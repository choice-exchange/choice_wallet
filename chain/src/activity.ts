// An account's activity, from the node's tx index: what each transaction did to the
// account's balances, and a word for what kind of transaction it was.
//
// Balance changes come from the bank module's own events (`coin_spent` and `coin_received`
// for this address), whatever the messages were, so swaps, contract calls and IBC show
// what actually moved. The fee is reported apart, when this account paid it. Transfers
// that never touch the bank module (pure ERC20 tokens on the EVM side) don't show here.

import type { Coin, IndexedTx, TxEvent } from "./lcd.ts";
import { toBigInt } from "./units.ts";

export type ActivityKind =
  | "send"
  | "receive"
  | "swap"
  | "contract"
  | "evm"
  | "orderbook"
  | "ibc"
  | "stake"
  | "unstake"
  | "redelegate"
  | "rewards"
  | "other";

export interface Activity {
  hash: string;
  height: string;
  time: string;
  ok: boolean;
  kind: ActivityKind;
  /** The message's own name, for kind "other" ("Vote" for MsgVote). */
  label?: string;
  /** Who the tokens went to or came from, when that is one address. */
  counterparty?: string;
  /** This account paid the fee: it signed the transaction (or its fee). */
  signed: boolean;
  /** Net change per denom, in base units, signed ("-1500", "2500"); the fee left out. */
  changes: Coin[];
  /** The fee, when this account paid it. */
  fee: Coin[];
}

/** "100inj,5peggy0x…" (an event's amount) as coins. */
export function parseCoins(s: string): Coin[] {
  const out: Coin[] = [];
  for (const part of s.split(",")) {
    const m = /^([0-9]+)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/.exec(part.trim());
    if (m) out.push({ denom: m[2]!, amount: m[1]! });
  }
  return out;
}

const attr = (e: TxEvent, key: string) => e.attributes.find((a) => a.key === key)?.value;

export function summarize(tx: IndexedTx, address: string): Activity {
  const net = new Map<string, bigint>();
  const add = (coins: Coin[], sign: bigint) => {
    for (const c of coins) net.set(c.denom, (net.get(c.denom) ?? 0n) + sign * toBigInt(c.amount));
  };
  let feePayer: string | undefined;
  let from: string | undefined;
  for (const e of tx.events) {
    if (e.type === "coin_received" && attr(e, "receiver") === address) add(parseCoins(attr(e, "amount") ?? ""), 1n);
    if (e.type === "coin_spent" && attr(e, "spender") === address) add(parseCoins(attr(e, "amount") ?? ""), -1n);
    if (e.type === "tx" && attr(e, "fee_payer") !== undefined) feePayer = attr(e, "fee_payer");
    if (e.type === "transfer" && attr(e, "recipient") === address && from === undefined) from = attr(e, "sender");
  }
  const signed = feePayer === address;
  if (signed) add(tx.fee, 1n); // the fee is reported apart
  const changes = [...net].filter(([, a]) => a !== 0n).map(([denom, a]) => ({ denom, amount: a.toString() }));
  const ups = changes.filter((c) => !c.amount.startsWith("-")).length;
  const downs = changes.length - ups;
  const up = ups > 0;
  const down = downs > 0;

  const base = { hash: tx.hash, height: tx.height.toString(), time: tx.time, ok: tx.code === 0, signed, changes, fee: signed ? tx.fee : [] };
  const types = tx.messages.map((m) => String(m["@type"] ?? ""));
  const first = tx.messages[0] ?? {};
  const t = types[0] ?? "";
  const str = (k: string) => (typeof first[k] === "string" ? (first[k] as string) : undefined);
  const kindOf = (kind: ActivityKind, counterparty?: string): Activity => ({ ...base, kind, ...(counterparty ? { counterparty } : {}) });

  if (t === "/cosmos.bank.v1beta1.MsgSend") {
    if (str("from_address") === address) return kindOf("send", str("to_address"));
    if (str("to_address") === address) return kindOf("receive", str("from_address"));
  }
  if (types.includes("/ibc.core.channel.v1.MsgRecvPacket") && up && !down) return kindOf("receive");
  if (!signed && up && !down) return kindOf("receive", from);
  if (t === "/ibc.applications.transfer.v1.MsgTransfer") return kindOf("ibc", str("receiver"));
  if (t === "/cosmos.staking.v1beta1.MsgDelegate") return kindOf("stake", str("validator_address"));
  if (t === "/cosmos.staking.v1beta1.MsgUndelegate") return kindOf("unstake", str("validator_address"));
  if (t === "/cosmos.staking.v1beta1.MsgBeginRedelegate") return kindOf("redelegate", str("validator_dst_address"));
  if (t === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward") return kindOf("rewards");
  if (t.startsWith("/injective.exchange.")) return kindOf("orderbook");
  if (ups === 1 && downs === 1) return kindOf("swap"); // one token out, another in
  if (t === "/cosmwasm.wasm.v1.MsgExecuteContract") return kindOf("contract", str("contract"));
  if (t === "/injective.evm.v1.MsgEthereumTx") return kindOf("evm");
  if (t === "/cosmos.bank.v1beta1.MsgMultiSend") return kindOf(up ? "receive" : "send");
  const name = t.split(".").pop() ?? "";
  return { ...kindOf("other"), label: name.replace(/^Msg/, "") || "Transaction" };
}

/** Two pages of the index merged: one per query, the same tx once, newest first. */
export function mergeActivity(lists: readonly (readonly Activity[])[]): Activity[] {
  const byHash = new Map<string, Activity>();
  for (const list of lists) for (const a of list) if (!byHash.has(a.hash)) byHash.set(a.hash, a);
  return [...byHash.values()].sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0));
}
