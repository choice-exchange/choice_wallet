// A fake mainnet for the host's tests: LCD and EVM JSON-RPC answers shaped as Injective's
// (recorded 2026-11-08/09), memory stores, and a service on them with the real vault.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
export const ERC20: Record<string, { symbol: string; name: string; decimals: number }> = {
  [LUMA]: { symbol: "LUMA", name: "Luma", decimals: 18 },
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
export function chain(opts: { balances?: Record<string, bigint>; evm?: Record<string, bigint>; cw20?: Record<string, bigint>; account?: boolean; gasUsed?: string; pricesDown?: boolean } = {}) {
  const state = {
    balances: opts.balances ?? { inj: 5n * INJ },
    evm: opts.evm ?? {},
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
      assert.equal(tx.from.toLowerCase(), ME_EVM.toLowerCase());
      if (tx.data === "0xdeadbeef") return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
      return answer(tx.data.startsWith("0xa9059cbb") ? "0xb5f0" : "0x5208"); // 46,576 for an ERC20 transfer; 21,000 for a plain send
    }
    if (r.method === "eth_blockNumber") return answer("0xb6137d8");
    if (r.method === "eth_sendRawTransaction") {
      state.evmSent.push(r.params[0] as unknown as string);
      return answer(`0x${"ab".repeat(32)}`);
    }
    if (r.method === "eth_getTransactionReceipt") return answer(state.evmSent.length ? { status: "0x1" } : null);
    const { to, data } = r.params[0]!;
    const t = ERC20[to.toLowerCase()];
    if (r.method !== "eth_call" || !t) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
    if (data.startsWith("0x70a08231")) {
      state.evmBalanceCalls.push(to.toLowerCase());
      // ME holds `evm`; any other account, none.
      const mine = data.slice(34).toLowerCase() === ME_EVM.slice(2).toLowerCase();
      return { jsonrpc: "2.0", id: r.id, result: `0x${(mine ? (state.evm[to.toLowerCase()] ?? 0n) : 0n).toString(16)}` };
    }
    const result = data === "0x95d89b41" ? abiString(t.symbol) : data === "0x06fdde03" ? abiString(t.name) : `0x${t.decimals.toString(16).padStart(64, "0")}`;
    return { jsonrpc: "2.0", id: r.id, result };
  };
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    state.hosts.add(url.host);
    const p = url.pathname;
    if (init?.method === "POST" && p === "/") {
      // EVM JSON-RPC.
      if (state.evmDown) return new Response("down", { status: 503 });
      const body = JSON.parse(String(init.body)) as Rpc | Rpc[];
      return json(200, Array.isArray(body) ? body.map(rpc) : rpc(body));
    }
    if (p.endsWith("/node_info")) return json(200, { default_node_info: { network: "injective-1" } });
    if (p === `/cosmos/auth/v1beta1/accounts/${ME}`) {
      return state.account
        ? json(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: ME, pub_key: null, account_number: "1680321", sequence: "2" } } })
        : json(404, { code: 5, message: `account ${ME} not found`, details: [] });
    }
    if (p.startsWith("/cosmos/bank/v1beta1/spendable_balances/")) {
      // ME holds `balances`; any other account, nothing.
      const who = p.split("/").pop()!;
      state.balanceAsked.push(who);
      const list = who === ME ? Object.entries(state.balances).map(([denom, a]) => ({ denom, amount: a.toString() })) : [];
      return json(200, { balances: list, pagination: { next_key: null } });
    }
    if (p === "/injective/txfees/v1beta1/cur_eip_base_fee") return json(200, { base_fee: { base_fee: "160000000.000000000000000000" } });
    if (p === "/injective/erc20/v1beta1/all_token_pairs") {
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
      const q = JSON.parse(atob(decodeURIComponent(smart[2]!))) as { balance?: { address: string }; token_info?: object };
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
      const rows = state.blockscout.map((t) => ({ blockNumber: String(t.blockNumber), hash: t.hash, from: THEM_EVM.toLowerCase(), to: ME_EVM.toLowerCase(), value: "1" }));
      return json(200, rows.length ? { message: "OK", result: rows, status: "1" } : { message: "No token transfers found", result: [], status: "0" });
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
    if (p === "/cosmos/bank/v1beta1/denoms_metadata_by_query_string") {
      const denom = url.searchParams.get("denom");
      if (denom === SCAM) return json(200, { metadata: { base: SCAM, display: "USDT", symbol: "USDT", name: "Tether USD", decimals: 6, denom_units: [] } });
      return json(404, { code: 5, message: "client metadata for denom", details: [] });
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
      return json(200, { tx_responses: q === `coin_received.receiver='${ME}'` ? RECEIVED : [], total: "2" });
    }
    if (p.startsWith("/cosmos/tx/v1beta1/txs/")) {
      const hash = p.split("/").pop()!;
      const known = state.broadcasts.some((b) => createHash("sha256").update(Buffer.from(b, "base64")).digest("hex").toUpperCase() === hash);
      return known
        ? json(200, { tx_response: { txhash: hash, height: "190861703", code: 0, raw_log: "" } })
        : json(404, { code: 5, message: `tx not found: ${hash}`, details: [] });
    }
    state.unhandled.push(`${init?.method ?? "GET"} ${url.host}${p}`);
    return json(501, { code: 12, message: "Not Implemented", details: [] });
  };
  return { state, fetch };
}

/** A service on these stores: a second one on the same stores is a service worker restart. */
/** What the service asked of the browser: approval windows opened (by request ID) and
 *  "something changed" notices to pages. */
export type Ui = { opened: string[]; notified: number };

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
  const ks = callVault<{ keystore: string }>(handle, "create_keystore", { secret: { private_key: key }, password: PASSWORD });
  assert.ok(ks.ok);
  const u = callVault<{ unlock_key: string }>(handle, "unlock", { keystore: ks.result.keystore, password: PASSWORD });
  assert.ok(u.ok);
  const a = callVault<{ accounts: { addresses: Record<string, string> }[] }>(handle, "accounts", {
    keystore: ks.result.keystore,
    unlock_key: u.result.unlock_key,
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

