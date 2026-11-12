// The approval window as it renders: a site's request through the service and the real
// WASM vault (./fake.ts), then the window's SignBody rendered to text. What a user can read
// outside the collapsed "Everything the wallet decoded" block is what these tests check.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Origin, SignBody } from "../../ui/src/Approve";
import type { DappReview, NetworkId } from "../../ui/src/protocol";

import { chain, ME, ME_EVM, ok, THEM, wallet } from "./fake";

const SITE = "https://app.example";
// SHROOM's CW20 and the mainnet CW20 adapter (published contracts).
const CW = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
const DECOY_TO = "inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8";

type Reply = { result?: unknown; error?: { code: number; message: string } };

/** A wallet with `SITE` connected (both providers), and a way to open its next window. */
async function connected(net = chain()) {
  const w = await wallet(net);
  const site = (method: string, params?: unknown) => w.service.dapp(SITE, { method, params }) as Promise<Reply>;
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && w.ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.ui.opened.length > seen, "no approval window opened");
    seen = w.ui.opened.length;
    return w.ui.opened.at(-1)!;
  };
  const enabled = site("choice_enable", { chainIds: ["injective-1"] });
  ok(await w.service.handle({ type: "dapp_answer", id: await window(), approve: true }));
  await enabled;
  /** Ask, then read the review the window gets, and reject it. */
  const review = async (method: string, params: unknown) => {
    const asked = site(method, params);
    const id = await window();
    const r = ok<DappReview>(await w.service.handle({ type: "dapp_review", id }));
    ok(await w.service.handle({ type: "dapp_answer", id, approve: false }));
    await asked;
    return r;
  };
  return { ...w, site, window, review };
}

/** The window's text, without the collapsed raw decode. */
function windowText(review: DappReview, network: NetworkId = "mainnet"): string {
  const html = renderToStaticMarkup(createElement(SignBody, { review, network, typed: "", onTyped: () => {} }));
  return html
    .replace(/<details class="raw">[\s\S]*?<\/details>/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const amino = (msgs: unknown[]) => ({
  account_number: "12345",
  chain_id: "injective-1",
  fee: { amount: [{ amount: "160000000000000", denom: "inj" }], gas: "200000" },
  memo: "",
  msgs,
  sequence: "3",
});
const bankSend = (to: string, amount: string) => ({ type: "cosmos-sdk/MsgSend", value: { amount: [{ amount, denom: "inj" }], from_address: ME, to_address: to } });
const execute = (contract: string, msg: unknown, funds: { amount: string; denom: string }[]) => ({
  type: "wasm/MsgExecuteContract",
  value: { contract, funds, msg, sender: ME },
});

// F3: a send card stood for every CW20 transfer and redeem-shaped call in the request, so a
// decoy send hid them. Every message without its own card is shown in full.
test("a decoy send card hides no other message", async () => {
  const { review } = await connected();
  const hidden = [
    execute(CW, { transfer: { amount: "999999999", recipient: THEM } }, [{ amount: "1", denom: "inj" }]),
    execute(THEM, { redeem_and_transfer: {} }, [{ amount: "40000000000000000000", denom: "inj" }]),
  ];
  for (const decoy of [bankSend(DECOY_TO, "1000000000000000"), bankSend(ME, "1")]) {
    const r = await review("choice_signAmino", { chainId: "injective-1", signer: ME, signDoc: amino([decoy, ...hidden]) });
    const text = windowText(r);
    assert.match(text, /You send/);
    assert.equal(text.match(/Contract call/g)?.length, 2, text);
    assert.match(text, /999999999/);
    assert.ok(text.includes(THEM), text);
    assert.match(text, /Attaches 40000000000000000000 /);
    // The redeem-shaped call at a contract the wallet doesn't know is a new contract.
    assert.ok(r.risk.findings.some((f) => f.rule === "new_contract" && (f.params as { contract?: string }).contract === THEM), JSON.stringify(r.risk));
  }
});

// F6: a redeem at the adapter that pays someone else read as the user's own conversion.
test("a conversion that pays someone else names them", async () => {
  const { review } = await connected();
  const bank = `factory/${ADAPTER}/${CW}`;
  const redeem = (recipient: string) => amino([execute(ADAPTER, { redeem_and_transfer: { recipient } }, [{ amount: "5000000", denom: bank }])]);
  const other = await review("choice_signAmino", { chainId: "injective-1", signer: ME, signDoc: redeem(THEM) });
  assert.ok(other.risk.findings.some((f) => f.rule === "redeem_to_other" && f.level === "amber"), JSON.stringify(other.risk));
  const text = windowText(other);
  assert.match(text, /You convert/);
  assert.ok(text.includes(`Delivered to ${THEM}`), text);

  // To the signer: a plain conversion, and the pinned adapter is no new contract.
  const own = await review("choice_signAmino", { chainId: "injective-1", signer: ME, signDoc: redeem(ME) });
  const rules = own.risk.findings.map((f) => f.rule);
  assert.ok(!rules.includes("redeem_to_other") && !rules.includes("new_contract"), rules.join());
  assert.doesNotMatch(windowText(own), /Delivered to/);
});

/** A wallet with `SITE` connected through EIP-1193, and a review helper as above. */
async function evmConnected(net = chain()) {
  const w = await wallet(net);
  const site = (method: string, params?: unknown) => w.service.dapp(SITE, { method, params }) as Promise<Reply>;
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && w.ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.ui.opened.length > seen, "no approval window opened");
    seen = w.ui.opened.length;
    return w.ui.opened.at(-1)!;
  };
  const asked = site("eth_requestAccounts");
  ok(await w.service.handle({ type: "dapp_answer", id: await window(), approve: true }));
  await asked;
  const review = async (method: string, params: unknown) => {
    const pending = site(method, params);
    const id = await window();
    const r = ok<DappReview>(await w.service.handle({ type: "dapp_review", id }));
    ok(await w.service.handle({ type: "dapp_answer", id, approve: false }));
    await pending;
    return r;
  };
  return { ...w, site, window, review };
}

const THEM_WORD = "0000000000000000000000009d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const ONE = "0".repeat(63) + "1";

// F4: native coin attached to a token transfer or approve was dropped from the window.
test("native coin attached to a token call is shown and named", async () => {
  const { review } = await evmConnected();
  for (const selector of ["0xa9059cbb", "0x095ea7b3"]) {
    const r = await review("eth_sendTransaction", [
      { from: ME_EVM, to: "0x1111111111111111111111111111111111111111", value: "0x1bc16d674ec80000", data: `${selector}${THEM_WORD}${ONE}` },
    ]);
    const f = r.risk.findings.find((x) => x.rule === "value_with_call");
    assert.ok(f && f.level === "amber", JSON.stringify(r.risk));
    assert.match(f.message, /Also sends 2 INJ to/);
    const text = windowText(r);
    assert.match(text, /You send 2 INJ/, text);
    assert.match(text, /0x1111111111111111111111111111111111111111/);
  }
});

// F10: the contract-call card named the value INJ on every chain.
test("a contract call's value is in the signing chain's coin", async () => {
  const { review, site } = await evmConnected();
  assert.deepEqual(await site("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), { result: null });
  const r = await review("eth_sendTransaction", [
    { from: ME_EVM, to: "0x4444444444444444444444444444444444444444", value: "0xe35fa931a0000", data: `0x095ea7b3${THEM_WORD}${"0".repeat(64)}` },
  ]);
  const text = windowText(r);
  assert.match(text, /Contract call/);
  assert.match(text, /0\.004 ETH/, text);
  assert.doesNotMatch(text, /INJ/, text);
});

// F11: the simulation list named an unlisted token by its creator's symbol alone.
test("an unlisted token in the simulation says it is unlisted, and where it lives", () => {
  const usdt = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const copy = "factory/inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49/usdt";
  const review = {
    digest: "00",
    risk: { level: "info", findings: [] },
    display: { kind: "cosmos_direct", chain: "cosmos:injective-1", signer: ME, memo: "", fee: { amount: [], gas_limit: "0", granter: null, payer: null }, messages: [] },
    tokens: {
      [usdt]: { denom: usdt, symbol: "USDT", name: "Tether", decimals: 6, known: true },
      [copy]: { denom: copy, symbol: "USDT", name: "USDT", decimals: 6, known: false },
    },
    checkedBy: "",
    simulation: {
      ok: true,
      changes: [
        { denom: usdt, amount: "-100000000" },
        { denom: copy, amount: "100000000" },
      ],
    },
  } as unknown as DappReview;
  const items = windowText(review).match(/[−+]100 USDT[^−+]*/g) ?? [];
  assert.equal(items.length, 2, windowText(review));
  assert.doesNotMatch(items[0]!, /Unlisted/);
  assert.match(items[1]!, /Unlisted/);
  assert.match(items[1]!, /factory\//);
});

// F20: the window cut a long host from the end, hiding the domain someone registered.
test("the window shows a long host whole, its registered domain set apart", () => {
  const origin = "https://app.uniswap.org.secure-session-verification-portal-login.evil.example";
  const html = renderToStaticMarkup(createElement(Origin, { origin }));
  assert.equal(html.replace(/<[^>]+>/g, ""), origin.slice("https://".length));
  assert.match(html, /<span class="origin-head">app\.uniswap\.org\.[^<]*<\/span>evil\.example<\/span>$/, html);
});
