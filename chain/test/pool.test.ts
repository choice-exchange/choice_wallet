// The pool reads an endpoint's answer only up to a size: a few bytes the browser decodes
// can be any amount (run-3).

import assert from "node:assert/strict";
import { test } from "node:test";

import { Down, Pool } from "../src/pool.ts";

test("an answer bigger than the pool reads is the endpoint being down", async () => {
  const answer = (body: string) => async () => new Response(body, { status: 200 });
  const pool = (body: string) => new Pool(["https://rpc.example"], { fetch: answer(body), identify: async () => {}, maxBytes: 1024 });
  assert.deepEqual(await pool(JSON.stringify({ ok: 1 })).json("https://rpc.example"), { status: 200, body: { ok: 1 } });
  await assert.rejects(pool(`"${"x".repeat(2000)}"`).json("https://rpc.example"), (e) => e instanceof Down && /too large/.test(e.message));
});
