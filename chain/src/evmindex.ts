// Where to look for ERC20 transfers someone else made to (or from) an account. Those leave
// no trace the Cosmos tx index can be searched by: the account appears only inside the
// EVM logs. Public EVM nodes cap log searches at a few hours of blocks (10,000 on
// Injective's own, 2026-11-09), so an explorer's index is the only way to cover history.
//
// Blockscout is used as a finder only. It returns transaction hashes; the wallet then
// fetches each one from the user's own LCD endpoints and reads it like any other, so a
// wrong answer here can leave a transfer out but can't put a false one in. The account's
// address is what it learns.
//
// Its Etherscan-style API pages by number, like the tx index: page `n` of `limit`
// transfers, newest first (checked on both networks' instances, 2026-11-09).

import { ChainError, Down, isObject, Pool, Unreachable, type Fetch } from "./pool.ts";

/** `keccak256("Approval(address,address,uint256)")`: ERC20 (3 topics) and ERC721 (4). */
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** `keccak256("ApprovalForAll(address,address,bool)")`: ERC721 and ERC1155 operators. */
const APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
/** Permit2's `Approval(address,address,address,uint160,uint48)` and
 *  `Permit(address,address,address,uint160,uint48,uint48)`: owner, token, spender indexed. */
const PERMIT2_APPROVAL = "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b";
const PERMIT2_PERMIT = "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec";
/** How many pages of 1000 logs a search reads before it says it is incomplete. */
const PAGES = 5;

const ownerTopic = (owner: string) => `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
/** An indexed address topic's address, or null when its high bytes aren't zero. */
const addressTopic = (t: string | undefined) => (t && /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null);

export class EvmIndex {
  readonly pool: Pool;

  constructor(urls: readonly string[], fetch: Fetch, timeoutMs?: number) {
    this.pool = new Pool(urls, { fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }), identify: async () => {} });
  }

  /** Logs naming `owner` as their first indexed argument, `topic0` the event, `address` the
   *  emitter if given: at most PAGES pages of 1000. `complete` is false when the search stopped
   *  at that cap, since any contract can log events naming `owner`, so a full last page may
   *  hide a real one. */
  async #logs(owner: string, topic0: string, address?: string): Promise<{ logs: { address: string; topics: string[]; data: string }[]; complete: boolean }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new RangeError(`not an address: ${owner}`);
    const topic1 = ownerTopic(owner);
    const logs: { address: string; topics: string[]; data: string }[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: "0", toBlock: "latest", ...(address ? { address } : {}), topic0, topic1, topic0_1_opr: "and", page: String(page), offset: "1000" });
      const result = (await this.pool.run(async (base) => {
        const { status, body } = await this.pool.json(`${base}/api?${q}`);
        if (status !== 200 || !isObject(body)) throw new Down(`HTTP ${status}`);
        const r = body["result"];
        // Etherscan-style indexes answer "No records found" with an empty list or a message.
        if (!Array.isArray(r)) {
          if (/no (records|logs) found/i.test(String(body["message"] ?? ""))) return [];
          throw new Down(`index: ${String(body["message"] ?? "no result").slice(0, 80)}`);
        }
        return r;
      })) as unknown[];
      for (const l of result) {
        if (!isObject(l) || typeof l["address"] !== "string" || !Array.isArray(l["topics"])) continue;
        const topics = l["topics"].filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
        const emitter = l["address"].toLowerCase();
        if (topics[0] !== topic0 || topics[1] !== topic1 || !/^0x[0-9a-f]{40}$/.test(emitter)) continue;
        if (address && emitter !== address.toLowerCase()) continue;
        logs.push({ address: emitter, topics, data: typeof l["data"] === "string" ? l["data"] : "0x" });
      }
      if (result.length < 1000) return { logs, complete: true };
    }
    return { logs, complete: false };
  }

  /** Every (token, spender) `owner` ever gave an ERC20 allowance to (`Approval` with 3 topics
   *  and a 32-byte amount), and every ERC721 token it approved someone for (4 topics: the
   *  token ID is indexed). Places to look: what is left comes from the contracts themselves. */
  async approvals(owner: string): Promise<{ pairs: { token: string; spender: string }[]; nfts: { collection: string; tokenId: string }[]; complete: boolean }> {
    const { logs, complete } = await this.#logs(owner, APPROVAL);
    const pairs = new Map<string, { token: string; spender: string }>();
    const nfts = new Map<string, { collection: string; tokenId: string }>();
    for (const l of logs) {
      const spender = addressTopic(l.topics[2]);
      if (!spender) continue;
      if (l.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(l.data)) pairs.set(`${l.address} ${spender}`, { token: l.address, spender });
      else if (l.topics.length === 4 && /^0x[0-9a-f]{64}$/.test(l.topics[3]!)) {
        const tokenId = BigInt(l.topics[3]!).toString();
        nfts.set(`${l.address} ${tokenId}`, { collection: l.address, tokenId });
      }
    }
    return { pairs: [...pairs.values()], nfts: [...nfts.values()], complete };
  }

  /** Every (collection, operator) `owner` ever logged an ERC721 or ERC1155 `ApprovalForAll`
   *  for; whether each still stands comes from the collection. */
  async operators(owner: string): Promise<{ pairs: { collection: string; operator: string }[]; complete: boolean }> {
    const { logs, complete } = await this.#logs(owner, APPROVAL_FOR_ALL);
    const pairs = new Map<string, { collection: string; operator: string }>();
    for (const l of logs) {
      const operator = l.topics.length === 3 ? addressTopic(l.topics[2]) : null;
      if (operator) pairs.set(`${l.address} ${operator}`, { collection: l.address, operator });
    }
    return { pairs: [...pairs.values()], complete };
  }

  /** Every (token, spender) Permit2 at `permit2` logged an allowance for, set on chain
   *  (`Approval`) or by a signed permit (`Permit`); what is left comes from Permit2. */
  async permit2Approvals(owner: string, permit2: string): Promise<{ pairs: { token: string; spender: string }[]; complete: boolean }> {
    const pairs = new Map<string, { token: string; spender: string }>();
    let complete = true;
    for (const topic0 of [PERMIT2_APPROVAL, PERMIT2_PERMIT]) {
      const found = await this.#logs(owner, topic0, permit2);
      complete &&= found.complete;
      for (const l of found.logs) {
        const [token, spender] = [addressTopic(l.topics[2]), addressTopic(l.topics[3])];
        if (l.topics.length === 4 && token && spender) pairs.set(`${token} ${spender}`, { token, spender });
      }
    }
    return { pairs: [...pairs.values()], complete };
  }

  /** The transactions behind a page of `holder`'s ERC20 transfers, newest first, each once
   *  (at its height). `done` says no later page holds more. */
  async transfers(holder: string, page: number, limit: number): Promise<{ txs: { hash: string; height: bigint }[]; done: boolean }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(holder)) throw new RangeError(`not an address: ${holder}`);
    const q = new URLSearchParams({ module: "account", action: "tokentx", address: holder, page: String(page), offset: String(limit), sort: "desc" });
    return (await this.pool.run(async (base) => {
      const { status, body } = await this.pool.json(`${base}/api?${q}`);
      if (status !== 200 || !isObject(body)) throw new Down(`HTTP ${status}`);
      const result = body["result"];
      if (!Array.isArray(result)) {
        // "Max rate limit reached" and the like come back as a string.
        throw new Down(`index: ${String(body["message"] ?? "no result").slice(0, 80)}`);
      }
      if (body["status"] !== "1" && result.length > 0) throw new ChainError(-1, String(body["message"] ?? "index error").slice(0, 120));
      const seen = new Map<string, bigint>();
      for (const t of result.slice(0, limit)) {
        if (!isObject(t) || typeof t["hash"] !== "string" || typeof t["blockNumber"] !== "string") continue;
        const hash = t["hash"].toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^[0-9]{1,20}$/.test(t["blockNumber"])) continue;
        if (!seen.has(hash)) seen.set(hash, BigInt(t["blockNumber"]));
      }
      return { txs: [...seen].map(([hash, height]) => ({ hash, height })), done: result.length < limit };
    })) as { txs: { hash: string; height: bigint }[]; done: boolean };
  }

  /** A page of `holder`'s history on a chain with an Etherscan-style index: the hashes of
   *  its transactions (sent, and coin received) and of its token transfers, merged, newest
   *  first, each once. `done` says no later page holds more. */
  async history(holder: string, page: number, limit: number): Promise<{ hashes: string[]; done: boolean }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(holder)) throw new RangeError(`not an address: ${holder}`);
    const list = (action: string) =>
      this.pool.run(async (base) => {
        const q = new URLSearchParams({ module: "account", action, address: holder, page: String(page), offset: String(limit), sort: "desc" });
        const { status, body } = await this.pool.json(`${base}/api?${q}`);
        if (status !== 200 || !isObject(body)) throw new Down(`HTTP ${status}`);
        const result = body["result"];
        // "No transactions found" comes back as an empty list with status 0.
        if (!Array.isArray(result)) throw new Down(`index: ${String(body["message"] ?? "no result").slice(0, 80)}`);
        return result;
      }) as Promise<unknown[]>;
    const [txs, transfers] = await Promise.all([list("txlist"), list("tokentx")]);
    const seen = new Map<string, bigint>();
    for (const t of [...txs.slice(0, limit), ...transfers.slice(0, limit)]) {
      if (!isObject(t) || typeof t["hash"] !== "string" || typeof t["blockNumber"] !== "string") continue;
      const hash = t["hash"].toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^[0-9]{1,20}$/.test(t["blockNumber"])) continue;
      if (!seen.has(hash)) seen.set(hash, BigInt(t["blockNumber"]));
    }
    const hashes = [...seen].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1)).map(([h]) => h);
    return { hashes, done: txs.length < limit && transfers.length < limit };
  }

  /** ERC721 tokens Blockscout says came to `holder` (its latest `limit` NFT transfers):
   *  places to look. Whether each is still held is for `ownerOf` to say. */
  async nftTransfers(holder: string, limit = 200): Promise<{ contract: string; tokenId: string }[]> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(holder)) throw new RangeError(`not an address: ${holder}`);
    const q = new URLSearchParams({ module: "account", action: "tokennfttx", address: holder, page: "1", offset: String(limit), sort: "desc" });
    try {
      return (await this.pool.run(async (base) => {
        const { status, body } = await this.pool.json(`${base}/api?${q}`);
        if (status !== 200 || !isObject(body)) throw new Down(`HTTP ${status}`);
        const result = body["result"];
        if (!Array.isArray(result)) throw new Down(`index: ${String(body["message"] ?? "no result").slice(0, 80)}`);
        const me = holder.toLowerCase();
        const out = new Map<string, { contract: string; tokenId: string }>();
        for (const t of result.slice(0, limit)) {
          if (!isObject(t) || typeof t["contractAddress"] !== "string" || typeof t["tokenID"] !== "string" || typeof t["to"] !== "string") continue;
          if (t["to"].toLowerCase() !== me || !/^0x[0-9a-fA-F]{40}$/.test(t["contractAddress"]) || !/^[0-9]{1,78}$/.test(t["tokenID"])) continue;
          const key = `${t["contractAddress"].toLowerCase()} ${t["tokenID"]}`;
          if (!out.has(key)) out.set(key, { contract: t["contractAddress"].toLowerCase(), tokenId: t["tokenID"] });
        }
        return [...out.values()];
      })) as { contract: string; tokenId: string }[];
    } catch (e) {
      // An index that's down or rate-limited leaves the rest to show.
      if (e instanceof Down || e instanceof ChainError || e instanceof Unreachable) return [];
      throw e;
    }
  }
}
