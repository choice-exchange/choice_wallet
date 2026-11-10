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

// Each chain's tokens are priced where they trade: Injective's by Choice (above), Solana's by
// Jupiter (its aggregator, which routes most of Solana's volume), and the EVM chains' by
// DefiLlama (by chain and contract, from each chain's own markets). Each is asked about the
// same fixed list for every user (each chain's coin and stablecoins), never about what one
// account holds. Both answer extension origins (checked 2026-11-10).

export const JUPITER_PRICES = "https://lite-api.jup.ag/price/v3";
export const LLAMA_PRICES = "https://coins.llama.fi/prices/current";

/** A price as the wallet keeps it: a plain decimal string, or nothing. */
function decimal(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const s = v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return /^[0-9]+(\.[0-9]+)?$/.test(s) && Number(s) > 0 ? s : null;
}

/** USD per whole token on Solana, by mint (Jupiter's price API). A mint it can't price is
 *  absent. */
export async function fetchJupiterPrices(fetch: Fetch, mints: readonly string[], url = JUPITER_PRICES): Promise<Map<string, string>> {
  const r = await fetch(`${url}?ids=${mints.map(encodeURIComponent).join(",")}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Jupiter prices: HTTP ${r.status}`);
  const body: unknown = await r.json();
  if (!isObject(body)) throw new Error("Jupiter prices: unexpected response");
  const out = new Map<string, string>();
  for (const m of mints) {
    const entry = body[m];
    const p = isObject(entry) ? decimal(entry["usdPrice"]) : null;
    if (p) out.set(m, p);
  }
  return out;
}

/** USD per whole token by DefiLlama key (`base:0x…`, the zero address for a chain's coin).
 *  Only confident prices (DefiLlama's own measure, 0.9 and up) count. */
export async function fetchLlamaPrices(fetch: Fetch, keys: readonly string[], url = LLAMA_PRICES): Promise<Map<string, string>> {
  const r = await fetch(`${url}/${keys.join(",")}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`DefiLlama prices: HTTP ${r.status}`);
  const body: unknown = await r.json();
  const coins = isObject(body) ? body["coins"] : null;
  if (!isObject(coins)) throw new Error("DefiLlama prices: unexpected response");
  // Keys come back as asked, though an address's case may not.
  const lower = new Map(Object.entries(coins).map(([k, v]) => [k.toLowerCase(), v]));
  const out = new Map<string, string>();
  for (const k of keys) {
    const entry = lower.get(k.toLowerCase());
    if (!isObject(entry) || typeof entry["confidence"] !== "number" || entry["confidence"] < 0.9) continue;
    const p = decimal(entry["price"]);
    if (p) out.set(k, p);
  }
  return out;
}
