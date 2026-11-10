// Swaps through Choice, on Injective's EVM side.
//
// 1. Quote: Choice's routing API answers with a route and its calldata (`chain/src/swap.ts`
//    checks the answer against the question). The quote waits in session storage.
// 2. Steps, each reviewed and confirmed like a send:
//    - an ERC20 input is pulled through Permit2, so the token must allow Permit2 the amount
//      (`approve`), and Permit2 must allow Choice's contract the amount for a while
//      (`permit2`). Both are for this swap's amount exactly, never unlimited;
//    - the swap: the API's calldata, which the vault reads and builds only if it pays this
//      account, with a minimum, any fee to Choice's treasury and no unknown adapter.
//    INJ in needs no approval: it is sent with the swap.
// After each step lands, the UI asks for the next one.

import { cw20Address, evmAddress, evmDenom, fetchRoute, isContractAddress, knownTokens, NATIVE, NETWORKS, RouteError, type Fetch, type NetworkId, type Route } from "@choice-wallet/chain";
import type { AccountInfo, Result, SendReview, SwapQuote, SwapStep, SwapToken } from "@choice-wallet/ui/protocol";

import type { createSender, EvmDisplayLike } from "./send";
import type { Store } from "./service";
import { fail, randomId } from "./util";

type Sender = ReturnType<typeof createSender>;

/** A quote older than this is asked for again: prices move. */
export const QUOTE_TTL_MS = 120_000;
/** How long a Permit2 allowance for one swap lasts. */
const PERMIT2_FOR_S = 30 * 60;
/** INJ kept back on "max", for this swap's fee and later ones. */
export const SWAP_RESERVE = 10n ** 16n;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What waits between the quote and its steps. */
interface Stored {
  id: string;
  network: NetworkId;
  account: string;
  from: string;
  to: string;
  tokenIn: string;
  tokenOut: string;
  slippageBps: number;
  at: number;
  route: Omit<Route, "value" | "amountIn" | "amountOut" | "minimumOut" | "gasEstimate"> & { value: string; amountIn: string; amountOut: string; minimumOut: string; gasEstimate: string | null };
}

/** `shown`: the tokens the user chose to show on a network (the token filter), which
 *  includes tokens added by contract. */
export function createSwaps(sender: Sender, session: Store, fetch: Fetch, shown: (network: NetworkId) => Promise<string[]>, now: () => number = Date.now) {
  /** The EVM token a wallet key trades as on Choice: native INJ, an ERC20 (an EVM-only
   *  token, a bank-backed `erc20:` denom, or a bank denom's ERC20 pair). */
  async function evmToken(network: NetworkId, denom: string): Promise<string | null> {
    if (denom === NETWORKS[network].feeDenom) return NATIVE;
    const direct = evmAddress(denom) ?? (denom.startsWith("erc20:") ? denom.slice(6) : null);
    if (direct) return direct;
    if (cw20Address(denom) || isContractAddress(denom)) return null;
    return (await sender.pairs(network)).get(denom) ?? null;
  }

  /** Tokens the swap screen offers: what this account holds that Choice can trade, then the
   *  wallet's list, then tokens the user added or chose to show. */
  async function tokens(network: NetworkId, account: AccountInfo): Promise<Result<SwapToken[]>> {
    const held = await sender.balances(network, account);
    if (!held.ok) return held;
    const out: SwapToken[] = [];
    const seen = new Set<string>();
    for (const b of held.result.balances) {
      if ((await evmToken(network, b.denom)) === null) continue;
      out.push(b);
      seen.add(b.denom);
    }
    for (const t of knownTokens(network)) {
      if (seen.has(t.denom) || (await evmToken(network, t.denom)) === null) continue;
      out.push(t);
      seen.add(t.denom);
    }
    const chosen: string[] = [];
    for (const dn of await shown(network)) if (!seen.has(dn) && (await evmToken(network, dn)) !== null) chosen.push(dn);
    const described = await sender.tokensFor(network, chosen);
    for (const dn of chosen) if (described[dn]) out.push(described[dn]);
    return { ok: true, result: out };
  }

  async function quote(network: NetworkId, account: AccountInfo, req: { from?: unknown; to?: unknown; amount?: unknown; slippageBps?: unknown }): Promise<Result<SwapQuote>> {
    const net = NETWORKS[network];
    const me = account.addresses[net.evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    if (typeof req.from !== "string" || typeof req.to !== "string" || req.from === req.to) return fail("bad_request", "Pick two different tokens.");
    const slippageBps = req.slippageBps === undefined ? 50 : req.slippageBps;
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) return fail("bad_request", "Slippage is 0.01% to 50%.");
    const [tokenIn, tokenOut] = await Promise.all([evmToken(network, req.from), evmToken(network, req.to)]);
    if (!tokenIn || !tokenOut) return fail("unsupported", "Choice can't swap this token on the EVM side.");
    if (same(tokenIn, tokenOut)) return fail("bad_request", "That's the same token.");
    // How much: the amount asked, or all of it ("max": all but a reserve for fees, for INJ).
    const held = await sender.balances(network, account);
    if (!held.ok) return held;
    const have = BigInt(held.result.balances.find((b) => b.denom === req.from)?.amount ?? "0");
    let amountIn: bigint;
    if (req.amount === "max") {
      amountIn = tokenIn === NATIVE ? have - SWAP_RESERVE : have;
    } else if (typeof req.amount === "string" && /^[0-9]{1,78}$/.test(req.amount)) {
      amountIn = BigInt(req.amount);
    } else {
      return fail("invalid_amount", "Enter an amount above zero.");
    }
    if (amountIn <= 0n) return fail("invalid_amount", "Enter an amount above zero.");
    if (amountIn > have) return fail("insufficient", "That's more than you have.");
    let route: Route;
    try {
      route = await fetchRoute(fetch, net, { tokenIn, tokenOut, amountIn, slippageBps, recipient: me });
    } catch (e) {
      if (e instanceof RouteError) return fail("no_route", e.message);
      return fail("unreachable", "Couldn't reach Choice. Try again.");
    }
    const id = randomId();
    const stored: Stored = {
      id,
      network,
      account: me,
      from: req.from,
      to: req.to,
      tokenIn,
      tokenOut,
      slippageBps,
      at: now(),
      route: {
        ...route,
        value: route.value.toString(),
        amountIn: route.amountIn.toString(),
        amountOut: route.amountOut.toString(),
        minimumOut: route.minimumOut.toString(),
        gasEstimate: route.gasEstimate?.toString() ?? null,
      },
    };
    await session.set({ swap_quote: stored });
    const steps = await stepsFor(network, stored);
    if (!steps.ok) return steps;
    return {
      ok: true,
      result: {
        id,
        from: req.from,
        to: req.to,
        amountIn: route.amountIn.toString(),
        amountOut: route.amountOut.toString(),
        minimumOut: route.minimumOut.toString(),
        slippageBps,
        executor: route.executor,
        legs: route.legs,
        fee: route.fee ? { bps: route.fee.bps } : null,
        steps: steps.result,
        tokens: await sender.tokensFor(network, [req.from, req.to]),
      },
    };
  }

  /** What a stored quote still needs, in order. */
  async function stepsFor(network: NetworkId, q: Stored): Promise<Result<SwapStep[]>> {
    if (q.tokenIn === NATIVE) return { ok: true, result: ["swap"] };
    const net = NETWORKS[network];
    try {
      const rpc = await sender.evm(network);
      const amount = BigInt(q.route.amountIn);
      const [toPermit2] = await rpc.erc20Allowances([{ token: q.tokenIn, spender: net.choice.permit2 }], q.account);
      const viaPermit2 = await rpc.permit2Allowance(net.choice.permit2, q.account, q.tokenIn, q.route.to);
      const steps: SwapStep[] = [];
      if (toPermit2 === null || toPermit2 === undefined || toPermit2 < amount) steps.push("approve");
      // An allowance that ends within five minutes may end before the swap lands.
      if (viaPermit2.amount < amount || viaPermit2.expiration < Math.floor(now() / 1000) + 300) steps.push("permit2");
      steps.push("swap");
      return { ok: true, result: steps };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** The next step of the stored quote, ready to review. */
  async function prepare(network: NetworkId, account: AccountInfo, id: unknown): Promise<Result<SendReview>> {
    const { swap_quote } = await session.get(["swap_quote"]);
    const q = swap_quote as Stored | undefined;
    const me = account.addresses[NETWORKS[network].evm];
    if (!q || q.id !== id || q.network !== network || !me || !same(q.account, me)) return fail("not_found", "This quote is gone. Get a new one.");
    // A quote that aged while approvals landed is asked for again, for the same pair, amount
    // and slippage: approvals don't depend on the price, and the swap's review shows the new
    // minimum before anything is signed.
    if (now() - q.at > QUOTE_TTL_MS) {
      let route: Route;
      try {
        route = await fetchRoute(fetch, NETWORKS[network], { tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: BigInt(q.route.amountIn), slippageBps: q.slippageBps, recipient: me });
      } catch (e) {
        if (e instanceof RouteError) return fail("quote_expired", `This quote is old, and Choice won't quote it again: ${e.message}`);
        return fail("unreachable", "Couldn't reach Choice. Try again.");
      }
      q.at = now();
      q.route = { ...route, value: route.value.toString(), amountIn: route.amountIn.toString(), amountOut: route.amountOut.toString(), minimumOut: route.minimumOut.toString(), gasEstimate: route.gasEstimate?.toString() ?? null };
      await session.set({ swap_quote: q });
    }
    const steps = await stepsFor(network, q);
    if (!steps.ok) return steps;
    const step = steps.result[0]!;
    const left = steps.result.length - 1;
    const net = NETWORKS[network];
    const amount = BigInt(q.route.amountIn);
    const extra = { swap: { step, left, from: q.from, to: q.to, expectedOut: q.route.amountOut } };
    const tokens = [q.from, q.to];
    if (step === "approve") {
      return sender.prepareEvmCall(network, account, {
        to: q.tokenIn,
        amount,
        call: { type: "approve" },
        tokens,
        extra,
        expect: (d) => (d.call["type"] === "approve" && same(String(d.call["spender"]), net.choice.permit2) && d.call["amount"] === amount.toString() ? null : "The approval isn't the one asked for."),
      });
    }
    if (step === "permit2") {
      return sender.prepareEvmCall(network, account, {
        to: net.choice.permit2,
        amount,
        call: { type: "permit2_approve", token: q.tokenIn, spender: q.route.to, expiration: Math.floor(now() / 1000) + PERMIT2_FOR_S },
        tokens,
        extra,
        expect: (d) => (d.call["type"] === "permit2_approve" && same(String(d.call["spender"]), q.route.to) && d.call["amount"] === amount.toString() ? null : "The approval isn't the one asked for."),
      });
    }
    return sender.prepareEvmCall(network, account, {
      to: q.route.to,
      amount: BigInt(q.route.value),
      call: { type: "swap", data: q.route.data },
      gasHint: q.route.gasEstimate === null ? null : BigInt(q.route.gasEstimate),
      tokens,
      extra,
      expect: (d) => matchesQuote(d, q),
    });
  }

  return { tokens, quote, prepare, evmToken };
}

/** The vault's reading of the swap against the quote the user saw. */
function matchesQuote(d: EvmDisplayLike, q: Stored): string | null {
  const c = d.call;
  if (c["type"] !== "swap") return "Choice's transaction isn't a swap the wallet can read.";
  if (!same(String(c["token_in"]), q.tokenIn) || !same(String(c["token_out"]), q.tokenOut)) return "Choice's transaction swaps another pair than its quote.";
  if (c["amount_in"] !== q.route.amountIn || c["minimum_out"] !== q.route.minimumOut) return "Choice's transaction doesn't match its quote.";
  if (!same(String(c["recipient"]), q.account)) return "Choice's transaction pays someone else.";
  return null;
}

/** The wallet key an ERC20 shows as: its bank denom when it is a pair's, else `evm:`. */
export function denomOf(pairs: ReadonlyMap<string, string>, token: string): string {
  for (const [denom, erc20] of pairs) if (same(erc20, token)) return denom;
  return evmDenom(token);
}
