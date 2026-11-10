// In, from Solana (the account's Solana key signs there): a quote, the burn, and later the
// rent of the burn's record, which comes back after Circle's delay.

import { bytesToBase58, NETWORKS, word, type NetworkId } from "@choice-wallet/chain";
import { ed25519 } from "@noble/curves/ed25519";
import type { AccountInfo, BridgeInQuote, Result, SendReview } from "@choice-wallet/ui/protocol";
import {
  BRIDGE_RECEIVER,
  INJECTIVE_DOMAIN,
  depositForBurnInstruction,
  encodeGasDropHook,
  findProgramAddress,
  reclaimEventAccountInstruction,
  EVENT_ACCOUNT_REFUND_DELAY_SEC,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  expectedAttestMs,
} from "injective-usdc-bridge";

import { fail, randomId } from "../util";
import { BRIDGE_QUOTE_TTL_MS, same, SOLANA_KEY, solanaSource, type BridgeContext, type StoredIn } from "./shared";

/** The burn's record on Solana: discriminator, rent payer, created at, then the message
 *  (148-byte header, 228-byte body, the hook) behind its length. Its rent comes back after
 *  Circle's delay (EVENT_ACCOUNT_REFUND_DELAY_SEC, 5 days). */
const recordSize = (hook: number) => 8 + 32 + 8 + 4 + 148 + 228 + hook;

export function createBridgeInSolana(c: BridgeContext) {
  const { sender, session, local, now, solana, usdc, gasDropOffer, askIn, attested, rentRecords } = c;

  /** The account's USDC and SOL on Solana. */
  async function solanaHeld(network: NetworkId, account: AccountInfo): Promise<{ usdc: bigint; native: bigint }> {
    const h = await solana!.holdings(network, account);
    if (!h || h.down) throw new Error("Solana didn't answer");
    const amount = (denom: string) => BigInt(h.balances.find((b) => b.denom === denom)?.amount ?? "0");
    return { usdc: amount(`spl:${NETWORKS[network].solana.usdcMint}`), native: amount("sol") };
  }

  /** A quote for USDC from Solana: Circle's fee for a burn there, and the SOL it needs (the
   *  fee, and the rent of the burn's record, which comes back after 5 days). */
  async function inQuoteSolana(network: NetworkId, account: AccountInfo, me: string, req: { amount?: unknown; gasDrop?: unknown }): Promise<Result<BridgeInQuote>> {
    const name = NETWORKS[network].solana.name;
    let held: { usdc: bigint; native: bigint };
    try {
      held = await solanaHeld(network, account);
    } catch {
      return fail("unreachable", `Couldn't reach ${name}. Try again.`);
    }
    let amount: bigint;
    if (req.amount === "max") amount = held.usdc;
    else if (typeof req.amount === "string" && /^[0-9]{1,30}$/.test(req.amount)) amount = BigInt(req.amount);
    else return fail("invalid_amount", "Enter an amount above zero.");
    if (amount <= 0n) return fail("invalid_amount", held.usdc === 0n ? `This account has no USDC on ${name}.` : "Enter an amount above zero.");
    if (amount > held.usdc) return fail("insufficient", `That's more USDC than you have on ${name}.`);
    let drop: { wei: bigint; fee: bigint } | null = null;
    if (req.gasDrop === true) {
      try {
        drop = await gasDropOffer(network);
      } catch (e) {
        return sender.chainFailure(e);
      }
      if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now.");
    }
    const q = await askIn(network, solanaSource(network), amount, drop?.fee ?? 0n);
    if (!q.ok) return q;
    let rent: bigint;
    try {
      rent = await (await solana!.rpc(network)).rentExempt(recordSize(drop ? 96 : 0));
    } catch {
      return fail("unreachable", `Couldn't reach ${name}. Try again.`);
    }
    const id = randomId();
    const stored: StoredIn = {
      id,
      network,
      account: me,
      chain: SOLANA_KEY,
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
        chain: SOLANA_KEY,
        chainName: name,
        symbol: "SOL",
        amount: stored.amount,
        maxFee: stored.maxFee,
        gasDropFee: stored.gasDropFee,
        gasDropInj: stored.dropWei,
        minReceived: stored.minReceived,
        fast: stored.fast,
        etaMs: expectedAttestMs(network, 5, q.result.minFinalityThreshold),
        steps: ["burn"],
        // Two signatures and a priority fee, besides the record's rent.
        gasNeed: (rent + 100_000n).toString(),
        gasHeld: held.native.toString(),
      },
    };
  }

  /** The burn on Solana for a stored quote: the account's USDC to its own 0x address on
   *  Injective (or through Choice's BridgeReceiver, for INJ for gas). A one-off key makes the
   *  burn's record; it signs after the vault, and holds nothing. */
  async function prepareInSolana(network: NetworkId, account: AccountInfo, me: string, s: StoredIn): Promise<Result<SendReview>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return fail("bad_request", "This account has no Solana address.");
    const net = NETWORKS[network];
    let held: { usdc: bigint; native: bigint };
    try {
      held = await solanaHeld(network, account);
    } catch {
      return fail("unreachable", `Couldn't reach ${net.solana.name}. Try again.`);
    }
    const amount = BigInt(s.amount);
    if (held.usdc < amount) return fail("insufficient", `That's more USDC than you have on ${net.solana.name}.`);
    if (now() - s.at > BRIDGE_QUOTE_TTL_MS) {
      let dropFee = 0n;
      if (BigInt(s.gasDropFee) > 0n) {
        const drop = await gasDropOffer(network).catch(() => null);
        if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now. Get a new quote.");
        dropFee = drop.fee;
        s.dropWei = drop.wei.toString();
      }
      const q = await askIn(network, solanaSource(network), amount, dropFee);
      if (!q.ok) return q;
      s.maxFee = q.result.maxFee.toString();
      s.gasDropFee = q.result.gasDropFee.toString();
      s.minReceived = q.result.minReceived.toString();
      s.fast = q.result.minFinalityThreshold === 1000;
      s.at = now();
      await session.set({ bridge_in_quote: s });
    }
    const dropFee = BigInt(s.gasDropFee);
    const receiver = BRIDGE_RECEIVER[network];
    if (dropFee > 0n && !receiver) return fail("gas_drop", "The INJ top-up isn't available on this network.");
    const u = await usdc(network, account);
    if (!u.ok) return u;
    const to = dropFee > 0n ? receiver! : me;
    const key = ed25519.utils.randomPrivateKey();
    const event = bytesToBase58(ed25519.getPublicKey(key));
    const burn = depositForBurnInstruction({
      owner,
      mint: net.solana.usdcMint,
      messageSentEventData: event,
      args: {
        amount,
        destinationDomain: INJECTIVE_DOMAIN,
        mintRecipient: `0x${word(to)}`,
        destinationCaller: dropFee > 0n ? `0x${word(to)}` : `0x${"0".repeat(64)}`,
        maxFee: BigInt(s.maxFee),
        minFinalityThreshold: s.fast ? 1000 : 2000,
        ...(dropFee > 0n ? { hookData: encodeGasDropHook(me as `0x${string}`, dropFee) } : {}),
      },
    });
    const usdcKey = `spl:${net.solana.usdcMint}`;
    return solana.prepareInstructions(network, account, {
      instructions: [burn],
      priorityAccounts: [net.solana.usdcMint, findProgramAddress([new TextEncoder().encode("message_transmitter")], SOLANA_MESSAGE_TRANSMITTER_V2)],
      recipient: null,
      balances: { native: held.native.toString(), [net.solana.usdcMint]: held.usdc.toString() },
      tokens: {
        sol: { denom: "sol", symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: net.solana.caip2 },
        [usdcKey]: { denom: usdcKey, symbol: "USDC", name: `USDC on ${net.solana.name}`, decimals: 6, known: true, chain: net.solana.caip2 },
        [u.result.denom]: { denom: u.result.denom, symbol: "USDC", name: "USD Coin", decimals: 6, known: true },
      },
      cosigner: key,
      deposit: { amount: s.amount, account: me, event, owner },
      extra: {
        bridgeIn: { step: "burn", left: 0, chain: net.solana.name, chainKey: SOLANA_KEY, amount: s.amount, maxFee: s.maxFee, gasDropFee: s.gasDropFee, gasDropInj: s.dropWei, minReceived: s.minReceived, usdc: usdcKey, injUsdc: u.result.denom },
      },
      expect: (d) => matchesSolanaQuote(d, s, me, owner),
    });
  }

  /** Burns on Solana whose record's rent this account can take back (Circle's delay past),
   *  and those still waiting. A record already closed is forgotten. */
  async function reclaims(network: NetworkId, account: AccountInfo): Promise<Result<{ hash: string; event: string; ready: boolean; at: number }[]>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return { ok: true, result: [] };
    const mine = (await rentRecords()).filter((r) => r.network === network && r.owner === owner);
    if (mine.length === 0) return { ok: true, result: [] };
    let open: (Record<string, unknown> | null)[];
    try {
      open = await (await solana.rpc(network)).accounts(mine.map((r) => r.event));
    } catch {
      return fail("unreachable", `Couldn't reach ${NETWORKS[network].solana.name}.`);
    }
    const closed = new Set(mine.filter((_, i) => open[i] === null && now() - mine[i]!.at > 120_000).map((r) => r.event));
    if (closed.size > 0) await local.set({ solana_rent: (await rentRecords()).filter((r) => !closed.has(r.event)) });
    return {
      ok: true,
      result: mine.filter((r) => !closed.has(r.event)).map((r) => ({ hash: r.hash, event: r.event, at: r.at, ready: now() - r.at > EVENT_ACCOUNT_REFUND_DELAY_SEC * 1000 + 60_000 })),
    };
  }

  /** Take a burn record's rent back, once Circle's delay has passed: its message and
   *  attestation, from Iris, prove Circle read it. */
  async function prepareReclaim(network: NetworkId, account: AccountInfo, hash: unknown): Promise<Result<SendReview>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return fail("bad_request", "This account has no Solana address.");
    const r = (await rentRecords()).find((x) => x.network === network && x.owner === owner && x.hash === hash);
    if (!r) return fail("not_found", "Nothing to take back for that transfer.");
    if (now() - r.at < EVENT_ACCOUNT_REFUND_DELAY_SEC * 1000) return fail("not_ready", "Circle lets it go 5 days after the transfer.");
    const found = await attested(network, { chain: SOLANA_KEY, hash: r.hash });
    if (!found.ok) return found;
    const m = found.result.m;
    if (!m || m.status !== "complete" || m.attestation === "PENDING") return fail("not_ready", "Circle hasn't confirmed that transfer.");
    const net = NETWORKS[network].solana;
    return solana.prepareInstructions(network, account, {
      instructions: [reclaimEventAccountInstruction({ payee: owner, eventAccount: r.event, message: m.message, attestation: m.attestation })],
      priorityAccounts: [r.event],
      recipient: null,
      balances: {},
      tokens: { sol: { denom: "sol", symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: net.caip2 } },
      expect: (d) => {
        const steps = Array.isArray(d["instructions"]) ? (d["instructions"] as Record<string, unknown>[]) : [];
        const back = steps.filter((x) => x["type"] === "bridge_reclaim");
        return back.length === 1 && back[0]!["event_account"] === r.event && back[0]!["payee"] === owner ? null : "That isn't the rent this account paid.";
      },
    });
  }

  return { solanaHeld, inQuoteSolana, prepareInSolana, reclaims, prepareReclaim };
}

/** The vault's reading of a burn on Solana against its quote: to Injective, this account,
 *  the amount and fees asked, from the account's own USDC. */
function matchesSolanaQuote(d: Record<string, unknown>, s: StoredIn, me: string, owner: string): string | null {
  const steps = Array.isArray(d["instructions"]) ? (d["instructions"] as Record<string, unknown>[]) : [];
  const burns = steps.filter((x) => x["type"] === "bridge");
  if (burns.length !== 1 || steps.some((x) => x["type"] === "program" || x["type"] === "unreadable")) return "The transfer isn't one the wallet can read.";
  const b = burns[0]!;
  if (b["chain"] !== "Injective" || b["usdc"] !== true || b["owner"] !== owner) return "The transfer doesn't go where its quote said.";
  if (b["amount"] !== s.amount || b["max_fee"] !== s.maxFee) return "The transfer doesn't match its quote.";
  if (typeof b["recipient"] !== "string" || !same(b["recipient"], me)) return "The transfer pays someone else.";
  const drop = BigInt(s.gasDropFee) > 0n;
  if (b["delivery"] !== (drop ? "gas_drop" : "anyone") || (drop && b["max_drop_fee"] !== s.gasDropFee)) return "The INJ top-up doesn't match its quote.";
  return null;
}
