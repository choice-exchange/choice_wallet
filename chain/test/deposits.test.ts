// Reading an exchange's shared deposit address from the chain: most deposits carry a memo,
// from many senders.

import assert from "node:assert/strict";
import { test } from "node:test";

import { takesMemos } from "../src/deposits.ts";
import type { IndexedTx } from "../src/lcd.ts";

const EXCHANGE = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz"; // the BIP-39 test phrase's account 0 (published)
const sender = (i: number) => `inj1sender${i}`;

const tx = (from: string, memo: string, code = 0): IndexedTx => ({
  hash: "A".repeat(64),
  height: 1n,
  time: "2026-11-09T00:00:00Z",
  code,
  messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: from, to_address: EXCHANGE }],
  memo,
  fee: [],
  events: [],
});

test("an exchange's deposits: memos from many senders", () => {
  const deposits = Array.from({ length: 18 }, (_, i) => tx(sender(i % 6), `10${i}234567`));
  assert.equal(takesMemos([...deposits, tx(sender(9), ""), tx(sender(10), "")], EXCHANGE), true);
});

test("not an exchange: few memos, one sender, or too little to go on", () => {
  // A personal address: a note now and then.
  assert.equal(takesMemos([tx(sender(1), "rent"), ...Array.from({ length: 12 }, (_, i) => tx(sender(i), ""))], EXCHANGE), false);
  // One sender tagging its own payments.
  assert.equal(takesMemos(Array.from({ length: 10 }, (_, i) => tx(sender(1), `invoice ${i}`)), EXCHANGE), false);
  // Four is too few to say.
  assert.equal(takesMemos([1, 2, 3, 4].map((i) => tx(sender(i), "12345")), EXCHANGE), false);
  // What it sent itself and failed transactions don't count.
  assert.equal(takesMemos([...[1, 2, 3, 4].map((i) => tx(sender(i), "12345")), tx(EXCHANGE, "12345"), tx(sender(5), "12345", 5)], EXCHANGE), false);
});

test("only the latest 20 count", () => {
  const old = Array.from({ length: 20 }, (_, i) => tx(sender(i), `${i}99`));
  const recent = Array.from({ length: 20 }, (_, i) => tx(sender(i), ""));
  assert.equal(takesMemos([...recent, ...old], EXCHANGE), false);
  assert.equal(takesMemos([...old, ...recent], EXCHANGE), true);
});
