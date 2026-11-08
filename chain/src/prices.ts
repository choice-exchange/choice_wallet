// USD prices, from Choice's price index (oracle-anchored; see choice.exchange). Display
// only: a price never reaches a transaction, and with no prices the wallet shows amounts
// alone.
//
// The whole list is fetched, never a question about particular tokens, so the server
// learns nothing about what this wallet holds. It is keyed by EVM address (native INJ is
// the zero address); a bank denom maps to its address through the chain's erc20 module
// (`Lcd.tokenPairs`), read from the user's own endpoints.

import { isObject, type Fetch } from "./pool.ts";
import { formatUnits } from "./units.ts";

export const CHOICE_PRICES = "https://evm-api.choice.exchange/prices";
/** How this wallet names itself to Choice's API gate. */
export const CLIENT = "choice-wallet/0.1.0";

export interface PriceList {
  observedAt: string;
  /** USD per whole token, by lowercase EVM address. A token Choice can't price is absent. */
  prices: Map<string, string>;
}

export async function fetchPrices(fetch: Fetch, url = CHOICE_PRICES): Promise<PriceList> {
  const r = await fetch(url, { headers: { "x-client": CLIENT }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`prices: HTTP ${r.status}`);
  const body: unknown = await r.json();
  if (!isObject(body) || !Array.isArray(body["prices"])) throw new Error("prices: unexpected response");
  const prices = new Map<string, string>();
  for (const p of body["prices"]) {
    if (isObject(p) && typeof p["address"] === "string" && typeof p["priceUsd"] === "string" && /^[0-9]+(\.[0-9]+)?$/.test(p["priceUsd"])) {
      prices.set(p["address"].toLowerCase(), p["priceUsd"]);
    }
  }
  return { observedAt: String(body["observedAt"] ?? ""), prices };
}

const NATIVE = "0x0000000000000000000000000000000000000000";

/** The address Choice prices a denom under, if it has one. A CW20 is priced as its
 *  adapter bank denom (`cw20Bank`), the same token one for one. */
export function priceAddress(denom: string, pairs: ReadonlyMap<string, string>, cw20Bank?: (denom: string) => string | null): string | undefined {
  if (denom === "inj") return NATIVE;
  if (denom.startsWith("erc20:")) return denom.slice("erc20:".length).toLowerCase();
  if (denom.startsWith("evm:")) return denom.slice("evm:".length).toLowerCase();
  if (denom.startsWith("cw20:")) {
    const bank = cw20Bank?.(denom);
    return bank ? pairs.get(bank)?.toLowerCase() : undefined;
  }
  return pairs.get(denom)?.toLowerCase();
}

/** USD value of `amount` base units. A float: it is only ever shown. */
export function usdValue(amount: string, decimals: number, priceUsd: string): number {
  return Number(formatUnits(amount, decimals)) * Number(priceUsd);
}
