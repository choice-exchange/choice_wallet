// Solana JSON-RPC client: what the wallet needs to show an account's SOL and tokens, read its
// history, and send (a recent blockhash, priority fees, rent, simulation, broadcast, status).
// Same rules as the other clients: several user-settable endpoints, each checked to serve the
// expected cluster (`getGenesisHash`) before use; a JSON-RPC error is the chain's answer.
//
// Checked 2026-11-10: publicnode (mainnet) answers extension origins but refuses
// `getTokenAccountsByOwner`, so tokens are then read from the accounts they would be at
// (`tokenAccounts`' `candidates`); Solana's own mainnet endpoint refuses browser origins
// altogether; devnet's answers everything.

import type { Activity, ActivityKind } from "./activity.ts";
import type { Coin } from "./lcd.ts";
import { base58ToBytes, base64ToBytes, bytesToBase58, bytesToHex } from "./encoding.ts";
import { ChainError, Down, isObject, Pool, type Fetch } from "./pool.ts";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const CCTP_TOKEN_MESSENGER_MINTER = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
export const CCTP_MESSAGE_TRANSMITTER = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

/** Lamports in one SOL. */
export const LAMPORTS = 9;
/** The denom SOL goes by in the wallet's lists; an SPL token is `spl:<mint>`. */
export const SOL = "sol";

export function splDenom(mint: string): string {
  return `spl:${mint}`;
}

export function splMint(denom: string): string | null {
  return denom.startsWith("spl:") ? denom.slice(4) : null;
}

/** Whether a denom is one of Solana's (SOL or an SPL token). */
export function isSolanaDenom(denom: string): boolean {
  return denom === SOL || denom.startsWith("spl:");
}

/** Solana error codes that mean the node, not the request, is the problem: behind, a slot
 *  skipped or not yet available, rate limits. */
const NODE_TROUBLE = new Set([-32005, -32007, -32009, -32014, -32016, -32603, 429]);

export interface SolanaTokenAccount {
  /** The token account. */
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
  decimals: number;
  /** SPL Token or Token-2022. */
  program: string;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  ok: boolean;
}

/** An account as `getMultipleAccounts` (base64) gives it. */
export interface RawAccount {
  lamports: bigint;
  /** The program that owns it. */
  owner: string;
  data: Uint8Array;
}

function raw(a: unknown): RawAccount | null {
  if (!isObject(a) || typeof a["lamports"] !== "number" || typeof a["owner"] !== "string" || !Array.isArray(a["data"]) || typeof a["data"][0] !== "string") return null;
  return { lamports: BigInt(a["lamports"]), owner: a["owner"], data: base64ToBytes(a["data"][0]) };
}

/** A token account's mint, owner and amount, from its bytes (both token programs keep these
 *  first). Null for anything shorter. */
export function tokenAccountOf(a: RawAccount): { mint: string; owner: string; amount: bigint } | null {
  if ((a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM) || a.data.length < 165) return null;
  return { mint: bytesToBase58(a.data.slice(0, 32)), owner: bytesToBase58(a.data.slice(32, 64)), amount: new DataView(a.data.buffer, a.data.byteOffset + 64, 8).getBigUint64(0, true) };
}

export class SolanaRpc {
  readonly pool: Pool;
  #id = 1;

  constructor(cluster: { genesis: string }, urls: readonly string[], fetch: Fetch, timeoutMs?: number) {
    this.pool = new Pool(urls, {
      fetch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      identify: async (base) => {
        const served = await this.#send(base, "getGenesisHash", []);
        if (served !== cluster.genesis) throw new Down(`serves genesis ${String(served)}, not ${cluster.genesis}`);
      },
    });
  }

  async #send(base: string, method: string, params: unknown[]): Promise<unknown> {
    const { status, body } = await this.pool.json(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method, params }),
    });
    if (isObject(body) && "result" in body && body["result"] !== undefined) return body["result"];
    const err = isObject(body) ? body["error"] : undefined;
    if (isObject(err) && typeof err["code"] === "number" && typeof err["message"] === "string") {
      if (NODE_TROUBLE.has(err["code"])) throw new Down(`code ${err["code"]}: ${err["message"]}`);
      throw new ChainError(err["code"], err["message"].slice(0, 300));
    }
    throw new Down(`HTTP ${status}, not a JSON-RPC answer`);
  }

  /** One call, on whichever endpoint answers. A transaction goes only to an endpoint known
   *  to serve this cluster. */
  call(method: string, params: unknown[] = []): Promise<unknown> {
    return this.pool.run((base) => this.#send(base, method, params), { write: method === "sendTransaction" });
  }

  /** Lamports at `address`. */
  async balance(address: string): Promise<bigint> {
    const r = await this.call("getBalance", [address, { commitment: "confirmed" }]);
    const v = isObject(r) ? r["value"] : undefined;
    if (typeof v !== "number") throw new Down("getBalance: no value");
    return BigInt(v);
  }

  /** Accounts, `jsonParsed`, 100 a request; null where there is none. */
  async accounts(addresses: readonly string[]): Promise<(Record<string, unknown> | null)[]> {
    const out: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await this.call("getMultipleAccounts", [addresses.slice(i, i + 100), { encoding: "jsonParsed", commitment: "confirmed" }]);
      const v = isObject(r) ? r["value"] : undefined;
      if (!Array.isArray(v)) throw new Down("getMultipleAccounts: no value");
      out.push(...v.map((a) => (isObject(a) ? a : null)));
    }
    return out;
  }

  /** Accounts as their bytes, 100 a request; null where there is none. */
  async rawAccounts(addresses: readonly string[]): Promise<(RawAccount | null)[]> {
    const out: (RawAccount | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await this.call("getMultipleAccounts", [addresses.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }]);
      const v = isObject(r) ? r["value"] : undefined;
      if (!Array.isArray(v)) throw new Down("getMultipleAccounts: no value");
      out.push(...v.map(raw));
    }
    return out;
  }

  /** Simulate a transaction (base64, unsigned or partly signed), with what `addresses` hold
   *  after it (at most 100). */
  async simulateWith(tx: string, addresses: readonly string[]): Promise<{ err: unknown; logs: string[]; after: (RawAccount | null)[] }> {
    const r = await this.call("simulateTransaction", [
      tx,
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: addresses.slice(0, 100) } },
    ]);
    const v = isObject(r) ? r["value"] : undefined;
    if (!isObject(v)) throw new Down("simulateTransaction: no value");
    return {
      err: v["err"] ?? null,
      logs: Array.isArray(v["logs"]) ? v["logs"].filter((l): l is string => typeof l === "string") : [],
      after: Array.isArray(v["accounts"]) ? v["accounts"].map(raw) : [],
    };
  }

  /** `owner`'s token accounts, under both token programs. Endpoints that refuse to list them
   *  (publicnode on mainnet) get the accounts `candidates` names instead: the owner's
   *  associated accounts for the tokens the wallet knows of. */
  async tokenAccounts(owner: string, candidates: () => readonly string[]): Promise<SolanaTokenAccount[]> {
    try {
      const lists = await Promise.all(
        [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
          this.call("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]),
        ),
      );
      return lists.flatMap((r) => {
        const v = isObject(r) ? r["value"] : undefined;
        if (!Array.isArray(v)) throw new Down("getTokenAccountsByOwner: no value");
        return v.flatMap((e) => (isObject(e) && typeof e["pubkey"] === "string" ? tokenAccount(e["pubkey"], e["account"]) : []));
      });
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
    }
    const addresses = candidates();
    const found = await this.accounts(addresses);
    return found.flatMap((a, i) => tokenAccount(addresses[i]!, a)).filter((t) => t.owner === owner);
  }

  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const v = isObject(r) ? r["value"] : undefined;
    if (!isObject(v) || typeof v["blockhash"] !== "string" || typeof v["lastValidBlockHeight"] !== "number") throw new Down("getLatestBlockhash: no value");
    return { blockhash: v["blockhash"], lastValidBlockHeight: v["lastValidBlockHeight"] };
  }

  /** A priority fee (micro-lamports a compute unit) that recent blocks touching `accounts`
   *  paid: their 75th percentile, at least `floor`. */
  async priorityFee(accounts: readonly string[], floor = 1_000): Promise<number> {
    const r = await this.call("getRecentPrioritizationFees", [accounts.slice(0, 128)]);
    const fees = (Array.isArray(r) ? r : []).flatMap((x) => (isObject(x) && typeof x["prioritizationFee"] === "number" ? [x["prioritizationFee"]] : [])).sort((a, b) => a - b);
    const p75 = fees.length > 0 ? fees[Math.floor(fees.length * 0.75)]! : 0;
    return Math.max(floor, Math.min(p75, 5_000_000));
  }

  /** Lamports an account of `bytes` must hold to stay. */
  async rentExempt(bytes: number): Promise<bigint> {
    const r = await this.call("getMinimumBalanceForRentExemption", [bytes]);
    if (typeof r !== "number") throw new Down("getMinimumBalanceForRentExemption: no value");
    return BigInt(r);
  }

  /** Run a signed or unsigned transaction (base64) without sending it. */
  async simulate(tx: string): Promise<{ err: unknown; logs: string[]; units: number | null }> {
    const r = await this.call("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }]);
    const v = isObject(r) ? r["value"] : undefined;
    if (!isObject(v)) throw new Down("simulateTransaction: no value");
    return {
      err: v["err"] ?? null,
      logs: Array.isArray(v["logs"]) ? v["logs"].filter((l): l is string => typeof l === "string") : [],
      units: typeof v["unitsConsumed"] === "number" ? v["unitsConsumed"] : null,
    };
  }

  /** Broadcast a signed transaction (base64); its signature, which names it from now on. */
  async send(tx: string): Promise<string> {
    const r = await this.call("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
    if (typeof r !== "string") throw new Down("sendTransaction: no signature");
    return r;
  }

  /** Where each transaction is: null for one the cluster hasn't seen (yet, or any more). */
  async statuses(signatures: readonly string[]): Promise<({ slot: number; ok: boolean; confirmation: string } | null)[]> {
    const r = await this.call("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
    const v = isObject(r) ? r["value"] : undefined;
    if (!Array.isArray(v)) throw new Down("getSignatureStatuses: no value");
    return v.map((s) =>
      isObject(s) && typeof s["slot"] === "number"
        ? { slot: s["slot"], ok: s["err"] === null || s["err"] === undefined, confirmation: typeof s["confirmationStatus"] === "string" ? s["confirmationStatus"] : "processed" }
        : null,
    );
  }

  /** The newest signatures that touch `address`, before `before` if given. */
  async signatures(address: string, limit: number, before?: string): Promise<SignatureInfo[]> {
    const r = await this.call("getSignaturesForAddress", [address, { limit, commitment: "confirmed", ...(before ? { before } : {}) }]);
    if (!Array.isArray(r)) throw new Down("getSignaturesForAddress: no list");
    return r.flatMap((s) =>
      isObject(s) && typeof s["signature"] === "string" && typeof s["slot"] === "number"
        ? [{ signature: s["signature"], slot: s["slot"], blockTime: typeof s["blockTime"] === "number" ? s["blockTime"] : null, ok: s["err"] === null || s["err"] === undefined }]
        : [],
    );
  }

  /** A confirmed transaction, `jsonParsed`, or null if the endpoint doesn't have it. */
  async transaction(signature: string): Promise<Record<string, unknown> | null> {
    const r = await this.call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    return isObject(r) ? r : null;
  }
}

/** A token account from `jsonParsed` account data, or nothing if it isn't one. */
function tokenAccount(address: string, account: unknown): SolanaTokenAccount[] {
  if (!isObject(account) || !isObject(account["data"])) return [];
  const parsed = account["data"]["parsed"];
  const program = typeof account["owner"] === "string" ? account["owner"] : "";
  if (!isObject(parsed) || parsed["type"] !== "account" || !isObject(parsed["info"])) return [];
  const info = parsed["info"];
  const amt = isObject(info["tokenAmount"]) ? info["tokenAmount"] : null;
  if (typeof info["mint"] !== "string" || typeof info["owner"] !== "string" || !amt || typeof amt["amount"] !== "string" || typeof amt["decimals"] !== "number") return [];
  if (!/^\d+$/.test(amt["amount"])) return [];
  return [{ address, mint: info["mint"], owner: info["owner"], amount: BigInt(amt["amount"]), decimals: amt["decimals"], program }];
}

const DEPOSIT_FOR_BURN = [215, 60, 61, 46, 114, 55, 128, 176];
const DEPOSIT_FOR_BURN_WITH_HOOK = [111, 245, 62, 131, 204, 108, 223, 155];
const RECLAIM_EVENT_ACCOUNT = [94, 198, 180, 159, 131, 236, 15, 174];

function startsWith(b: Uint8Array, prefix: readonly number[]): boolean {
  return b.length >= prefix.length && prefix.every((x, i) => b[i] === x);
}

/** A CCTP burn's destination, read from its instruction data: the domain at bytes 16 to 20
 *  (little-endian), the recipient at 20 to 52. */
export function solanaBurn(data: string): { domain: number; mintRecipient: string } | null {
  let b: Uint8Array;
  try {
    b = base58ToBytes(data);
  } catch {
    return null;
  }
  if (b.length < 96 || !(startsWith(b, DEPOSIT_FOR_BURN) || startsWith(b, DEPOSIT_FOR_BURN_WITH_HOOK))) return null;
  const domain = b[16]! | (b[17]! << 8) | (b[18]! << 16) | (b[19]! << 24);
  return { domain: domain >>> 0, mintRecipient: `0x${bytesToHex(b.slice(20, 52))}` };
}

interface Ix {
  programId: string;
  parsed?: unknown;
  data?: string;
}

function instructions(tx: Record<string, unknown>): Ix[] {
  const t = tx["transaction"];
  const m = isObject(t) ? t["message"] : undefined;
  const list = isObject(m) && Array.isArray(m["instructions"]) ? m["instructions"] : [];
  return list.flatMap((i) => (isObject(i) && typeof i["programId"] === "string" ? [i as unknown as Ix] : []));
}

function keys(tx: Record<string, unknown>): { pubkey: string; signer: boolean }[] {
  const t = tx["transaction"];
  const m = isObject(t) ? t["message"] : undefined;
  const list = isObject(m) && Array.isArray(m["accountKeys"]) ? m["accountKeys"] : [];
  return list.map((k) => (isObject(k) && typeof k["pubkey"] === "string" ? { pubkey: k["pubkey"], signer: k["signer"] === true } : { pubkey: "", signer: false }));
}

interface TokenBalance {
  index: number;
  mint: string;
  owner: string;
  amount: bigint;
}

function tokenBalances(list: unknown): TokenBalance[] {
  return (Array.isArray(list) ? list : []).flatMap((b) => {
    if (!isObject(b) || typeof b["accountIndex"] !== "number" || typeof b["mint"] !== "string" || !isObject(b["uiTokenAmount"])) return [];
    const a = b["uiTokenAmount"]["amount"];
    if (typeof a !== "string" || !/^\d+$/.test(a)) return [];
    return [{ index: b["accountIndex"], mint: b["mint"], owner: typeof b["owner"] === "string" ? b["owner"] : "", amount: BigInt(a) }];
  });
}

/** One Solana transaction (`getTransaction`, `jsonParsed`) as the activity list shows it for
 *  `owner`: what its SOL and tokens did (the fee apart), who was on the other side when one
 *  transfer says so, and a CCTP burn's destination. `chain` is the cluster's CAIP-2 ID. */
export function summarizeSolana(tx: Record<string, unknown>, owner: string, chain: string): Activity | null {
  const meta = tx["meta"];
  const sigs = isObject(tx["transaction"]) ? tx["transaction"]["signatures"] : undefined;
  const hash = Array.isArray(sigs) && typeof sigs[0] === "string" ? sigs[0] : null;
  if (!isObject(meta) || !hash) return null;
  const ks = keys(tx);
  const at = ks.findIndex((k) => k.pubkey === owner);
  const payer = ks[0]?.pubkey === owner;
  const signed = at >= 0 && ks[at]!.signer;
  const fee = payer && typeof meta["fee"] === "number" ? BigInt(meta["fee"]) : 0n;
  const changes: Coin[] = [];
  const pre = Array.isArray(meta["preBalances"]) ? meta["preBalances"] : [];
  const post = Array.isArray(meta["postBalances"]) ? meta["postBalances"] : [];
  if (at >= 0 && typeof pre[at] === "number" && typeof post[at] === "number") {
    const sol = BigInt(post[at]) - BigInt(pre[at]) + fee;
    if (sol !== 0n) changes.push({ denom: SOL, amount: sol.toString() });
  }
  const before = tokenBalances(meta["preTokenBalances"]).filter((b) => b.owner === owner);
  const after = tokenBalances(meta["postTokenBalances"]).filter((b) => b.owner === owner);
  const mints = new Set([...before, ...after].map((b) => b.mint));
  for (const mint of mints) {
    const sum = (l: TokenBalance[]) => l.filter((b) => b.mint === mint).reduce((s, b) => s + b.amount, 0n);
    const d = sum(after) - sum(before);
    if (d !== 0n) changes.push({ denom: splDenom(mint), amount: d.toString() });
  }
  const ixs = instructions(tx);
  const out = changes.filter((c) => c.amount.startsWith("-"));
  const into = changes.filter((c) => !c.amount.startsWith("-"));
  // The other side of one transfer: where SOL or tokens went, or came from.
  const owners = new Map<number, string>();
  for (const b of [...tokenBalances(meta["preTokenBalances"]), ...tokenBalances(meta["postTokenBalances"])]) owners.set(b.index, b.owner);
  const ownerOf = (account: unknown) => {
    const i = ks.findIndex((k) => k.pubkey === account);
    return i >= 0 ? (owners.get(i) ?? null) : null;
  };
  const sides = ixs.flatMap((i) => {
    if (!isObject(i.parsed) || !isObject(i.parsed["info"])) return [];
    const info = i.parsed["info"];
    const type = i.parsed["type"];
    if (type === "transfer" && i.programId === SYSTEM_PROGRAM) return [{ from: info["source"], to: info["destination"] }];
    if ((type === "transfer" || type === "transferChecked") && (i.programId === TOKEN_PROGRAM || i.programId === TOKEN_2022_PROGRAM)) {
      return [{ from: info["authority"] ?? ownerOf(info["source"]), to: ownerOf(info["destination"]) ?? info["destination"] }];
    }
    return [];
  });
  let kind: ActivityKind;
  let counterparty: string | undefined;
  let bridge: Activity["bridge"];
  let label: string | undefined;
  const burn = ixs.find((i) => i.programId === CCTP_TOKEN_MESSENGER_MINTER && typeof i.data === "string" && solanaBurn(i.data));
  const reclaim = ixs.some((i) => {
    if (i.programId !== CCTP_MESSAGE_TRANSMITTER || typeof i.data !== "string") return false;
    try {
      return startsWith(base58ToBytes(i.data), RECLAIM_EVENT_ACCOUNT);
    } catch {
      return false;
    }
  });
  if (burn) {
    kind = "bridge";
    bridge = solanaBurn(burn.data!)!;
  } else if (reclaim) {
    kind = "other";
    label = "Rent back";
  } else if (out.length > 0 && into.length > 0) {
    kind = "swap";
  } else if (out.length > 0) {
    kind = "send";
    const to = [...new Set(sides.filter((s) => s.from === owner).map((s) => s.to))];
    if (to.length === 1 && typeof to[0] === "string") counterparty = to[0];
  } else if (into.length > 0) {
    kind = "receive";
    const from = [...new Set(sides.filter((s) => s.to === owner).map((s) => s.from))];
    if (from.length === 1 && typeof from[0] === "string") counterparty = from[0];
  } else {
    kind = signed ? "contract" : "other";
  }
  const time = typeof tx["blockTime"] === "number" ? new Date(tx["blockTime"] * 1000).toISOString() : "";
  return {
    hash,
    height: typeof tx["slot"] === "number" ? String(tx["slot"]) : "0",
    time,
    ok: meta["err"] === null || meta["err"] === undefined,
    kind,
    ...(label ? { label } : {}),
    ...(counterparty ? { counterparty } : {}),
    signed: signed || payer,
    changes,
    fee: fee > 0n ? [{ denom: SOL, amount: fee.toString() }] : [],
    ...(bridge ? { bridge } : {}),
    chain,
  };
}
