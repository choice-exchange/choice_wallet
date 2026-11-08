// Blockscout as a finder: hashes and heights from its Etherscan-style API, as Injective's
// instances answered on 2026-11-09.

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvmIndex } from "../src/evmindex.ts";
import { Unreachable } from "../src/pool.ts";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const row = (hash: string, block: number) => ({ blockNumber: String(block), hash, from: ME.toLowerCase(), to: "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f", value: "5", contractAddress: "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4" });

test("a page of transfers: each transaction once, at its height; a short page is the last", async () => {
  const asked: string[] = [];
  const index = new EvmIndex(["https://scout.example/"], async (input) => {
    const url = new URL(input);
    asked.push(url.pathname + url.search);
    if (url.searchParams.get("page") === "2") return new Response(JSON.stringify({ message: "No token transfers found", result: [], status: "0" }));
    // Two transfers in one transaction, then a row that isn't one.
    const H = (b: string) => `0x${b.repeat(32)}`;
    return new Response(JSON.stringify({ message: "OK", status: "1", result: [row(H("AA"), 300), row(H("aa"), 300), row(H("bb"), 290), { hash: "nope", blockNumber: "1" }] }));
  });
  const p1 = await index.transfers(ME, 1, 4);
  assert.deepEqual(p1, { txs: [{ hash: `0x${"aa".repeat(32)}`, height: 300n }, { hash: `0x${"bb".repeat(32)}`, height: 290n }], done: false });
  assert.deepEqual(await index.transfers(ME, 2, 4), { txs: [], done: true });
  assert.equal(asked[0], `/api?module=account&action=tokentx&address=${ME}&page=1&offset=4&sort=desc`);
  await assert.rejects(index.transfers("inj1abc", 1, 4), RangeError);
});

test("a rate limit or an outage moves on, then gives up", async () => {
  const index = new EvmIndex(["https://a.example", "https://b.example"], async (input) =>
    new URL(input).host === "a.example"
      ? new Response(JSON.stringify({ message: "NOTOK", result: "Max rate limit reached", status: "0" }))
      : new Response("Bad gateway", { status: 502 }),
  );
  await assert.rejects(index.transfers(ME, 1, 50), Unreachable);
});
