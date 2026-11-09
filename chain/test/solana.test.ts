import assert from "node:assert/strict";
import { test } from "node:test";

import { base58ToBytes, bytesToBase58, isSolanaAddress } from "../src/encoding.ts";
import { NETWORKS } from "../src/networks.ts";
import { SOL, SolanaRpc, solanaBurn, splDenom, summarizeSolana, TOKEN_PROGRAM } from "../src/solana.ts";

// The "abandon … about" phrase's Phantom accounts 0 and 1, and Solana's USDC mint.
const ME = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const THEM = "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MY_USDC = "5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt";
const THEIR_USDC = "8X8ts1CnpZmtqApE2rREA97xEJuSRcomPGVcMFdS2cgY";
const MAINNET = NETWORKS.mainnet.solana;

test("base58 round-trips and knows a Solana address", () => {
  for (const s of [ME, USDC, "11111111111111111111111111111111"]) {
    assert.equal(base58ToBytes(s).length, 32);
    assert.equal(bytesToBase58(base58ToBytes(s)), s);
  }
  assert.equal(bytesToBase58(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  assert.ok(isSolanaAddress(ME));
  assert.ok(!isSolanaAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94"));
  assert.ok(!isSolanaAddress("inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz"));
});

type Req = { id: number; method: string; params: unknown[] };

/** A fake Solana node: the genesis hash per host, and the methods the wallet asks. */
function node(genesis: Record<string, string>, opts: { listTokens: boolean }, log: string[] = []) {
  const account = (owner: string, mint: string, amount: string) => ({
    owner: TOKEN_PROGRAM,
    data: { parsed: { type: "account", info: { mint, owner, tokenAmount: { amount, decimals: 6 } } } },
  });
  return async (input: string, init?: RequestInit) => {
    const host = new URL(input).host;
    const r = JSON.parse(String(init?.body)) as Req;
    log.push(`${host} ${r.method}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
    switch (r.method) {
      case "getGenesisHash":
        return ok(genesis[host]);
      case "getBalance":
        return ok({ context: { slot: 1 }, value: 2_500_000_000 });
      case "getTokenAccountsByOwner":
        if (!opts.listTokens) return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "Request blocked" } }));
        return ok({ context: { slot: 1 }, value: (r.params[1] as { programId: string }).programId === TOKEN_PROGRAM ? [{ pubkey: MY_USDC, account: account(ME, USDC, "1500000") }] : [] });
      case "getMultipleAccounts":
        return ok({ context: { slot: 1 }, value: (r.params[0] as string[]).map((a) => (a === MY_USDC ? account(ME, USDC, "1500000") : a === THEIR_USDC ? account(THEM, USDC, "9") : null)) });
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "no" } }));
    }
  };
}

test("an endpoint serving another cluster is skipped; SOL and tokens are read", async () => {
  const log: string[] = [];
  const fetch = node({ "devnet.example": NETWORKS.testnet.solana.genesis, "main.example": MAINNET.genesis }, { listTokens: true }, log);
  const rpc = new SolanaRpc(MAINNET, ["https://devnet.example", "https://main.example"], fetch);
  assert.equal(await rpc.balance(ME), 2_500_000_000n);
  // Reads go out while an endpoint is checked; a wrong cluster's answer is thrown away.
  assert.ok(log.includes("devnet.example getGenesisHash"));
  assert.equal(rpc.pool.current, "https://main.example");
  const tokens = await rpc.tokenAccounts(ME, () => assert.fail("listed, so no candidates"));
  assert.deepEqual(tokens, [{ address: MY_USDC, mint: USDC, owner: ME, amount: 1_500_000n, decimals: 6, program: TOKEN_PROGRAM }]);
});

test("an endpoint that won't list tokens gets the accounts they would be at", async () => {
  const rpc = new SolanaRpc(MAINNET, ["https://main.example"], node({ "main.example": MAINNET.genesis }, { listTokens: false }));
  // Someone else's account among the candidates doesn't count as this owner's.
  const tokens = await rpc.tokenAccounts(ME, () => [MY_USDC, THEIR_USDC, ME]);
  assert.deepEqual(tokens.map((t) => [t.address, t.amount]), [[MY_USDC, 1_500_000n]]);
});

/** A `jsonParsed` transaction, as `getTransaction` returns one. */
function tx(p: {
  keys: { pubkey: string; signer: boolean }[];
  instructions: unknown[];
  pre: number[];
  post: number[];
  preTokens?: unknown[];
  postTokens?: unknown[];
  fee?: number;
  err?: unknown;
}): Record<string, unknown> {
  return {
    slot: 467_000_000,
    blockTime: 1_794_249_151,
    meta: { err: p.err ?? null, fee: p.fee ?? 5000, preBalances: p.pre, postBalances: p.post, preTokenBalances: p.preTokens ?? [], postTokenBalances: p.postTokens ?? [] },
    transaction: { signatures: ["5sig"], message: { accountKeys: p.keys, instructions: p.instructions } },
  };
}

const usdcBalance = (index: number, owner: string, amount: string) => ({ accountIndex: index, mint: USDC, owner, programId: TOKEN_PROGRAM, uiTokenAmount: { amount, decimals: 6 } });

test("SOL sent: the change without the fee, and to whom", () => {
  const a = summarizeSolana(
    tx({
      keys: [{ pubkey: ME, signer: true }, { pubkey: THEM, signer: false }, { pubkey: "11111111111111111111111111111111", signer: false }],
      instructions: [{ program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: ME, destination: THEM, lamports: 10_000_000 } } }],
      pre: [1_000_000_000, 0, 1],
      post: [989_995_000, 10_000_000, 1],
    }),
    ME,
    MAINNET.caip2,
  )!;
  assert.equal(a.kind, "send");
  assert.equal(a.counterparty, THEM);
  assert.deepEqual(a.changes, [{ denom: SOL, amount: "-10000000" }]);
  assert.deepEqual(a.fee, [{ denom: SOL, amount: "5000" }]);
  assert.equal(a.chain, MAINNET.caip2);
  assert.ok(a.ok && a.signed);
});

test("USDC received into the owner's token account, from its sender", () => {
  const a = summarizeSolana(
    tx({
      keys: [{ pubkey: THEM, signer: true }, { pubkey: THEIR_USDC, signer: false }, { pubkey: MY_USDC, signer: false }],
      instructions: [
        { program: "spl-token", programId: TOKEN_PROGRAM, parsed: { type: "transferChecked", info: { source: THEIR_USDC, destination: MY_USDC, authority: THEM, mint: USDC } } },
      ],
      pre: [1_000_000_000, 2_039_280, 2_039_280],
      post: [999_995_000, 2_039_280, 2_039_280],
      preTokens: [usdcBalance(1, THEM, "5000000"), usdcBalance(2, ME, "0")],
      postTokens: [usdcBalance(1, THEM, "3500000"), usdcBalance(2, ME, "1500000")],
    }),
    ME,
    MAINNET.caip2,
  )!;
  assert.equal(a.kind, "receive");
  assert.equal(a.counterparty, THEM);
  assert.deepEqual(a.changes, [{ denom: splDenom(USDC), amount: "1500000" }]);
  assert.deepEqual(a.fee, []);
  assert.ok(!a.signed);
});

test("a CCTP burn reads as bridged, with its destination; a failed one says so", () => {
  // deposit_for_burn's data: 2 USDC to Injective (29), to 0x9858…da94.
  const data = new Uint8Array(96);
  data.set([215, 60, 61, 46, 114, 55, 128, 176]);
  new DataView(data.buffer).setBigUint64(8, 2_000_000n, true);
  new DataView(data.buffer).setUint32(16, 29, true);
  data.set(Buffer.from("0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94", "hex"), 20);
  const burn = { programId: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", accounts: [], data: bytesToBase58(data) };
  assert.deepEqual(solanaBurn(burn.data), { domain: 29, mintRecipient: "0x0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94" });
  const t = (err: unknown) =>
    summarizeSolana(
      tx({
        keys: [{ pubkey: ME, signer: true }, { pubkey: MY_USDC, signer: false }],
        instructions: [burn],
        pre: [1_000_000_000, 2_039_280],
        post: [996_195_160, 2_039_280],
        preTokens: [usdcBalance(1, ME, "2000000")],
        postTokens: [usdcBalance(1, ME, "0")],
        fee: 10_000,
        err,
      }),
      ME,
      MAINNET.caip2,
    )!;
  const a = t(null);
  assert.equal(a.kind, "bridge");
  assert.deepEqual(a.bridge, { domain: 29, mintRecipient: "0x0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94" });
  // The USDC burned, and the rent its record locks (the fee apart).
  assert.deepEqual(a.changes, [{ denom: SOL, amount: "-3794840" }, { denom: splDenom(USDC), amount: "-2000000" }]);
  assert.equal(t({ InstructionError: [0, "Custom"] }).ok, false);
  assert.equal(solanaBurn(bytesToBase58(new Uint8Array(40))), null);
});
