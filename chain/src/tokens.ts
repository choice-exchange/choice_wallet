// What the wallet shows for a bank denom. A short list of tokens the wallet knows is checked
// by hand; everything else shows the symbol its creator set, which proves nothing, so the
// UI marks it and shows the denom too.

import type { DenomMetadata, Lcd } from "./lcd.ts";
import { NETWORKS, type NetworkId } from "./networks.ts";
import { ChainError } from "./pool.ts";

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
/** Every token on the wallet's list for a network. */
export function knownTokens(network: NetworkId): Token[] {
  return Object.keys(KNOWN[network]).map((d) => knownToken(network, d)!);
}

export function knownToken(network: NetworkId, denom: string): Token | null {
  const e = KNOWN[network][denom];
  return e ? { denom, symbol: e[0], name: e[1], decimals: e[2], known: true } : null;
}

/** Describe a denom: the wallet's list first, then the chain's metadata. A CW20 (or the
 *  bank form the CW20 adapter mints for one, when it has no metadata of its own) is
 *  described by the contract's `token_info`. */
export async function describeToken(lcd: Lcd, network: NetworkId, denom: string): Promise<Token> {
  const k = knownToken(network, denom);
  if (k) return k;
  // No metadata is shown as raw base units, which is never wrong. A node that can't be
  // reached is thrown, so a caller doesn't keep a description made without asking.
  const none = (e: unknown) => {
    if (e instanceof ChainError) return null;
    throw e;
  };
  let m: DenomMetadata | null;
  const cw20 = cw20Address(denom);
  if (cw20) m = await lcd.cw20Info(cw20).catch(none);
  else {
    m = await lcd.denomMetadata(denom).catch(none);
    // The token factory gives each new denom empty metadata; the adapter's stay empty
    // until someone copies the CW20's in. The CW20 says what the token is.
    const inner = adapterCw20(network, denom);
    if (inner && !m?.symbol.trim()) m = (await lcd.cw20Info(inner).catch(none)) ?? m;
  }
  const symbol = clean(m?.symbol ?? "", 12) || shortDenom(denom);
  return { denom, symbol, name: clean(m?.name ?? "", 40), decimals: m?.decimals ?? 0, known: false };
}

/** `factory/inj1abc…xyz/sub` → something that fits on one line. */
export function shortDenom(denom: string): string {
  const evm = evmAddress(denom);
  if (evm) return `${evm.slice(0, 6)}…${evm.slice(-4)}`;
  const cw20 = cw20Address(denom);
  if (cw20) return `${cw20.slice(0, 8)}…${cw20.slice(-4)}`;
  if (denom.length <= 20) return denom;
  return `${denom.slice(0, 12)}…${denom.slice(-6)}`;
}

/** The wallet's own key for an ERC20 that has no bank denom (an EVM-only token):
 *  `evm:` and the lowercase contract address. Never a bank denom, so it can't be sent
 *  with a bank message by mistake. */
export function evmDenom(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new RangeError(`not an address: ${address}`);
  return `evm:${address.toLowerCase()}`;
}

/** The contract address behind an `evm:` key, or null for a bank denom. */
export function evmAddress(denom: string): string | null {
  return /^evm:0x[0-9a-f]{40}$/.test(denom) ? denom.slice(4) : null;
}

/** A CosmWasm contract address on Injective: 20 bytes, or 32 for newer contracts. */
const CONTRACT = /^inj1(?:[02-9ac-hj-np-z]{38}|[02-9ac-hj-np-z]{58})$/;

/** The wallet's key for a CW20 token: `cw20:` and its contract address. Like `evm:`, never
 *  a bank denom, so it can't go into a bank message by mistake. */
export function cw20Denom(contract: string): string {
  if (!CONTRACT.test(contract)) throw new RangeError(`not a contract address: ${contract}`);
  return `cw20:${contract}`;
}

/** The contract behind a `cw20:` key, or null. */
export function cw20Address(denom: string): string | null {
  const a = denom.startsWith("cw20:") ? denom.slice(5) : "";
  return CONTRACT.test(a) ? a : null;
}

/** Whether `s` looks like a contract address (`inj1…`). The chain checks the rest. */
export function isContractAddress(s: string): boolean {
  return CONTRACT.test(s);
}

/** The CW20 behind the bank denom the network's CW20 adapter mints for it
 *  (`factory/{adapter}/{cw20}`), or null for any other denom. */
export function adapterCw20(network: NetworkId, denom: string): string | null {
  const prefix = `factory/${NETWORKS[network].cw20Adapter}/`;
  if (!denom.startsWith(prefix)) return null;
  const a = denom.slice(prefix.length);
  return CONTRACT.test(a) ? a : null;
}

/** The bank denom the network's CW20 adapter mints for a CW20. */
export function adapterDenom(network: NetworkId, cw20: string): string {
  if (!CONTRACT.test(cw20)) throw new RangeError(`not a contract address: ${cw20}`);
  return `factory/${NETWORKS[network].cw20Adapter}/${cw20}`;
}

/** A token's other form, if it has one: a CW20's adapter bank denom, or the CW20 behind
 *  one. The two are the same token, one for one, converted by the adapter. */
export function otherForm(network: NetworkId, denom: string): string | null {
  const cw20 = cw20Address(denom);
  if (cw20) return adapterDenom(network, cw20);
  const inner = adapterCw20(network, denom);
  return inner ? cw20Denom(inner) : null;
}

/** Strip what can disguise text (control, bidi and zero-width characters) and cap the length. */
export function cleanText(s: string, max: number): string {
  return clean(s, max);
}

function clean(s: string, max: number): string {
  const t = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
