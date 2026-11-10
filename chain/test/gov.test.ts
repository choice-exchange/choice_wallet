// Governance reads. Bodies follow what Injective mainnet sent on 2026-11-10 (proposal 713).

import assert from "node:assert/strict";
import { test } from "node:test";

import { currentTally, proposal, proposalOf, proposals, voteOf } from "../src/gov.ts";
import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import type { Fetch } from "../src/pool.ts";

const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  messages: [{ "@type": "/cosmos.gov.v1.MsgExecLegacyContent", content: { "@type": "/injective.exchange.v1beta1.SpotMarketLaunchProposal", title: "legacy" } }],
  status: "PROPOSAL_STATUS_PASSED",
  final_tally_result: { yes_count: "12971243466484350947227488", abstain_count: "11631025806473731066726986", no_count: "3451881412540521168059", no_with_veto_count: "14632554734050976318" },
  submit_time: "2026-11-01T10:00:00.000000000Z",
  voting_start_time: "2026-11-01T10:00:00.000000000Z",
  voting_end_time: "2026-11-05T10:00:00.000000000Z",
  metadata: "",
  title: "OLP Reward Disbursement – Epoch 64",
  summary: "Pays the epoch's rewards.\n\n\n\nDetails‮ below.",
  proposer: ME,
  expedited: false,
  failed_reason: "",
  ...extra,
});

test("a proposal as the LCD gives it, cleaned; anything else refused", () => {
  assert.deepEqual(proposalOf(record("713")), {
    id: "713",
    title: "OLP Reward Disbursement – Epoch 64",
    summary: "Pays the epoch's rewards.\n\nDetails below.",
    status: "passed",
    votingStart: "2026-11-01T10:00:00.000000000Z",
    votingEnd: "2026-11-05T10:00:00.000000000Z",
    expedited: false,
    tally: { yes: "12971243466484350947227488", abstain: "11631025806473731066726986", no: "3451881412540521168059", noWithVeto: "14632554734050976318" },
  });
  // An old one titled only in its legacy content; one that failed says why.
  const legacy = proposalOf(record("12", { title: "", summary: "", status: "PROPOSAL_STATUS_FAILED", failed_reason: "out of gas" }))!;
  assert.deepEqual([legacy.title, legacy.status, legacy.failedReason], ["legacy", "failed", "out of gas"]);
  // While voting, no final tally yet (zeros), and no end before it starts.
  const open = proposalOf(record("714", { status: "PROPOSAL_STATUS_VOTING_PERIOD", final_tally_result: { yes_count: "0", abstain_count: "0", no_count: "0", no_with_veto_count: "0" }, voting_end_time: "0001-01-01T00:00:00Z" }))!;
  assert.deepEqual([open.status, open.votingEnd, open.tally?.yes], ["voting", null, "0"]);
  for (const bad of [null, {}, record("0"), record("07"), record("x"), record("1", { status: "PROPOSAL_STATUS_UNSPECIFIED" })]) {
    assert.equal(proposalOf(bad), null, JSON.stringify(bad));
  }
});

test("the newest proposals, the tally so far, and how an account voted while voting is open", async () => {
  const asked: string[] = [];
  const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fetch: Fetch = (input) => {
    const u = new URL(input);
    asked.push(`${u.pathname}${u.search}`);
    const p = u.pathname;
    if (p.endsWith("/node_info")) return reply(200, { default_node_info: { network: "injective-1" } });
    if (p === "/cosmos/gov/v1/proposals") {
      const voting = u.searchParams.get("proposal_status") === "PROPOSAL_STATUS_VOTING_PERIOD";
      return reply(200, { proposals: voting ? [record("714", { status: "PROPOSAL_STATUS_VOTING_PERIOD" })] : [record("712"), record("714", { status: "PROPOSAL_STATUS_VOTING_PERIOD" }), record("713"), { id: "bad" }] });
    }
    if (p === "/cosmos/gov/v1/proposals/714/tally") return reply(200, { tally: { yes_count: "5", abstain_count: "0", no_count: "2", no_with_veto_count: "0" } });
    if (p === "/cosmos/gov/v1/proposals/714") return reply(200, { proposal: record("714", { status: "PROPOSAL_STATUS_VOTING_PERIOD" }) });
    if (p === `/cosmos/gov/v1/proposals/714/votes/${ME}`) return reply(200, { vote: { proposal_id: "714", voter: ME, options: [{ option: "VOTE_OPTION_NO_WITH_VETO", weight: "1.000000000000000000" }], metadata: "" } });
    if (p === `/cosmos/gov/v1/proposals/713/votes/${ME}`) return reply(404, { code: 5, message: `rpc error: code = NotFound desc = voter: ${ME} not found for proposal: 713: key not found`, details: [] });
    if (p === "/cosmos/gov/v1/proposals/99") return reply(404, { code: 5, message: "proposal 99 doesn't exist: key not found", details: [] });
    return reply(404, { code: 12, message: "Not Implemented" });
  };
  const lcd = new Lcd(NETWORKS.mainnet, ["https://a.example"], fetch, 1000);
  assert.deepEqual((await proposals(lcd, { limit: 20 })).map((p) => p.id), ["714", "713", "712"]);
  assert.ok(asked.at(-1)!.includes("pagination.reverse=true"));
  assert.deepEqual((await proposals(lcd, { voting: true, limit: 20 })).map((p) => [p.id, p.status]), [["714", "voting"]]);
  assert.deepEqual(await currentTally(lcd, "714"), { yes: "5", abstain: "0", no: "2", noWithVeto: "0" });
  assert.equal(await voteOf(lcd, "714", ME), "no_with_veto");
  assert.equal(await voteOf(lcd, "713", ME), null);
  assert.equal((await proposal(lcd, "714"))?.status, "voting");
  assert.equal(await proposal(lcd, "99"), null);
});
