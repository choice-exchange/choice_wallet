// Balances and sends, chrome-free so they run under test. A send is two requests:
//
// 1. prepare: read the account, balances and gas price; build the transaction, simulate it
//    for gas, build it again with the real fee; decode it and grade it with the risk rules
//    (the vault, like any dapp request). The review shows that decode. The prepared
//    request waits in session storage under its digest.
// 2. confirm: sign exactly the request whose digest the review showed, then broadcast.
//    The pending request is removed first, so a double click can't send twice.

import {
  adapterCw20,
  adapterDenom,
  ChainError,
  cosmosTxHash,
  cw20Address,
  cw20Denom,
  describeToken,
  EvmIndex,
  EvmRpc,
  evmAddress,
  evmDenom,
  explorerTxUrl,
  isContractAddress,
  isObject,
  MIN_GAS_PRICE,
  otherForm,
  word,
  Lcd,
  fetchPrices,
  mergeActivity,
  NETWORKS,
  summarize,
  priceAddress,
  shortDenom,
  Unreachable,
  usdValue,
  type Coin,
  type EvmView,
  type Fetch,
  type IndexedTx,
  type NetworkId,
  type PriceList,
  type Token,
} from "@choice-wallet/chain";
import type { AccountInfo, ActivityPage, Balance, CosmosDisplay, Result, Risk, SendReview, Sent, TokenInfo, TxState } from "@choice-wallet/ui/protocol";

import { memoFrom, type RiskFacts } from "./contacts";
import type { Store } from "./service";

export interface SendDeps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  fetch: Fetch;
  /** Holds `choice_seen`: when Choice last priced each token (public data, no balances). */
  local: Store;
  session: Store;
  /** The endpoints the user chose for a network (or the defaults): LCD and EVM JSON-RPC. */
  endpoints(network: NetworkId): Promise<readonly string[]>;
  evmEndpoints(network: NetworkId): Promise<readonly string[]>;
  /** Blockscout instances for EVM history; empty when the user turned it off. */
  evmIndexEndpoints(network: NetworkId): Promise<readonly string[]>;
  /** Whether to show USD values (the user can turn them off). */
  prices(): Promise<boolean>;
  /** The address book and the user's accounts for the risk rules, and whether `recipient`
   *  takes deposits with a memo (./contacts.ts). */
  riskFacts(network: NetworkId, recipient: string | null): Promise<RiskFacts>;
}

const PRICE_TTL_MS = 60_000;
const PAIRS_TTL_MS = 3_600_000;
/** A token Choice priced this recently still counts as priced for the token filter, so a
 *  Choice outage doesn't make tokens vanish. */
const SEEN_MS = 7 * 24 * 3_600_000;

/** What `confirm` needs, kept in session storage between the two steps. */
interface Pending {
  network: NetworkId;
  digest: string;
  request: unknown;
  account: AccountInfo["account"];
  /** The wallet that signs for it. */
  wallet: string;
  confirm: string | null;
  blocked: boolean;
  /** An EVM transaction (broadcast with eth_sendRawTransaction), not a Cosmos one. */
  evm?: boolean;
}

/** Index entries per query per page (the node's `limit`), and Blockscout transfers per page. */
const ACTIVITY_PAGE = 50;
/** Transactions found through Blockscout, looked up on the LCD at once. */
const LOOKUP_PARALLEL = 6;

/** Gas assumed while estimating an EVM transfer, and the most an estimate is believed
 *  (an ERC20 transfer uses about 35k to 60k). */
const EVM_SIMULATION_GAS = 100_000n;
const EVM_MAX_GAS = 1_000_000n;

/** CW20 balance queries in flight at once (one smart query per token). */
const CW20_PARALLEL = 6;
/** At most this many CW20s are asked about because their bank form has an ERC20 pair (2 of
 *  mainnet's 1,112 pairs on 2026-11-09), so a chain with many can't flood the endpoints.
 *  CW20s held in bank form or added by hand are always asked. */
const CW20_FROM_PAIRS = 50;

/** Gas assumed for the simulation's own fee. */
const SIMULATION_GAS = 200_000n;
const MIN_GAS = 50_000n;
/** Above this a simulation result is not believed (a bank send uses about 83k). */
const MAX_GAS = 3_000_000n;

const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

export function createSender(d: SendDeps) {
  const clients = new Map<string, Lcd>();
  const tokenCache = new Map<string, Promise<Token>>();

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

  let priceCache: { at: number; list: Promise<PriceList> } | null = null;
  /** Per LCD client, so per network and endpoint set: new endpoints are asked afresh. */
  const pairCache = new Map<Lcd, { at: number; pairs: Promise<Map<string, string>> }>();

  /** The erc20 module's token pairs (bank denom → ERC20 address), cached an hour. */
  function pairsEntry(client: Lcd): Promise<Map<string, string>> {
    const now = Date.now();
    let pc = pairCache.get(client);
    if (!pc || now - pc.at > PAIRS_TTL_MS) {
      const entry = { at: now, pairs: client.tokenPairs() };
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
   *  isn't asked, and only what it said before counts. */
  async function choiceFor(network: NetworkId, client: Lcd, denoms: Iterable<string>): Promise<ChoiceView> {
    const out: ChoiceView = { prices: new Map(), onChoice: new Set(), seen: new Set(), priceOf: () => undefined };
    if (network !== "mainnet") return out;
    const now = Date.now();
    const ask = await d.prices();
    // When Choice last priced each address, kept a week.
    const stored = ((await d.local.get(["choice_seen"]))["choice_seen"] ?? {}) as Record<string, number>;
    const seen: Record<string, number> = {};
    for (const [a, t] of Object.entries(stored)) if (typeof t === "number" && now - t < SEEN_MS) seen[a] = t;
    if (!ask && Object.keys(seen).length === 0) return out;

    if (ask && (!priceCache || now - priceCache.at > PRICE_TTL_MS)) {
      const entry = { at: now, list: fetchPrices(d.fetch) };
      priceCache = entry;
      entry.list.catch(() => {
        if (priceCache === entry) priceCache = null;
      });
    }
    const [list, pairs] = await Promise.all([ask && priceCache ? priceCache.list.catch(() => null) : null, pairsFor(network, client)]);
    if (list) {
      for (const a of list.prices.keys()) seen[a] = now;
      await d.local.set({ choice_seen: seen });
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
      t = rpc.erc20Metadata(address).then((m) => (m ? { denom, ...m, known: false } : null));
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
    const holder = address(network, account);
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
      t = describeToken(client, network, denom);
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
   *  by symbol. The UI filters. */
  async function balances(network: NetworkId, account: AccountInfo): Promise<Result<{ network: NetworkId; balances: Balance[]; evmDown?: true }>> {
    const client = await lcd(network);
    try {
      const coins = await client.balances(address(network, account));
      const bank: Balance[] = await Promise.all(coins.map(async (c) => ({ ...(await token(network, client, c.denom)), amount: c.amount })));
      const list = [...bank, ...(await cw20Holdings(network, client, account, bank))];
      const choice = await choiceFor(network, client, list.map((b) => b.denom));
      const out: Balance[] = list.map((b) => {
        const p = choice.prices.get(b.denom);
        const seen = choice.onChoice.has(b.denom) ? { onChoice: true } : {};
        const other = otherForm(network, b.denom);
        const more = { ...seen, ...(other ? { convertsTo: other } : {}) };
        return p ? { ...b, ...more, priceUsd: p, usd: usdValue(b.amount, b.decimals, p) } : { ...b, ...more };
      });
      // EVM-only tokens: a failure here leaves the bank list standing.
      let evmDown = false;
      try {
        out.push(...(await evmOnly(network, client, account, out, choice)));
      } catch (e) {
        if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
        evmDown = true;
      }
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
    const me = address(network, account);
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
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(LOOKUP_PARALLEL, missing.length) }, async () => {
            while (next < missing.length) {
              const i = next++;
              try {
                got[i] = await client.txByEvmHash(missing[i]!.hash);
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
      const items = mergeActivity(lists);
      const denoms = new Set(items.flatMap((a) => [...a.changes, ...a.fee].map((c) => c.denom).concat(a.approval ? [a.approval.denom] : [])));
      const choice = await choiceFor(network, client, denoms);
      const described = await Promise.all(
        [...denoms].map(async (dn) => {
          const a = evmAddress(dn);
          const t = a ? await erc20Token(network, await evm(network), a).catch(() => null) : await token(network, client, dn);
          return t ? ([dn, { ...t, ...(choice.onChoice.has(dn) ? { onChoice: true } : {}) }] as const) : null;
        }),
      );
      const tokens = Object.fromEntries(described.filter((x) => x !== null));
      return {
        ok: true,
        result: { network, items, tokens, more: streams.some((st) => !st.done), cutoff, ...(indexDown ? { evmIndexDown: true as const } : {}) },
      };
    } catch (e) {
      return chainFailure(e);
    }
  }

  async function prepare(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string; memo?: unknown }): Promise<Result<SendReview>> {
    if (typeof req.denom !== "string" || !req.denom) return fail("bad_request", "Pick a token.");
    if (typeof req.to !== "string" || req.to.length > 128) return fail("invalid_address", "Check the recipient address.");
    const memo = memoFrom(req.memo);
    if (memo === null) return fail("bad_request", "A memo is at most 256 characters, on one line.");
    if (evmAddress(req.denom)) {
      if (memo) return fail("bad_request", "An EVM-only token's send can't carry a memo.");
      return prepareEvm(network, account, { denom: req.denom, to: req.to, amount: req.amount });
    }
    const cw20 = cw20Address(req.denom);
    return prepareCosmos(network, account, {
      denom: req.denom,
      amount: req.amount,
      memo,
      recipient: req.to,
      messages: (amount) => [
        cw20
          ? { type: "cw20_transfer", contract: cw20, to: req.to, amount: amount.toString() }
          : { type: "bank_send", to: req.to, amount: [{ denom: req.denom, amount: amount.toString() }] },
      ],
    });
  }

  /** Convert a token into its other form through the network's CW20 adapter: a CW20 into
   *  its bank denom (which also makes it an ERC20 where it has a pair), or back. One for
   *  one; the adapter is the only contract involved. */
  async function prepareConvert(network: NetworkId, account: AccountInfo, req: { denom: string; amount: string }): Promise<Result<SendReview>> {
    if (typeof req.denom !== "string") return fail("bad_request", "Pick a token.");
    const cw20 = cw20Address(req.denom);
    const inner = adapterCw20(network, req.denom);
    if (!cw20 && !inner) return fail("bad_request", "This token has no other form.");
    return prepareCosmos(network, account, {
      denom: req.denom,
      amount: req.amount,
      knownContracts: [NETWORKS[network].cw20Adapter],
      returned: true,
      messages: (amount) => [cw20 ? { type: "cw20_to_bank", contract: cw20, amount: amount.toString() } : { type: "bank_to_cw20", contract: inner, amount: amount.toString() }],
    });
  }

  /** A Cosmos transaction the wallet builds, spending `amount` (or all, "max") of `denom`
   *  (a bank denom or a `cw20:` key): simulate it for gas, build it again with the real
   *  fee, decode and grade it. */
  async function prepareCosmos(
    network: NetworkId,
    account: AccountInfo,
    spec: {
      denom: string;
      amount: string;
      messages: (amount: bigint) => unknown[];
      knownContracts?: string[];
      /** It all comes back in another form (a conversion): the share-of-balance warnings
       *  don't apply, so the spent token's balance is left out of the risk context. The
       *  amount was checked against it here. */
      returned?: boolean;
      /** The amount comes from somewhere other than this account's balance of `denom` (a
       *  stake being unstaked or moved): how much is there, and what to call it when there
       *  isn't enough. The fee is still paid from the balance. */
      source?: { available: bigint; short: string };
      /** Kept back from the balance on "max", for later fees. */
      reserve?: bigint;
      /** There is no amount (claiming rewards); `amount` is ignored. */
      noAmount?: boolean;
      memo?: string;
      /** Who receives the amount, for the address book and the memo check. */
      recipient?: string;
    },
  ): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const client = await lcd(network);
    // Read alongside the rest; the risk rules need it at the end.
    const facts = d.riskFacts(network, spec.recipient ?? null);
    facts.catch(() => {});
    const max = !spec.noAmount && spec.amount === "max";
    if (!spec.noAmount && !max && !(typeof spec.amount === "string" && /^[0-9]+$/.test(spec.amount) && BigInt(spec.amount) > 0n)) {
      return fail("invalid_amount", "Enter an amount above zero.");
    }
    const cw20 = cw20Address(spec.denom);
    try {
      const from = address(network, account);
      const [acct, coins, price, cw20Held] = await Promise.all([
        client.account(from),
        client.balances(from),
        client.gasPrice(),
        cw20 ? client.cw20Balance(cw20, from) : Promise.resolve(null),
      ]);
      if (!acct) return fail("no_funds", "This account has no funds yet.");
      if (cw20 && cw20Held === null) return fail("not_a_token", "That contract isn't a CW20 token.");
      const held = (denom: string) => (cw20 && denom === spec.denom ? cw20Held! : BigInt(coins.find((c) => c.denom === denom)?.amount ?? "0"));
      const symbol = (await token(network, client, spec.denom)).symbol;
      const feeSymbol = (await token(network, client, net.feeDenom)).symbol;
      // Whether the amount leaves the balance the fee is paid from.
      const fromBalance = !spec.source && !spec.noAmount;
      const sameDenom = fromBalance && spec.denom === net.feeDenom;
      const available = () => spec.source?.available ?? held(spec.denom);
      const amountFor = (fee: bigint) =>
        spec.noAmount ? 0n : max ? (spec.source ? spec.source.available : held(spec.denom) - (sameDenom ? fee + (spec.reserve ?? 0n) : 0n)) : BigInt(spec.amount);
      const check = (amount: bigint, fee: bigint): Result<never> | null => {
        if (!spec.noAmount && (amount <= 0n || amount > available())) {
          return fail("insufficient", spec.source ? `That's more than ${spec.source.short}.` : `Not enough ${symbol}.`);
        }
        if ((sameDenom ? amount : 0n) + fee > held(net.feeDenom)) return fail("insufficient", `Not enough ${feeSymbol} for the fee.`);
        return null;
      };
      const build = (amount: bigint, gas: bigint) =>
        d.vault<{ request: unknown; simulate_tx: string }>("build_cosmos", {
          chain: net.cosmos,
          signer: account.public_key,
          messages: spec.messages(amount),
          account_number: acct.accountNumber.toString(),
          sequence: acct.sequence.toString(),
          fee: { amount: [{ denom: net.feeDenom, amount: (gas * price).toString() }], gas_limit: gas.toString() },
          memo: spec.memo ?? "",
        });

      // Simulate with a provisional fee, then build with the real one.
      let amount = amountFor(SIMULATION_GAS * price);
      const early = check(amount, SIMULATION_GAS * price);
      if (early) return early;
      const sim = await build(amount, SIMULATION_GAS);
      if (!sim.ok) {
        return sim.error.message.startsWith("invalid address") ? fail("invalid_address", "Check the recipient address.") : sim;
      }
      const used = await client.simulate(sim.result.simulate_tx);
      const checkedBy = new URL(client.pool.current).host;
      let gas = (used * 13n) / 10n + 1n;
      if (gas < MIN_GAS) gas = MIN_GAS;
      if (gas > MAX_GAS) return fail("chain", "The gas estimate looks wrong. Try another endpoint.");
      amount = amountFor(gas * price);
      const late = check(amount, gas * price);
      if (late) return late;
      const built = await build(amount, gas);
      if (!built.ok) return built;

      // Balances and symbols for the risk rules, keyed as they are: bank denoms, and a
      // CW20 by its contract. Symbols are the wallet's list, else the short denom (a
      // creator-chosen symbol could pass for another token).
      const balances: Record<string, string> = Object.fromEntries(coins.map((c) => [c.denom, c.amount]));
      const symbols: Record<string, string> = {};
      for (const c of coins) {
        const t = await token(network, client, c.denom);
        symbols[c.denom] = t.known ? t.symbol : shortDenom(c.denom);
      }
      if (cw20) {
        balances[cw20] = cw20Held!.toString();
        symbols[cw20] = shortDenom(spec.denom);
      }
      if (spec.returned) delete balances[cw20 ?? spec.denom];
      const decoded = await d.vault<Pick<SendReview, "digest" | "risk"> & { display: CosmosDisplay }>("decode", {
        request: built.result.request,
        context: { balances, symbols, known_contracts: spec.knownContracts ?? [], ...(await facts) },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        account: account.account,
        wallet: account.wallet,
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
      };
      await d.session.set({ pending_send: pending });
      const tokens = await tokensFor(network, displayDenoms(network, display));
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** An EVM-only token's send: an ERC20 `transfer` on the EVM side, fee in INJ. Same shape
   *  as a bank send: build, estimate, build again with the real gas, decode and grade. With
   *  `revoke` (a spender), an `approve(spender, 0)` on the token instead, and no amount. */
  async function prepareEvm(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string; revoke?: string }): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const contract = evmAddress(req.denom)!;
    const from = account.addresses[net.evm];
    if (!from) return fail("bad_request", "This account has no EVM address.");
    const client = await lcd(network);
    const facts = d.riskFacts(network, req.revoke ? null : req.to);
    facts.catch(() => {});
    try {
      const rpc = await evm(network);
      const t = await erc20Token(network, rpc, contract);
      if (!t) return fail("not_a_token", "That contract isn't an ERC20 token.");
      const [nonce, block, tip, native, held] = await rpc.batch([
        { method: "eth_getTransactionCount", params: [from, "pending"] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        { method: "eth_maxPriorityFeePerGas", params: [] },
        { method: "eth_getBalance", params: [from, "latest"] },
        { method: "eth_call", params: [{ to: contract, data: `0x70a08231${word(from)}` }, "latest"] },
      ]);
      const quantity = (v: unknown, what: string): bigint => {
        if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new ChainError(-1, `the node returned no ${what}`);
        return BigInt(v);
      };
      const tokenHeld = quantity(held, "token balance");
      const injHeld = quantity(native, "balance");
      const base = isObject(block) ? quantity(block["baseFeePerGas"], "base fee") : MIN_GAS_PRICE;
      // The chain's own bounds, as for Cosmos fees; a tip above the base fee isn't believed.
      const baseFee = base < MIN_GAS_PRICE ? MIN_GAS_PRICE : base > MIN_GAS_PRICE * 1000n ? MIN_GAS_PRICE * 1000n : base;
      const tipped = typeof tip === "string" ? quantity(tip, "tip") : 0n;
      const priority = tipped > baseFee ? baseFee : tipped;
      // Injective EVM charges gas limit × max fee per gas, with no refund of unused gas or
      // of the gap to the base fee (measured on testnet 2026-11-09). So no headroom on the
      // fee, whose base sits at the chain minimum, and a smaller gas margin than Cosmos's.
      const maxFee = baseFee + priority;
      const amount = req.revoke ? 0n : req.amount === "max" ? tokenHeld : BigInt(req.amount);
      if (!req.revoke && (amount <= 0n || amount > tokenHeld)) return fail("insufficient", `Not enough ${t.symbol}.`);
      const build = (gas: bigint) =>
        d.vault<{ request: { evm_transaction: { tx: { to: string; data: string } } } }>("build_evm", {
          chain: net.evm,
          from,
          to: req.revoke ? contract : req.to,
          token: contract,
          ...(req.revoke ? { revoke: req.revoke } : {}),
          amount: amount.toString(),
          nonce: Number(quantity(nonce, "nonce")),
          gas_limit: Number(gas),
          max_fee_per_gas: maxFee.toString(),
          max_priority_fee_per_gas: priority.toString(),
        });
      const sim = await build(EVM_SIMULATION_GAS);
      if (!sim.ok) return sim.error.message.startsWith("invalid address") ? fail("invalid_address", "Check the recipient address.") : sim;
      const { to, data } = sim.result.request.evm_transaction.tx;
      const used = quantity(await rpc.call("eth_estimateGas", [{ from, to, data, value: "0x0" }]), "gas estimate");
      const checkedBy = new URL(rpc.pool.current).host;
      let gas = (used * 12n) / 10n + 1n;
      if (gas < 21_000n) gas = 21_000n;
      if (gas > EVM_MAX_GAS) return fail("chain", "The gas estimate looks wrong. Try another endpoint.");
      if (gas * maxFee > injHeld) return fail("insufficient", "Not enough INJ for the fee.");
      const built = await build(gas);
      if (!built.ok) return built;

      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: {
          balances: { native: injHeld.toString(), [to]: tokenHeld.toString() },
          symbols: { [to]: t.known ? t.symbol : shortDenom(req.denom) },
          ...(await facts),
        },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        account: account.account,
        wallet: account.wallet,
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
        evm: true,
      };
      await d.session.set({ pending_send: pending });
      const choice = await choiceFor(network, client, [net.feeDenom]);
      const price = choice.priceOf(contract);
      const fee = await token(network, client, net.feeDenom);
      const feePrice = choice.prices.get(net.feeDenom);
      const tokens = {
        [req.denom]: price ? { ...t, priceUsd: price } : t,
        [net.feeDenom]: feePrice ? { ...fee, priceUsd: feePrice } : fee,
      };
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** Sign the send the review showed, with the wallet that prepared it, then broadcast. */
  async function confirm(
    unlockKey: string,
    signerOf: (wallet: string) => Promise<{ secret: string; wallet: string } | null>,
    req: { digest: string; confirm?: string },
  ): Promise<Result<Sent>> {
    const { pending_send } = await d.session.get(["pending_send"]);
    const p = pending_send as Pending | undefined;
    if (!p || p.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (req.confirm ?? "").trim() !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    await d.session.remove(["pending_send"]);
    const signer = await signerOf(p.wallet);
    if (!signer) return fail("not_approved", "That wallet is gone. Review the send again.");
    const signed = await d.vault<{ tx_raw: string } & { raw: string; hash: string }>("sign", {
      ...signer,
      unlock_key: unlockKey,
      account: p.account,
      request: p.request,
      digest: p.digest,
    });
    if (!signed.ok) return signed;
    if (p.evm) {
      // The vault hashes what it signed; a node that already has the tx (a retry) is fine.
      const hash = signed.result.hash.toLowerCase();
      try {
        await (await evm(p.network)).call("eth_sendRawTransaction", [signed.result.raw]);
      } catch (e) {
        if (!(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) return chainFailure(e);
      }
      return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
    }
    const hash = await cosmosTxHash(signed.result.tx_raw);
    try {
      await (await lcd(p.network)).broadcast(signed.result.tx_raw, hash);
    } catch (e) {
      return chainFailure(e);
    }
    return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
  }

  async function status(network: NetworkId, hash: string): Promise<Result<TxState>> {
    if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      try {
        const r = await (await evm(network)).call("eth_getTransactionReceipt", [hash]);
        if (!isObject(r)) return { ok: true, result: { state: "pending" } };
        return { ok: true, result: r["status"] === "0x1" ? { state: "success" } : { state: "failed", log: "The transaction reverted." } };
      } catch (e) {
        return chainFailure(e);
      }
    }
    if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    try {
      const tx = await (await lcd(network)).tx(hash);
      if (!tx) return { ok: true, result: { state: "pending" } };
      return { ok: true, result: tx.code === 0 ? { state: "success" } : { state: "failed", log: tx.log } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  return {
    balances,
    activity,
    inspectToken,
    prepare,
    prepareConvert,
    prepareCosmos,
    prepareEvm,
    confirm,
    status,
    lcd,
    evm,
    evmIndex,
    tokensFor,
    chainFailure,
    token,
    riskFacts: d.riskFacts,
  };
}

/** Every token a decoded Cosmos transaction moves, by the wallet's keys: the fee, coins
 *  sent or attached, a CW20 by its `cw20:` key, and what an adapter conversion returns. */
export function displayDenoms(network: NetworkId, display: CosmosDisplay): Set<string> {
  const out = new Set<string>(display.fee.amount.map((c) => c.denom));
  const coins = (v: unknown) => (Array.isArray(v) ? (v as Coin[]).filter((c) => typeof c?.denom === "string") : []);
  for (const msg of display.messages) {
    const m = msg as Record<string, unknown>;
    for (const c of [...coins(m["amount"]), ...coins(m["funds"])]) out.add(c.denom);
    const call = isObject(m["call"]) ? m["call"] : null;
    const contract = typeof m["contract"] === "string" ? m["contract"] : "";
    if (!call || !isContractAddress(contract)) continue;
    if (["cw20_transfer", "cw20_send", "cw20_increase_allowance", "cw20_decrease_allowance"].includes(String(call["type"]))) out.add(cw20Denom(contract));
    // A CW20 sent to the adapter comes back as its bank form.
    if (call["type"] === "cw20_send" && call["contract"] === NETWORKS[network].cw20Adapter) out.add(adapterDenom(network, contract));
    if (call["type"] === "adapter_redeem") {
      for (const f of coins(m["funds"])) {
        const inner = adapterCw20(network, f.denom);
        if (inner) out.add(cw20Denom(inner));
      }
    }
  }
  return out;
}

function address(network: NetworkId, account: AccountInfo): string {
  const a = account.addresses[NETWORKS[network].cosmos];
  if (!a) throw new Error(`no ${network} address for this account`);
  return a;
}

function rank(network: NetworkId, t: Token): number {
  return t.denom === NETWORKS[network].feeDenom ? 0 : t.known ? 1 : 2;
}
