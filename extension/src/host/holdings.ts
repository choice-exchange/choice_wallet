// What an account holds and did, chrome-free so it runs under test: the network clients (on
// the user's endpoints), token descriptions (cached on disk), Choice's prices, every
// balance (bank, CW20 and EVM-only tokens, sorted), and Activity's pages. ./send.ts builds
// sends on top of it.

import {
  adapterCw20,
  adapterDenom,
  ChainError,
  cw20Address,
  cw20Denom,
  describeToken,
  EvmIndex,
  EvmRpc,
  evmAddress,
  evmDenom,
  fetchPrices,
  isContractAddress,
  knownToken,
  Lcd,
  mergeActivity,
  NETWORKS,
  otherForm,
  priceAddress,
  summarize,
  Unreachable,
  usdValue,
  type EvmView,
  type Fetch,
  type IndexedTx,
  type NetworkId,
  type PriceList,
  type Token,
} from "@choice-wallet/chain";
import type { AccountInfo, ActivityPage, Balance, Result, TokenInfo } from "@choice-wallet/ui/protocol";

import { bridgeLabel } from "./bridge";
import { diskCache } from "./cache";
import type { Store } from "./service";
import { fail } from "./util";

export interface HoldingsDeps {
  fetch: Fetch;
  /** Holds the disk caches and `choice_seen`: when Choice last priced each token (public
   *  data, no balances). */
  local: Store;
  /** The endpoints the user chose for a network (or the defaults): LCD and EVM JSON-RPC. */
  endpoints(network: NetworkId): Promise<readonly string[]>;
  evmEndpoints(network: NetworkId): Promise<readonly string[]>;
  /** Blockscout instances for EVM history; empty when the user turned it off. */
  evmIndexEndpoints(network: NetworkId): Promise<readonly string[]>;
  /** Whether to show USD values (the user can turn them off). */
  prices(): Promise<boolean>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Prices are fetched again after a minute; one up to 15 minutes old still shows while
 *  that happens. */
const PRICE_TTL_MS = MINUTE;
const PAIRS_TTL_MS = HOUR;
/** A token Choice priced this recently still counts as priced for the token filter, so a
 *  Choice outage doesn't make tokens vanish. */
const SEEN_MS = 7 * 24 * 3_600_000;
/** Injective's SOL/USDC perpetual (mainnet), whose mark price prices SOL. */
const SOL_PERP = "0x291f404810c663e5fdd68b50454c1014760227842d420a2315f88311efe6ec41";
/** Tether's USDT: its mint on Solana, and its Peggy denom on Injective. */
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const INJECTIVE_USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";

/** Index entries per query per page (the node's `limit`), and Blockscout transfers per page. */
const ACTIVITY_PAGE = 50;
/** Transactions found through Blockscout, looked up on the LCD at once. */
const LOOKUP_PARALLEL = 6;
/** Blocks (about an hour) below the newest known before a transfer the node's index
 *  doesn't hold is taken as out of its window. */
const UNINDEXED_BELOW = 5_000n;

/** CW20 balance queries in flight at once (one smart query per token). */
const CW20_PARALLEL = 6;
/** At most this many CW20s are asked about because their bank form has an ERC20 pair (2 of
 *  mainnet's 1,112 pairs on 2026-11-09), so a chain with many can't flood the endpoints.
 *  CW20s held in bank form or added by hand are always asked. */
const CW20_FROM_PAIRS = 50;

export function createHoldings(d: HoldingsDeps) {
  const clients = new Map<string, Lcd>();
  const tokenCache = new Map<string, Promise<Token>>();
  // On disk (./cache.ts): token descriptions change rarely (a token's admin can rename it),
  // ERC20 metadata almost never, pairs when governance adds one.
  const tokensDisk = diskCache<Token>(d.local, "cache_tokens", { fresh: DAY, stale: 30 * DAY, max: 3000 });
  const erc20Disk = diskCache<Token | null>(d.local, "cache_erc20", { fresh: 7 * DAY, stale: 90 * DAY, max: 1000 });
  const pairsDisk = diskCache<[string, string][]>(d.local, "cache_pairs", { fresh: PAIRS_TTL_MS, stale: 7 * DAY, max: 6 });
  // EVM transactions Blockscout knows of that this node's index doesn't hold (it keeps its
  // own window of history): not asked again for a while.
  const unindexed = diskCache<true>(d.local, "cache_unindexed", { fresh: 6 * HOUR, stale: 6 * HOUR, max: 2000 });
  const pricesDisk = diskCache<{ observedAt: string; prices: [string, string][] }>(d.local, "cache_prices", { fresh: PRICE_TTL_MS, stale: 15 * MINUTE, fallback: 15 * MINUTE, max: 1 });

  async function lcd(network: NetworkId): Promise<Lcd> {
    const urls = await d.endpoints(network);
    const key = `${network} ${urls.join(" ")}`;
    let c = clients.get(key);
    if (!c) {
      c = new Lcd(NETWORKS[network], urls, d.fetch);
      clients.set(key, c);
    }
    return c;
  }

  /** The last price list read, and when Choice was last seen pricing each token written
   *  for it, so neither is redone while the list is the same. */
  let priceMemo: { from: unknown; list: PriceList } | null = null;
  let seenWritten: PriceList | null = null;
  /** Choice's price list: from disk while it is fresh enough (./cache.ts), or asked. */
  async function priceList(): Promise<PriceList | null> {
    try {
      const raw = await pricesDisk.get("mainnet", async () => {
        const l = await fetchPrices(d.fetch);
        return { observedAt: l.observedAt, prices: [...l.prices] };
      });
      if (priceMemo?.from !== raw) priceMemo = { from: raw, list: { observedAt: raw.observedAt, prices: new Map(raw.prices) } };
      return priceMemo.list;
    } catch {
      return null;
    }
  }
  /** Per LCD client, so per network and endpoint set: new endpoints are asked afresh. */
  const pairCache = new Map<Lcd, { at: number; pairs: Promise<Map<string, string>> }>();

  /** The erc20 module's token pairs (bank denom → ERC20 address), cached an hour. */
  function pairsEntry(client: Lcd): Promise<Map<string, string>> {
    const now = Date.now();
    let pc = pairCache.get(client);
    if (!pc || now - pc.at > PAIRS_TTL_MS) {
      const key = `${client.network.chainId} ${client.pool.urls.join(" ")}`;
      const entry = { at: now, pairs: pairsDisk.get(key, async () => [...(await client.tokenPairs())]).then((list) => new Map(list)) };
      pairCache.set(client, entry);
      entry.pairs.catch(() => {
        if (pairCache.get(client) === entry) pairCache.delete(client);
      });
      pc = entry;
    }
    return pc.pairs;
  }
  /** The pairs, empty when the node can't say. */
  function pairsFor(_network: NetworkId, client: Lcd): Promise<Map<string, string>> {
    return pairsEntry(client).catch(() => new Map<string, string>());
  }

  type ChoiceView = {
    prices: Map<string, string>;
    onChoice: Set<string>;
    /** Every address Choice priced within `SEEN_MS`. */
    seen: Set<string>;
    /** Choice's price for an address, now. */
    priceOf(address: string): string | undefined;
  };

  /** Choice's view of these denoms (mainnet only): the price to show, where it has one
   *  now, and whether it priced the token within `SEEN_MS` (for the token filter). Never
   *  an error: with no prices the wallet shows amounts alone. With USD values off, Choice
   *  isn't asked, and only what it said before counts; the same with `ask` false (the
   *  background watcher, which never asks Choice). */
  async function choiceFor(network: NetworkId, client: Lcd, denoms: Iterable<string>, askChoice = true): Promise<ChoiceView> {
    const out: ChoiceView = { prices: new Map(), onChoice: new Set(), seen: new Set(), priceOf: () => undefined };
    if (network !== "mainnet") return out;
    const now = Date.now();
    const ask = askChoice && (await d.prices());
    // When Choice last priced each address, kept a week.
    const stored = ((await d.local.get(["choice_seen"]))["choice_seen"] ?? {}) as Record<string, number>;
    const seen: Record<string, number> = {};
    for (const [a, t] of Object.entries(stored)) if (typeof t === "number" && now - t < SEEN_MS) seen[a] = t;
    if (!ask && Object.keys(seen).length === 0) return out;

    const [list, pairs] = await Promise.all([ask ? priceList() : null, pairsFor(network, client)]);
    if (list) {
      for (const a of list.prices.keys()) seen[a] = now;
      if (seenWritten !== list) {
        seenWritten = list;
        await d.local.set({ choice_seen: seen });
      }
    }
    const bankForm = (dn: string) => {
      const c = cw20Address(dn);
      return c ? adapterDenom(network, c) : null;
    };
    for (const dn of denoms) {
      const a = priceAddress(dn, pairs, bankForm);
      if (a === undefined) continue;
      const p = list?.prices.get(a);
      if (p) out.prices.set(dn, p);
      if (p || seen[a] !== undefined) out.onChoice.add(dn);
    }
    out.seen = new Set(Object.keys(seen));
    out.priceOf = (a) => list?.prices.get(a.toLowerCase());
    return out;
  }

  /** USD prices for Solana's tokens, by their denoms there (mainnet, with USD values on).
   *  USDC and USDT are the same tokens as Injective's, at Choice's prices for those. SOL is
   *  the mark price of Injective's SOL/USDC perpetual (Chainlink's oracle, checked
   *  2026-11-10: $86.67 against the perp's $86.64), read from the user's endpoint, since
   *  Choice prices only what has an address on Injective EVM. Never an error. */
  async function solanaPrices(network: NetworkId): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (network !== "mainnet" || !(await d.prices())) return out;
    const client = await lcd(network);
    const usdc = `erc20:${NETWORKS[network].cctp.usdc}`;
    const twins: Record<string, string> = { [`spl:${NETWORKS[network].solana.usdcMint}`]: usdc, [`spl:${SOLANA_USDT}`]: INJECTIVE_USDT };
    const [choice, perp] = await Promise.all([
      choiceFor(network, client, Object.values(twins)),
      client.get(`/injective/exchange/v1beta1/derivative/markets/${SOL_PERP}`).catch(() => null),
    ]);
    for (const [denom, twin] of Object.entries(twins)) {
      const p = choice.prices.get(twin);
      if (p) out.set(denom, p);
    }
    const m = (perp as { market?: { market?: { status?: string; quote_denom?: string }; mark_price?: string } } | null)?.market;
    const mark = Number(m?.mark_price) / 1e6; // USDC base units per SOL
    if (m?.market?.status === "Active" && m.market.quote_denom?.toLowerCase() === usdc.toLowerCase() && Number.isFinite(mark) && mark > 0) out.set("sol", mark.toFixed(6));
    return out;
  }

  const evmClients = new Map<string, EvmRpc>();
  async function evm(network: NetworkId): Promise<EvmRpc> {
    const urls = await d.evmEndpoints(network);
    const key = `${network} ${urls.join(" ")}`;
    let c = evmClients.get(key);
    if (!c) {
      c = new EvmRpc(NETWORKS[network], urls, d.fetch);
      evmClients.set(key, c);
    }
    return c;
  }

  /** A client for a chain USDC comes from, on the bridge registry's public endpoints. */
  function sourceRpc(s: { chainId: number; rpcUrls: readonly string[] }): EvmRpc {
    const key = `${s.chainId} ${s.rpcUrls.join(" ")}`;
    let c = evmClients.get(key);
    if (!c) {
      c = new EvmRpc({ evmChainId: s.chainId }, s.rpcUrls, d.fetch);
      evmClients.set(key, c);
    }
    return c;
  }

  const indexClients = new Map<string, EvmIndex>();
  /** Blockscout for this network, or null when the user turned it off. */
  async function evmIndex(network: NetworkId): Promise<EvmIndex | null> {
    const urls = await d.evmIndexEndpoints(network);
    if (urls.length === 0) return null;
    const key = `${network} ${urls.join(" ")}`;
    let c = indexClients.get(key);
    if (!c) {
      c = new EvmIndex(urls, d.fetch);
      indexClients.set(key, c);
    }
    return c;
  }

  const erc20Cache = new Map<string, Promise<Token | null>>();
  /** An EVM-only token's description, from its contract (cached; null if not an ERC20). */
  function erc20Token(network: NetworkId, rpc: EvmRpc, address: string): Promise<Token | null> {
    const denom = evmDenom(address);
    const key = `${network} ${denom}`;
    let t = erc20Cache.get(key);
    if (!t) {
      t = erc20Disk.get(key, () => rpc.erc20Metadata(address).then((m) => (m ? { denom, ...m, known: false } : null)));
      erc20Cache.set(key, t);
      t.catch(() => erc20Cache.delete(key));
    }
    return t;
  }

  /** Tokens the user added by contract: ERC20s (0x…) and CW20s (inj1…). */
  async function customTokens(network: NetworkId): Promise<string[]> {
    const { custom_tokens } = (await d.local.get(["custom_tokens"])) as { custom_tokens?: Partial<Record<NetworkId, unknown>> };
    const list = custom_tokens?.[network];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string" && (/^0x[0-9a-f]{40}$/.test(a) || isContractAddress(a))) : [];
  }

  /** CW20 balances. A CW20 lives in its contract, which no bank query sees, so the wallet
   *  asks each candidate: the CW20 behind every adapter bank denom that has an ERC20 pair
   *  (the CW20s that matter on Injective today), behind every adapter denom this account
   *  holds, and the user's own additions (shown even at zero). Prices come later. */
  async function cw20Holdings(network: NetworkId, client: Lcd, account: AccountInfo, bank: readonly Balance[]): Promise<Balance[]> {
    const custom = (await customTokens(network)).filter(isContractAddress);
    const candidates = new Set(custom);
    const paired = [...(await pairsFor(network, client)).keys()].map((dn) => adapterCw20(network, dn)).filter((c): c is string => c !== null);
    for (const c of paired.slice(0, CW20_FROM_PAIRS)) candidates.add(c);
    for (const b of bank) {
      const c = adapterCw20(network, b.denom);
      if (c) candidates.add(c);
    }
    const holder = cosmosAddress(network, account);
    const list = [...candidates];
    const amounts: (bigint | null)[] = new Array(list.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CW20_PARALLEL, list.length) }, async () => {
        while (next < list.length) {
          const i = next++;
          amounts[i] = await client.cw20Balance(list[i]!, holder);
        }
      }),
    );
    const out: Balance[] = [];
    await Promise.all(
      list.map(async (c, i) => {
        const amount = amounts[i];
        if (amount === null || amount === undefined || (amount === 0n && !custom.includes(c))) return;
        out.push({ ...(await token(network, client, cw20Denom(c))), amount: amount.toString() });
      }),
    );
    return out;
  }

  /** ERC20s with no bank denom that this account holds (or added by hand). Candidates are
   *  what Choice priced this week and the user's own additions; anything a bank denom
   *  already covers (an `erc20:` denom or a token pair) is left to the bank list, so no
   *  token shows twice. */
  async function evmOnly(network: NetworkId, client: Lcd, account: AccountInfo, bank: readonly Balance[], choice: ChoiceView): Promise<Balance[]> {
    const custom = (await customTokens(network)).filter((a) => a.startsWith("0x"));
    const candidates = new Set([...choice.seen, ...custom].map((a) => a.toLowerCase()));
    candidates.delete("0x0000000000000000000000000000000000000000");
    if (candidates.size === 0) return [];
    const covered = new Set([...(await pairsFor(network, client)).values()].map((a) => a.toLowerCase()));
    for (const b of bank) if (b.denom.startsWith("erc20:")) covered.add(b.denom.slice(6).toLowerCase());
    const tokens = [...candidates].filter((a) => !covered.has(a));
    if (tokens.length === 0) return [];
    const rpc = await evm(network);
    const holder = account.addresses[NETWORKS[network].evm];
    if (!holder) return [];
    const amounts = await rpc.erc20Balances(tokens, holder);
    const out: Balance[] = [];
    await Promise.all(
      tokens.map(async (a, i) => {
        const amount = amounts[i];
        const mine = custom.includes(a);
        if (amount === null || amount === undefined || (amount === 0n && !mine)) return;
        const t = await erc20Token(network, rpc, a);
        if (!t) return;
        const p = choice.priceOf(a);
        const base: Balance = { ...t, amount: amount.toString(), ...(choice.seen.has(a) || p ? { onChoice: true } : {}) };
        out.push(p ? { ...base, priceUsd: p, usd: usdValue(base.amount, base.decimals, p) } : base);
      }),
    );
    return out;
  }

  /** What a contract address is, for "add a token": the bank denom that already covers it,
   *  or the EVM-only token it is. */
  async function inspectToken(network: NetworkId, address: unknown): Promise<Result<{ denom: string; symbol: string }>> {
    const entered = typeof address === "string" ? address.trim() : "";
    if (isContractAddress(entered.toLowerCase())) {
      // A CW20, by its contract on the Cosmos side.
      const c = entered.toLowerCase();
      const client = await lcd(network);
      try {
        const info = await client.cw20Info(c);
        if (!info) return fail("not_a_token", "That address isn't a CW20 token.");
        return { ok: true, result: { denom: cw20Denom(c), symbol: (await token(network, client, cw20Denom(c))).symbol } };
      } catch (e) {
        return chainFailure(e);
      }
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(entered)) return fail("invalid_address", "Enter a token contract address (0x… or inj1…).");
    const a = entered.toLowerCase();
    if (a === "0x0000000000000000000000000000000000000000") return fail("invalid_address", "That's native INJ, already in your list.");
    const client = await lcd(network);
    try {
      for (const [denom, pair] of await pairsFor(network, client)) {
        if (pair.toLowerCase() === a) return { ok: true, result: { denom, symbol: (await token(network, client, denom)).symbol } };
      }
      const t = await erc20Token(network, await evm(network), a);
      if (!t) return fail("not_a_token", "That address isn't an ERC20 token.");
      return { ok: true, result: { denom: t.denom, symbol: t.symbol } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  function token(network: NetworkId, client: Lcd, denom: string): Promise<Token> {
    const key = `${network} ${denom}`;
    let t = tokenCache.get(key);
    if (!t) {
      const known = knownToken(network, denom);
      t = known ? Promise.resolve(known) : tokensDisk.get(key, () => describeToken(client, network, denom));
      tokenCache.set(key, t);
      t.catch(() => tokenCache.delete(key));
    }
    return t;
  }

  /** How to show each denom, with Choice's price where it has one. An `evm:` key is read
   *  from its contract (and left out if it isn't an ERC20). */
  async function tokensFor(network: NetworkId, denoms: Iterable<string>): Promise<Record<string, TokenInfo>> {
    const client = await lcd(network);
    const list = [...new Set(denoms)];
    const px = (await choiceFor(network, client, list)).prices;
    const described = await Promise.all(
      list.map(async (dn) => {
        const a = evmAddress(dn);
        const t = a ? await erc20Token(network, await evm(network), a) : await token(network, client, dn);
        const p = px.get(dn);
        return t ? ([dn, p ? { ...t, priceUsd: p } : t] as const) : null;
      }),
    );
    return Object.fromEntries(described.filter((x) => x !== null));
  }

  /** How to show each denom in a list of what happened (Activity's rows, the watcher's
   *  notices): its token, and whether Choice priced it this week (for the token filter). An
   *  EVM-only token is read from its contract; one that can't be is left out. */
  async function labels(network: NetworkId, denoms: Iterable<string>, askChoice = true): Promise<Record<string, Token & { onChoice?: true }>> {
    const client = await lcd(network);
    const list = [...new Set(denoms)];
    const choice = await choiceFor(network, client, list, askChoice);
    const described = await Promise.all(
      list.map(async (dn) => {
        const a = evmAddress(dn);
        const t = a ? await erc20Token(network, await evm(network), a).catch(() => null) : await token(network, client, dn);
        return t ? ([dn, { ...t, ...(choice.onChoice.has(dn) ? { onChoice: true as const } : {}) }] as const) : null;
      }),
    );
    return Object.fromEntries(described.filter((x) => x !== null));
  }

  /** Turn chain and network failures into one short line for the UI. */
  function chainFailure(e: unknown): Result<never> {
    if (e instanceof Unreachable) return fail("unreachable", "Couldn't reach the network. Check your connection or endpoints.");
    if (e instanceof ChainError) {
      if (/insufficient (funds|fee)/i.test(e.message)) return fail("insufficient", "Not enough funds for this send and its fee.");
      return fail("chain", e.message.length > 200 ? `${e.message.slice(0, 199)}…` : e.message);
    }
    throw e;
  }

  /** Every balance, sorted: INJ, the wallet's known tokens, then by USD value, then the rest
   *  by symbol. INJ is there even at zero (the bank lists only what's held), as SOL is on
   *  Solana, so an empty account is priced like any other. The UI filters. */
  async function balances(network: NetworkId, account: AccountInfo, opts: { askChoice?: boolean } = {}): Promise<Result<{ network: NetworkId; balances: Balance[]; evmDown?: true }>> {
    const client = await lcd(network);
    const ask = opts.askChoice ?? true;
    try {
      // Prices and pairs don't depend on the balances: they are asked beside them.
      const prices = choiceFor(network, client, [], ask);
      const [coins] = await Promise.all([client.balances(cosmosAddress(network, account)), pairsFor(network, client)]);
      const fee = NETWORKS[network].feeDenom;
      const held = coins.some((c) => c.denom === fee) ? coins : [{ denom: fee, amount: "0" }, ...coins];
      const bank: Balance[] = await Promise.all(held.map(async (c) => ({ ...(await token(network, client, c.denom)), amount: c.amount })));
      // EVM-only tokens, beside the CW20s: a failure here leaves the rest standing.
      const evmSide = (async () => {
        try {
          return { list: await evmOnly(network, client, account, bank, await prices), down: false };
        } catch (e) {
          if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
          return { list: [] as Balance[], down: true };
        }
      })();
      evmSide.catch(() => {}); // awaited below; this only keeps an early failure from going unhandled
      const list = [...bank, ...(await cw20Holdings(network, client, account, bank))];
      const choice = await choiceFor(network, client, list.map((b) => b.denom), ask);
      const out: Balance[] = list.map((b) => {
        const p = choice.prices.get(b.denom);
        const seen = choice.onChoice.has(b.denom) ? { onChoice: true } : {};
        const other = otherForm(network, b.denom);
        const more = { ...seen, ...(other ? { convertsTo: other } : {}) };
        return p ? { ...b, ...more, priceUsd: p, usd: usdValue(b.amount, b.decimals, p) } : { ...b, ...more };
      });
      const evmOut = await evmSide;
      out.push(...evmOut.list);
      const evmDown = evmOut.down;
      out.sort((a, b) => rank(network, a) - rank(network, b) || (b.usd ?? -1) - (a.usd ?? -1) || a.symbol.localeCompare(b.symbol));
      return { ok: true, result: { network, balances: out, ...(evmDown ? { evmDown: true as const } : {}) } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** A page of activity, merged from what the account signed, spent and received in the
   *  tx index (a reverted EVM transaction has no signer event, only its fee spent), and the
   *  ERC20 transfers Blockscout knows of. Each of those is looked up on the user's LCD and
   *  read like the rest; one that changed nothing here (a zero-value transfer, as address
   *  poisoning sends) is left out. */
  async function activity(network: NetworkId, account: AccountInfo, page: unknown): Promise<Result<Omit<ActivityPage, "filter">>> {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000) return fail("bad_request", "Not a page number.");
    const client = await lcd(network);
    const me = cosmosAddress(network, account);
    const me0x = account.addresses[NETWORKS[network].evm];
    try {
      const index = me0x ? await evmIndex(network) : null;
      let indexDown = false;
      const [pages, found, pairs] = await Promise.all([
        Promise.all([`message.sender='${me}'`, `coin_spent.spender='${me}'`, `coin_received.receiver='${me}'`].map((q) => client.searchTxs(q, page, ACTIVITY_PAGE))),
        index && me0x
          ? index.transfers(me0x, page, ACTIVITY_PAGE).catch((e: unknown) => {
              if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
              indexDown = true;
              return null;
            })
          : null,
        pairsEntry(client).then(
          (m) => new Map([...m].map(([denom, erc20]) => [erc20.toLowerCase(), denom])),
          () => null,
        ),
      ]);
      const view: EvmView | undefined = me0x ? { address: me0x, pairs } : undefined;
      const lists = pages.map((p) => p.txs.map((tx) => summarize(tx, me, view)));
      // Each list goes on past its last item unless it's done: below the highest of those
      // last heights, a next page could still hold rows newer than what's shown.
      const streams = pages.map((p) => ({ heights: p.txs.map((t) => t.height), done: p.done }));
      if (found) {
        const have = new Map(lists.flat().flatMap((a) => (a.evmHash ? [[a.evmHash, BigInt(a.height)] as const] : [])));
        const missing = found.txs.filter((t) => !have.has(t.hash));
        const got: (IndexedTx | null)[] = new Array(missing.length).fill(null);
        // A miss counts as the node's history running out only well below the newest block
        // either source has: a transfer Blockscout saw seconds ago may not be indexed yet.
        const newest = [...pages.flatMap((p) => p.txs.map((t) => t.height)), ...found.txs.map((t) => t.height)].reduce((a, b) => (b > a ? b : a), 0n);
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(LOOKUP_PARALLEL, missing.length) }, async () => {
            while (next < missing.length) {
              const i = next++;
              const key = `${client.pool.urls.join(" ")} ${missing[i]!.hash}`;
              const known = await unindexed.peek(key);
              if (known && known.age < 6 * HOUR) continue;
              try {
                got[i] = await client.txByEvmHash(missing[i]!.hash);
                if (got[i] === null && newest - missing[i]!.height > UNINDEXED_BELOW) await unindexed.put(key, true);
              } catch (e) {
                if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
              }
            }
          }),
        );
        const confirmed = got.filter((tx): tx is IndexedTx => tx !== null);
        lists.push(confirmed.map((tx) => summarize(tx, me, view)).filter((a) => a.signed || a.changes.length > 0));
        // Only heights the LCD confirmed count toward the cutoff: hashes Blockscout made up
        // can't hold back rows the node did confirm.
        const already = found.txs.flatMap((t) => (have.has(t.hash) ? [have.get(t.hash)!] : []));
        streams.push({ heights: [...already, ...confirmed.map((tx) => tx.height)], done: found.done });
      }
      const open = streams.filter((st) => !st.done && st.heights.length > 0);
      const lows = open.map((st) => st.heights.reduce((m, h) => (h < m ? h : m)));
      const cutoff = lows.length > 0 ? lows.reduce((a, b) => (a > b ? a : b)).toString() : null;
      const items = mergeActivity(lists).map((a) => (a.bridge ? { ...a, bridge: { ...a.bridge, ...bridgeLabel(network, a.bridge.domain, a.bridge.mintRecipient) } } : a));
      const denoms = new Set(items.flatMap((a) => [...a.changes, ...a.fee].map((c) => c.denom).concat(a.approval ? [a.approval.denom] : [])));
      const tokens = await labels(network, denoms);
      return {
        ok: true,
        result: { network, items, tokens, more: streams.some((st) => !st.done), cutoff, ...(indexDown ? { evmIndexDown: true as const } : {}) },
      };
    } catch (e) {
      return chainFailure(e);
    }
  }

  return { lcd, evm, sourceRpc, evmIndex, erc20Token, token, tokensFor, labels, pairsEntry, pairsFor, choiceFor, solanaPrices, inspectToken, chainFailure, balances, activity };
}

/** The account's address on the network's Cosmos side. */
export function cosmosAddress(network: NetworkId, account: AccountInfo): string {
  const a = account.addresses[NETWORKS[network].cosmos];
  if (!a) throw new Error(`no ${network} address for this account`);
  return a;
}

function rank(network: NetworkId, t: Token): number {
  return t.denom === NETWORKS[network].feeDenom ? 0 : t.known ? 1 : 2;
}
