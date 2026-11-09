// Swaps through Choice, through the service: quotes from a fake /route serving Choice's
// real answers (2026-11-09), each step built and read by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ADDED, AGGREGATOR, chain, code, INJ, ME_EVM, ok, PERMIT2, USDT, USDT_ERC20, wallet } from "./fake";

type Quote = { id: string; amountIn: string; amountOut: string; minimumOut: string; steps: string[]; legs: { venue: string }[]; fee: unknown; executor: string; tokens: Record<string, { symbol: string }> };
type Review = {
  digest: string;
  display: { to: string; value: string; call: Record<string, unknown> };
  risk: { level: string; findings: { rule: string; message: string }[] };
  swap?: { step: string; left: number; from: string; to: string; expectedOut: string };
};

const rules = (r: Review) => r.risk.findings.map((f) => f.rule);

test("INJ in: one step, the swap, read by the vault and sent", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() }));
  assert.deepEqual(q.steps, ["swap"]);
  assert.equal(q.executor, "aggregator");
  assert.equal(q.minimumOut, "8145811");
  assert.equal(q.fee, null);
  assert.equal(q.tokens[USDT]?.symbol, "USDT");
  // EVM routes only, paying this account.
  const asked = net.state.routeAsks[0]!;
  assert.equal(asked.get("vms"), "evm");
  assert.equal(asked.get("recipient"), ME_EVM);
  assert.equal(asked.get("tokenIn"), "0x0000000000000000000000000000000000000000");
  assert.equal(asked.get("tokenOut")?.toLowerCase(), USDT_ERC20);

  const r = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.deepEqual(r.swap, { step: "swap", left: 0, from: "inj", to: USDT, expectedOut: q.amountOut });
  assert.equal(r.display.to, AGGREGATOR);
  assert.equal(r.display.value, INJ.toString());
  assert.equal(r.display.call["type"], "swap");
  assert.equal(r.display.call["minimum_out"], "8145811");
  assert.equal(r.risk.level, "info");
  assert.deepEqual(rules(r), ["swap"]);
  ok(await service.handle({ type: "confirm_send", digest: r.digest }));
  assert.equal(net.state.evmSent.length, 1);
});

test("USDT in: approve Permit2, then Permit2 for the aggregator, then the swap; each exact", async () => {
  const net = chain({ balances: { inj: 3n * INJ, [USDT]: 10_000_000n } });
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: USDT, to: "inj", amount: "5000000" }));
  assert.deepEqual(q.steps, ["approve", "permit2", "swap"]);

  const approve = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.equal(approve.swap?.step, "approve");
  assert.equal(approve.swap?.left, 2);
  assert.equal(approve.display.to.toLowerCase(), USDT_ERC20);
  assert.deepEqual(approve.display.call, { type: "approve", spender: PERMIT2, amount: "5000000" });
  assert.equal(approve.risk.findings[0]?.message, "Permit2 could spend this token up to the amount shown.");
  ok(await service.handle({ type: "confirm_send", digest: approve.digest }));
  net.state.erc20Allowance[`${USDT_ERC20} ${PERMIT2.toLowerCase()}`] = 5_000_000n;

  const permit = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.equal(permit.swap?.step, "permit2");
  assert.equal(permit.display.call["type"], "permit2_approve");
  assert.equal(permit.display.call["spender"], AGGREGATOR);
  assert.equal(permit.display.call["amount"], "5000000");
  // Thirty minutes from now.
  const exp = Number(permit.display.call["expiration"]);
  assert.ok(Math.abs(exp - (Date.now() / 1000 + 1800)) < 60, String(exp));
  assert.deepEqual(rules(permit), ["permit2_limited"]);
  ok(await service.handle({ type: "confirm_send", digest: permit.digest }));
  net.state.permit2[`${USDT_ERC20} ${AGGREGATOR.toLowerCase()}`] = { amount: 5_000_000n, expiration: exp };

  const swap = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.deepEqual(swap.swap, { step: "swap", left: 0, from: USDT, to: "inj", expectedOut: q.amountOut });
  assert.equal(swap.display.value, "0");
  assert.equal(swap.display.call["token_out"], "0x0000000000000000000000000000000000000000");
  assert.deepEqual(rules(swap), ["swap"]);
  ok(await service.handle({ type: "confirm_send", digest: swap.digest }));
  assert.equal(net.state.evmSent.length, 3);

  // An allowance about to end is renewed rather than trusted.
  net.state.permit2[`${USDT_ERC20} ${AGGREGATOR.toLowerCase()}`] = { amount: 5_000_000n, expiration: Math.floor(Date.now() / 1000) + 60 };
  assert.deepEqual(ok<Quote>(await service.handle({ type: "swap_quote", from: USDT, to: "inj", amount: "5000000" })).steps, ["permit2", "swap"]);
});

test("refusals: no route, an answer for another pair, an old quote, more than held", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const { service, session } = await wallet(net);
  assert.equal(code(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: "7" })), "no_route");
  assert.equal(code(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: (5n * INJ).toString() })), "insufficient");
  assert.equal(code(await service.handle({ type: "swap_quote", from: "inj", to: "inj", amount: "1" })), "bad_request");
  assert.equal(code(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString(), slippageBps: 9000 })), "bad_request");
  // Choice answers with another output token than asked.
  const key = `0x0000000000000000000000000000000000000000 ${USDT_ERC20} ${INJ}`;
  const real = net.state.routes[key]!;
  net.state.routes[key] = { ...real, tokenOut: "0x5555555555555555555555555555555555555555" };
  assert.equal(code(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() })), "no_route");
  net.state.routes[key] = real;
  // A quote kept too long is asked for again (same pair, amount and slippage) before its
  // step is built; if Choice won't quote it now, it stops there.
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() }));
  const age = async () => {
    const { swap_quote } = await session.get(["swap_quote"]);
    await session.set({ swap_quote: { ...(swap_quote as object), at: Date.now() - 10 * 60_000 } });
  };
  await age();
  const asks = net.state.routeAsks.length;
  assert.equal(ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id })).swap?.step, "swap");
  assert.equal(net.state.routeAsks.length, asks + 1);
  assert.equal(net.state.routeAsks.at(-1)?.get("slippageBps"), "50");
  await age();
  delete net.state.routes[key];
  assert.equal(code(await service.handle({ type: "prepare_swap", quote: q.id })), "quote_expired");
  net.state.routes[key] = real;
  assert.equal(code(await service.handle({ type: "prepare_swap", quote: "0000000000000000" })), "not_found");
});

test("a quote is for the account that asked", async () => {
  // (The vault refuses calldata that pays anyone but the signer: crates/vault tests.)
  const net = chain({ balances: { inj: 3n * INJ } });
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() }));
  ok(await service.handle({ type: "add_account" }));
  assert.equal(code(await service.handle({ type: "prepare_swap", quote: q.id })), "not_found");
});

test("a watched account can quote but not swap", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const { service } = await wallet(net);
  ok(await service.handle({ type: "add_watch", address: "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v" }));
  assert.equal(code(await service.handle({ type: "prepare_swap", quote: "0000000000000000" })), "watch_only");
});

test("swap tokens: what's held that Choice can trade, then the wallet's list", async () => {
  const net = chain({ balances: { inj: 3n * INJ, [USDT]: 1n } });
  const { service } = await wallet(net);
  const list = ok<{ denom: string; amount?: string }[]>(await service.handle({ type: "swap_tokens" }));
  const denoms = list.map((t) => t.denom);
  assert.equal(denoms[0], "inj");
  assert.ok(denoms.includes(USDT));
  // Listed but not held: offered without an amount.
  const usdc = list.find((t) => t.denom === "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a");
  assert.ok(usdc && usdc.amount === undefined);
  // A token added by contract is offered too, held or not.
  ok(await service.handle({ type: "add_token", address: ADDED }));
  assert.ok(ok<{ denom: string }[]>(await service.handle({ type: "swap_tokens" })).some((t) => t.denom === `evm:${ADDED}`));
});
