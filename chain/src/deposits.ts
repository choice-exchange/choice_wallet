// Whether an address takes deposits with a memo, as an exchange's shared deposit address
// does: the exchange credits each deposit to a customer by its memo, so a send without one
// isn't credited to anyone. No list of such addresses is published, so the wallet reads
// the pattern from the chain: most transfers such an address receives carry a memo, from
// many different senders. On Injective mainnet (2026-11-09) two addresses like this had
// memos on 28 and 29 of their last 30 deposits, from 24 and 17 senders, while 1,329 of
// 1,342 bank sends in the last 4,000 blocks had none.

import type { IndexedTx } from "./lcd.ts";

/** Transfers looked at, the latest first. */
export const DEPOSITS_LOOKED_AT = 20;
/** At least this many of them carry a memo, and at least half do. */
const MIN_WITH_MEMO = 5;
/** From at least this many different senders. */
const MIN_SENDERS = 3;

/** Who sent a transaction: its first message's signer, as the node renders it. */
function sender(tx: IndexedTx): string | null {
  const m = tx.messages[0];
  for (const key of ["from_address", "sender", "signer", "granter"]) {
    const v = m?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Whether `address` takes deposits with a memo, from the latest transfers it received
 *  (newest first; transactions it signed itself don't count). */
export function takesMemos(txs: readonly IndexedTx[], address: string): boolean {
  const incoming = txs.filter((t) => t.code === 0 && sender(t) !== address).slice(0, DEPOSITS_LOOKED_AT);
  const tagged = incoming.filter((t) => t.memo.trim().length > 0);
  const senders = new Set(tagged.map(sender).filter((s) => s !== null));
  return tagged.length >= MIN_WITH_MEMO && tagged.length * 2 >= incoming.length && senders.size >= MIN_SENDERS;
}
