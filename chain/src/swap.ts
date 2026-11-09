// Quotes from Choice's routing API (`GET /route`), for the wallet's own swaps.
//
// The API builds the transaction (calldata for Choice's aggregator or router). Everything
// else in its answer is a description: the vault reads the calldata itself before anything
// is signed, and the review shows the vault's reading. This client only turns away an
// answer that doesn't match the question: another pair or amount, another contract, a
// minimum below the user's slippage. Only EVM routes are asked for (`vms=evm`): Choice's
// CosmWasm aggregator keeps part of some orderbook fills without showing it in the quote.

import { CLIENT } from "./prices.ts";
import { isObject, type Fetch } from "./pool.ts";
import type { Network } from "./networks.ts";

/** Native INJ, as the API and the aggregator name it. */
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const DEFAULT_SLIPPAGE_BPS = 50;
/** The API's own ceiling. */
export const MAX_SLIPPAGE_BPS = 5000;

export interface RouteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
  recipient: string;
}

export interface RouteLeg {
  venue: string;
  portionBps: number;
}

export interface Route {
  executor: "aggregator" | "router";
  /** The contract the transaction calls, and what it pulls ERC20 input through Permit2 for. */
  to: string;
  data: string;
  /** INJ sent with it, in wei. */
  value: bigint;
  amountIn: bigint;
  /** What the route is expected to return, and the least it may (after slippage and fee). */
  amountOut: bigint;
  minimumOut: bigint;
  /** The route's fee, if Choice charges one. It is in the calldata; the vault shows it. */
  fee: { bps: number; recipient: string } | null;
  gasEstimate: bigint | null;
  legs: RouteLeg[];
}

export class RouteError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !UINT.test(v)) throw new RouteError(`Choice's answer has no ${what}.`);
  return BigInt(v);
};

/** Ask Choice for a route, and hold its answer to the question. */
export async function fetchRoute(fetch: Fetch, net: Network, req: RouteRequest): Promise<Route> {
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 1 || req.slippageBps > MAX_SLIPPAGE_BPS) throw new RangeError("slippage out of range");
  const q = new URLSearchParams({
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amountIn: req.amountIn.toString(),
    slippageBps: String(req.slippageBps),
    recipient: req.recipient,
    vms: "evm",
  });
  const r = await fetch(`${net.choice.api}/route?${q}`, { headers: { "x-client": CLIENT, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    // Read below as no route.
  }
  if (!r.ok || !isObject(body)) {
    const msg = isObject(body) && typeof body["error"] === "string" ? body["error"] : isObject(body) && typeof body["message"] === "string" ? body["message"] : "";
    throw new RouteError(r.status === 404 || r.status === 422 ? "Choice has no route for this pair." : `Choice didn't quote this (${r.status}${msg ? `: ${msg.slice(0, 80)}` : ""}).`);
  }
  return checkRoute(net, req, body);
}

/** An answer from `/route`, checked against the request. */
export function checkRoute(net: Network, req: RouteRequest, body: Record<string, unknown>): Route {
  const tx = body["tx"];
  if (!isObject(tx) || typeof tx["to"] !== "string" || typeof tx["data"] !== "string" || !/^0x([0-9a-fA-F]{2}){4,}$/.test(tx["data"])) {
    throw new RouteError("Choice's answer has no transaction.");
  }
  const executor = body["executor"] === "aggregator" ? "aggregator" : body["executor"] === "universalRouter" ? "router" : null;
  const pinned = executor === "aggregator" ? net.choice.aggregator : executor === "router" ? net.choice.universalRouter : null;
  if (!executor || !pinned || !ADDRESS.test(tx["to"]) || !same(tx["to"], pinned)) throw new RouteError("Choice's answer calls a contract the wallet doesn't know.");
  if (body["vm"] !== undefined && body["vm"] !== "evm") throw new RouteError("Choice answered with a route the wallet doesn't use.");
  if (typeof body["tokenIn"] !== "string" || typeof body["tokenOut"] !== "string" || !same(body["tokenIn"], req.tokenIn) || !same(body["tokenOut"], req.tokenOut)) {
    throw new RouteError("Choice quoted another pair.");
  }
  const amountIn = uint(body["amountIn"], "input");
  if (amountIn !== req.amountIn) throw new RouteError("Choice quoted another amount.");
  const amountOut = uint(body["amountOut"], "output");
  const minimumOut = uint(body["amountOutMinimum"], "minimum");
  // The minimum may be no lower than the user's slippage allows.
  if (minimumOut === 0n || minimumOut > amountOut || minimumOut < (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n) {
    throw new RouteError("Choice's minimum doesn't match your slippage.");
  }
  const value = uint(tx["value"] ?? "0", "value");
  if (value !== 0n && !(same(req.tokenIn, NATIVE) && value === amountIn)) throw new RouteError("Choice's answer sends INJ the swap doesn't take.");
  const f = body["fee"];
  let fee: Route["fee"] = null;
  if (isObject(f)) {
    const bps = f["bps"];
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 100 || typeof f["recipient"] !== "string" || !ADDRESS.test(f["recipient"])) {
      throw new RouteError("Choice's answer has a fee the wallet can't read.");
    }
    if (bps > 0) fee = { bps, recipient: f["recipient"] };
  } else if (f !== null && f !== undefined) {
    throw new RouteError("Choice's answer has a fee the wallet can't read.");
  }
  const legs: RouteLeg[] = Array.isArray(body["legs"])
    ? body["legs"].flatMap((l) =>
        isObject(l) && typeof l["venue"] === "string" && typeof l["portionBps"] === "number" ? [{ venue: l["venue"].replace(/[^a-z0-9-]/gi, "").slice(0, 24), portionBps: l["portionBps"] }] : [],
      )
    : [];
  const gas = body["gasEstimate"];
  return {
    executor,
    to: tx["to"],
    data: tx["data"],
    value,
    amountIn,
    amountOut,
    minimumOut,
    fee,
    gasEstimate: typeof gas === "string" && UINT.test(gas) ? BigInt(gas) : null,
    legs,
  };
}
