// The approval window as it renders: a site's request through the service and the real
// WASM vault (./fake.ts), then the window's SignBody rendered to text. What a user can read
// outside the collapsed "Everything the wallet decoded" block is what these tests check.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SignBody } from "../../ui/src/Approve";
import type { DappReview, NetworkId } from "../../ui/src/protocol";

import { chain, ME, ok, THEM, wallet } from "./fake";

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
