// Balances and sends through the service worker's logic, against the real WASM vault and a
// fake LCD that answers like Injective mainnet (shapes recorded 2026-11-08).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { handle, initSync } from "choice-wallet-vault-glue";

import { createService, type Store } from "../src/service";
import { callVault } from "../src/vault";

initSync({ module: readFileSync(new URL("./choice_wallet_wasm_bg.wasm", import.meta.url)) });

// The BIP-39 test phrase: published, owned by no one. Its account exists on mainnet.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const ME_EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
// The EIP-155 example key (published) and its address, as a recipient.
const THEM_KEY = "4646464646464646464646464646464646464646464646464646464646464646";
const THEM_EVM = "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F";
const PASSWORD = "correct horse battery staple";
const INJ = 10n ** 18n;
const GAS_PRICE = 160_000_000n;
const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SCAM = "factory/inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49/usdt";

function memory(): Store & { data: Map<string, unknown> } {
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
const THEM = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
const FEE_COLLECTOR = "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9";
const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value, index: true }));
const moved = (from: string, to: string, amount: string) => [
  { type: "coin_spent", attributes: attrs({ spender: from, amount }) },
  { type: "coin_received", attributes: attrs({ receiver: to, amount }) },
  { type: "transfer", attributes: attrs({ recipient: to, sender: from, amount }) },
];
const indexed = (height: number, from: string, to: string, amount: string) => ({
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
const SIGNED = [indexed(100, ME, THEM, "1000000000000000000inj")];
const RECEIVED = [indexed(120, THEM, ME, `2500000${USDT}`), indexed(90, THEM, ME, `7000000${SCAM}`)];

// EVM-only tokens (no bank denom): one Choice prices, one to add by hand, and a contract
// that isn't a token. The USDT ERC20 (0x88f7…) is bank-backed through its token pair.
const LUMA = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
const ADDED = "0x1111111111111111111111111111111111111111";
const NOT_A_TOKEN = "0x2222222222222222222222222222222222222222";
const USDT_ERC20 = "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13";
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return `0x${"20".padStart(64, "0")}${(hex.length / 2).toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
};
const ERC20: Record<string, { symbol: string; name: string; decimals: number }> = {
  [LUMA]: { symbol: "LUMA", name: "Luma", decimals: 18 },
  [ADDED]: { symbol: "TEST", name: "Test token", decimals: 6 },
  [USDT_ERC20]: { symbol: "USDT", name: "Tether USD", decimals: 6 },
};

// CW20s (published mainnet contracts): SHROOM's, whose adapter bank form has an ERC20 pair
// Choice prices, and NONJA's, to add by hand. The adapter itself is a contract but no CW20.
const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
const CW = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const CW_ADDED = "inj1fu5u29slsg2xtsj7v5la22vl4mr4ywl7wlqeck";
const CW_BANK = `factory/${ADAPTER}/${CW}`;
const CW_PAIR = "0x3333333333333333333333333333333333333333";
const CW20: Record<string, { symbol: string; name: string; decimals: number }> = {
  [CW]: { symbol: "SHROOM", name: "shroomin", decimals: 18 },
  [CW_ADDED]: { symbol: "NONJA", name: "nonja", decimals: 18 },
};

/** A fake mainnet LCD and EVM JSON-RPC. `balances`, `evm` and `account` can be changed per test. */
function chain(opts: { balances?: Record<string, bigint>; evm?: Record<string, bigint>; cw20?: Record<string, bigint>; account?: boolean; gasUsed?: string; pricesDown?: boolean } = {}) {
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
      assert.ok(tx.data.startsWith("0xa9059cbb"), "an ERC20 transfer");
      return answer("0xb5f0"); // 46,576
    }
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
      assert.equal(data.slice(34).toLowerCase(), ME_EVM.slice(2).toLowerCase());
      return { jsonrpc: "2.0", id: r.id, result: `0x${(state.evm[to.toLowerCase()] ?? 0n).toString(16)}` };
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
    if (p === `/cosmos/bank/v1beta1/spendable_balances/${ME}`) {
      return json(200, { balances: Object.entries(state.balances).map(([denom, a]) => ({ denom, amount: a.toString() })), pagination: { next_key: null } });
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
        assert.equal(q.balance.address, ME);
        return json(200, { data: { balance: (state.cw20[smart[1]!] ?? 0n).toString() } });
      }
      return json(500, { code: 2, message: "unknown variant", details: [] });
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
      return json(200, { gas_info: { gas_wanted: "150000000", gas_used: opts.gasUsed ?? "82771" } });
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
      // The signed list goes on for pages; the received one fits in this page.
      if (q === `message.sender='${ME}'`) return json(200, { tx_responses: SIGNED, total: "120" });
      return json(200, { tx_responses: q === `coin_received.receiver='${ME}'` ? RECEIVED : [], total: "2" });
    }
    if (p.startsWith("/cosmos/tx/v1beta1/txs/")) {
      const hash = p.split("/").pop()!;
      const known = state.broadcasts.some((b) => createHash("sha256").update(Buffer.from(b, "base64")).digest("hex").toUpperCase() === hash);
      return known
        ? json(200, { tx_response: { txhash: hash, height: "190861703", code: 0, raw_log: "" } })
        : json(404, { code: 5, message: `tx not found: ${hash}`, details: [] });
    }
    return json(501, { code: 12, message: "Not Implemented", details: [] });
  };
  return { state, fetch };
}

/** A service on these stores: a second one on the same stores is a service worker restart. */
function serviceOn(net: ReturnType<typeof chain>, local: Store, session: Store) {
  return createService({
    vault: async (method, params) => callVault(handle, method, params),
    local,
    session,
    fetch: net.fetch,
    scheduleLock: () => {},
    cancelLock: () => {},
  });
}

async function wallet(net = chain()) {
  const local = memory();
  const session = memory();
  const service = serviceOn(net, local, session);
  const r = await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD });
  assert.ok(r.ok, JSON.stringify(r));
  return { service, session, local, net };
}

/** The inj1 address of a private key, from the vault. */
async function bech32Of(key: string): Promise<string> {
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

const ok = <T>(r: { ok: boolean; result?: unknown; error?: unknown }): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.result as T;
};
const code = (r: { ok: boolean; error?: { code: string; message: string } }) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return r.error!.code;
};

type Review = {
  digest: string;
  display: { messages: { type: string; to: string; amount: { denom: string; amount: string }[] }[]; fee: { amount: { denom: string; amount: string }[]; gas_limit: string } };
  risk: { level: string; confirm?: string; findings: { rule: string }[] };
  tokens: Record<string, { symbol: string; decimals: number; known: boolean }>;
  checkedBy: string;
};

test("balances: known tokens by name, others by their claimed symbol and marked", async () => {
  const { service } = await wallet(chain({ balances: { [SCAM]: 7n, inj: 5n * INJ, [USDT]: 2_500_000n } }));
  const { balances } = ok<{ balances: { denom: string; symbol: string; known: boolean; amount: string }[] }>(await service.handle({ type: "balances" }));
  assert.deepEqual(
    balances.map((b) => [b.symbol, b.known, b.amount]),
    [["INJ", true, "5000000000000000000"], ["USDT", true, "2500000"], ["USDT", false, "7"]],
  );
});

test("a send: prepare shows the vault's decode, confirm signs exactly that and broadcasts it", async () => {
  const { service, session, net } = await wallet();
  const review = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM_EVM, amount: (2n * INJ).toString() }));
  // The review is the vault's decode: the 0x address became the same account's inj1 form.
  const [m] = review.display.messages;
  assert.equal(m?.type, "bank_send");
  assert.equal(m?.to, await bech32Of(THEM_KEY));
  assert.deepEqual(m?.amount, [{ denom: "inj", amount: (2n * INJ).toString() }]);
  // Gas: simulated 82,771 × 1.3, at the chain's base fee.
  const gas = (82_771n * 13n) / 10n + 1n;
  assert.equal(review.display.fee.gas_limit, gas.toString());
  assert.deepEqual(review.display.fee.amount, [{ denom: "inj", amount: (gas * GAS_PRICE).toString() }]);
  assert.equal(review.tokens["inj"]?.symbol, "INJ");
  assert.equal(review.checkedBy, "sentry.lcd.injective.network");
  assert.equal(review.risk.level, "info");
  assert.ok(session.data.has("pending_send"));

  // Only the reviewed digest is signed.
  assert.equal(code(await service.handle({ type: "confirm_send", digest: "00".repeat(32) })), "not_approved");
  const sent = ok<{ hash: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);
  const bytes = Buffer.from(net.state.broadcasts[0]!, "base64");
  assert.equal(sent.hash, createHash("sha256").update(bytes).digest("hex").toUpperCase());
  assert.equal(sent.explorer, `https://injscan.com/transaction/${sent.hash}`);
  // The broadcast tx carries the reviewed send (the recipient's bech32 is in its body).
  assert.ok(bytes.includes(Buffer.from(m!.to)));
  // A second click can't send it again.
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest })), "not_approved");
  assert.equal(net.state.broadcasts.length, 1);
  assert.deepEqual(ok(await service.handle({ type: "tx_status", hash: sent.hash })), { state: "success" });
  assert.deepEqual(ok(await service.handle({ type: "tx_status", hash: "AB".repeat(32) })), { state: "pending" });
});

test("max sends everything but the fee", async () => {
  const { service } = await wallet();
  const review = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: ME_EVM, amount: "max" }));
  const fee = BigInt(review.display.fee.amount[0]!.amount);
  assert.equal(BigInt(review.display.messages[0]!.amount[0]!.amount) + fee, 5n * INJ);
  // All of it: the risk rules point that out.
  assert.deepEqual(review.risk.findings.map((f) => f.rule), ["most_of_balance"]);
});

test("refusals before anything is signed", async () => {
  const { service, net } = await wallet(chain({ balances: { inj: 1000n, [USDT]: 5n } }));
  const send = (denom: string, to: string, amount: string) => service.handle({ type: "prepare_send", denom, to, amount });
  assert.equal(code(await send("inj", ME, "0")), "invalid_amount");
  assert.equal(code(await send("inj", ME, "1.5")), "invalid_amount");
  assert.equal(code(await send(USDT, ME, "6")), "insufficient");
  // 1 inj is there, but not the fee.
  assert.equal(code(await send("inj", ME, "1")), "insufficient");
  assert.equal(code(await send(USDT, ME, "1")), "insufficient");
  assert.equal(net.state.simulations, 0);
  const bad = await wallet(chain());
  assert.equal(code(await bad.service.handle({ type: "prepare_send", denom: "inj", to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda95", amount: "1" })), "invalid_address");
  assert.equal(code(await bad.service.handle({ type: "prepare_send", denom: "inj", to: "cosmos1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz", amount: "1" })), "invalid_address");
  const fresh = await wallet(chain({ account: false }));
  assert.equal(code(await fresh.service.handle({ type: "prepare_send", denom: "inj", to: ME, amount: "1" })), "no_funds");
  const wild = await wallet(chain({ gasUsed: "90000000" }));
  assert.equal(code(await wild.service.handle({ type: "prepare_send", denom: "inj", to: ME, amount: "1" })), "chain");
});

test("a send that asks for a typed word needs it; locking drops the pending send", async () => {
  const { service, session } = await wallet();
  const review = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: ME, amount: "1" }));
  // Our own sends never need a word; force one to check the host enforces it.
  const pending = (await session.get(["pending_send"]))["pending_send"] as Record<string, unknown>;
  await session.set({ pending_send: { ...pending, confirm: "GRANT" } });
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest })), "confirm");
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest, confirm: "grant" })), "confirm");
  await session.set({ pending_send: { ...pending, blocked: true } });
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest })), "blocked");
  await service.handle({ type: "lock" });
  assert.equal(session.data.has("pending_send"), false);
  assert.equal(code(await service.handle({ type: "balances" })), "locked");
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest })), "locked");
});

test("settings: network and endpoints, https only", async () => {
  const { service, net } = await wallet();
  const s = ok<{ network: string; lcd: Record<string, string[]>; lcdDefault: Record<string, string[]> }>(await service.handle({ type: "settings" }));
  assert.equal(s.network, "mainnet");
  assert.deepEqual(s.lcd, s.lcdDefault);
  assert.equal(code(await service.handle({ type: "save_settings", network: "mainnet", lcd: ["http://lcd.example"] })), "invalid_endpoint");
  assert.equal(code(await service.handle({ type: "save_settings", network: "devnet", lcd: null })), "bad_request");
  assert.equal(code(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, evm: ["http://evm.example"] })), "invalid_endpoint");
  const saved = ok<{ lcd: Record<string, string[]>; evm: Record<string, string[]>; evmDefault: Record<string, string[]> }>(
    await service.handle({ type: "save_settings", network: "mainnet", lcd: ["https://my-node.example/ "], evm: ["https://my-evm.example"] }),
  );
  assert.deepEqual(saved.lcd["mainnet"], ["https://my-node.example"]);
  assert.deepEqual(saved.evm["mainnet"], ["https://my-evm.example"]);
  assert.deepEqual(saved.evm["testnet"], saved.evmDefault["testnet"]);
  net.state.hosts.clear();
  ok(await service.handle({ type: "balances" }));
  // Chain reads go only to the user's endpoints; the one other host is Choice's price list.
  assert.deepEqual([...net.state.hosts].sort(), ["evm-api.choice.exchange", "my-evm.example", "my-node.example"]);
  // Leaving `evm` out leaves it as it was.
  const kept = ok<{ evm: Record<string, string[]> }>(await service.handle({ type: "save_settings", network: "mainnet", lcd: ["https://my-node.example"] }));
  assert.deepEqual(kept.evm["mainnet"], ["https://my-evm.example"]);
  // Testnet: the status says so, and a mainnet node is refused (it serves injective-1).
  ok(await service.handle({ type: "save_settings", network: "testnet", lcd: null }));
  const st = ok<{ network: string }>(await service.handle({ type: "status" }));
  assert.equal(st.network, "testnet");
  assert.equal(code(await service.handle({ type: "balances" })), "unreachable");
});

test("USD values: mainnet only, from one bulk price list, and never in the way", async () => {
  const net = chain({ balances: { [SCAM]: 7n, inj: 5n * INJ, [USDT]: 2_500_000n } });
  const { service } = await wallet(net);
  const r = ok<B>(await service.handle({ type: "balances" }));
  assert.deepEqual(r.balances.map((b) => [b.symbol, b.usd, b.onChoice]), [["INJ", 40, true], ["USDT", 2.5, true], ["USDT", undefined, undefined]]);
  assert.equal(r.prices, true);
  assert.deepEqual(r.filter, { all: false, hideSmall: false, shown: [], hidden: [] });
  // The review prices the amount and the fee.
  const review = ok<Review & { tokens: Record<string, { priceUsd?: string }> }>(
    await service.handle({ type: "prepare_send", denom: "inj", to: ME, amount: INJ.toString() }),
  );
  assert.equal(review.tokens["inj"]?.priceUsd, "8");
  // Cached: one price request for both.
  assert.equal(net.state.priceCalls, 1);

  // Switched off: no request, no values. What Choice said before still counts for the filter.
  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, prices: false }));
  const off = ok<B>(await service.handle({ type: "balances" }));
  assert.ok(off.balances.every((b) => b.usd === undefined));
  assert.deepEqual(off.balances.map((b) => b.onChoice), [true, true, undefined]);
  assert.equal(off.prices, false);
  assert.equal(net.state.priceCalls, 1);
  assert.equal(ok<{ prices: boolean }>(await service.handle({ type: "settings" })).prices, false);

  // Choice down: balances still come back, without USD.
  const down = await wallet(chain({ pricesDown: true }));
  const d = ok<B>(await down.service.handle({ type: "balances" }));
  assert.deepEqual(d.balances.map((b) => [b.symbol, b.usd, b.onChoice]), [["INJ", undefined, undefined]]);
});

type B = { balances: { symbol: string; usd?: number; priceUsd?: string; onChoice?: boolean }[]; filter: unknown; prices: boolean };

test("a token Choice priced this week stays priced for the filter while Choice is down", async () => {
  const net = chain({ balances: { inj: 5n * INJ, [USDT]: 2_500_000n } });
  const { service, local, session } = await wallet(net);
  ok(await service.handle({ type: "balances" }));
  const seen = local.data.get("choice_seen") as Record<string, number>;
  assert.deepEqual(Object.keys(seen).sort(), ["0x0000000000000000000000000000000000000000", CW_PAIR, "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13", LUMA]);

  net.state.pricesDown = true;
  const restarted = ok<B>(await serviceOn(net, local, session).handle({ type: "balances" }));
  assert.deepEqual(restarted.balances.map((b) => [b.symbol, b.usd, b.onChoice]), [["INJ", undefined, true], ["USDT", undefined, true]]);

  // Past a week it no longer counts, and is dropped.
  const old = Date.now() - 8 * 24 * 3_600_000;
  local.data.set("choice_seen", Object.fromEntries(Object.keys(seen).map((a) => [a, old])));
  const later = ok<B>(await serviceOn(net, local, session).handle({ type: "balances" }));
  assert.ok(later.balances.every((b) => b.onChoice === undefined));

  // Back up: remembered again, without the stale entries.
  net.state.pricesDown = false;
  ok(await serviceOn(net, local, session).handle({ type: "balances" }));
  assert.ok(Object.values(local.data.get("choice_seen") as Record<string, number>).every((t) => t > old));
});

test("token filter: kept per network, and checked", async () => {
  const { service, local } = await wallet(chain({ balances: { inj: 5n * INJ, [SCAM]: 7n } }));
  const f = { all: false, hideSmall: true, shown: [SCAM], hidden: [USDT] };
  assert.deepEqual(ok(await service.handle({ type: "save_token_filter", filter: f })), f);
  assert.deepEqual(ok<B>(await service.handle({ type: "balances" })).filter, f);
  // Duplicates are dropped.
  assert.deepEqual(ok(await service.handle({ type: "save_token_filter", filter: { ...f, shown: [SCAM, SCAM] } })), f);

  // Another network has its own, starting from the default.
  ok(await service.handle({ type: "save_settings", network: "testnet", lcd: null }));
  const t = { all: true, hideSmall: false, shown: [], hidden: [] };
  ok(await service.handle({ type: "save_token_filter", filter: t }));
  assert.deepEqual(local.data.get("token_filter"), { mainnet: f, testnet: t });

  const many = Array.from({ length: 501 }, (_, i) => `factory/inj1x/t${i}`);
  for (const bad of [null, "all", { ...f, all: "yes" }, { ...f, shown: ["../../x"] }, { ...f, shown: [USDT] }, { ...f, hidden: many }, { ...f, shown: undefined }]) {
    assert.equal(code(await service.handle({ type: "save_token_filter", filter: bad })), "bad_request", JSON.stringify(bad)?.slice(0, 80));
  }
  // A damaged stored filter reads as the default.
  local.data.set("token_filter", { mainnet: { all: 1 } });
  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: null }));
  assert.deepEqual(ok<B>(await service.handle({ type: "balances" })).filter, { all: false, hideSmall: false, shown: [], hidden: [] });
});

test("activity: what it signed and what it received, merged, with how to show each token", async () => {
  const { service } = await wallet();
  type Page = {
    items: { height: string; kind: string; counterparty?: string; signed: boolean; changes: { denom: string; amount: string }[]; fee: unknown[] }[];
    tokens: Record<string, { symbol: string; known: boolean; onChoice?: boolean }>;
    more: boolean;
    cutoff: string | null;
    filter: unknown;
  };
  const first = ok<Page>(await service.handle({ type: "activity", page: 1 }));
  assert.deepEqual(
    first.items.map((a) => [a.height, a.kind, a.counterparty, a.signed]),
    [["120", "receive", THEM, false], ["100", "send", THEM, true], ["90", "receive", THEM, false]],
  );
  assert.deepEqual(first.items[1]!.changes, [{ denom: "inj", amount: "-1000000000000000000" }]);
  assert.equal(first.items[1]!.fee.length, 1);
  // Show down to 100: below that, the signed list's next page could still hold newer rows.
  assert.equal(first.cutoff, "100");
  assert.equal(first.more, true);
  assert.deepEqual(
    Object.entries(first.tokens).map(([d, t]) => [d, t.symbol, t.known, t.onChoice ?? false]).sort(),
    [[SCAM, "USDT", false, false], ["inj", "INJ", true, true], [USDT, "USDT", true, true]].sort(),
  );
  assert.deepEqual(first.filter, { all: false, hideSmall: false, shown: [], hidden: [] });
  // Past the end: nothing more, nothing held back.
  const second = ok<Page>(await service.handle({ type: "activity", page: 2 }));
  assert.deepEqual([second.items.length, second.more, second.cutoff], [0, false, null]);

  assert.equal(code(await service.handle({ type: "activity", page: 0 })), "bad_request");
  assert.equal(code(await service.handle({ type: "activity", page: "1" })), "bad_request");
  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "activity", page: 1 })), "locked");
});

test("EVM-only tokens: found through Choice's list or added by hand, never twice", async () => {
  const net = chain({ balances: { inj: 5n * INJ, [USDT]: 2_500_000n }, evm: { [LUMA]: 3000n * INJ, [USDT_ERC20]: 2_500_000n } });
  const { service, local } = await wallet(net);
  type Row = { denom: string; symbol: string; amount: string; onChoice?: boolean; usd?: number };
  const rows = async () => ok<{ balances: Row[]; evmDown?: true }>(await service.handle({ type: "balances" }));
  const first = await rows();
  assert.deepEqual(
    first.balances.map((b) => [b.denom, b.symbol, b.amount, b.onChoice ?? false, b.usd]),
    [
      ["inj", "INJ", (5n * INJ).toString(), true, 40],
      [USDT, "USDT", "2500000", true, 2.5],
      [`evm:${LUMA}`, "LUMA", (3000n * INJ).toString(), true, 6],
    ],
  );
  // The USDT ERC20 is the bank denom's own pair: never asked on the EVM side, never twice.
  assert.deepEqual([...new Set(net.state.evmBalanceCalls)], [LUMA]);
  assert.equal(first.evmDown, undefined);

  // Added by hand: listed even when empty, and shown though the filter would hide it.
  const added = ok<{ denom: string; symbol: string; filter: { shown: string[] } }>(
    await service.handle({ type: "add_token", address: "0x1111111111111111111111111111111111111111" }),
  );
  assert.deepEqual([added.denom, added.symbol], [`evm:${ADDED}`, "TEST"]);
  assert.ok(added.filter.shown.includes(`evm:${ADDED}`));
  assert.deepEqual(local.data.get("custom_tokens"), { mainnet: [ADDED] });
  const second = await rows();
  assert.deepEqual(second.balances.at(-1), { denom: `evm:${ADDED}`, symbol: "TEST", name: "Test token", decimals: 6, known: false, amount: "0" });

  // A contract a bank denom covers: that denom is shown, nothing is added.
  const backed = ok<{ denom: string; filter: { shown: string[] } }>(await service.handle({ type: "add_token", address: USDT_ERC20 }));
  assert.equal(backed.denom, USDT);
  assert.ok(backed.filter.shown.includes(USDT));
  assert.deepEqual(local.data.get("custom_tokens"), { mainnet: [ADDED] });

  // Refused: not an address, the native coin, and a contract that isn't a token.
  assert.equal(code(await service.handle({ type: "add_token", address: "0x123" })), "invalid_address");
  assert.equal(code(await service.handle({ type: "add_token", address: "0x0000000000000000000000000000000000000000" })), "invalid_address");
  assert.equal(code(await service.handle({ type: "add_token", address: NOT_A_TOKEN })), "not_a_token");

  // The EVM side down: the bank list still comes back, flagged.
  net.state.evmDown = true;
  const down = await rows();
  assert.equal(down.evmDown, true);
  assert.deepEqual(down.balances.map((b) => b.denom), ["inj", USDT]);

  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "add_token", address: ADDED })), "locked");
});

test("an EVM-only token's send: an ERC20 transfer the vault decodes and signs, fee in INJ", async () => {
  const net = chain({ evm: { [LUMA]: 3000n * INJ } });
  const { service } = await wallet(net);
  type EvmReview = {
    digest: string;
    display: { kind: string; to: string; nonce: string; gas_limit: string; max_fee_per_gas: string; max_priority_fee_per_gas: string; max_gas_cost: string; call: { type: string; to: string; amount: string } };
    risk: { level: string };
    tokens: Record<string, { symbol: string }>;
    checkedBy: string;
  };
  const amount = (100n * INJ).toString();
  const review = ok<EvmReview>(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: THEM_EVM, amount }));
  assert.equal(review.display.kind, "evm_transaction");
  assert.equal(review.display.to.toLowerCase(), LUMA);
  assert.deepEqual(review.display.call, { type: "erc20_transfer", to: THEM_EVM, amount });
  // 46,576 gas estimated, times 1.2; the base fee (160000000) and no tip: Injective charges
  // gas limit × max fee, so no headroom is added.
  assert.equal(review.display.gas_limit, "55892");
  assert.equal(review.display.max_fee_per_gas, "160000000");
  assert.equal(review.display.max_priority_fee_per_gas, "0");
  assert.equal(review.display.max_gas_cost, (55892n * 160000000n).toString());
  assert.equal(review.display.nonce, "3");
  assert.equal(review.tokens[`evm:${LUMA}`]?.symbol, "LUMA");
  assert.equal(review.tokens["inj"]?.symbol, "INJ");
  assert.equal(review.checkedBy, "sentry.evm-rpc.injective.network");
  assert.notEqual(review.risk.level, "blocked");

  // An inj1 recipient is the same account: the transfer goes to its 0x form.
  const viaBech32 = ok<EvmReview>(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: await bech32Of(THEM_KEY), amount }));
  assert.equal(viaBech32.display.call.to, THEM_EVM);
  const sent = ok<{ hash: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: viaBech32.digest }));
  assert.match(sent.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(sent.explorer, `https://blockscout.injective.network/tx/${sent.hash}`);
  assert.equal(net.state.evmSent.length, 1);
  const transfer = `a9059cbb${THEM_EVM.slice(2).toLowerCase().padStart(64, "0")}${(100n * INJ).toString(16).padStart(64, "0")}`;
  assert.ok(net.state.evmSent[0]!.startsWith("0x02") && net.state.evmSent[0]!.includes(transfer), "a type-2 tx carrying exactly the reviewed transfer");
  assert.deepEqual(ok(await service.handle({ type: "tx_status", hash: sent.hash })), { state: "success" });
  // The approval was single-use.
  assert.equal(code(await service.handle({ type: "confirm_send", digest: viaBech32.digest })), "not_approved");

  // Refused before anything is signed: more than held, and no INJ for the fee.
  assert.equal(code(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: THEM_EVM, amount: (5000n * INJ).toString() })), "insufficient");
  assert.equal(code(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: "0x123", amount })), "invalid_address");
  net.state.balances = {};
  assert.equal(code(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: THEM_EVM, amount })), "insufficient");
  assert.equal(net.state.evmSent.length, 1);
});

test("CW20s: found through pairs, held bank forms and additions; priced as their bank form", async () => {
  const { service, net } = await wallet(chain({ cw20: { [CW]: 3n * INJ } }));
  type B = { denom: string; symbol: string; amount: string; usd?: number; convertsTo?: string; known: boolean };
  const first = ok<{ balances: B[] }>(await service.handle({ type: "balances" })).balances;
  const shroom = first.find((b) => b.denom === `cw20:${CW}`);
  assert.deepEqual(
    { symbol: shroom?.symbol, amount: shroom?.amount, usd: shroom?.usd, convertsTo: shroom?.convertsTo, known: shroom?.known },
    { symbol: "SHROOM", amount: (3n * INJ).toString(), usd: 1.5, convertsTo: CW_BANK, known: false },
  );
  // Only the paired CW20 was asked: nothing else is a candidate yet.
  assert.deepEqual(net.state.cw20Calls, [CW]);

  // Added by contract: shown at zero, and its CW20 is asked from then on.
  const added = ok<{ denom: string; symbol: string; filter: { shown: string[] } }>(await service.handle({ type: "add_token", address: CW_ADDED.toUpperCase() }));
  assert.deepEqual([added.denom, added.symbol], [`cw20:${CW_ADDED}`, "NONJA"]);
  assert.ok(added.filter.shown.includes(`cw20:${CW_ADDED}`));
  const after = ok<{ balances: B[] }>(await service.handle({ type: "balances" })).balances;
  assert.equal(after.find((b) => b.denom === `cw20:${CW_ADDED}`)?.amount, "0");
  assert.equal(code(await service.handle({ type: "add_token", address: ADAPTER })), "not_a_token");

  // The bank form, held: convertible back, and priced through its pair.
  net.state.balances[CW_BANK] = 2n * INJ;
  const bank = ok<{ balances: B[] }>(await service.handle({ type: "balances" })).balances.find((b) => b.denom === CW_BANK);
  assert.deepEqual([bank?.symbol, bank?.usd, bank?.convertsTo], ["SHROOM", 1, `cw20:${CW}`]);
});

test("a CW20 send: a cw20_transfer the vault decodes and signs, checked against the CW20 balance", async () => {
  const { service, net } = await wallet(chain({ cw20: { [CW]: 3n * INJ } }));
  assert.equal(code(await service.handle({ type: "prepare_send", denom: `cw20:${CW}`, to: THEM, amount: (4n * INJ).toString() })), "insufficient");
  const review = ok<Review>(await service.handle({ type: "prepare_send", denom: `cw20:${CW}`, to: THEM, amount: "max" }));
  const m = review.display.messages[0] as unknown as { type: string; contract: string; call: { type: string; recipient: string; amount: string } };
  assert.deepEqual([m.type, m.contract, m.call], ["execute_contract", CW, { type: "cw20_transfer", recipient: THEM, amount: (3n * INJ).toString() }]);
  assert.equal(review.tokens[`cw20:${CW}`]?.symbol, "SHROOM");
  // All of it, against the CW20's own balance, said in the risk rules' words.
  assert.ok(review.risk.findings.some((f) => f.rule === "most_of_balance"), JSON.stringify(review.risk));
  const sent = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: review.digest, ...(review.risk.confirm ? { confirm: review.risk.confirm } : {}) }));
  assert.equal(net.state.broadcasts.length, 1);
  assert.match(sent.hash, /^[0-9A-F]{64}$/);
});

test("conversions: a CW20 into its bank form and back, through the adapter only", async () => {
  const { service } = await wallet(chain({ cw20: { [CW]: 3n * INJ }, balances: { inj: 5n * INJ, [CW_BANK]: 2n * INJ } }));
  type Msg = { type: string; contract: string; funds: { denom: string; amount: string }[]; call: Record<string, unknown> };
  const toBank = ok<Review>(await service.handle({ type: "prepare_convert", denom: `cw20:${CW}`, amount: INJ.toString() }));
  const a = toBank.display.messages[0] as unknown as Msg;
  assert.deepEqual([a.contract, a.call], [CW, { type: "cw20_send", contract: ADAPTER, amount: INJ.toString(), msg: "" }]);
  // The adapter is the wallet's own known contract: no note about a contract running code,
  // and converting most of a balance loses none of it.
  assert.deepEqual(toBank.risk.findings, [], JSON.stringify(toBank.risk));
  assert.ok(toBank.tokens[CW_BANK] && toBank.tokens[`cw20:${CW}`]);

  const back = ok<Review>(await service.handle({ type: "prepare_convert", denom: CW_BANK, amount: "max" }));
  const b = back.display.messages[0] as unknown as Msg;
  assert.deepEqual([b.contract, b.funds, b.call["type"]], [ADAPTER, [{ denom: CW_BANK, amount: (2n * INJ).toString() }], "adapter_redeem"]);
  assert.ok(back.tokens[`cw20:${CW}`], "the CW20 it returns is described");
  assert.deepEqual(back.risk.findings, [], JSON.stringify(back.risk));

  assert.equal(code(await service.handle({ type: "prepare_convert", denom: "inj", amount: "1" })), "bad_request");
  assert.equal(code(await service.handle({ type: "prepare_convert", denom: `cw20:${CW}`, amount: (4n * INJ).toString() })), "insufficient");
});
