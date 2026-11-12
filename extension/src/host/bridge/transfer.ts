// USDC from any chain to any other, over Circle's CCTP: Injective, Solana, and the EVM chains
// beside them (chain/src/chains.ts). The account signs on the chain the USDC is on, with its
// key there (the same 0x on every EVM chain; its Solana key on Solana).
//
// 1. Routes: every chain the account has an address on, with its USDC and gas coin there.
// 2. Quote: Circle's fees from Iris for this route and amount; who delivers on the
//    destination: Circle, where it forwards (opening a Solana recipient's USDC account if it
//    has none); on Injective, Choice's bridge service or anyone (the wallet too), or Choice's
//    BridgeReceiver when the transfer also buys INJ for gas (mainnet); elsewhere, whoever
//    claims it with gas there (Plasma), which the wallet offers to do. The recipient is
//    checked: a 0x address on an EVM chain, a Solana wallet on Solana. The quote waits in
//    session storage.
// 3. Steps, each reviewed and confirmed like a send, on the source chain: an exact USDC
//    approval for TokenMessengerV2 where it is short (EVM), then the burn, which the vault
//    reads like any other and the host holds to the quote.
// 4. Delivery: the burn is followed from local storage until it lands. Iris says when it is
//    attested and whether Circle delivered; on an EVM destination the chain's
//    MessageTransmitterV2 says whether its nonce is used, the only proof of a mint. One nobody
//    minted can be minted from this account (`receiveMessage`), paying gas there.
//
// injective-usdc-bridge 0.2.0's quote and burn builders insist on Injective at one end; its
// lower-level pieces (Iris' fees, the burn's calldata, the hooks, Solana's instruction) are
// used here for every route, with the same arithmetic.

import { CHAINS, cctpChain, word, bytesToBase58, type ChainInfo, type NetworkId } from "@choice-wallet/chain";
import { ed25519 } from "@noble/curves/ed25519";
import type { AccountInfo, BridgeEnd, BridgePending, BridgeQuote, BridgeRoutes, BridgeStatus, BridgeStep, BridgeStepInfo, Result, SendReview } from "@choice-wallet/ui/protocol";
import {
  BRIDGE_RECEIVER,
  CCTP_CONTRACTS,
  FINALITY,
  FORWARD_HOOK_DATA,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  addressToBytes32,
  associatedTokenAddress,
  bpsFee,
  burnCall,
  checkSolanaRecipient,
  decodeBurnMessage,
  decodeMessage,
  depositForBurnInstruction,
  encodeGasDropHook,
  expectedAttestMs,
  findProgramAddress,
  forwardHookDataWithAccountSetup,
  solanaToBytes32,
  toEvmAddress,
  type IrisMessage,
} from "injective-usdc-bridge";

import { dataFeeBound, sourceOfChain, type EvmDisplayLike, type SourceChain } from "../send";
import { fail, randomId } from "../util";
import { BRIDGE_QUOTE_TTL_MS, hexAmount, MAX_TRACKED, same, TRACK_MS, TRACK_URL, withTimeout, type BridgeContext } from "./shared";

/** Gas a step takes, for the estimate the form shows (a burn measured at about 110k to 170k;
 *  an approval about 46k to 56k), and about the size of a step's unsigned transaction. */
const BURN_GAS = 200_000n;
const APPROVE_GAS = 60_000n;
const STEP_BYTES = 420;
/** eth_estimateGas comes in low on Injective for a mint (Choice's bridge relays at an 800k
 *  floor). */
const RECEIVE_GAS = 600_000n;
/** Left on Arc for its fee, which is paid in USDC, when bridging "max" from there. */
const ARC_GAS_RESERVE = 50_000n;
/** A chain's endpoint gets this long for a balance on the form. */
const BALANCE_TIMEOUT_MS = 6_000;
/** Solana: two signatures and a priority fee, besides the burn record's rent. */
const SOLANA_FEES = 100_000n;
/** The burn's record on Solana: discriminator, rent payer, created at, then the message
 *  (148-byte header, 228-byte body, the hook) behind its length. Its rent comes back after
 *  Circle's delay. */
const recordSize = (hook: number) => 8 + 32 + 8 + 4 + 148 + 228 + hook;

/** Who delivers on the destination. */
type Delivery = BridgeQuote["delivery"];

/** What waits between a quote and its steps. Amounts are decimal strings. */
interface Stored {
  id: string;
  network: NetworkId;
  from: string;
  to: string;
  /** The signer's address on `from`. */
  account: string;
  /** As the burn names it: a 0x address, or a Solana wallet. */
  recipient: string;
  amount: string;
  maxFee: string;
  gasDropFee: string;
  /** INJ the top-up buys, in wei; "0" without one. */
  dropWei: string;
  minReceived: string;
  recipientSetup: boolean;
  fast: boolean;
  delivery: Delivery;
  at: number;
}

/** A transfer followed until it lands (local storage: it outlives the popup and a restart). */
export interface Transfer {
  network: NetworkId;
  from: string;
  to: string;
  hash: string;
  amount: string;
  /** The signer's address on `from`. */
  account: string;
  recipient: string;
  at: number;
}

export function createTransfers(c: BridgeContext) {
  const { sender, session, local, now, solana, gasDropOffer } = c;

  /** The USDC and gas coin the account holds on a chain (null where it didn't answer). */
  async function heldOn(network: NetworkId, account: AccountInfo, chain: ChainInfo): Promise<{ usdc: bigint; native: bigint } | null> {
    const address = account.addresses[chain.caip2];
    if (!address) return null;
    try {
      if (chain.kind === "solana") {
        const h = await solana!.holdings(network, account);
        if (!h || h.down) return null;
        const amount = (denom: string) => BigInt(h.balances.find((b) => b.denom === denom)?.amount ?? "0");
        return { usdc: amount(`spl:${chain.usdc}`), native: amount("sol") };
      }
      if (chain.kind === "injective") {
        // Injective's USDC is a bank balance (its ERC20 is the same tokens), read like the rest.
        const b = await sender.balances(network, account);
        if (!b.ok) return null;
        const amount = (denom: string) => BigInt(b.result.balances.find((x) => same(x.denom, denom))?.amount ?? "0");
        return { usdc: amount(`erc20:${chain.usdc}`), native: amount("inj") };
      }
      const rpc = await sender.chainRpc(network, chain.key);
      const [usdc, native] = await rpc.batch([
        { method: "eth_call", params: [{ to: chain.usdc, data: `0x70a08231${word(address)}` }, "latest"] },
        { method: "eth_getBalance", params: [address, "latest"] },
      ]);
      return { usdc: hexAmount(usdc), native: hexAmount(native) };
    } catch {
      return null;
    }
  }

  /** Every chain USDC can go to; on those where the account has an address, that address and
   *  what it holds there (where it can send from). */
  async function routes(network: NetworkId, account: AccountInfo): Promise<Result<BridgeRoutes>> {
    const chains = CHAINS[network];
    const held = await Promise.all(chains.map((x) => withTimeout(heldOn(network, account, x), BALANCE_TIMEOUT_MS).catch(() => null)));
    const inj = held[0]?.native ?? 0n;
    return {
      ok: true,
      result: {
        chains: chains.map((x, i): BridgeEnd => ({
          key: x.key,
          name: x.name,
          kind: x.kind,
          address: account.addresses[x.caip2] ?? "",
          usdc: held[i] ? held[i]!.usdc.toString() : null,
          native: held[i] ? held[i]!.native.toString() : null,
          symbol: x.native.symbol,
          decimals: x.native.decimals,
          fast: x.fast,
          forwarding: x.forwarding,
        })),
        gasDrop: BRIDGE_RECEIVER[network] !== undefined,
        inj: inj.toString(),
      },
    };
  }

  /** Who delivers a transfer to `to`: Circle where it forwards; on Injective, Choice's
   *  contract with a gas drop, or else anyone; elsewhere whoever claims it. */
  function deliveryTo(to: ChainInfo, gasDrop: boolean): Delivery {
    if (to.kind === "injective") return gasDrop ? "gas_drop" : "anyone";
    return to.forwarding ? "circle" : "anyone";
  }

  /** The recipient as the burn names it (and whether a Solana one needs its USDC account
   *  opened), or why it can't be one. */
  async function recipientFor(to: ChainInfo, typed: string): Promise<Result<{ recipient: string; setup: boolean }>> {
    const s = typed.trim();
    if (to.kind !== "solana") {
      const checksummed = /^0x[0-9a-fA-F]{40}$/.test(s) ? toEvmAddress(s) : null;
      if (!checksummed) return fail("bad_recipient", `Enter a 0x address on ${to.name}.`);
      // Mixed case is a checksum; one that doesn't match is a typo.
      if (s !== s.toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase() && s !== checksummed) return fail("bad_recipient", "That address has a typo: its capital letters don't match.");
      return { ok: true, result: { recipient: checksummed, setup: false } };
    }
    let check;
    try {
      check = await checkSolanaRecipient(to.rpc, s, to.usdc, c.plainFetch);
    } catch {
      return fail("unreachable", "Couldn't check that Solana address. Try again.");
    }
    if (!check.ok) {
      const why = { not_an_address: "That isn't a Solana address.", token_account: "That's a USDC account. Enter the wallet address it belongs to.", not_a_wallet: "That Solana address isn't a wallet." }[check.reason];
      return fail("bad_recipient", why ?? "That Solana address can't receive USDC.");
    }
    return { ok: true, result: { recipient: s, setup: !check.tokenAccountExists } };
  }

  /** Circle's fees for the route, as injective-usdc-bridge's quoteTransfer works them out:
   *  Fast where the source offers it (its fee plus a fifth for headroom), the forwarding fee
   *  where Circle delivers, and the gas drop's. */
  async function ask(network: NetworkId, from: ChainInfo, to: ChainInfo, amount: bigint, o: { delivery: Delivery; setup: boolean; dropFee: bigint }): Promise<Result<{ maxFee: bigint; minReceived: bigint; fast: boolean }>> {
    const forward = o.delivery === "circle";
    let tiers;
    try {
      tiers = await c.iris(network).getFees(from.domain, to.domain, { forward, recipientSetup: o.setup });
    } catch {
      return fail("unreachable", "Couldn't reach Circle for its fee. Try again.");
    }
    const threshold = from.fast ? FINALITY.fast : FINALITY.standard;
    const tier = tiers.find((t) => t.finalityThreshold === threshold) ?? tiers.find((t) => t.finalityThreshold === FINALITY.standard);
    if (!tier) return fail("unreachable", "Circle gave no fee for that route.");
    const fast = tier.finalityThreshold === FINALITY.fast;
    const raw = fast ? bpsFee(amount, tier.minimumFee) : 0n;
    const protocol = raw === 0n ? 0n : raw + (raw * 20n + 99n) / 100n;
    let forwarding = 0n;
    if (forward) {
      if (!tier.forwardFee) return fail("unreachable", "Circle gave no delivery fee for that route.");
      forwarding = BigInt(tier.forwardFee.med);
    }
    const maxFee = protocol + forwarding;
    if (amount <= maxFee + o.dropFee) return fail("bridge_amount", "That's not enough to cover the fees.");
    return { ok: true, result: { maxFee, minReceived: amount - maxFee - o.dropFee, fast } };
  }

  /** Gas prices on an EVM chain, and the most a step's Ethereum data fee can be there. */
  async function feesOn(network: NetworkId, chain: ChainInfo): Promise<{ base: bigint; tip: bigint; data: bigint }> {
    const rpc = chain.kind === "injective" ? await sender.evm(network) : await sender.chainRpc(network, chain.key);
    const [block, tip] = await Promise.all([rpc.call("eth_getBlockByNumber", ["latest", false]), rpc.call("eth_maxPriorityFeePerGas", []).catch(() => "0x0")]);
    const base = block && typeof block === "object" ? hexAmount((block as Record<string, unknown>)["baseFeePerGas"]) : 0n;
    const data = chain.kind === "evm" ? await dataFeeBound(rpc, sourceOfChain(chain), STEP_BYTES) : 0n;
    return { base, tip: hexAmount(tip), data };
  }

  /** The USDC allowance TokenMessengerV2 has from the account on an EVM chain. */
  async function allowanceOn(network: NetworkId, chain: ChainInfo, me: string): Promise<bigint> {
    const rpc = chain.kind === "injective" ? await sender.evm(network) : await sender.chainRpc(network, chain.key);
    return hexAmount(await rpc.call("eth_call", [{ to: chain.usdc, data: `0xdd62ed3e${word(me)}${word(CCTP_CONTRACTS[network].tokenMessenger)}` }, "latest"]));
  }

  async function quote(network: NetworkId, account: AccountInfo, req: { from?: unknown; to?: unknown; amount?: unknown; recipient?: unknown; gasDrop?: unknown }): Promise<Result<BridgeQuote>> {
    const from = cctpChain(network, req.from);
    const to = cctpChain(network, req.to);
    if (!from || !to) return fail("bad_request", "Pick both chains.");
    if (from.key === to.key) return fail("bad_request", "Pick another chain to bridge to.");
    const me = account.addresses[from.caip2];
    if (!me) return fail("bad_request", `This account has no address on ${from.name}.`);
    if (typeof req.recipient !== "string") return fail("bad_recipient", "Enter who receives it.");
    const r = await recipientFor(to, req.recipient);
    if (!r.ok) return r;
    const held = await heldOn(network, account, from);
    if (!held) return fail("unreachable", `Couldn't reach ${from.name}. Try again.`);
    let amount: bigint;
    if (req.amount === "max") amount = from.gasIsUsdc ? held.usdc - ARC_GAS_RESERVE : held.usdc;
    else if (typeof req.amount === "string" && /^[0-9]{1,30}$/.test(req.amount)) amount = BigInt(req.amount);
    else return fail("invalid_amount", "Enter an amount above zero.");
    if (amount <= 0n) return fail("invalid_amount", held.usdc === 0n ? `This account has no USDC on ${from.name}.` : "Enter an amount above zero.");
    if (amount > held.usdc) return fail("insufficient", `That's more USDC than you have on ${from.name}.`);
    const wantDrop = req.gasDrop === true && to.kind === "injective";
    let drop: { wei: bigint; fee: bigint } | null = null;
    if (wantDrop) {
      try {
        drop = await gasDropOffer(network);
      } catch (e) {
        return sender.chainFailure(e);
      }
      if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now.");
    }
    const delivery = deliveryTo(to, drop !== null);
    const q = await ask(network, from, to, amount, { delivery, setup: r.result.setup, dropFee: drop?.fee ?? 0n });
    if (!q.ok) return q;
    // What signing there costs, in its coin.
    let steps: BridgeStep[] = ["burn"];
    let gasNeed: bigint;
    try {
      if (from.kind === "solana") {
        gasNeed = (await (await solana!.rpc(network)).rentExempt(recordSize(drop ? 96 : delivery === "circle" ? (r.result.setup ? 65 : 32) : 0))) + SOLANA_FEES;
      } else {
        const [fees, allowed] = await Promise.all([feesOn(network, from), allowanceOn(network, from, me)]);
        if (allowed < amount) steps = ["approve", "burn"];
        gasNeed = ((steps.length > 1 ? APPROVE_GAS : 0n) + BURN_GAS) * (fees.base * 2n + fees.tip) + BigInt(steps.length) * fees.data;
      }
    } catch {
      return fail("unreachable", `Couldn't reach ${from.name}. Try again.`);
    }
    const own = Object.values(account.addresses).some((a) => same(a, r.result.recipient));
    const stored: Stored = {
      id: randomId(),
      network,
      from: from.key,
      to: to.key,
      account: me,
      recipient: r.result.recipient,
      amount: amount.toString(),
      maxFee: q.result.maxFee.toString(),
      gasDropFee: (drop?.fee ?? 0n).toString(),
      dropWei: (drop?.wei ?? 0n).toString(),
      minReceived: q.result.minReceived.toString(),
      recipientSetup: r.result.setup,
      fast: q.result.fast,
      delivery,
      at: now(),
    };
    await session.set({ bridge_quote: stored });
    return {
      ok: true,
      result: {
        id: stored.id,
        from: from.key,
        fromName: from.name,
        to: to.key,
        toName: to.name,
        recipient: stored.recipient,
        own,
        amount: stored.amount,
        maxFee: stored.maxFee,
        gasDropFee: stored.gasDropFee,
        gasDropInj: stored.dropWei,
        minReceived: stored.minReceived,
        recipientSetup: stored.recipientSetup,
        fast: stored.fast,
        etaMs: expectedAttestMs(network, from.domain, stored.fast ? FINALITY.fast : FINALITY.standard),
        steps,
        delivery,
        gasNeed: gasNeed.toString(),
        // On Arc the burn's USDC leaves the same balance its fee is paid from.
        gasHeld: (from.gasIsUsdc ? held.native - amount * 10n ** 12n : held.native).toString(),
        gasSymbol: from.native.symbol,
        gasDecimals: from.native.decimals,
      },
    };
  }

  /** The burn's mint recipient, destination caller and hook, as bytes32/hex. */
  function burnFields(network: NetworkId, s: Stored, to: ChainInfo): { mintRecipient: `0x${string}`; destinationCaller: `0x${string}`; hook: `0x${string}` | undefined } {
    const zero = `0x${"0".repeat(64)}` as const;
    if (s.delivery === "gas_drop") {
      const receiver = addressToBytes32(BRIDGE_RECEIVER[network]!);
      return { mintRecipient: receiver, destinationCaller: receiver, hook: encodeGasDropHook(s.recipient as `0x${string}`, BigInt(s.gasDropFee)) };
    }
    if (to.kind === "solana") {
      const owner = solanaToBytes32(s.recipient);
      return { mintRecipient: solanaToBytes32(associatedTokenAddress(s.recipient, to.usdc)), destinationCaller: zero, hook: s.recipientSetup ? forwardHookDataWithAccountSetup(owner) : FORWARD_HOOK_DATA };
    }
    return { mintRecipient: addressToBytes32(s.recipient as `0x${string}`), destinationCaller: zero, hook: s.delivery === "circle" ? FORWARD_HOOK_DATA : undefined };
  }

  /** The next step of the stored quote, ready to review, on the chain the USDC is on. */
  async function prepare(network: NetworkId, account: AccountInfo, id: unknown): Promise<Result<SendReview>> {
    const { bridge_quote } = await session.get(["bridge_quote"]);
    const s = bridge_quote as Stored | undefined;
    const from = s ? cctpChain(network, s.from) : undefined;
    const to = s ? cctpChain(network, s.to) : undefined;
    const me = from ? account.addresses[from.caip2] : undefined;
    if (!s || s.id !== id || s.network !== network || !from || !to || !me || !same(s.account, me)) return fail("not_found", "This quote is gone. Get a new one.");
    const amount = BigInt(s.amount);
    const held = await heldOn(network, account, from);
    if (!held) return fail("unreachable", `Couldn't reach ${from.name}. Try again.`);
    if (held.usdc < amount) return fail("insufficient", `That's more USDC than you have on ${from.name}.`);
    let step: BridgeStep = "burn";
    let left = 0;
    if (from.kind !== "solana") {
      let allowed: bigint;
      try {
        allowed = await allowanceOn(network, from, me);
      } catch (e) {
        return sender.chainFailure(e);
      }
      if (allowed < amount) [step, left] = ["approve", 1];
    }
    // The fees are asked again before the burn if the quote aged (an approval doesn't depend
    // on them); the review shows the new most before anything is signed.
    if (step === "burn" && now() - s.at > BRIDGE_QUOTE_TTL_MS) {
      let dropFee = 0n;
      if (s.delivery === "gas_drop") {
        const drop = await gasDropOffer(network).catch(() => null);
        if (!drop) return fail("gas_drop", "The INJ top-up isn't available right now. Get a new quote.");
        dropFee = drop.fee;
        s.dropWei = drop.wei.toString();
        s.gasDropFee = drop.fee.toString();
      }
      const q = await ask(network, from, to, amount, { delivery: s.delivery, setup: s.recipientSetup, dropFee });
      if (!q.ok) return q;
      s.maxFee = q.result.maxFee.toString();
      s.minReceived = q.result.minReceived.toString();
      s.fast = q.result.fast;
      s.at = now();
      await session.set({ bridge_quote: s });
    }
    const usdcKey = from.kind === "injective" ? `erc20:${from.usdc}` : from.kind === "solana" ? `spl:${from.usdc}` : `usdc:${from.caip2}`;
    const arriving = to.kind === "injective" ? `erc20:${to.usdc}` : to.kind === "solana" ? `spl:${to.usdc}` : `usdc:${to.caip2}`;
    const info: BridgeStepInfo = {
      step,
      left,
      from: from.name,
      to: to.name,
      fromKey: from.key,
      toKey: to.key,
      recipient: s.recipient,
      amount: s.amount,
      maxFee: s.maxFee,
      gasDropFee: s.gasDropFee,
      gasDropInj: s.dropWei,
      minReceived: s.minReceived,
      usdc: usdcKey,
      arriving,
      delivery: s.delivery,
    };
    const extra = { bridge: info } satisfies Partial<SendReview>;
    const tm = CCTP_CONTRACTS[network].tokenMessenger;
    const transfer = { to: to.key, amount: s.amount, account: me, recipient: s.recipient };
    if (step === "approve") {
      const expect = (d: EvmDisplayLike) => (d.call["type"] === "approve" && same(String(d.call["spender"]), tm) && d.call["amount"] === s.amount && same(d.to, from.usdc) ? null : "The approval isn't the one asked for.");
      if (from.kind === "injective") return sender.prepareEvmCall(network, account, { to: from.usdc, amount, call: { type: "bridge_approve" }, tokens: [usdcKey], extra, expect });
      return sender.prepareSourceCall(network, account, sourceOfChain(from), { to: from.usdc, amount, call: { type: "bridge_approve" }, usdcHeld: held.usdc, burns: 0n, extra, expect });
    }
    if (s.delivery === "gas_drop" && !BRIDGE_RECEIVER[network]) return fail("gas_drop", "The INJ top-up isn't available on this network.");
    const f = burnFields(network, s, to);
    const threshold = s.fast ? FINALITY.fast : FINALITY.standard;
    if (from.kind === "solana") return prepareSolana(network, account, s, from, to, held, f, threshold, info, transfer);
    const data = burnCall({ amount, destinationDomain: to.domain, mintRecipient: f.mintRecipient, burnToken: from.usdc as `0x${string}`, destinationCaller: f.destinationCaller, maxFee: BigInt(s.maxFee), minFinalityThreshold: threshold, ...(f.hook ? { hookData: f.hook } : {}) });
    const expect = (d: EvmDisplayLike) => matchesQuote(d.call, s, to, "evm");
    if (from.kind === "injective") return sender.prepareEvmCall(network, account, { to: tm, amount: 0n, call: { type: "bridge", data }, tokens: [usdcKey], extra, expect, deposit: transfer });
    return sender.prepareSourceCall(network, account, sourceOfChain(from), { to: tm, amount: 0n, call: { type: "bridge", data }, usdcHeld: held.usdc, burns: amount, extra, deposit: transfer, expect });
  }

  /** The burn on Solana: a one-off key makes the burn's record; it signs after the vault, and
   *  holds nothing. */
  async function prepareSolana(
    network: NetworkId,
    account: AccountInfo,
    s: Stored,
    from: ChainInfo,
    to: ChainInfo,
    held: { usdc: bigint; native: bigint },
    f: ReturnType<typeof burnFields>,
    threshold: number,
    info: BridgeStepInfo,
    transfer: { to: string; amount: string; account: string; recipient: string },
  ): Promise<Result<SendReview>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return fail("bad_request", "This account has no Solana address.");
    const key = ed25519.utils.randomPrivateKey();
    const event = bytesToBase58(ed25519.getPublicKey(key));
    const burn = depositForBurnInstruction({
      owner,
      mint: from.usdc,
      messageSentEventData: event,
      args: { amount: BigInt(s.amount), destinationDomain: to.domain, mintRecipient: f.mintRecipient, destinationCaller: f.destinationCaller, maxFee: BigInt(s.maxFee), minFinalityThreshold: threshold, ...(f.hook ? { hookData: f.hook } : {}) },
    });
    const usdcKey = `spl:${from.usdc}`;
    return solana.prepareInstructions(network, account, {
      instructions: [burn],
      priorityAccounts: [from.usdc, findProgramAddress([new TextEncoder().encode("message_transmitter")], SOLANA_MESSAGE_TRANSMITTER_V2)],
      recipient: null,
      balances: { native: held.native.toString(), [from.usdc]: held.usdc.toString() },
      tokens: {
        sol: { denom: "sol", symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: from.caip2 },
        [usdcKey]: { denom: usdcKey, symbol: "USDC", name: `USDC on ${from.name}`, decimals: 6, known: true, chain: from.caip2 },
      },
      cosigner: key,
      deposit: { ...transfer, event, owner },
      extra: { bridge: info },
      expect: (d) => {
        const steps = Array.isArray(d["instructions"]) ? (d["instructions"] as Record<string, unknown>[]) : [];
        const burns = steps.filter((x) => x["type"] === "bridge");
        if (burns.length !== 1 || steps.some((x) => x["type"] === "program" || x["type"] === "unreadable")) return "The transfer isn't one the wallet can read.";
        if (burns[0]!["usdc"] !== true || burns[0]!["owner"] !== owner) return "The transfer doesn't spend this account's USDC.";
        return matchesQuote(burns[0]!, s, to, "solana");
      },
    });
  }

  /** A burn was broadcast: follow it until it lands. A burn on Solana also leaves a record
   *  whose rent the account takes back later. */
  async function track(network: NetworkId, t: { chain: string; to?: string; hash: string; amount: string; account: string; recipient?: string; event?: string; owner?: string }): Promise<void> {
    const list = (await tracked()).filter((x) => x.hash !== t.hash && now() - x.at < TRACK_MS);
    list.unshift({ network, from: t.chain, to: t.to ?? "injective", hash: t.hash, amount: t.amount, account: t.account, recipient: t.recipient ?? t.account, at: now() });
    await local.set({ bridge_transfers: list.slice(0, MAX_TRACKED) });
    if (t.chain === "solana" && t.event && t.owner) {
      const records = (await c.rentRecords()).filter((r) => r.event !== t.event);
      records.unshift({ network, hash: t.hash, event: t.event, owner: t.owner, at: now() });
      await local.set({ solana_rent: records.slice(0, 50) });
    }
  }

  async function tracked(): Promise<Transfer[]> {
    const { bridge_transfers } = await local.get(["bridge_transfers"]);
    return Array.isArray(bridge_transfers) ? (bridge_transfers as Transfer[]) : [];
  }

  async function forget(hash: string): Promise<void> {
    const list = await tracked();
    if (list.some((t) => t.hash === hash)) await local.set({ bridge_transfers: list.filter((t) => t.hash !== hash) });
  }

  /** Transfers this account sent that haven't landed, newest first. */
  async function pending(network: NetworkId, account: AccountInfo): Promise<Result<BridgePending[]>> {
    const mine = new Set(Object.values(account.addresses).map((a) => a.toLowerCase()));
    const name = (k: string) => cctpChain(network, k)?.name;
    return {
      ok: true,
      result: (await tracked())
        .filter((t) => t.network === network && mine.has(t.account.toLowerCase()) && now() - t.at < TRACK_MS && name(t.from) && name(t.to))
        .map((t) => ({ from: t.from, fromName: name(t.from)!, to: t.to, toName: name(t.to)!, hash: t.hash, amount: t.amount, at: t.at })),
    };
  }

  /** Iris' message for a burn on `from` (none yet: null). */
  async function attested(network: NetworkId, req: { from?: unknown; hash?: unknown }): Promise<Result<{ from: ChainInfo; hash: string; m: IrisMessage | null }>> {
    const from = cctpChain(network, req.from);
    if (!from) return fail("bad_request", "Not a chain the wallet knows.");
    // A Solana transaction is named by its signature (base58), an EVM one by its 0x hash.
    const hash = typeof req.hash !== "string" ? "" : from.kind === "solana" ? req.hash : req.hash.toLowerCase();
    if (from.kind === "solana" ? !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash) : !/^0x[0-9a-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    let messages: IrisMessage[];
    try {
      messages = await c.iris(network).getMessages(from.domain, hash as `0x${string}`);
    } catch {
      return fail("unreachable", "Couldn't reach Circle. Try again.");
    }
    // A transaction with several messages would be someone else's batch: the one going
    // where the wallet sent it counts.
    const t = (await tracked()).find((x) => x.hash === hash);
    const toDomain = t ? cctpChain(network, t.to)?.domain : undefined;
    const m = messages.find((x) => toDomain === undefined || x.decodedMessage?.destinationDomain === undefined || String(x.decodedMessage.destinationDomain) === String(toDomain)) ?? null;
    return { ok: true, result: { from, hash, m } };
  }

  /** The chain a message goes to, as the wallet's list names it. */
  function destinationOf(network: NetworkId, m: IrisMessage): ChainInfo | undefined {
    let domain: number | undefined;
    try {
      domain = decodeMessage(m.message as `0x${string}`).destinationDomain;
    } catch {
      domain = Number(m.decodedMessage?.destinationDomain);
      if (!Number.isSafeInteger(domain)) return undefined;
    }
    return CHAINS[network].find((x) => x.domain === domain);
  }

  /** Whether a destination EVM chain's MessageTransmitterV2 has used this nonce. */
  async function nonceUsed(network: NetworkId, to: ChainInfo, nonce: string): Promise<boolean> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("Circle gave no nonce");
    const rpc = to.kind === "injective" ? await sender.evm(network) : await sender.chainRpc(network, to.key);
    return hexAmount(await rpc.call("eth_call", [{ to: CCTP_CONTRACTS[network].messageTransmitter, data: `0xfeb61724${nonce.slice(2)}` }, "latest"])) !== 0n;
  }

  /** Where a transfer is: Circle saw the burn, attested it, delivered it (or someone minted
   *  it); and whether this account can mint it itself. */
  async function status(network: NetworkId, account: AccountInfo, req: { from?: unknown; hash?: unknown }): Promise<Result<BridgeStatus>> {
    const found = await attested(network, req);
    if (!found.ok) return found;
    const { from, hash, m } = found.result;
    const t = (await tracked()).find((x) => x.hash === hash);
    const base = { track: `${TRACK_URL}/${from.domain}/${hash}`, selfMint: false, etaMs: expectedAttestMs(network, from.domain, FINALITY.fast), to: t?.to ?? "" };
    if (!m) return { ok: true, result: { ...base, phase: "pending" } };
    if (m.status !== "complete" || m.attestation === "PENDING" || m.message === "0x") return { ok: true, result: { ...base, phase: "attesting" } };
    const to = destinationOf(network, m);
    if (!to) return { ok: true, result: { ...base, phase: "delivering" } };
    const at = { ...base, to: to.key };
    if (m.forwardState === "CONFIRMED" && m.forwardTxHash) {
      await forget(hash);
      // Circle's word for the mint goes into a link only if it has the form of a hash there.
      const form = to.kind === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/ : /^0x[0-9a-fA-F]{64}$/;
      const tx = typeof m.forwardTxHash === "string" && form.test(m.forwardTxHash) ? m.forwardTxHash : null;
      return { ok: true, result: { ...at, phase: "delivered", ...(tx ? { mintTx: tx, mintUrl: to.explorerTx.replace("{hash}", tx) } : {}) } };
    }
    // Solana's mint is Circle's to make here; on an EVM chain the nonce says if anyone did.
    if (to.kind === "solana") return { ok: true, result: { ...at, phase: m.forwardState === "FAILED" ? "stuck" : "delivering" } };
    let used: boolean;
    try {
      used = await nonceUsed(network, to, m.eventNonce);
    } catch (e) {
      return sender.chainFailure(e);
    }
    if (used) {
      await forget(hash);
      return { ok: true, result: { ...at, phase: "delivered" } };
    }
    const anyone = permissionless(m.message);
    const mine = anyone && Boolean(account.addresses[to.caip2]);
    if (m.forwardState === "FAILED") return { ok: true, result: { ...at, phase: "stuck", selfMint: mine } };
    // Circle is still to deliver it (or forwarding wasn't asked: anyone may mint it).
    if (m.forwardState && m.forwardState !== "FAILED") return { ok: true, result: { ...at, phase: "delivering" } };
    return { ok: true, result: { ...at, phase: "ready", selfMint: mine } };
  }

  /** The mint of an attested transfer on its destination, from this account, when nobody
   *  has (Choice's service didn't, or Circle doesn't deliver there). It costs gas there. */
  async function prepareReceive(network: NetworkId, account: AccountInfo, req: { from?: unknown; hash?: unknown }): Promise<Result<SendReview>> {
    const found = await attested(network, req);
    if (!found.ok) return found;
    const { from, m } = found.result;
    if (!m || m.status !== "complete" || m.attestation === "PENDING") return fail("not_ready", "Circle hasn't confirmed it yet.");
    const to = destinationOf(network, m);
    if (!to || to.kind === "solana") return fail("bad_request", "The wallet can't complete a transfer there.");
    const me = account.addresses[to.caip2];
    if (!me) return fail("bad_request", `This account has no address on ${to.name}.`);
    if (!permissionless(m.message)) return fail("not_yours", "Only Choice's bridge contract can complete this one.");
    let body;
    try {
      body = decodeBurnMessage(decodeMessage(m.message as `0x${string}`).body);
    } catch {
      return fail("bad_request", "Circle's message can't be read.");
    }
    const arriving = to.kind === "injective" ? `erc20:${to.usdc}` : `usdc:${to.caip2}`;
    const info: BridgeStepInfo = {
      step: "receive",
      left: 0,
      from: from.name,
      to: to.name,
      fromKey: from.key,
      toKey: to.key,
      recipient: body.mintRecipient,
      amount: body.amount.toString(),
      maxFee: body.maxFee.toString(),
      gasDropFee: "0",
      gasDropInj: "0",
      minReceived: (body.amount - body.feeExecuted).toString(),
      usdc: arriving,
      arriving,
      delivery: "anyone",
    };
    const call = { type: "bridge_receive", message: m.message, attestation: m.attestation };
    const expect = (d: EvmDisplayLike) => (d.call["type"] === "bridge_receive" && d.call["chain"] === from.name && d.call["to_here"] === true ? null : "The mint isn't the one asked for.");
    const mt = CCTP_CONTRACTS[network].messageTransmitter;
    if (to.kind === "injective") return sender.prepareEvmCall(network, account, { to: mt, amount: 0n, call, gasHint: RECEIVE_GAS, tokens: [arriving], extra: { bridge: info }, expect });
    return sender.prepareSourceCall(network, account, sourceOfChain(to), { to: mt, amount: 0n, call, extra: { bridge: info }, expect });
  }

  return { routes, quote, prepare, track, pending, status, prepareReceive };
}

/** Whether an attested message may be minted by anyone. */
function permissionless(message: string): boolean {
  try {
    return /^0x0{64}$/.test(decodeMessage(message as `0x${string}`).destinationCaller);
  } catch {
    return false;
  }
}

/** The vault's reading of a burn (an EVM call's, or a Solana instruction's) against the quote
 *  the user saw: where it goes, how much, Circle's most, who receives it, who delivers. */
function matchesQuote(c: Record<string, unknown>, s: Stored, to: ChainInfo, side: "evm" | "solana"): string | null {
  if (c["type"] !== "bridge" || c["domain"] !== to.domain) return "The transfer goes somewhere other than its quote.";
  if (c["amount"] !== s.amount || c["max_fee"] !== s.maxFee) return "The transfer doesn't match its quote.";
  const expected = to.kind === "solana" ? associatedTokenAddress(s.recipient, to.usdc) : s.recipient;
  if (typeof c["recipient"] !== "string" || !same(c["recipient"], expected)) return "The transfer pays someone else.";
  if (to.kind === "solana" && s.recipientSetup && c["account_owner"] !== undefined && c["account_owner"] !== s.recipient) return "The transfer opens an account for someone else.";
  // How each side's reading names who delivers.
  const delivery = { circle: "circle", anyone: side === "evm" ? "claim" : "anyone", gas_drop: "gas_drop" }[s.delivery];
  if (c["delivery"] !== delivery) return "The transfer isn't delivered the way its quote said.";
  if (s.delivery === "gas_drop" && c["max_drop_fee"] !== s.gasDropFee) return "The INJ top-up doesn't match its quote.";
  return null;
}

export type { SourceChain };
