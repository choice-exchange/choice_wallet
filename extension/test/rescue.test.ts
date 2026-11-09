// The rescue address through the service worker's logic: set, gas from it, and a rescue
// that moves what one transaction can, each built and graded by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, code, INJ, ME, ok, USDT, VAL_A, wallet } from "./fake";

type Status = { accounts: { addresses: Record<string, string>; name: string }[]; active: number };
type Summary = { address: string | null; name?: string; canGrant?: boolean; gas?: { limit: { amount: string }[]; current: boolean } | null; stakesMove?: boolean };
type Review = {
  display: { signer: string; fee: { granter: string | null }; messages: { type: string; [k: string]: unknown }[] };
  risk: { level: string; confirm?: string; findings: { rule: string; message: string }[] };
  rescue?: { to: string; rest: number };
};

const COSMOS = "cosmos:injective-1";

test("a rescue address: another account, gas from it, and a rescue to it", async () => {
  const net = chain({ balances: { inj: 3n * INJ, [USDT]: 2_500_000n } });
  net.state.delegations[VAL_A] = 2n * INJ;
  net.state.rewards[VAL_A] = "50000000000000000000000000000000000";
  const { service } = await wallet(net);
  const two = ok<Status>(await service.handle({ type: "add_account" }));
  const rescue = two.accounts[1]!.addresses[COSMOS]!;
  net.state.funded.add(rescue);
  ok(await service.handle({ type: "switch_account", index: 0 }));

  assert.deepEqual(ok<Summary>(await service.handle({ type: "rescue" })), { address: null });
  assert.equal(code(await service.handle({ type: "set_rescue", address: ME })), "same_account");
  ok(await service.handle({ type: "set_rescue", address: rescue }));
  const s = ok<Summary>(await service.handle({ type: "rescue" }));
  assert.deepEqual([s.address, s.name, s.canGrant, s.gas, s.stakesMove], [rescue, "Account 2", true, null, false]);

  // Gas: signed by the rescue account, for this one; named, amber, nothing to type.
  const g = ok<Review>(await service.handle({ type: "prepare_rescue_grant" }));
  assert.equal(g.display.signer, rescue);
  assert.deepEqual(g.display.messages.map((m) => m.type), ["fee_grant"]);
  assert.deepEqual([g.risk.findings[0]?.rule, g.risk.confirm], ["fee_grant_own", undefined]);

  // The rescue, with INJ for its own fee: rewards there, unstaked (the address isn't on
  // Injective's transfer list), everything in the bank sent; named as the rescue address.
  const r = ok<Review>(await service.handle({ type: "prepare_rescue" }));
  assert.deepEqual(r.rescue, { to: rescue, rest: 0 });
  assert.deepEqual(r.display.messages.map((m) => m.type), ["set_withdraw_address", "withdraw_rewards", "undelegate", "bank_send"]);
  assert.equal(r.display.fee.granter, null);
  const rules = r.risk.findings.map((f) => f.rule);
  assert.ok(rules.includes("withdraw_address_own") && rules.includes("address_book"), rules.join());
  assert.ok(!r.risk.confirm, "nothing to type for a rescue to your own account");
  const sent = r.display.messages[3]!["amount"] as { denom: string; amount: string }[];
  assert.deepEqual(sent.map((c) => c.denom).sort(), ["inj", USDT].sort());

  // No INJ left: without gas from the rescue address it can't pay; with it, it can.
  net.state.balances = { [USDT]: 2_500_000n };
  assert.equal(code(await service.handle({ type: "prepare_rescue" })), "no_gas");
  net.state.issuedBy[rescue] = [
    {
      grantee: ME,
      allowance: {
        "@type": "/cosmos.feegrant.v1beta1.AllowedMsgAllowance",
        allowance: { "@type": "/cosmos.feegrant.v1beta1.BasicAllowance", spend_limit: [{ denom: "inj", amount: "100000000000000000" }], expiration: null },
        allowed_messages: ["/cosmos.bank.v1beta1.MsgSend"],
      },
    },
  ];
  const gasNow = ok<Summary>(await service.handle({ type: "rescue" }));
  assert.equal(gasNow.gas?.current, false, "gas that doesn't cover unstaking is offered for renewal");
  const renew = ok<Review>(await service.handle({ type: "prepare_rescue_grant" }));
  assert.deepEqual(renew.display.messages.map((m) => m.type), ["fee_revoke", "fee_grant"]);
  const onGas = ok<Review>(await service.handle({ type: "prepare_rescue" }));
  assert.equal(onGas.display.fee.granter, rescue);
  assert.deepEqual(onGas.display.messages.map((m) => m.type), ["set_withdraw_address", "withdraw_rewards", "undelegate", "bank_send"]);
});
