import assert from "node:assert/strict";
import { test } from "node:test";

import type { Balance } from "../src/protocol.ts";
import { applyFilter, DEFAULT_FILTER, flip, hiddenWhy } from "../src/tokenFilter.ts";

const bal = (denom: string, extra: Partial<Balance> = {}): Balance => ({
  denom,
  symbol: denom.slice(0, 4).toUpperCase(),
  name: "",
  decimals: 6,
  known: false,
  amount: "1000000",
  ...extra,
});

const INJ = bal("inj", { known: true, decimals: 18, usd: 8.1, priceUsd: "8.1", onChoice: true });
const USDC = bal("erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", { known: true, usd: 0.4, priceUsd: "1", onChoice: true });
const SHROOM = bal("factory/inj1shroom/shroom", { usd: 12, priceUsd: "0.0001", onChoice: true });
const DUST = bal("factory/inj1dust/dust", { usd: 0.02, priceUsd: "0.00000002", onChoice: true });
const JUNK = bal("factory/inj1junk/claim-at-example", {});
const STALE = bal("factory/inj1stale/stale", { onChoice: true }); // priced last week, not now

test("by default: the fee token, listed tokens and tokens Choice prices", () => {
  const s = applyFilter([INJ, USDC, SHROOM, DUST, JUNK, STALE], DEFAULT_FILTER, "inj");
  assert.deepEqual(s.shown.map((b) => b.denom), [INJ, USDC, SHROOM, DUST, STALE].map((b) => b.denom));
  assert.deepEqual(s.hidden.map((h) => [h.balance.denom, h.why]), [[JUNK.denom, "unlisted"]]);
  assert.equal(s.totalUsd, 8.1 + 0.4 + 12 + 0.02);
});

test("hide small: priced tokens under $1 go, the fee token stays, unpriced ones are left to the other rules", () => {
  const f = { ...DEFAULT_FILTER, hideSmall: true };
  const poor = { ...INJ, usd: 0.5 };
  assert.equal(hiddenWhy(poor, f, "inj"), null);
  assert.equal(hiddenWhy(USDC, f, "inj"), "small");
  assert.equal(hiddenWhy(DUST, f, "inj"), "small");
  assert.equal(hiddenWhy(SHROOM, f, "inj"), null);
  assert.equal(hiddenWhy(STALE, f, "inj"), null);
  assert.equal(hiddenWhy(JUNK, { ...f, all: true }, "inj"), null);
});

test("all tokens shows everything but what the user hid", () => {
  const f = { ...DEFAULT_FILTER, all: true, hidden: [SHROOM.denom] };
  const s = applyFilter([INJ, SHROOM, JUNK], f, "inj");
  assert.deepEqual(s.shown.map((b) => b.denom), [INJ.denom, JUNK.denom]);
  assert.deepEqual(s.hidden.map((h) => h.why), ["yours"]);
  assert.equal(s.totalUsd, 8.1);
});

test("no prices at all: no total", () => {
  assert.equal(applyFilter([bal("inj", { known: true })], DEFAULT_FILTER, "inj").totalUsd, undefined);
});

test("flip keeps a choice only where it differs from the rules", () => {
  // Showing junk is remembered; flipping it back forgets it.
  let f = flip(DEFAULT_FILTER, JUNK, "inj");
  assert.deepEqual(f.shown, [JUNK.denom]);
  assert.equal(hiddenWhy(JUNK, f, "inj"), null);
  f = flip(f, JUNK, "inj");
  assert.deepEqual(f, DEFAULT_FILTER);

  // Hiding a priced token is remembered, and wins over "all".
  f = flip(DEFAULT_FILTER, SHROOM, "inj");
  assert.deepEqual(f.hidden, [SHROOM.denom]);
  assert.equal(hiddenWhy(SHROOM, { ...f, all: true }, "inj"), "yours");

  // A small token the user wants to see stays when "hide small" is on.
  f = flip({ ...DEFAULT_FILTER, hideSmall: true }, DUST, "inj");
  assert.deepEqual(f.shown, [DUST.denom]);
  assert.equal(hiddenWhy(DUST, f, "inj"), null);

  // The fee token can't be hidden.
  assert.equal(flip(DEFAULT_FILTER, INJ, "inj"), DEFAULT_FILTER);
  assert.equal(hiddenWhy(INJ, { ...DEFAULT_FILTER, hidden: ["inj"] }, "inj"), null);
});
