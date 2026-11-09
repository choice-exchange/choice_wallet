// Staking as the LCD reports it: the bonded validators, an account's stakes, what it is
// unstaking and its unclaimed rewards. Each answer is checked; amounts are bigints in base
// units of the bond denom (INJ on Injective).
//
// Validator names, websites and details are whatever each validator wrote: shown as plain
// text, never proof of who runs it.

import { Down, isObject } from "./pool.ts";
import { cleanText } from "./tokens.ts";

export interface Validator {
  /** Operator address, `injvaloper1…`. */
  address: string;
  moniker: string;
  website: string;
  /** 0 to 1. */
  commission: number;
  /** Bonded tokens: its voting power. */
  tokens: bigint;
  jailed: boolean;
}

export interface Delegation {
  validator: string;
  amount: bigint;
}

export interface Unbonding {
  validator: string;
  amount: bigint;
  /** The height it started at, which cancelling it names. */
  height: bigint;
  /** ISO 8601. */
  completes: string;
}

/** Longest validator name kept, in characters. */
const MONIKER_MAX = 40;
const VALOPER = /^[a-z]{1,16}valoper1[02-9ac-hj-np-z]{6,90}$/;
const DIGITS = /^[0-9]{1,78}$/;
/** A chain decimal (`"0.050000000000000000"`). */
const DEC = /^([0-9]{1,78})(?:\.([0-9]{1,18}))?$/;

/** Validator-written text, cleaned like token names; whitespace runs collapse to one space. */
function text(s: unknown, max: number): string {
  return typeof s === "string" ? cleanText(s.replace(/\s+/g, " "), max) : "";
}

/** A chain decimal → bigint, rounded down (rewards owed are paid in whole base units). */
export function floorDecimal(s: string): bigint {
  const m = DEC.exec(s);
  if (!m || m[1] === undefined) throw new Down(`not a decimal: ${JSON.stringify(s)}`);
  return BigInt(m[1]);
}

/** A chain decimal fraction (commission rates) → number in 0..1. */
function rate(s: unknown): number {
  if (typeof s !== "string" || !DEC.test(s)) throw new Down("malformed rate");
  const n = Number(s);
  if (!(n >= 0 && n <= 1)) throw new Down("rate out of range");
  return n;
}

function amount(s: unknown): bigint {
  if (typeof s !== "string" || !DIGITS.test(s)) throw new Down("malformed amount");
  return BigInt(s);
}

function valoper(s: unknown): string {
  if (typeof s !== "string" || !VALOPER.test(s)) throw new Down("malformed validator address");
  return s;
}

/** One page of `/cosmos/staking/v1beta1/validators`. */
export function parseValidators(body: unknown): Validator[] {
  if (!isObject(body) || !Array.isArray(body["validators"])) throw new Down("no validators");
  return body["validators"].map((v) => {
    if (!isObject(v)) throw new Down("malformed validator");
    const d = isObject(v["description"]) ? v["description"] : {};
    const c = isObject(v["commission"]) && isObject(v["commission"]["commission_rates"]) ? v["commission"]["commission_rates"] : {};
    return {
      address: valoper(v["operator_address"]),
      moniker: text(d["moniker"], MONIKER_MAX),
      website: text(d["website"], 100),
      commission: rate(c["rate"]),
      tokens: amount(v["tokens"]),
      jailed: v["jailed"] === true,
    };
  });
}

/** `/cosmos/staking/v1beta1/delegations/{address}`, keeping stakes in `bondDenom`. */
export function parseDelegations(body: unknown, delegator: string, bondDenom: string): Delegation[] {
  if (!isObject(body) || !Array.isArray(body["delegation_responses"])) throw new Down("no delegations");
  const out: Delegation[] = [];
  for (const r of body["delegation_responses"]) {
    const d = isObject(r) && isObject(r["delegation"]) ? r["delegation"] : null;
    const b = isObject(r) && isObject(r["balance"]) ? r["balance"] : null;
    if (!d || !b) throw new Down("malformed delegation");
    if (d["delegator_address"] !== delegator) throw new Down("the node returned another account's stake");
    if (b["denom"] !== bondDenom) continue;
    const a = amount(b["amount"]);
    if (a > 0n) out.push({ validator: valoper(d["validator_address"]), amount: a });
  }
  return out;
}

/** `/cosmos/staking/v1beta1/delegators/{address}/unbonding_delegations`: one row per entry. */
export function parseUnbonding(body: unknown, delegator: string): Unbonding[] {
  if (!isObject(body) || !Array.isArray(body["unbonding_responses"])) throw new Down("no unbonding");
  const out: Unbonding[] = [];
  for (const r of body["unbonding_responses"]) {
    if (!isObject(r) || !Array.isArray(r["entries"])) throw new Down("malformed unbonding");
    if (r["delegator_address"] !== delegator) throw new Down("the node returned another account's unbonding");
    const validator = valoper(r["validator_address"]);
    for (const e of r["entries"]) {
      if (!isObject(e) || typeof e["completion_time"] !== "string" || Number.isNaN(Date.parse(e["completion_time"]))) throw new Down("malformed unbonding entry");
      const a = amount(e["balance"]);
      if (a > 0n) out.push({ validator, amount: a, height: amount(e["creation_height"]), completes: e["completion_time"] });
    }
  }
  return out.sort((x, y) => Date.parse(x.completes) - Date.parse(y.completes));
}

/** `/cosmos/distribution/v1beta1/delegators/{address}/rewards`: unclaimed `bondDenom` per
 *  validator, rounded down. Validators owing less than one base unit are left out. */
export function parseRewards(body: unknown, bondDenom: string): Map<string, bigint> {
  if (!isObject(body) || !Array.isArray(body["rewards"])) throw new Down("no rewards");
  const out = new Map<string, bigint>();
  for (const r of body["rewards"]) {
    if (!isObject(r) || !Array.isArray(r["reward"])) throw new Down("malformed reward");
    const validator = valoper(r["validator_address"]);
    for (const c of r["reward"]) {
      if (!isObject(c) || c["denom"] !== bondDenom) continue;
      const a = floorDecimal(String(c["amount"]));
      if (a > 0n) out.set(validator, (out.get(validator) ?? 0n) + a);
    }
  }
  return out;
}

/** `unbonding_time` from `/cosmos/staking/v1beta1/params` (`"1814400s"`) in seconds. */
export function parseUnbondingTime(body: unknown): number {
  const p = isObject(body) && isObject(body["params"]) ? body["params"] : {};
  const m = /^([0-9]{1,10})(?:\.[0-9]+)?s$/.exec(String(p["unbonding_time"] ?? ""));
  if (!m) throw new Down("malformed staking params");
  return Number(m[1]);
}
