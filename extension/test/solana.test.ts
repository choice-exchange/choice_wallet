// Solana through the service: the account's SOL and USDC (from an endpoint that won't list
// tokens, as the free mainnet one won't), sends built with injective-usdc-bridge's Solana
// toolkit and read and signed by the real WASM vault, a fake node that checks every
// signature, and history.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, code, INJ, ME_SOL, ME_SOL_USDC, ok, SOLANA_MAINNET, SOL_USDC, THEM_SOL, THEM_SOL_USDC, wallet } from "./fake";

type Review = {
  digest: string;
  display: { kind: string; signer: string; fee: { total: string }; instructions: Record<string, unknown>[] };
  risk: { level: string; findings: { rule: string; message: string }[] };
  tokens: Record<string, { symbol: string; chain?: string }>;
};
type Holdings = { address: string; balances: { denom: string; symbol: string; amount: string; chain?: string; known: boolean }[]; down?: true };

test("the account's Solana side: its address (Phantom's for the phrase), SOL and USDC", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  const b = ok<{ balances: unknown[]; solana?: Holdings }>(await service.handle({ type: "balances" }));
  assert.equal(b.solana?.address, ME_SOL);
  assert.deepEqual(
    b.solana?.balances.map((x) => [x.denom, x.symbol, x.amount, x.chain]),
    [
      ["sol", "SOL", "2000000000", SOLANA_MAINNET],
      [`spl:${SOL_USDC}`, "USDC", "5000000", SOLANA_MAINNET],
    ],
  );
  // The cluster down: Injective's side still stands.
  net.state.solana.down = true;
  const down = ok<{ balances: unknown[]; solana?: Holdings }>(await service.handle({ type: "balances" }));
  assert.ok(down.solana?.down && down.balances.length > 0);
});

test("SOL to another wallet: built, read by the vault, signed, sent, followed until it lands", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  const r = ok<Review>(await service.handle({ type: "prepare_send", denom: "sol", to: THEM_SOL, amount: "250000000" }));
  assert.equal(r.display.kind, "solana_transaction");
  assert.equal(r.display.signer, ME_SOL);
  const send = r.display.instructions.find((i) => i["type"] === "sol_transfer")!;
  assert.deepEqual([send["to"], send["lamports"]], [THEM_SOL, "250000000"]);
  // A compute limit from the simulation and a priority fee from recent fees, both shown.
  assert.ok(r.display.instructions.some((i) => i["type"] === "compute_budget" && i["unit_limit"] === 37_000));
  assert.ok(BigInt(r.display.fee.total) > 5_000n);
  assert.notEqual(r.risk.level, "red");
  const sent = ok<{ hash: string; explorer: string; chain: string }>(await service.handle({ type: "confirm_send", digest: r.digest }));
  assert.equal(sent.chain, SOLANA_MAINNET);
  assert.equal(sent.explorer, `https://explorer.solana.com/tx/${sent.hash}`);
  assert.equal(net.state.solana.sent.length, 1);
  // Not landed yet: each check sends it again, until its blockhash expires.
  net.state.solana.landed[sent.hash] = false;
  assert.equal(ok<{ state: string }>(await service.handle({ type: "tx_status", hash: sent.hash, chain: SOLANA_MAINNET })).state, "pending");
  assert.equal(net.state.solana.sent.length, 2);
  net.state.solana.height += 1_000;
  const gone = ok<{ state: string; log?: string }>(await service.handle({ type: "tx_status", hash: sent.hash, chain: SOLANA_MAINNET }));
  assert.equal(gone.state, "failed");
  assert.match(gone.log ?? "", /expired/);
  // One that landed.
  const again = ok<Review>(await service.handle({ type: "prepare_send", denom: "sol", to: THEM_SOL, amount: "1000" }));
  const s2 = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: again.digest }));
  assert.equal(ok<{ state: string }>(await service.handle({ type: "tx_status", hash: s2.hash, chain: SOLANA_MAINNET })).state, "success");
});

test("USDC to another wallet: its account opened if need be, the recipient named, not its account", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  const r = ok<Review>(await service.handle({ type: "prepare_send", denom: `spl:${SOL_USDC}`, to: THEM_SOL, amount: "1500000" }));
  const open = r.display.instructions.find((i) => i["type"] === "create_token_account")!;
  assert.deepEqual([open["owner"], open["account"], open["idempotent"]], [THEM_SOL, THEM_SOL_USDC, true]);
  const move = r.display.instructions.find((i) => i["type"] === "token_transfer")!;
  assert.deepEqual([move["source"], move["destination"], move["destination_owner"], move["amount"], move["usdc"]], [ME_SOL_USDC, THEM_SOL_USDC, THEM_SOL, "1500000", true]);
  assert.ok(!r.risk.findings.some((f) => f.rule === "solana_token_account_unknown"), JSON.stringify(r.risk));
  ok(await service.handle({ type: "confirm_send", digest: r.digest }));
  assert.equal(net.state.solana.sent.length, 1);
  // Not to a token account itself, and only what's held.
  assert.equal(code(await service.handle({ type: "prepare_send", denom: `spl:${SOL_USDC}`, to: THEM_SOL_USDC, amount: "1" })), "invalid_address");
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "sol", to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", amount: "1" })), "invalid_address");
  net.state.solana.simulateErr = { InstructionError: [1, { Custom: 1 }] };
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "sol", to: THEM_SOL, amount: "1" })), "reverts");
});

test("history: what this account's Solana transactions did", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  net.state.solana.history.push({
    signature: "5".repeat(88),
    slot: 400_000_000,
    tx: {
      slot: 400_000_000,
      blockTime: 1_794_249_151,
      meta: { err: null, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [989_995_000, 10_000_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: {
        signatures: ["5".repeat(88)],
        message: {
          accountKeys: [
            { pubkey: ME_SOL, signer: true },
            { pubkey: THEM_SOL, signer: false },
          ],
          instructions: [{ program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: ME_SOL, destination: THEM_SOL, lamports: 10_000_000 } } }],
        },
      },
    },
  });
  const h = ok<{ items: { kind: string; counterparty?: string; changes: { denom: string; amount: string }[]; chain?: string }[]; next: string | null }>(
    await service.handle({ type: "solana_activity" }),
  );
  assert.equal(h.items.length, 1);
  assert.deepEqual([h.items[0]!.kind, h.items[0]!.counterparty, h.items[0]!.chain], ["send", THEM_SOL, SOLANA_MAINNET]);
  assert.deepEqual(h.items[0]!.changes, [{ denom: "sol", amount: "-10000000" }]);
  assert.equal(h.next, null);
});

test("the chain Home shows, and the test networks, picked without touching endpoints", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  type S = { chain: string; network: string };
  assert.equal(ok<S>(await service.handle({ type: "status" })).chain, "injective");
  const picked = ok<S>(await service.handle({ type: "pick_chain", chain: "solana" }));
  assert.deepEqual([picked.chain, picked.network], ["solana", "mainnet"]);
  ok(await service.handle({ type: "save_settings", network: "mainnet", lcd: ["https://my-lcd.example"] }));
  const test = ok<S>(await service.handle({ type: "pick_chain", chain: "solana", network: "testnet" }));
  assert.deepEqual([test.chain, test.network], ["solana", "testnet"]);
  ok(await service.handle({ type: "pick_chain", chain: "injective", network: "mainnet" }));
  assert.deepEqual(ok<{ lcd: { mainnet: string[] } }>(await service.handle({ type: "settings" })).lcd.mainnet, ["https://my-lcd.example"]);
  assert.equal(code(await service.handle({ type: "pick_chain", chain: "ethereum" })), "bad_request");
  assert.equal(code(await service.handle({ type: "pick_chain", chain: "solana", network: "devnet" })), "bad_request");
});
