// Generates crates/injective/tests/vectors/direct.json with injective-ts (sdk-ts), an
// implementation independent of ours. The Rust tests must match it byte for byte.
//
//   cd tools/vectors && npm ci && npm run gen
//
// Keys come from the BIP-39 test phrase only. They belong to no one.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey, MsgSend, MsgExecuteContract, createTransaction } from "@injectivelabs/sdk-ts";
import * as TxPb from "@injectivelabs/core-proto-ts-v2/generated/cosmos/tx/v1beta1/tx_pb";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const path = (i) => `m/44'/60'/0'/0/${i}`;
const hex = (b) => Buffer.from(b).toString("hex");

const keys = [0, 1, 2].map((i) => PrivateKey.fromMnemonic(PHRASE, path(i)));
const [k0, k1] = keys;
const a0 = k0.toBech32();
const a1 = k1.toBech32();

// The mainnet CW20 adapter. The "CW20" is test-phrase account 2: only its shape matters.
const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
const CW20 = keys[2].toBech32();
const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";

const fee = { amount: [{ denom: "inj", amount: "160000000000000" }], gas: "160000" };

const exec = (contract, msg, funds = []) =>
  MsgExecuteContract.fromJSON({ sender: a0, contractAddress: contract, msg, funds });

const cases = [
  {
    name: "bank_send_inj",
    build: { kind: "bank_send", to: a1, coins: [["inj", "1500000000000000000"]] },
    msgs: [MsgSend.fromJSON({ srcInjectiveAddress: a0, dstInjectiveAddress: a1, amount: { denom: "inj", amount: "1500000000000000000" } })],
    memo: "", timeoutHeight: 0, sequence: 0, accountNumber: 12345, fee,
  },
  {
    name: "bank_send_two_coins_memo_timeout",
    build: { kind: "bank_send", to: a1, coins: [["inj", "1"], [USDT, "2500000"]] },
    msgs: [MsgSend.fromJSON({
      srcInjectiveAddress: a0, dstInjectiveAddress: a1,
      amount: [{ denom: "inj", amount: "1" }, { denom: USDT, amount: "2500000" }],
    })],
    memo: "exchange memo 1234567", timeoutHeight: 150000000, sequence: 7, accountNumber: 98765, fee,
  },
  {
    name: "cw20_transfer",
    build: { kind: "cw20_transfer", cw20: CW20, recipient: a1, amount: "1000000" },
    msgs: [exec(CW20, { transfer: { recipient: a1, amount: "1000000" } })],
    memo: "", timeoutHeight: 0, sequence: 3, accountNumber: 12345, fee,
  },
  {
    name: "cw20_to_bank",
    build: { kind: "cw20_to_bank", cw20: CW20, adapter: ADAPTER, amount: "1000000" },
    msgs: [exec(CW20, { send: { contract: ADAPTER, amount: "1000000", msg: "" } })],
    memo: "", timeoutHeight: 0, sequence: 4, accountNumber: 12345, fee,
  },
  {
    name: "bank_to_cw20",
    build: { kind: "bank_to_cw20", cw20: CW20, adapter: ADAPTER, amount: "1000000", recipient: a0 },
    msgs: [exec(ADAPTER, { redeem_and_transfer: { recipient: a0 } }, [{ denom: `factory/${ADAPTER}/${CW20}`, amount: "1000000" }])],
    memo: "", timeoutHeight: 0, sequence: 5, accountNumber: 12345, fee,
  },
];

const out = {
  generator: "tools/vectors/gen.mjs with @injectivelabs/sdk-ts 1.20.62",
  phrase: PHRASE,
  chain_id: "injective-1",
  accounts: keys.map((k, i) => ({
    path: path(i),
    inj: k.toBech32(),
    eth: k.toAddress().toHex(),
    pubkey: hex(Buffer.from(k.toPublicKey().toBase64(), "base64")),
  })),
  cases: cases.map((c) => {
    const tx = createTransaction({
      message: c.msgs, memo: c.memo, fee: c.fee, chainId: "injective-1",
      pubKey: k0.toPublicKey().toBase64(), sequence: c.sequence, accountNumber: c.accountNumber,
      timeoutHeight: c.timeoutHeight || undefined,
    });
    const signature = k0.sign(Buffer.from(tx.signBytes));
    tx.txRaw.signatures = [signature];
    return {
      name: c.name,
      build: c.build,
      memo: c.memo,
      timeout_height: c.timeoutHeight,
      sequence: c.sequence,
      account_number: c.accountNumber,
      fee: { amount: c.fee.amount.map((x) => [x.denom, x.amount]), gas_limit: Number(c.fee.gas) },
      body_bytes: hex(tx.bodyBytes),
      auth_info_bytes: hex(tx.authInfoBytes),
      sign_doc: hex(tx.signBytes),
      signature: hex(signature),
      tx_raw: hex(TxPb.TxRaw.toBinary(tx.txRaw)),
    };
  }),
};

const file = join(dirname(fileURLToPath(import.meta.url)), "../../crates/injective/tests/vectors/direct.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.cases.length} cases to ${file}`);
