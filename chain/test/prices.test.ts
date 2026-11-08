import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchPrices, priceAddress, usdValue } from "../src/prices.ts";

test("prices: parsed by lowercase address, junk dropped, our client named", async () => {
  let sent: Headers | undefined;
  const fetch = async (_url: string, init?: RequestInit) => {
    sent = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        observedAt: "2026-11-08T11:30:00.000Z",
        prices: [
          { address: "0x0000000000000000000000000000000000000000", symbol: "INJ", priceUsd: "8.17964427" },
          { address: "0x88F7F2B685F9692CAF8C478F5BADF09EE9B1CC13", symbol: "USDT", priceUsd: "0.99864219" },
          { address: "0x1111111111111111111111111111111111111111", symbol: "BAD", priceUsd: "-1" },
          { address: "0x2222222222222222222222222222222222222222", symbol: "NUL", priceUsd: null },
        ],
      }),
    );
  };
  const list = await fetchPrices(fetch);
  assert.equal(sent?.get("x-client"), "choice-wallet/0.1.0");
  assert.deepEqual([...list.prices], [
    ["0x0000000000000000000000000000000000000000", "8.17964427"],
    ["0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13", "0.99864219"],
  ]);
  await assert.rejects(fetchPrices(async () => new Response("down", { status: 503 })), /HTTP 503/);
});

test("denoms map to the address Choice prices them under", () => {
  const pairs = new Map([["peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13"]]);
  assert.equal(priceAddress("inj", pairs), "0x0000000000000000000000000000000000000000");
  assert.equal(priceAddress("erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", pairs), "0xa00c59ff5a080d2b954d0c75e46e22a0c371235a");
  assert.equal(priceAddress("peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", pairs), "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13");
  assert.equal(priceAddress("factory/inj1x/abc", pairs), undefined);
  // A CW20 is priced as its adapter bank form.
  const cw20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
  const bank = `factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/${cw20}`;
  const withBank = new Map([[bank, "0x2222222222222222222222222222222222222222"]]);
  assert.equal(priceAddress(`cw20:${cw20}`, withBank, (d) => (d === `cw20:${cw20}` ? bank : null)), "0x2222222222222222222222222222222222222222");
  assert.equal(priceAddress(`cw20:${cw20}`, withBank), undefined);
  assert.equal(usdValue("2500000", 6, "2"), 5);
});
