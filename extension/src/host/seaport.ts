// Seaport listings this wallet signed (run-5). Seaport ends all of an account's orders by
// moving its counter with `incrementCounter()`, by the last block's hash. Injective's EVM
// answers BLOCKHASH with zero (its stored headers carry no validator hash), so there that
// cancels nothing, and a listing ends only by `cancel()` with the order as signed, which only
// its signer has. So the wallet keeps each Seaport 1.6 order it signs, until it ends, and
// Approvals lists those still open, each with a cancel. A listing signed with this key
// elsewhere isn't known here, and Approvals says so.

import { isObject, SEAPORT, type EvmRpc } from "@choice-wallet/chain";
import { keccak_256 } from "@noble/hashes/sha3";

import type { Store } from "./service";
import type { Turn } from "./util";

/** Records kept per account and chain; the oldest go first. */
const MAX_RECORDS = 100;
/** Orders checked on chain at once. */
const MAX_CHECKS = 50;
/** Items one order may carry for the wallet to keep it (the vault's own cancel takes as many). */
const MAX_ITEMS = 100;

/** An offered item, for the screen: what kind, which contract and, for an NFT, which one. */
export interface SeaportOffer {
  /** Seaport's item type: 0 the coin, 1 an ERC20, 2 an ERC721, 3 an ERC1155, 4 and 5 any of
   *  a collection (by criteria). */
  kind: number;
  token: string;
  id: string;
  amount: string;
}

/** One order this wallet signed, as signed. */
export interface SeaportOrder {
  /** Seaport's order hash (the EIP-712 struct hash of the order). */
  hash: string;
  /** The order's fields as signed, for `cancel()`. */
  order: Record<string, unknown>;
  /** Unix seconds when it stops being fillable. */
  end: number;
  /** Decimal: the counter it was signed under. */
  counter: string;
  offer: SeaportOffer[];
}

type Records = Record<string, SeaportOrder[]>;
const key = (chain: string, owner: string) => `${chain} ${owner}`.toLowerCase();

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const keccak = (parts: string[]) => hex(keccak_256(Uint8Array.from((parts.join("").match(/../g) ?? []).map((h) => parseInt(h, 16)))));
const typeHash = (s: string) => hex(keccak_256(enc.encode(s)));
const OFFER_ITEM = "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)";
const CONSIDERATION_ITEM = "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)";
const ORDER = `OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)${CONSIDERATION_ITEM}${OFFER_ITEM}`;

/** An unsigned integer as the vault reads it: a JSON number only while exact, or a decimal or
 *  hex string. */
function uint(v: unknown): bigint | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string" || !/^(0[xX][0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) return null;
  const n = BigInt(v.replace(/^0X/, "0x"));
  return n < 1n << 256n ? n : null;
}
const addr = (v: unknown) => (typeof v === "string" && /^0[xX][0-9a-fA-F]{40}$/.test(v) ? `0x${v.slice(2).toLowerCase()}` : null);
const bytes32 = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.slice(2).toLowerCase() : null);
const w = (n: bigint) => n.toString(16).padStart(64, "0");
const wa = (a: string) => a.slice(2).padStart(64, "0");
const seconds = (n: bigint) => (n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n));

/** Seaport's order hash of `m` (an OrderComponents), or null for one the vault couldn't cancel
 *  as it stands (a field missing or out of range, or more items than it takes). */
export function orderHash(m: Record<string, unknown>): string | null {
  const [offerer, zone, orderType, start, end, zoneHash, salt, conduitKey, counter] = [
    addr(m["offerer"]),
    addr(m["zone"]),
    uint(m["orderType"]),
    uint(m["startTime"]),
    uint(m["endTime"]),
    bytes32(m["zoneHash"]),
    uint(m["salt"]),
    bytes32(m["conduitKey"]),
    uint(m["counter"]),
  ];
  if (!offerer || !zone || orderType === null || orderType > 4n || start === null || end === null || !zoneHash || salt === null || !conduitKey || counter === null) return null;
  const items = (list: unknown, recipient: boolean): string | null => {
    if (!Array.isArray(list) || list.length > MAX_ITEMS) return null;
    const hashes: string[] = [];
    for (const i of list) {
      if (!isObject(i)) return null;
      const [kind, token, id, from, to] = [uint(i["itemType"]), addr(i["token"]), uint(i["identifierOrCriteria"]), uint(i["startAmount"]), uint(i["endAmount"])];
      const who = recipient ? addr(i["recipient"]) : "";
      if (kind === null || kind > 5n || !token || id === null || from === null || to === null || who === null) return null;
      hashes.push(keccak([typeHash(recipient ? CONSIDERATION_ITEM : OFFER_ITEM), w(kind), wa(token), w(id), w(from), w(to), ...(recipient ? [wa(who)] : [])]));
    }
    return keccak(hashes);
  };
  const [offer, consideration] = [items(m["offer"], false), items(m["consideration"], true)];
  if (offer === null || consideration === null) return null;
  return `0x${keccak([typeHash(ORDER), wa(offerer), wa(zone), offer, consideration, w(orderType), w(start), w(end), zoneHash, w(salt), conduitKey, w(counter)])}`;
}

/** The order a Seaport typed-data signature (Seaport 1.6's own address, `OrderComponents`)
 *  makes, its signer, and its chain (`eip155:<id>`); null for anything else, or one the vault
 *  couldn't cancel. */
export function orderOf(typed: unknown): { chain: string; offerer: string; order: SeaportOrder } | null {
  let td: unknown = typed;
  if (typeof td === "string") {
    try {
      td = JSON.parse(td);
    } catch {
      return null;
    }
  }
  if (!isObject(td) || !isObject(td["domain"]) || td["primaryType"] !== "OrderComponents" || !isObject(td["message"])) return null;
  const domain = td["domain"];
  if (domain["name"] !== "Seaport" || addr(domain["verifyingContract"]) !== SEAPORT.toLowerCase()) return null;
  const id = uint(domain["chainId"]);
  const m = td["message"];
  const hash = orderHash(m);
  const offerer = addr(m["offerer"]);
  if (id === null || id === 0n || !hash || !offerer) return null;
  const offer = (m["offer"] as Record<string, unknown>[]).slice(0, 3).map((i) => ({ kind: Number(uint(i["itemType"])), token: addr(i["token"])!, id: uint(i["identifierOrCriteria"])!.toString(), amount: uint(i["startAmount"])!.toString() }));
  return { chain: `eip155:${id}`, offerer, order: { hash, order: m, end: seconds(uint(m["endTime"])!), counter: uint(m["counter"])!.toString(), offer } };
}

/** A Seaport 1.6 order the wallet couldn't keep: it isn't signed, since on a chain where
 *  cancel-all does nothing it could then never be cancelled here. */
export function unkept(typed: unknown): boolean {
  let td: unknown = typed;
  if (typeof td === "string") {
    try {
      td = JSON.parse(td);
    } catch {
      return false;
    }
  }
  if (!isObject(td) || !isObject(td["domain"]) || td["primaryType"] !== "OrderComponents") return false;
  const domain = td["domain"];
  return domain["name"] === "Seaport" && addr(domain["verifyingContract"]) === SEAPORT.toLowerCase() && orderOf(td) === null;
}

const GET_COUNTER = "0xf07ec373";
const INCREMENT_COUNTER = "0x5b34b966";
const ORDER_STATUS = "0x46423aa7";

/** Whether Seaport's `incrementCounter()` would leave `owner`'s counter where it is on the chain
 *  `rpc` serves: true there (it would cancel nothing), false where it moves it, null when the
 *  endpoint couldn't say. */
export async function counterStuck(rpc: EvmRpc, owner: string): Promise<boolean | null> {
  try {
    const [now, next] = await rpc.batch([
      { method: "eth_call", params: [{ to: SEAPORT, data: `${GET_COUNTER}${wa(owner.toLowerCase())}` }, "latest"] },
      { method: "eth_call", params: [{ from: owner, to: SEAPORT, data: INCREMENT_COUNTER }, "latest"] },
    ]);
    const n = (r: unknown) => (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r) ? BigInt(r) : null);
    const [a, b] = [n(now), n(next)];
    return a === null || b === null ? null : a === b;
  } catch {
    return null;
  }
}

/** `turn`: the queue the account records share, so a pruning never undoes a record. */
export function createSeaport(local: Store, now: () => number = () => Math.floor(Date.now() / 1000), turn: Turn = (work) => work()) {
  async function all(): Promise<Records> {
    const { seaport_signed } = await local.get(["seaport_signed"]);
    return isObject(seaport_signed) ? (seaport_signed as Records) : {};
  }

  /** Keep the order of a Seaport signature `owner` just made. */
  async function record(owner: string, typed: unknown): Promise<void> {
    const got = orderOf(typed);
    if (!got || got.offerer !== owner.toLowerCase()) return;
    await turn(async () => {
      const records = await all();
      const k = key(got.chain, owner);
      const at = now();
      const kept = [...(records[k] ?? []).filter((o) => o.end >= at && o.hash !== got.order.hash), got.order];
      // Past the cap the oldest go, and until the last of them ends the wallet says it can't
      // tell they were all cancelled: an open listing is never dropped unsaid.
      const dropped = kept.slice(0, Math.max(0, kept.length - MAX_RECORDS));
      const { seaport_overflow } = await local.get(["seaport_overflow"]);
      const over = isObject(seaport_overflow) ? (seaport_overflow as Record<string, number>) : {};
      const until = Math.max(over[k] ?? 0, ...dropped.map((o) => o.end));
      await local.set({
        seaport_signed: { ...records, [k]: kept.slice(-MAX_RECORDS) },
        ...(dropped.length > 0 ? { seaport_overflow: { ...over, [k]: until } } : {}),
      });
    });
  }

  /** The order `owner` signed on `chain` with hash `hash`, unexpired. */
  async function find(chain: string, owner: string, hash: string): Promise<SeaportOrder | null> {
    return ((await all())[key(chain, owner)] ?? []).find((o) => o.hash === hash.toLowerCase() && o.end >= now()) ?? null;
  }

  /** The orders `owner` signed on `chain` that may still be filled: unexpired, and neither
   *  cancelled, filled, nor left behind by the counter as far as `rpc` says (null: it couldn't
   *  say). One that couldn't be checked counts as open, and is said to be unchecked. */
  async function live(chain: string, owner: string, rpc: EvmRpc | null): Promise<{ orders: SeaportOrder[]; unchecked: boolean }> {
    const at = now();
    const mine = ((await all())[key(chain, owner)] ?? []).filter((o) => o.end >= at);
    const { seaport_overflow } = await local.get(["seaport_overflow"]);
    const over = isObject(seaport_overflow) ? (seaport_overflow as Record<string, number>)[key(chain, owner)] : undefined;
    let unchecked = typeof over === "number" && over >= at;
    if (mine.length === 0) return { orders: [], unchecked };
    if (!rpc) return { orders: mine, unchecked: true };
    // The newest first: past the cap the rest count as open, unchecked.
    const checked = mine.slice(-MAX_CHECKS);
    const out = mine.slice(0, -MAX_CHECKS);
    if (out.length > 0) unchecked = true;
    try {
      const answers = await rpc.batch([
        { method: "eth_call", params: [{ to: SEAPORT, data: `${GET_COUNTER}${wa(owner.toLowerCase())}` }, "latest"] },
        ...checked.map((o) => ({ method: "eth_call", params: [{ to: SEAPORT, data: `${ORDER_STATUS}${o.hash.slice(2)}` }, "latest"] })),
      ]);
      const c = answers[0];
      const counter = typeof c === "string" && /^0x[0-9a-fA-F]{64}$/.test(c) ? BigInt(c) : null;
      checked.forEach((o, i) => {
        const s = answers[i + 1];
        // getOrderStatus: isValidated, isCancelled, totalFilled, totalSize.
        if (counter === null || typeof s !== "string" || !/^0x[0-9a-fA-F]{256}$/.test(s)) {
          unchecked = true;
          out.push(o);
          return;
        }
        const word = (n: number) => BigInt(`0x${s.slice(2 + 64 * n, 66 + 64 * n)}`);
        const [cancelled, filled, size] = [word(1) !== 0n, word(2), word(3)];
        if (counter === BigInt(o.counter) && !cancelled && !(size > 0n && filled >= size)) out.push(o);
      });
    } catch {
      return { orders: mine, unchecked: true };
    }
    return { orders: out, unchecked };
  }

  // A reset removes them with the wallet's records; a removed account's go in its pruning
  // (service.ts, forgetGone).
  return { record, find, live };
}

export type SeaportRecords = ReturnType<typeof createSeaport>;
