// Approvals and grants: which grants are shown as able to move the account's funds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { canMoveFunds, permissionName } from "../src/permissions.ts";

test("every grant is red unless its type is known not to move funds", () => {
  for (const red of [
    "/cosmos.bank.v1beta1.MsgSend",
    "/cosmwasm.wasm.v1.MsgExecuteContract",
    // Run-3: these move the granter's funds too, and were shown in the normal colour.
    "/injective.wasmx.v1.MsgExecuteContractCompat",
    "/injective.peggy.v1.MsgSendToEth",
    "/injective.exchange.v2.MsgPrivilegedExecuteContract",
    "/cosmwasm.wasm.v1.MsgInstantiateContract",
    "/injective.exchange.v2.MsgExternalTransfer",
    // A trading grant can trade the funds away.
    "/injective.exchange.v2.MsgCreateSpotMarketOrder",
    // Unknown and future types.
    "/some.future.v1.MsgAnything",
  ]) {
    assert.equal(canMoveFunds(red), true, red);
  }
  assert.equal(canMoveFunds(null), true, "a non-generic grant");
  for (const fine of ["/cosmos.staking.v1beta1.MsgDelegate", "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward", "/cosmos.gov.v1.MsgVote", "/injective.exchange.v2.MsgCancelSpotOrder", "/injective.exchange.v1beta1.MsgBatchCancelDerivativeOrders"]) {
    assert.equal(canMoveFunds(fine), false, fine);
  }
});

test("only order messages are called orderbook trading", () => {
  assert.equal(permissionName("/injective.exchange.v2.MsgCreateSpotLimitOrder"), "Trade on the INJ orderbook");
  assert.equal(permissionName("/injective.exchange.v2.MsgPrivilegedExecuteContract"), "Privileged Execute Contract for you");
  assert.equal(permissionName("/injective.exchange.v2.MsgExternalTransfer"), "External Transfer for you");
});
