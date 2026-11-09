// Balances and sends through the service worker's logic, against the real WASM vault and a
// fake LCD that answers like Injective mainnet (shapes recorded 2026-11-08).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { transferCall, transferLog } from "../../chain/test/evm-fixture";

import {
  ADAPTER,
  ADDED,
  CW,
  CW20,
  CW_ADDED,
  CW_BANK,
  CW_PAIR,
  ERC20,
  FEE_COLLECTOR,
  GAS_PRICE,
  INJ,
  LUMA,
  ME,
  ME_EVM,
  NOT_A_TOKEN,
  PASSWORD,
  PHRASE,
  RECEIVED,
  SCAM,
  SIGNED,
  THEM,
  THEM_EVM,
  THEM_KEY,
  USDT,
  USDT_ERC20,
  abiString,
  attrs,
  bech32Of,
  chain,
  code,
  evmHashAt,
  evmIndexed,
  indexed,
  memory,
  moved,
  ok,
  serviceOn,
  wallet,
  callVault,
  handle,
} from "./fake";

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
  // All of it: the risk rules point that out. It goes to this account, which they name.
  assert.deepEqual(review.risk.findings.map((f) => f.rule), ["most_of_balance", "address_book"]);
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

test("activity: EVM transactions, and ERC20s others sent, found through Blockscout and read from the LCD", async () => {
  const net = chain();
  const me = ME_EVM.toLowerCase();
  const them = THEM_EVM.toLowerCase();
  // ME sent 5 LUMA (no bank form) on the EVM side: in the signed list, its logs say what moved.
  net.state.signedEvm = [evmIndexed(110, { from: me, fromInj: ME, to: LUMA, input: transferCall(them, 5n * INJ), logs: [transferLog(LUMA, me, them, 5n * INJ)] })];
  // Others: 2 LUMA to ME (only Blockscout knows), a zero-value "transfer" from ME (address
  // poisoning), and one the LCD's index doesn't have.
  const got = evmIndexed(115, { from: them, fromInj: THEM, to: LUMA, logs: [transferLog(LUMA, them, me, 2n * INJ)] });
  const poison = evmIndexed(112, { from: them, fromInj: THEM, to: USDT_ERC20, logs: [transferLog(USDT_ERC20, me, them, 0n)] });
  net.state.byEvmHash = { [evmHashAt(115)]: got, [evmHashAt(112)]: poison };
  net.state.blockscout = [115, 112, 110, 105].map((h) => ({ hash: evmHashAt(h), blockNumber: h }));
  const { service } = await wallet(net);
  type Page = {
    items: { height: string; kind: string; counterparty?: string; signed: boolean; changes: { denom: string; amount: string }[]; evmHash?: string }[];
    tokens: Record<string, { symbol: string }>;
    cutoff: string | null;
    evmIndexDown?: boolean;
  };
  const page = ok<Page>(await service.handle({ type: "activity", page: 1 }));
  assert.deepEqual(
    page.items.map((a) => [a.height, a.kind, a.counterparty, a.signed]),
    [["120", "receive", THEM, false], ["115", "receive", them, false], ["110", "send", them, true], ["100", "send", THEM, true], ["90", "receive", THEM, false]],
  );
  assert.deepEqual(page.items[1]!.changes, [{ denom: `evm:${LUMA}`, amount: (2n * INJ).toString() }]);
  assert.deepEqual(page.items[2]!.changes, [{ denom: `evm:${LUMA}`, amount: (-5n * INJ).toString() }]);
  assert.equal(page.items[2]!.evmHash, evmHashAt(110));
  assert.equal(page.tokens[`evm:${LUMA}`]?.symbol, "LUMA");
  assert.equal(page.cutoff, "100");
  // Blockscout was asked for ME's 0x address; the LCD only for what the page didn't have.
  assert.deepEqual(net.state.blockscoutCalls, [`?module=account&action=tokentx&address=${ME_EVM}&page=1&offset=50&sort=desc`]);
  assert.deepEqual(net.state.evmLookups.sort(), [evmHashAt(115), evmHashAt(112), evmHashAt(105)].sort());

  // A full page of hashes Blockscout made up, at the newest height: nothing to show, and they
  // can't hold back the rows the LCD confirmed (only confirmed heights count to the cutoff).
  net.state.blockscout = Array.from({ length: 50 }, (_, i) => ({ hash: evmHashAt(5000 + i), blockNumber: 999_999 }));
  const made = ok<Page>(await service.handle({ type: "activity", page: 1 }));
  assert.deepEqual([made.items.map((a) => a.height), made.cutoff], [["120", "110", "100", "90"], "100"]);

  // Blockscout down: the rest of the page stands, and says so.
  net.state.blockscout = "down";
  const down = ok<Page>(await service.handle({ type: "activity", page: 1 }));
  assert.equal(down.evmIndexDown, true);
  assert.deepEqual(down.items.map((a) => a.height), ["120", "110", "100", "90"]);

  // Turned off: an empty list. Blockscout isn't asked; the defaults bring it back.
  const off = ok<{ evmIndex: Record<string, string[]> }>(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, evmIndex: [] }));
  assert.deepEqual(off.evmIndex.mainnet, []);
  const asked = net.state.blockscoutCalls.length;
  const quiet = ok<Page>(await service.handle({ type: "activity", page: 1 }));
  assert.equal(net.state.blockscoutCalls.length, asked);
  assert.equal(quiet.evmIndexDown, undefined);
  const back = ok<{ evmIndex: Record<string, string[]> }>(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, evmIndex: null }));
  assert.deepEqual(back.evmIndex.mainnet, ["https://blockscout.injective.network"]);
  assert.equal(code(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, evmIndex: ["http://scout.example"] })), "invalid_endpoint");
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
