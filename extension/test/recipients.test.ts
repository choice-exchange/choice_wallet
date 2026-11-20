// Who a site's request pays, for the exchange-memo rule: bank sends and CW20 transfers
// (inside MsgExec too), an Injective tx sent as typed data, and an EVM send on Injective.

import assert from "node:assert/strict";
import { test } from "node:test";

import { recipientsOf } from "../src/host/dapp/recipients";

test("recipients of each kind of request", () => {
  const bank = { type: "bank_send", from: "inj1me", to: "inj1a", amount: [] };
  const cw20 = { type: "execute_contract", sender: "inj1me", contract: "inj1t", call: { type: "cw20_transfer", recipient: "inj1b", amount: "5" } };
  const exec = { type: "authz_exec", grantee: "inj1me", msgs: [{ ...bank, to: "inj1c" }] };
  const nft = { type: "execute_contract", sender: "inj1me", contract: "inj1n", call: { type: "nft_transfer", recipient: "inj1d", token_id: "7" } };
  const redeem = { type: "execute_contract", sender: "inj1me", contract: "inj1adapter", call: { type: "adapter_redeem", recipient: "inj1e" } };
  const own = { type: "execute_contract", sender: "inj1me", contract: "inj1adapter", call: { type: "adapter_redeem", recipient: null } };
  assert.deepEqual(recipientsOf("mainnet", { kind: "cosmos_direct", messages: [bank, cw20, exec, bank, nft, redeem, own] }), ["inj1a", "inj1b", "inj1c", "inj1d", "inj1e"]);
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_transaction", chain: "eip155:1776", to: "0xn", call: { type: "nft_transfer", from: "0xme", to: "0x3" } }), ["0x3"]);
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_typed_data", injective_tx: { messages: [bank] } }), ["inj1a"]);
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_transaction", chain: "eip155:1776", to: "0x1", call: { type: "transfer" } }), ["0x1"]);
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_transaction", chain: "eip155:1776", to: "0xt", call: { type: "erc20_transfer", to: "0x2" } }), ["0x2"]);
  // Another EVM chain: the wallet reads Injective's deposits only.
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_transaction", chain: "eip155:8453", to: "0x1", call: { type: "transfer" } }), []);
  assert.deepEqual(recipientsOf("mainnet", { kind: "evm_personal_sign", text: "hi" }), []);
  assert.deepEqual(recipientsOf("mainnet", null), []);
});

// Run-3: token calls the policy weighs but the display doesn't type get memo facts too.
test("recipients of token calls the display leaves as contract calls", () => {
  const me = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
  const x = "0x7777777777777777777777777777777777777777";
  const w = (a: string) => a.slice(2).padStart(64, "0");
  const evm = (data: string) => ({ kind: "evm_transaction", chain: "eip155:1776", from: me, to: "0x4444444444444444444444444444444444444444", data, call: { type: "contract" } });
  assert.deepEqual(recipientsOf("mainnet", evm(`0x23b872dd${w(me)}${w(x)}${"5".padStart(64, "0")}`)), [x]);
  assert.deepEqual(recipientsOf("mainnet", evm(`0xb88d4fde${w(me)}${w(x)}${"7".padStart(64, "0")}${"80".padStart(64, "0")}${"0".padStart(64, "0")}`)), [x]);
  assert.deepEqual(recipientsOf("mainnet", evm(`0x4000aea0${w(x)}${"5".padStart(64, "0")}${"60".padStart(64, "0")}${"0".padStart(64, "0")}`)), [x]);
  // From someone else (using their approval): not this account's send.
  assert.deepEqual(recipientsOf("mainnet", evm(`0x23b872dd${w(x)}${w(me)}${"5".padStart(64, "0")}`)), []);
});
