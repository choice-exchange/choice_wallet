// NFTs: collections suggested by the tx index and Blockscout, what's held confirmed by each
// contract. Bodies follow cw721-base's queries and Blockscout's `tokennfttx`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvmRpc } from "../src/evm.ts";
import { EvmIndex } from "../src/evmindex.ts";
import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import { cw721Collections, CW721_PAGE, erc721Collections, isTokenId } from "../src/nfts.ts";
import type { Fetch } from "../src/pool.ts";

const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const ME_EVM = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
const OTHER = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
/** Test-phrase accounts 2 and 3's addresses stand in for contracts: only the shapes matter. */
const PUNKS = "inj1keckja4ra05d8xkwkpph9u30lrngqtt6vv34da";
const CW20 = "inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8";
const ADDED = "inj1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sax6t9f";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 230 punks held by ME (three pages), one in ADDED, a CW20 that isn't a CW721. */
function chain() {
  const punks = Array.from({ length: 230 }, (_, i) => `punk-${String(i).padStart(3, "0")}`);
  const smartCalls: string[] = [];
  const fetch: Fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/node_info")) return json(200, { default_node_info: { network: "injective-1" } });
    if (url.pathname === "/cosmos/tx/v1beta1/txs") {
      const q = url.searchParams.get("query") ?? "";
      const wasm = (attrs: Record<string, string>) => ({ type: "wasm", attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })) });
      const tx = (events: unknown[]) => ({ txhash: "AA".repeat(32), height: "5", timestamp: "2026-11-09T00:00:00Z", code: 0, tx: { body: { messages: [], memo: "" }, auth_info: { fee: { amount: [] } } }, events });
      if (q.startsWith("wasm.recipient")) {
        return json(200, {
          tx_responses: [
            tx([wasm({ _contract_address: PUNKS, action: "transfer_nft", sender: OTHER, recipient: ME, token_id: "punk-001" })]),
            // A CW20 transfer to ME: "transfer", not an NFT action.
            tx([wasm({ _contract_address: CW20, action: "transfer", from: OTHER, to: ME, recipient: ME, amount: "5" })]),
          ],
          total: "2",
        });
      }
      return json(200, { tx_responses: [], total: "0" });
    }
    const m = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/(.+)$/.exec(url.pathname);
    if (m) {
      const contract = m[1]!;
      const q = JSON.parse(atob(decodeURIComponent(m[2]!))) as Record<string, Record<string, unknown>>;
      smartCalls.push(`${contract.slice(-4)} ${Object.keys(q)[0]}`);
      const isNft = contract === PUNKS || contract === ADDED;
      if (q["contract_info"]) return isNft ? json(200, { data: { name: contract === PUNKS ? "Test‮Punks" : "Added", symbol: "TP" } }) : json(500, { code: 2, message: "unknown variant" });
      if (q["tokens"] && isNft) {
        const owned = contract === PUNKS ? punks : ["only-one"];
        const after = q["tokens"]["start_after"] as string | undefined;
        const from = after === undefined ? 0 : owned.indexOf(after) + 1;
        return json(200, { data: { tokens: owned.slice(from, from + Number(q["tokens"]["limit"])) } });
      }
      if (q["nft_info"]) {
        const id = q["nft_info"]["token_id"] as string;
        return json(200, { data: { token_uri: id === "punk-000" ? "ipfs://bafy/0.json" : "javascript:alert(1)", extension: id === "punk-000" ? { name: "Punk Zero" } : null } });
      }
      return json(500, { code: 2, message: "unknown variant" });
    }
    return json(404, { code: 5, message: "not found" });
  };
  return { fetch, smartCalls };
}

test("CW721: suggested by the index, every page of tokens read, metadata cleaned", async () => {
  const c = chain();
  const lcd = new Lcd(NETWORKS.mainnet, ["https://a.example"], c.fetch, 1000);
  const found = await cw721Collections(lcd, ME, [ADDED]);
  assert.deepEqual(found.map((x) => [x.address, x.name, x.items.length, x.more]), [
    [ADDED, "Added", 1, false],
    [PUNKS, "TestPunks", 230, false],
  ]);
  // 230 tokens at 100 a page is three pages; a default page size would have stopped at 10.
  assert.equal(c.smartCalls.filter((s) => s === `${PUNKS.slice(-4)} tokens`).length, Math.ceil(230 / CW721_PAGE));
  const punks = found[1]!;
  assert.deepEqual(punks.items[0], { tokenId: "punk-000", name: "Punk Zero", uri: "ipfs://bafy/0.json" });
  // A script URI is never offered as a link.
  assert.equal(punks.items[1]!.uri, null);
  // The CW20 named in a "transfer" was never asked about as an NFT.
  assert.ok(!c.smartCalls.some((s) => s.startsWith(CW20.slice(-4))));
});

test("token IDs the wallet names", () => {
  for (const ok of ["1", "punk-001", "a".repeat(256)]) assert.ok(isTokenId(ok), ok);
  for (const bad of ["", "a".repeat(257), "a\u0000b", 7]) assert.ok(!isTokenId(bad), String(bad));
});

test("ERC721: Blockscout names tokens, ownerOf says which are still held", async () => {
  const COLLECTION = "0x1111111111111111111111111111111111111111";
  const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  const str = (s: string) => `0x${word("20")}${word(Buffer.from(s).length.toString(16))}${Buffer.from(s).toString("hex").padEnd(64, "0")}`;
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "index.example") {
      assert.equal(url.searchParams.get("action"), "tokennfttx");
      return json(200, {
        status: "1",
        result: [
          { contractAddress: COLLECTION, tokenID: "7", to: ME_EVM, from: "0x0000000000000000000000000000000000000000" },
          { contractAddress: COLLECTION, tokenID: "8", to: ME_EVM, from: "0x0000000000000000000000000000000000000000" },
          { contractAddress: COLLECTION, tokenID: "9", to: "0x2222222222222222222222222222222222222222", from: ME_EVM },
        ],
      });
    }
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ data: string }] } | { id: number; method: string; params: [{ data: string }] }[];
    const answer = (r: { id: number; method: string; params: [{ data: string }] }) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x6f0" };
      const d = r.params[0].data;
      let result = "0x";
      if (d.startsWith("0x06fdde03")) result = str("Test Cats");
      else if (d.startsWith("0x95d89b41")) result = str("CAT");
      else if (d.startsWith("0x70a08231")) result = `0x${word("1")}`;
      else if (d.startsWith("0x6352211e")) result = `0x${word(BigInt(`0x${d.slice(10)}`) === 7n ? ME_EVM : "0x3333333333333333333333333333333333333333")}`;
      else if (d.startsWith("0xc87b56dd")) result = str("https://cats.example/7.json");
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return json(200, Array.isArray(body) ? body.map(answer) : answer(body));
  };
  const rpc = new EvmRpc(NETWORKS.mainnet, ["https://rpc.example"], fetch, 1000);
  const index = new EvmIndex(["https://index.example"], fetch, 1000);
  const found = await erc721Collections(rpc, index, ME_EVM, []);
  assert.deepEqual(found, [
    { address: COLLECTION, standard: "erc721", name: "Test Cats", symbol: "CAT", items: [{ tokenId: "7", name: "", uri: "https://cats.example/7.json" }], more: false },
  ]);
});
