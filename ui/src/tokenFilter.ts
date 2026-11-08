// Which balances the lists show. Anyone can send any token to any address, and junk often
// carries a name meant to be read ("claim at …"), so the default is to show only what has
// a reason to be there: the fee token, the wallet's listed tokens, and tokens Choice prices
// (they trade somewhere real). The user's own choices win over the rules, except that the
// fee token always shows.

import type { Balance, TokenFilter } from "./protocol";

export const DEFAULT_FILTER: TokenFilter = { all: false, hideSmall: false, shown: [], hidden: [] };

/** Under this many dollars counts as small. */
export const SMALL_USD = 1;

export type HiddenWhy = "unlisted" | "small" | "yours";

/** Why the filter hides `b`, or null if it shows. */
export function hiddenWhy(b: Balance, f: TokenFilter, feeDenom: string): HiddenWhy | null {
  if (b.denom === feeDenom) return null;
  if (f.hidden.includes(b.denom)) return "yours";
  if (f.shown.includes(b.denom)) return null;
  if (f.hideSmall && b.usd !== undefined && b.usd < SMALL_USD) return "small";
  if (f.all || b.known || b.onChoice) return null;
  return "unlisted";
}

export type Sorted = { shown: Balance[]; hidden: { balance: Balance; why: HiddenWhy }[]; totalUsd?: number };

/** Split the balances, keeping their order. `totalUsd` sums the shown ones that have a
 *  price; absent when none do. */
export function applyFilter(list: readonly Balance[], f: TokenFilter, feeDenom: string): Sorted {
  const out: Sorted = { shown: [], hidden: [] };
  let total: number | undefined;
  for (const b of list) {
    const why = hiddenWhy(b, f, feeDenom);
    if (why) {
      out.hidden.push({ balance: b, why });
    } else {
      out.shown.push(b);
      if (b.usd !== undefined) total = (total ?? 0) + b.usd;
    }
  }
  if (total !== undefined) out.totalUsd = total;
  return out;
}

/** The filter after the user flips `b` between shown and hidden. A choice is only kept
 *  where it differs from the rules, so the lists stay short. */
export function flip(f: TokenFilter, b: Balance, feeDenom: string): TokenFilter {
  if (b.denom === feeDenom) return f;
  const hide = hiddenWhy(b, f, feeDenom) === null;
  const base = { ...f, shown: f.shown.filter((d) => d !== b.denom), hidden: f.hidden.filter((d) => d !== b.denom) };
  if ((hiddenWhy(b, base, feeDenom) !== null) === hide) return base;
  return hide ? { ...base, hidden: [...base.hidden, b.denom] } : { ...base, shown: [...base.shown, b.denom] };
}
