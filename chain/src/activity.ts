// An account's activity, from the node's tx index: what each transaction did to the
// account's balances, and a word for what kind of transaction it was.
//
// Balance changes come from the bank module's own events (`coin_spent` and `coin_received`
// for this address), whatever the messages were, so swaps, contract calls and IBC show
// what actually moved. CW20 tokens move inside their contracts, so their `wasm` events
// (transfer, send, mint, burn) count too, under the token's `cw20:` key. The fee is
// reported apart, when this account paid it. Transfers that never touch either (pure ERC20
// tokens on the EVM side) don't show here.

import type { Coin, IndexedTx, TxEvent } from "./lcd.ts";
import { toBigInt } from "./units.ts";

export type ActivityKind =
  | "send"
  | "receive"
  | "swap"
  | "convert"
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

const CONTRACT = /^inj1(?:[02-9ac-hj-np-z]{38}|[02-9ac-hj-np-z]{58})$/;
const MOVES = new Set(["transfer", "send", "transfer_from", "send_from"]);

/** A CW20's movement in one `wasm` event, as (from, to, amount); null for anything else. */
function cw20Move(e: TxEvent): { token: string; from?: string; to?: string; amount: string } | null {
  if (e.type !== "wasm") return null;
  const contract = attr(e, "_contract_address");
  const action = attr(e, "action");
  const amount = attr(e, "amount");
  if (!contract || !CONTRACT.test(contract) || !action || !amount || !/^[0-9]{1,78}$/.test(amount)) return null;
  const token = `cw20:${contract}`;
  const from = attr(e, "from");
  const to = attr(e, "to");
  if (MOVES.has(action) && from && to) return { token, from, to, amount };
  if (action === "mint" && to) return { token, to, amount };
  if ((action === "burn" || action === "burn_from") && from) return { token, from, amount };
  return null;
}

/** What a transaction's events did to `address`: the net change per denom (a CW20 under
 *  its `cw20:` key), the fee left out when `address` paid it, and who sent what arrived. */
export function balanceChanges(events: readonly TxEvent[], address: string, fee: readonly Coin[]): { changes: Coin[]; signed: boolean; from?: string } {
  const net = new Map<string, bigint>();
  const add = (coins: Coin[], sign: bigint) => {
    for (const c of coins) net.set(c.denom, (net.get(c.denom) ?? 0n) + sign * toBigInt(c.amount));
  };
  let feePayer: string | undefined;
  let from: string | undefined;
  for (const e of events) {
    if (e.type === "coin_received" && attr(e, "receiver") === address) add(parseCoins(attr(e, "amount") ?? ""), 1n);
    if (e.type === "coin_spent" && attr(e, "spender") === address) add(parseCoins(attr(e, "amount") ?? ""), -1n);
    if (e.type === "tx" && attr(e, "fee_payer") !== undefined) feePayer = attr(e, "fee_payer");
    if (e.type === "transfer" && attr(e, "recipient") === address && from === undefined) from = attr(e, "sender");
    const m = cw20Move(e);
    if (m?.to === address) add([{ denom: m.token, amount: m.amount }], 1n);
    if (m?.from === address) add([{ denom: m.token, amount: m.amount }], -1n);
    if (m?.to === address && m.from && from === undefined) from = m.from;
  }
  const signed = feePayer === address;
  if (signed) add([...fee], 1n); // the fee is reported apart
  const changes = [...net].filter(([, a]) => a !== 0n).map(([denom, a]) => ({ denom, amount: a.toString() }));
  return { changes, signed, ...(from ? { from } : {}) };
}

export function summarize(tx: IndexedTx, address: string): Activity {
  const { changes, signed, from } = balanceChanges(tx.events, address, tx.fee);
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
  if (ups === 1 && downs === 1) {
    // The same token in its other form, one for one: a CW20 adapter conversion.
    const [a, b] = changes.map((c) => c.denom);
    const cw20 = [a, b].find((dn) => dn?.startsWith("cw20:"))?.slice(5);
    const other = [a, b].find((dn) => !dn?.startsWith("cw20:"));
    const same = changes[0]!.amount.replace("-", "") === changes[1]!.amount.replace("-", "");
    if (cw20 && other?.startsWith("factory/") && other.endsWith(`/${cw20}`) && same) return kindOf("convert");
    return kindOf("swap"); // one token out, another in
  }
  if (t === "/cosmwasm.wasm.v1.MsgExecuteContract") {
    // A CW20 `transfer` reads as a send to its recipient.
    const call = first["msg"];
    const to = typeof call === "object" && call !== null ? (call as Record<string, unknown>)["transfer"] : undefined;
    const recipient = typeof to === "object" && to !== null ? (to as Record<string, unknown>)["recipient"] : undefined;
    if (downs === 1 && ups === 0 && typeof recipient === "string" && changes[0]!.denom === `cw20:${str("contract")}`) return kindOf("send", recipient);
    return kindOf("contract", str("contract"));
  }
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
