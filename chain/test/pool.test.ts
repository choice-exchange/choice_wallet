// The pool reads an endpoint's answer only up to a size: a few bytes the browser decodes
// can be any amount (run-3).

import assert from "node:assert/strict";
import { test } from "node:test";

import { Down, MAX_IN_FLIGHT, MAX_VALUES, Pool } from "../src/pool.ts";

test("an answer bigger than the pool reads is the endpoint being down", async () => {
  const answer = (body: string) => async () => new Response(body, { status: 200 });
  const pool = (body: string) => new Pool(["https://rpc.example"], { fetch: answer(body), identify: async () => {}, maxBytes: 1024 });
  assert.deepEqual(await pool(JSON.stringify({ ok: 1 })).json("https://rpc.example"), { status: 200, body: { ok: 1 } });
  await assert.rejects(pool(`"${"x".repeat(2000)}"`).json("https://rpc.example"), (e) => e instanceof Down && /too large/.test(e.message));
});

// Run-4: the cap is per answer, and parsing can multiply it. An answer that parses into more
// values than any the wallet reads is refused, and the worker holds a bounded total of
// answers at once, however many reads a site starts.
test("an answer of too many values, or past what every pool holds at once, is refused", async () => {
  const pool = (body: () => BodyInit) => new Pool(["https://rpc.example"], { fetch: async () => new Response(body(), { status: 200 }), identify: async () => {} });
  const nested = `[${Array.from({ length: MAX_VALUES + 1 }, () => "[]").join(",")}]`;
  await assert.rejects(pool(() => nested).json("https://rpc.example"), (e) => e instanceof Down && /too large/.test(e.message));
  // As many characters inside one string: one value, read.
  const text = JSON.stringify(",".repeat(MAX_VALUES * 2));
  assert.equal(((await pool(() => text).json("https://rpc.example")).body as string).length, MAX_VALUES * 2);

  // Answers that never finish, each just under the per-answer cap, held at once: past the
  // worker's total, the next is refused rather than read.
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const stalled = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 15; i++) c.enqueue(chunk);
      },
    });
  const reads = Array.from({ length: Math.ceil(MAX_IN_FLIGHT / (15 * chunk.length)) + 1 }, () => pool(stalled).json("https://rpc.example").catch((e: unknown) => e));
  // The ones within the total wait for the rest of their answers; the first to end is refused.
  const first = await Promise.race(reads);
  assert.ok(first instanceof Down && /too many answers at once/.test(first.message), String(first));
});
