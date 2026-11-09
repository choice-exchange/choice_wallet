// The LCD client against a fake network. Response bodies are as Injective mainnet sent
// them on 2026-11-08, including how each endpoint fails.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import { ChainError, Unreachable, type Fetch } from "../src/pool.ts";
import { adapterCw20, adapterDenom, cw20Address, cw20Denom, describeToken, otherForm, shortDenom } from "../src/tokens.ts";
import { ethMessage, rawTx, resultData, transferCall, transferLog } from "./evm-fixture.ts";

const ADDR = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const NODE_INFO = { default_node_info: { network: "injective-1" } };

type Reply = { status: number; body: unknown } | "network-error" | "html-503";
type Route = (url: string, init?: RequestInit) => Reply | undefined;

/** A fake network: each host answers through its routes; calls are logged. Every host
 *  serves injective-1 unless `nodeInfo` says otherwise. */
function fake(hosts: Record<string, Route>, nodeInfo: Record<string, Reply> = {}) {
  const calls: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const isInfo = url.pathname.endsWith("/node_info");
    if (!isInfo) calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const reply = isInfo
      ? (nodeInfo[url.host] ?? { status: 200, body: NODE_INFO })
      : (hosts[url.host]?.(url.pathname + url.search, init) ?? { status: 404, body: { code: 12, message: "Not Implemented" } });
    if (reply === "network-error") throw new TypeError("fetch failed");
    if (reply === "html-503") return new Response("Service Unavailable", { status: 503 });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch, calls };
}

const lcd = (fetch: Fetch, hosts = ["a.example", "b.example"]) =>
  new Lcd(NETWORKS.mainnet, hosts.map((h) => `https://${h}`), fetch, 1000);

test("accounts: Injective's EthAccount, and a fresh address", async () => {
  const { fetch } = fake({
    "a.example": (p) =>
      p.endsWith(ADDR)
        ? {
            status: 200,
            body: {
              account: {
                "@type": "/injective.types.v1beta1.EthAccount",
                base_account: { address: ADDR, pub_key: null, account_number: "1680321", sequence: "2" },
                code_hash: "xdJGAYb3IzySfn2y3McDwOUAtlPKgic7e/rYBF2FpHA=",
              },
            },
          }
        : { status: 404, body: { code: 5, message: "account inj1utfp9svg96kwptxrrkrta8qdtfl7su3vm45wy6 not found", details: [] } },
  });
  const c = lcd(fetch);
  assert.deepEqual(await c.account(ADDR), { address: ADDR, accountNumber: 1680321n, sequence: 2n });
  assert.equal(await c.account("inj1utfp9svg96kwptxrrkrta8qdtfl7su3vm45wy6"), null);
});

test("a node that returns someone else's account is refused", async () => {
  const { fetch } = fake({
    "a.example": () => ({ status: 200, body: { account: { base_account: { address: "inj1other", account_number: "1", sequence: "0" } } } }),
  });
  await assert.rejects(lcd(fetch).account(ADDR), /another account/);
});

test("failover: network errors, HTML errors and wrong chains are skipped; chain errors are final", async () => {
  const { fetch, calls } = fake({
    "a.example": () => "network-error",
    "b.example": () => ({ status: 200, body: { gas_info: { gas_used: "1" } } }),
    "c.example": () => "html-503",
    "d.example": (p) => (p.includes("/simulate") ? { status: 500, body: { code: 2, message: "failed to execute message; message index: 0: spendable balance 1inj is smaller than 2inj: insufficient funds [!injective!labs/cosmos-sdk@v0.50.15-inj.1/x/bank/keeper/send.go:334] With gas wanted: '0' and gas used: '1156' " } } : undefined),
    "e.example": () => ({ status: 200, body: { gas_info: { gas_used: "82771" } } }),
  }, { "b.example": { status: 200, body: { default_node_info: { network: "injective-888" } } } });
  const c = lcd(fetch, ["a.example", "b.example", "c.example", "d.example", "e.example"]);
  await assert.rejects(c.simulate("0a00"), (e: unknown) => {
    assert.ok(e instanceof ChainError);
    assert.equal(e.message, "failed to execute message; message index: 0: spendable balance 1inj is smaller than 2inj: insufficient funds");
    return true;
  });
  // b (testnet) answered, but a wrong-chain answer doesn't count; e was never asked: d's
  // chain error is the answer.
  assert.ok(!calls.some((x) => x.includes("e.example")));
  // The next call starts at d, the endpoint that answered.
  calls.length = 0;
  await assert.rejects(c.simulate("0a00"), ChainError);
  assert.deepEqual(calls, ["POST d.example/cosmos/tx/v1beta1/simulate"]);
});

test("a read goes out while the endpoint is identified; a broadcast waits for it", async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    order.push(url.pathname.split("/").pop()!);
    if (url.pathname.endsWith("/node_info")) {
      await held;
      return new Response(JSON.stringify(NODE_INFO));
    }
    if (init?.method === "POST") return new Response(JSON.stringify({ tx_response: { txhash: "H", code: 0 } }));
    return new Response(JSON.stringify({ balances: [{ denom: "inj", amount: "5" }], pagination: {} }));
  };
  const c = lcd(fetch, ["a.example"]);
  const read = c.balances(ADDR);
  await new Promise((r) => setTimeout(r, 10));
  // Both requests are out; the answer waits for the node to say which chain it serves.
  assert.deepEqual(order, ["node_info", ADDR]);
  release();
  assert.deepEqual(await read, [{ denom: "inj", amount: "5" }]);

  order.length = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((r) => (unblock = r));
  const slow: Fetch = async (input, init) => {
    if (new URL(input).pathname.endsWith("/node_info")) await gate;
    return fetch(input, init);
  };
  const w = new Lcd(NETWORKS.mainnet, ["https://b.example"], slow, 1000).broadcast("0a00", "H");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, []);
  unblock();
  assert.deepEqual(await w, { hash: "H", uncertain: false });
  assert.deepEqual(order, ["node_info", "txs"]);
});

test("a wrong-chain endpoint's read answer is thrown away, even when it comes first", async () => {
  const { fetch } = fake(
    { "a.example": () => ({ status: 200, body: { balances: [{ denom: "inj", amount: "999" }], pagination: {} } }), "b.example": () => ({ status: 200, body: { balances: [{ denom: "inj", amount: "5" }], pagination: {} } }) },
    { "a.example": { status: 200, body: { default_node_info: { network: "injective-888" } } } },
  );
  assert.deepEqual(await lcd(fetch).balances(ADDR), [{ denom: "inj", amount: "5" }]);
});

test("no endpoint answering is reported as such", async () => {
  const { fetch } = fake({ "a.example": () => "network-error", "b.example": () => "html-503" });
  await assert.rejects(lcd(fetch).balances(ADDR), (e: unknown) => {
    assert.ok(e instanceof Unreachable);
    assert.equal(e.attempts.length, 2);
    return true;
  });
});

test("overloaded nodes (gRPC unavailable) are skipped", async () => {
  const { fetch } = fake({
    "a.example": () => ({ status: 503, body: { code: 14, message: "connection refused" } }),
    "b.example": () => ({ status: 200, body: { gas_info: { gas_used: "100" } } }),
  });
  assert.equal(await lcd(fetch).simulate("0a00"), 100n);
});

test("balances follow pagination on one endpoint and check every coin", async () => {
  const { fetch } = fake({
    "a.example": (p) =>
      p.includes("pagination.key=")
        ? { status: 200, body: { balances: [{ denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "5" }], pagination: { next_key: null } } }
        : { status: 200, body: { balances: [{ denom: "inj", amount: "1" }], pagination: { next_key: "AAE=" } } },
    "b.example": () => ({ status: 200, body: { balances: [{ denom: "inj", amount: "-1" }] } }),
  });
  assert.deepEqual(await lcd(fetch).balances(ADDR), [
    { denom: "inj", amount: "1" },
    { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "5" },
  ]);
  await assert.rejects(lcd(fetch, ["b.example"]).balances(ADDR), Unreachable);
});

test("gas price stays within the chain's bounds", async () => {
  const at = (fee: string) =>
    lcd(fake({ "a.example": () => ({ status: 200, body: { base_fee: { base_fee: fee } } }) }).fetch).gasPrice();
  assert.equal(await at("160000000.000000000000000000"), 160_000_000n);
  assert.equal(await at("200000000.5"), 200_000_001n);
  assert.equal(await at("1"), 160_000_000n);
  assert.equal(await at("1000000000000000000000"), 160_000_000_000n);
  // A chain without the txfees module: the minimum.
  assert.equal(await lcd(fake({}).fetch).gasPrice(), 160_000_000n);
});

test("broadcast: success, already relayed by a retry, and refusals", async () => {
  const ok = (code: number, raw_log = "") => ({ status: 200, body: { tx_response: { txhash: "H", code, raw_log } } });
  assert.deepEqual(await lcd(fake({ "a.example": () => ok(0) }).fetch).broadcast("0a00", "H"), { hash: "H", uncertain: false });
  // a timed out after relaying; b already has it.
  const relayed = fake({ "a.example": () => "network-error", "b.example": () => ok(19, "tx already exists in cache") });
  assert.deepEqual(await lcd(relayed.fetch).broadcast("0a00", "H"), { hash: "H", uncertain: true });
  const seq = fake({ "a.example": () => "network-error", "b.example": () => ok(32, "account sequence mismatch") });
  assert.deepEqual(await lcd(seq.fetch).broadcast("0a00", "H"), { hash: "H", uncertain: true });
  // On the first try, a sequence mismatch is a real refusal.
  await assert.rejects(lcd(fake({ "a.example": () => ok(32, "account sequence mismatch, expected 3, got 2: incorrect account sequence") }).fetch).broadcast("0a00", "H"), /sequence mismatch/);
  // The sentry's way of refusing a tx: HTTP 500 with the chain's error.
  const sentry = fake({ "a.example": () => ({ status: 500, body: { code: 2, message: "broadcast error on transaction validation: tx H is invalid: code=18, data=, log='must contain at least one message: invalid request', codespace='sdk'", details: [] } }) });
  await assert.rejects(lcd(sentry.fetch).broadcast("0a00", "H"), /must contain at least one message/);
});

test("tx status: pending, done, and a lying node", async () => {
  const done = { status: 200, body: { tx_response: { txhash: "ABC", height: "190861703", code: 0, raw_log: "" } } };
  assert.deepEqual(await lcd(fake({ "a.example": () => done }).fetch).tx("abc"), { hash: "abc", height: 190861703n, code: 0, log: "" });
  const missing = { status: 404, body: { code: 5, message: "tx not found: ABC", details: [] } };
  assert.equal(await lcd(fake({ "a.example": () => missing }).fetch).tx("ABC"), null);
  await assert.rejects(lcd(fake({ "a.example": () => done }).fetch).tx("DEF"), /another transaction/);
});

test("tokens: the wallet's list first, then chain metadata, sanitised", async () => {
  const meta = (m: unknown) => fake({ "a.example": (p) => (p.includes("denoms_metadata") ? { status: 200, body: { metadata: m } } : undefined) }).fetch;
  const usdt = await describeToken(lcd(meta(null)), "mainnet", "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7");
  assert.deepEqual(usdt, { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD (Peggy)", decimals: 6, known: true });
  // A token whose creator calls it "USDT", with a right-to-left override hidden in it.
  const fake1 = "factory/inj1scam/usdt";
  const t = await describeToken(
    lcd(meta({ base: fake1, display: "USDT", symbol: `US${String.fromCharCode(0x202e)}DT`, name: "Tether", decimals: 6, denom_units: [] })),
    "mainnet",
    fake1,
  );
  assert.deepEqual(t, { denom: fake1, symbol: "USDT", name: "Tether", decimals: 6, known: false });
  // decimals from denom_units when the Injective field is missing.
  const d = "factory/inj1x/abc";
  const t2 = await describeToken(lcd(meta({ base: d, display: "ABC", symbol: "ABC", denom_units: [{ denom: d, exponent: 0 }, { denom: "ABC", exponent: 8 }] })), "mainnet", d);
  assert.equal(t2.decimals, 8);
  // No metadata: raw base units under a shortened denom.
  const long = "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1q6zlut7gtkzknkk773jecujwsdkgq882akqksk";
  const t3 = await describeToken(lcd(fake({}).fetch), "mainnet", long);
  assert.deepEqual(t3, { denom: long, symbol: "factory/inj1…akqksk", name: "", decimals: 0, known: false });
});

// SHROOM's CW20 on mainnet (a published contract), and its adapter bank form.
const SHROOM_CW20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const SHROOM_BANK = `factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/${SHROOM_CW20}`;

/** A host that answers CW20 smart queries for SHROOM_CW20 as mainnet does (2026-11-09),
 *  and refuses them for any other contract the way wasmd does. */
const cw20Host = (balance: string): Route => (p) => {
  const m = /\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/(.+)$/.exec(p);
  if (!m) return undefined;
  if (m[1] !== SHROOM_CW20) return { status: 500, body: { code: 2, message: "query wasm contract failed: Error parsing into type", details: [] } };
  const q = JSON.parse(atob(decodeURIComponent(m[2]!))) as Record<string, unknown>;
  if ("token_info" in q) return { status: 200, body: { data: { name: "shroomin", symbol: "SHROOM", decimals: 18, total_supply: "1000000000000000000000000000" } } };
  if ("balance" in q) return { status: 200, body: { data: { balance } } };
  return { status: 500, body: { code: 2, message: "unknown variant" } };
};

test("CW20 tokens: balances and token_info by smart query; other contracts are not tokens", async () => {
  const { fetch, calls } = fake({ "a.example": cw20Host("42") });
  const c = lcd(fetch);
  assert.equal(await c.cw20Balance(SHROOM_CW20, ADDR), 42n);
  assert.deepEqual(await c.cw20Info(SHROOM_CW20), { symbol: "SHROOM", name: "shroomin", decimals: 18 });
  assert.equal(await c.cw20Balance("inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk", ADDR), null);
  assert.equal(await c.cw20Info("inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk"), null);
  // A refusal is the contract's answer, not the node's trouble: no other endpoint is asked.
  assert.ok(calls.every((x) => x.includes("a.example")));
  const odd = lcd(fake({ "a.example": cw20Host("1e9") }).fetch);
  assert.equal(await odd.cw20Balance(SHROOM_CW20, ADDR), null);

  // The CW20 and its bank form are described by the contract (the bank form has no metadata).
  const t = await describeToken(c, "mainnet", cw20Denom(SHROOM_CW20));
  assert.deepEqual(t, { denom: `cw20:${SHROOM_CW20}`, symbol: "SHROOM", name: "shroomin", decimals: 18, known: false });
  const b = await describeToken(c, "mainnet", SHROOM_BANK);
  assert.deepEqual(b, { denom: SHROOM_BANK, symbol: "SHROOM", name: "shroomin", decimals: 18, known: false });
  // The token factory's empty metadata (as testnet's adapter denoms have it) defers to the CW20.
  const empty = { base: SHROOM_BANK, display: "", name: "", symbol: "", decimals: 0, denom_units: [{ denom: SHROOM_BANK, exponent: 0, aliases: [] }] };
  const withEmpty = lcd(fake({ "a.example": (p) => (p.includes("denoms_metadata") ? { status: 200, body: { metadata: empty } } : cw20Host("42")(p)) }).fetch);
  assert.deepEqual(await describeToken(withEmpty, "mainnet", SHROOM_BANK), { denom: SHROOM_BANK, symbol: "SHROOM", name: "shroomin", decimals: 18, known: false });
  // A node that can't be reached is an error, not a description made without asking.
  await assert.rejects(describeToken(lcd(fake({ "a.example": () => "network-error", "b.example": () => "network-error" }).fetch), "mainnet", cw20Denom(SHROOM_CW20)), Unreachable);
});

test("CW20 keys and forms: cw20: keys, the adapter's bank denom, and back", () => {
  assert.equal(cw20Denom(SHROOM_CW20), `cw20:${SHROOM_CW20}`);
  assert.equal(cw20Address(`cw20:${SHROOM_CW20}`), SHROOM_CW20);
  assert.equal(cw20Address(SHROOM_CW20), null);
  assert.equal(cw20Address("cw20:inj1short"), null);
  assert.throws(() => cw20Denom("0x9858EfFD232B4033E47d90003D41EC34EcaEda94"), RangeError);
  assert.equal(adapterDenom("mainnet", SHROOM_CW20), SHROOM_BANK);
  assert.equal(adapterCw20("mainnet", SHROOM_BANK), SHROOM_CW20);
  // Another network's adapter, or another creator's factory denom, is not the adapter's.
  assert.equal(adapterCw20("testnet", SHROOM_BANK), null);
  assert.equal(adapterCw20("mainnet", `factory/inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v/${SHROOM_CW20}`), null);
  assert.equal(otherForm("mainnet", `cw20:${SHROOM_CW20}`), SHROOM_BANK);
  assert.equal(otherForm("mainnet", SHROOM_BANK), `cw20:${SHROOM_CW20}`);
  assert.equal(otherForm("mainnet", "inj"), null);
  assert.equal(shortDenom(`cw20:${SHROOM_CW20}`), "inj1300x…7xm8");
});

test("endpoints must be https (or local http)", () => {
  assert.throws(() => new Lcd(NETWORKS.mainnet, ["http://evil.example"], fake({}).fetch), /https/);
  assert.throws(() => new Lcd(NETWORKS.mainnet, [], fake({}).fetch), /no endpoints/);
  new Lcd(NETWORKS.mainnet, ["http://127.0.0.1:8080/"], fake({}).fetch);
});

// -- EVM transactions in the index (see ../src/evmtx.ts) --

const EVM_HASH = `0x${"ab".repeat(32)}`;
const ME_EVM = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
const THEM_EVM = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const LUMA = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
const evmResponse = (o: { code?: number; hash?: string; raw_log?: string; data?: string }) => ({
  txhash: "cd".repeat(32),
  height: "147664258",
  timestamp: "2026-11-09T08:00:00Z",
  code: o.code ?? 0,
  raw_log: o.raw_log ?? "",
  data: o.data ?? resultData(o.hash ?? EVM_HASH, [transferLog(LUMA, ME_EVM, THEM_EVM, 5n)]),
  tx: { body: { messages: [ethMessage(ME_EVM, rawTx({ to: LUMA, input: transferCall(THEM_EVM, 5n) }))] }, auth_info: { fee: { amount: [{ denom: "inj", amount: "1" }] } } },
  events: o.code ? [] : [{ type: "ethereum_tx", attributes: [{ key: "ethereumTxHash", value: o.hash ?? EVM_HASH }] }],
});

test("EVM transactions: the hash and logs from the result; a reverted one's hash from its log", async () => {
  const reverted = `failed to execute message; message index: 0: {"tx_hash":"0x${"ef".repeat(32)}","gas_used":974469,"reason":"","vm_error":"execution reverted"}`;
  const { fetch, calls } = fake({
    "a.example": (path) => {
      const q = new URLSearchParams(path.split("?")[1]).get("query") ?? "";
      if (q === `ethereum_tx.ethereumTxHash='${EVM_HASH}'`) return { status: 200, body: { tx_responses: [evmResponse({})], total: "1" } };
      if (q.startsWith("ethereum_tx.")) return { status: 200, body: { tx_responses: [evmResponse({ hash: `0x${"00".repeat(32)}` })], total: "1" } };
      return { status: 200, body: { tx_responses: [evmResponse({}), evmResponse({ code: 3, raw_log: reverted, data: "" })], total: "2" } };
    },
  });
  const c = lcd(fetch, ["a.example"]);
  const [ran, failed] = (await c.searchTxs("x='y'", 1, 50)).txs;
  assert.deepEqual(ran!.evm, { hash: EVM_HASH, logs: [transferLog(LUMA, ME_EVM, THEM_EVM, 5n)] });
  assert.deepEqual(failed!.evm, { hash: `0x${"ef".repeat(32)}`, logs: [] });
  // By EVM hash: the node's answer must be that transaction.
  assert.equal((await c.txByEvmHash(EVM_HASH.toUpperCase().replace("0X", "0x")))!.hash, "CD".repeat(32));
  assert.equal(await c.txByEvmHash(`0x${"12".repeat(32)}`), null);
  await assert.rejects(c.txByEvmHash("0x12"), RangeError);
  assert.ok(calls.every((x) => x.startsWith("GET a.example/cosmos/tx/v1beta1/txs")));
});
