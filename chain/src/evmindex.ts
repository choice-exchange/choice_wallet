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

import { ChainError, Down, isObject, Pool, type Fetch } from "./pool.ts";

export class EvmIndex {
  readonly pool: Pool;

  constructor(urls: readonly string[], fetch: Fetch, timeoutMs?: number) {
    this.pool = new Pool(urls, { fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }), identify: async () => {} });
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
}
