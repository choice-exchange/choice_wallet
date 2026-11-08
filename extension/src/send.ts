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
  type Fetch,
  type NetworkId,
  type PriceList,
  type Token,
} from "@choice-wallet/chain";
import type { AccountInfo, ActivityPage, Balance, CosmosDisplay, Result, Risk, SendReview, Sent, TxState } from "@choice-wallet/ui/protocol";

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
  /** Whether to show USD values (the user can turn them off). */
  prices(): Promise<boolean>;
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
  confirm: string | null;
  blocked: boolean;
  /** An EVM transaction (broadcast with eth_sendRawTransaction), not a Cosmos one. */
  evm?: boolean;
}

/** Index entries per query per page (the node's `limit`). */
const ACTIVITY_PAGE = 50;

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

  /** The erc20 module's token pairs (bank denom → ERC20 address), cached an hour. Empty
   *  when the node can't say. */
  function pairsFor(_network: NetworkId, client: Lcd): Promise<Map<string, string>> {
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
    return pc.pairs.catch(() => new Map<string, string>());
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

  /** A page of activity: what this account signed, and what it received, merged. */
  async function activity(network: NetworkId, account: AccountInfo, page: unknown): Promise<Result<Omit<ActivityPage, "filter">>> {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000) return fail("bad_request", "Not a page number.");
    const client = await lcd(network);
    const me = address(network, account);
    try {
      const pages = await Promise.all(
        [`message.sender='${me}'`, `coin_received.receiver='${me}'`].map((q) => client.searchTxs(q, page, ACTIVITY_PAGE)),
      );
      const lists = pages.map((p) => p.txs.map((tx) => summarize(tx, me)));
      // A list that goes on past its last item: below the highest of those last items, a
      // next page could still hold rows newer than what's shown.
      const open = lists.filter((l, i) => !pages[i]!.done && l.length > 0);
      const lows = open.map((l) => l.reduce((m, a) => (BigInt(a.height) < m ? BigInt(a.height) : m), BigInt(l[0]!.height)));
      const cutoff = lows.length > 0 ? lows.reduce((a, b) => (a > b ? a : b)).toString() : null;
      const items = mergeActivity(lists);
      const denoms = new Set(items.flatMap((a) => [...a.changes, ...a.fee].map((c) => c.denom)));
      const choice = await choiceFor(network, client, denoms);
      const tokens = Object.fromEntries(
        await Promise.all([...denoms].map(async (dn) => [dn, { ...(await token(network, client, dn)), ...(choice.onChoice.has(dn) ? { onChoice: true } : {}) }] as const)),
      );
      return { ok: true, result: { network, items, tokens, more: pages.some((p) => !p.done), cutoff } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  async function prepare(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string }): Promise<Result<SendReview>> {
    if (typeof req.denom !== "string" || !req.denom) return fail("bad_request", "Pick a token.");
    if (evmAddress(req.denom)) return prepareEvm(network, account, req);
    const cw20 = cw20Address(req.denom);
    return prepareCosmos(network, account, {
      denom: req.denom,
      amount: req.amount,
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
    },
  ): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const client = await lcd(network);
    const max = spec.amount === "max";
    if (!max && !(typeof spec.amount === "string" && /^[0-9]+$/.test(spec.amount) && BigInt(spec.amount) > 0n)) {
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
      const sameDenom = spec.denom === net.feeDenom;
      const amountFor = (fee: bigint) => (max ? held(spec.denom) - (sameDenom ? fee : 0n) : BigInt(spec.amount));
      const check = (amount: bigint, fee: bigint): Result<never> | null => {
        if (amount <= 0n || amount > held(spec.denom)) return fail("insufficient", `Not enough ${symbol}.`);
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
        context: { balances, symbols, known_contracts: spec.knownContracts ?? [] },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        account: account.account,
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
      };
      await d.session.set({ pending_send: pending });
      const denoms = displayDenoms(network, display);
      const px = (await choiceFor(network, client, denoms)).prices;
      const tokens = Object.fromEntries(
        await Promise.all(
          [...denoms].map(async (dn) => {
            const t = await token(network, client, dn);
            const p = px.get(dn);
            return [dn, p ? { ...t, priceUsd: p } : t] as const;
          }),
        ),
      );
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** An EVM-only token's send: an ERC20 `transfer` on the EVM side, fee in INJ. Same shape
   *  as a bank send: build, estimate, build again with the real gas, decode and grade. */
  async function prepareEvm(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string }): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const contract = evmAddress(req.denom)!;
    const from = account.addresses[net.evm];
    if (!from) return fail("bad_request", "This account has no EVM address.");
    const client = await lcd(network);
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
      const amount = req.amount === "max" ? tokenHeld : BigInt(req.amount);
      if (amount <= 0n || amount > tokenHeld) return fail("insufficient", `Not enough ${t.symbol}.`);
      const build = (gas: bigint) =>
        d.vault<{ request: { evm_transaction: { tx: { to: string; data: string } } } }>("build_evm", {
          chain: net.evm,
          from,
          to: req.to,
          token: contract,
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
        context: { balances: { native: injHeld.toString(), [to]: tokenHeld.toString() }, symbols: { [to]: t.known ? t.symbol : shortDenom(req.denom) } },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        account: account.account,
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

  async function confirm(keystore: string, unlockKey: string, req: { digest: string; confirm?: string }): Promise<Result<Sent>> {
    const { pending_send } = await d.session.get(["pending_send"]);
    const p = pending_send as Pending | undefined;
    if (!p || p.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (req.confirm ?? "").trim() !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    await d.session.remove(["pending_send"]);
    const signed = await d.vault<{ tx_raw: string } & { raw: string; hash: string }>("sign", {
      keystore,
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

  return { balances, activity, inspectToken, prepare, prepareConvert, confirm, status };
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
    if (call["type"] === "cw20_transfer" || call["type"] === "cw20_send" || call["type"] === "cw20_increase_allowance") out.add(cw20Denom(contract));
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
