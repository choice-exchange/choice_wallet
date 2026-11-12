import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { base58ToBytes, bytesToBase58 } from "../src/encoding.ts";
import { TOKEN_PROGRAM, tokenAccountOf } from "../src/solana.ts";
import { joinSolanaTransaction, lookupTableAddresses, readSolanaMessage, splitSolanaTransaction } from "../src/solanaWire.ts";

// Messages compiled by @solana/web3.js (the vault's vectors), signed by the "abandon …
// about" phrase's Phantom account 0.
const V = JSON.parse(readFileSync(new URL("../../crates/solana/tests/vectors/messages.json", import.meta.url), "utf8")) as Record<string, string>;
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

test("a legacy message's accounts: its signer first, writable as its header says", () => {
  const m = readSolanaMessage(hex(V["sol_transfer"]!));
  assert.equal(m.version, "legacy");
  assert.equal(m.signers, 1);
  assert.equal(m.keys[0], V["owner"]);
  assert.ok(m.keys.includes(V["other"]!));
  assert.equal(m.writable[0], true);
  assert.equal(m.writable[m.keys.indexOf("11111111111111111111111111111111")], false);
  assert.deepEqual(m.lookups, []);
});

test("a v0 message names its lookup tables and the entries it reads", () => {
  const m = readSolanaMessage(hex(V["v0_table"]!));
  assert.equal(m.version, 0);
  assert.equal(m.lookups.length, 1);
  assert.equal(base58ToBytes(m.lookups[0]!.table).length, 32);
  assert.ok(m.lookups[0]!.writable.length + m.lookups[0]!.readonly.length > 0);
  // Cut short, or with a byte after its end: not a message.
  const bytes = hex(V["v0_table"]!);
  assert.throws(() => readSolanaMessage(bytes.slice(0, bytes.length - 1)), RangeError);
  assert.throws(() => readSolanaMessage(Uint8Array.from([...bytes, 0])), RangeError);
});

test("a transaction splits into its signatures and message, and joins back", () => {
  const message = hex(V["sol_transfer"]!);
  const sig = new Uint8Array(64).fill(7);
  const wire = joinSolanaTransaction([sig], message);
  const { signatures, message: back } = splitSolanaTransaction(wire);
  assert.deepEqual([signatures.length, signatures[0], back], [1, sig, message]);
  // Two signatures for a message one account signs: refused.
  assert.throws(() => splitSolanaTransaction(joinSolanaTransaction([sig, sig], message)), RangeError);
});

test("a lookup table's addresses, and a token account's mint, owner and amount", () => {
  const a = base58ToBytes(V["owner"]!);
  const b = base58ToBytes(V["other"]!);
  const table = new Uint8Array(56 + 64);
  table.set(a, 56);
  table.set(b, 88);
  assert.deepEqual(lookupTableAddresses(table), [V["owner"], V["other"]]);
  assert.throws(() => lookupTableAddresses(table.slice(0, 70)), RangeError);
  const data = new Uint8Array(165);
  data.set(b, 0);
  data.set(a, 32);
  new DataView(data.buffer).setBigUint64(64, 1_500_000n, true);
  assert.deepEqual(tokenAccountOf({ lamports: 2_039_280n, owner: TOKEN_PROGRAM, data }), { mint: bytesToBase58(b), owner: V["owner"], amount: 1_500_000n, delegate: null, delegated: 0n, closeAuthority: null });
  assert.equal(tokenAccountOf({ lamports: 1n, owner: "11111111111111111111111111111111", data }), null);
});
