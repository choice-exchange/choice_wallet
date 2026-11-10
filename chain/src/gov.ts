// Governance, from the user's LCD (cosmos-sdk gov v1): proposals, their tallies, and how an
// account voted. The chain keeps a vote only while its proposal's voting is open; after
// that, only the tally is left.

import type { Lcd } from "./lcd.ts";
import { ChainError, isObject } from "./pool.ts";
import { cleanText } from "./tokens.ts";

export type ProposalStatus = "deposit" | "voting" | "passed" | "rejected" | "failed";
export type VoteOptionName = "yes" | "abstain" | "no" | "no_with_veto";
/** How an account voted: one option, or several by weight (`weighted`). */
export type VoteCast = VoteOptionName | "weighted";

/** Votes counted, in base units of the staking token (INJ, 18 decimals). */
export interface Tally {
  yes: string;
  abstain: string;
  no: string;
  noWithVeto: string;
}

export interface Proposal {
  id: string;
  title: string;
  /** The proposer's text: plain lines, as written (often Markdown). */
  summary: string;
  status: ProposalStatus;
  votingStart: string | null;
  votingEnd: string | null;
  expedited: boolean;
  /** The final tally once voting ends; while it runs, the chain's current count. */
  tally: Tally | null;
  /** Why a passed proposal's messages failed, if they did. */
  failedReason?: string;
}

export const VOTE_OPTIONS: readonly VoteOptionName[] = ["yes", "no", "abstain", "no_with_veto"];

const STATUS: Record<string, ProposalStatus> = {
  PROPOSAL_STATUS_DEPOSIT_PERIOD: "deposit",
  PROPOSAL_STATUS_VOTING_PERIOD: "voting",
  PROPOSAL_STATUS_PASSED: "passed",
  PROPOSAL_STATUS_REJECTED: "rejected",
  PROPOSAL_STATUS_FAILED: "failed",
};
const OPTION: Record<string, VoteOptionName> = {
  VOTE_OPTION_YES: "yes",
  VOTE_OPTION_ABSTAIN: "abstain",
  VOTE_OPTION_NO: "no",
  VOTE_OPTION_NO_WITH_VETO: "no_with_veto",
};
/** The most of a proposal's text kept. */
const MAX_SUMMARY = 6000;

const uint = (v: unknown): string => (typeof v === "string" && /^[0-9]{1,40}$/.test(v) ? v.replace(/^0+(?=.)/, "") : "0");
const time = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v) && !v.startsWith("0001") ? v : null);

/** Several lines of someone else's text, each cleaned like a token name. */
function cleanLines(s: string, max: number): string {
  const text = s
    .split(/\r?\n/)
    .map((l) => cleanText(l, 1000))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tallyOf(v: unknown): Tally | null {
  if (!isObject(v)) return null;
  return { yes: uint(v["yes_count"]), abstain: uint(v["abstain_count"]), no: uint(v["no_count"]), noWithVeto: uint(v["no_with_veto_count"]) };
}

/** One proposal as the LCD gives it, checked: null if it isn't one. */
export function proposalOf(p: unknown): Proposal | null {
  if (!isObject(p) || typeof p["id"] !== "string" || !/^[1-9][0-9]{0,19}$/.test(p["id"])) return null;
  const status = STATUS[String(p["status"])];
  if (!status) return null;
  // Older proposals carry their title inside a legacy content message.
  const messages = Array.isArray(p["messages"]) ? p["messages"] : [];
  const legacy = messages.map((m) => (isObject(m) && isObject(m["content"]) ? m["content"] : null)).find((c) => c !== null);
  const title = typeof p["title"] === "string" && p["title"].trim() ? p["title"] : typeof legacy?.["title"] === "string" ? legacy["title"] : "";
  const summary = typeof p["summary"] === "string" && p["summary"].trim() ? p["summary"] : typeof legacy?.["description"] === "string" ? legacy["description"] : "";
  const tally = tallyOf(p["final_tally_result"]);
  const failed = typeof p["failed_reason"] === "string" ? cleanText(p["failed_reason"], 300) : "";
  return {
    id: p["id"],
    title: cleanText(title, 140) || `Proposal ${p["id"]}`,
    summary: cleanLines(summary, MAX_SUMMARY),
    status,
    votingStart: time(p["voting_start_time"]),
    votingEnd: time(p["voting_end_time"]),
    expedited: p["expedited"] === true,
    tally,
    ...(failed ? { failedReason: failed } : {}),
  };
}

/** The newest proposals first, `limit` of them; only those in voting with `voting`. */
export async function proposals(lcd: Lcd, opts: { voting?: boolean; limit: number }): Promise<Proposal[]> {
  const status = opts.voting ? "&proposal_status=PROPOSAL_STATUS_VOTING_PERIOD" : "";
  const body = await lcd.get(`/cosmos/gov/v1/proposals?pagination.limit=${opts.limit}&pagination.reverse=true${status}`);
  const list = isObject(body) && Array.isArray(body["proposals"]) ? body["proposals"] : [];
  return list
    .map(proposalOf)
    .filter((p): p is Proposal => p !== null)
    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

/** One proposal, or null if the chain has none by that ID. */
export async function proposal(lcd: Lcd, id: string): Promise<Proposal | null> {
  try {
    const body = await lcd.get(`/cosmos/gov/v1/proposals/${encodeURIComponent(id)}`);
    return isObject(body) ? proposalOf(body["proposal"]) : null;
  } catch (e) {
    if (e instanceof ChainError) return null;
    throw e;
  }
}

/** A proposal's count so far, while its voting runs. */
export async function currentTally(lcd: Lcd, id: string): Promise<Tally | null> {
  const body = await lcd.get(`/cosmos/gov/v1/proposals/${encodeURIComponent(id)}/tally`);
  return isObject(body) ? tallyOf(body["tally"]) : null;
}

/** How `voter` voted on a proposal still in voting; null when it hasn't (or voting ended:
 *  the chain no longer has it). */
export async function voteOf(lcd: Lcd, id: string, voter: string): Promise<VoteCast | null> {
  let body: unknown;
  try {
    body = await lcd.get(`/cosmos/gov/v1/proposals/${encodeURIComponent(id)}/votes/${encodeURIComponent(voter)}`);
  } catch (e) {
    if (e instanceof ChainError) return null;
    throw e;
  }
  const vote = isObject(body) && isObject(body["vote"]) ? body["vote"] : null;
  if (!vote || vote["voter"] !== voter) return null;
  const options = Array.isArray(vote["options"]) ? vote["options"].filter(isObject) : [];
  if (options.length !== 1) return options.length > 1 ? "weighted" : null;
  return OPTION[String(options[0]!["option"])] ?? null;
}

/** INJ bonded to validators, which turnout is a share of. */
export async function bondedTokens(lcd: Lcd): Promise<string | null> {
  const body = await lcd.get("/cosmos/staking/v1beta1/pool");
  return isObject(body) && isObject(body["pool"]) ? uint(body["pool"]["bonded_tokens"]) : null;
}
