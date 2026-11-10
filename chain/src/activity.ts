// An account's activity, from the node's tx index: what each transaction did to the
// account's balances, and a word for what kind of transaction it was.
//
// Balance changes come from the bank module's own events (`coin_spent` and `coin_received`
// for this address), whatever the messages were, so swaps, contract calls and IBC show
// what actually moved. CW20 tokens move inside their contracts, so their `wasm` events
// (transfer, send, mint, burn) count too, under the token's `cw20:` key. The fee is
// reported apart, when this account paid it.
//
// EVM transactions are in the same index (see ./evmtx.ts). Most ERC20s on Injective are
// bank-backed (a token pair, or an `erc20:` denom), so their moves are bank events like any
// other; an ERC20 with no bank form moves only in its contract's logs, which count under
// its `evm:` key. Which tokens have a bank form comes from the erc20 module's pairs, so a
// move never counts twice.

import { EVM_MSG, erc20Event, evmCall, transferRecipient, type Erc20Event } from "./evmtx.ts";
import type { Coin, IndexedTx, TxEvent } from "./lcd.ts";
import { NETWORKS } from "./networks.ts";
import { evmDenom } from "./tokens.ts";
import { toBigInt } from "./units.ts";

export type ActivityKind =
  | "send"
  | "receive"
  | "swap"
  | "convert"
  | "approve"
  | "bridge"
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
  /** An EVM transaction's own 0x hash (its explorer page is Blockscout's). */
  evmHash?: string;
  /** For kind "approve": who may now spend how much of which token ("0" takes it back). */
  approval?: { denom: string; spender: string; amount: string };
  /** For kind "bridge": USDC burned over Circle's CCTP, to this domain and `mintRecipient`
   *  (bytes32 hex), as the signed call says; or, `incoming`, minted here from a burn on that
   *  domain (whoever submitted the mint). */
  bridge?: { domain: number; mintRecipient: string; incoming?: true };
  /** A Solana transaction: its cluster's CAIP-2 ID. Its hash is the signature (base58), its
   *  height the slot, and its denoms `sol` and `spl:<mint>`. */
  chain?: string;
}

/** `depositForBurn` and `depositForBurnWithHook` (TokenMessengerV2). */
const CCTP_BURNS = ["0x8e0250ee", "0x779b432d"];

/** A CCTP burn this account signed, read from the call: where it goes. */
function cctpBurn(call: { to: string | null; input: string } | null): { domain: number; mintRecipient: string } | null {
  if (!call?.to || !Object.values(NETWORKS).some((n) => n.cctp.tokenMessenger.toLowerCase() === call.to)) return null;
  if (!CCTP_BURNS.includes(call.input.slice(0, 10)) || call.input.length < 10 + 64 * 3) return null;
  const word = (i: number) => call.input.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const domain = Number.parseInt(word(1), 16);
  return Number.isSafeInteger(domain) ? { domain, mintRecipient: `0x${word(2)}` } : null;
}

/** `receiveMessage(bytes,bytes)` (MessageTransmitterV2) and BridgeReceiver's `relay(bytes,bytes)`. */
const CCTP_MINTS = ["0x57ecfd28", "0x564a5158"];

/** A CCTP mint on Injective, read from the call (anyone's): where it was burned, and who it
 *  pays. Its first argument is the attested message (the source domain at bytes 4 to 8, the
 *  recipient at 184 to 216). */
function cctpMint(call: { to: string | null; input: string } | null): { domain: number; mintRecipient: string } | null {
  const to = call?.to;
  if (!to || !Object.values(NETWORKS).some((n) => n.cctp.messageTransmitter.toLowerCase() === to || n.cctp.bridgeReceiver?.toLowerCase() === to)) return null;
  if (!CCTP_MINTS.includes(call.input.slice(0, 10))) return null;
  const offset = Number.parseInt(call.input.slice(10, 74), 16);
  if (!Number.isSafeInteger(offset) || offset > 1024) return null;
  const message = call.input.slice(10 + offset * 2 + 64);
  if (message.length < 2 * 216) return null;
  const domain = Number.parseInt(message.slice(8, 16), 16);
  return Number.isSafeInteger(domain) ? { domain, mintRecipient: `0x${message.slice(368, 432)}` } : null;
}

/** What `summarize` needs to read EVM transactions for this account. */
export interface EvmView {
  /** This account's 0x address. */
  address: string;
  /** ERC20s with a bank form (lowercase address → bank denom), from the erc20 module's token
   *  pairs. Null when the node couldn't say: then no log counts, rather than one twice. */
  pairs: ReadonlyMap<string, string> | null;
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
 *  its `cw20:` key), the fee left out when `address` paid it, and who sent what arrived.
 *  `signer` says `address` signed it where the events don't name a fee payer (EVM). */
export function balanceChanges(
  events: readonly TxEvent[],
  address: string,
  fee: readonly Coin[],
  signer = false,
): { changes: Coin[]; signed: boolean; from?: string } {
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
  const signed = signer || feePayer === address;
  if (signed) add([...fee], 1n); // the fee is reported apart
  const changes = [...net].filter(([, a]) => a !== 0n).map(([denom, a]) => ({ denom, amount: a.toString() }));
  return { changes, signed, ...(from ? { from } : {}) };
}

const ERC20_DENOM = /^erc20:(0x[0-9a-fA-F]{40})$/;

export function summarize(tx: IndexedTx, address: string, evm?: EvmView): Activity {
  const call = tx.evm && tx.messages[0] ? evmCall(tx.messages[0]) : null;
  const me = evm?.address.toLowerCase();
  // An EVM transaction names no fee payer: its signer is in the signed bytes (and, when it
  // ran, in the `message` event as the bech32 sender).
  const evmSigner =
    tx.evm !== undefined &&
    ((call !== null && call.from === me) || tx.events.some((e) => e.type === "message" && attr(e, "action") === EVM_MSG && attr(e, "sender") === address));
  const bank = balanceChanges(tx.events, address, tx.fee, evmSigner);
  const { signed } = bank;
  let { changes, from } = bank;

  // ERC20 logs: who moved what, and what counts that bank events didn't already.
  const events = (tx.evm?.logs ?? []).map(erc20Event).filter((e): e is Erc20Event => e !== null);
  const local = new Map<string, string>(); // bank-backed tokens this tx's bank events name
  for (const e of tx.events) {
    if (e.type !== "coin_spent" && e.type !== "coin_received") continue;
    for (const c of parseCoins(attr(e, "amount") ?? "")) {
      const m = ERC20_DENOM.exec(c.denom);
      if (m) local.set(m[1]!.toLowerCase(), c.denom);
    }
  }
  const bankOf = (token: string) => evm?.pairs?.get(token) ?? local.get(token);
  const keyOf = (token: string) => bankOf(token) ?? evmDenom(token);
  const transfers = events.filter((e): e is Extract<Erc20Event, { kind: "transfer" }> => e.kind === "transfer" && e.amount > 0n);
  if (me && evm?.pairs) {
    const net = new Map(changes.map((c) => [c.denom, BigInt(c.amount)])); // signed, from balanceChanges
    for (const m of transfers) {
      if (bankOf(m.token)) continue;
      const key = evmDenom(m.token);
      if (m.to === me) net.set(key, (net.get(key) ?? 0n) + m.amount);
      if (m.from === me) net.set(key, (net.get(key) ?? 0n) - m.amount);
    }
    changes = [...net].filter(([, a]) => a !== 0n).map(([denom, a]) => ({ denom, amount: a.toString() }));
  }
  if (tx.evm && me) {
    // Who sent what arrived, in the EVM's own terms.
    const t = transfers.find((m) => m.to === me);
    if (t) from = t.from;
    else if (call && call.to === me && call.value > 0n) from = call.from;
  }

  const ups = changes.filter((c) => !c.amount.startsWith("-")).length;
  const downs = changes.length - ups;
  const up = ups > 0;
  const down = downs > 0;

  const base = {
    hash: tx.hash,
    height: tx.height.toString(),
    time: tx.time,
    ok: tx.code === 0,
    signed,
    changes,
    fee: signed ? tx.fee : [],
    ...(tx.evm?.hash ? { evmHash: tx.evm.hash } : {}),
  };
  const types = tx.messages.map((m) => String(m["@type"] ?? ""));
  const first = tx.messages[0] ?? {};
  const t = types[0] ?? "";
  const str = (k: string) => (typeof first[k] === "string" ? (first[k] as string) : undefined);
  const kindOf = (kind: ActivityKind, counterparty?: string): Activity => ({ ...base, kind, ...(counterparty ? { counterparty } : {}) });

  if (t === EVM_MSG) {
    // USDC bridged in, minted by whoever submitted it (Choice's bridge service, or this account).
    const mint = up && !down ? cctpMint(call) : null;
    if (mint) return { ...kindOf("bridge"), bridge: { ...mint, incoming: true } };
    if (!signed && up && !down) return kindOf("receive", from);
    const burn = signed ? cctpBurn(call) : null;
    if (burn) return { ...kindOf("bridge"), bridge: burn };
    if (signed && !base.ok) {
      // It reverted: say what it tried, from the signed call.
      const to = call ? transferRecipient(call.input) : null;
      if (to) return kindOf("send", to);
      if (call?.to && call.input === "0x" && call.value > 0n) return kindOf("send", call.to);
      return call?.to ? kindOf("contract", call.to) : kindOf("evm");
    }
    if (signed) {
      const approvals = events.filter((e): e is Extract<Erc20Event, { kind: "approval" }> => e.kind === "approval" && e.owner === me);
      const a = approvals[approvals.length - 1];
      if (changes.length === 0 && a) return { ...kindOf("approve", a.spender), approval: { denom: keyOf(a.token), spender: a.spender, amount: a.amount.toString() } };
      if (downs === 1 && ups === 0) {
        const outs = transfers.filter((m) => m.from === me);
        if (outs.length === 1 && keyOf(outs[0]!.token) === changes[0]!.denom) return kindOf("send", outs[0]!.to);
        if (outs.length === 0 && call?.to && call.input === "0x" && changes[0]!.denom === "inj") return kindOf("send", call.to);
      }
    }
    if (ups === 1 && downs === 1) {
      // INJ wrapped into (or out of) the contract called, one for one: wINJ.
      const [a, b] = changes as [Coin, Coin];
      const same = a.amount.replace("-", "") === b.amount.replace("-", "");
      const other = a.denom === "inj" ? b.denom : b.denom === "inj" ? a.denom : null;
      if (same && other && call?.to && other.toLowerCase() === `erc20:${call.to}`) return kindOf("convert");
      return kindOf("swap");
    }
    if (call && call.to === null) return { ...kindOf("other"), label: "Contract created" };
    return kindOf("contract", call?.to ?? undefined);
  }

  if (t === "/cosmos.bank.v1beta1.MsgSend") {
    if (str("from_address") === address) return kindOf("send", str("to_address"));
    if (str("to_address") === address) return kindOf("receive", str("from_address"));
  }
  if (types.includes("/ibc.core.channel.v1.MsgRecvPacket") && up && !down) return kindOf("receive");
  if (!signed && up && !down) return kindOf("receive", from);
  if (t === "/ibc.applications.transfer.v1.MsgTransfer") return kindOf("ibc", str("receiver"));
  if (t === "/cosmos.staking.v1beta1.MsgDelegate") return kindOf("stake", str("validator_address"));
  if (t === "/cosmos.staking.v1beta1.MsgUndelegate") return kindOf("unstake", str("validator_address"));
  // Cancelling an unstaking stakes it again.
  if (t === "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation") return kindOf("stake", str("validator_address"));
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
  if (t === "/cosmos.bank.v1beta1.MsgMultiSend") return kindOf(up ? "receive" : "send");
  if (t === "/cosmos.gov.v1beta1.MsgVote" || t === "/cosmos.gov.v1.MsgVote") {
    const option = ({ VOTE_OPTION_YES: "Yes", VOTE_OPTION_NO: "No", VOTE_OPTION_ABSTAIN: "Abstain", VOTE_OPTION_NO_WITH_VETO: "No with veto" } as Record<string, string>)[str("option") ?? ""];
    const id = str("proposal_id");
    return { ...kindOf("other"), label: option && id && /^[1-9][0-9]{0,19}$/.test(id) ? `Voted ${option} on proposal ${id}` : "Voted" };
  }
  const name = t.split(".").pop() ?? "";
  return { ...kindOf("other"), label: name.replace(/^Msg/, "") || "Transaction" };
}

/** Two pages of the index merged: one per query, the same tx once, newest first. */
export function mergeActivity(lists: readonly (readonly Activity[])[]): Activity[] {
  const byHash = new Map<string, Activity>();
  for (const list of lists) for (const a of list) if (!byHash.has(a.hash)) byHash.set(a.hash, a);
  return [...byHash.values()].sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0));
}
