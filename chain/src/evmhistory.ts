// An account's history on an EVM chain beside Injective. Public nodes can't search by
// address, so something else finds the transactions: an Etherscan-style index where the
// chain has a free one (Blockscout, Routescan), and the wallet's own record of what it sent.
// Either only names hashes. Each transaction is then read from the user's own endpoints for
// that chain (the transaction, its receipt with its logs, its block's time) and summarized
// here, so a wrong index can leave something out but can't put a false row in.

import { abiString, type EvmRpc } from "./evm.ts";
import { erc20Event, type EvmLog } from "./evmtx.ts";
import { ChainError, isObject } from "./pool.ts";
import type { Activity } from "./activity.ts";

/** One transaction as the chain describes it. */
export interface EvmTxRecord {
  hash: string;
  /** Lowercase. */
  from: string;
  /** Lowercase; null for a contract creation. */
  to: string | null;
  value: bigint;
  input: string;
  ok: boolean;
  /** What it paid: gas used × effective price, plus an OP Stack chain's L1 fee. */
  fee: bigint;
  logs: EvmLog[];
  block: bigint;
  /** Seconds since 1970. */
  time: number;
}

const hexBig = (v: unknown): bigint => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : 0n);

/** Read transactions by hash in batches: each one's transaction, receipt and block time.
 *  One not found (yet) is left out. */
export async function readEvmTxs(rpc: EvmRpc, hashes: readonly string[]): Promise<EvmTxRecord[]> {
  const calls = hashes.flatMap((h) => [
    { method: "eth_getTransactionByHash", params: [h] },
    { method: "eth_getTransactionReceipt", params: [h] },
  ]);
  const got = calls.length ? await rpc.batch(calls) : [];
  const found: Omit<EvmTxRecord, "time">[] = [];
  hashes.forEach((hash, i) => {
    const tx = got[2 * i];
    const r = got[2 * i + 1];
    if (!isObject(tx) || !isObject(r) || tx instanceof ChainError || r instanceof ChainError) return;
    if (typeof tx["from"] !== "string" || typeof r["blockNumber"] !== "string") return;
    const logs: EvmLog[] = Array.isArray(r["logs"])
      ? r["logs"].flatMap((l) =>
          isObject(l) && typeof l["address"] === "string" && Array.isArray(l["topics"]) && typeof l["data"] === "string"
            ? [{ address: l["address"].toLowerCase(), topics: l["topics"].map((t) => String(t).toLowerCase()), data: l["data"].toLowerCase() }]
            : [],
        )
      : [];
    const price = hexBig(r["effectiveGasPrice"] ?? tx["gasPrice"]);
    found.push({
      hash: hash.toLowerCase(),
      from: tx["from"].toLowerCase(),
      to: typeof tx["to"] === "string" ? tx["to"].toLowerCase() : null,
      value: hexBig(tx["value"]),
      input: typeof tx["input"] === "string" ? tx["input"].toLowerCase() : "0x",
      ok: r["status"] === "0x1",
      fee: hexBig(r["gasUsed"]) * price + hexBig(r["l1Fee"]),
      logs,
      block: hexBig(r["blockNumber"]),
    });
  });
  const blocks = [...new Set(found.map((f) => f.block))];
  const heads = blocks.length ? await rpc.batch(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: [`0x${b.toString(16)}`, false] }))) : [];
  const times = new Map(blocks.map((b, i) => [b, isObject(heads[i]) ? Number(hexBig((heads[i] as Record<string, unknown>)["timestamp"])) : 0]));
  return found.map((f) => ({ ...f, time: times.get(f.block) ?? 0 }));
}

/** What a chain's history names tokens by: its coin, its USDC, and any other ERC20 there. */
export interface HistoryKeys {
  /** The coin's wallet key (`native:eip155:8453`). */
  coin: string;
  /** A token contract's wallet key (USDC's is `usdc:eip155:8453`). */
  token(address: string): string;
  /** Circle's contracts there, to call a burn or a mint what it is. */
  tokenMessenger: string;
  messageTransmitter: string;
}

const CCTP_BURNS = ["0x8e0250ee", "0x779b432d"];

/** One transaction from `me`'s side: what changed for it, in the shape Activity shows. */
export function summarizeEvmTx(r: EvmTxRecord, me: string, chain: string, keys: HistoryKeys): Activity {
  const self = me.toLowerCase();
  const signed = r.from === self;
  const changes = new Map<string, bigint>();
  const add = (denom: string, v: bigint) => changes.set(denom, (changes.get(denom) ?? 0n) + v);
  if (r.ok && r.value > 0n) {
    if (signed) add(keys.coin, -r.value);
    if (r.to === self) add(keys.coin, r.value);
  }
  let approval: Activity["approval"];
  const others = new Set<string>();
  for (const log of r.ok ? r.logs : []) {
    const e = erc20Event(log);
    if (!e) continue;
    if (e.kind === "transfer") {
      if (e.from === self) {
        add(keys.token(e.token), -e.amount);
        others.add(e.to);
      }
      if (e.to === self) {
        add(keys.token(e.token), e.amount);
        others.add(e.from);
      }
    } else if (e.owner === self && signed) {
      approval = { denom: keys.token(e.token), spender: e.spender, amount: e.amount.toString() };
    }
  }
  const list = [...changes].filter(([, v]) => v !== 0n).map(([denom, v]) => ({ denom, amount: v.toString() }));
  const out = list.some((c) => c.amount.startsWith("-"));
  const into = list.some((c) => !c.amount.startsWith("-"));
  const burn = signed && r.to === keys.tokenMessenger.toLowerCase() && CCTP_BURNS.includes(r.input.slice(0, 10)) && r.input.length >= 10 + 64 * 3;
  const mint = r.to === keys.messageTransmitter.toLowerCase() && r.input.startsWith("0x57ecfd28");
  const kind: Activity["kind"] = burn || mint ? "bridge" : approval && list.length === 0 ? "approve" : out && !into ? "send" : into && !out ? "receive" : list.length === 0 && signed ? "contract" : "evm";
  const counterparty = kind === "send" || kind === "receive" ? (others.size === 1 ? [...others][0] : kind === "send" ? (r.to ?? undefined) : r.from) : approval ? approval.spender : undefined;
  const item: Activity = {
    hash: r.hash,
    height: r.block.toString(),
    time: new Date(r.time * 1000).toISOString(),
    ok: r.ok,
    kind,
    signed,
    changes: list,
    fee: signed ? [{ denom: keys.coin, amount: r.fee.toString() }] : [],
    chain,
  };
  if (counterparty) item.counterparty = counterparty;
  if (approval) item.approval = approval;
  if (burn) {
    const word = (i: number) => r.input.slice(10 + 64 * i, 10 + 64 * (i + 1));
    item.bridge = { domain: Number.parseInt(word(1), 16), mintRecipient: `0x${word(2)}` };
  }
  if (mint) {
    // The message (after two offsets and its length) starts with its version, then its
    // source domain.
    const at = 10 + 64 * 3 + 8;
    const domain = Number.parseInt(r.input.slice(at, at + 8), 16);
    if (Number.isSafeInteger(domain)) item.bridge = { domain, mintRecipient: `0x${self.slice(2).padStart(64, "0")}`, incoming: true };
  }
  return item;
}

/** A token's symbol and decimals there, from the contract (for a row's amount). */
export async function erc20Meta(rpc: EvmRpc, address: string): Promise<{ symbol: string; decimals: number } | null> {
  const [s, d] = await rpc.batch([
    { method: "eth_call", params: [{ to: address, data: "0x95d89b41" }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: "0x313ce567" }, "latest"] },
  ]);
  const symbol = abiString(s);
  const decimals = typeof d === "string" && /^0x[0-9a-fA-F]+$/.test(d) ? Number(BigInt(d)) : NaN;
  return symbol && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? { symbol, decimals } : null;
}
