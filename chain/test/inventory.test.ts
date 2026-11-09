// Inventory: chain decimals, a subaccount's ID, XYK shares valued from their pair (only when
// the pair names the share), and CLMM amounts from liquidity and price.

import assert from "node:assert/strict";
import { test } from "node:test";

import { clmmAmounts, decFloor, subaccountId, xykPositions } from "../src/inventory.ts";
import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import type { Fetch } from "../src/pool.ts";

test("chain decimals round down; subaccount IDs are address and nonce", () => {
  assert.equal(decFloor("20000000000000000.000000000000000000"), 20000000000000000n);
  assert.equal(decFloor("12.999999999999999999"), 12n);
  assert.equal(decFloor("7"), 7n);
  for (const bad of ["", "1e5", "1.0000000000000000001", "abc", 5]) assert.equal(decFloor(bad), null, String(bad));
  assert.equal(subaccountId("0x47A660f365f7439CD3c411B8A7Ee69CF8e219e15", 1), "0x47a660f365f7439cd3c411b8a7ee69cf8e219e15000000000000000000000001");
  assert.throws(() => subaccountId("0x47a6", 1));
});

test("CLMM amounts: below the range all token0, above all token1, inside both", () => {
  const q96 = (price: number) => BigInt(Math.round(Math.sqrt(price) * 2 ** 96));
  const L = 10n ** 18n;
  const below = clmmAmounts(L, 0, 6932, q96(0.5)); // ticks 0..6932 is price 1..2
  assert.equal(below.inRange, false);
  assert.equal(below.amount1, 0n);
  assert.ok(below.amount0 > 0n);
  const above = clmmAmounts(L, 0, 6932, q96(3));
  assert.deepEqual([above.inRange, above.amount0], [false, 0n]);
  // L × (√2 − 1) of token1.
  assert.ok(Math.abs(Number(above.amount1) / 1e18 - (Math.SQRT2 - 1)) < 1e-4, String(above.amount1));
  const inside = clmmAmounts(L, 0, 6932, q96(1.5));
  assert.ok(inside.inRange && inside.amount0 > 0n && inside.amount1 > 0n);
});

test("XYK: a held share is valued from its pair; a token that only looks like one isn't", async () => {
  const PAIR = "inj17lpu6atwwtdnn6t9fuedhstqkrzsqh42l2jz0w";
  const FAKE = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetch: Fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/node_info")) return json({ default_node_info: { network: "injective-1" } });
    const m = /\/contract\/([^/]+)\/smart\/(.+)$/.exec(url.pathname)!;
    const q = JSON.parse(atob(decodeURIComponent(m[2]!))) as Record<string, unknown>;
    if (q["pair"]) return json({ data: { liquidity_token: m[1] === PAIR ? `factory/${PAIR}/lp` : "factory/somewhere/else" } });
    return json({ data: { assets: [{ info: { native_token: { denom: "inj" } }, amount: "1000" }, { info: { token: { contract_addr: FAKE } }, amount: "500" }], total_share: "100" } });
  };
  const lcd = new Lcd(NETWORKS.mainnet, ["https://a.example"], fetch, 1000);
  const got = await xykPositions(lcd, [
    { denom: `factory/${PAIR}/lp`, amount: "10" },
    { denom: `factory/${FAKE}/lp`, amount: "10" },
    { denom: "inj", amount: "5" },
  ]);
  assert.deepEqual(got, [
    { pool: PAIR, share: `factory/${PAIR}/lp`, amount: 10n, totalShare: 100n, assets: [{ denom: "inj", amount: 100n }, { denom: `cw20:${FAKE}`, amount: 50n }] },
  ]);
});
