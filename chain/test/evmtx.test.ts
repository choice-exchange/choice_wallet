// Reading EVM transactions out of the Cosmos tx index: the signed call, the result's logs,
// and the ERC20 events in them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { erc20Event, evmCall, evmResults, failedEvmHash, transferRecipient } from "../src/evmtx.ts";
import { approvalLog, ethMessage, rawTx, resultData, transferCall, transferLog, word } from "./evm-fixture.ts";

// Published addresses: the BIP-39 test phrase's account and the EIP-155 example key's.
const ME = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
const THEM = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const TOKEN = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
const HASH = `0x${"ab".repeat(32)}`;

test("the result's logs: hash, emitter, topics and data", () => {
  const logs = [transferLog(TOKEN, ME, THEM, 5n * 10n ** 18n), approvalLog(TOKEN, ME, THEM, 0n)];
  const [r] = evmResults(resultData(HASH, logs));
  assert.equal(r!.hash, HASH);
  assert.deepEqual(r!.logs, logs);
  // Anything that isn't an EVM result reads as none.
  assert.deepEqual(evmResults(""), []);
  assert.deepEqual(evmResults("zz"), []);
  assert.deepEqual(evmResults("12FF"), []); // truncated
  assert.deepEqual(evmResults("1206" + "0A04" + Buffer.from("/x.y").toString("hex")), []);
});

test("the signed call, from each transaction type Injective runs", () => {
  for (const type of [0, 1, 2] as const) {
    const m = ethMessage(ME, rawTx({ type, to: THEM, value: 10n ** 15n }));
    assert.deepEqual(evmCall(m), { from: ME, to: THEM, value: 10n ** 15n, input: "0x" }, `type ${type}`);
  }
  const call = evmCall(ethMessage(ME, rawTx({ to: TOKEN, input: transferCall(THEM, 7n) })));
  assert.equal(call!.to, TOKEN);
  assert.equal(transferRecipient(call!.input), THEM);
  assert.equal(evmCall(ethMessage(ME, rawTx({ to: null, input: "0x6080" })))!.to, null);
  // Not an EVM message, or bytes that don't read as a transaction.
  assert.equal(evmCall({ "@type": "/cosmos.bank.v1beta1.MsgSend" }), null);
  assert.equal(evmCall(ethMessage(ME, "0x02c0")), null);
  assert.equal(evmCall(ethMessage(ME, "0x04f8")), null);
  assert.equal(evmCall({ ...ethMessage(ME, rawTx({ to: THEM })), from: "!!" }), null);
});

test("ERC20 events: transfers and approvals; an NFT transfer or anything else isn't one", () => {
  assert.deepEqual(erc20Event(transferLog(TOKEN, ME, THEM, 9n)), { kind: "transfer", token: TOKEN, from: ME, to: THEM, amount: 9n });
  assert.deepEqual(erc20Event(approvalLog(TOKEN, ME, THEM, 1n)), { kind: "approval", token: TOKEN, owner: ME, spender: THEM, amount: 1n });
  const nft = transferLog(TOKEN, ME, THEM, 0n);
  assert.equal(erc20Event({ ...nft, topics: [...nft.topics, word("5")], data: "0x" }), null);
  assert.equal(erc20Event({ ...nft, topics: [word("1"), ...nft.topics.slice(1)] }), null);
});

test("a reverted transaction's EVM hash, from its log line", () => {
  const log = `failed to execute message; message index: 0: {"tx_hash":"${HASH.toUpperCase().replace("0X", "0x")}","gas_used":974469,"reason":"no profit","vm_error":"execution reverted"}`;
  assert.equal(failedEvmHash(log), HASH);
  assert.equal(failedEvmHash("out of gas"), null);
});
