// A fake mainnet for the host's tests: LCD and EVM JSON-RPC answers shaped as Injective's
// (recorded 2026-11-08/09), memory stores, and a service on them with the real vault.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519";
import { handle, initSync } from "choice-wallet-vault-glue";

import { ethMessage, rawTx, resultData, type Log } from "../../chain/test/evm-fixture";
import { createService, type Store } from "../src/service";
import { callVault } from "../src/vault";

initSync({ module: readFileSync(new URL("./choice_wallet_wasm_bg.wasm", import.meta.url)) });

export { callVault, handle };

// The BIP-39 test phrase: published, owned by no one. Its account exists on mainnet.
export const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
export const ME_EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
// The EIP-155 example key (published) and its address, as a recipient.
export const THEM_KEY = "4646464646464646464646464646464646464646464646464646464646464646";
export const THEM_EVM = "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F";
export const PASSWORD = "correct horse battery staple";
/** The phrase's Solana account 0 (Phantom's path), and another wallet there (its account 1). */
export const ME_SOL = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
export const THEM_SOL = "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb";
export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Their associated USDC accounts (web3.js agrees). */
export const ME_SOL_USDC = "5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt";
export const THEM_SOL_USDC = "8X8ts1CnpZmtqApE2rREA97xEJuSRcomPGVcMFdS2cgY";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const INJ = 10n ** 18n;
export const GAS_PRICE = 160_000_000n;
export const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const SCAM = "factory/inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49/usdt";

export function memory(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) data.delete(k);
    },
  };
}

// Indexed transactions, shaped like mainnet's: a send ME signed, a receive, and junk.
export const THEM = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
export const FEE_COLLECTOR = "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9";
export const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value, index: true }));
export const moved = (from: string, to: string, amount: string) => [
  { type: "coin_spent", attributes: attrs({ spender: from, amount }) },
  { type: "coin_received", attributes: attrs({ receiver: to, amount }) },
  { type: "transfer", attributes: attrs({ recipient: to, sender: from, amount }) },
];
export const indexed = (height: number, from: string, to: string, amount: string) => ({
  txhash: height.toString(16).padStart(64, "0"),
  height: String(height),
  timestamp: "2026-11-09T08:00:00Z",
  code: 0,
  tx: {
    body: { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: from, to_address: to, amount: [] }] },
    auth_info: { fee: { amount: [{ denom: "inj", amount: "17216480000000" }], gas_limit: "107603" } },
  },
  events: [...moved(from, FEE_COLLECTOR, "17216480000000inj"), { type: "tx", attributes: attrs({ fee: "17216480000000inj", fee_payer: from }) }, ...moved(from, to, amount)],
});
export const SIGNED = [indexed(100, ME, THEM, "1000000000000000000inj")];

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const AGGREGATOR = "0xa705d0D5f549Af25024038dc575E3074B9Bd37c9";
/** Choice's real /route answers (2026-11-09; they pay the test phrase's account 0, ME_EVM),
 *  by `tokenIn tokenOut amountIn`, rebuilt from the vault's fixture of them. */
export const CHOICE_ROUTES: Record<string, Record<string, unknown>> = (() => {
  const v = JSON.parse(readFileSync(new URL("../../crates/injective/tests/choice_routes.json", import.meta.url), "utf8")) as {
    cases: { name: string; network: string; to: string; value: string; data: string; api: Record<string, unknown> }[];
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of v.cases) {
    if (c.network !== "mainnet") continue;
    const a = c.api;
    out[`${String(a["tokenIn"]).toLowerCase()} ${String(a["tokenOut"]).toLowerCase()} ${String(a["amountIn"])}`] = {
      tokenIn: a["tokenIn"],
      tokenOut: a["tokenOut"],
      amountIn: a["amountIn"],
      amountOut: String((BigInt(String(a["amountOutMinimum"])) * 10_000n) / 9_950n + 1n),
      amountOutMinimum: a["amountOutMinimum"],
      executor: a["executor"],
      fee: null,
      gasEstimate: "245000",
      legs: (a["legs"] as string[]).map((venue) => ({ venue, portionBps: 10000 })),
      tx: { to: c.to, data: c.data, value: c.value },
    };
  }
  return out;
})();

/** Deposits to an exchange's shared address: each from its own sender, with a memo. */
export function exchangeDeposits(exchange: string, n = 12): unknown[] {
  return Array.from({ length: n }, (_, i) => {
    const t = indexed(200 - i, `inj1sender${i}`, exchange, "1000000000000000000inj");
    return { ...t, tx: { ...t.tx, body: { ...t.tx.body, memo: `10${i}234567` } } };
  });
}

/** An EVM transaction as the LCD indexes it: the fee (no fee payer named), the `message`
 *  event with the bech32 sender, then `events`; the logs in its result. Its EVM hash is
 *  the height's, so tests can name it. */
export const evmHashAt = (height: number) => `0x${height.toString(16).padStart(64, "e")}`;
export function evmIndexed(height: number, o: { from: string; fromInj: string; to: string; input?: string; value?: bigint; logs?: Log[]; events?: unknown[] }) {
  const hash = evmHashAt(height);
  return {
    txhash: height.toString(16).padStart(64, "c"),
    height: String(height),
    timestamp: "2026-11-09T08:00:00Z",
    code: 0,
    raw_log: "",
    data: resultData(hash, o.logs ?? []),
    tx: { body: { messages: [ethMessage(o.from, rawTx({ to: o.to, value: o.value ?? 0n, input: o.input ?? "0x" }))] }, auth_info: { fee: { amount: [{ denom: "inj", amount: "4032160000000" }], gas_limit: "25201" } } },
    events: [
      ...moved(o.fromInj, FEE_COLLECTOR, "4032160000000inj"),
      { type: "tx", attributes: attrs({ fee: "4032160000000inj" }) },
      { type: "message", attributes: attrs({ action: "/injective.evm.v1.MsgEthereumTx", sender: o.fromInj }) },
      ...(o.events ?? []),
      { type: "ethereum_tx", attributes: attrs({ ethereumTxHash: hash, recipient: o.to }) },
    ],
  };
}
export const RECEIVED = [indexed(120, THEM, ME, `2500000${USDT}`), indexed(90, THEM, ME, `7000000${SCAM}`)];

// EVM-only tokens (no bank denom): one Choice prices, one to add by hand, and a contract
// that isn't a token. The USDT ERC20 (0x88f7…) is bank-backed through its token pair.
export const LUMA = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
export const ADDED = "0x1111111111111111111111111111111111111111";
export const NOT_A_TOKEN = "0x2222222222222222222222222222222222222222";
export const USDT_ERC20 = "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13";
export const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${"20".padStart(64, "0")}${(hex.length / 2).toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
};
/** Native USDC on Injective EVM (Circle's), and its bank denom; Circle's TokenMessengerV2. */
export const USDC_ERC20 = "0xa00c59ff5a080d2b954d0c75e46e22a0c371235a";
export const USDC = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
export const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
export const BRIDGE_RECEIVER = "0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A";
/** USDC on Base, where the fake's second chain is (mainnet.base.org, chain 8453). */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ERC20: Record<string, { symbol: string; name: string; decimals: number }> = {
  [LUMA]: { symbol: "LUMA", name: "Luma", decimals: 18 },
  [USDC_ERC20]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  [ADDED]: { symbol: "TEST", name: "Test token", decimals: 6 },
  [USDT_ERC20]: { symbol: "USDT", name: "Tether USD", decimals: 6 },
};

// CW20s (published mainnet contracts): SHROOM's, whose adapter bank form has an ERC20 pair
// Choice prices, and NONJA's, to add by hand. The adapter itself is a contract but no CW20.
export const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
export const CW = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
export const CW_ADDED = "inj1fu5u29slsg2xtsj7v5la22vl4mr4ywl7wlqeck";
export const CW_BANK = `factory/${ADAPTER}/${CW}`;
export const CW_PAIR = "0x3333333333333333333333333333333333333333";
export const CW20: Record<string, { symbol: string; name: string; decimals: number }> = {
  [CW]: { symbol: "SHROOM", name: "shroomin", decimals: 18 },
  [CW_ADDED]: { symbol: "NONJA", name: "nonja", decimals: 18 },
};

/** A fake mainnet LCD and EVM JSON-RPC. `balances`, `evm` and `account` can be changed per test. */
/** Test validators (addresses of fixed bytes, not real ones). */
export const VAL_A = "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q";
export const VAL_B = "injvaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz7c964k";
/** Jailed, out of the active set. */
export const VAL_JAILED = "injvaloper1qvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrlgymlh";
const validatorJson = (address: string, moniker: string, tokens: bigint, jailed = false) => ({
  operator_address: address,
  jailed,
  status: jailed ? "BOND_STATUS_UNBONDING" : "BOND_STATUS_BONDED",
  tokens: tokens.toString(),
  description: { moniker, website: "" },
  commission: { commission_rates: { rate: "0.050000000000000000" } },
});

export function chain(opts: { balances?: Record<string, bigint>; evm?: Record<string, bigint>; cw20?: Record<string, bigint>; account?: boolean; gasUsed?: string; pricesDown?: boolean } = {}) {
  const state = {
    balances: opts.balances ?? { inj: 5n * INJ },
    evm: opts.evm ?? {},
    /** More 0x accounts that hold `evm` and may send, like ME (a Ledger's, say). */
    evmAlso: [] as string[],
    cw20: opts.cw20 ?? {},
    /** CW20 contracts asked for a balance. */
    cw20Calls: [] as string[],
    evmDown: false,
    /** Contracts asked for a balance on the EVM side. */
    evmBalanceCalls: [] as string[],
    /** Raw EVM transactions broadcast. */
    evmSent: [] as string[],
    account: opts.account ?? true,
    broadcasts: [] as string[],
    simulations: 0,
    priceCalls: 0,
    pricesDown: opts.pricesDown ?? false,
    hosts: new Set<string>(),
    /** More of what ME signed (EVM transactions), and what the LCD finds by EVM hash. */
    signedEvm: [] as unknown[],
    byEvmHash: {} as Record<string, unknown>,
    /** EVM hashes asked of the LCD. */
    evmLookups: [] as string[],
    /** Blockscout's ERC20 transfers for ME (newest first), or down. */
    blockscout: [] as { hash: string; blockNumber: number }[] | "down",
    /** Blockscout queries asked. */
    blockscoutCalls: [] as string[],
    /** Accounts whose bank balances were asked. */
    balanceAsked: [] as string[],
    /** Requests no route answered (501). */
    unhandled: [] as string[],
    /** More indexed transactions in which ME received and spent coins (newest first). */
    receivedTxs: [] as unknown[],
    spentTxs: [] as unknown[],
    /** Transactions whose CW20 events moved tokens to ME (`wasm.to`). */
    cw20In: [] as unknown[],
    /** Other accounts' bank balances and received transactions, where set. */
    otherBalances: {} as Record<string, { denom: string; amount: string }[]>,
    otherReceived: {} as Record<string, unknown[]>,
    /** Times the token pairs and denom metadata were asked. */
    pairCalls: 0,
    metadataCalls: 0,
    /** Other accounts (inj1…) that exist and hold 5 INJ. */
    funded: new Set<string>(),
    /** ME's stakes, unbonding entries and rewards (chain decimals) by validator. */
    delegations: {} as Record<string, bigint>,
    unbonding: [] as { validator: string; amount: bigint; height: number; completes: string }[],
    rewards: {} as Record<string, string>,
    /** What ME lets others do: authz grants and fee allowances (LCD JSON, granter filled in),
     *  the rewards address, CW20 allowances by contract, Approval logs Blockscout has, and
     *  what each (token spender) allowance is now. */
    grants: [] as Record<string, unknown>[],
    feeGrants: [] as Record<string, unknown>[],
    /** Fee allowances other accounts gave, by granter (a rescue address's gas). */
    issuedBy: {} as Record<string, Record<string, unknown>[]>,
    rewardsTo: null as string | null,
    cw20Allowances: {} as Record<string, { spender: string; allowance: string }[]>,
    approvalLogs: [] as { token: string; spender: string }[],
    erc20Allowance: {} as Record<string, bigint>,
    /** What other accounts (inj1…) received, newest first (indexed txs), and whose were asked. */
    deposits: {} as Record<string, unknown[]>,
    depositChecks: [] as string[],
    /** Choice's /route: the real answers recorded on 2026-11-09 (they pay ME_EVM), by
     *  `tokenIn tokenOut amountIn`; the questions asked; and what Permit2 lets each (token spender) take. */
    routes: CHOICE_ROUTES,
    routeAsks: [] as URLSearchParams[],
    permit2: {} as Record<string, { amount: bigint; expiration: number }>,
    /** Circle's Iris: its messages by burn hash, and the requests it saw (with their headers). */
    iris: {} as Record<string, unknown[]>,
    irisAsks: [] as { path: string; headers: Record<string, string> }[],
    irisDown: false,
    /** Solana accounts that exist (by base58 address), for the recipient check. */
    solanaAccounts: {} as Record<string, { owner: string }>,
    /** Solana mainnet: ME_SOL's lamports and USDC, transactions sent (base64, each one's
     *  signatures checked), their statuses, the block height, and ME_SOL's history. */
    solana: {
      lamports: 2_000_000_000n,
      usdc: 5_000_000n,
      sent: [] as string[],
      landed: {} as Record<string, boolean>,
      height: 1_000,
      history: [] as { signature: string; slot: number; tx: Record<string, unknown> }[],
      simulateErr: null as unknown,
      down: false,
    },
    /** Base: ME's USDC and ETH there, what TokenMessengerV2 may take, what was broadcast. */
    base: { usdc: 0n, eth: 10n ** 16n, allowance: 0n, sent: [] as string[], down: false },
    /** Injective's MessageTransmitterV2: the nonces it has used (minted). */
    usedNonces: new Set<string>(),
    /** BridgeReceiver's INJ top-up: wei, its fee in USDC, paused. */
    gasDrop: { wei: 2n * 10n ** 16n, fee: 500_000n, paused: false },
  };
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const baseRpc = (r: Rpc) => {
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
    const reverted = { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
    if (r.method === "eth_chainId") return answer("0x2105");
    if (r.method === "eth_getTransactionCount") return answer(`0x${state.base.sent.length.toString(16)}`);
    if (r.method === "eth_getBlockByNumber") return answer({ number: "0x1000", baseFeePerGas: "0x5f5e100" });
    if (r.method === "eth_maxPriorityFeePerGas") return answer("0xf4240");
    if (r.method === "eth_getBalance") return answer(r.params[0] as unknown as string === ME_EVM ? `0x${state.base.eth.toString(16)}` : "0x0");
    if (r.method === "eth_estimateGas") {
      const tx = r.params[0] as unknown as { from: string; to: string; data: string };
      assert.equal(tx.from.toLowerCase(), ME_EVM.toLowerCase());
      if (tx.data.startsWith("0x095ea7b3")) return answer("0xb3b0");
      if (/^0x(779b432d|8e0250ee)/.test(tx.data)) return BigInt(`0x${tx.data.slice(10, 74)}`) > state.base.allowance ? reverted : answer("0x29810");
      return reverted;
    }
    if (r.method === "eth_sendRawTransaction") {
      state.base.sent.push(r.params[0] as unknown as string);
      return answer(`0x${"ba".repeat(31)}${state.base.sent.length.toString(16).padStart(2, "0")}`);
    }
    if (r.method === "eth_getTransactionReceipt") return answer(state.base.sent.length ? { status: "0x1" } : null);
    const { to, data } = r.params[0]!;
    // OP Stack's GasPriceOracle: the most a transaction's Ethereum data fee can be.
    if (r.method === "eth_call" && to.toLowerCase() === "0x420000000000000000000000000000000000000f" && data.startsWith("0xf1c7a58b")) return answer(word(4_660_000_000n));
    if (r.method === "eth_call" && to.toLowerCase() === BASE_USDC.toLowerCase()) {
      const mine = data.slice(34, 74) === ME_EVM.slice(2).toLowerCase();
      if (data.startsWith("0x70a08231")) return answer(word(mine ? state.base.usdc : 0n));
      if (data.startsWith("0xdd62ed3e")) return answer(word(mine && data.slice(98, 138) === TOKEN_MESSENGER.slice(2).toLowerCase() ? state.base.allowance : 0n));
    }
    return reverted;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  type Rpc = { id: number; method: string; params: { to: string; data: string }[] };
  const rpc = (r: Rpc) => {
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
    if (r.method === "eth_chainId") return answer("0x6f0");
    if (r.method === "eth_getTransactionCount") return answer("0x3");
    if (r.method === "eth_getBlockByNumber") return answer({ number: "0xb6137d8", baseFeePerGas: "0x9896800" });
    if (r.method === "eth_maxPriorityFeePerGas") return answer("0x0");
    if (r.method === "eth_getBalance") return answer(`0x${(state.balances["inj"] ?? 0n).toString(16)}`);
    if (r.method === "eth_estimateGas") {
      const tx = r.params[0] as unknown as { from: string; to: string; data: string };
      assert.ok([ME_EVM, ...state.evmAlso].some((a) => a.toLowerCase() === tx.from.toLowerCase()), `estimate from ${tx.from}`);
      if (tx.data === "0xdeadbeef") return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
      // 46,576 for an ERC20 transfer; approvals 46,000; a swap 250,000; a mint 200,000; 21,000 for a plain send.
      const est = tx.data.startsWith("0xa9059cbb") ? "0xb5f0" : /^0x(095ea7b3|87517c45)/.test(tx.data) ? "0xb3b0" : /^0x(ddab6e8d|3593564c)/.test(tx.data) ? "0x3d090" : /^0x(779b432d|8e0250ee)/.test(tx.data) ? "0x76530" : tx.data.startsWith("0x57ecfd28") ? "0x30d40" : "0x5208";
      return answer(est);
    }
    if (r.method === "eth_blockNumber") return answer("0xb6137d8");
    if (r.method === "eth_sendRawTransaction") {
      state.evmSent.push(r.params[0] as unknown as string);
      return answer(`0x${"ab".repeat(32)}`);
    }
    if (r.method === "eth_getTransactionReceipt") return answer(state.evmSent.length ? { status: "0x1" } : null);
    const { to, data } = r.params[0]!;
    if (r.method === "eth_call" && to.toLowerCase() === PERMIT2.toLowerCase() && data.startsWith("0x927da105")) {
      // allowance(owner, token, spender): ME's, by token and spender.
      const token = `0x${data.slice(98, 138)}`;
      const spender = `0x${data.slice(162, 202)}`;
      const a = data.slice(34, 74) === ME_EVM.slice(2).toLowerCase() ? state.permit2[`${token} ${spender}`] : undefined;
      const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
      return { jsonrpc: "2.0", id: r.id, result: `0x${w(a?.amount ?? 0n)}${w(a?.expiration ?? 0)}${w(0)}` };
    }
    if (r.method === "eth_call" && to.toLowerCase() === MESSAGE_TRANSMITTER.toLowerCase() && data.startsWith("0xfeb61724")) {
      return answer(word(state.usedNonces.has(`0x${data.slice(10)}`) ? 1n : 0n));
    }
    if (r.method === "eth_call" && to.toLowerCase() === BRIDGE_RECEIVER.toLowerCase()) {
      const g = state.gasDrop;
      const v = { "0x2806f1c2": g.wei, "0xba3c944e": g.fee, "0xa424e452": g.paused ? 1n : 0n }[data];
      if (v !== undefined) return answer(word(v));
    }
    const t = ERC20[to.toLowerCase()];
    if (r.method !== "eth_call" || !t) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
    if (data.startsWith("0xdd62ed3e")) {
      // allowance(owner, spender): ME's, by token and spender.
      const owner = `0x${data.slice(34, 74)}`;
      const spender = `0x${data.slice(98, 138)}`;
      const left = owner === ME_EVM.toLowerCase() ? (state.erc20Allowance[`${to.toLowerCase()} ${spender}`] ?? 0n) : 0n;
      return { jsonrpc: "2.0", id: r.id, result: `0x${left.toString(16).padStart(64, "0")}` };
    }
    if (data.startsWith("0x70a08231")) {
      state.evmBalanceCalls.push(to.toLowerCase());
      // ME holds `evm`; any other account, none.
      const mine = [ME_EVM, ...state.evmAlso].some((a) => data.slice(34).toLowerCase() === a.slice(2).toLowerCase());
      return { jsonrpc: "2.0", id: r.id, result: `0x${(mine ? (state.evm[to.toLowerCase()] ?? 0n) : 0n).toString(16)}` };
    }
    const result = data === "0x95d89b41" ? abiString(t.symbol) : data === "0x06fdde03" ? abiString(t.name) : `0x${t.decimals.toString(16).padStart(64, "0")}`;
    return { jsonrpc: "2.0", id: r.id, result };
  };
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    state.hosts.add(url.host);
    const p = url.pathname;
    if (init?.method === "POST" && url.host === "mainnet.base.org") {
      if (state.base.down) return new Response("down", { status: 503 });
      const body = JSON.parse(String(init.body)) as Rpc | Rpc[];
      return json(200, Array.isArray(body) ? body.map(baseRpc) : baseRpc(body));
    }
    if (init?.method === "POST" && p === "/" && url.host !== "solana-rpc.publicnode.com") {
      // EVM JSON-RPC.
      if (state.evmDown) return new Response("down", { status: 503 });
      const body = JSON.parse(String(init.body)) as Rpc | Rpc[];
      return json(200, Array.isArray(body) ? body.map(rpc) : rpc(body));
    }
    if (p.endsWith("/node_info")) return json(200, { default_node_info: { network: "injective-1" } });
    const other = /^\/cosmos\/auth\/v1beta1\/accounts\/(inj1[a-z0-9]+)$/.exec(p)?.[1];
    if (other && other !== ME && state.funded.has(other)) {
      return json(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: other, pub_key: null, account_number: "7", sequence: "0" } } });
    }
    if (p === `/cosmos/auth/v1beta1/accounts/${ME}`) {
      return state.account
        ? json(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: ME, pub_key: null, account_number: "1680321", sequence: "2" } } })
        : json(404, { code: 5, message: `account ${ME} not found`, details: [] });
    }
    if (p.startsWith("/cosmos/bank/v1beta1/spendable_balances/")) {
      // ME holds `balances`; any other account, nothing.
      const who = p.split("/").pop()!;
      state.balanceAsked.push(who);
      const list =
        who === ME
          ? Object.entries(state.balances).map(([denom, a]) => ({ denom, amount: a.toString() }))
          : (state.otherBalances[who] ?? (state.funded.has(who) ? [{ denom: "inj", amount: (5n * INJ).toString() }] : []));
      return json(200, { balances: list, pagination: { next_key: null } });
    }
    if (p === "/injective/txfees/v1beta1/cur_eip_base_fee") return json(200, { base_fee: { base_fee: "160000000.000000000000000000" } });
    if (p === "/injective/erc20/v1beta1/all_token_pairs") {
      state.pairCalls++;
      return json(200, {
        token_pairs: [
          { bank_denom: USDT, erc20_address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13" },
          { bank_denom: CW_BANK, erc20_address: CW_PAIR },
        ],
        pagination: null,
      });
    }
    const smart = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/]+)$/.exec(p);
    if (smart) {
      // CW20 queries as wasmd answers them; any other contract refuses.
      const t = CW20[smart[1]!];
      const q = JSON.parse(atob(decodeURIComponent(smart[2]!))) as { balance?: { address: string }; token_info?: object; all_allowances?: { owner: string } };
      if (t && q.all_allowances) {
        const list = q.all_allowances.owner === ME ? (state.cw20Allowances[smart[1]!] ?? []) : [];
        return json(200, { data: { allowances: list.map((a) => ({ ...a, expires: { never: {} } })) } });
      }
      if (!t) return json(500, { code: 2, message: "query wasm contract failed: Error parsing into type", details: [] });
      if (q.token_info) return json(200, { data: { ...t, total_supply: "1000000000000000000000000000" } });
      if (q.balance) {
        state.cw20Calls.push(smart[1]!);
        // ME holds `cw20`; any other account, none.
        return json(200, { data: { balance: (q.balance.address === ME ? (state.cw20[smart[1]!] ?? 0n) : 0n).toString() } });
      }
      return json(500, { code: 2, message: "unknown variant", details: [] });
    }
    if (url.host === "blockscout.injective.network" && p === "/api") {
      state.blockscoutCalls.push(url.search);
      if (state.blockscout === "down") return new Response("<html>502</html>", { status: 502 });
      if (url.searchParams.get("action") === "getLogs") {
        const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
        const mine = url.searchParams.get("topic1") === pad(ME_EVM);
        const logs = (mine ? state.approvalLogs : []).map((l) => ({
          address: l.token,
          topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", pad(ME_EVM), pad(l.spender), null],
          data: `0x${"f".repeat(64)}`,
        }));
        return json(200, logs.length ? { message: "OK", result: logs, status: "1" } : { message: "No logs found", result: [], status: "0" });
      }
      const rows = state.blockscout.map((t) => ({ blockNumber: String(t.blockNumber), hash: t.hash, from: THEM_EVM.toLowerCase(), to: ME_EVM.toLowerCase(), value: "1" }));
      return json(200, rows.length ? { message: "OK", result: rows, status: "1" } : { message: "No token transfers found", result: [], status: "0" });
    }
    if (url.host === "iris-api.circle.com") {
      state.irisAsks.push({ path: `${p}${url.search}`, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (state.irisDown) return new Response("down", { status: 503 });
      // Circle's answers for Injective (domain 29) as of 2026-11-10's shape: standard only
      // from Injective is free; forwarding costs a flat fee per destination.
      // Into Injective from Base: Fast costs 1 bp; Circle doesn't deliver on Injective.
      if (p === "/v2/burn/USDC/fees/6/29") {
        return json(200, [
          { finalityThreshold: 1000, minimumFee: 1 },
          { finalityThreshold: 2000, minimumFee: 0 },
        ]);
      }
      const fees = /^\/v2\/burn\/USDC\/fees\/29\/(\d+)$/.exec(p);
      if (fees) {
        const setup = url.searchParams.get("includeRecipientSetup") === "true";
        const fwd = fees[1] === "5" ? (setup ? 290_000 : 130_000) : 54_000;
        const forwardFee = url.searchParams.get("forward") === "true" ? { forwardFee: { low: fwd - 4000, med: fwd, high: fwd + 6000 } } : {};
        return json(200, [
          { finalityThreshold: 1000, minimumFee: 1, ...forwardFee },
          { finalityThreshold: 2000, minimumFee: 0, ...forwardFee },
        ]);
      }
      if (p === "/v2/messages/29" || p === "/v2/messages/6") {
        const m = state.iris[url.searchParams.get("transactionHash") ?? ""];
        return m ? json(200, { messages: m }) : json(404, { error: "Message not found" });
      }
      return json(404, { error: "not found" });
    }
    if (url.host === "solana-rpc.publicnode.com" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
      const sol = state.solana;
      if (sol.down) return json(503, "down");
      const ok = (result: unknown) => json(200, { jsonrpc: "2.0", id: body.id, result });
      const ctx = { context: { slot: 400_000_000 } };
      const tokenAccount = (owner: string, mint: string, amount: bigint) => ({
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        lamports: 2039280,
        data: { parsed: { type: "account", info: { mint, owner, tokenAmount: { amount: amount.toString(), decimals: 6 } } }, program: "spl-token", space: 165 },
      });
      switch (body.method) {
        case "getGenesisHash":
          return ok(SOLANA_GENESIS);
        case "getAccountInfo": {
          const a = state.solanaAccounts[body.params[0] as string];
          return ok({ ...ctx, value: a ? { owner: a.owner, lamports: 2039280, data: ["", "base64"], executable: false, rentEpoch: 0, space: 165 } : null });
        }
        case "getBalance":
          return ok({ ...ctx, value: body.params[0] === ME_SOL ? Number(sol.lamports) : 0 });
        case "getTokenAccountsByOwner":
          // As publicnode: refused.
          return ok_err(body.id, -32602, "Request blocked");
        case "getMultipleAccounts":
          return ok({ ...ctx, value: (body.params[0] as string[]).map((a) => (a === ME_SOL_USDC && sol.usdc > 0n ? tokenAccount(ME_SOL, SOL_USDC, sol.usdc) : null)) });
        case "getLatestBlockhash":
          return ok({ ...ctx, value: { blockhash: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw", lastValidBlockHeight: sol.height + 150 } });
        case "getBlockHeight":
          return ok(sol.height);
        case "getRecentPrioritizationFees":
          return ok([{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 5000 }]);
        case "getMinimumBalanceForRentExemption":
          return ok(2039280);
        case "simulateTransaction":
          return ok({ ...ctx, value: { err: sol.simulateErr, logs: sol.simulateErr ? ["Program log: Error: insufficient funds"] : [], unitsConsumed: 30_000 } });
        case "sendTransaction": {
          const wire = Buffer.from(body.params[0] as string, "base64");
          const n = wire[0]!;
          const message = wire.subarray(1 + 64 * n);
          const keys = message[0] & 0x80 ? message.subarray(5) : message.subarray(4);
          for (let i = 0; i < n; i++) {
            const sig = wire.subarray(1 + 64 * i, 1 + 64 * (i + 1));
            assert.ok(ed25519.verify(sig, message, keys.subarray(32 * i, 32 * (i + 1))), `signature ${i} of a Solana transaction`);
          }
          sol.sent.push(body.params[0] as string);
          const signature = bs58(wire.subarray(1, 65));
          sol.landed[signature] ??= true;
          return ok(signature);
        }
        case "getSignatureStatuses":
          return ok({
            ...ctx,
            value: (body.params[0] as string[]).map((s) => (sol.landed[s] ? { slot: 400_000_000, confirmations: null, err: null, confirmationStatus: "confirmed" } : null)),
          });
        case "getSignaturesForAddress":
          return ok(body.params[0] === ME_SOL ? sol.history.map((h) => ({ signature: h.signature, slot: h.slot, blockTime: 1_794_249_151, err: null, confirmationStatus: "finalized" })) : []);
        case "getTransaction":
          return ok(sol.history.find((h) => h.signature === body.params[0])?.tx ?? null);
        default:
          state.unhandled.push(`solana ${body.method}`);
          return ok_err(body.id, -32601, "Method not found");
      }
    }
    if (url.host === "evm-api.choice.exchange" && p === "/route") {
      state.routeAsks.push(url.searchParams);
      const r = state.routes[`${url.searchParams.get("tokenIn")?.toLowerCase()} ${url.searchParams.get("tokenOut")?.toLowerCase()} ${url.searchParams.get("amountIn")}`];
      return r ? json(200, r) : json(404, { error: "no route" });
    }
    if (url.host === "evm-api.choice.exchange" && p === "/prices") {
      state.priceCalls++;
      if (state.pricesDown) return new Response("down", { status: 503 });
      return json(200, {
        observedAt: "2026-11-08T11:30:00.000Z",
        prices: [
          { address: "0x0000000000000000000000000000000000000000", symbol: "INJ", priceUsd: "8" },
          { address: "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13", symbol: "USDT", priceUsd: "1" },
          { address: LUMA, symbol: "LUMA", priceUsd: "0.002" },
          { address: CW_PAIR, symbol: "SHROOM", priceUsd: "0.5" },
        ],
      });
    }
    // Injective's SOL/USDC perpetual: its mark price prices SOL (USDC base units per SOL).
    if (p === "/injective/exchange/v1beta1/derivative/markets/0x291f404810c663e5fdd68b50454c1014760227842d420a2315f88311efe6ec41") {
      return json(200, { market: { market: { ticker: "SOL/USDC PERP", status: "Active", quote_denom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a" }, mark_price: "150000000.000000000000000000" } });
    }
    if (p === "/cosmos/bank/v1beta1/denoms_metadata_by_query_string") {
      state.metadataCalls++;
      const denom = url.searchParams.get("denom");
      if (denom === SCAM) return json(200, { metadata: { base: SCAM, display: "USDT", symbol: "USDT", name: "Tether USD", decimals: 6, denom_units: [] } });
      return json(404, { code: 5, message: "client metadata for denom", details: [] });
    }
    if (p === "/cosmos/staking/v1beta1/validators") {
      return json(200, { validators: [validatorJson(VAL_B, "Bravo", 900n * INJ), validatorJson(VAL_A, "Alpha", 100n * INJ)], pagination: { next_key: null } });
    }
    if (p === `/cosmos/staking/v1beta1/validators/${VAL_JAILED}`) return json(200, { validator: validatorJson(VAL_JAILED, "Jailed", 5n * INJ, true) });
    if (p === "/cosmos/staking/v1beta1/params") return json(200, { params: { unbonding_time: "1814400s", bond_denom: "inj" } });
    const stakingOf = /^\/cosmos\/(?:staking\/v1beta1\/delegations|staking\/v1beta1\/delegators|distribution\/v1beta1\/delegators)\/(inj1[0-9a-z]+)/.exec(p)?.[1];
    if (stakingOf && stakingOf !== ME) {
      // Anyone else has nothing staked.
      return json(200, { delegation_responses: [], unbonding_responses: [], rewards: [], total: [], withdraw_address: stakingOf });
    }
    if (p === `/cosmos/authz/v1beta1/grants/granter/${ME}`) return json(200, { grants: state.grants.map((g) => ({ granter: ME, ...g })), pagination: { next_key: null } });
    if (p.startsWith("/cosmos/authz/v1beta1/grants/granter/")) return json(200, { grants: [], pagination: { next_key: null } });
    if (p.startsWith("/cosmos/feegrant/v1beta1/issued/")) {
      const granter = p.split("/").pop()!;
      const list = granter === ME ? state.feeGrants : (state.issuedBy[granter] ?? []);
      return json(200, { allowances: list.map((g) => ({ granter, ...g })), pagination: { next_key: null } });
    }
    if (p === `/cosmos/distribution/v1beta1/delegators/${ME}/withdraw_address`) return json(200, { withdraw_address: state.rewardsTo ?? ME });
    if (p === `/cosmos/staking/v1beta1/delegations/${ME}`) {
      return json(200, {
        delegation_responses: Object.entries(state.delegations).map(([v, a]) => ({
          delegation: { delegator_address: ME, validator_address: v, shares: `${a}.000000000000000000` },
          balance: { denom: "inj", amount: a.toString() },
        })),
      });
    }
    if (p === `/cosmos/staking/v1beta1/delegators/${ME}/unbonding_delegations`) {
      return json(200, {
        unbonding_responses: state.unbonding.map((u) => ({
          delegator_address: ME,
          validator_address: u.validator,
          entries: [{ creation_height: String(u.height), completion_time: u.completes, initial_balance: u.amount.toString(), balance: u.amount.toString() }],
        })),
      });
    }
    if (p === `/cosmos/distribution/v1beta1/delegators/${ME}/rewards`) {
      return json(200, { rewards: Object.entries(state.rewards).map(([v, a]) => ({ validator_address: v, reward: [{ denom: "inj", amount: a }] })), total: [] });
    }
    if (p === "/cosmos/tx/v1beta1/simulate") {
      state.simulations++;
      // A bank send's events, as mainnet's simulate returns them: the fee, then the send.
      const { tx_bytes } = JSON.parse(String(init?.body)) as { tx_bytes: string };
      const sendsTo = Buffer.from(tx_bytes, "base64").toString("latin1").includes(THEM);
      const events = [
        ...moved(ME, FEE_COLLECTOR, "16000000000000inj"),
        { type: "tx", attributes: attrs({ fee: "16000000000000inj", fee_payer: ME }) },
        ...(sendsTo ? moved(ME, THEM, "1000000000000000000inj") : []),
      ];
      return json(200, { gas_info: { gas_wanted: "150000000", gas_used: opts.gasUsed ?? "82771" }, result: { data: "", log: "", events } });
    }
    if (p === "/cosmos/tx/v1beta1/txs" && init?.method === "POST") {
      const { tx_bytes, mode } = JSON.parse(String(init.body)) as { tx_bytes: string; mode: string };
      assert.equal(mode, "BROADCAST_MODE_SYNC");
      state.broadcasts.push(tx_bytes);
      const hash = createHash("sha256").update(Buffer.from(tx_bytes, "base64")).digest("hex").toUpperCase();
      return json(200, { tx_response: { txhash: hash, code: 0, raw_log: "" } });
    }
    if (p === "/cosmos/tx/v1beta1/txs") {
      // The tx index: what ME signed, and what it received.
      const q = url.searchParams.get("query") ?? "";
      if (url.searchParams.get("page") !== "1") {
        return json(500, { code: 13, message: "failed to search for txs: page should be within [1, 1] range, given 2", details: [] });
      }
      const byHash = /^ethereum_tx\.ethereumTxHash='(0x[0-9a-f]{64})'$/.exec(q);
      if (byHash) {
        state.evmLookups.push(byHash[1]!);
        const t = state.byEvmHash[byHash[1]!];
        return json(200, { tx_responses: t ? [t] : [], total: t ? "1" : "0" });
      }
      // The signed list goes on for pages; the received one fits in this page.
      if (q === `message.sender='${ME}'`) return json(200, { tx_responses: [...SIGNED, ...state.signedEvm], total: "120" });
      if (q === `coin_received.receiver='${ME}'`) return json(200, { tx_responses: [...state.receivedTxs, ...RECEIVED], total: String(2 + state.receivedTxs.length) });
      if (q === `coin_spent.spender='${ME}'`) return json(200, { tx_responses: state.spentTxs, total: String(state.spentTxs.length) });
      if (q === `wasm.to='${ME}'`) return json(200, { tx_responses: state.cw20In, total: String(state.cw20In.length) });
      const to = /^coin_received\.receiver='(inj1[0-9a-z]+)'$/.exec(q)?.[1];
      if (to && state.otherReceived[to]) return json(200, { tx_responses: state.otherReceived[to], total: String(state.otherReceived[to].length) });
      if (to) {
        state.depositChecks.push(to);
        const list = state.deposits[to] ?? [];
        return json(200, { tx_responses: list, total: String(list.length) });
      }
      return json(200, { tx_responses: [], total: "0" });
    }
    if (p.startsWith("/cosmos/tx/v1beta1/txs/")) {
      // A broadcast is in a block at once: a bank send of 1 INJ from ME to THEM, as the
      // index has it.
      const hash = p.split("/").pop()!;
      const known = state.broadcasts.some((b) => createHash("sha256").update(Buffer.from(b, "base64")).digest("hex").toUpperCase() === hash);
      return known
        ? json(200, { tx_response: { ...sentTx(190861703, hash), raw_log: "" } })
        : json(404, { code: 5, message: `tx not found: ${hash}`, details: [] });
    }
    state.unhandled.push(`${init?.method ?? "GET"} ${url.host}${p}`);
    return json(501, { code: 12, message: "Not Implemented", details: [] });
  };
  return { state, fetch };
}

const ok_err = (id: number, code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status: 200 });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58(b: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A bank send of 1 INJ from ME to THEM, as the index has it, at `height`, now. */
export function sentTx(height: number, hash = height.toString(16).padStart(64, "0").toUpperCase()) {
  const fee = "16000000000000inj";
  return {
    txhash: hash,
    height: String(height),
    timestamp: new Date().toISOString(),
    code: 0,
    tx: {
      body: { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: ME, to_address: THEM, amount: [{ denom: "inj", amount: INJ.toString() }] }], memo: "" },
      auth_info: { fee: { amount: [{ denom: "inj", amount: "16000000000000" }], gas_limit: "100000" } },
    },
    events: [
      ...moved(ME, FEE_COLLECTOR, fee),
      { type: "tx", attributes: attrs({ fee, fee_payer: ME }) },
      { type: "message", attributes: attrs({ action: "/cosmos.bank.v1beta1.MsgSend", sender: ME, module: "bank" }) },
      ...moved(ME, THEM, `${INJ}inj`),
    ],
  };
}

/** A service on these stores: a second one on the same stores is a service worker restart. */
/** What the service asked of the browser: approval windows opened (by request ID),
 *  "something changed" notices to pages, notifications shown (none while `popupOpen`),
 *  the toolbar count, refreshes asked of the wallet's pages, and the watcher's alarm. */
export type Ui = { opened: string[]; notified: number; notices?: { id: string; title: string; message: string }[]; badge?: string; refreshed?: number; popupOpen?: boolean; watching?: boolean };

export function serviceOn(net: ReturnType<typeof chain>, local: Store, session: Store, ui: Ui = { opened: [], notified: 0 }) {
  return createService({
    vault: async (method, params) => callVault(handle, method, params),
    local,
    session,
    fetch: net.fetch,
    scheduleLock: () => {},
    cancelLock: () => {},
    openWindow: async (id) => {
      ui.opened.push(id);
      return ui.opened.length;
    },
    notify: () => {
      ui.notified++;
    },
    refresh: () => {
      ui.refreshed = (ui.refreshed ?? 0) + 1;
    },
    async showNotice(n) {
      if (ui.popupOpen) return false;
      (ui.notices ??= []).push(n);
      return true;
    },
    badge: (text) => {
      ui.badge = text;
    },
    scheduleWatch: (on) => {
      ui.watching = on;
    },
  });
}

export async function wallet(net = chain()) {
  const local = memory();
  const session = memory();
  const ui: Ui = { opened: [], notified: 0 };
  const service = serviceOn(net, local, session, ui);
  const r = await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD });
  assert.ok(r.ok, JSON.stringify(r));
  return { service, session, local, net, ui };
}

/** The inj1 address of a private key, from the vault. */
export async function bech32Of(key: string): Promise<string> {
  const v = callVault<{ vault: string; unlock_key: string }>(handle, "create_vault", { password: PASSWORD });
  assert.ok(v.ok);
  const sealed = callVault<{ secret: string }>(handle, "seal_secret", { unlock_key: v.result.unlock_key, wallet: "w", secret: { private_key: key } });
  assert.ok(sealed.ok);
  const a = callVault<{ accounts: { addresses: Record<string, string> }[] }>(handle, "accounts", {
    secret: sealed.result.secret,
    wallet: "w",
    unlock_key: v.result.unlock_key,
    accounts: [{ derivation: "imported" }],
  });
  assert.ok(a.ok);
  return a.result.accounts[0]!.addresses["cosmos:injective-1"]!;
}

export const ok = <T>(r: { ok: boolean; result?: unknown; error?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.result as T;
};
export const code = (r: { ok: boolean; error?: { code: string; message: string } }) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return r.error!.code;
};

