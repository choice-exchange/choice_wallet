// An added chain is named by whoever adds it: never after a chain on the wallet's own list.

import assert from "node:assert/strict";
import { test } from "node:test";

import { copiedChainName } from "../src/chains.ts";

test("names copying a chain on the wallet's list are found, others aren't", () => {
  for (const [name, copied] of [
    ["Ethereum", "Ethereum"],
    ["ethereum mainnet", "Ethereum"],
    ["Base Network", "Base"],
    ["Arbitrum One", "Arbitrum"],
    ["Injective EVM", "Injective"],
    ["OP Main Net", null],
    ["OP Mainnet", "OP Mainnet"],
    ["Ethereum Classic", null],
    ["Polygon zkEVM", null],
    ["BNB Smart Chain", null],
    ["Еthereum", null],
    ["", null],
  ] as const) {
    assert.equal(copiedChainName(name), copied, name);
  }
});
