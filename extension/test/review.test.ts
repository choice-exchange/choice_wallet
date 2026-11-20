// Findings from an external review, kept as regression tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SignBody } from "../../ui/src/Approve";
import type { DappReview } from "../../ui/src/protocol";
import { ME, ok, PASSWORD, THEM_EVM, wallet } from "./fake";

type Reply = { result?: unknown; error?: { code: number; message: string } };

// A site that never connected gets the same answer whether the wallet is locked or not;
// otherwise it can watch the user lock, unlock and switch accounts.
test("an unconnected site can't tell locked from unlocked", async () => {
  const w = await wallet();
  const ask = () =>
    w.service.dapp("https://never-connected.example", {
      method: "eth_sendTransaction",
      params: [{ from: THEM_EVM, to: THEM_EVM, value: "0x1" }],
    }) as Promise<Reply>;

  const unlocked = await ask();
  ok(await w.service.handle({ type: "lock" }));
  const locked = await ask();
  ok(await w.service.handle({ type: "unlock", password: PASSWORD }));

  assert.equal(unlocked.error?.code, 4100);
  assert.deepEqual(locked, unlocked, "the reply reveals whether the wallet is locked");
});

/** The approval window's markup, without the raw-request section (which escapes its own). */
const windowHtml = (display: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(SignBody, {
      review: { digest: "00", risk: { level: "info", findings: [] }, display, tokens: {}, checkedBy: "" } as unknown as DappReview,
      network: "mainnet",
      typed: "",
      onTyped: () => {},
    }),
  ).replace(/<details class="raw">[\s\S]*?<\/details>/, "");

// A site's memo and EIP-712 app name are shown with right-to-left overrides and zero-width
// characters made visible, so they can't be made to read as something else.
test("hidden and right-to-left characters in a memo are made visible", () => {
  const memo = "deposit 12345‮54321​";
  const html = windowHtml({ kind: "cosmos_direct", chain: "cosmos:injective-1", signer: ME, memo, fee: { amount: [], gas_limit: "0", granter: null, payer: null }, messages: [] });
  assert.ok(!html.includes("‮") && !html.includes("​"), "raw hidden characters in the memo row");
  assert.match(html, /⟨U\+202E⟩/);
  assert.match(html, /⟨U\+200B⟩/);
});

test("hidden and right-to-left characters in an EIP-712 app name are made visible", () => {
  const html = windowHtml({ kind: "evm_typed_data", domain: { name: "Uniswap‮" }, primary_type: "Permit", message: {} });
  assert.ok(!html.includes("‮"), "raw right-to-left override in the App row");
  assert.match(html, /Uniswap⟨U\+202E⟩/);
});

// A finding quotes what a site wrote (an app name, an NFT ID); the window names any hidden
// character in it too, after the vault already has, and a contract's error text the same.
test("hidden characters in a finding or a simulation error are made visible", () => {
  const html = renderToStaticMarkup(
    createElement(SignBody, {
      review: {
        digest: "00",
        risk: { level: "info", findings: [{ rule: "typed_data", level: "info", message: "Signs a structured message for Uni‮paws.", params: {} }] },
        display: { kind: "evm_typed_data", domain: { name: "x" }, primary_type: "Mail", message: {} },
        tokens: {},
        checkedBy: "",
        simulation: { ok: false, error: "out of gas⁦ all good" },
      } as unknown as DappReview,
      network: "mainnet",
      typed: "",
      onTyped: () => {},
    }),
  ).replace(/<details class="raw">[\s\S]*?<\/details>/, "");
  assert.ok(!html.includes("‮") && !html.includes("⁦"), "raw hidden characters in the window");
  assert.match(html, /Uni⟨U\+202E⟩paws/);
  assert.match(html, /out of gas⟨U\+2066⟩ all good/);
});
