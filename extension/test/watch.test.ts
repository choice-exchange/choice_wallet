// The background watcher (notifications), the disk caches and the saved snapshots, on the
// fake mainnet.

import assert from "node:assert/strict";
import { test } from "node:test";

import { transferLog } from "../../chain/test/evm-fixture";
import { createSnapshots } from "../src/host/snapshots";
import { attrs, chain, CW, evmHashAt, evmIndexed, INJ, indexed, LUMA, ME, ME_EVM, memory, PASSWORD, SCAM, sentTx, serviceOn, THEM, THEM_EVM, USDT, wallet } from "./fake";

type R<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
function ok<T>(r: unknown): T {
  const x = r as R<T>;
  assert.ok(x.ok, JSON.stringify(x));
  return x.result;
}

/** An indexed transaction from now (the watcher looks at what came after its last check). */
const now = <T extends object>(tx: T): T => ({ ...tx, timestamp: new Date().toISOString() });

test("tokens coming in: one notification each, from the index, after a first quiet check", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  assert.equal(ui.notices, undefined, "the first check only keeps what's there");

  net.state.balances[USDT] = 2_500_000n;
  net.state.receivedTxs.unshift(now(indexed(130, THEM, ME, `2500000${USDT}`)));
  await service.watch();
  assert.deepEqual(
    ui.notices?.map((n) => [n.title, n.message]),
    [["Received 2.5 USDT", "Account 1 · from inj1nk9x…l55v"]],
  );
  assert.equal(ui.badge, "1");
  assert.ok((ui.refreshed ?? 0) > 0, "open pages are told to refresh");

  // Nothing new: nothing shown, and the same transaction is never shown twice.
  await service.watch();
  assert.equal(ui.notices?.length, 1);

  // The wallet opened: the count goes.
  ok(await service.handle({ type: "seen" }));
  assert.equal(ui.badge, "");
});

test("what happened before watching began isn't news", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  // A receive a moment before the first check, then a change that has nothing to do with it.
  net.state.receivedTxs.unshift({ ...indexed(129, THEM, ME, `2500000${USDT}`), timestamp: new Date(Date.now() - 30_000).toISOString() });
  await service.watch();
  net.state.balances["inj"] = 6n * INJ;
  await service.watch();
  await service.watch();
  assert.deepEqual(ui.notices?.map((n) => n.title), ["Balance changed"]);
});

test("CW20s and EVM-only tokens: read like the list reads them, explained by their own events", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  // The popup has read prices once: SHROOM (a CW20 with a priced bank form) and LUMA (an
  // EVM-only token) are tokens the list shows.
  ok(await service.handle({ type: "balances" }));
  const prices = net.state.priceCalls;
  await service.watch();

  // 3 SHROOM in, in the CW20's own contract: no coin event names the account.
  net.state.cw20[CW] = 3n * INJ;
  net.state.cw20In.unshift(
    now({
      ...indexed(140, THEM, THEM, "1inj"),
      events: [{ type: "wasm", attributes: attrs({ _contract_address: CW, action: "transfer", from: THEM, to: ME, amount: (3n * INJ).toString() }) }],
    }),
  );
  // 2 LUMA in: only its log names the account; Blockscout finds it, the LCD has it.
  net.state.evm[LUMA] = 2n * INJ;
  net.state.blockscout = [{ hash: evmHashAt(141), blockNumber: 141 }];
  net.state.byEvmHash[evmHashAt(141)] = now(evmIndexed(141, { from: THEM_EVM, fromInj: THEM, to: LUMA, logs: [transferLog(LUMA, THEM_EVM, ME_EVM, 2n * INJ)] }));
  await service.watch();
  assert.deepEqual(ui.notices?.map((n) => n.title).sort(), ["Received 2 LUMA", "Received 3 SHROOM"]);
  assert.deepEqual(ui.notices?.find((n) => n.title === "Received 3 SHROOM")?.message, "Account 1 · from inj1nk9x…l55v");
  // In the background, Choice is never asked.
  assert.equal(net.state.priceCalls, prices);

  // No EVM endpoint answering: LUMA isn't taken for gone.
  net.state.evmDown = true;
  await service.watch();
  await service.watch();
  assert.equal(ui.notices?.length, 2);
});

test("junk stays quiet: a token the filter hides, sent by someone else", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  net.state.balances[SCAM] = 7_000_000n;
  net.state.receivedTxs.unshift(now(indexed(131, THEM, ME, `7000000${SCAM}`)));
  await service.watch();
  await service.watch(); // explained by a transaction: not shown later as a bare change either
  assert.equal(ui.notices, undefined);
});

test("a change no transaction explains is asked about once more, then shown as it is", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  // Unstaked INJ coming back: no transaction does that.
  net.state.balances["inj"] = 7n * INJ;
  await service.watch();
  assert.equal(ui.notices, undefined);
  await service.watch();
  assert.deepEqual(
    ui.notices?.map((n) => [n.title, n.message]),
    [["Balance changed", "Account 1 · +2 INJ"]],
  );
});

test("the wallet's own send: confirmed once, and its balance change isn't shown again", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  const sent = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  // The send lands; the chain shows the balance down and the spend in the index.
  net.state.balances["inj"] = 4n * INJ - 16_000_000_000_000n;
  net.state.spentTxs.unshift(sentTx(190861703, sent.hash));
  await service.watch();
  await service.settled();
  assert.deepEqual(
    ui.notices?.map((n) => [n.title, n.message]),
    [["Sent 1 INJ", "Account 1 · to inj1nk9x…l55v · confirmed"]],
  );
  assert.equal(ui.notices?.[0]?.id, `mainnet|${sent.hash}|${ME}`);
  await service.watch();
  assert.equal(ui.notices?.length, 1);
});

// F18: a failed transaction's log is the chain's text, which a site that broadcasts chooses.
// It never goes in a notification.
test("a failed transaction's notice carries none of the chain's failure text", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  net.state.txFail = { code: 5, raw_log: "spendable balance 0URGENT.wallet-drained.restore.at.example is smaller than 1" };
  ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  await service.watch();
  await service.settled();
  assert.ok(ui.notices?.length, "a notice");
  for (const n of ui.notices ?? []) assert.doesNotMatch(`${n.title} ${n.message}`, /URGENT|wallet-drained|spendable/, JSON.stringify(n));
});

test("between two watched accounts: sent on one, received on the other", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  const s = ok<{ accounts: { addresses: Record<string, string> }[] }>(await service.handle({ type: "add_account" }));
  const second = s.accounts[1]!.addresses["cosmos:injective-1"]!;
  ok(await service.handle({ type: "switch_account", index: 0 }));
  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, notify: "all" }));
  net.state.funded.add(second);
  await service.watch();
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  const sent = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  // The fake sends to THEM; the second account's own index shows the same transaction coming in.
  net.state.balances["inj"] = 4n * INJ - 16_000_000_000_000n;
  net.state.spentTxs.unshift(sentTx(190861703, sent.hash));
  net.state.otherReceived[second] = [now(indexed(190861703, ME, second, `${INJ}inj`))].map((t) => ({ ...t, txhash: sent.hash }));
  net.state.funded.delete(second);
  net.state.otherBalances[second] = [{ denom: "inj", amount: (6n * INJ).toString() }];
  await service.watch();
  await service.settled();
  assert.deepEqual(
    ui.notices?.map((n) => n.title).sort(),
    ["Received 1 INJ", "Sent 1 INJ"],
  );
  assert.equal(new Set(ui.notices?.map((n) => n.id)).size, 2);
});

test("while the popup is open nothing pops up, and the count stays", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  await service.watch();
  ui.popupOpen = true;
  net.state.balances[USDT] = 2_500_000n;
  net.state.receivedTxs.unshift(now(indexed(132, THEM, ME, `2500000${USDT}`)));
  await service.watch();
  assert.equal(ui.notices, undefined);
  assert.equal(ui.badge, undefined);
  assert.ok((ui.refreshed ?? 0) > 0);
});

test("who is watched: the account in use, every account, or nobody", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, ui } = await wallet(net);
  const s = ok<{ accounts: { addresses: Record<string, string> }[] }>(await service.handle({ type: "add_account" }));
  const second = s.accounts[1]!.addresses["cosmos:injective-1"]!;
  ok(await service.handle({ type: "switch_account", index: 0 }));

  net.state.balanceAsked.length = 0;
  await service.watch();
  assert.deepEqual(net.state.balanceAsked, [ME]);

  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, notify: "all" }));
  assert.equal(ui.watching, true);
  assert.equal(ok<{ notify: string }>(await service.handle({ type: "settings" })).notify, "all");
  net.state.balanceAsked.length = 0;
  await service.watch();
  assert.deepEqual(net.state.balanceAsked, [ME, second]);

  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, notify: "off" }));
  assert.equal(ui.watching, false);
  net.state.balanceAsked.length = 0;
  await service.watch();
  assert.deepEqual(net.state.balanceAsked, []);
  assert.equal((await service.handle({ type: "save_settings", network: "mainnet", lcd: null, notify: "loud" })).ok, false);
});

test("a fresh service worker opens on what's on disk: token details, pairs, prices", async () => {
  const net = chain({ balances: { inj: 5n * INJ, [USDT]: 2_500_000n, [SCAM]: 7n } });
  const { service, local, session } = await wallet(net);
  ok(await service.handle({ type: "balances" }));
  await service.settled();
  const asked = { prices: net.state.priceCalls, pairs: net.state.pairCalls, metadata: net.state.metadataCalls };
  assert.ok(asked.metadata > 0 && asked.pairs > 0 && asked.prices > 0);

  // Chrome stopped the worker; the popup opens again a little later.
  const restarted = serviceOn(net, local, session);
  const b = ok<{ balances: { symbol: string; usd?: number }[] }>(await restarted.handle({ type: "balances" }));
  assert.deepEqual(b.balances.map((x) => [x.symbol, x.usd]), [["INJ", 40], ["USDT", 2.5], ["USDT", undefined]]);
  assert.deepEqual({ prices: net.state.priceCalls, pairs: net.state.pairCalls, metadata: net.state.metadataCalls }, asked);
});

test("what an account showed last is there at once, and goes with the wallet", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service, local, session } = await wallet(net);
  assert.equal(ok(await service.handle({ type: "snapshot" })), null);
  ok(await service.handle({ type: "balances" }));
  ok(await service.handle({ type: "staking" }));
  ok(await service.handle({ type: "activity", page: 1 }));
  await new Promise((r) => setTimeout(r, 20));

  type Snap = { balances?: { at: number; value: { balances: { symbol: string }[]; filter: unknown } }; staking?: unknown; activity?: { value: { items: unknown[] } } };
  const snap = ok<Snap>(await serviceOn(net, local, session).handle({ type: "snapshot" }));
  assert.deepEqual(snap.balances?.value.balances.map((b) => b.symbol), ["INJ"]);
  assert.ok(snap.balances!.at <= Date.now());
  assert.deepEqual(snap.balances?.value.filter, { all: false, hideSmall: false, shown: [], hidden: [] });
  assert.ok(snap.staking);
  assert.ok((snap.activity?.value.items.length ?? 0) > 0);
  assert.ok([...local.data.keys()].some((k) => k.startsWith("snap ")));

  // Locked: nothing.
  ok(await service.handle({ type: "lock" }));
  assert.equal((await service.handle({ type: "snapshot" })).ok, false);

  // Removing the wallet removes them, and what the watcher kept.
  ok(await service.handle({ type: "unlock", password: PASSWORD }));
  await service.watch();
  assert.ok(local.data.has("watch"));
  ok(await service.handle({ type: "reset", password: PASSWORD }));
  assert.deepEqual([...local.data.keys()].filter((k) => k.startsWith("snap") || k.startsWith("watch")), []);
});

test("saved parts that arrive together are both kept", async () => {
  // A slow store, so the two writes overlap as balances and staking do in the browser.
  const local = memory();
  const slow = { ...local, get: async (k: string[]) => (await new Promise((r) => setTimeout(r, 5)), local.get(k)) };
  const snaps = createSnapshots(slow);
  await Promise.all([snaps.save("mainnet", ME, "balances", { a: 1 }), snaps.save("mainnet", ME, "staking", { b: 2 }), snaps.save("mainnet", ME, "activity", { items: [] })]);
  const s = await snaps.get("mainnet", ME);
  assert.deepEqual([s?.balances?.value, s?.staking?.value, s?.activity?.value], [{ a: 1 }, { b: 2 }, { items: [] }]);
});
