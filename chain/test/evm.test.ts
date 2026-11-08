import assert from "node:assert/strict";
import { test } from "node:test";

import { abiString, EvmRpc, word } from "../src/evm.ts";
import { NETWORKS } from "../src/networks.ts";
import { ChainError, Unreachable } from "../src/pool.ts";

const HOLDER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TOKEN = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
const BAD = "0x1111111111111111111111111111111111111111";

/** ABI-encode a string return value. */
function abiEncodeString(s: string): string {
  const hex = Buffer.from(s, "utf8").toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${(hex.length / 2).toString(16).padStart(64, "0")}${padded}`;
}

type Req = { id: number; method: string; params: unknown[] };

/** A fake JSON-RPC node: `chainId` per host, ERC20 reads for TOKEN, reverts for BAD. */
function node(chainIds: Record<string, string>, log: string[] = []) {
  return async (input: string, init?: RequestInit) => {
    const host = new URL(input).host;
    log.push(host);
    const body = JSON.parse(String(init?.body)) as Req | Req[];
    const one = (r: Req) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: chainIds[host] };
      const { to, data } = r.params[0] as { to: string; data: string };
      if (to === BAD) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
      const result =
        data.startsWith("0x70a08231") ? `0x${(1234n * 10n ** 18n).toString(16)}` : data === "0x95d89b41" ? abiEncodeString("LUMA") : data === "0x06fdde03" ? abiEncodeString("Luma ‮Token") : `0x${"12".padStart(64, "0")}`;
      return { jsonrpc: "2.0", id: r.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one).reverse() : one(body)));
  };
}

test("an endpoint serving another chain is skipped", async () => {
  const log: string[] = [];
  const rpc = new EvmRpc(NETWORKS.mainnet, ["https://testnet.example", "https://mainnet.example"], node({ "testnet.example": "0x59f", "mainnet.example": "0x6f0" }, log));
  assert.equal(await rpc.call("eth_chainId"), "0x6f0");
  assert.ok(log.includes("testnet.example"));
  assert.equal(rpc.pool.current, "https://mainnet.example");
  const none = new EvmRpc(NETWORKS.mainnet, ["https://testnet.example"], node({ "testnet.example": "0x59f" }));
  await assert.rejects(none.call("eth_blockNumber"), Unreachable);
});

test("batches keep their order even when the node answers out of order; one revert sinks only itself", async () => {
  const rpc = new EvmRpc(NETWORKS.mainnet, ["https://m.example"], node({ "m.example": "0x6f0" }));
  const out = await rpc.batch([
    { method: "eth_call", params: [{ to: TOKEN, data: `0x70a08231${word(HOLDER)}` }, "latest"] },
    { method: "eth_call", params: [{ to: BAD, data: "0x95d89b41" }, "latest"] },
    { method: "eth_call", params: [{ to: TOKEN, data: "0x313ce567" }, "latest"] },
  ]);
  assert.equal(BigInt(out[0] as string), 1234n * 10n ** 18n);
  assert.ok(out[1] instanceof ChainError);
  assert.equal(BigInt(out[2] as string), 18n);
  assert.deepEqual(await rpc.erc20Balances([TOKEN, BAD], HOLDER), [1234n * 10n ** 18n, null]);
});

test("ERC20 metadata: cleaned, and null for a contract that isn't one", async () => {
  const rpc = new EvmRpc(NETWORKS.mainnet, ["https://m.example"], node({ "m.example": "0x6f0" }));
  assert.deepEqual(await rpc.erc20Metadata(TOKEN), { symbol: "LUMA", name: "Luma Token", decimals: 18 });
  assert.equal(await rpc.erc20Metadata(BAD), null);
});

test("ABI strings: dynamic, bytes32, and junk", () => {
  assert.equal(abiString(abiEncodeString("USDC")), "USDC");
  assert.equal(abiString(abiEncodeString("")), "");
  assert.equal(abiString(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`), "MKR");
  assert.equal(abiString("0x"), "");
  assert.equal(abiString("0x1234"), "");
  assert.equal(abiString(`0x${"00".repeat(31)}20${"ff".repeat(32)}`), ""); // length past the end
  assert.equal(abiString(42), "");
  assert.equal(word(HOLDER), `000000000000000000000000${HOLDER.slice(2).toLowerCase()}`);
  assert.throws(() => word("0x123"), RangeError);
});
