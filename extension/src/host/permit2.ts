// Permit2: who else could take a token of the account's through it, once Permit2 holds an
// ERC20 allowance for that token (run-5). The wallet's own swap asks before its approve step,
// and a site's approve(token, Permit2) is weighed with the answer, from one place so the two
// can't drift. Two kinds of holder:
//
// - a spender Permit2 already lets spend the token: found from the EVM index's Permit2 logs,
//   then confirmed on chain;
// - the spender of a Permit2 permit this wallet signed and that may not have been used: an
//   unused permit leaves no log, so the wallet keeps one record of each it signs (the token,
//   spender, nonce and deadline, by account and chain) until it ends or the chain shows it
//   used. A permit signed with this key elsewhere isn't known here, and Approvals says so.

import { isObject, type EvmIndex, type EvmRpc } from "@choice-wallet/chain";

import type { Store } from "./service";
import type { Turn } from "./util";

/** Permit2's one address on every chain. */
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
/** Records kept per account and chain; the oldest go first. */
const MAX_RECORDS = 200;
/** Candidates checked on chain at once. */
const MAX_CHECKS = 50;

/** One permit this wallet signed: AllowanceTransfer (`allowance`, used at the pair's nonce)
 *  or SignatureTransfer (`transfer`, one-off, its nonce a bit in Permit2's bitmap). */
export interface Permit2Permit {
  token: string;
  spender: string;
  kind: "allowance" | "transfer";
  /** Decimal: the pair's nonce (allowance) or the unordered nonce (transfer). */
  nonce: string;
  /** Unix seconds after which it can't be used (its sigDeadline, or deadline). */
  deadline: number;
  /** What it lets the spender take, base units (decimal). */
  amount: string;
}

type Records = Record<string, Permit2Permit[]>;
const key = (chain: string, owner: string) => `${chain} ${owner}`.toLowerCase();

const PRIMARY = new Set(["PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitWitnessTransferFrom", "PermitBatchWitnessTransferFrom"]);

/** The permits a Permit2 typed-data signature gives, and the chain it is for (`eip155:<id>`);
 *  none for anything else. Only Permit2's own address is read: the swap and Approvals read
 *  it alone. */
export function permitsOf(typed: unknown): { chain: string; permits: Permit2Permit[] } | null {
  let td: unknown = typed;
  if (typeof td === "string") {
    try {
      td = JSON.parse(td);
    } catch {
      return null;
    }
  }
  if (!isObject(td) || !isObject(td["domain"]) || !isObject(td["message"]) || typeof td["primaryType"] !== "string") return null;
  const domain = td["domain"];
  const m = td["message"];
  if (domain["name"] !== "Permit2" || !PRIMARY.has(td["primaryType"]) || String(domain["verifyingContract"] ?? "").toLowerCase() !== PERMIT2) return null;
  const id = uint(domain["chainId"]);
  const spender = addr(m["spender"]);
  if (id === null || id === 0n || !spender) return null;
  const out: Permit2Permit[] = [];
  const primary = td["primaryType"];
  if (primary === "PermitSingle" || primary === "PermitBatch") {
    // AllowanceTransfer: each detail has its own token, amount and nonce.
    const deadline = uint(m["sigDeadline"]);
    const details = primary === "PermitSingle" ? [m["details"]] : Array.isArray(m["details"]) ? m["details"] : [];
    for (const d of details) {
      if (!isObject(d)) continue;
      const [token, amount, nonce] = [addr(d["token"]), uint(d["amount"]), uint(d["nonce"])];
      if (token && amount !== null && nonce !== null && deadline !== null) out.push({ token, spender, kind: "allowance", nonce: nonce.toString(), deadline: seconds(deadline), amount: amount.toString() });
    }
  } else {
    // SignatureTransfer: one nonce for every token it permits.
    const [nonce, deadline] = [uint(m["nonce"]), uint(m["deadline"])];
    const permitted = Array.isArray(m["permitted"]) ? m["permitted"] : [m["permitted"]];
    for (const p of permitted) {
      if (!isObject(p)) continue;
      const [token, amount] = [addr(p["token"]), uint(p["amount"])];
      if (token && amount !== null && nonce !== null && deadline !== null) out.push({ token, spender, kind: "transfer", nonce: nonce.toString(), deadline: seconds(deadline), amount: amount.toString() });
    }
  }
  return out.length > 0 ? { chain: `eip155:${id}`, permits: out } : null;
}

function uint(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) return null;
  const n = BigInt(v);
  return n < 1n << 256n ? n : null;
}
const addr = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
const seconds = (n: bigint) => (n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n));

/** `turn`: the queue the account records share, so a pruning never undoes a record. */
export function createPermit2(local: Store, now: () => number = () => Math.floor(Date.now() / 1000), turn: Turn = (work) => work()) {
  async function all(): Promise<Records> {
    const { permit2_signed } = await local.get(["permit2_signed"]);
    return isObject(permit2_signed) ? (permit2_signed as Records) : {};
  }

  /** Keep the permits of a Permit2 signature `owner` just made. */
  async function record(owner: string, typed: unknown): Promise<void> {
    const got = permitsOf(typed);
    if (!got) return;
    await turn(async () => {
      const records = await all();
      const k = key(got.chain, owner);
      const at = now();
      const kept = (records[k] ?? []).filter((p) => p.deadline >= at);
      await local.set({ permit2_signed: { ...records, [k]: [...kept, ...got.permits].slice(-MAX_RECORDS) } });
    });
  }

  /** The permits `owner` signed on `chain` that may still be used: unexpired, and not used or
   *  cancelled on chain as far as `rpc` says (null: it couldn't say). */
  async function live(chain: string, owner: string, rpc: EvmRpc | null): Promise<{ permits: Permit2Permit[]; unchecked: boolean }> {
    const at = now();
    const mine = ((await all())[key(chain, owner)] ?? []).filter((p) => p.deadline >= at);
    if (mine.length === 0) return { permits: [], unchecked: false };
    if (!rpc) return { permits: mine, unchecked: true };
    const checked = mine.slice(0, MAX_CHECKS);
    let unchecked = mine.length > MAX_CHECKS;
    const out: Permit2Permit[] = [];
    try {
      const pairs = checked.filter((p) => p.kind === "allowance");
      const transfers = checked.filter((p) => p.kind === "transfer");
      const words = [...new Set(transfers.map((p) => BigInt(p.nonce) >> 8n))];
      const [nonces, bitmaps] = await Promise.all([pairs.length ? rpc.permit2Allowances(PERMIT2, pairs, owner) : [], words.length ? rpc.permit2NonceBitmaps(PERMIT2, owner, words) : []]);
      pairs.forEach((p, i) => {
        const a = nonces[i];
        // A permit for a nonce the pair has passed can't be used; one at it or above can.
        if (!a) {
          unchecked = true;
          out.push(p);
        } else if (BigInt(p.nonce) >= BigInt(a.nonce)) out.push(p);
      });
      for (const p of transfers) {
        const b = bitmaps[words.indexOf(BigInt(p.nonce) >> 8n)];
        if (b === null || b === undefined) {
          unchecked = true;
          out.push(p);
        } else if (((b >> (BigInt(p.nonce) & 255n)) & 1n) === 0n) out.push(p);
      }
    } catch {
      return { permits: mine, unchecked: true };
    }
    return { permits: out, unchecked };
  }

  /** Who but `except` could take `token` of `owner`'s through Permit2 on `chain` once it holds
   *  an allowance: spenders of standing Permit2 allowances (from `index`, confirmed on `rpc`)
   *  and of permits the wallet signed that may still be used. `unchecked` when some source
   *  was off or didn't answer: then the wallet can't say no one could. */
  async function others(chain: string, owner: string, token: string, except: readonly string[], index: EvmIndex | null, rpc: EvmRpc): Promise<{ spenders: string[]; unchecked: boolean }> {
    const t = token.toLowerCase();
    const skip = new Set(except.map((e) => e.toLowerCase()));
    const spenders = new Set<string>();
    let unchecked = false;
    const signed = await live(chain, owner, rpc);
    unchecked ||= signed.unchecked;
    for (const p of signed.permits) if (p.token === t && !skip.has(p.spender)) spenders.add(p.spender);
    if (!index) unchecked = true;
    else {
      try {
        const { pairs, complete } = await index.permit2Approvals(owner, PERMIT2);
        if (!complete) unchecked = true;
        const candidates = pairs.filter((p) => p.token.toLowerCase() === t && !skip.has(p.spender.toLowerCase()));
        if (candidates.length > MAX_CHECKS) unchecked = true;
        const checked = candidates.slice(0, MAX_CHECKS);
        const left = checked.length ? await rpc.permit2Allowances(PERMIT2, checked, owner) : [];
        checked.forEach((p, i) => {
          const a = left[i];
          if (!a) unchecked = true;
          else if (a.amount > 0n && a.expiration >= now()) spenders.add(p.spender.toLowerCase());
        });
      } catch {
        unchecked = true;
      }
    }
    return { spenders: [...spenders], unchecked };
  }

  // A reset removes them with the wallet's records; a removed account's go in its pruning
  // (service.ts, forgetGone).
  return { record, live, others };
}

export type Permit2Records = ReturnType<typeof createPermit2>;
