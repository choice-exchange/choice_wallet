// Governance through the service worker's logic: proposals in voting with the count so far and
// this account's vote, the newest finished ones, and a vote read by the vault, graded, signed,
// sent, and kept for when the chain forgets it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, code, INJ, ME, ok, proposalRecord, THEM, wallet } from "./fake";

type Gov = { voting: { id: string; status: string; tally: { yes: string } | null }[]; past: { id: string; status: string }[]; votes: Record<string, string>; bonded: string | null };
type Review = { digest: string; display: { messages: Record<string, unknown>[] }; risk: { level: string; findings: { rule: string }[] } };

const VOTING = "PROPOSAL_STATUS_VOTING_PERIOD";

test("governance: proposals in voting with the count so far, the newest finished ones, INJ bonded", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  net.state.gov.proposals = [proposalRecord("714", VOTING), proposalRecord("713", "PROPOSAL_STATUS_PASSED"), proposalRecord("712", "PROPOSAL_STATUS_DEPOSIT_PERIOD"), proposalRecord("711", "PROPOSAL_STATUS_REJECTED")];
  net.state.gov.tallies["714"] = { yes_count: "42", abstain_count: "0", no_count: "1", no_with_veto_count: "0" };
  net.state.gov.votes[`714 ${ME}`] = "VOTE_OPTION_ABSTAIN";
  const { service } = await wallet(net);
  const g = ok<Gov>(await service.handle({ type: "governance" }));
  assert.deepEqual(g.voting.map((p) => [p.id, p.tally?.yes]), [["714", "42"]]);
  assert.deepEqual(g.past.map((p) => [p.id, p.status]), [["713", "passed"], ["711", "rejected"]]);
  assert.deepEqual(g.votes, { "714": "abstain" });
  assert.equal(g.bonded, (1000n * INJ).toString());
});

test("a vote: read by the vault, graded, signed and sent; the chain's word while voting is open, the wallet's after", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  net.state.gov.proposals = [proposalRecord("714", VOTING), proposalRecord("713", "PROPOSAL_STATUS_PASSED")];
  const { service } = await wallet(net);
  const review = ok<Review>(await service.handle({ type: "prepare_vote", proposal: "714", option: "no_with_veto" }));
  assert.deepEqual(review.display.messages, [{ type: "vote", voter: ME, proposal_id: 714, option: "no_with_veto", metadata: "" }]);
  assert.deepEqual([review.risk.level, review.risk.findings.map((f) => f.rule)], ["info", ["vote"]]);
  // Only on a proposal in voting, with one of the four options.
  assert.equal(code(await service.handle({ type: "prepare_vote", proposal: "713", option: "yes" })), "closed");
  assert.equal(code(await service.handle({ type: "prepare_vote", proposal: "99", option: "yes" })), "not_found");
  assert.equal(code(await service.handle({ type: "prepare_vote", proposal: "714", option: "maybe" })), "bad_request");
  assert.equal(code(await service.handle({ type: "prepare_vote", proposal: "0714", option: "yes" })), "bad_request");

  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);
  assert.ok(Buffer.from(net.state.broadcasts[0]!, "base64").includes(Buffer.from("/cosmos.gov.v1beta1.MsgVote")));
  // While voting is open the chain says: it has the vote, and the wallet keeps it.
  net.state.gov.votes[`714 ${ME}`] = "VOTE_OPTION_NO_WITH_VETO";
  assert.deepEqual(ok<Gov>(await service.handle({ type: "governance" })).votes, { "714": "no_with_veto" });
  // Voting ends; the chain forgets the vote; the wallet still shows it.
  delete net.state.gov.votes[`714 ${ME}`];
  net.state.gov.proposals[0] = proposalRecord("714", "PROPOSAL_STATUS_PASSED");
  assert.deepEqual(ok<Gov>(await service.handle({ type: "governance" })).votes, { "714": "no_with_veto" });

  // A vote kept that the chain doesn't have while voting is open (its transaction failed) goes.
  net.state.gov.proposals.unshift(proposalRecord("715", VOTING));
  const again = ok<Review>(await service.handle({ type: "prepare_vote", proposal: "715", option: "yes" }));
  ok(await service.handle({ type: "confirm_send", digest: again.digest }));
  assert.deepEqual(ok<Gov>(await service.handle({ type: "governance" })).votes, { "714": "no_with_veto" });

  // A watched account can read, not vote.
  ok(await service.handle({ type: "add_watch", address: THEM }));
  assert.equal(code(await service.handle({ type: "prepare_vote", proposal: "715", option: "yes" })), "watch_only");
});
