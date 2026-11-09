// What a screen read from the host, kept while the popup is open: going back to the screen
// draws it at once, and the host is asked again only when it is older than a minute, or
// once something has happened (the wallet sent a transaction, or the background watcher
// saw one land). The wallet holds one store per account and network.

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { useBackend } from "./backend";
import type { Reply, UiRequest } from "./protocol";

type Entry = { value: unknown; at: number };

/** The store, as the wallet provides it. */
export class Kept {
  readonly #entries = new Map<string, Entry>();
  get(key: string): Entry | undefined {
    return this.#entries.get(key);
  }
  set(key: string, value: unknown): void {
    this.#entries.set(key, { value, at: Date.now() });
  }
  /** Something happened: everything is asked again on its next showing (and still drawn
   *  meanwhile). */
  stale(): void {
    for (const e of this.#entries.values()) e.at = 0;
  }
}

export const KeptContext = createContext<Kept | null>(null);

/** Shown at once when kept; asked again when older than this. */
export const KEPT_FRESH_MS = 60_000;
const UNREACHABLE = "The wallet didn't answer. Try again.";

/** `req`'s answer: the kept one at once, and the host's when it is missing or old. `update`
 *  replaces it (an answer to another request that returns the same, say). */
export function useKept<R extends UiRequest>(req: R) {
  const backend = useBackend();
  const kept = useContext(KeptContext);
  const key = JSON.stringify(req);
  const hit = kept?.get(key);
  const [value, setValue] = useState<Reply<R> | null>((hit?.value as Reply<R> | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  async function load() {
    setBusy(true);
    try {
      const r = await backend.send(req);
      if (!live.current) return;
      if (r.ok) {
        setValue(r.result);
        setError(null);
        kept?.set(key, r.result);
      } else setError(r.error.message);
    } catch {
      if (live.current) setError(UNREACHABLE);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  useEffect(() => {
    live.current = true;
    const now = kept?.get(key);
    if (!now || Date.now() - now.at > KEPT_FRESH_MS) void load();
    return () => {
      live.current = false;
    };
  }, [key]);

  const update = (v: Reply<R>) => {
    setValue(v);
    kept?.set(key, v);
  };
  return { value, error, busy, reload: load, update };
}
