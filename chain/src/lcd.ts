// Cosmos REST (LCD) client for what the wallet needs: accounts, balances, token metadata,
// gas estimates, broadcasting and transaction status. Every response is checked before
// use; an endpoint that serves another chain is skipped.

import { hexToBase64 } from "./encoding.ts";
import { EVM_MSG, evmResults, failedEvmHash, type EvmLog } from "./evmtx.ts";
import { MIN_GAS_PRICE, type Network } from "./networks.ts";
import { ChainError, Down, isObject, Pool, type Fetch } from "./pool.ts";
import { parseDelegations, parseRewards, parseUnbonding, parseUnbondingTime, parseValidators, type Delegation, type Unbonding, type Validator } from "./staking.ts";
import { ceilDecimal, toBigInt } from "./units.ts";

export interface Coin {
  denom: string;
  amount: string;
}

export interface Account {
  address: string;
  accountNumber: bigint;
  sequence: bigint;
}

export interface DenomMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

export interface TxStatus {
  hash: string;
  height: bigint;
  /** 0 on success. */
  code: number;
  log: string;
}

export interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
}

/** A transaction from the node's tx index, with what's needed to describe it. */
export interface IndexedTx {
  hash: string;
  height: bigint;
  /** ISO 8601, from the block. */
  time: string;
  /** 0 on success. */
  code: number;
  /** As the node renders them: each has an "@type". */
  messages: Record<string, unknown>[];
  fee: Coin[];
  events: TxEvent[];
  /** For an EVM transaction: its 0x hash (null if the node didn't say) and its logs (none
   *  when it reverted). */
  evm?: { hash: string | null; logs: EvmLog[] };
}

export interface Broadcast {
  hash: string;
  /** Another endpoint may already have relayed it (a retry after a timeout): watch the
   *  hash rather than trust this answer. */
  uncertain: boolean;
}

/** gRPC codes that mean the node, not the request, is the problem. */
const NODE_TROUBLE = new Set([4 /* deadline */, 8 /* exhausted */, 14 /* unavailable */]);
/** sdk codes on broadcast. */
const TX_IN_MEMPOOL = 19;
const WRONG_SEQUENCE = 32;
/** Highest gas price accepted from a node: txfees `max_base_fee_multiplier` (1000) × min. */
const MAX_GAS_PRICE = MIN_GAS_PRICE * 1000n;

export class Lcd {
  readonly network: Network;
  readonly pool: Pool;

  constructor(network: Network, urls: readonly string[], fetch: Fetch, timeoutMs?: number) {
    this.network = network;
    this.pool = new Pool(urls, {
      fetch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      identify: async (base) => {
        const r = await this.pool.json(`${base}/cosmos/base/tendermint/v1beta1/node_info`);
        const info = isObject(r.body) && isObject(r.body["default_node_info"]) ? r.body["default_node_info"] : {};
        const served = info["network"];
        if (r.status !== 200 || typeof served !== "string") throw new Down(`node_info: HTTP ${r.status}`);
        if (served !== network.chainId) throw new Down(`serves ${served}, not ${network.chainId}`);
      },
    });
  }

  /** GET or POST `path` and return the body of a 200 answer. A chain error is thrown as
   *  `ChainError`; anything else moves on to the next endpoint. */
  #call(path: string, post?: unknown, onAnswer?: (body: unknown, tries: number) => unknown): Promise<unknown> {
    return this.pool.run(async (base, tries) => {
      const init: RequestInit = post === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(post) };
      const { status, body } = await this.pool.json(`${base}${path}`, init);
      if (status === 200 && isObject(body)) return onAnswer ? onAnswer(body, tries) : body;
      if (isObject(body) && typeof body["code"] === "number" && typeof body["message"] === "string") {
        if (NODE_TROUBLE.has(body["code"])) throw new Down(`code ${body["code"]}: ${body["message"]}`);
        throw new ChainError(body["code"], cleanMessage(body["message"]));
      }
      throw new Down(`HTTP ${status}`);
    });
  }

  /** The account, or null if the chain has never seen it (nothing received yet). */
  async account(address: string): Promise<Account | null> {
    let body: unknown;
    try {
      body = await this.#call(`/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`);
    } catch (e) {
      if (e instanceof ChainError && e.code === 5) return null;
      throw e;
    }
    const acct = isObject(body) ? body["account"] : undefined;
    // Injective wraps the base account in an EthAccount.
    const base = isObject(acct) && isObject(acct["base_account"]) ? acct["base_account"] : acct;
    if (!isObject(base) || base["address"] !== address) throw new ChainError(-1, "the node returned another account");
    return {
      address,
      accountNumber: toBigInt(String(base["account_number"])),
      sequence: toBigInt(String(base["sequence"] ?? "0")),
    };
  }

  /** Spendable bank balances, every page from one endpoint. */
  async balances(address: string): Promise<Coin[]> {
    return (await this.pool.run(async (base) => {
      const coins: Coin[] = [];
      let key: string | null = null;
      for (let page = 0; page < 20; page++) {
        const q = key ? `&pagination.key=${encodeURIComponent(key)}` : "";
        const { status, body } = await this.pool.json(
          `${base}/cosmos/bank/v1beta1/spendable_balances/${encodeURIComponent(address)}?pagination.limit=1000${q}`,
        );
        if (status !== 200 || !isObject(body) || !Array.isArray(body["balances"])) throw new Down(`balances: HTTP ${status}`);
        for (const c of body["balances"]) coins.push(coin(c));
        const next = isObject(body["pagination"]) ? body["pagination"]["next_key"] : null;
        if (typeof next !== "string" || !next) return coins;
        key = next;
      }
      throw new Down("too many balance pages");
    })) as Coin[];
  }

  /** A bank denom's metadata, or null if it has none. Symbols and names are whatever the
   *  token's creator set: never proof of what the token is. */
  async denomMetadata(denom: string): Promise<DenomMetadata | null> {
    let body: unknown;
    try {
      body = await this.#call(`/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=${encodeURIComponent(denom)}`);
    } catch (e) {
      if (e instanceof ChainError && e.code === 5) return null;
      throw e;
    }
    const m = isObject(body) ? body["metadata"] : undefined;
    if (!isObject(m) || m["base"] !== denom) return null;
    let decimals = m["decimals"];
    if (typeof decimals !== "number" && Array.isArray(m["denom_units"])) {
      const unit = m["denom_units"].find((u) => isObject(u) && u["denom"] === m["display"]);
      decimals = isObject(unit) ? unit["exponent"] : undefined;
    }
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    return { symbol: String(m["symbol"] ?? ""), name: String(m["name"] ?? ""), decimals };
  }

  /** A contract's answer to a smart query; null when the contract refuses it (not that
   *  kind of contract, or no contract there). */
  async smart(contract: string, query: unknown): Promise<unknown> {
    const q = encodeURIComponent(btoa(JSON.stringify(query)));
    try {
      const body = await this.#call(`/cosmwasm/wasm/v1/contract/${encodeURIComponent(contract)}/smart/${q}`);
      return isObject(body) && "data" in body ? body["data"] : null;
    } catch (e) {
      if (e instanceof ChainError) return null;
      throw e;
    }
  }

  /** A CW20's balance for `holder` in base units, or null if `contract` isn't a CW20. */
  async cw20Balance(contract: string, holder: string): Promise<bigint | null> {
    const r = await this.smart(contract, { balance: { address: holder } });
    const b = isObject(r) ? r["balance"] : undefined;
    return typeof b === "string" && /^[0-9]{1,78}$/.test(b) ? BigInt(b) : null;
  }

  /** A CW20's `token_info`, or null if `contract` isn't a CW20. As with bank metadata, the
   *  symbol and name are whatever the token's creator chose. */
  async cw20Info(contract: string): Promise<DenomMetadata | null> {
    const r = await this.smart(contract, { token_info: {} });
    if (!isObject(r)) return null;
    const { symbol, name, decimals } = r;
    if (typeof symbol !== "string" || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    return { symbol, name: typeof name === "string" ? name : "", decimals };
  }

  /** The erc20 module's token pairs: bank denom → its ERC20 address on Injective EVM. */
  async tokenPairs(): Promise<Map<string, string>> {
    const body = await this.#call("/injective/erc20/v1beta1/all_token_pairs?pagination.limit=10000");
    const pairs = new Map<string, string>();
    const list = isObject(body) ? body["token_pairs"] : undefined;
    if (!Array.isArray(list)) throw new ChainError(-1, "the node returned no token pairs");
    for (const p of list) {
      if (isObject(p) && typeof p["bank_denom"] === "string" && typeof p["erc20_address"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(p["erc20_address"])) {
        pairs.set(p["bank_denom"], p["erc20_address"]);
      }
    }
    return pairs;
  }

  /** The bonded validators (the active set), by voting power. */
  async validators(): Promise<Validator[]> {
    const out: Validator[] = [];
    let key = "";
    for (let page = 0; page < 5; page++) {
      const q = key ? `&pagination.key=${encodeURIComponent(key)}` : "";
      const body = await this.#call(`/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=300${q}`);
      out.push(...parseValidators(body));
      const next = isObject(body) && isObject(body["pagination"]) ? body["pagination"]["next_key"] : null;
      if (typeof next !== "string" || !next) return out.sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0));
      key = next;
    }
    throw new ChainError(-1, "too many validator pages");
  }

  /** One validator, whatever its status (a stake can stay with one that left the active
   *  set), or null if there is none at that address. */
  async validator(address: string): Promise<Validator | null> {
    const body = await this.#empty(`/cosmos/staking/v1beta1/validators/${encodeURIComponent(address)}`, null);
    if (!isObject(body)) return null;
    const [v] = parseValidators({ validators: [body["validator"]] });
    if (v?.address !== address) throw new ChainError(-1, "the node returned another validator");
    return v;
  }

  /** `address`'s stakes in the bond denom. */
  async delegations(address: string): Promise<Delegation[]> {
    const body = await this.#empty(`/cosmos/staking/v1beta1/delegations/${encodeURIComponent(address)}?pagination.limit=500`, { delegation_responses: [] });
    return parseDelegations(body, address, this.network.feeDenom);
  }

  /** What `address` is unstaking, soonest first. */
  async unbonding(address: string): Promise<Unbonding[]> {
    const body = await this.#empty(`/cosmos/staking/v1beta1/delegators/${encodeURIComponent(address)}/unbonding_delegations?pagination.limit=500`, {
      unbonding_responses: [],
    });
    return parseUnbonding(body, address);
  }

  /** `address`'s unclaimed rewards in the bond denom, per validator. */
  async rewards(address: string): Promise<Map<string, bigint>> {
    const body = await this.#empty(`/cosmos/distribution/v1beta1/delegators/${encodeURIComponent(address)}/rewards`, { rewards: [] });
    return parseRewards(body, this.network.feeDenom);
  }

  /** How long unstaking takes, in seconds. */
  async unbondingTime(): Promise<number> {
    return parseUnbondingTime(await this.#call("/cosmos/staking/v1beta1/params"));
  }

  /** `#call`, with "not found" (an account the chain hasn't seen) read as `empty`. */
  async #empty(path: string, empty: unknown): Promise<unknown> {
    try {
      return await this.#call(path);
    } catch (e) {
      if (e instanceof ChainError && e.code === 5) return empty;
      throw e;
    }
  }

  /** A simulation's gas, and its events: what the transaction would do, as the bank module
   *  and contracts report it. The tx is unsigned (an empty signature), as simulation takes. */
  async simulateEvents(simulateTxHex: string): Promise<{ gasUsed: bigint; events: TxEvent[] }> {
    const body = await this.#call("/cosmos/tx/v1beta1/simulate", { tx_bytes: hexToBase64(simulateTxHex) });
    const used = isObject(body) && isObject(body["gas_info"]) ? body["gas_info"]["gas_used"] : undefined;
    if (typeof used !== "string") throw new ChainError(-1, "the node returned no gas estimate");
    const result = isObject(body) && isObject(body["result"]) ? body["result"] : {};
    return { gasUsed: toBigInt(used), events: Array.isArray(result["events"]) ? parseEvents(result["events"]) : [] };
  }

  /** Gas a transaction uses, from the vault's `simulate_tx`. */
  async simulate(simulateTxHex: string): Promise<bigint> {
    const body = await this.#call("/cosmos/tx/v1beta1/simulate", { tx_bytes: hexToBase64(simulateTxHex) });
    const used = isObject(body) && isObject(body["gas_info"]) ? body["gas_info"]["gas_used"] : undefined;
    if (typeof used !== "string") throw new ChainError(-1, "the node returned no gas estimate");
    return toBigInt(used);
  }

  /** Gas price for the fee: the chain's current base fee (Injective's txfees module), kept
   *  within the chain's own bounds so a node can't inflate it. */
  async gasPrice(): Promise<bigint> {
    try {
      const body = await this.#call("/injective/txfees/v1beta1/cur_eip_base_fee");
      const fee = isObject(body) && isObject(body["base_fee"]) ? body["base_fee"]["base_fee"] : undefined;
      if (typeof fee !== "string") return MIN_GAS_PRICE;
      const p = ceilDecimal(fee);
      return p < MIN_GAS_PRICE ? MIN_GAS_PRICE : p > MAX_GAS_PRICE ? MAX_GAS_PRICE : p;
    } catch (e) {
      if (e instanceof ChainError) return MIN_GAS_PRICE;
      throw e;
    }
  }

  /** Broadcast signed bytes (the vault's `tx_raw`). `hash` is the tx hash, computed before
   *  sending, so a retry that finds the tx already relayed still succeeds. */
  async broadcast(txRawHex: string, hash: string): Promise<Broadcast> {
    const result = await this.#call(
      "/cosmos/tx/v1beta1/txs",
      { tx_bytes: hexToBase64(txRawHex), mode: "BROADCAST_MODE_SYNC" },
      (body, tries) => {
        const r = isObject(body) ? body["tx_response"] : undefined;
        if (!isObject(r)) throw new Down("broadcast: no tx_response");
        const code = Number(r["code"] ?? 0);
        if (code === 0) return { hash, uncertain: false };
        if (code === TX_IN_MEMPOOL) return { hash, uncertain: tries > 0 };
        if (code === WRONG_SEQUENCE && tries > 0) return { hash, uncertain: true };
        throw new ChainError(code, cleanMessage(String(r["raw_log"] ?? "")));
      },
    );
    return result as Broadcast;
  }

  /** Transactions matching a CometBFT event query, newest first. `page` counts from 1; past
   *  the last page is an empty list. `done` says no later page holds more: `total` and
   *  `limit` count the same index entries, and a transaction matching more than once (two
   *  messages from one sender) comes back once, so a page can hold fewer than `limit`.
   *  Each node indexes its own window of history (seen 2026-11-09: the sentry refuses a
   *  query that reaches below its pruned height), so a node that can't serve the page is
   *  skipped. Load-balanced endpoints can answer pages from different nodes: callers drop
   *  repeats by hash. */
  async searchTxs(query: string, page: number, limit: number): Promise<{ txs: IndexedTx[]; done: boolean }> {
    const q = `query=${encodeURIComponent(query)}&page=${page}&limit=${limit}&order_by=ORDER_BY_DESC`;
    return (await this.pool.run(async (base) => {
      const { status, body } = await this.pool.json(`${base}/cosmos/tx/v1beta1/txs?${q}`);
      if (status === 200 && isObject(body) && Array.isArray(body["tx_responses"])) {
        const txs = body["tx_responses"].map(indexedTx);
        const total = typeof body["total"] === "string" && /^[0-9]+$/.test(body["total"]) ? Number(body["total"]) : null;
        return { txs, done: txs.length === 0 || (total !== null && total <= page * limit) };
      }
      const message = isObject(body) && typeof body["message"] === "string" ? body["message"] : "";
      if (/page should be within/.test(message)) return { txs: [], done: true };
      if (isObject(body) && typeof body["code"] === "number" && message && !/not available|lowest height|pruned/i.test(message)) {
        throw new ChainError(body["code"], cleanMessage(message));
      }
      throw new Down(`tx search: HTTP ${status}${message ? ` (${message.slice(0, 80)})` : ""}`);
    })) as { txs: IndexedTx[]; done: boolean };
  }

  /** The indexed transaction behind an EVM hash, or null if this node's index doesn't have
   *  it (a node indexes its own window of history). Reverted transactions emit no
   *  `ethereum_tx` event, so only ones that ran are found this way. */
  async txByEvmHash(hash: string): Promise<IndexedTx | null> {
    const h = hash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) throw new RangeError(`not an EVM hash: ${hash}`);
    const { txs } = await this.searchTxs(`ethereum_tx.ethereumTxHash='${h}'`, 1, 1);
    return txs.find((t) => t.evm?.hash === h) ?? null;
  }

  /** A transaction's result, or null while it isn't in a block (or never made it). */
  async tx(hash: string): Promise<TxStatus | null> {
    let body: unknown;
    try {
      body = await this.#call(`/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`);
    } catch (e) {
      if (e instanceof ChainError && (e.code === 5 || /not found/i.test(e.message))) return null;
      throw e;
    }
    const r = isObject(body) ? body["tx_response"] : undefined;
    if (!isObject(r) || String(r["txhash"]).toUpperCase() !== hash.toUpperCase()) {
      throw new ChainError(-1, "the node returned another transaction");
    }
    return { hash, height: toBigInt(String(r["height"])), code: Number(r["code"] ?? 0), log: cleanMessage(String(r["raw_log"] ?? "")) };
  }
}

function coin(c: unknown): Coin {
  if (!isObject(c) || typeof c["denom"] !== "string" || typeof c["amount"] !== "string" || !/^[0-9]+$/.test(c["amount"])) {
    throw new Down("malformed coin");
  }
  return { denom: c["denom"], amount: c["amount"] };
}

function indexedTx(r: unknown): IndexedTx {
  const tx = isObject(r) && isObject(r["tx"]) ? r["tx"] : {};
  const body = isObject(tx["body"]) ? tx["body"] : {};
  const fee = isObject(tx["auth_info"]) && isObject(tx["auth_info"]["fee"]) ? tx["auth_info"]["fee"]["amount"] : undefined;
  if (
    !isObject(r) ||
    typeof r["txhash"] !== "string" ||
    !/^[0-9A-Fa-f]{64}$/.test(r["txhash"]) ||
    typeof r["timestamp"] !== "string" ||
    !Array.isArray(body["messages"]) ||
    !Array.isArray(r["events"])
  ) {
    throw new Down("malformed tx");
  }
  const events = parseEvents(r["events"]);
  const messages = body["messages"].filter(isObject);
  const code = Number(r["code"] ?? 0);
  const out: IndexedTx = {
    hash: r["txhash"].toUpperCase(),
    height: toBigInt(String(r["height"])),
    time: r["timestamp"],
    code,
    messages,
    fee: Array.isArray(fee) ? fee.map(coin) : [],
    events,
  };
  if (messages.length === 1 && messages[0]!["@type"] === EVM_MSG) {
    const result = code === 0 && typeof r["data"] === "string" ? evmResults(r["data"])[0] : undefined;
    const announced = events.find((e) => e.type === "ethereum_tx")?.attributes.find((a) => a.key === "ethereumTxHash")?.value.toLowerCase();
    const hash = result?.hash ?? (announced && /^0x[0-9a-f]{64}$/.test(announced) ? announced : null) ?? failedEvmHash(String(r["raw_log"] ?? ""));
    out.evm = { hash, logs: result?.logs ?? [] };
  }
  return out;
}

function parseEvents(list: unknown[]): TxEvent[] {
  return list.map((e) => {
    if (!isObject(e) || typeof e["type"] !== "string" || !Array.isArray(e["attributes"])) throw new Down("malformed event");
    return {
      type: e["type"],
      attributes: e["attributes"].filter(isObject).map((a) => ({ key: String(a["key"] ?? ""), value: String(a["value"] ?? "") })),
    };
  });
}

/** Drop the node's source locations and gas trailer from an error message. */
export function cleanMessage(m: string): string {
  return m
    .replace(/\s*\[[^\]]*\.go:\d+\]/g, "")
    .replace(/\s*With gas wanted:.*$/s, "")
    .trim();
}
