// The pool reads an endpoint's answer only up to a size: a few bytes the browser decodes
// can be any amount (run-3).

import assert from "node:assert/strict";
import { test } from "node:test";

import { Busy, ChainError, Down, MAX_IN_FLIGHT, MAX_SITE_IN_FLIGHT, MAX_VALUES, Pool, siteBudget, Unconfirmed, Unreachable } from "../src/pool.ts";

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
  // The ones within the total wait for the rest of their answers; the first to end is refused,
  // as the worker's own refusal (run-5), not the endpoint's failure.
  const first = await Promise.race(reads);
  assert.ok(first instanceof Busy, String(first));
});

// Run-5: a site's endpoints and reads count against that site's own budget, so a site holding
// many stalled answers fails only its own reads, never the wallet's. The worker's refusal isn't
// the endpoint's failure: no other endpoint is tried for it.
test("a site's held answers can't fail the wallet's reads", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const stalled = () =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (let i = 0; i < 15; i++) c.enqueue(chunk);
        await held;
        c.close();
      },
    });
  const site = new Pool(["https://site.example"], { fetch: async () => new Response(stalled(), { status: 200 }), identify: async () => {}, budget: siteBudget("https://shop.example") });
  const reads = Array.from({ length: Math.ceil(MAX_SITE_IN_FLIGHT / (15 * chunk.length)) + 1 }, () => site.json("https://site.example").catch((e: unknown) => e));
  assert.ok((await Promise.race(reads)) instanceof Busy);
  // The wallet's own pool still reads while the site holds its budget.
  const asked: string[] = [];
  const own = new Pool(["https://a.example", "https://b.example"], {
    fetch: async (u) => {
      asked.push(u);
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    },
    identify: async () => {},
  });
  assert.deepEqual((await own.run((base) => own.json(base))).body, { ok: 1 });
  // A refusal of the worker's own, inside run, ends it at once.
  let tries = 0;
  await assert.rejects(
    own.run(async () => {
      tries++;
      throw new Busy();
    }),
    (e) => e instanceof Busy,
  );
  assert.equal(tries, 1);
  release();
  await Promise.all(reads);
  assert.ok(MAX_IN_FLIGHT > MAX_SITE_IN_FLIGHT);
});

// Run-5: a write that went out and got no answer may have landed. It still goes to the next
// endpoint (the same bytes), but ends as Unconfirmed, never as Unreachable; a refusal from the
// next after the first took it says nothing sure either. Not sent at all: Unreachable.
test("a write whose answer is lost ends unconfirmed", async () => {
  const pool = (identify: (base: string) => Promise<void>) => new Pool(["https://a.example", "https://b.example"], { fetch: async () => new Response("", { status: 200 }), identify });
  const sent: string[] = [];
  const lost = pool(async () => {});
  await assert.rejects(
    lost.run(
      async (base) => {
        sent.push(base);
        throw new Down("timed out");
      },
      { write: true },
    ),
    (e) => e instanceof Unconfirmed,
  );
  assert.deepEqual(sent, ["https://a.example", "https://b.example"]);
  await assert.rejects(
    lost.run(
      async (base) => {
        if (base.includes("a.example")) throw new Down("timed out");
        throw new ChainError(-32000, "nonce too low");
      },
      { write: true },
    ),
    (e) => e instanceof Unconfirmed,
  );
  // "Already known" from the next: it's there, and the caller says so.
  await assert.rejects(
    lost.run(
      async (base) => {
        if (base.includes("a.example")) throw new Down("timed out");
        throw new ChainError(-32000, "already known");
      },
      { write: true },
    ),
    (e) => e instanceof ChainError,
  );
  // Review: after one took it, the next endpoint's own check failing (a full budget, a
  // garbled answer) says nothing sure either.
  const checks = pool(async (base) => {
    if (base.includes("b.example")) throw new Busy();
  });
  await assert.rejects(
    checks.run(
      async () => {
        throw new Down("timed out");
      },
      { write: true },
    ),
    (e) => e instanceof Unconfirmed,
  );
  // An endpoint that answered it didn't take it (a rate limit) didn't get it.
  const limited = pool(async () => {});
  await assert.rejects(
    limited.run(
      async () => {
        throw new Down("HTTP 429, not JSON", { refused: true });
      },
      { write: true },
    ),
    (e) => e instanceof Unreachable && !(e instanceof Unconfirmed),
  );
  // No endpoint could be identified: nothing went out.
  const down = pool(async () => {
    throw new Down("no answer");
  });
  await assert.rejects(
    down.run(async () => 1, { write: true }),
    (e) => e instanceof Unreachable && !(e instanceof Unconfirmed),
  );
});
