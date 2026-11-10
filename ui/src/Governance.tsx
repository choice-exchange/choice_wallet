// Governance, the Stake tab's second pane: proposals in voting, with the count so far and this
// account's vote, and the newest finished ones with their result. A proposal opens with its
// text and the votes; a vote goes to the same review as a send (the vault reads `MsgVote`).

import { formatShort } from "@choice-wallet/chain";
import { useState, type ReactNode } from "react";

import { ChevronRightIcon } from "./icons";
import { BackBar, Callout, Screen } from "./kit";
import { useKept } from "./kept";
import type { Proposal, SendReview, VoteCast, VoteOptionName } from "./protocol";
import { useRequest } from "./request";
import { VOTE_LABEL } from "./Send";
import { StakeScreen } from "./Staking";

const STATUS_LABEL: Record<Proposal["status"], string> = { deposit: "Deposit period", voting: "Voting", passed: "Passed", rejected: "Rejected", failed: "Failed" };
const OPTIONS: readonly VoteOptionName[] = ["yes", "no", "abstain", "no_with_veto"];
/** Characters of a proposal's text shown before "Show all". */
const FOLD = 700;

const castLabel = (v: VoteCast) => (v === "weighted" ? "Split" : VOTE_LABEL[v]);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(new Date(iso).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) }) : "";

export function GovernanceView({
  canSign,
  staked,
  tabs,
  head,
  onReview,
}: {
  canSign: boolean;
  /** INJ staked now: a vote's weight. */
  staked: bigint;
  tabs: ReactNode;
  head: ReactNode;
  /** The review, with the proposal's title by ID. */
  onReview: (review: SendReview, titles: Record<string, string>) => void;
}) {
  const { value: gov, error } = useKept({ type: "governance" });
  const [open, setOpen] = useState<string | null>(null);
  const shown = open ? [...(gov?.voting ?? []), ...(gov?.past ?? [])].find((p) => p.id === open) : undefined;
  if (shown && gov) {
    return <ProposalScreen p={shown} mine={gov.votes[shown.id]} bonded={gov.bonded} canSign={canSign} staked={staked} onReview={onReview} onBack={() => setOpen(null)} />;
  }
  const row = (p: Proposal) => {
    const mine = gov?.votes[p.id];
    const sub = p.status === "voting" ? `Ends ${when(p.votingEnd)} · ${mine ? `You voted ${castLabel(mine)}` : "Not voted"}` : `${STATUS_LABEL[p.status]}${mine ? ` · You voted ${castLabel(mine)}` : ""}`;
    return (
      <button key={p.id} className="token proposal-row" onClick={() => setOpen(p.id)}>
        <span className="proposal-id">{p.id}</span>
        <span className="name">
          <span className="symbol">{p.title}</span>
          <span className="sub">{sub}</span>
        </span>
        <ChevronRightIcon size={16} />
      </button>
    );
  };
  return (
    <StakeScreen tabs={tabs} head={head}>
      {error && <Callout level="amber">{error}</Callout>}
      {!gov && !error && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 52 }} />)}
      {gov && (
        <>
          <div className="section-head">
            <span className="eyebrow">Voting now</span>
          </div>
          {gov.voting.length === 0 ? <p className="empty">No proposal is in voting.</p> : <div className="token-list">{gov.voting.map(row)}</div>}
          <div className="section-head">
            <span className="eyebrow">Past</span>
          </div>
          <div className="token-list">{gov.past.map(row)}</div>
          <p className="footnote">Your votes on past proposals are the ones this wallet saw or sent.</p>
        </>
      )}
    </StakeScreen>
  );
}

function ProposalScreen({
  p,
  mine,
  bonded,
  canSign,
  staked,
  onReview,
  onBack,
}: {
  p: Proposal;
  mine: VoteCast | undefined;
  bonded: string | null;
  canSign: boolean;
  staked: bigint;
  onReview: (review: SendReview, titles: Record<string, string>) => void;
  onBack: () => void;
}) {
  const { run, error, busy } = useRequest();
  const [all, setAll] = useState(false);
  const voting = p.status === "voting";
  const t = p.tally;
  const counts: [VoteOptionName, bigint][] = t ? [["yes", BigInt(t.yes)], ["no", BigInt(t.no)], ["no_with_veto", BigInt(t.noWithVeto)], ["abstain", BigInt(t.abstain)]] : [];
  const total = counts.reduce((s, [, n]) => s + n, 0n);
  const pct = (n: bigint, of: bigint) => (of > 0n ? Number((n * 10000n) / of) / 100 : 0);
  const turnout = bonded && BigInt(bonded) > 0n ? pct(total, BigInt(bonded)) : null;
  const text = all || p.summary.length <= FOLD ? p.summary : `${p.summary.slice(0, FOLD).trimEnd()}…`;

  async function vote(option: VoteOptionName) {
    const r = await run({ type: "prepare_vote", proposal: p.id, option });
    if (r) onReview(r, { [p.id]: p.title });
  }

  return (
    <Screen
      top={<BackBar title={`Proposal ${p.id}`} onBack={onBack} />}
      foot={
        voting && canSign ? (
          <>
            {error && <Callout level="amber">{error}</Callout>}
            <div className="vote-grid">
              {OPTIONS.map((o) => (
                <button key={o} className={o === "yes" ? "btn btn-gold" : "btn"} disabled={busy} onClick={() => void vote(o)}>
                  {VOTE_LABEL[o]}
                </button>
              ))}
            </div>
          </>
        ) : undefined
      }
    >
      <div className="surface-hero">
        <div className="eyebrow">
          {STATUS_LABEL[p.status]}
          {p.expedited ? " · Expedited" : ""}
        </div>
        <div className="proposal-title">{p.title}</div>
        <p className="meta" style={{ marginTop: 6 }}>
          {voting ? `Voting ends ${when(p.votingEnd)}` : p.votingEnd ? `Voting ended ${when(p.votingEnd)}` : ""}
        </p>
        {p.failedReason && <p className="meta warn">It passed, but running it failed: {p.failedReason}</p>}
      </div>
      {t && (
        <div className="well rows">
          {counts.map(([o, n]) => (
            <div key={o} className="tally-row">
              <span>{VOTE_LABEL[o]}</span>
              <span className="tally-bar">
                <span className={`tally-fill ${o}`} style={{ width: `${pct(n, total)}%` }} />
              </span>
              <span className="num">{pct(n, total).toFixed(1)}%</span>
            </div>
          ))}
          <div className="row">
            <span>{voting ? "Votes so far" : "Votes"}</span>
            <span className="num">
              {formatShort(total, 18, 0)} INJ{turnout !== null ? ` · ${turnout.toFixed(1)}% turnout` : ""}
            </span>
          </div>
        </div>
      )}
      <p className="lead" style={{ margin: "4px 0" }}>
        {mine ? `You voted ${castLabel(mine)}.` : voting ? "You haven't voted." : "No vote from this wallet."}
      </p>
      {voting && canSign && staked === 0n && <p className="meta warn">You have no stake, so your vote carries no weight. Stake INJ to vote with it.</p>}
      {voting && canSign && mine && <p className="meta">Voting again replaces your vote.</p>}
      {p.summary && (
        <>
          <div className="proposal-text">{text}</div>
          {p.summary.length > FOLD && (
            <button className="link" onClick={() => setAll(!all)}>
              {all ? "Show less" : "Show all"}
            </button>
          )}
        </>
      )}
    </Screen>
  );
}
