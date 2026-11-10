// Governance (`@choice-wallet/chain`'s gov.ts): proposals in voting with the count so far and
// this account's vote, the newest finished ones, and a vote through the usual prepare, review
// and confirm (the vault reads `MsgVote`).
//
// The chain forgets a vote once its proposal's voting ends, so the wallet keeps the votes it
// sent or saw while voting was open (local `votes_cast`, per network and account), to show
// them on finished proposals.

import { bondedTokens, currentTally, NETWORKS, proposal, proposals, voteOf, VOTE_OPTIONS, type NetworkId, type VoteCast, type VoteOptionName } from "@choice-wallet/chain";
import type { AccountInfo, GovView, Result, SendReview } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";
import type { Store } from "./service";
import { fail } from "./util";

type Sender = ReturnType<typeof createSender>;
type Kept = Partial<Record<NetworkId, Record<string, Record<string, VoteCast>>>>;

/** Finished proposals shown, newest first. */
const PAST = 20;
/** Votes kept per account. */
const MAX_KEPT = 200;
const CASTS: readonly string[] = [...VOTE_OPTIONS, "weighted"];

/** Votes, less those on `ids`. */
const without = (votes: Record<string, VoteCast>, ids: readonly string[]) => Object.fromEntries(Object.entries(votes).filter(([id]) => !ids.includes(id)));

export function createGov(d: { sender: Sender; local: Store }) {
  async function kept(network: NetworkId, voter: string): Promise<Record<string, VoteCast>> {
    const { votes_cast } = (await d.local.get(["votes_cast"])) as { votes_cast?: Kept };
    const mine = votes_cast?.[network]?.[voter] ?? {};
    return Object.fromEntries(Object.entries(mine).filter(([id, v]) => /^[1-9][0-9]{0,19}$/.test(id) && CASTS.includes(v)));
  }

  async function keep(network: NetworkId, voter: string, votes: Record<string, VoteCast>): Promise<void> {
    const { votes_cast } = (await d.local.get(["votes_cast"])) as { votes_cast?: Kept };
    const merged = { ...(await kept(network, voter)), ...votes };
    // The newest proposals' votes, when there are too many.
    const ids = Object.keys(merged).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, MAX_KEPT);
    const mine = Object.fromEntries(ids.map((id) => [id, merged[id]!]));
    await d.local.set({ votes_cast: { ...(votes_cast ?? {}), [network]: { ...(votes_cast?.[network] ?? {}), [voter]: mine } } });
  }

  /** Replace an account's kept votes. */
  async function replace(network: NetworkId, voter: string, votes: Record<string, VoteCast>): Promise<void> {
    const { votes_cast } = (await d.local.get(["votes_cast"])) as { votes_cast?: Kept };
    await d.local.set({ votes_cast: { ...(votes_cast ?? {}), [network]: { ...(votes_cast?.[network] ?? {}), [voter]: votes } } });
    await keep(network, voter, {});
  }

  async function summary(network: NetworkId, account: AccountInfo): Promise<Result<GovView>> {
    const me = account.addresses[NETWORKS[network].cosmos] ?? "";
    try {
      const lcd = await d.sender.lcd(network);
      const [voting, recent, bonded] = await Promise.all([proposals(lcd, { voting: true, limit: 20 }), proposals(lcd, { limit: PAST + 20 }), bondedTokens(lcd).catch(() => null)]);
      const open = await Promise.all(
        voting.map(async (p) => {
          const [tally, mine] = await Promise.all([currentTally(lcd, p.id).catch(() => p.tally), me ? voteOf(lcd, p.id, me) : Promise.resolve(null)]);
          return { p: { ...p, tally: tally ?? p.tally }, mine };
        }),
      );
      // While voting is open the chain says how the account voted: what it says is kept, and
      // a kept vote it doesn't have (a vote whose transaction failed) is dropped.
      const seen = Object.fromEntries(open.flatMap((x) => (x.mine ? [[x.p.id, x.mine] as const] : [])));
      const before = me ? await kept(network, me) : {};
      const stale = open.some((x) => !x.mine && before[x.p.id]);
      if (me && (stale || open.some((x) => x.mine && before[x.p.id] !== x.mine))) await replace(network, me, { ...without(before, open.map((x) => x.p.id)), ...seen });
      const votes = { ...without(before, open.map((x) => x.p.id)), ...seen };
      const past = recent.filter((p) => p.status !== "voting" && p.status !== "deposit").slice(0, PAST);
      return { ok: true, result: { voting: open.map((x) => x.p), past, votes, bonded } };
    } catch (e) {
      return d.sender.chainFailure(e);
    }
  }

  /** A vote on a proposal still in voting, to review. */
  async function prepareVote(network: NetworkId, account: AccountInfo, req: { proposal?: unknown; option?: unknown }): Promise<Result<SendReview>> {
    const id = typeof req.proposal === "string" && /^[1-9][0-9]{0,19}$/.test(req.proposal) ? req.proposal : null;
    if (!id) return fail("bad_request", "Which proposal?");
    if (!VOTE_OPTIONS.includes(req.option as VoteOptionName)) return fail("bad_request", "Vote yes, no, abstain or no with veto.");
    const option = req.option as VoteOptionName;
    try {
      const p = await proposal(await d.sender.lcd(network), id);
      if (!p) return fail("not_found", `There's no proposal ${id}.`);
      if (p.status !== "voting") return fail("closed", `Voting on proposal ${id} has ended.`);
    } catch (e) {
      return d.sender.chainFailure(e);
    }
    return d.sender.prepareCosmos(network, account, {
      denom: NETWORKS[network].feeDenom,
      amount: "0",
      noAmount: true,
      messages: () => [{ type: "vote", proposal: id, option }],
      vote: { proposal: id, option },
    });
  }

  /** A vote this wallet just broadcast: kept for when the chain no longer has it. */
  async function voted(network: NetworkId, voter: string, vote: { proposal: string; option: string }): Promise<void> {
    if (/^[1-9][0-9]{0,19}$/.test(vote.proposal) && VOTE_OPTIONS.includes(vote.option as VoteOptionName)) await keep(network, voter, { [vote.proposal]: vote.option as VoteOptionName });
  }

  return { summary, prepareVote, voted };
}
