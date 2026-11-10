// In, from another EVM chain (the same key, so the same 0x address there):
// 1. Balances: each chain's public endpoint (the package's registry) is asked for this
//    address's USDC and gas coin, so the form can start where the USDC is.
// 2. Quote: Circle's fee for a burn from there (Fast where the chain offers it), and on
//    mainnet optionally Choice's BridgeReceiver top-up, which buys INJ for gas.
// 3. Steps, signed on that chain: an exact USDC approval for TokenMessengerV2, then the burn.
//    The vault signs nothing else there: only what it reads as a deposit into this account.
// 4. Delivery: Circle doesn't mint on Injective. Choice's bridge service does, for anyone
//    (the top-up only through BridgeReceiver); if it hasn't, the account can mint it itself
//    (`receiveMessage`, a little INJ). The burn is followed from local storage until
//    Injective's MessageTransmitterV2 has used its nonce.
//
// From Solana: ./solana.ts.

import { NETWORKS, word, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, BridgeInBalance, BridgeInPending, BridgeInQuote, BridgeInRoutes, BridgeInStatus, BridgeStep, Result, SendReview } from "@choice-wallet/ui/protocol";
import {
  BRIDGE_RECEIVER,
  CCTP_CONTRACTS,
  buildBurn,
  bytes32ToAddress,
  decodeBurnMessage,
  decodeMessage,
  expectedAttestMs,
  injective,
  type EvmChain,
  type Quote,
} from "injective-usdc-bridge";

import { dataFeeBound, sourceUsdc, type EvmDisplayLike, type SourceChain } from "../send";
import { fail, randomId } from "../util";
import type { createBridgeInSolana } from "./solana";
import { APPROVE_GAS, ARC_GAS_RESERVE, BALANCE_TIMEOUT_MS, BRIDGE_QUOTE_TTL_MS, bridgeSources, BURN_GAS, hexAmount, RECEIVE_GAS, same, SOLANA_KEY, sourceOf, STEP_BYTES, tokenMessenger, TRACK_MS, TRACK_URL, withTimeout, type BridgeContext, type StoredIn } from "./shared";

export function createBridgeIn(c: BridgeContext, fromSolana: ReturnType<typeof createBridgeInSolana>) {
  const { sender, session, now, solana, usdc, gasDropOffer, askIn, attested, tracked, forget } = c;
  const { solanaHeld, inQuoteSolana, prepareInSolana } = fromSolana;

  /** The account's USDC there and its coin for gas, or null where the chain didn't answer. */
  async function heldOn(source: SourceChain, me: string): Promise<{ usdc: bigint; native: bigint }> {
    const rpc = sender.sourceRpc(source);
    const [usdcHeld, native] = await Promise.all([
      rpc.call("eth_call", [{ to: source.usdc, data: `0x70a08231${word(me)}` }, "latest"]),
      rpc.call("eth_getBalance", [me, "latest"]),
    ]);
    return { usdc: hexAmount(usdcHeld), native: hexAmount(native) };
  }

  async function inRoutes(network: NetworkId, account: AccountInfo): Promise<Result<BridgeInRoutes>> {
    const u = await usdc(network, account);
    if (!u.ok) return u;
    return {
      ok: true,
      result: {
        chains: [
          ...bridgeSources(network).map((c) => ({ key: c.key, name: c.name, symbol: c.nativeSymbol, fast: c.fastSource, decimals: 18 })),
          ...(solana?.address(network, account) ? [{ key: SOLANA_KEY, name: NETWORKS[network].solana.name, symbol: "SOL", fast: true, decimals: 9 }] : []),
        ],
        address: account.addresses[NETWORKS[network].evm] ?? "",
        usdc: u.result.denom,
        inj: u.result.inj.toString(),
        gasDrop: BRIDGE_RECEIVER[network] !== undefined,
      },
    };
  }

  /** The account's USDC and gas coin on each chain USDC can come from. Each chain's public
   *  endpoint is asked about this account's address (the same 0x on every chain). */
  async function inBalances(network: NetworkId, account: AccountInfo): Promise<Result<BridgeInBalance[]>> {
    const me = account.addresses[NETWORKS[network].evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    const all = await Promise.all(
      bridgeSources(network).map(async (c): Promise<BridgeInBalance> => {
        try {
          const h = await withTimeout(heldOn(sourceOf(c), me), BALANCE_TIMEOUT_MS);
          return { chain: c.key, usdc: h.usdc.toString(), native: h.native.toString() };
        } catch {
          return { chain: c.key, usdc: null, native: null };
        }
      }),
    );
    if (solana?.address(network, account)) all.push(await solanaHeld(network, account).then(
      (h) => ({ chain: SOLANA_KEY, usdc: h.usdc.toString(), native: h.native.toString() }),
      () => ({ chain: SOLANA_KEY, usdc: null, native: null }),
    ));
    return { ok: true, result: all };
  }

  async function inQuote(network: NetworkId, account: AccountInfo, req: { from?: unknown; amount?: unknown; gasDrop?: unknown }): Promise<Result<BridgeInQuote>> {
    const me = account.addresses[NETWORKS[network].evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    if (req.from === SOLANA_KEY && solana?.address(network, account)) return inQuoteSolana(network, account, me, req);
    const chain = typeof req.from === "string" ? bridgeSources(network).find((c) => c.key === req.from) : undefined;
    if (!chain) return fail("bad_request", "Pick the chain your USDC is on.");
    const source = sourceOf(chain);
    let held: { usdc: bigint; native: bigint };
    let fees: { base: bigint; tip: bigint; data: bigint };
    let allowed: bigint;
    try {
      [held, fees, allowed] = await Promise.all([heldOn(source, me), feesOn(source), allowanceOn(source, network, me)]);
    } catch {
      return fail("unreachable", `Couldn't reach ${chain.name}. Try again.`);
    }
    let amount: bigint;
    // On Arc the fee comes out of the same USDC: "max" leaves some for it.
    if (req.amount === "max") amount = source.gasIsUsdc ? held.usdc - ARC_GAS_RESERVE : held.usdc;
    else if (typeof req.amount === "string" && /^[0-9]{1,30}$/.test(req.amount)) amount = BigInt(req.amount);
    else return fail("invalid_amount", "Enter an amount above zero.");
    if (amount <= 0n) return fail("invalid_amount", held.usdc === 0n ? `This account has no USDC on ${chain.name}.` : "Enter an amount above zero.");
    if (amount > held.usdc) return fail("insufficient", `That's more USDC than you have on ${chain.name}.`);
    let drop: { wei: bigint; fee: bigint } | null = null;
    if (req.gasDrop === true) {
      try {
        drop = await gasDropOffer(network);
      } catch (e) {
        return sender.chainFailure(e);
      }
      if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now.");
    }
    const q = await askIn(network, chain, amount, drop?.fee ?? 0n);
    if (!q.ok) return q;
    const steps: BridgeStep[] = allowed < amount ? ["approve", "burn"] : ["burn"];
    const gasNeed = ((steps.length > 1 ? APPROVE_GAS : 0n) + BURN_GAS) * (fees.base * 2n + fees.tip) + BigInt(steps.length) * fees.data;
    const id = randomId();
    const stored: StoredIn = {
      id,
      network,
      account: me,
      chain: chain.key,
      amount: amount.toString(),
      maxFee: q.result.maxFee.toString(),
      gasDropFee: q.result.gasDropFee.toString(),
      dropWei: (drop?.wei ?? 0n).toString(),
      minReceived: q.result.minReceived.toString(),
      fast: q.result.minFinalityThreshold === 1000,
      at: now(),
    };
    await session.set({ bridge_in_quote: stored });
    return {
      ok: true,
      result: {
        id,
        chain: chain.key,
        chainName: chain.name,
        symbol: chain.nativeSymbol,
        amount: stored.amount,
        maxFee: stored.maxFee,
        gasDropFee: stored.gasDropFee,
        gasDropInj: stored.dropWei,
        minReceived: stored.minReceived,
        fast: stored.fast,
        etaMs: expectedAttestMs(network, chain.domain, q.result.minFinalityThreshold),
        steps,
        gasNeed: gasNeed.toString(),
        gasHeld: (source.gasIsUsdc ? held.native - amount * 10n ** 12n : held.native).toString(),
      },
    };
  }

  /** The next step of the stored deposit quote, ready to review: on the chain the USDC is on. */
  async function prepareIn(network: NetworkId, account: AccountInfo, id: unknown): Promise<Result<SendReview>> {
    const { bridge_in_quote } = await session.get(["bridge_in_quote"]);
    const s = bridge_in_quote as StoredIn | undefined;
    const me = account.addresses[NETWORKS[network].evm];
    if (s && s.chain === SOLANA_KEY && s.id === id && s.network === network && me && same(s.account, me)) return prepareInSolana(network, account, me, s);
    const chain = s ? bridgeSources(network).find((c) => c.key === s.chain) : undefined;
    if (!s || s.id !== id || s.network !== network || !me || !same(s.account, me) || !chain) return fail("not_found", "This quote is gone. Get a new one.");
    const source = sourceOf(chain);
    const amount = BigInt(s.amount);
    let held: { usdc: bigint; native: bigint };
    let allowed: bigint;
    try {
      [held, allowed] = await Promise.all([heldOn(source, me), allowanceOn(source, network, me)]);
    } catch {
      return fail("unreachable", `Couldn't reach ${chain.name}. Try again.`);
    }
    if (held.usdc < amount) return fail("insufficient", `That's more USDC than you have on ${chain.name}.`);
    const steps: BridgeStep[] = allowed < amount ? ["approve", "burn"] : ["burn"];
    const step = steps[0]!;
    // The fees are asked again before the burn if the quote aged.
    if (step === "burn" && now() - s.at > BRIDGE_QUOTE_TTL_MS) {
      let dropFee = 0n;
      if (BigInt(s.gasDropFee) > 0n) {
        const drop = await gasDropOffer(network).catch(() => null);
        if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now. Get a new quote.");
        dropFee = drop.fee;
        s.dropWei = drop.wei.toString();
      }
      const q = await askIn(network, chain, amount, dropFee);
      if (!q.ok) return q;
      s.maxFee = q.result.maxFee.toString();
      s.gasDropFee = q.result.gasDropFee.toString();
      s.minReceived = q.result.minReceived.toString();
      s.fast = q.result.minFinalityThreshold === 1000;
      s.at = now();
      await session.set({ bridge_in_quote: s });
    }
    const u = await usdc(network, account);
    if (!u.ok) return u;
    const extra = {
      bridgeIn: { step, left: steps.length - 1, chain: chain.name, chainKey: chain.key, amount: s.amount, maxFee: s.maxFee, gasDropFee: s.gasDropFee, gasDropInj: s.dropWei, minReceived: s.minReceived, usdc: sourceUsdc(source), injUsdc: u.result.denom },
    } satisfies Partial<SendReview>;
    if (step === "approve") {
      return sender.prepareSourceCall(network, account, source, {
        to: source.usdc,
        amount,
        call: { type: "bridge_approve" },
        usdcHeld: held.usdc,
        burns: 0n,
        extra,
        expect: (d) => (d.call["type"] === "approve" && same(String(d.call["spender"]), tokenMessenger(network)) && d.call["amount"] === s.amount && same(d.to, source.usdc) ? null : "The approval isn't the one asked for."),
      });
    }
    const dropFee = BigInt(s.gasDropFee);
    const receiver = BRIDGE_RECEIVER[network];
    if (dropFee > 0n && !receiver) return fail("gas_drop", "The INJ top-up isn't available on this network.");
    const quoted: Quote = {
      direction: "deposit",
      amount,
      speed: s.fast ? "fast" : "standard",
      minFinalityThreshold: s.fast ? 1000 : 2000,
      protocolFee: BigInt(s.maxFee),
      forwardingFee: 0n,
      gasDropFee: dropFee,
      bridgeFee: 0n,
      maxFee: BigInt(s.maxFee),
      minReceived: BigInt(s.minReceived),
      forwarded: false,
      recipientSetup: false,
    };
    let data: string;
    try {
      const route = { source: chain, destination: injective(network) };
      data = buildBurn({ network, route, quote: quoted, recipient: me, allowance: amount, ...(dropFee > 0n && receiver ? { gasDrop: { receiver, maxDropFee: dropFee } } : {}) }).burn.data;
    } catch (e) {
      return fail("bad_request", e instanceof Error ? e.message : "Couldn't build the transfer.");
    }
    return sender.prepareSourceCall(network, account, source, {
      to: tokenMessenger(network),
      amount: 0n,
      call: { type: "bridge", data },
      usdcHeld: held.usdc,
      burns: amount,
      extra,
      deposit: { amount: s.amount, account: me },
      expect: (d) => matchesInQuote(d, s, chain, me),
    });
  }

  /** Where a deposit is: Circle saw the burn, attested it, and whether Injective minted it. */
  async function inStatus(network: NetworkId, account: AccountInfo, req: { chain?: unknown; hash?: unknown }): Promise<Result<BridgeInStatus>> {
    const found = await attested(network, req);
    if (!found.ok) return found;
    const { chain, hash, m } = found.result;
    const base = { track: `${TRACK_URL}/${chain.domain}/${hash}`, selfMint: false, etaMs: expectedAttestMs(network, chain.domain, 1000) };
    if (!m) return { ok: true, result: { ...base, phase: "pending" } };
    if (m.status !== "complete" || m.attestation === "PENDING" || m.message === "0x") return { ok: true, result: { ...base, phase: "attesting" } };
    let used: boolean;
    try {
      used = await nonceUsed(network, m.eventNonce);
    } catch (e) {
      return sender.chainFailure(e);
    }
    if (used) {
      await forget(hash);
      return { ok: true, result: { ...base, phase: "delivered" } };
    }
    const me = account.addresses[NETWORKS[network].evm] ?? "";
    return { ok: true, result: { ...base, phase: "ready", selfMint: mintsTo(m.message, me) } };
  }

  /** The mint of an attested deposit on Injective, by this account: when Choice's service
   *  hasn't done it (it is down, the amount is under what it relays, or on testnet, where it
   *  doesn't run). Anyone may submit it; it costs this account a little INJ. */
  async function prepareReceive(network: NetworkId, account: AccountInfo, req: { chain?: unknown; hash?: unknown }): Promise<Result<SendReview>> {
    const found = await attested(network, req);
    if (!found.ok) return found;
    const { chain, m } = found.result;
    const me = account.addresses[NETWORKS[network].evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    if (!m || m.status !== "complete" || m.attestation === "PENDING") return fail("not_ready", "Circle hasn't confirmed it yet.");
    if (!mintsTo(m.message, me)) return fail("not_yours", "Only Choice's bridge contract can complete this one.");
    const u = await usdc(network, account);
    if (!u.ok) return u;
    const body = decodeBurnMessage(decodeMessage(m.message).body);
    return sender.prepareEvmCall(network, account, {
      to: CCTP_CONTRACTS[network].messageTransmitter,
      amount: 0n,
      call: { type: "bridge_receive", message: m.message, attestation: m.attestation },
      gasHint: RECEIVE_GAS,
      tokens: [u.result.denom],
      extra: { bridgeIn: { step: "receive", left: 0, chain: chain.name, chainKey: chain.key, amount: body.amount.toString(), maxFee: body.maxFee.toString(), gasDropFee: "0", gasDropInj: "0", minReceived: (body.amount - body.feeExecuted).toString(), usdc: u.result.denom, injUsdc: u.result.denom } },
      expect: (d) => (d.call["type"] === "bridge_receive" && d.call["chain"] === chain.name && typeof d.call["recipient"] === "string" && same(d.call["recipient"], me) ? null : "The mint isn't the one asked for."),
    });
  }

  /** Deposits this account sent that haven't arrived yet, newest first. */
  async function inPending(network: NetworkId, account: AccountInfo): Promise<Result<BridgeInPending[]>> {
    const me = account.addresses[NETWORKS[network].evm] ?? "";
    const list = await tracked();
    const names = new Map([...bridgeSources(network).map((c) => [c.key, c.name] as const), [SOLANA_KEY, NETWORKS[network].solana.name] as const]);
    return {
      ok: true,
      result: list
        .filter((t) => t.network === network && same(t.account, me) && now() - t.at < TRACK_MS && names.has(t.chain))
        .map((t) => ({ chain: t.chain, chainName: names.get(t.chain)!, hash: t.hash, amount: t.amount, at: t.at })),
    };
  }

  /** Whether Injective's MessageTransmitterV2 has used this nonce: the only proof of a mint. */
  async function nonceUsed(network: NetworkId, nonce: string): Promise<boolean> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("Circle gave no nonce");
    const r = await (await sender.evm(network)).call("eth_call", [{ to: CCTP_CONTRACTS[network].messageTransmitter, data: `0xfeb61724${nonce.slice(2)}` }, "latest"]);
    return hexAmount(r) !== 0n;
  }

  /** Gas prices there, and the most a step's Ethereum data fee can be (OP Stack chains). */
  async function feesOn(source: SourceChain): Promise<{ base: bigint; tip: bigint; data: bigint }> {
    const rpc = sender.sourceRpc(source);
    const [block, tip, data] = await Promise.all([rpc.call("eth_getBlockByNumber", ["latest", false]), rpc.call("eth_maxPriorityFeePerGas", []).catch(() => "0x0"), dataFeeBound(rpc, source, STEP_BYTES)]);
    const base = block && typeof block === "object" ? hexAmount((block as Record<string, unknown>)["baseFeePerGas"]) : 0n;
    return { base, tip: hexAmount(tip), data };
  }

  async function allowanceOn(source: SourceChain, network: NetworkId, me: string): Promise<bigint> {
    const r = await sender.sourceRpc(source).call("eth_call", [{ to: source.usdc, data: `0xdd62ed3e${word(me)}${word(tokenMessenger(network))}` }, "latest"]);
    return hexAmount(r);
  }

  return { inRoutes, inBalances, inQuote, prepareIn, inStatus, prepareReceive, inPending };
}

/** Whether an attested message is a deposit anyone may mint that pays `me`. */
function mintsTo(message: string, me: string): boolean {
  try {
    const header = decodeMessage(message as `0x${string}`);
    if (!/^0x0{64}$/.test(header.destinationCaller)) return false;
    return same(bytes32ToAddress(decodeBurnMessage(header.body).mintRecipient), me);
  } catch {
    return false;
  }
}

/** The vault's reading of a deposit's burn against the quote the user saw. */
function matchesInQuote(d: EvmDisplayLike, s: StoredIn, chain: EvmChain, me: string): string | null {
  const c = d.call;
  if (c["type"] !== "bridge_in") return "The transfer isn't one the wallet can read.";
  if (c["chain"] !== chain.name || !same(String(c["token"]), chain.usdc)) return "The transfer comes from somewhere other than its quote.";
  if (c["amount"] !== s.amount || c["max_fee"] !== s.maxFee) return "The transfer doesn't match its quote.";
  if (typeof c["recipient"] !== "string" || !same(c["recipient"], me)) return "The transfer pays someone else.";
  const drop = BigInt(s.gasDropFee) > 0n;
  if (c["delivery"] !== (drop ? "gas_drop" : "anyone") || (drop && c["max_drop_fee"] !== s.gasDropFee)) return "The INJ top-up doesn't match its quote.";
  return null;
}
