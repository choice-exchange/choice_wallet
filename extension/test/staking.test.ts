// Staking through the service: the summary, and each action built by the vault, decoded,
// graded and signed only as reviewed. Against the real WASM vault and a fake chain.

import assert from "node:assert/strict";
import { test } from "node:test";

import { STAKE_RESERVE } from "../src/staking";
import { chain, code, GAS_PRICE, INJ, indexed, ME, ok, VAL_A, VAL_B, VAL_JAILED, wallet } from "./fake";

type Review = { digest: string; display: { messages: Record<string, unknown>[]; fee: { amount: { amount: string }[] } }; risk: { level: string; findings: { rule: string }[] } };
type Summary = {
  staked: string;
  rewards: string;
  unbondingTotal: string;
  stakes: { validator: string; amount: string; rewards: string }[];
  unbonding: { validator: string; height: string }[];
  validators: { address: string; moniker: string; active: boolean; rank: number | null; jailed: boolean }[];
  unbondingDays: number;
};

test("staking summary: stakes, rewards rounded down, unbonding, and validators outside the set", async () => {
  const net = chain();
  net.state.delegations = { [VAL_A]: 2n * INJ, [VAL_JAILED]: 1n * INJ };
  net.state.rewards = { [VAL_A]: "1500000000000000000.9", [VAL_JAILED]: "0.4" };
  net.state.unbonding = [{ validator: VAL_B, amount: 3n * INJ, height: 1234, completes: "2026-11-30T00:00:00Z" }];
  const { service } = await wallet(net);
  const s = ok<Summary>(await service.handle({ type: "staking" }));
  assert.equal(s.staked, (3n * INJ).toString());
  assert.equal(s.rewards, "1500000000000000000");
  assert.equal(s.unbondingTotal, (3n * INJ).toString());
  assert.deepEqual(
    s.stakes.map((x) => [x.validator, x.rewards]),
    [
      [VAL_A, "1500000000000000000"],
      [VAL_JAILED, "0"],
    ],
  );
  assert.deepEqual(
    s.validators.map((v) => [v.moniker, v.rank, v.active]),
    [
      ["Bravo", 1, true],
      ["Alpha", 2, true],
      ["Jailed", null, false],
    ],
  );
  assert.equal(s.unbondingDays, 21);
  assert.deepEqual(net.state.unhandled, []);
});

test("stake: built, graded and signed as reviewed; max keeps a reserve for fees", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service } = await wallet(net);
  const review = ok<Review>(await service.handle({ type: "prepare_stake", action: "stake", validator: VAL_A, amount: "max" }));
  const [m] = review.display.messages;
  assert.equal(m!["type"], "delegate");
  assert.equal(m!["validator"], VAL_A);
  const fee = BigInt(review.display.fee.amount[0]!.amount);
  assert.equal(BigInt((m!["amount"] as { amount: string }).amount), 5n * INJ - fee - STAKE_RESERVE);
  // Staking all you have isn't "most of your balance": only the unbonding note.
  assert.deepEqual(
    review.risk.findings.map((f) => f.rule),
    ["stake"],
  );
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);
  assert.ok(Buffer.from(net.state.broadcasts[0]!, "base64").includes(Buffer.from("/cosmos.staking.v1beta1.MsgDelegate")));

  // Only validators in the active set, not jailed ones; and not more than you hold.
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "stake", validator: VAL_JAILED, amount: "1" })), "bad_request");
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "stake", validator: VAL_A, amount: (6n * INJ).toString() })), "insufficient");
});

test("unstake and move: from the stake, not the balance; fee from the balance", async () => {
  const net = chain({ balances: { inj: INJ / 100n } });
  net.state.delegations = { [VAL_A]: 2n * INJ };
  const { service } = await wallet(net);
  const all = ok<Review>(await service.handle({ type: "prepare_stake", action: "unstake", validator: VAL_A, amount: "max" }));
  assert.equal((all.display.messages[0]!["amount"] as { amount: string }).amount, (2n * INJ).toString());
  assert.deepEqual(
    all.risk.findings.map((f) => f.rule),
    ["unstake"],
  );
  const err = await service.handle({ type: "prepare_stake", action: "unstake", validator: VAL_A, amount: (3n * INJ).toString() });
  assert.equal(code(err), "insufficient");
  assert.match(String((err as { error?: { message: string } }).error?.message), /more than is staked/);
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "unstake", validator: VAL_B, amount: "1" })), "bad_request");

  const move = ok<Review>(await service.handle({ type: "prepare_stake", action: "move", validator: VAL_A, to: VAL_B, amount: INJ.toString() }));
  assert.deepEqual(
    move.display.messages.map((x) => [x["type"], x["from_validator"], x["to_validator"]]),
    [["redelegate", VAL_A, VAL_B]],
  );
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "move", validator: VAL_A, to: VAL_A, amount: "1" })), "bad_request");
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "move", validator: VAL_A, to: VAL_JAILED, amount: "1" })), "bad_request");

  // No INJ for the fee: refused before anything is signed.
  net.state.balances = {};
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "unstake", validator: VAL_A, amount: "1" })), "insufficient");
});

test("claim every reward in one transaction; cancel an unstaking by its height", async () => {
  const net = chain();
  net.state.delegations = { [VAL_A]: INJ, [VAL_B]: INJ };
  const { service } = await wallet(net);
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "claim" })), "bad_request");
  net.state.rewards = { [VAL_A]: "2.0", [VAL_B]: "9.5" };
  const claim = ok<Review>(await service.handle({ type: "prepare_stake", action: "claim" }));
  assert.deepEqual(
    claim.display.messages.map((x) => [x["type"], x["validator"]]),
    [
      ["withdraw_rewards", VAL_B],
      ["withdraw_rewards", VAL_A],
    ],
  );
  assert.equal(claim.risk.level, "info");

  net.state.unbonding = [{ validator: VAL_A, amount: 7n, height: 4321, completes: "2026-11-30T00:00:00Z" }];
  const cancel = ok<Review>(await service.handle({ type: "prepare_stake", action: "cancel", validator: VAL_A, height: "4321" }));
  assert.deepEqual(
    cancel.display.messages.map((x) => [x["type"], x["creation_height"], (x["amount"] as { amount: string }).amount]),
    [["cancel_unbonding", 4321, "7"]],
  );
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "cancel", validator: VAL_A, height: "1" })), "bad_request");
  assert.ok(GAS_PRICE > 0n && ME);
});

test("a watched account can't stake", async () => {
  const { service } = await wallet();
  ok(await service.handle({ type: "add_watch", address: "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v" }));
  assert.equal(code(await service.handle({ type: "prepare_stake", action: "stake", validator: VAL_A, amount: "1" })), "watch_only");
  // It can still see what it has staked.
  ok(await service.handle({ type: "staking" }));
});

test("activity names validators from the active set", async () => {
  const net = chain();
  const BONDED_POOL = "inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3lj7tt0";
  const delegate = {
    ...indexed(130, ME, BONDED_POOL, "1000000000000000000inj"),
    txhash: "D".repeat(64),
  };
  delegate.tx.body.messages = [{ "@type": "/cosmos.staking.v1beta1.MsgDelegate", delegator_address: ME, validator_address: VAL_A, amount: { denom: "inj", amount: "1000000000000000000" } } as never];
  net.state.signedEvm.push(delegate);
  const { service } = await wallet(net);
  const page = ok<{ items: { hash: string; kind: string; counterparty?: string }[]; validators?: Record<string, string> }>(await service.handle({ type: "activity", page: 1 }));
  const row = page.items.find((i) => i.hash === "D".repeat(64));
  assert.deepEqual([row?.kind, row?.counterparty], ["stake", VAL_A]);
  assert.deepEqual(page.validators, { [VAL_A]: "Alpha" });
});
