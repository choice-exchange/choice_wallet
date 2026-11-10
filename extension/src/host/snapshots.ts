// What each account last showed: its balances, staking and the first page of its activity,
// kept on disk so the popup can draw them the moment it opens, while the chain is asked
// again. The UI replaces them as soon as the new answers come.
//
// One storage item per account and network (`snap <network> <address>`), so a refresh
// rewrites only that account's, and an index of them (`snapshots`) so the oldest go once
// there are `MAX`, and so removing the wallet can remove them all. What's kept is what the
// chain shows anyone who knows the address, and the addresses are already in local storage
// (the account list); nothing secret.

import type { NetworkId } from "@choice-wallet/chain";

import type { Store } from "./service";

/** Accounts (per network) remembered. */
const MAX = 20;
/** Activity rows kept: the first screen or so. */
const ACTIVITY_ROWS = 30;
/** A part whose content is unchanged is written again only after this long, so its age
 *  stays roughly right without a write on every refresh. */
const REWRITE_MS = 5 * 60_000;
const INDEX = "snapshots";

export type Part = "balances" | "staking" | "activity";
type Stamped = { at: number; value: unknown };
export type Snapshot = Partial<Record<Part, Stamped>>;

const keyOf = (network: NetworkId, address: string) => `snap ${network} ${address}`;

export function createSnapshots(local: Store, now: () => number = Date.now) {
  /** The last JSON written per part, to skip writes that change nothing. */
  const written = new Map<string, string>();
  // Writes take turns: balances and staking arrive together, and each rewrites the
  // account's item, so two at once would put back the other's old part.
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }

  async function index(): Promise<Record<string, number>> {
    const v = (await local.get([INDEX]))[INDEX];
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};
  }

  async function get(network: NetworkId, address: string): Promise<Snapshot | null> {
    const k = keyOf(network, address);
    const v = (await local.get([k]))[k];
    return typeof v === "object" && v !== null ? (v as Snapshot) : null;
  }

  function save(network: NetworkId, address: string, part: Part, value: unknown): Promise<void> {
    return inTurn(() => write(network, address, part, value));
  }

  async function write(network: NetworkId, address: string, part: Part, value: unknown): Promise<void> {
    if (!address) return;
    const k = keyOf(network, address);
    const kept = part === "activity" ? trimActivity(value) : value;
    const json = JSON.stringify(kept);
    const snap = (await get(network, address)) ?? {};
    const old = snap[part];
    const memo = `${k} ${part}`;
    const same = old !== undefined && (written.has(memo) ? written.get(memo) === json : JSON.stringify(old.value) === json);
    written.set(memo, json);
    if (same && now() - old.at < REWRITE_MS) return;
    const all = await index();
    all[k] = now();
    const keys = Object.keys(all).sort((a, b) => all[a]! - all[b]!);
    const drop = keys.slice(0, Math.max(0, keys.length - MAX));
    for (const d of drop) delete all[d];
    await local.set({ [k]: { ...snap, [part]: { at: now(), value: kept } }, [INDEX]: all });
    if (drop.length) await local.remove(drop);
  }

  /** Forget accounts that are no longer in the wallet. */
  function keepOnly(addresses: readonly string[]): Promise<void> {
    return inTurn(() => forgetOthers(addresses));
  }

  async function forgetOthers(addresses: readonly string[]): Promise<void> {
    const all = await index();
    const keep = new Set(addresses);
    const drop = Object.keys(all).filter((k) => !keep.has(k.split(" ")[2] ?? ""));
    if (drop.length === 0) return;
    for (const d of drop) delete all[d];
    await local.set({ [INDEX]: all });
    await local.remove(drop);
  }

  /** Every storage key this holds, for removing the wallet. */
  async function keys(): Promise<string[]> {
    return [INDEX, ...Object.keys(await index())];
  }

  return { get, save, keepOnly, keys };
}

function trimActivity(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const page = value as { items?: unknown[]; more?: boolean; cutoff?: unknown };
  if (!Array.isArray(page.items) || page.items.length <= ACTIVITY_ROWS) return value;
  // Cut rows: the next page is asked for when the user scrolls there, as always.
  return { ...page, items: page.items.slice(0, ACTIVITY_ROWS), more: true };
}
