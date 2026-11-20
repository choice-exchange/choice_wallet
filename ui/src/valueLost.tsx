// A swap quote against the wallet's own prices (Choice's price index, apart from its router):
// a router that is wrong, or a pool that is thin, pays much less than the tokens are worth,
// and the minimum only holds the swap to the quote.

import { Callout } from "./kit";

/** When a quote is said to pay less than it costs, and when that is red. */
export const LOST_WARN = 0.05;
const LOST_RED = 0.2;

export function ValueLost({ lost }: { lost: number | null | undefined }) {
  if (lost === undefined) return null;
  if (lost === null) return <p className="meta">No price to check this quote against.</p>;
  if (lost < LOST_WARN) return null;
  return <Callout level={lost >= LOST_RED ? "red" : "amber"}>You get about {Math.round(lost * 100)}% less than you pay, by Choice&apos;s prices.</Callout>;
}
