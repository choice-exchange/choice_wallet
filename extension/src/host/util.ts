// What the service worker's modules share: a refusal in the UI's terms, a random ID, turns
// on stored records, and how records compare addresses.

import { bytesToHex } from "@choice-wallet/chain";
import type { Result } from "@choice-wallet/ui/protocol";

/** A refusal for the UI: a stable code, and a message in words. */
export const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** A random ID, `bytes` long, in hex: for something kept between two steps. */
export const randomId = (bytes = 8): string => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

/** Work on stored records that must not interleave with other work on them: each waits for
 *  the one before. */
export type Turn = <T>(work: () => Promise<T>) => Promise<T>;

/** A new queue of turns. */
export function turns(): Turn {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const p = queue.then(work);
    queue = p.catch(() => {});
    return p;
  };
}

/** No shared queue: the work runs as it is (a module used on its own, in tests). */
export const ownTurn: Turn = (work) => work();

/** An address as records compare it: a 0x address in any case, base58 and bech32 exactly. */
export const addressKey = (x: string): string => (x.startsWith("0x") ? x.toLowerCase() : x);
