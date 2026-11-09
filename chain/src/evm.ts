// Injective EVM JSON-RPC client: what the wallet needs to see EVM-only tokens (ERC20s with
// no bank denom), and later to send on the EVM side. Same rules as the LCD client: several
// user-settable endpoints, each checked to serve the expected chain (`eth_chainId`)
// before use, and a JSON-RPC error is the chain's answer while anything else moves on.
//
// Checked 2026-11-09 on both networks' defaults: CORS open to extension origins, batch
// requests answered in one round trip, Multicall3 deployed.

import type { Network } from "./networks.ts";
import { ChainError, Down, isObject, Pool, type Fetch } from "./pool.ts";
import { cleanText } from "./tokens.ts";

/** JSON-RPC codes that mean the node, not the request, is the problem. */
const NODE_TROUBLE = new Set([-32005 /* limit exceeded */, -32603 /* internal */]);
/** Calls per batch request; public nodes cap batch sizes. */
const BATCH = 20;

export interface Call {
  method: string;
  params: unknown[];
}

export class EvmRpc {
  readonly network: Network;
  readonly pool: Pool;
  #id = 1;

  constructor(network: Network, urls: readonly string[], fetch: Fetch, timeoutMs?: number) {
    this.network = network;
    this.pool = new Pool(urls, {
      fetch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      identify: async (base) => {
        const served = await this.#send(base, { method: "eth_chainId", params: [] });
        if (typeof served !== "string" || BigInt(served) !== BigInt(network.evmChainId)) {
          throw new Down(`serves chain ${String(served)}, not ${network.evmChainId}`);
        }
      },
    });
  }

  /** One request to one endpoint. */
  async #send(base: string, call: Call): Promise<unknown> {
    const { status, body } = await this.pool.json(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, ...call }),
    });
    return answer(status, body);
  }

  /** One call, on whichever endpoint answers. */
  call(method: string, params: unknown[] = []): Promise<unknown> {
    return this.pool.run((base) => this.#send(base, { method, params }));
  }

  /** Several calls in batch requests, all on one endpoint. Each result is the call's value,
   *  or a `ChainError` for a call the chain refused (a revert, say): one bad call doesn't
   *  sink the others. */
  async batch(calls: readonly Call[]): Promise<(unknown | ChainError)[]> {
    return (await this.pool.run(async (base) => {
      const out: (unknown | ChainError)[] = [];
      for (let i = 0; i < calls.length; i += BATCH) {
        const chunk = calls.slice(i, i + BATCH).map((c) => ({ jsonrpc: "2.0", id: this.#id++, ...c }));
        const { status, body } = await this.pool.json(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk),
        });
        if (status !== 200 || !Array.isArray(body)) throw new Down(`batch: HTTP ${status}`);
        const byId = new Map(body.filter(isObject).map((r) => [r["id"], r]));
        for (const c of chunk) {
          const r = byId.get(c.id);
          if (!r) throw new Down("batch: an answer is missing");
          try {
            out.push(answer(200, r));
          } catch (e) {
            if (e instanceof ChainError) out.push(e);
            else throw e;
          }
        }
      }
      return out;
    })) as (unknown | ChainError)[];
  }

  /** `holder`'s balance of each ERC20 (base units), or null where the call failed. */
  async erc20Balances(tokens: readonly string[], holder: string): Promise<(bigint | null)[]> {
    const data = `0x70a08231${word(holder)}`; // balanceOf(address)
    const results = await this.batch(tokens.map((to) => ({ method: "eth_call", params: [{ to, data }, "latest"] })));
    return results.map((r) => (typeof r === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(r) ? BigInt(r) : null));
  }

  /** What each spender may still take of each token from `owner` (`allowance(owner,
   *  spender)`), or null where the call failed. */
  async erc20Allowances(pairs: readonly { token: string; spender: string }[], owner: string): Promise<(bigint | null)[]> {
    const results = await this.batch(pairs.map((p) => ({ method: "eth_call", params: [{ to: p.token, data: `0xdd62ed3e${word(owner)}${word(p.spender)}` }, "latest"] })));
    return results.map((r) => (typeof r === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(r) ? BigInt(r) : null));
  }

  /** What Permit2 lets `spender` take of `owner`'s `token`: the amount and when it ends
   *  (unix seconds). */
  async permit2Allowance(permit2: string, owner: string, token: string, spender: string): Promise<{ amount: bigint; expiration: number }> {
    const r = await this.call("eth_call", [{ to: permit2, data: `0x927da105${word(owner)}${word(token)}${word(spender)}` }, "latest"]);
    if (typeof r !== "string" || !/^0x[0-9a-fA-F]{192}$/.test(r)) throw new ChainError(-1, "Permit2 gave no allowance");
    return { amount: BigInt(`0x${r.slice(2, 66)}`), expiration: Number(BigInt(`0x${r.slice(66, 130)}`)) };
  }

  /** An ERC20's symbol, name and decimals, or null if it doesn't answer like one. Symbols
   *  and names are whatever the deployer chose, cleaned like bank metadata. */
  async erc20Metadata(token: string): Promise<{ symbol: string; name: string; decimals: number } | null> {
    const call = (data: string): Call => ({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    const [symbol, name, decimals] = await this.batch([call("0x95d89b41"), call("0x06fdde03"), call("0x313ce567")]);
    const d = typeof decimals === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(decimals) ? BigInt(decimals) : -1n;
    if (d < 0n || d > 36n) return null;
    const s = cleanText(abiString(symbol), 12);
    if (!s) return null;
    return { symbol: s, name: cleanText(abiString(name), 40), decimals: Number(d) };
  }
}

/** A JSON-RPC response: its result, or the chain's error. */
function answer(status: number, body: unknown): unknown {
  if (isObject(body) && "result" in body && body["result"] !== undefined) return body["result"];
  const err = isObject(body) ? body["error"] : undefined;
  if (isObject(err) && typeof err["code"] === "number" && typeof err["message"] === "string") {
    if (NODE_TROUBLE.has(err["code"])) throw new Down(`code ${err["code"]}: ${err["message"]}`);
    throw new ChainError(err["code"], err["message"].slice(0, 300));
  }
  throw new Down(`HTTP ${status}, not a JSON-RPC answer`);
}

/** A 20-byte address as a 32-byte ABI word (hex, no 0x). */
export function word(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new RangeError(`not an address: ${address}`);
  return address.slice(2).toLowerCase().padStart(64, "0");
}

/** An ABI-encoded `string` return, or a `bytes32` one (older tokens); "" if neither. */
export function abiString(r: unknown): string {
  if (typeof r !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(r)) return "";
  const hex = r.slice(2);
  const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  const utf8 = (h: string) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes(h));
    } catch {
      return "";
    }
  };
  if (hex.length === 64) return utf8(hex.replace(/(00)+$/, "")); // bytes32
  if (hex.length < 128) return "";
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
  if (offset * 2 + 64 > hex.length) return "";
  const length = Number(BigInt(`0x${hex.slice(offset * 2, offset * 2 + 64)}`));
  const start = offset * 2 + 64;
  if (length > 256 || start + length * 2 > hex.length) return "";
  return utf8(hex.slice(start, start + length * 2));
}
