// What the bridge's directions share (./index.ts puts them together): the chains, what
// waits between a quote and its steps, and a context with the Iris client, the account's
// USDC on Injective, inbound quotes, Circle's word on a burn, and the deposits followed
// until they arrive.

import { NETWORKS, type Fetch, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Result } from "@choice-wallet/ui/protocol";
import {
  BRIDGE_RECEIVER,
  CCTP_CONTRACTS,
  INJECTIVE_DOMAIN,
  IrisClient,
  RouteError,
  bytes32ToAddress,
  bytes32ToSolana,
  chainByDomain,
  chainByKey,
  type SolanaChain,
  injective,
  peers,
  quoteTransfer,
  type Chain,
  type EvmChain,
  type IrisMessage,
  type Quote,
} from "injective-usdc-bridge";

import type { createSender, DepositSent, SourceChain } from "../send";
import type { Store } from "../service";
import type { createSolana } from "../solana";
import { fail } from "../util";

export type Sender = ReturnType<typeof createSender>;
export type Solana = ReturnType<typeof createSolana>;

/** Solana as a chain USDC comes from (the account's Solana key signs there). */
export const SOLANA_KEY = "solana";

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

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

/** A quote for bringing USDC in, between the quote and its steps. Amounts are decimal strings. */
export interface StoredIn {
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
export interface RentRecord {
  network: NetworkId;
  hash: string;
  event: string;
  owner: string;
  at: number;
}

/** A deposit followed until it arrives (local storage: it outlives the popup and a restart). */
export interface Tracked extends DepositSent {
  network: NetworkId;
  at: number;
}

/** A source chain's public endpoint gets this long for a balance. */
export const BALANCE_TIMEOUT_MS = 6_000;
/** Deposits are followed for a week, at most this many. */
export const TRACK_MS = 7 * 24 * 3_600_000;
export const MAX_TRACKED = 20;
/** Left on Arc for its fee, which is paid in USDC, when bridging "max" from there. */
export const ARC_GAS_RESERVE = 50_000n;
/** Gas a step takes on another chain, for the estimate the form shows (a burn measured at
 *  about 110k to 170k; an approval about 46k to 56k). */
export const BURN_GAS = 200_000n;
export const APPROVE_GAS = 60_000n;
/** About the size of a step's unsigned transaction (a burn with a hook is the largest). */
export const STEP_BYTES = 420;
/** OP Stack chains in the registry, which charge an Ethereum data fee besides gas. */
export const OP_STACK = new Set(["base", "optimism", "unichain", "worldchain", "ink"]);
/** eth_estimateGas comes in low on Injective (Choice's bridge relays mints at an 800k floor). */
export const RECEIVE_GAS = 600_000n;

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

export function hexAmount(v: unknown): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error("the node returned no number");
  return BigInt(v);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

export function tokenMessenger(network: NetworkId): string {
  return CCTP_CONTRACTS[network].tokenMessenger;
}

/** What more than one direction uses. */
export function createContext(sender: Sender, session: Store, local: Store, fetch: Fetch, now: () => number, solana?: Solana) {
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

  return { sender, session, local, now, solana, plainFetch, iris, usdc, gasDropOffer, askIn, attested, track, rentRecords, tracked, forget };
}

export type BridgeContext = ReturnType<typeof createContext>;
