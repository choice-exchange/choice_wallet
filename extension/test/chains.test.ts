// The wallet's own copy of the chain list (chain/src/chains.ts) against injective-usdc-bridge's
// registry, which the bridge's flows use: the same chains, IDs, USDC and endpoints.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAINS, chainByCaip2, chainByKey, chainDenom, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import { chains as registry } from "injective-usdc-bridge";

import { chain, code, INJ, ME_EVM, ok, wallet } from "./fake";

type Review = { digest: string; display: { chain: string }; tokens: Record<string, { symbol: string }> };

test("the chain list is the bridge registry's, with Injective and Solana first", () => {
  for (const network of ["mainnet", "testnet"] as NetworkId[]) {
    const ours = CHAINS[network];
    assert.equal(ours[0]?.key, "injective");
    assert.equal(ours[1]?.key, "solana");
    const theirs = registry(network);
    // The package lists Solana only on mainnet; the wallet has devnet beside testnet.
    const expected = theirs.filter((c) => c.kind === "evm" || network === "mainnet");
    assert.deepEqual(new Set(ours.filter((c) => c.kind !== "solana" || network === "mainnet").map((c) => c.key)), new Set(expected.map((c) => c.key)));
    for (const c of ours) {
      const r = theirs.find((x) => x.key === c.key);
      if (c.kind === "solana") {
        assert.equal(c.caip2, NETWORKS[network].solana.caip2);
        if (r && r.kind === "solana") assert.equal(c.usdc, r.usdcMint);
        continue;
      }
      assert.ok(r && r.kind === "evm", c.key);
      assert.equal(c.chainId, r.chainId, c.key);
      assert.equal(c.caip2, `eip155:${r.chainId}`, c.key);
      assert.equal(c.domain, r.domain, c.key);
      assert.equal(c.usdc, r.usdc, c.key);
      assert.equal(c.native.symbol, r.nativeSymbol, c.key);
      assert.equal(c.forwarding, r.forwarding, c.key);
      assert.equal(c.fast, r.fastSource, c.key);
      assert.equal(c.gasIsUsdc === true, r.gasIsUsdc === true, c.key);
      // Injective's own endpoints are the wallet's (NETWORKS); the rest are the registry's.
      if (c.kind === "evm") {
        assert.deepEqual([...c.rpc], [...r.rpcUrls], c.key);
        assert.equal(c.explorerTx, r.explorerTx, c.key);
      }
      assert.equal(chainByKey(network, c.key), c);
      assert.equal(chainByCaip2(network, c.caip2), c);
    }
  }
  assert.equal(chainByCaip2("mainnet", "cosmos:injective-1")?.key, "injective");
  assert.equal(chainByKey("testnet", "polygon"), undefined);
  assert.deepEqual(chainDenom("usdc:eip155:8453"), { caip2: "eip155:8453", what: "usdc" });
  assert.equal(chainDenom("erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a"), null);
});

test("each EVM chain beside Injective: the account's coin and USDC, priced by DefiLlama", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.eth = 2n * 10n ** 17n;
  net.state.base.usdc = 12_500_000n;
  const { service } = await wallet(net);
  type H = { chain: string; address: string; balances: { denom: string; symbol: string; amount: string; chain?: string; priceUsd?: string; usd?: number }[]; down?: true };
  const b = ok<{ chains?: H[] }>(await service.handle({ type: "balances" }));
  const base = b.chains?.find((h) => h.chain === "base");
  assert.equal(base?.address, ME_EVM);
  assert.deepEqual(
    base?.balances.map((x) => [x.denom, x.symbol, x.amount, x.chain, x.priceUsd]),
    [
      ["native:eip155:8453", "ETH", (2n * 10n ** 17n).toString(), "eip155:8453", "3000"],
      ["usdc:eip155:8453", "USDC", "12500000", "eip155:8453", "0.9998"],
    ],
  );
  assert.equal(base?.balances[0]?.usd, 600);
  // Every mainnet EVM chain is listed; the ones whose endpoints the fake has down say so.
  assert.equal(b.chains?.length, CHAINS.mainnet.filter((c) => c.kind === "evm").length);
  assert.ok(b.chains?.find((h) => h.chain === "arbitrum")?.down);
  // Arc's coin is its USDC: only the token is listed.
  assert.deepEqual(b.chains?.find((h) => h.chain === "arc")?.balances.map((x) => x.denom), ["usdc:eip155:5042"]);
  // DefiLlama was asked one fixed list: every chain's coin and USDC, nothing about the account.
  const asked = net.state.priceAsks.find((u) => u.includes("coins.llama.fi"))!;
  assert.ok(asked.includes(`base:${CHAINS.mainnet.find((c) => c.key === "base")!.usdc}`));
  assert.ok(!asked.toLowerCase().includes(ME_EVM.slice(2).toLowerCase()));
});

test("a send on Base: ETH or USDC to a 0x address, read by the vault, signed and sent there", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.eth = 10n ** 17n;
  net.state.base.usdc = 30_000_000n;
  const { service } = await wallet(net);
  const them = "0x2222222222222222222222222222222222222222";
  // USDC: an ERC20 transfer on Base, shown as Base's USDC.
  net.state.base.allowance = 0n;
  const r = ok<Review>(await service.handle({ type: "prepare_send", denom: "usdc:eip155:8453", to: them, amount: "5000000" }));
  assert.equal(r.display.chain, "eip155:8453");
  assert.deepEqual((r.display as unknown as { call: unknown }).call, { type: "erc20_transfer", to: them, amount: "5000000" });
  assert.equal(r.tokens["usdc:eip155:8453"]?.symbol, "USDC");
  const sent = ok<{ hash: string; chain?: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: r.digest }));
  assert.equal(sent.chain, "base");
  assert.equal(net.state.base.sent.length, 1);
  assert.deepEqual(ok(await service.handle({ type: "tx_status", hash: sent.hash, chain: "base" })), { state: "success" });
  // ETH, all of it: what's left after the fee.
  const all = ok<Review>(await service.handle({ type: "prepare_send", denom: "native:eip155:8453", to: them, amount: "max" }));
  const value = BigInt((all.display as unknown as { value: string }).value);
  assert.ok(value > 0n && value < 10n ** 17n);
  // Refused: not a 0x address there, more than held, a chain not on the list.
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "usdc:eip155:8453", to: "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz", amount: "1" })), "invalid_address");
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "usdc:eip155:8453", to: them, amount: "99000000" })), "insufficient");
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "usdc:eip155:56", to: them, amount: "1" })), "bad_request");
});

test("history on Base: what the wallet sent, and what an index finds, each read from the chain", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.usdc = 30_000_000n;
  const { service } = await wallet(net);
  type Item = { hash: string; kind: string; signed: boolean; changes: { denom: string; amount: string }[]; counterparty?: string; chain?: string };
  type Page = { items: Item[]; tokens: Record<string, { symbol: string; known: boolean }>; next: number | null; indexed: boolean };
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const log = (token: string, from: string, to: string, amount: bigint) => ({
    address: token.toLowerCase(),
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(from), pad(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  });
  // No index for Base by default: only what the wallet sent there.
  let page = ok<Page>(await service.handle({ type: "chain_activity", chain: "base" }));
  assert.deepEqual([page.items, page.indexed], [[], false]);
  const them = "0x2222222222222222222222222222222222222222";
  const r = ok<Review>(await service.handle({ type: "prepare_send", denom: "usdc:eip155:8453", to: them, amount: "5000000" }));
  const sent = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: r.digest }));
  // Base, asked about it, says what it did.
  net.state.base.txs[sent.hash] = { from: ME_EVM, to: BASE_USDC, value: 0n, input: "0xa9059cbb", logs: [log(BASE_USDC, ME_EVM, them, 5_000_000n)], block: 0x1000n };
  page = ok<Page>(await service.handle({ type: "chain_activity", chain: "base" }));
  assert.deepEqual(
    page.items.map((i) => [i.hash, i.kind, i.signed, i.changes, i.counterparty, i.chain]),
    [[sent.hash, "send", true, [{ denom: "usdc:eip155:8453", amount: "-5000000" }], them, "eip155:8453"]],
  );
  assert.equal(page.tokens["usdc:eip155:8453"]?.symbol, "USDC");

  // An index, set in Settings: an incoming USDC transfer it finds is read from Base; one of
  // a token nobody listed, from a stranger, is left out; a hash Base doesn't know is too.
  ok(await service.handle({ type: "save_settings", network: "mainnet", chain: { key: "base", index: ["https://base-index.example"] } }));
  const usdcIn = `0x${"a1".repeat(32)}`;
  const spam = `0x${"a2".repeat(32)}`;
  const ghost = `0x${"a3".repeat(32)}`;
  net.state.base.txs[usdcIn] = { from: them, to: BASE_USDC, value: 0n, input: "0xa9059cbb", logs: [log(BASE_USDC, them, ME_EVM, 7_000_000n)], block: 0x2000n };
  net.state.base.txs[spam] = { from: them, to: "0x3333333333333333333333333333333333333333", value: 0n, input: "0x", logs: [log("0x3333333333333333333333333333333333333333", them, ME_EVM, 1n)], block: 0x2001n };
  net.state.base.index = { txs: [], transfers: [spam, usdcIn, ghost] };
  page = ok<Page>(await service.handle({ type: "chain_activity", chain: "base" }));
  assert.equal(page.indexed, true);
  assert.deepEqual(
    page.items.map((i) => [i.hash, i.kind, i.changes]),
    [
      [usdcIn, "receive", [{ denom: "usdc:eip155:8453", amount: "7000000" }]],
      [sent.hash, "send", [{ denom: "usdc:eip155:8453", amount: "-5000000" }]],
    ],
  );
  // Off again: an empty list.
  ok(await service.handle({ type: "save_settings", network: "mainnet", chain: { key: "base", index: [] } }));
  assert.equal(ok<Page>(await service.handle({ type: "chain_activity", chain: "base" })).indexed, false);
  assert.equal(code(await service.handle({ type: "chain_activity", chain: "solana" })), "bad_request");
});
