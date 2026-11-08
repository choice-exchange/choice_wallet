// Generates crates/injective/tests/vectors/direct.json with injective-ts (sdk-ts), an
// implementation independent of ours. The Rust tests must match it byte for byte.
//
//   cd tools/vectors && npm ci && npm run gen
//
// Keys come from the BIP-39 test phrase only. They belong to no one.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PrivateKey, MsgSend, MsgExecuteContract, MsgGrant, MsgAuthzExec, MsgRevoke, MsgGrantAllowance, MsgRevokeAllowance,
  MsgWithdrawDelegatorReward, MsgChangeAdmin, MsgUpdateAdmin, createTransaction, getAminoStdSignDoc,
  getEip712TypedDataV2, sortObjectByKeys, SIGN_AMINO,
} from "@injectivelabs/sdk-ts";
import * as AuthzTx from "@injectivelabs/core-proto-ts-v2/generated/cosmos/authz/v1beta1/tx_pb";
import * as BankAuthz from "@injectivelabs/core-proto-ts-v2/generated/cosmos/bank/v1beta1/authz_pb";
import * as DistrTx from "@injectivelabs/core-proto-ts-v2/generated/cosmos/distribution/v1beta1/tx_pb";
import * as WasmTx from "@injectivelabs/core-proto-ts-v2/generated/cosmwasm/wasm/v1/tx_pb";
import { hashTypedData } from "viem";
import { mnemonicToAccount } from "viem/accounts";
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

// ---- EIP-712 v2: Cosmos txs signed as typed data by EVM wallets ----
// sdk-ts builds the typed data, as Injective dapps send it to eth_signTypedData_v4;
// viem hashes and signs it.

const viemAccount = mnemonicToAccount(PHRASE, { addressIndex: 0 });
const a2 = keys[2].toBech32();

const v2cases = [
  {
    name: "mainnet_send_and_cw20_transfer",
    msgs: [
      MsgSend.fromJSON({ srcInjectiveAddress: a0, dstInjectiveAddress: a1, amount: { denom: "inj", amount: "1000000000000000000" } }),
      exec(CW20, { transfer: { recipient: a1, amount: "5" } }),
    ],
    tx: { accountNumber: "12345", sequence: "3", timeoutHeight: "0", chainId: "injective-1", memo: "hello" },
    fee, evmChainId: 1776,
  },
  {
    name: "mainnet_eth_chain_id_fee_delegation",
    msgs: [exec(CW20, { send: { contract: ADAPTER, amount: "1000000", msg: "" } })],
    tx: { accountNumber: "12345", sequence: "4", timeoutHeight: "150000000", chainId: "injective-1", memo: "" },
    fee: { ...fee, feePayer: a2 }, evmChainId: 1,
  },
  {
    name: "testnet_bank_to_cw20",
    msgs: [exec(ADAPTER, { redeem_and_transfer: { recipient: a0 } }, [{ denom: `factory/${ADAPTER}/${CW20}`, amount: "7" }])],
    tx: { accountNumber: "9", sequence: "0", timeoutHeight: "0", chainId: "injective-888", memo: "" },
    fee, evmChainId: 1439,
  },
];

const v2out = {
  generator: "tools/vectors/gen.mjs: typed data from @injectivelabs/sdk-ts 1.20.62, hashed and signed with viem 2.57.7",
  phrase: PHRASE,
  cases: await Promise.all(v2cases.map(async (c) => {
    const td = getEip712TypedDataV2({ msgs: c.msgs, tx: c.tx, fee: c.fee, evmChainId: c.evmChainId });
    const forViem = { ...td, domain: { ...td.domain, chainId: BigInt(td.domain.chainId) } };
    return {
      name: c.name,
      typed_data: JSON.stringify(td),
      hash: hashTypedData(forViem),
      signature: await viemAccount.signTypedData(forViem),
      expect: {
        evm_chain_id: c.evmChainId,
        chain_id: c.tx.chainId,
        account_number: Number(c.tx.accountNumber),
        sequence: Number(c.tx.sequence),
        timeout_height: Number(c.tx.timeoutHeight),
        memo: c.tx.memo,
        fee_payer: c.fee.feePayer ?? null,
        messages: c.msgs.length,
      },
    };
  })),
};

const v2file = join(dirname(fileURLToPath(import.meta.url)), "../../crates/injective/tests/vectors/eip712_v2.json");
writeFileSync(v2file, JSON.stringify(v2out, null, 2) + "\n");
console.log(`wrote ${v2out.cases.length} cases to ${v2file}`);

// ---- LEGACY_AMINO_JSON: what Ledger's Cosmos app signs ----
// injective-ts's Ledger Cosmos strategy signs JSON.stringify(sortObjectByKeys(doc)). It
// always writes timeout_height, which the chain leaves out when 0, so these cases use a
// non-zero timeout height.

const aminoCases = [
  {
    name: "amino_bank_send",
    build: [{ kind: "bank_send", to: a1, coins: [["inj", "1500000000000000000"]] }],
    msgs: [MsgSend.fromJSON({ srcInjectiveAddress: a0, dstInjectiveAddress: a1, amount: { denom: "inj", amount: "1500000000000000000" } })],
    memo: "", timeoutHeight: "150000000", sequence: 0, accountNumber: 12345,
  },
  {
    name: "amino_cw20_transfer_memo",
    build: [{ kind: "cw20_transfer", cw20: CW20, recipient: a1, amount: "1000000" }],
    msgs: [exec(CW20, { transfer: { recipient: a1, amount: "1000000" } })],
    memo: "exchange memo 1234567", timeoutHeight: "150000001", sequence: 3, accountNumber: 12345,
  },
  {
    name: "amino_redeem_then_send",
    build: [
      { kind: "bank_to_cw20", cw20: CW20, adapter: ADAPTER, amount: "7", recipient: a0 },
      { kind: "cw20_transfer", cw20: CW20, recipient: a1, amount: "7" },
    ],
    msgs: [
      exec(ADAPTER, { redeem_and_transfer: { recipient: a0 } }, [{ denom: `factory/${ADAPTER}/${CW20}`, amount: "7" }]),
      exec(CW20, { transfer: { recipient: a1, amount: "7" } }),
    ],
    memo: "", timeoutHeight: "150000002", sequence: 9, accountNumber: 777,
  },
];

const aminoOut = {
  generator: "tools/vectors/gen.mjs with @injectivelabs/sdk-ts 1.20.62",
  phrase: PHRASE,
  cases: aminoCases.map((c) => {
    const doc = getAminoStdSignDoc({
      memo: c.memo, chainId: "injective-1", accountNumber: c.accountNumber, sequence: c.sequence,
      timeoutHeight: c.timeoutHeight, gas: "160000", msgs: c.msgs,
    });
    const signDoc = JSON.stringify(sortObjectByKeys(doc));
    const tx = createTransaction({
      message: c.msgs, memo: c.memo, fee: doc.fee, chainId: "injective-1", signMode: SIGN_AMINO,
      pubKey: k0.toPublicKey().toBase64(), sequence: c.sequence, accountNumber: c.accountNumber,
      timeoutHeight: Number(c.timeoutHeight),
    });
    const signature = k0.sign(Buffer.from(signDoc));
    tx.txRaw.signatures = [signature];
    return {
      name: c.name,
      build: c.build,
      memo: c.memo,
      timeout_height: Number(c.timeoutHeight),
      sequence: c.sequence,
      account_number: c.accountNumber,
      fee: { amount: doc.fee.amount.map((x) => [x.denom, x.amount]), gas_limit: Number(doc.fee.gas) },
      sign_doc: signDoc,
      body_bytes: hex(tx.bodyBytes),
      auth_info_bytes: hex(tx.authInfoBytes),
      signature: hex(signature),
      tx_raw: hex(TxPb.TxRaw.toBinary(tx.txRaw)),
    };
  }),
};

const aminoFile = join(dirname(fileURLToPath(import.meta.url)), "../../crates/injective/tests/vectors/amino.json");
writeFileSync(aminoFile, JSON.stringify(aminoOut, null, 2) + "\n");
console.log(`wrote ${aminoOut.cases.length} cases to ${aminoFile}`);

// ---- Grants, allowances, admins and rewards: the messages risk rules look at ----
// Each case is one message as an Any, encoded by injective-ts (sdk-ts classes, or its
// generated protobuf classes where sdk-ts has no class). Our decoder must accept the bytes
// exactly and read the same fields.

const SEND_URL = "/cosmos.bank.v1beta1.MsgSend";
const EXPIRY = 1893456000;
const valoper = k0.toAddress().toBech32("injvaloper");
const sdkAny = (m) => ({ type_url: m.toDirectSign().type, value: hex(m.toBinary()) });
const pbAny = (type_url, T, fields) => ({ type_url, value: hex(T.toBinary(T.create(fields))) });
const sendAuth = {
  typeUrl: "/cosmos.bank.v1beta1.SendAuthorization",
  value: BankAuthz.SendAuthorization.toBinary(BankAuthz.SendAuthorization.create({
    spendLimit: [{ denom: "inj", amount: "5000" }], allowList: [a2],
  })),
};
const execSend = MsgAuthzExec.fromJSON({
  grantee: a0,
  msgs: MsgSend.fromJSON({ srcInjectiveAddress: a1, dstInjectiveAddress: a0, amount: { denom: "inj", amount: "42" } }),
});

const riskCases = [
  ["authz_generic_grant", sdkAny(MsgGrant.fromJSON({ granter: a0, grantee: a1, messageType: SEND_URL, expiration: EXPIRY }))],
  ["authz_send_grant", sdkAny(MsgGrant.fromJSON({ granter: a0, grantee: a1, authorization: sendAuth, expiration: EXPIRY }))],
  ["authz_exec_send", sdkAny(execSend)],
  ["authz_revoke", sdkAny(MsgRevoke.fromJSON({ granter: a0, grantee: a1, messageType: SEND_URL }))],
  ["feegrant_basic", sdkAny(MsgGrantAllowance.fromJSON({
    granter: a0, grantee: a1, allowance: { spendLimit: [{ denom: "inj", amount: "1000" }], expiration: EXPIRY },
  }))],
  ["feegrant_revoke", sdkAny(MsgRevokeAllowance.fromJSON({ granter: a0, grantee: a1 }))],
  ["withdraw_rewards", sdkAny(MsgWithdrawDelegatorReward.fromJSON({ delegatorAddress: a0, validatorAddress: valoper }))],
  ["set_withdraw_address", pbAny("/cosmos.distribution.v1beta1.MsgSetWithdrawAddress", DistrTx.MsgSetWithdrawAddress, {
    delegatorAddress: a0, withdrawAddress: a1,
  })],
  ["tokenfactory_change_admin", sdkAny(MsgChangeAdmin.fromJSON({ sender: a0, denom: `factory/${a0}/test`, newAdmin: a1 }))],
  ["wasm_update_admin", sdkAny(MsgUpdateAdmin.fromJSON({ sender: a0, newAdmin: a1, contract: a2 }))],
  ["wasm_clear_admin", pbAny("/cosmwasm.wasm.v1.MsgClearAdmin", WasmTx.MsgClearAdmin, { sender: a0, contract: a2 })],
];

// Expiration as the protobuf decodes it, so the test doesn't assume sdk-ts's units.
const grantExpiry = (anyHex) => {
  const g = AuthzTx.MsgGrant.fromBinary(Buffer.from(anyHex, "hex")).grant;
  return g?.expiration ? Number(g.expiration.seconds) : null;
};

// One full transaction too, so MsgExec's nested Any goes through the Direct decoder.
const riskTx = createTransaction({
  message: [execSend, MsgGrant.fromJSON({ granter: a0, grantee: a1, messageType: SEND_URL, expiration: EXPIRY })],
  memo: "", fee, chainId: "injective-1", pubKey: k0.toPublicKey().toBase64(), sequence: 1, accountNumber: 12345,
});

const riskOut = {
  generator: "tools/vectors/gen.mjs with @injectivelabs/sdk-ts 1.20.62 and its core-proto-ts-v2",
  phrase: PHRASE,
  addresses: { a0, a1, a2, valoper },
  expiry: EXPIRY,
  messages: riskCases.map(([name, any]) => ({
    name, ...any, grant_expiration: any.type_url.endsWith("MsgGrant") ? grantExpiry(any.value) : undefined,
  })),
  tx: { body_bytes: hex(riskTx.bodyBytes), auth_info_bytes: hex(riskTx.authInfoBytes), account_number: 12345 },
};

const riskFile = join(dirname(fileURLToPath(import.meta.url)), "../../crates/injective/tests/vectors/messages.json");
writeFileSync(riskFile, JSON.stringify(riskOut, null, 2) + "\n");
console.log(`wrote ${riskOut.messages.length} messages to ${riskFile}`);
