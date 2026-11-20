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
