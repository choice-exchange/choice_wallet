// What a site's Solana transaction review shows, from the vault's display.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SolanaDisplay, SolanaStep } from "../src/protocol.ts";
import { shown } from "../src/review.ts";

const SIGNER = "signer";
const display = (instructions: SolanaStep[]): SolanaDisplay => ({
  kind: "solana_transaction",
  chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  signer: SIGNER,
  fee_payer: SIGNER,
  signers: [SIGNER],
  version: "legacy",
  fee: { base: "5000", priority: "0", total: "5000", unit_limit: null, unit_price: null },
  durable_nonce: false,
  lookup_tables: [],
  instructions,
});
const SYSTEM = { program: "11111111111111111111111111111111", program_name: "System" };

test("SOL out of an account derived from the signer is a send; from anyone else's, a line", () => {
  const seed = (base: string): SolanaStep => ({ ...SYSTEM, type: "transfer_with_seed", from: "derivedAccount", base, to: "them", lamports: "7" });
  assert.deepEqual(shown(display([seed(SIGNER)]), "mainnet").sends, [{ coins: [{ denom: "sol", amount: "7" }], to: "them" }]);
  const theirs = shown(display([seed("someoneElse")]), "mainnet");
  assert.deepEqual(theirs.sends, []);
  assert.equal(theirs.others.length, 1);
});

test("a plain SPL Transfer the signer authorises always shows its amount: as its source account's token, or unnamed", () => {
  const TOKEN = { program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", program_name: "Token" };
  const transfer = (source_mint: string | null): SolanaStep => ({ ...TOKEN, type: "token_transfer", source: "mySourceTokenAccount11111111111111", destination: "attackerTokenAccount1111111111111", destination_owner: null, authority: SIGNER, amount: "250000000000", mint: null, decimals: null, usdc: false, source_mint });
  const named = shown(display([transfer("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")]), "mainnet");
  assert.deepEqual(named.sends, [{ coins: [{ denom: "spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "250000000000" }], to: "attackerTokenAccount1111111111111" }]);
  const unnamed = shown(display([transfer(null)]), "mainnet");
  assert.deepEqual(unnamed.sends, []);
  assert.deepEqual(unnamed.others, ["Sends 250000000000 base units of an unnamed token from mySo…1111 to atta…1111"]);
});

test("every Solana memo is shown, in order", () => {
  const memo = (text: string): SolanaStep => ({ program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", program_name: "Memo", type: "memo", text, hex: "" });
  const v = shown(display([memo("deposit 111"), memo("deposit 222")]), "mainnet");
  assert.deepEqual(v.memos, ["deposit 111", "deposit 222"]);
});
