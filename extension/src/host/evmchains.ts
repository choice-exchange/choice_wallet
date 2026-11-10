// The EVM chains beside Injective (chain/src/chains.ts): each one's endpoints (the user's,
// or the defaults), what the account holds there (its coin and USDC; the same 0x address on
// every chain), and their USD prices from DefiLlama on mainnet.
//
// Every chain is asked about the account's address, so each endpoint learns it, as any
// wallet's would. The prices list is the same for everyone: every chain's coin and USDC.

import { CHAINS, chainByKey, chainCoin, chainUsdc, ChainError, EvmRpc, fetchLlamaPrices, usdValue, word, type ChainInfo, type Fetch, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Balance, ChainHoldings } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";

/** A chain's endpoints as the user set them, per network and chain key. */
export type ChainEndpoints = Partial<Record<NetworkId, Record<string, string[]>>>;


export interface EvmChainsDeps {
  fetch: Fetch;
  local: Store;
  /** Whether to show USD values. */
  prices(): Promise<boolean>;
  now?: () => number;
}

/** Holdings on the chains Home isn't showing are read again after this long. */
const HELD_TTL_MS = 60_000;
/** Prices are asked again after a minute. */
const PRICE_TTL_MS = 60_000;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The EVM chains other than Injective's own EVM side on a network. */
export function evmChains(network: NetworkId): ChainInfo[] {
  return CHAINS[network].filter((c) => c.kind === "evm");
}

export function createEvmChains(d: EvmChainsDeps) {
  const now = d.now ?? Date.now;
  const clients = new Map<string, EvmRpc>();

  /** The user's endpoints for a chain, or its defaults. */
  async function endpoints(network: NetworkId, key: string): Promise<readonly string[]> {
    const { chain_endpoints } = (await d.local.get(["chain_endpoints"])) as { chain_endpoints?: ChainEndpoints };
    const own = chain_endpoints?.[network]?.[key];
    return own && own.length > 0 ? own : (chainByKey(network, key)?.rpc ?? []);
  }

  /** A client for an EVM chain, on the user's endpoints: each must serve that chain's ID. */
  async function rpc(network: NetworkId, key: string): Promise<EvmRpc> {
    const c = chainByKey(network, key);
    if (!c || c.kind !== "evm" || c.chainId === undefined) throw new RangeError(`not an EVM chain: ${key}`);
    const urls = await endpoints(network, key);
    const id = `${c.chainId} ${urls.join(" ")}`;
    let client = clients.get(id);
    if (!client) {
      client = new EvmRpc({ evmChainId: c.chainId }, urls, d.fetch);
      clients.set(id, client);
    }
    return client;
  }

  const priceCache = new Map<NetworkId, { at: number; prices: Promise<Map<string, string>> }>();
  /** USD prices of every EVM chain's coin and USDC, by wallet key (mainnet, USD values on).
   *  Never an error: a chain without a price shows amounts alone. */
  async function prices(network: NetworkId): Promise<Map<string, string>> {
    if (network !== "mainnet" || !(await d.prices())) return new Map();
    const hit = priceCache.get(network);
    if (hit && now() - hit.at < PRICE_TTL_MS) return hit.prices;
    const chains = evmChains(network).filter((c) => c.llama);
    const keys = new Map<string, string>();
    for (const c of chains) {
      keys.set(`${c.llama}:${c.usdc}`, chainUsdc(c.caip2));
      if (!c.gasIsUsdc) keys.set(`${c.llama}:${ZERO}`, chainCoin(c.caip2));
    }
    const p = fetchLlamaPrices(d.fetch, [...keys.keys()]).then(
      (got) => new Map([...got].map(([k, v]) => [keys.get(k)!, v])),
      () => {
        priceCache.delete(network);
        return new Map<string, string>();
      },
    );
    priceCache.set(network, { at: now(), prices: p });
    return p;
  }

  /** The account's coin and USDC on one chain, in one batch. On Arc the coin is the USDC
   *  itself (at 18 decimals), so only the token is listed. */
  async function holdings(network: NetworkId, account: AccountInfo, key: string): Promise<ChainHoldings | null> {
    const c = chainByKey(network, key);
    const address = c ? account.addresses[c.caip2] : undefined;
    if (!c || c.kind !== "evm" || !address) return null;
    const coin: Balance = { denom: chainCoin(c.caip2), symbol: c.native.symbol, name: c.native.symbol, decimals: c.native.decimals, known: true, chain: c.caip2, amount: "0" };
    const usdc: Balance = { denom: chainUsdc(c.caip2), symbol: "USDC", name: "USD Coin", decimals: 6, known: true, chain: c.caip2, amount: "0" };
    try {
      const client = await rpc(network, key);
      const [native, held] = await client.batch([
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_call", params: [{ to: c.usdc, data: `0x70a08231${word(address)}` }, "latest"] },
      ]);
      const amount = (v: unknown) => {
        if (v instanceof ChainError || typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new Error("no number");
        return BigInt(v).toString();
      };
      const list = c.gasIsUsdc ? [{ ...usdc, amount: amount(held) }] : [{ ...coin, amount: amount(native) }, { ...usdc, amount: amount(held) }];
      const p = await prices(network);
      return { chain: key, address, balances: list.map((b) => priced(b, p)) };
    } catch {
      return { chain: key, address, balances: c.gasIsUsdc ? [usdc] : [coin, usdc], down: true };
    }
  }

  const heldCache = new Map<string, { at: number; value: Promise<ChainHoldings | null> }>();
  /** Every EVM chain's holdings for the account. The chain Home shows (`fresh`) is read
   *  every time; the others at most once a minute, so a refresh doesn't ask sixteen chains. */
  async function all(network: NetworkId, account: AccountInfo, fresh?: string): Promise<ChainHoldings[]> {
    const out = await Promise.all(
      evmChains(network).map((c) => {
        const id = `${network} ${c.key} ${account.addresses[c.caip2] ?? ""}`;
        const hit = heldCache.get(id);
        if (hit && c.key !== fresh && now() - hit.at < HELD_TTL_MS) return hit.value;
        const value = holdings(network, account, c.key);
        heldCache.set(id, { at: now(), value });
        return value;
      }),
    );
    return out.filter((h): h is ChainHoldings => h !== null);
  }

  return { endpoints, rpc, prices, holdings, all };
}

function priced(b: Balance, prices: Map<string, string>): Balance {
  const p = prices.get(b.denom);
  return p ? { ...b, priceUsd: p, usd: usdValue(b.amount, b.decimals, p) } : b;
}
