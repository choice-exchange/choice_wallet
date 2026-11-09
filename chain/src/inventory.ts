// What an account holds outside its balance: orderbook trading accounts (exchange
// subaccounts) and liquidity on Choice. All read from the chain, on the user's own endpoints;
// Choice's API is never asked about the account.
//
// - **Trading accounts.** A subaccount is the owner's 20-byte address and a 12-byte nonce.
//   No query lists an owner's subaccounts, so nonces 0 to `SUBACCOUNTS - 1` are asked
//   (the INJ orderbook's apps use the first few). Deposits come in the chain's decimal
//   format; available is what a withdrawal can take now, the rest backs open orders.
//   Derivative positions are listed as they stand.
// - **XYK liquidity.** A Choice XYK pair's share is the bank denom `factory/{pair}/lp`; the
//   pair names it (`pair {}`), and `pool {}` gives its assets and total shares, so a held
//   share is worth its part of each asset.
// - **CLMM liquidity.** Choice's CLMM position manager (pinned per network) holds every
//   position in the pools and issues the owner an NFT for each: `tokens { owner }`, page by
//   page, then `position_with_fees` for its pool, range, liquidity and fees owed. Amounts
//   come from the liquidity and the pool's price (`get_slot0`, a Q96 square root; Uniswap v3
//   math in floating point: display only).

import type { Lcd } from "./lcd.ts";
import { ChainError, isObject } from "./pool.ts";

/** Subaccount nonces asked. */
export const SUBACCOUNTS = 10;
const CONTRACT = /^inj1[02-9ac-hj-np-z]{38,58}$/;

export type Deposit = { denom: string; available: bigint; total: bigint };
export type Position = { marketId: string; long: boolean; quantity: string; entryPrice: string; margin: string };
export type Subaccount = { id: string; nonce: number; deposits: Deposit[]; positions: Position[] };
export type XykPosition = { pool: string; share: Deposit["denom"]; amount: bigint; totalShare: bigint; assets: { denom: string; amount: bigint }[] };
export type ClmmPosition = {
  /** The position's NFT ID at the manager. */
  id: string;
  pool: string;
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  inRange: boolean;
  /** Base units, rounded down. */
  amount0: bigint;
  amount1: bigint;
  owed0: bigint;
  owed1: bigint;
};

/** The ID of `owner0x`'s subaccount `nonce`. */
export function subaccountId(owner0x: string, nonce: number): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner0x) || !Number.isInteger(nonce) || nonce < 0) throw new RangeError("subaccount");
  return `0x${owner0x.slice(2).toLowerCase()}${nonce.toString(16).padStart(24, "0")}`;
}

/** A chain decimal ("123.450000000000000000") as base units, rounded down; null if malformed. */
export function decFloor(s: unknown): bigint | null {
  if (typeof s !== "string") return null;
  const m = /^(-?)([0-9]{1,78})(?:\.[0-9]{1,18})?$/.exec(s);
  if (!m) return null;
  return m[1] ? -BigInt(m[2]!) : BigInt(m[2]!);
}

const quiet = (e: unknown) => e instanceof ChainError;

/** The account's trading subaccounts with anything in them. */
export async function subaccounts(lcd: Lcd, owner0x: string, count = SUBACCOUNTS): Promise<Subaccount[]> {
  const out: Subaccount[] = [];
  for (let nonce = 0; nonce < count; nonce++) {
    const id = subaccountId(owner0x, nonce);
    let deposits: Deposit[] = [];
    let positions: Position[] = [];
    try {
      const body = await lcd.get(`/injective/exchange/v2/exchange/subaccountDeposits?subaccount_id=${id}`);
      const map = isObject(body) && isObject(body["deposits"]) ? body["deposits"] : {};
      deposits = Object.entries(map)
        .map(([denom, d]) => ({ denom, available: decFloor(isObject(d) ? d["available_balance"] : null) ?? 0n, total: decFloor(isObject(d) ? d["total_balance"] : null) ?? 0n }))
        .filter((d) => d.total > 0n || d.available > 0n);
    } catch (e) {
      if (!quiet(e)) throw e;
    }
    try {
      const body = await lcd.get(`/injective/exchange/v2/subaccount_positions/${id}`);
      const list = isObject(body) && Array.isArray(body["state"]) ? body["state"] : [];
      positions = list.flatMap((p: unknown) => {
        if (!isObject(p) || !isObject(p["position"]) || typeof p["market_id"] !== "string") return [];
        const q = p["position"];
        return [{ marketId: p["market_id"], long: q["isLong"] === true, quantity: String(q["quantity"] ?? "0"), entryPrice: String(q["entry_price"] ?? "0"), margin: String(q["margin"] ?? "0") }];
      });
    } catch (e) {
      if (!quiet(e)) throw e;
    }
    if (deposits.length || positions.length) out.push({ id, nonce, deposits, positions });
  }
  return out;
}

/** The XYK shares among `held` (bank coins), each valued from its pair. */
export async function xykPositions(lcd: Lcd, held: readonly { denom: string; amount: string }[]): Promise<XykPosition[]> {
  const out: XykPosition[] = [];
  for (const c of held) {
    const m = /^factory\/(inj1[02-9ac-hj-np-z]{38,58})\/lp$/.exec(c.denom);
    const amount = BigInt(c.amount);
    if (!m || amount <= 0n) continue;
    const pool = m[1]!;
    const pair = await lcd.smart(pool, { pair: {} });
    // The pair must name this share, or it's someone's token that only looks like one.
    if (!isObject(pair) || pair["liquidity_token"] !== c.denom) continue;
    const p = await lcd.smart(pool, { pool: {} });
    if (!isObject(p) || !Array.isArray(p["assets"]) || typeof p["total_share"] !== "string" || !/^[0-9]{1,78}$/.test(p["total_share"])) continue;
    const totalShare = BigInt(p["total_share"]);
    if (totalShare === 0n) continue;
    const assets = (p["assets"] as unknown[]).flatMap((a) => {
      if (!isObject(a) || typeof a["amount"] !== "string" || !/^[0-9]{1,78}$/.test(a["amount"]) || !isObject(a["info"])) return [];
      const info = a["info"];
      const denom = isObject(info["native_token"]) && typeof info["native_token"]["denom"] === "string" ? info["native_token"]["denom"] : isObject(info["token"]) && typeof info["token"]["contract_addr"] === "string" ? `cw20:${info["token"]["contract_addr"]}` : null;
      return denom ? [{ denom, amount: (BigInt(a["amount"]) * amount) / totalShare }] : [];
    });
    out.push({ pool, share: c.denom, amount, totalShare, assets });
  }
  return out;
}

const tokenDenom = (t: unknown): string | null =>
  isObject(t) && isObject(t["native_token"]) && typeof t["native_token"]["denom"] === "string"
    ? t["native_token"]["denom"]
    : isObject(t) && isObject(t["token"]) && typeof t["token"]["contract_addr"] === "string"
      ? `cw20:${t["token"]["contract_addr"]}`
      : null;

/** Token amounts of a Uniswap v3 position: `liquidity` between two ticks at a Q96 sqrt price. */
export function clmmAmounts(liquidity: bigint, tickLower: number, tickUpper: number, sqrtPriceQ96: bigint): { amount0: bigint; amount1: bigint; inRange: boolean } {
  const L = Number(liquidity);
  const p = Number(sqrtPriceQ96) / 2 ** 96;
  const a = Math.pow(1.0001, tickLower / 2);
  const b = Math.pow(1.0001, tickUpper / 2);
  const floor = (x: number) => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x)) : 0n);
  if (p <= a) return { amount0: floor((L * (b - a)) / (a * b)), amount1: 0n, inRange: false };
  if (p >= b) return { amount0: 0n, amount1: floor(L * (b - a)), inRange: false };
  return { amount0: floor((L * (b - p)) / (p * b)), amount1: floor(L * (p - a)), inRange: true };
}

/** `owner`'s Choice CLMM positions: the NFTs Choice's position manager issued it (every
 *  page), each read with its fees owed, valued at its pool's price. */
export async function clmmPositions(lcd: Lcd, manager: string, owner: string, max = 200): Promise<ClmmPosition[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await lcd.smart(manager, { tokens: { owner, limit: 100, ...(after === undefined ? {} : { start_after: after }) } });
    const page = isObject(r) && Array.isArray(r["tokens"]) ? (r["tokens"] as unknown[]).filter((t): t is string => typeof t === "string" && /^[0-9]{1,20}$/.test(t)) : [];
    ids.push(...page.filter((t) => !ids.includes(t)));
    if (page.length < 100 || ids.length >= max || page.at(-1) === after) break;
    after = page.at(-1);
  }
  const prices = new Map<string, bigint | null>();
  const uint = (v: unknown) => (typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : 0n);
  const out: ClmmPosition[] = [];
  for (const id of ids.slice(0, max)) {
    const r = await lcd.smart(manager, { position_with_fees: { token_id: id } });
    const p = isObject(r) && isObject(r["position"]) ? r["position"] : null;
    if (!p || !isObject(r)) continue;
    const pool = p["pool_address"];
    const token0 = tokenDenom(p["token0"]);
    const token1 = tokenDenom(p["token1"]);
    if (typeof pool !== "string" || !CONTRACT.test(pool) || !token0 || !token1 || typeof p["tick_lower"] !== "number" || typeof p["tick_upper"] !== "number") continue;
    if (!prices.has(pool)) {
      const slot0 = await lcd.smart(pool, { get_slot0: {} });
      prices.set(pool, isObject(slot0) && typeof slot0["sqrt_price"] === "string" && /^[0-9]{1,80}$/.test(slot0["sqrt_price"]) ? BigInt(slot0["sqrt_price"]) : null);
    }
    const sqrt = prices.get(pool);
    if (!sqrt) continue;
    const liquidity = uint(r["liquidity"]);
    const owed0 = uint(r["tokens_owed_0"]);
    const owed1 = uint(r["tokens_owed_1"]);
    if (liquidity === 0n && owed0 === 0n && owed1 === 0n) continue;
    out.push({ id, pool, token0, token1, tickLower: p["tick_lower"], tickUpper: p["tick_upper"], liquidity, owed0, owed1, ...clmmAmounts(liquidity, p["tick_lower"], p["tick_upper"], sqrt) });
  }
  return out;
}
