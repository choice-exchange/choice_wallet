// Native USDC from Injective to other chains, over Circle's CCTP, with injective-usdc-bridge.
//
// 1. Routes: the chains Circle delivers to from Injective (the package's registry).
// 2. Quote: Circle's fees from Iris (`quoteTransfer`), for this amount and destination, and
//    the recipient checked: a 0x address on EVM chains (this account's own by default, the
//    same key), or a Solana wallet, whose USDC account Circle opens if it has none. The
//    quote waits in session storage.
// 3. Steps, each reviewed and confirmed like a send:
//    - `approve`: TokenMessengerV2 may take exactly this amount of USDC (when it can't yet);
//    - `burn`: the package's calldata, which the vault reads and builds only as a USDC burn
//      to a chain it names, delivered by Circle, to a usable address (vault `cctp`). The
//      vault's reading is then held to the quote the user saw.
//    After each step lands, the UI asks for the next one.
// 4. Status: Circle's attestation service (Iris) says when the burn is attested and when its
//    Forwarding Service minted on the destination.
//
// Circle learns the burn (it is on chain anyway); for a Solana recipient the package's
// Solana RPC is asked whether the wallet already has a USDC account.
//
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

import { bytesToBase58, NETWORKS, word, type Fetch, type NetworkId } from "@choice-wallet/chain";
import { ed25519 } from "@noble/curves/ed25519";
import type { AccountInfo, BridgeInBalance, BridgeInPending, BridgeInQuote, BridgeInRoutes, BridgeInStatus, BridgeQuote, BridgeRoutes, BridgeStatus, BridgeStep, Result, SendReview } from "@choice-wallet/ui/protocol";
import {
  BRIDGE_RECEIVER,
  CCTP_CONTRACTS,
  INJECTIVE_DOMAIN,
  IrisClient,
  RouteError,
  associatedTokenAddress,
  buildBurn,
  bytes32ToAddress,
  bytes32ToSolana,
  chainByDomain,
  chainByKey,
  checkSolanaRecipient,
  depositForBurnInstruction,
  encodeGasDropHook,
  findProgramAddress,
  reclaimEventAccountInstruction,
  EVENT_ACCOUNT_REFUND_DELAY_SEC,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  type SolanaChain,
  decodeBurnMessage,
  decodeMessage,
  expectedAttestMs,
  explorerTxUrl,
  injective,
  peers,
  quoteTransfer,
  toEvmAddress,
  type Chain,
  type EvmChain,
  type IrisMessage,
  type Quote,
} from "injective-usdc-bridge";

import { dataFeeBound, sourceUsdc, type createSender, type DepositSent, type EvmDisplayLike, type SourceChain } from "./send";
import type { Store } from "./service";
import type { createSolana } from "./solana";

type Sender = ReturnType<typeof createSender>;
type Solana = ReturnType<typeof createSolana>;

/** Solana as a chain USDC comes from (the account's Solana key signs there). */
export const SOLANA_KEY = "solana";
/** The burn's record on Solana: discriminator, rent payer, created at, then the message
 *  (148-byte header, 228-byte body, the hook) behind its length. Its rent comes back after
 *  Circle's delay (EVENT_ACCOUNT_REFUND_DELAY_SEC, 5 days). */
const recordSize = (hook: number) => 8 + 32 + 8 + 4 + 148 + 228 + hook;

/** Solana as the package names it: its registry's on mainnet; devnet, which the registry
 *  doesn't list, beside testnet. */
export function solanaSource(network: NetworkId): SolanaChain {
  const listed = chainByKey(network, SOLANA_KEY);
  if (listed && listed.kind === "solana") return listed;
  const s = NETWORKS[network].solana;
  return { kind: "solana", key: SOLANA_KEY, name: s.name, domain: 5, rpcUrls: s.rpc, explorerTx: s.explorerTx, fastSource: true, forwarding: true, usdcMint: s.usdcMint, nativeSymbol: "SOL" };
}

/** A quote older than this is asked for again: Circle's forwarding fee moves with gas. */
export const BRIDGE_QUOTE_TTL_MS = 120_000;
/** Where anyone can follow a transfer, and claim it if Circle never delivers. */
export const TRACK_URL = "https://bridge.choice.exchange/tx";

const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What waits between the quote and its steps. Amounts are decimal strings. */
interface Stored {
  id: string;
  network: NetworkId;
  /** This account's 0x address, which signs. */
  account: string;
  chain: string;
  /** As the burn names it: a 0x address, or the Solana wallet. */
  recipient: string;
  amount: string;
  recipientSetup: boolean;
  maxFee: string;
  minReceived: string;
  at: number;
}

/** An Activity row's bridge transfer, named: the destination chain, and the recipient as it
 *  spells addresses (for Solana, the USDC account the burn names). */
export function bridgeLabel(network: NetworkId, domain: number, mintRecipient: string): { chain?: string; recipient?: string } {
  const c = chainByDomain(network, domain);
  if (!c || c.domain === INJECTIVE_DOMAIN) return {};
  try {
    const r = mintRecipient as `0x${string}`;
    return { chain: c.name, recipient: c.kind === "solana" ? bytes32ToSolana(r) : bytes32ToAddress(r) };
  } catch {
    return { chain: c.name };
  }
}

/** The chains a wallet transfer can go to: Circle must deliver there (the wallet never
 *  leaves a transfer for someone to claim). */
export function bridgeChains(network: NetworkId): Chain[] {
  return peers(network).filter((c) => c.forwarding);
}

export function createBridge(sender: Sender, session: Store, local: Store, fetch: Fetch, now: () => number = Date.now, solana?: Solana) {
  // The package adds a user-agent outside pages (Circle's CDN refuses some servers' own); a
  // service worker's fetch would make it a CORS preflight, which Iris doesn't answer.
  const plainFetch = ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("user-agent");
    return fetch(url, { ...init, headers });
  }) as typeof globalThis.fetch;
  const iris = (network: NetworkId) => new IrisClient({ network, fetch: plainFetch });

  /** USDC's wallet key on this network (its bank denom), and the account's balance of it and
   *  of INJ. */
  async function usdc(network: NetworkId, account: AccountInfo): Promise<Result<{ denom: string; balance: bigint; inj: bigint }>> {
    const token = injective(network).usdc;
    const held = await sender.balances(network, account);
    if (!held.ok) return held;
    const b = held.result.balances.find((x) => same(x.denom, `erc20:${token}`) || same(x.denom, `evm:${token}`));
    const inj = held.result.balances.find((x) => x.denom === "inj");
    return { ok: true, result: { denom: b?.denom ?? `erc20:${token}`, balance: BigInt(b?.amount ?? "0"), inj: BigInt(inj?.amount ?? "0") } };
  }

  async function routes(network: NetworkId, account: AccountInfo): Promise<Result<BridgeRoutes>> {
    const u = await usdc(network, account);
    if (!u.ok) return u;
    return {
      ok: true,
      result: {
        chains: bridgeChains(network).map((c) => ({ key: c.key, name: c.name, kind: c.kind })),
        usdc: u.result.denom,
        balance: u.result.balance.toString(),
        address: account.addresses[NETWORKS[network].evm] ?? "",
      },
    };
  }

  /** The recipient as the burn names it, or why it can't be one. */
  async function recipientFor(chain: Chain, typed: string): Promise<Result<{ recipient: string; setup: boolean }>> {
    const s = typed.trim();
    if (chain.kind === "evm") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return fail("bad_recipient", `Enter a 0x address on ${chain.name}.`);
      const checksummed = toEvmAddress(s);
      if (!checksummed) return fail("bad_recipient", `Enter a 0x address on ${chain.name}.`);
      // Mixed case is a checksum; one that doesn't match is a typo.
      if (s !== s.toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase() && s !== checksummed) return fail("bad_recipient", "That address has a typo: its capital letters don't match.");
      return { ok: true, result: { recipient: checksummed, setup: false } };
    }
    let check;
    try {
      check = await checkSolanaRecipient(chain.rpcUrls, s, chain.usdcMint, plainFetch);
    } catch {
      return fail("unreachable", "Couldn't check that Solana address. Try again.");
    }
    if (!check.ok) {
      const why = { not_an_address: "That isn't a Solana address.", token_account: "That's a USDC account. Enter the wallet address it belongs to.", not_a_wallet: "That Solana address isn't a wallet." }[check.reason];
      return fail("bad_recipient", why ?? "That Solana address can't receive USDC.");
    }
    return { ok: true, result: { recipient: s, setup: !check.tokenAccountExists } };
  }

  async function ask(network: NetworkId, chain: Chain, amount: bigint, setup: boolean): Promise<Result<Quote>> {
    try {
      const q = await quoteTransfer({ iris: iris(network), route: { source: injective(network), destination: chain }, amount, forward: true, recipientSetup: setup });
      return { ok: true, result: q };
    } catch (e) {
      if (e instanceof RouteError) return fail("bridge_amount", /does not cover fees/.test(e.message) ? "That's not enough to cover Circle's fee." : e.message);
      return fail("unreachable", "Couldn't reach Circle for its fee. Try again.");
    }
  }

  async function quote(network: NetworkId, account: AccountInfo, req: { to?: unknown; amount?: unknown; recipient?: unknown }): Promise<Result<BridgeQuote>> {
    const me = account.addresses[NETWORKS[network].evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    const chain = typeof req.to === "string" ? bridgeChains(network).find((c) => c.key === req.to) : undefined;
    if (!chain) return fail("bad_request", "Pick a chain to bridge to.");
    if (typeof req.recipient !== "string") return fail("bad_recipient", "Enter who receives it.");
    const r = await recipientFor(chain, req.recipient);
    if (!r.ok) return r;
    const u = await usdc(network, account);
    if (!u.ok) return u;
    let amount: bigint;
    if (req.amount === "max") amount = u.result.balance;
    else if (typeof req.amount === "string" && /^[0-9]{1,30}$/.test(req.amount)) amount = BigInt(req.amount);
    else return fail("invalid_amount", "Enter an amount above zero.");
    if (amount <= 0n) return fail("invalid_amount", u.result.balance === 0n ? "This account has no USDC." : "Enter an amount above zero.");
    if (amount > u.result.balance) return fail("insufficient", "That's more USDC than you have.");
    const q = await ask(network, chain, amount, r.result.setup);
    if (!q.ok) return q;
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const stored: Stored = {
      id,
      network,
      account: me,
      chain: chain.key,
      recipient: r.result.recipient,
      amount: amount.toString(),
      recipientSetup: r.result.setup,
      maxFee: q.result.maxFee.toString(),
      minReceived: q.result.minReceived.toString(),
      at: now(),
    };
    await session.set({ bridge_quote: stored });
    const steps = await stepsFor(network, stored);
    if (!steps.ok) return steps;
    return { ok: true, result: view(stored, chain, steps.result) };
  }

  function view(s: Stored, chain: Chain, steps: BridgeStep[]): BridgeQuote {
    return {
      id: s.id,
      chain: chain.key,
      chainName: chain.name,
      recipient: s.recipient,
      amount: s.amount,
      maxFee: s.maxFee,
      minReceived: s.minReceived,
      recipientSetup: s.recipientSetup,
      steps,
    };
  }

  /** What a stored quote still needs, in order. */
  async function stepsFor(network: NetworkId, s: Stored): Promise<Result<BridgeStep[]>> {
    try {
      const rpc = await sender.evm(network);
      const [allowed] = await rpc.erc20Allowances([{ token: injective(network).usdc, spender: tokenMessenger(network) }], s.account);
      return { ok: true, result: allowed === null || allowed === undefined || allowed < BigInt(s.amount) ? ["approve", "burn"] : ["burn"] };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** The next step of the stored quote, ready to review. */
  async function prepare(network: NetworkId, account: AccountInfo, id: unknown): Promise<Result<SendReview>> {
    const { bridge_quote } = await session.get(["bridge_quote"]);
    const s = bridge_quote as Stored | undefined;
    const me = account.addresses[NETWORKS[network].evm];
    const chain = s ? chainByKey(network, s.chain) : undefined;
    if (!s || s.id !== id || s.network !== network || !me || !same(s.account, me) || !chain) return fail("not_found", "This quote is gone. Get a new one.");
    const steps = await stepsFor(network, s);
    if (!steps.ok) return steps;
    const step = steps.result[0]!;
    // Circle's fee is asked again before the burn if the quote aged (approvals don't depend
    // on it); the review shows the new most before anything is signed.
    if (step === "burn" && now() - s.at > BRIDGE_QUOTE_TTL_MS) {
      const q = await ask(network, chain, BigInt(s.amount), s.recipientSetup);
      if (!q.ok) return q;
      s.maxFee = q.result.maxFee.toString();
      s.minReceived = q.result.minReceived.toString();
      s.at = now();
      await session.set({ bridge_quote: s });
    }
    const u = await usdc(network, account);
    if (!u.ok) return u;
    const amount = BigInt(s.amount);
    const extra = {
      bridge: { step, left: steps.result.length - 1, chain: chain.name, recipient: s.recipient, amount: s.amount, maxFee: s.maxFee, minReceived: s.minReceived, usdc: u.result.denom },
    } satisfies Partial<SendReview>;
    if (step === "approve") {
      return sender.prepareEvmCall(network, account, {
        to: injective(network).usdc,
        amount,
        call: { type: "bridge_approve" },
        tokens: [u.result.denom],
        extra,
        expect: (d) => (d.call["type"] === "approve" && same(String(d.call["spender"]), tokenMessenger(network)) && d.call["amount"] === s.amount ? null : "The approval isn't the one asked for."),
      });
    }
    // The quote as asked. Injective is never a fast source: its transfers attest at standard
    // finality, which there takes seconds.
    const quoted: Quote = {
      direction: "withdraw",
      amount,
      speed: "standard",
      minFinalityThreshold: 2000,
      protocolFee: 0n,
      forwardingFee: BigInt(s.maxFee),
      gasDropFee: 0n,
      bridgeFee: 0n,
      maxFee: BigInt(s.maxFee),
      minReceived: BigInt(s.minReceived),
      forwarded: true,
      recipientSetup: s.recipientSetup,
    };
    let data: string;
    try {
      const route = { source: injective(network), destination: chain };
      data = buildBurn({ network, route, quote: quoted, recipient: s.recipient, allowance: amount }).burn.data;
    } catch (e) {
      return fail("bad_request", e instanceof Error ? e.message : "Couldn't build the transfer.");
    }
    return sender.prepareEvmCall(network, account, {
      to: tokenMessenger(network),
      amount: 0n,
      call: { type: "bridge", data },
      tokens: [u.result.denom],
      extra,
      expect: (d) => matchesQuote(d, s, chain),
    });
  }

  /** Where a burn is: Iris has it, Circle attested it, Circle's mint landed. */
  async function status(network: NetworkId, hash: unknown): Promise<Result<BridgeStatus>> {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    const track = `${TRACK_URL}/${INJECTIVE_DOMAIN}/${hash}`;
    let messages;
    try {
      messages = await iris(network).getMessages(INJECTIVE_DOMAIN, hash as `0x${string}`);
    } catch {
      return fail("unreachable", "Couldn't reach Circle. Try again.");
    }
    const m = messages[0];
    if (!m) return { ok: true, result: { phase: "pending", track } };
    if (m.status !== "complete") return { ok: true, result: { phase: "attesting", track } };
    const dest = m.decodedMessage?.destinationDomain === undefined ? undefined : peers(network).find((c) => String(c.domain) === String(m.decodedMessage?.destinationDomain));
    if (m.forwardState === "CONFIRMED" && m.forwardTxHash) {
      return { ok: true, result: { phase: "delivered", track, mintTx: m.forwardTxHash, ...(dest ? { mintUrl: explorerTxUrl(dest, m.forwardTxHash) } : {}) } };
    }
    if (m.forwardState === "FAILED") return { ok: true, result: { phase: "stuck", track } };
    return { ok: true, result: { phase: "delivering", track } };
  }

  // ---- In: USDC from another EVM chain into this account on Injective ----

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

  /** The account's USDC and SOL on Solana. */
  async function solanaHeld(network: NetworkId, account: AccountInfo): Promise<{ usdc: bigint; native: bigint }> {
    const h = await solana!.holdings(network, account);
    if (!h || h.down) throw new Error("Solana didn't answer");
    const amount = (denom: string) => BigInt(h.balances.find((b) => b.denom === denom)?.amount ?? "0");
    return { usdc: amount(`spl:${NETWORKS[network].solana.usdcMint}`), native: amount("sol") };
  }

  /** BridgeReceiver's INJ top-up: how much INJ, for how much USDC, and whether it is on. */
  async function gasDropOffer(network: NetworkId): Promise<{ wei: bigint; fee: bigint } | null> {
    const receiver = BRIDGE_RECEIVER[network];
    if (!receiver) return null;
    const rpc = await sender.evm(network);
    const [wei, fee, paused] = await rpc.batch(["0x2806f1c2", "0xba3c944e", "0xa424e452"].map((data) => ({ method: "eth_call", params: [{ to: receiver, data }, "latest"] })));
    const n = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
    const [w, f, p] = [n(wei), n(fee), n(paused)];
    if (w === null || f === null || p === null || w === 0n || p !== 0n) return null;
    return { wei: w, fee: f };
  }

  async function askIn(network: NetworkId, source: EvmChain | SolanaChain, amount: bigint, gasDropFee: bigint): Promise<Result<Quote>> {
    try {
      const q = await quoteTransfer({ iris: iris(network), route: { source, destination: injective(network) }, amount, gasDropFee });
      return { ok: true, result: q };
    } catch (e) {
      if (e instanceof RouteError) return fail("bridge_amount", /does not cover fees/.test(e.message) ? "That's not enough to cover the fees." : e.message);
      return fail("unreachable", "Couldn't reach Circle for its fee. Try again.");
    }
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
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  /** A deposit's burn was broadcast: follow it until Injective mints it. */
  async function track(network: NetworkId, d: DepositSent): Promise<void> {
    const list = (await tracked()).filter((t) => t.hash !== d.hash && now() - t.at < TRACK_MS);
    list.unshift({ network, ...d, at: now() });
    await local.set({ bridge_in_pending: list.slice(0, MAX_TRACKED) });
    // A burn on Solana leaves a record whose rent the account takes back later.
    if (d.chain === SOLANA_KEY && d.event && d.owner) {
      const records = (await rentRecords()).filter((r) => r.event !== d.event);
      records.unshift({ network, hash: d.hash, event: d.event, owner: d.owner, at: now() });
      await local.set({ solana_rent: records.slice(0, 50) });
    }
  }

  async function rentRecords(): Promise<RentRecord[]> {
    const { solana_rent } = await local.get(["solana_rent"]);
    return Array.isArray(solana_rent) ? (solana_rent as RentRecord[]) : [];
  }

  async function tracked(): Promise<Tracked[]> {
    const { bridge_in_pending } = await local.get(["bridge_in_pending"]);
    return Array.isArray(bridge_in_pending) ? (bridge_in_pending as Tracked[]) : [];
  }

  async function forget(hash: string): Promise<void> {
    const list = await tracked();
    if (list.some((t) => t.hash === hash)) await local.set({ bridge_in_pending: list.filter((t) => t.hash !== hash) });
  }

  /** Iris' message for a deposit's burn (none yet: null). */
  async function attested(network: NetworkId, req: { chain?: unknown; hash?: unknown }): Promise<Result<{ chain: Pick<EvmChain, "key" | "name" | "domain">; hash: string; m: IrisMessage | null }>> {
    const chain = req.chain === SOLANA_KEY ? solanaSource(network) : typeof req.chain === "string" ? bridgeSources(network).find((c) => c.key === req.chain) : undefined;
    if (!chain) return fail("bad_request", "Not a chain USDC comes from.");
    // A Solana transaction is named by its signature (base58), an EVM one by its 0x hash.
    const hash = typeof req.hash !== "string" ? "" : chain.key === SOLANA_KEY ? req.hash : req.hash.toLowerCase();
    if (chain.key === SOLANA_KEY ? !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash) : !/^0x[0-9a-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    let messages: IrisMessage[];
    try {
      messages = await iris(network).getMessages(chain.domain, hash as `0x${string}`);
    } catch {
      return fail("unreachable", "Couldn't reach Circle. Try again.");
    }
    // Several messages in one transaction would be someone else's batch: only the one that
    // pays Injective counts.
    const m = messages.find((x) => x.decodedMessage?.destinationDomain === undefined || String(x.decodedMessage.destinationDomain) === String(INJECTIVE_DOMAIN)) ?? null;
    return { ok: true, result: { chain, hash, m } };
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
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  async function allowanceOn(source: SourceChain, network: NetworkId, me: string): Promise<bigint> {
    const r = await sender.sourceRpc(source).call("eth_call", [{ to: source.usdc, data: `0xdd62ed3e${word(me)}${word(tokenMessenger(network))}` }, "latest"]);
    return hexAmount(r);
  }

  return { routes, quote, prepare, status, inRoutes, inBalances, inQuote, prepareIn, inStatus, prepareReceive, inPending, track, reclaims, prepareReclaim, source: (network: NetworkId, key: unknown) => sourceByKey(network, key) };
}

/** A quote for bringing USDC in, between the quote and its steps. Amounts are decimal strings. */
interface StoredIn {
  id: string;
  network: NetworkId;
  account: string;
  chain: string;
  amount: string;
  maxFee: string;
  gasDropFee: string;
  /** INJ the top-up buys, in wei; "0" without one. */
  dropWei: string;
  minReceived: string;
  fast: boolean;
  at: number;
}

/** A burn on Solana whose record's rent comes back to `owner` (its Solana address). */
interface RentRecord {
  network: NetworkId;
  hash: string;
  event: string;
  owner: string;
  at: number;
}

/** A deposit followed until it arrives (local storage: it outlives the popup and a restart). */
interface Tracked extends DepositSent {
  network: NetworkId;
  at: number;
}

/** A source chain's public endpoint gets this long for a balance. */
const BALANCE_TIMEOUT_MS = 6_000;
/** Deposits are followed for a week, at most this many. */
const TRACK_MS = 7 * 24 * 3_600_000;
const MAX_TRACKED = 20;
/** Left on Arc for its fee, which is paid in USDC, when bridging "max" from there. */
const ARC_GAS_RESERVE = 50_000n;
/** Gas a step takes on another chain, for the estimate the form shows (a burn measured at
 *  about 110k to 170k; an approval about 46k to 56k). */
const BURN_GAS = 200_000n;
const APPROVE_GAS = 60_000n;
/** About the size of a step's unsigned transaction (a burn with a hook is the largest). */
const STEP_BYTES = 420;
/** OP Stack chains in the registry, which charge an Ethereum data fee besides gas. */
const OP_STACK = new Set(["base", "optimism", "unichain", "worldchain", "ink"]);
/** eth_estimateGas comes in low on Injective (Choice's bridge relays mints at an 800k floor). */
const RECEIVE_GAS = 600_000n;

/** The chains USDC can come from: every EVM chain in the bridge registry but Injective. */
export function bridgeSources(network: NetworkId): EvmChain[] {
  return peers(network).filter((c): c is EvmChain => c.kind === "evm");
}

/** A source chain as the sender needs it. */
export function sourceOf(c: EvmChain): SourceChain {
  return { key: c.key, name: c.name, caip2: `eip155:${c.chainId}`, chainId: c.chainId, symbol: c.nativeSymbol, gasIsUsdc: c.gasIsUsdc === true, opStack: OP_STACK.has(c.key), usdc: c.usdc, rpcUrls: c.rpcUrls, explorerTx: c.explorerTx };
}

export function sourceByKey(network: NetworkId, key: unknown): SourceChain | undefined {
  const c = typeof key === "string" ? bridgeSources(network).find((x) => x.key === key) : undefined;
  return c ? sourceOf(c) : undefined;
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

function hexAmount(v: unknown): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error("the node returned no number");
  return BigInt(v);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

function tokenMessenger(network: NetworkId): string {
  return CCTP_CONTRACTS[network].tokenMessenger;
}

/** The vault's reading of the burn against the quote the user saw. */
function matchesQuote(d: EvmDisplayLike, s: Stored, chain: Chain): string | null {
  const c = d.call;
  if (c["type"] !== "bridge") return "The transfer isn't one the wallet can read.";
  if (c["chain"] !== chain.name || c["delivery"] !== "circle") return "The transfer goes somewhere other than its quote.";
  if (c["amount"] !== s.amount || c["max_fee"] !== s.maxFee) return "The transfer doesn't match its quote.";
  const expected = chain.kind === "solana" ? associatedTokenAddress(s.recipient, chain.usdcMint) : s.recipient;
  if (typeof c["recipient"] !== "string" || !same(c["recipient"], expected)) return "The transfer pays someone else.";
  if (chain.kind === "solana" && s.recipientSetup && c["account_owner"] !== s.recipient) return "The transfer opens an account for someone else.";
  return null;
}
