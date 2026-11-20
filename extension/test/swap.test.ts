// Swaps through Choice, through the service: quotes from a fake /route serving Choice's
// real answers (2026-11-09), each step built and read by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shown } from "../../ui/src/review";
import { ADDED, AGGREGATOR, chain, code, CW_BANK, CW_PAIR, ERC20, INJ, ME_EVM, ok, PERMIT2, USDT, USDT_ERC20, wallet } from "./fake";

type Quote = { id: string; amountIn: string; amountOut: string; minimumOut: string; steps: string[]; legs: { venue: string }[]; fee: unknown; executor: string; tokens: Record<string, { symbol: string }>; valueLost: number | null };
type Review = {
  digest: string;
  display: { to: string; value: string; call: Record<string, unknown> };
  risk: { level: string; findings: { rule: string; message: string }[] };
  swap?: { step: string; left: number; from: string; to: string; expectedOut: string; valueLost?: number | null };
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

  // Weighed by the wallet's prices: a little more than it costs here.
  assert.ok(q.valueLost !== null && q.valueLost < 0, String(q.valueLost));

  const r = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.deepEqual(r.swap, { step: "swap", left: 0, from: "inj", to: USDT, expectedOut: q.amountOut, valueLost: q.valueLost });
  assert.equal(r.display.to, AGGREGATOR);
  assert.equal(r.display.value, INJ.toString());
  assert.equal(r.display.call["type"], "swap");
  assert.equal(r.display.call["minimum_out"], "8145811");
  assert.equal(r.risk.level, "info");
  assert.deepEqual(rules(r), ["swap"]);
  // USDT's pinned pair is shown as USDT, so it isn't described again as a contract.
  const described = Object.keys((r as Review & { tokens: Record<string, unknown> }).tokens);
  assert.ok(described.includes(USDT) && !described.some((k) => k.startsWith("evm:")), JSON.stringify(described));
  ok(await service.handle({ type: "confirm_send", digest: r.digest }));
  assert.equal(net.state.evmSent.length, 1);
});

// F9: a listed token's ERC20 is pinned, so an LCD that lies about its token pair can't
// change which token a swap buys.
test("a lying LCD token pair doesn't change a listed token's swap contract", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const honest = net.fetch;
  net.fetch = async (input: string, init?: RequestInit) => {
    if (String(input).includes("/injective/erc20/v1beta1/all_token_pairs")) {
      return new Response(JSON.stringify({ token_pairs: [{ bank_denom: USDT, erc20_address: "0x5555555555555555555555555555555555555555" }], pagination: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return honest(input, init);
  };
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() }));
  assert.equal(net.state.routeAsks.at(-1)!.get("tokenOut")?.toLowerCase(), USDT_ERC20);
  const r = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.equal(String(r.display.call["token_out"]).toLowerCase(), USDT_ERC20);
});

// Run-2 C4: an unlisted bank denom's ERC20 comes from the LCD, which may lie. The review
// describes the contract the swap actually buys and names it as itself, never as the denom
// the user picked, so an LCD's word never decides what the review says is bought.
test("a swap of an unlisted denom is reviewed as the contract it buys", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const usdt = USDT_ERC20.slice(2).toLowerCase();
  const real = net.state.routes[`0x0000000000000000000000000000000000000000 ${USDT_ERC20} ${INJ}`]!;
  // Choice's INJ to USDT answer, bought as CW_BANK's pair instead.
  const pair = CW_PAIR.slice(2).toLowerCase();
  net.state.routes[`0x0000000000000000000000000000000000000000 ${CW_PAIR.toLowerCase()} ${INJ}`] = JSON.parse(JSON.stringify(real).replace(new RegExp(usdt, "gi"), pair));
  // The pair is an ERC20 on the fake chain for this test (read from its contract).
  ERC20[CW_PAIR.toLowerCase()] = { symbol: "SHROOM", name: "Shroom", decimals: 18 };
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: CW_BANK, amount: INJ.toString() }));
  const r = ok<Review & { tokens: Record<string, { known: boolean }> }>(await service.handle({ type: "prepare_swap", quote: q.id }));
  delete ERC20[CW_PAIR.toLowerCase()];
  assert.equal(String(r.display.call["token_out"]).toLowerCase(), CW_PAIR.toLowerCase());
  // The contract traded is described, so the review can name it.
  assert.equal(r.tokens[`evm:${CW_PAIR.toLowerCase()}`]?.known, false, JSON.stringify(Object.keys(r.tokens)));
  const view = shown(r.display as unknown as Parameters<typeof shown>[0], "mainnet", r.swap as Parameters<typeof shown>[2]);
  assert.equal(view.swaps[0]!.minimum.denom, `evm:${CW_PAIR.toLowerCase()}`);
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
  assert.deepEqual({ ...swap.swap, valueLost: undefined }, { step: "swap", left: 0, from: USDT, to: "inj", expectedOut: q.amountOut, valueLost: undefined });
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

// Review of #9: every quote is weighed by the wallet's prices, with USD values off too, and
// so is the one asked for again at the swap step. A rate far below the market's is said.
test("a quote that pays much less than the wallet's prices say is weighed, USD values on or off", async () => {
  const net = chain({ balances: { inj: 3n * INJ } });
  const honest = net.fetch;
  // The price index says INJ is worth twice what the quote pays for it.
  net.fetch = async (input: string, init?: RequestInit) => {
    if (String(input).includes("evm-api.choice.exchange/prices")) {
      const r = await honest(input, init);
      const body = (await r.json()) as { prices: { address: string; priceUsd: string }[] };
      for (const p of body.prices) if (p.address === "0x0000000000000000000000000000000000000000") p.priceUsd = "16";
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return honest(input, init);
  };
  const { service } = await wallet(net);
  ok(await service.handle({ type: "save_settings", network: "mainnet", prices: false }));
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: "inj", to: USDT, amount: INJ.toString() }));
  assert.ok(q.valueLost !== null && q.valueLost > 0.4, String(q.valueLost));
  const r = ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id }));
  assert.equal(r.swap?.valueLost, q.valueLost);
});
