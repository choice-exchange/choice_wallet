// Chain data kept on disk (local storage), so the wallet opens fast. Chrome stops the
// service worker about 30 seconds after the popup closes, and what it held in memory goes
// with it: without this, nearly every open would ask the endpoints again for each token's
// description, the erc20 module's token pairs and Choice's prices, one round trip after
// another, before the first balance could show.
//
// Each cache is one storage item, a record of entries stamped with when they were fetched.
// An entry younger than `fresh` is used as it is. One older but younger than `stale` is
// used too, and fetched again in the background, so the next read has the new value
// (stale-while-revalidate). Anything older is fetched before it is used. Writes are batched
// and the oldest entries go first once a cache holds `max`.
//
// Only public chain data is kept here: token descriptions, pairs and prices. What an account
// holds is kept apart, in ./snapshots.ts.

import type { Store } from "./service";

type Entry<V> = { at: number; v: V };

export interface DiskCacheOptions {
  /** Used without asking again, in ms. */
  fresh: number;
  /** Used while it is asked again, in ms; past this it is asked before it is used. */
  stale: number;
  /** Entries kept. */
  max: number;
  /** The oldest an entry may be to stand in when fetching fails (default: any age). */
  fallback?: number;
}

/** How long the batched write waits for more entries. */
const FLUSH_MS = 100;

/** Writes in flight, for `settled()`. */
const writes = new Set<Promise<void>>();

/** Every cache's pending writes done (tests restart the service worker after this). */
export async function settled(): Promise<void> {
  while (writes.size > 0) await Promise.all([...writes]);
}

export function diskCache<V>(local: Store, item: string, opts: DiskCacheOptions, now: () => number = Date.now) {
  let loaded: Promise<Record<string, Entry<V>>> | null = null;
  let pending: { promise: Promise<void>; resolve: () => void } | null = null;
  /** Fetches running in the background, by key, so one key is asked once at a time. */
  const refreshing = new Map<string, Promise<V>>();

  function load(): Promise<Record<string, Entry<V>>> {
    loaded ??= local.get([item]).then((r) => {
      const v = r[item];
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, Entry<V>>) : {};
    });
    return loaded;
  }

  function schedule() {
    if (pending) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    pending = { promise, resolve };
    writes.add(promise);
    setTimeout(() => void flush(), FLUSH_MS);
  }

  async function flush(): Promise<void> {
    const w = pending;
    pending = null;
    try {
      const all = await load();
      const keys = Object.keys(all);
      if (keys.length > opts.max) {
        keys.sort((a, b) => all[a]!.at - all[b]!.at);
        for (const k of keys.slice(0, keys.length - opts.max)) delete all[k];
      }
      await local.set({ [item]: all });
    } catch {
      // A failed write only costs a fetch later.
    } finally {
      if (w) {
        writes.delete(w.promise);
        w.resolve();
      }
    }
  }

  async function put(key: string, v: V): Promise<void> {
    (await load())[key] = { at: now(), v };
    schedule();
  }

  /** The value for `key`: from disk when it is fresh enough, otherwise from `fetch` (and
   *  kept). A failed fetch falls back to a stale entry when there is one. */
  async function get(key: string, fetch: () => Promise<V>): Promise<V> {
    const hit = (await load())[key];
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < opts.fresh) return hit.v;
    if (hit && age < opts.stale) {
      void refresh(key, fetch).catch(() => {});
      return hit.v;
    }
    try {
      return await refresh(key, fetch);
    } catch (e) {
      if (hit && age < (opts.fallback ?? Infinity)) return hit.v;
      throw e;
    }
  }

  function refresh(key: string, fetch: () => Promise<V>): Promise<V> {
    let p = refreshing.get(key);
    if (!p) {
      p = fetch().then(async (v) => {
        await put(key, v);
        return v;
      });
      refreshing.set(key, p);
      void p.finally(() => refreshing.delete(key)).catch(() => {});
    }
    return p;
  }

  /** The entry for `key` with its age, without fetching. */
  async function peek(key: string): Promise<{ v: V; age: number } | null> {
    const hit = (await load())[key];
    return hit ? { v: hit.v, age: now() - hit.at } : null;
  }

  return { get, put, peek };
}
