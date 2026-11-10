// Solana's wire format, as far as the host needs it for a transaction a site hands over: its
// signatures apart from its message, and which accounts the message names (its own keys and
// the lookup tables a v0 message reads more from). The vault reads the message itself, as
// strictly as the runtime does; these only find what to fetch and where a signature goes.

import { bytesToBase58 } from "./encoding.ts";

/** A compact-u16 (1 to 3 bytes) at `at`: its value and the offset after it. */
function shortVec(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new RangeError("the transaction ends early");
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new RangeError("a length in the transaction is too long");
}

function encodeShortVec(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

/** A signed (or partly signed) transaction: its signatures (64 zero bytes where one is still
 *  missing), then its message. */
export function splitSolanaTransaction(wire: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array } {
  const [count, at] = shortVec(wire, 0);
  if (count === 0 || count > 64) throw new RangeError("the transaction has no signatures, or too many");
  const end = at + count * 64;
  if (wire.length <= end) throw new RangeError("the transaction ends early");
  const signatures = Array.from({ length: count }, (_, i) => wire.slice(at + i * 64, at + (i + 1) * 64));
  const message = wire.slice(end);
  if (readSolanaMessage(message).signers !== count) throw new RangeError("the transaction's signatures don't match its message");
  return { signatures, message };
}

export function joinSolanaTransaction(signatures: readonly Uint8Array[], message: Uint8Array): Uint8Array {
  const head = encodeShortVec(signatures.length);
  const out = new Uint8Array(head.length + signatures.length * 64 + message.length);
  out.set(head);
  signatures.forEach((s, i) => {
    if (s.length !== 64) throw new RangeError("a signature is 64 bytes");
    out.set(s, head.length + i * 64);
  });
  out.set(message, head.length + signatures.length * 64);
  return out;
}

export interface SolanaMessageKeys {
  version: "legacy" | 0;
  /** How many of `keys`, from the first, sign. */
  signers: number;
  /** The message's own accounts (base58), in order. */
  keys: string[];
  /** Whether each of `keys` is writable. */
  writable: boolean[];
  /** A v0 message's lookup tables, and which of each one's entries it reads. */
  lookups: { table: string; writable: number[]; readonly: number[] }[];
}

/** The accounts a message names. Throws a RangeError for bytes that aren't a message. */
export function readSolanaMessage(m: Uint8Array): SolanaMessageKeys {
  let at = 0;
  let version: "legacy" | 0 = "legacy";
  const first = m[0];
  if (first === undefined) throw new RangeError("the message is empty");
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new RangeError(`message version ${first & 0x7f} isn't known`);
    version = 0;
    at = 1;
  }
  const [signers, readonlySigned, readonlyUnsigned] = [m[at], m[at + 1], m[at + 2]];
  if (signers === undefined || readonlySigned === undefined || readonlyUnsigned === undefined) throw new RangeError("the message ends early");
  at += 3;
  const [nKeys, afterLen] = shortVec(m, at);
  at = afterLen;
  if (at + nKeys * 32 + 32 > m.length) throw new RangeError("the message ends early");
  const keys = Array.from({ length: nKeys }, (_, i) => bytesToBase58(m.slice(at + i * 32, at + (i + 1) * 32)));
  at += nKeys * 32 + 32; // the keys, then the recent blockhash
  if (signers === 0 || signers > nKeys || readonlySigned >= signers || readonlyUnsigned > nKeys - signers) throw new RangeError("the message's header doesn't fit its accounts");
  const writable = keys.map((_, i) => (i < signers ? i < signers - readonlySigned : i < nKeys - readonlyUnsigned));
  const [nIx, afterIx] = shortVec(m, at);
  at = afterIx;
  for (let i = 0; i < nIx; i++) {
    at += 1; // the program's index
    const [nAcc, a1] = shortVec(m, at);
    at = a1 + nAcc;
    const [nData, a2] = shortVec(m, at);
    at = a2 + nData;
    if (at > m.length) throw new RangeError("the message ends early");
  }
  const lookups: SolanaMessageKeys["lookups"] = [];
  if (version === 0) {
    const [nLookups, a3] = shortVec(m, at);
    at = a3;
    for (let i = 0; i < nLookups; i++) {
      if (at + 32 > m.length) throw new RangeError("the message ends early");
      const table = bytesToBase58(m.slice(at, at + 32));
      at += 32;
      const [nW, a4] = shortVec(m, at);
      const w = Array.from(m.slice(a4, a4 + nW));
      const [nR, a5] = shortVec(m, a4 + nW);
      const r = Array.from(m.slice(a5, a5 + nR));
      at = a5 + nR;
      if (at > m.length) throw new RangeError("the message ends early");
      lookups.push({ table, writable: w, readonly: r });
    }
  }
  if (at !== m.length) throw new RangeError("the message has bytes after its end");
  return { version, signers, keys, writable, lookups };
}

/** The addresses an address lookup table holds, from its account's data (they start after
 *  its 56-byte header). */
export function lookupTableAddresses(data: Uint8Array): string[] {
  if (data.length < 56 || (data.length - 56) % 32 !== 0) throw new RangeError("not an address lookup table");
  return Array.from({ length: (data.length - 56) / 32 }, (_, i) => bytesToBase58(data.slice(56 + i * 32, 88 + i * 32)));
}

/** The program that owns address lookup tables. */
export const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
