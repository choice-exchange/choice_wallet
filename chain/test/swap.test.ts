// Choice's /route answers, held to the question. The fixture is a real answer from
// evm-api.choice.exchange on 2026-11-09 (1 INJ to USDT, paying the BIP-39 test account).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NETWORKS } from "../src/networks.ts";
import { checkRoute, fetchRoute, NATIVE, RouteError, type RouteRequest } from "../src/swap.ts";

const answer = JSON.parse(readFileSync(new URL("./choice-route.json", import.meta.url), "utf8")) as Record<string, unknown>;
const USDT = "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13";
const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const req: RouteRequest = { tokenIn: NATIVE, tokenOut: USDT, amountIn: 10n ** 18n, slippageBps: 50, recipient: ME };

test("a real answer reads as the route it is", () => {
  const r = checkRoute(NETWORKS.mainnet, req, answer);
  assert.equal(r.executor, "aggregator");
  assert.equal(r.to, NETWORKS.mainnet.choice.aggregator);
  assert.equal(r.value, 10n ** 18n);
  assert.equal(r.amountOut, 8186745n);
  assert.equal(r.minimumOut, 8145811n);
  assert.equal(r.fee, null);
  assert.equal(r.gasEstimate, 245000n);
  assert.deepEqual(r.legs, [{ venue: "pumex-v2", portionBps: 10000 }]);
});

test("an answer that doesn't match the question is turned away", () => {
  const bad = (change: Record<string, unknown>, r: RouteRequest = req) => assert.throws(() => checkRoute(NETWORKS.mainnet, r, { ...answer, ...change }), RouteError, JSON.stringify(change));
  bad({ tokenOut: "0x5555555555555555555555555555555555555555" });
  bad({ amountIn: "2" });
  bad({ tx: { ...(answer["tx"] as object), to: "0x4444444444444444444444444444444444444444" } });
  bad({ executor: "wasmAggregator" });
  bad({ vm: "wasm" });
  // A minimum below what 0.5% slippage allows, or none.
  bad({ amountOutMinimum: "8000000" });
  bad({ amountOutMinimum: "0" });
  bad({ fee: { bps: 500, amount: "1", recipient: ME } });
  // INJ sent with an ERC20 swap.
  bad({ tokenIn: USDT }, { ...req, tokenIn: USDT });
  // Testnet has no aggregator: the same answer there names a contract it doesn't know.
  assert.throws(() => checkRoute(NETWORKS.testnet, req, answer), RouteError);
});

test("the request: EVM routes only, with the wallet's client name", async () => {
  let asked: URL | null = null;
  let headers: Headers | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    asked = new URL(String(input));
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  await fetchRoute(fetch, NETWORKS.mainnet, req);
  const q = (asked as unknown as URL).searchParams;
  assert.equal((asked as unknown as URL).origin + (asked as unknown as URL).pathname, "https://evm-api.choice.exchange/route");
  assert.equal(q.get("vms"), "evm");
  assert.equal(q.get("amountIn"), "1000000000000000000");
  assert.equal(q.get("recipient"), ME);
  assert.match((headers as unknown as Headers).get("x-client") ?? "", /^choice-wallet\//);
  const none = async () => new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  await assert.rejects(fetchRoute(none, NETWORKS.mainnet, req), /no route for this pair/);
  await assert.rejects(fetchRoute(fetch, NETWORKS.mainnet, { ...req, slippageBps: 0 }), RangeError);
});
