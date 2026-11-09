// The review's reading of a decode: sends, conversions, and everything else. Message shapes
// as the vault decodes them (crates/cosmos `Msg`, `ContractCall`).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CosmosDisplay } from "../src/protocol.ts";
import { shown } from "../src/review.ts";

// The BIP-39 test phrase's account and the EIP-155 example key's (both published).
const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const THEM = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
// SHROOM's CW20 and the mainnet CW20 adapter (published contracts).
const CW = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
const BANK = `factory/${ADAPTER}/${CW}`;

const tx = (messages: CosmosDisplay["messages"]): CosmosDisplay => ({
  kind: "cosmos_direct",
  chain: "cosmos:injective-1",
  signer: ME,
  memo: "",
  fee: { amount: [{ denom: "inj", amount: "100" }], gas_limit: "200000", granter: null, payer: null },
  messages,
});
const exec = (contract: string, call: Record<string, unknown>, funds: { denom: string; amount: string }[] = []) => ({
  type: "execute_contract",
  sender: ME,
  contract,
  funds,
  json: "{}",
  call,
});

test("a bank send and a CW20 transfer are both sends", () => {
  const v = shown(tx([{ type: "bank_send", from: ME, to: THEM, amount: [{ denom: "inj", amount: "5" }] }, exec(CW, { type: "cw20_transfer", recipient: THEM, amount: "7" })]), "mainnet");
  assert.deepEqual(v.sends, [
    { coins: [{ denom: "inj", amount: "5" }], to: THEM },
    { coins: [{ denom: `cw20:${CW}`, amount: "7" }], to: THEM },
  ]);
  assert.deepEqual(v.converts, []);
  assert.deepEqual(v.others, []);
  assert.deepEqual(v.fee, [{ denom: "inj", amount: "100" }]);
});

test("adapter conversions, both ways, only through this network's adapter", () => {
  const toBank = shown(tx([exec(CW, { type: "cw20_send", contract: ADAPTER, amount: "9", msg: "" })]), "mainnet");
  assert.deepEqual(toBank.converts, [{ from: { denom: `cw20:${CW}`, amount: "9" }, to: { denom: BANK, amount: "9" }, recipient: ME }]);
  assert.deepEqual(toBank.sends, []);

  const back = shown(tx([exec(ADAPTER, { type: "adapter_redeem", recipient: null }, [{ denom: BANK, amount: "4" }])]), "mainnet");
  assert.deepEqual(back.converts, [{ from: { denom: BANK, amount: "4" }, to: { denom: `cw20:${CW}`, amount: "4" }, recipient: ME }]);
  const elsewhere = shown(tx([exec(ADAPTER, { type: "adapter_redeem", recipient: THEM }, [{ denom: BANK, amount: "4" }])]), "mainnet");
  assert.equal(elsewhere.converts[0]?.recipient, THEM);

  // The same shapes anywhere else are contract calls: a CW20 sent to another contract, with
  // a message for it, or the adapter of another network.
  for (const [d, net] of [
    [tx([exec(CW, { type: "cw20_send", contract: THEM, amount: "9", msg: "" })]), "mainnet"],
    [tx([exec(CW, { type: "cw20_send", contract: ADAPTER, amount: "9", msg: "eyJ4Ijp7fX0=" })]), "mainnet"],
    [tx([exec(CW, { type: "cw20_send", contract: ADAPTER, amount: "9", msg: "" })]), "testnet"],
    [tx([exec(ADAPTER, { type: "adapter_redeem", recipient: null }, [{ denom: "inj", amount: "4" }])]), "mainnet"],
  ] as const) {
    const v = shown(d, net);
    assert.deepEqual(v.converts, [], JSON.stringify(d.messages));
    assert.equal(v.others.length, 1);
    assert.match(v.others[0]!, /^Contract call to inj1/);
  }
});

test("anything else is named, never dropped", () => {
  const v = shown(tx([exec(CW, { type: "other" }), { type: "authz_grant", granter: ME, grantee: THEM }]), "mainnet");
  assert.deepEqual(v.others, [`Contract call to ${CW}`, "authz_grant"]);
});

test("EVM: the fee is gas limit × max fee, an ERC20 transfer is a send", () => {
  const v = shown(
    {
      kind: "evm_transaction",
      chain: "eip155:1776",
      from: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      to: "0xb0D94f200998997cf8175Ae7ddF039927A8B3EF4",
      value: "0",
      nonce: "3",
      gas_limit: "55892",
      max_fee_per_gas: "160000000",
      max_priority_fee_per_gas: "0",
      max_gas_cost: "8942720000000",
      data: "0x",
      call: { type: "erc20_transfer", to: "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F", amount: "250" },
    },
    "mainnet",
  );
  assert.deepEqual(v.sends, [{ coins: [{ denom: "evm:0xb0d94f200998997cf8175ae7ddf039927a8b3ef4", amount: "250" }], to: "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F" }]);
  assert.deepEqual(v.fee, [{ denom: "inj", amount: "8942720000000" }]);
  assert.equal(v.evm, true);
});

test("staking: the signer's own actions are staking lines; someone else's are named", () => {
  const A = "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q";
  const B = "injvaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz7c964k";
  const coin = { denom: "inj", amount: "5" };
  const v = shown(
    tx([
      { type: "delegate", delegator: ME, validator: A, amount: coin },
      { type: "redelegate", delegator: ME, from_validator: A, to_validator: B, amount: coin },
      { type: "withdraw_rewards", delegator: ME, validator: B },
      { type: "undelegate", delegator: THEM, validator: A, amount: coin },
    ]),
    "mainnet",
  );
  assert.deepEqual(v.stakes, [
    { kind: "stake", validator: A, amount: coin },
    { kind: "move", validator: A, to: B, amount: coin },
    { kind: "claim", validator: B },
  ]);
  assert.deepEqual(v.others, ["undelegate"]);
});

test("revokes: grants, fee allowances, the rewards address and allowances taken back", () => {
  const v = shown(
    tx([
      { type: "authz_revoke", granter: ME, grantee: THEM, msg_type_url: "/cosmos.bank.v1beta1.MsgSend" },
      { type: "fee_revoke", granter: ME, grantee: THEM },
      { type: "set_withdraw_address", delegator: ME, withdraw_address: ME },
      exec(CW, { type: "cw20_decrease_allowance", spender: THEM, amount: "5" }),
      // Pointing rewards elsewhere is not a revoke.
      { type: "set_withdraw_address", delegator: ME, withdraw_address: THEM },
    ]),
    "mainnet",
  );
  assert.deepEqual(v.revokes, [
    { kind: "grant", grantee: THEM, msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend" },
    { kind: "fee", grantee: THEM },
    { kind: "rewards" },
    { kind: "allowance", token: `cw20:${CW}`, spender: THEM },
  ]);
  assert.deepEqual(v.others, ["set_withdraw_address"]);
  const spender = "4444444444444444444444444444444444444444";
  const evm = shown(
    {
      kind: "evm_transaction",
      chain: "eip155:1776",
      from: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
      to: "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4",
      value: "0",
      data: `0x095ea7b3${spender.padStart(64, "0")}${"0".repeat(64)}`,
      call: { type: "contract", selector: "0x095ea7b3" },
      max_gas_cost: "1",
    } as never,
    "mainnet",
  );
  assert.deepEqual(evm.revokes, [{ kind: "allowance", token: "evm:0xb0d94f200998997cf8175ae7ddf039927a8b3ef4", spender: `0x${spender}` }]);
});
