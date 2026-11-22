// NFTs: sending an ERC1155 token (Talis's editions on Injective EVM), checked as held first.
import assert from "node:assert/strict";
import test from "node:test";

import { chain, ok, THEM_EVM, wallet } from "./fake";

test("an ERC1155 send: how many, checked as held, read by the vault as that send", async () => {
  const net = chain();
  const NFT = "0x7777777777777777777777777777777777777777";
  net.state.erc1155 = { [`${NFT} 7`]: 3n };
  const { service } = await wallet(net);
  type Rev = { display: { to: string; call: { type: string; token_id: string; amount?: string } }; risk: { level: string; findings: { rule: string }[] }; nft?: { standard: string } };
  const r = ok<Rev>(await service.handle({ type: "prepare_nft_send", standard: "erc1155", collection: NFT, tokenId: "7", to: THEM_EVM, amount: "2" }));
  assert.deepEqual([r.display.to.toLowerCase(), r.display.call.type, r.display.call.token_id, r.display.call.amount], [NFT, "nft_transfer", "7", "2"]);
  assert.equal(r.nft?.standard, "erc1155");
  assert.ok(r.risk.findings.some((f) => f.rule === "nft_send"));
  // More than is held, or one not held, is refused before anything is built.
  assert.equal((await service.handle({ type: "prepare_nft_send", standard: "erc1155", collection: NFT, tokenId: "7", to: THEM_EVM, amount: "4" })).ok, false);
  assert.equal((await service.handle({ type: "prepare_nft_send", standard: "erc1155", collection: NFT, tokenId: "8", to: THEM_EVM })).ok, false);
});
