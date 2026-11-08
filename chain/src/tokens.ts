// What the wallet shows for a bank denom. A short list of tokens the wallet knows is checked
// by hand; everything else shows the symbol its creator set, which proves nothing, so the
// UI marks it and shows the denom too.

import type { DenomMetadata, Lcd } from "./lcd.ts";
import type { NetworkId } from "./networks.ts";

export interface Token {
  denom: string;
  symbol: string;
  name: string;
  decimals: number;
  /** On the wallet's own list. */
  known: boolean;
}

type Entry = readonly [symbol: string, name: string, decimals: number];

// Checked 2026-11-08 against mainnet: Peggy denoms are the Ethereum contracts' addresses;
// IBC denoms hash their trace (channel-1 → cosmoshub-4, channel-148 → noble-1); the
// erc20: denom is Circle's USDC on Injective EVM (CCTP domain 29).
const KNOWN: Readonly<Record<NetworkId, Readonly<Record<string, Entry>>>> = {
  mainnet: {
    inj: ["INJ", "Injective", 18],
    "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a": ["USDC", "USD Coin", 6],
    "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E": ["USDC", "USD Coin (Noble)", 6],
    peggy0xdAC17F958D2ee523a2206206994597C13D831ec7: ["USDT", "Tether USD (Peggy)", 6],
    peggy0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: ["USDC", "USD Coin (Peggy)", 6],
    peggy0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2: ["WETH", "Wrapped Ether (Peggy)", 18],
    "ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9": ["ATOM", "Cosmos Hub", 6],
  },
  testnet: {
    inj: ["INJ", "Injective", 18],
  },
};

/** A token on the wallet's list, or null. */
export function knownToken(network: NetworkId, denom: string): Token | null {
  const e = KNOWN[network][denom];
  return e ? { denom, symbol: e[0], name: e[1], decimals: e[2], known: true } : null;
}

/** Describe a denom: the wallet's list first, then the chain's metadata. */
export async function describeToken(lcd: Lcd, network: NetworkId, denom: string): Promise<Token> {
  const k = knownToken(network, denom);
  if (k) return k;
  let m: DenomMetadata | null = null;
  try {
    m = await lcd.denomMetadata(denom);
  } catch {
    // No metadata is shown as raw base units, which is never wrong.
  }
  const symbol = clean(m?.symbol ?? "", 12) || shortDenom(denom);
  return { denom, symbol, name: clean(m?.name ?? "", 40), decimals: m?.decimals ?? 0, known: false };
}

/** `factory/inj1abc…xyz/sub` → something that fits on one line. */
export function shortDenom(denom: string): string {
  if (denom.length <= 20) return denom;
  return `${denom.slice(0, 12)}…${denom.slice(-6)}`;
}

/** Strip what can disguise text (control, bidi and zero-width characters) and cap the length. */
function clean(s: string, max: number): string {
  const t = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
