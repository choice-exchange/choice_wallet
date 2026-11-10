// The EVM chains beside Injective (chain/src/chains.ts): each one's endpoints (the user's,
// or the defaults), what the account holds there (its coin and USDC; the same 0x address on
// every chain), and their USD prices from DefiLlama on mainnet.
//
// Every chain is asked about the account's address, so each endpoint learns it, as any
// wallet's would. The prices list is the same for everyone: every chain's coin and USDC.

import {
  CHAINS,
  chainByKey,
  chainCoin,
  chainUsdc,
  ChainError,
  Down,
  erc20Meta,
  EvmIndex,
  EvmRpc,
  fetchLlamaPrices,
  NETWORKS,
  readEvmTxs,
  summarizeEvmTx,
  Unreachable,
  usdValue,
  word,
  type ChainInfo,
  type Fetch,
  type NetworkId,
} from "@choice-wallet/chain";
import type { AccountInfo, ActivityItem, Balance, ChainHoldings, Result, TokenInfo } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";
import { fail } from "./util";

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
/** Rows per Activity page. */
const PAGE = 25;
/** Transactions the wallet sent on each chain, kept for its history there. */
const MAX_SENT = 100;

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

  /** The user's history indexes for a chain (empty: off), or its defaults. */
  async function historyEndpoints(network: NetworkId, key: string): Promise<readonly string[]> {
    const { chain_history } = (await d.local.get(["chain_history"])) as { chain_history?: ChainEndpoints };
    return chain_history?.[network]?.[key] ?? chainByKey(network, key)?.history ?? [];
  }

  /** What the wallet sent on a chain, newest first, for its history there. */
  type Sent = Partial<Record<string, string[]>>;
  const sentKey = (network: NetworkId, key: string, address: string) => `${network} ${key} ${address.toLowerCase()}`;
  async function recordSent(network: NetworkId, key: string, address: string, hash: string): Promise<void> {
    const { chain_sent } = (await d.local.get(["chain_sent"])) as { chain_sent?: Sent };
    const id = sentKey(network, key, address);
    const list = [hash.toLowerCase(), ...(chain_sent?.[id] ?? []).filter((h) => h !== hash.toLowerCase())].slice(0, MAX_SENT);
    await d.local.set({ chain_sent: { ...(chain_sent ?? {}), [id]: list } });
  }

  const metaCache = new Map<string, Promise<{ symbol: string; decimals: number } | null>>();
  /** A page of the account's history on an EVM chain: what its index finds (where it has
   *  one) and what the wallet sent there, each read from the chain itself. */
  async function activity(
    network: NetworkId,
    account: AccountInfo,
    key: string,
    page: number,
  ): Promise<Result<{ items: ActivityItem[]; tokens: Record<string, TokenInfo>; next: number | null; indexed: boolean; indexDown?: true }>> {
    const c = chainByKey(network, key);
    const me = c ? account.addresses[c.caip2] : undefined;
    if (!c || c.kind !== "evm" || !me) return fail("bad_request", "Not a chain this account is on.");
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) return fail("bad_request", "No such page.");
    const urls = await historyEndpoints(network, key);
    let found: string[] = [];
    let done = true;
    let indexDown = false;
    if (urls.length > 0) {
      try {
        const h = await new EvmIndex(urls, d.fetch).history(me, page, PAGE);
        found = h.hashes;
        done = h.done;
      } catch (e) {
        if (!(e instanceof Down || e instanceof ChainError || e instanceof Unreachable || e instanceof RangeError)) throw e;
        indexDown = true;
      }
    }
    const { chain_sent } = (await d.local.get(["chain_sent"])) as { chain_sent?: Sent };
    const own = page === 1 ? (chain_sent?.[sentKey(network, key, me)] ?? []) : [];
    const hashes = [...new Set([...own, ...found])];
    let client: EvmRpc;
    try {
      client = await rpc(network, key);
    } catch {
      return fail("unreachable", `Couldn't reach ${c.name}.`);
    }
    let records;
    try {
      records = await readEvmTxs(client, hashes);
    } catch {
      return fail("unreachable", `Couldn't reach ${c.name}. Try again.`);
    }
    const usdc = c.usdc.toLowerCase();
    const keys = {
      coin: chainCoin(c.caip2),
      token: (a: string) => (a.toLowerCase() === usdc ? chainUsdc(c.caip2) : `token:${c.caip2}:${a.toLowerCase()}`),
      tokenMessenger: NETWORKS[network].cctp.tokenMessenger,
      messageTransmitter: NETWORKS[network].cctp.messageTransmitter,
    };
    const all = records.map((r) => summarizeEvmTx(r, me, c.caip2, keys)).sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0));
    const tokens: Record<string, TokenInfo> = {
      [keys.coin]: { denom: keys.coin, symbol: c.native.symbol, name: c.native.symbol, decimals: c.native.decimals, known: true, chain: c.caip2 },
      [chainUsdc(c.caip2)]: { denom: chainUsdc(c.caip2), symbol: "USDC", name: "USD Coin", decimals: 6, known: true, chain: c.caip2 },
    };
    const others = [...new Set(all.flatMap((a) => a.changes.map((x) => x.denom)).filter((x) => x.startsWith("token:")))];
    await Promise.all(
      others.map(async (denom) => {
        const address = denom.split(":").pop()!;
        const id = `${c.caip2} ${address}`;
        let m = metaCache.get(id);
        if (!m) {
          m = erc20Meta(client, address).catch(() => null);
          metaCache.set(id, m);
        }
        const meta = await m;
        tokens[denom] = { denom, symbol: meta?.symbol ?? address.slice(0, 8), name: meta?.symbol ?? address, decimals: meta?.decimals ?? 0, known: false, chain: c.caip2 };
      }),
    );
    // Tokens nobody asked for, sent by someone else and only of unlisted kinds, are spam
    // more often than not: left out.
    const items = all.filter((a) => a.signed || a.changes.length === 0 || a.changes.some((x) => tokens[x.denom]?.known));
    return { ok: true, result: { items: items as ActivityItem[], tokens, next: done ? null : page + 1, indexed: urls.length > 0, ...(indexDown ? { indexDown: true as const } : {}) } };
  }

  return { endpoints, rpc, prices, holdings, all, historyEndpoints, recordSent, activity };
}

function priced(b: Balance, prices: Map<string, string>): Balance {
  const p = prices.get(b.denom);
  return p ? { ...b, priceUsd: p, usd: usdValue(b.amount, b.decimals, p) } : b;
}
