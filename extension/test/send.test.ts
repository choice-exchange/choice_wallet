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

/** A fake mainnet LCD. `balances` and `account` can be changed per test. */
function chain(opts: { balances?: Record<string, bigint>; account?: boolean; gasUsed?: string } = {}) {
  const state = {
    balances: opts.balances ?? { inj: 5n * INJ },
    account: opts.account ?? true,
    broadcasts: [] as string[],
    simulations: 0,
    hosts: new Set<string>(),
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    state.hosts.add(url.host);
    const p = url.pathname;
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

async function wallet(net = chain()) {
  const local = memory();
  const session = memory();
  const service = createService({
    vault: async (method, params) => callVault(handle, method, params),
    local,
    session,
    fetch: net.fetch,
    scheduleLock: () => {},
    cancelLock: () => {},
  });
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
  const saved = ok<{ lcd: Record<string, string[]> }>(await service.handle({ type: "save_settings", network: "mainnet", lcd: ["https://my-node.example/ "] }));
  assert.deepEqual(saved.lcd["mainnet"], ["https://my-node.example"]);
  net.state.hosts.clear();
  ok(await service.handle({ type: "balances" }));
  assert.deepEqual([...net.state.hosts], ["my-node.example"]);
  // Testnet: the status says so, and a mainnet node is refused (it serves injective-1).
  ok(await service.handle({ type: "save_settings", network: "testnet", lcd: null }));
  const st = ok<{ network: string }>(await service.handle({ type: "status" }));
  assert.equal(st.network, "testnet");
  assert.equal(code(await service.handle({ type: "balances" })), "unreachable");
});
