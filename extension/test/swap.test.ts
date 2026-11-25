// Swaps through Choice, through the service: quotes from a fake /route serving Choice's
// real answers (2026-11-09), each step built and read by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shown } from "../../ui/src/review";
import { createPermit2, permitsOf } from "../src/host/permit2";
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

// Run-4: the approve step gives Permit2 the swap's amount, and any spender Permit2 already
// lets spend that token could take it before the swap does. Such a spender is revoked first.
test("the approve step waits while Permit2 lets another spender spend the token", async () => {
  const net = chain({ balances: { inj: 3n * INJ, [USDT]: 10_000_000n } });
  const { service } = await wallet(net);
  const OTHER = "0x5555555555555555555555555555555555555555";
  net.state.permit2Logs.push({ token: USDT_ERC20, spender: OTHER });
  net.state.permit2[`${USDT_ERC20} ${OTHER}`] = { amount: 10n ** 30n, expiration: Math.floor(Date.now() / 1000) + 86_400 };
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: USDT, to: "inj", amount: "5000000" }));
  const refused = await service.handle({ type: "prepare_swap", quote: q.id });
  assert.equal(code(refused), "permit2_spender", JSON.stringify(refused));
  assert.match(JSON.stringify(refused), /0x5555…5555/);
  // Revoked (or ended): the step goes ahead.
  net.state.permit2[`${USDT_ERC20} ${OTHER}`] = { amount: 0n, expiration: 0 };
  assert.equal(ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id })).swap?.step, "approve");
});

// Run-5: a Permit2 permit signed for a site and not used leaves no log, yet can take what the
// approve step gives Permit2. The wallet keeps each it signs: the step waits until it is used,
// cancelled or ended, and a site's own approve to Permit2 names who could take it.
test("a Permit2 permit signed here holds off the approve step, and a site's approve names it", async () => {
  const net = chain({ balances: { inj: 3n * INJ, [USDT]: 10_000_000n } });
  const { service, ui, local } = await wallet(net);
  const OTHER = "0x5555555555555555555555555555555555555555";
  const site = (method: string, params?: unknown) => service.dapp("https://app.example", { method, params });
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(ui.opened.length > seen, "no approval window opened");
    seen = ui.opened.length;
    return { id: ui.opened.at(-1)! };
  };
  const connecting = site("eth_requestAccounts");
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await connecting;
  const sign = async (typed: object) => {
    const asked = site("eth_signTypedData_v4", [ME_EVM, JSON.stringify(typed)]);
    const w = await window();
    const r = ok<{ digest: string; risk: { confirm?: string } }>(await service.handle({ type: "dapp_review", id: w.id }));
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: r.digest, ...(r.risk.confirm ? { confirm: r.risk.confirm } : {}) }));
    return asked;
  };
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = { name: "Permit2", chainId: 1776, verifyingContract: PERMIT2 };
  const types = {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
    TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  };
  const signed = (await sign({ types, domain, primaryType: "PermitTransferFrom", message: { permitted: { token: USDT_ERC20, amount: "10000000" }, spender: OTHER, nonce: "258", deadline: String(deadline) } })) as { result?: unknown };
  assert.equal(typeof signed.result, "string", JSON.stringify(signed));
  assert.ok(JSON.stringify(await local.get(["permit2_signed"])).includes(OTHER), JSON.stringify(await local.get(["permit2_signed"])));
  // The swap's approve step waits for it.
  const q = ok<Quote>(await service.handle({ type: "swap_quote", from: USDT, to: "inj", amount: "5000000" }));
  const refused = await service.handle({ type: "prepare_swap", quote: q.id });
  assert.equal(code(refused), "permit2_spender", JSON.stringify(refused));
  // A site's approve(USDT, Permit2) names who could take it: red.
  const approve = `0x095ea7b3${PERMIT2.slice(2).toLowerCase().padStart(64, "0")}${(5_000_000n).toString(16).padStart(64, "0")}`;
  const asked = site("eth_sendTransaction", [{ from: ME_EVM, to: USDT_ERC20, data: approve }]);
  const w = await window();
  const r = ok<{ risk: { level: string; findings: { rule: string; message: string }[] } }>(await service.handle({ type: "dapp_review", id: w.id }));
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  await asked;
  assert.equal(r.risk.level, "red", JSON.stringify(r.risk));
  assert.ok(r.risk.findings.some((f) => f.rule === "permit2_rearms" && f.message.includes("0x5555…5555")), JSON.stringify(r.risk));
  // Approvals lists it, to cancel by its nonce's bit (word 1, bit 2).
  const s = ok<{ permit2Signed?: { spender: string; kind: string; nonce: string }[] }>(await service.handle({ type: "approvals" }));
  assert.deepEqual(s.permit2Signed?.map((p) => [p.spender, p.kind, p.nonce]), [[OTHER, "transfer", "258"]]);
  const cancel = ok<{ risk: { level: string; findings: { rule: string }[] }; display: { call: Record<string, unknown> } }>(
    await service.handle({ type: "prepare_revoke_evm", kind: "permit2_transfer", contract: PERMIT2, word: "1", mask: "4" }),
  );
  assert.deepEqual([cancel.risk.level, cancel.risk.findings.map((f) => f.rule)], ["info", ["permit2_cancel_transfers"]]);
  assert.equal(cancel.display.call["selector"], "0x3ff9dcb1");
  // Used or cancelled on chain (its bit set): the step goes ahead, and the row is gone.
  net.state.permit2Bitmap["1"] = 4n;
  assert.equal(ok<Review>(await service.handle({ type: "prepare_swap", quote: q.id })).swap?.step, "approve");
  assert.equal(ok<{ permit2Signed?: unknown[] }>(await service.handle({ type: "approvals" })).permit2Signed, undefined);
});

// Review: a Permit2 permit the wallet can't read exactly (a field it can't parse, more than
// it keeps per signature) isn't signed, so none goes unrecorded; past the records kept, the
// wallet says it can't tell.
test("Permit2 permits are read exactly, or not signed", async () => {
  const domain = { name: "Permit2", chainId: 1776, verifyingContract: PERMIT2.toUpperCase().replace("0X", "0x") };
  const single = (details: unknown, extra: Record<string, unknown> = {}) => ({ domain, primaryType: "PermitSingle", message: { details, spender: "0X5555555555555555555555555555555555555555", sigDeadline: "99999999999", ...extra } });
  const detail = { token: USDT_ERC20, amount: "1", expiration: "0", nonce: "0" };
  const read = permitsOf(single(detail));
  assert.ok(read && read !== "unreadable");
  assert.deepEqual(read.permits.map((p) => [p.spender, p.kind]), [["0x5555555555555555555555555555555555555555", "allowance"]]);
  assert.equal(permitsOf(single({ ...detail, nonce: 2 ** 60 })), "unreadable");
  assert.equal(permitsOf(single(detail, { sigDeadline: "soon" })), "unreadable");
  assert.equal(permitsOf({ ...single(detail), primaryType: "PermitBatch", message: { details: Array.from({ length: 51 }, () => detail), spender: "0x5555555555555555555555555555555555555555", sigDeadline: "1" } }), "unreadable");
  // Another contract's "Permit2" isn't recorded (Approvals names those as not checked).
  assert.equal(permitsOf({ ...single(detail), domain: { ...domain, verifyingContract: "0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768" } }), null);
  // Past the records kept per account, it can't say no one else holds one, until they end.
  const local = new Map<string, unknown>();
  const store = { get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => local.has(k)).map((k) => [k, local.get(k)])), set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => local.set(k, v)), remove: async (keys: string[]) => void keys.forEach((k) => local.delete(k)) };
  const p2 = createPermit2(store, () => 1000);
  const owner = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
  const batch = (n: number) => ({ domain, primaryType: "PermitBatch", message: { details: Array.from({ length: n }, (_, i) => ({ ...detail, nonce: String(i) })), spender: "0x5555555555555555555555555555555555555555", sigDeadline: "5000" } });
  for (let i = 0; i < 4; i++) await p2.record(owner, batch(50));
  assert.equal((await p2.live("eip155:1776", owner, null)).permits.length, 200);
  await p2.record(owner, batch(1));
  const after = await p2.live("eip155:1776", owner, null);
  assert.equal(after.unchecked, true);
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
