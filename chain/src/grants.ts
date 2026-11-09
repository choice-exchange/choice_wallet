// What an account lets others do: authz grants and fee allowances it gave, where its
// staking rewards go, and CW20 allowances. Each LCD answer is checked; nothing here signs.
//
// A revoke names the message type a grant covers. A generic grant says it; typed ones
// imply it (a send grant covers MsgSend, Injective's `…Authz` orderbook grants the matching
// `Msg…`, from injective-core v1.20's MsgTypeURL methods). A grant whose type the wallet
// can't tell still shows, with no revoke.

import type { Coin } from "./lcd.ts";
import { Down, isObject } from "./pool.ts";

export interface AuthzGrant {
  grantee: string;
  /** The authorization's type URL. */
  type: string;
  /** The message type the grant covers, which a revoke names; null when the wallet can't
   *  tell. */
  msgTypeUrl: string | null;
  /** A send grant's limit (empty: none given). */
  spendLimit?: Coin[];
  /** A send grant's allowed recipients (empty: anyone). */
  allowList?: string[];
  /** ISO 8601; null for no end. */
  expiration: string | null;
}

export interface FeeGrant {
  grantee: string;
  /** The allowance's type URL. */
  type: string;
  /** Empty for no limit. */
  spendLimit: Coin[];
  /** ISO 8601; null for no end. */
  expiration: string | null;
  /** Only for these message types, when restricted. */
  allowedMessages?: string[];
}

export interface Cw20Allowance {
  spender: string;
  amount: bigint;
  /** The contract's `expires` JSON (`{"never":{}}`, `{"at_height":…}`, `{"at_time":…}`). */
  expires: string;
}

const TYPE_URL = /^\/[A-Za-z0-9._]{1,127}$/;
const ACCOUNT = /^[a-z]{1,16}1[02-9ac-hj-np-z]{38,58}$/;

const STAKE_TYPES: Record<string, string> = {
  AUTHORIZATION_TYPE_DELEGATE: "/cosmos.staking.v1beta1.MsgDelegate",
  AUTHORIZATION_TYPE_UNDELEGATE: "/cosmos.staking.v1beta1.MsgUndelegate",
  AUTHORIZATION_TYPE_REDELEGATE: "/cosmos.staking.v1beta1.MsgBeginRedelegate",
  AUTHORIZATION_TYPE_CANCEL_UNBONDING_DELEGATION: "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation",
};

const FIXED: Record<string, string> = {
  "/cosmos.bank.v1beta1.SendAuthorization": "/cosmos.bank.v1beta1.MsgSend",
  "/cosmwasm.wasm.v1.ContractExecutionAuthorization": "/cosmwasm.wasm.v1.MsgExecuteContract",
  "/cosmwasm.wasm.v1.ContractMigrationAuthorization": "/cosmwasm.wasm.v1.MsgMigrateContract",
  "/ibc.applications.transfer.v1.TransferAuthorization": "/ibc.applications.transfer.v1.MsgTransfer",
};

/** Injective's typed orderbook grants (v1beta1 and v2): `XAuthz` covers `MsgX`. */
const EXCHANGE_AUTHZ =
  /^\/injective\.exchange\.(v1beta1|v2)\.(CreateSpotLimitOrder|CreateSpotMarketOrder|BatchCreateSpotLimitOrders|CancelSpotOrder|BatchCancelSpotOrders|CreateDerivativeLimitOrder|CreateDerivativeMarketOrder|BatchCreateDerivativeLimitOrders|CancelDerivativeOrder|BatchCancelDerivativeOrders|BatchUpdateOrders)Authz$/;

/** The message type an authorization covers, or null if the wallet can't tell. */
export function grantedMsg(auth: Record<string, unknown>): string | null {
  const type = String(auth["@type"] ?? "");
  if (type === "/cosmos.authz.v1beta1.GenericAuthorization") {
    const msg = auth["msg"];
    return typeof msg === "string" && TYPE_URL.test(msg) ? msg : null;
  }
  if (type === "/cosmos.staking.v1beta1.StakeAuthorization") return STAKE_TYPES[String(auth["authorization_type"])] ?? null;
  const fixed = FIXED[type];
  if (fixed) return fixed;
  const ex = EXCHANGE_AUTHZ.exec(type);
  return ex ? `/injective.exchange.${ex[1]}.Msg${ex[2]}` : null;
}

function coins(v: unknown): Coin[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => {
    if (!isObject(c) || typeof c["denom"] !== "string" || typeof c["amount"] !== "string" || !/^[0-9]{1,78}$/.test(c["amount"])) throw new Down("malformed coin");
    return { denom: c["denom"], amount: c["amount"] };
  });
}

function time(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new Down("malformed expiration");
  return v;
}

function account(v: unknown): string {
  if (typeof v !== "string" || !ACCOUNT.test(v)) throw new Down("malformed address");
  return v;
}

/** `/cosmos/authz/v1beta1/grants/granter/{granter}`. */
export function parseAuthzGrants(body: unknown, granter: string): AuthzGrant[] {
  if (!isObject(body) || !Array.isArray(body["grants"])) throw new Down("no grants");
  return body["grants"].map((g) => {
    if (!isObject(g) || !isObject(g["authorization"])) throw new Down("malformed grant");
    if (g["granter"] !== granter) throw new Down("the node returned another account's grants");
    const auth = g["authorization"];
    const out: AuthzGrant = {
      grantee: account(g["grantee"]),
      type: String(auth["@type"] ?? ""),
      msgTypeUrl: grantedMsg(auth),
      expiration: time(g["expiration"]),
    };
    if (out.type === "/cosmos.bank.v1beta1.SendAuthorization") {
      out.spendLimit = coins(auth["spend_limit"]);
      out.allowList = Array.isArray(auth["allow_list"]) ? auth["allow_list"].map(account) : [];
    }
    return out;
  });
}

/** Unwrap a fee allowance: its limit, end and message restriction, whatever the wrapping. */
function allowance(a: Record<string, unknown>, depth = 0): Omit<FeeGrant, "grantee"> {
  if (depth > 3) throw new Down("allowance nested too deep");
  const type = String(a["@type"] ?? "");
  if (type === "/cosmos.feegrant.v1beta1.AllowedMsgAllowance" && isObject(a["allowance"])) {
    const inner = allowance(a["allowance"], depth + 1);
    const allowed = Array.isArray(a["allowed_messages"]) ? a["allowed_messages"].filter((m): m is string => typeof m === "string") : [];
    return { ...inner, type, allowedMessages: allowed };
  }
  if (type === "/cosmos.feegrant.v1beta1.PeriodicAllowance" && isObject(a["basic"])) {
    return { ...allowance(a["basic"], depth + 1), type };
  }
  return { type, spendLimit: coins(a["spend_limit"]), expiration: time(a["expiration"]) };
}

/** `/cosmos/feegrant/v1beta1/issued/{granter}`. */
export function parseFeeGrants(body: unknown, granter: string): FeeGrant[] {
  if (!isObject(body) || !Array.isArray(body["allowances"])) throw new Down("no allowances");
  return body["allowances"].map((g) => {
    if (!isObject(g) || !isObject(g["allowance"])) throw new Down("malformed fee grant");
    if (g["granter"] !== granter) throw new Down("the node returned another account's fee grants");
    return { grantee: account(g["grantee"]), ...allowance(g["allowance"]) };
  });
}

/** `/cosmos/distribution/v1beta1/delegators/{address}/withdraw_address`. */
export function parseWithdrawAddress(body: unknown): string {
  return account(isObject(body) ? body["withdraw_address"] : undefined);
}

/** A CW20's `all_allowances` answer: spenders with something left. */
export function parseCw20Allowances(data: unknown): Cw20Allowance[] {
  if (!isObject(data) || !Array.isArray(data["allowances"])) throw new Down("no allowances");
  const out: Cw20Allowance[] = [];
  for (const a of data["allowances"]) {
    if (!isObject(a) || typeof a["allowance"] !== "string" || !/^[0-9]{1,78}$/.test(a["allowance"])) throw new Down("malformed allowance");
    const amount = BigInt(a["allowance"]);
    if (amount > 0n) out.push({ spender: account(a["spender"]), amount, expires: JSON.stringify(a["expires"] ?? { never: {} }) });
  }
  return out;
}
