// The Activity tab's state, apart from its screen so it can be tested: what it shows, and
// how a page read from the chain joins what's there.

import type { ActivityItem, ActivityPage, TokenFilter } from "./protocol";

/** What the Activity tab shows. The wallet keeps it while the popup is open, so coming
 *  back to the tab draws it at once. */
export type ActivityState = {
  items: ActivityItem[];
  tokens: ActivityPage["tokens"];
  validators: Record<string, string>;
  filter: TokenFilter | null;
  /** Pages read so far. */
  page: number;
  more: boolean;
  cutoff: string | null;
  indexDown: boolean;
  /** When the first page was last read (ms); 0 when it is the saved copy from disk, or
   *  something has happened since. */
  at: number;
};

/** Coming back within this long shows what's there without asking again; a transaction
 *  landing, the watcher's word or the refresh button ask at once. */
export const ACTIVITY_FRESH_MS = 60_000;

const byHeight = (a: ActivityItem, b: ActivityItem) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0);

/** `prev` with page `p` of the chain's answer: the next page added, or the first page read
 *  again. Read again, the first page goes on top of what further pages showed, when the two
 *  meet; past a gap (more new rows than a page holds), it starts over. */
export function merge(prev: ActivityState | null, r: ActivityPage, p: number, at: number): ActivityState {
  const base = { filter: r.filter, indexDown: r.evmIndexDown === true, validators: { ...(prev?.validators ?? {}), ...(r.validators ?? {}) } };
  if (p > 1 && prev) {
    const seen = new Set(prev.items.map((a) => a.hash));
    return { ...prev, ...base, items: [...prev.items, ...r.items.filter((a) => !seen.has(a.hash))].sort(byHeight), tokens: { ...prev.tokens, ...r.tokens }, page: p, more: r.more, cutoff: r.cutoff };
  }
  const fresh = { ...base, items: [...r.items].sort(byHeight), tokens: r.tokens, page: 1, more: r.more, cutoff: r.cutoff, at };
  if (!prev || prev.page <= 1 || prev.items.length === 0) return fresh;
  const oldTop = prev.items.reduce((m, a) => (BigInt(a.height) > m ? BigInt(a.height) : m), 0n);
  if (r.more && r.cutoff !== null && BigInt(r.cutoff) > oldTop) return fresh;
  const kept = prev.items.filter((a) => !r.items.some((x) => x.hash === a.hash));
  return { ...prev, ...base, items: [...r.items, ...kept].sort(byHeight), tokens: { ...prev.tokens, ...r.tokens }, at };
}

