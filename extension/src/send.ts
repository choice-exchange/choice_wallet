// Balances and sends, chrome-free so they run under test. A send is two requests:
//
// 1. prepare: read the account, balances and gas price; build the transaction, simulate it
//    for gas, build it again with the real fee; decode it and grade it with the risk rules
//    (the vault, like any dapp request). The review shows that decode. The prepared
//    request waits in session storage under its digest.
// 2. confirm: sign exactly the request whose digest the review showed, then broadcast.
//    The pending request is removed first, so a double click can't send twice.

import {
  ChainError,
  cosmosTxHash,
  describeToken,
  EvmRpc,
  evmDenom,
  explorerTxUrl,
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
import type { AccountInfo, ActivityPage, Balance, Result, Risk, SendReview, Sent, TxState } from "@choice-wallet/ui/protocol";

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
}

/** Index entries per query per page (the node's `limit`). */
const ACTIVITY_PAGE = 50;

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
  const pairCache = new Map<NetworkId, { at: number; pairs: Promise<Map<string, string>> }>();

  /** The erc20 module's token pairs (bank denom → ERC20 address), cached an hour. Empty
   *  when the node can't say. */
  function pairsFor(network: NetworkId, client: Lcd): Promise<Map<string, string>> {
    const now = Date.now();
    let pc = pairCache.get(network);
    if (!pc || now - pc.at > PAIRS_TTL_MS) {
      const entry = { at: now, pairs: client.tokenPairs() };
      pairCache.set(network, entry);
      entry.pairs.catch(() => {
        if (pairCache.get(network) === entry) pairCache.delete(network);
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
    for (const dn of denoms) {
      const a = priceAddress(dn, pairs);
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

  async function customTokens(network: NetworkId): Promise<string[]> {
    const { custom_tokens } = (await d.local.get(["custom_tokens"])) as { custom_tokens?: Partial<Record<NetworkId, unknown>> };
    const list = custom_tokens?.[network];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a)) : [];
  }

  /** ERC20s with no bank denom that this account holds (or added by hand). Candidates are
   *  what Choice priced this week and the user's own additions; anything a bank denom
   *  already covers (an `erc20:` denom or a token pair) is left to the bank list, so no
   *  token shows twice. */
  async function evmOnly(network: NetworkId, client: Lcd, account: AccountInfo, bank: readonly Balance[], choice: ChoiceView): Promise<Balance[]> {
    const custom = await customTokens(network);
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
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address.trim())) return fail("invalid_address", "Enter a token contract address (0x…).");
    const a = address.trim().toLowerCase();
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
      const list = await Promise.all(coins.map(async (c) => ({ ...(await token(network, client, c.denom)), amount: c.amount })));
      const choice = await choiceFor(network, client, list.map((b) => b.denom));
      const out: Balance[] = list.map((b) => {
        const p = choice.prices.get(b.denom);
        const seen = choice.onChoice.has(b.denom) ? { onChoice: true } : {};
        return p ? { ...b, ...seen, priceUsd: p, usd: usdValue(b.amount, b.decimals, p) } : { ...b, ...seen };
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
    const net = NETWORKS[network];
    const client = await lcd(network);
    const max = req.amount === "max";
    if (typeof req.denom !== "string" || !req.denom) return fail("bad_request", "Pick a token.");
    if (req.denom.startsWith("evm:")) return fail("not_yet", "Sending EVM-only tokens comes next.");
    if (!max && !(typeof req.amount === "string" && /^[0-9]+$/.test(req.amount) && BigInt(req.amount) > 0n)) {
      return fail("invalid_amount", "Enter an amount above zero.");
    }
    try {
      const from = address(network, account);
      const [acct, coins, price] = await Promise.all([client.account(from), client.balances(from), client.gasPrice()]);
      if (!acct) return fail("no_funds", "This account has no funds yet.");
      const held = (denom: string) => BigInt(coins.find((c) => c.denom === denom)?.amount ?? "0");
      const symbol = (await token(network, client, req.denom)).symbol;
      const feeSymbol = (await token(network, client, net.feeDenom)).symbol;
      const sameDenom = req.denom === net.feeDenom;
      const amountFor = (fee: bigint) => (max ? held(req.denom) - (sameDenom ? fee : 0n) : BigInt(req.amount));
      const check = (amount: bigint, fee: bigint): Result<never> | null => {
        if (amount <= 0n || amount > held(req.denom)) return fail("insufficient", `Not enough ${symbol}.`);
        if ((sameDenom ? amount : 0n) + fee > held(net.feeDenom)) return fail("insufficient", `Not enough ${feeSymbol} for the fee.`);
        return null;
      };
      const build = (amount: bigint, gas: bigint) =>
        d.vault<{ request: unknown; simulate_tx: string }>("build_cosmos", {
          chain: net.cosmos,
          signer: account.public_key,
          messages: [{ type: "bank_send", to: req.to, amount: [{ denom: req.denom, amount: amount.toString() }] }],
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

      // Symbols for the risk rules' messages: the wallet's list, else the short denom (a
      // creator-chosen symbol could pass for another token).
      const symbols: Record<string, string> = {};
      for (const c of coins) {
        const t = await token(network, client, c.denom);
        symbols[c.denom] = t.known ? t.symbol : shortDenom(c.denom);
      }
      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: { balances: Object.fromEntries(coins.map((c) => [c.denom, c.amount])), symbols },
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
      const denoms = new Set<string>(display.fee.amount.map((c) => c.denom));
      for (const m of display.messages) if (Array.isArray(m["amount"])) for (const c of m["amount"] as Coin[]) denoms.add(c.denom);
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

  async function confirm(keystore: string, unlockKey: string, req: { digest: string; confirm?: string }): Promise<Result<Sent>> {
    const { pending_send } = await d.session.get(["pending_send"]);
    const p = pending_send as Pending | undefined;
    if (!p || p.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (req.confirm ?? "").trim() !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    await d.session.remove(["pending_send"]);
    const signed = await d.vault<{ tx_raw: string }>("sign", {
      keystore,
      unlock_key: unlockKey,
      account: p.account,
      request: p.request,
      digest: p.digest,
    });
    if (!signed.ok) return signed;
    const hash = await cosmosTxHash(signed.result.tx_raw);
    try {
      await (await lcd(p.network)).broadcast(signed.result.tx_raw, hash);
    } catch (e) {
      return chainFailure(e);
    }
    return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
  }

  async function status(network: NetworkId, hash: string): Promise<Result<TxState>> {
    if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    try {
      const tx = await (await lcd(network)).tx(hash);
      if (!tx) return { ok: true, result: { state: "pending" } };
      return { ok: true, result: tx.code === 0 ? { state: "success" } : { state: "failed", log: tx.log } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  return { balances, activity, inspectToken, prepare, confirm, status };
}

function address(network: NetworkId, account: AccountInfo): string {
  const a = account.addresses[NETWORKS[network].cosmos];
  if (!a) throw new Error(`no ${network} address for this account`);
  return a;
}

function rank(network: NetworkId, t: Token): number {
  return t.denom === NETWORKS[network].feeDenom ? 0 : t.known ? 1 : 2;
}
