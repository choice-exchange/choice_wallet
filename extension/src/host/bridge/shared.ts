// What the bridge's parts share (./index.ts puts them together): limits, and a context with
// the Iris client, Choice's INJ top-up, and the rent records of burns on Solana.

import type { Fetch, NetworkId } from "@choice-wallet/chain";
import { BRIDGE_RECEIVER, INJECTIVE_DOMAIN, IrisClient, bytes32ToAddress, bytes32ToSolana, chainByDomain } from "injective-usdc-bridge";

import type { createSender } from "../send";
import type { Store } from "../service";
import type { createSolana } from "../solana";

export type Sender = ReturnType<typeof createSender>;
export type Solana = ReturnType<typeof createSolana>;

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

/** A burn on Solana whose record's rent comes back to `owner` (its Solana address). */
export interface RentRecord {
  network: NetworkId;
  hash: string;
  event: string;
  owner: string;
  at: number;
}

/** Transfers are followed for a week, at most this many. */
export const TRACK_MS = 7 * 24 * 3_600_000;
export const MAX_TRACKED = 20;

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

/** What more than one part uses. */
export function createContext(sender: Sender, session: Store, local: Store, fetch: Fetch, now: () => number, solana?: Solana) {
  // The package adds a user-agent outside pages (Circle's CDN refuses some servers' own); a
  // service worker's fetch would make it a CORS preflight, which Iris doesn't answer.
  const plainFetch = ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("user-agent");
    return fetch(url, { ...init, headers });
  }) as typeof globalThis.fetch;
  const iris = (network: NetworkId) => new IrisClient({ network, fetch: plainFetch });

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

  async function rentRecords(): Promise<RentRecord[]> {
    const { solana_rent } = await local.get(["solana_rent"]);
    return Array.isArray(solana_rent) ? (solana_rent as RentRecord[]) : [];
  }

  return { sender, session, local, now, solana, plainFetch, iris, gasDropOffer, rentRecords };
}

export type BridgeContext = ReturnType<typeof createContext>;
