// Sites talking to the wallet: what a page can see and ask, the approval each request waits
// for, and what reaches the page afterwards. Through the service worker's logic, against
// the real WASM vault and the fake mainnet (./fake.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { dappOrigin } from "../src/service";
import { callVault, chain, code, handle, INJ, ME, ME_EVM, ok, PASSWORD, PHRASE, THEM, THEM_EVM, wallet } from "./fake";

const SITE = "https://app.example";
const OTHER = "https://other.example";
type Reply = { result?: unknown; error?: { code: number; message: string } };

/** A wallet, and a page at `origin` that sends requests and gets EIP-1193 replies. */
async function setup(net = chain()) {
  const w = await wallet(net);
  const page = (origin: string) => (method: string, params?: unknown) => w.service.dapp(origin, { method, params }) as Promise<Reply>;
  /** The next approval window to open: its request, as the window reads it. */
  let seen = 0;
  const window = async () => {
    for (let i = 0; i < 200 && w.ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(w.ui.opened.length > seen, "no approval window opened");
    seen = w.ui.opened.length;
    const id = w.ui.opened.at(-1)!;
    return { id, req: ok<{ kind: string; origin: string; method?: string; to?: string }>(await w.service.handle({ type: "dapp_request", id })) };
  };
  return { ...w, page, window };
}

test("a site sees nothing until it connects, and only its own grant", async () => {
  const { service, page, window, ui } = await setup();
  const site = page(SITE);
  assert.deepEqual(await site("eth_chainId"), { result: "0x6f0" });
  assert.deepEqual(await site("net_version"), { result: "1776" });
  assert.deepEqual(await site("eth_accounts"), { result: [] });

  // Rejected in the window: the page hears 4001.
  let asked = site("eth_requestAccounts");
  let w = await window();
  assert.deepEqual([w.req.kind, w.req.origin], ["connect", SITE]);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  assert.equal((await asked).error?.code, 4001);
  assert.equal(code(await service.handle({ type: "dapp_request", id: w.id })), "not_found");

  // Closing the window rejects too.
  asked = site("eth_requestAccounts");
  w = await window();
  service.windowClosed(ui.opened.length);
  assert.equal((await asked).error?.code, 4001);

  // Approved: the account, lowercase, and from then on without asking.
  asked = site("eth_requestAccounts");
  w = await window();
  const before = ui.notified;
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true }));
  assert.deepEqual(await asked, { result: [ME_EVM.toLowerCase()] });
  assert.ok(ui.notified > before, "pages are told");
  const opened = ui.opened.length;
  assert.deepEqual(await site("eth_requestAccounts"), { result: [ME_EVM.toLowerCase()] });
  assert.equal(ui.opened.length, opened, "no window for a connected site");
  assert.deepEqual(await page(OTHER)("eth_accounts"), { result: [] });
  assert.deepEqual(ok<{ origin: string }[]>(await service.handle({ type: "connections" })).map((c) => c.origin), [SITE]);

  // Locked: no accounts for anyone. Disconnected: none again, and it must ask.
  ok(await service.handle({ type: "lock" }));
  assert.deepEqual(await site("eth_accounts"), { result: [] });
  ok(await service.handle({ type: "unlock", password: PASSWORD }));
  assert.deepEqual(await site("eth_accounts"), { result: [ME_EVM.toLowerCase()] });
  ok(await service.handle({ type: "disconnect", origin: SITE }));
  assert.deepEqual(await site("eth_accounts"), { result: [] });
});

test("requests a site can't make: unconnected signing, raw-hash signing, unknown methods, floods", async () => {
  const { page, window, service } = await setup();
  const site = page(SITE);
  assert.equal((await site("personal_sign", ["0x68656c6c6f", ME_EVM])).error?.code, 4100);
  assert.equal((await site("eth_sign", [ME_EVM, "0x" + "11".repeat(32)])).error?.code, 4200);
  assert.equal((await site("eth_coinbase")).error?.code, 4200);
  assert.deepEqual(await site("eth_blockNumber"), { result: "0xb6137d8" }); // read-only: the user's own endpoint
  // One connect at a time per site.
  const first = site("eth_requestAccounts");
  const w = await window();
  assert.equal((await site("eth_requestAccounts")).error?.code, -32002);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  await first;
  // Not a request at all.
  assert.equal(((await service.dapp(SITE, "hello")) as Reply).error?.code, -32602);
});

async function connected(net = chain()) {
  const s = await setup(net);
  const asked = s.page(SITE)("eth_requestAccounts");
  const w = await s.window();
  ok(await s.service.handle({ type: "dapp_answer", id: w.id, approve: true }));
  await asked;
  return s;
}

/** The vault's own signature for a request, to compare with what the page got. */
function vaultSigns(request: unknown): Record<string, string> {
  const v = callVault<{ vault: string; unlock_key: string }>(handle, "create_vault", { password: PASSWORD });
  assert.ok(v.ok);
  const sealed = callVault<{ secret: string }>(handle, "seal_secret", { unlock_key: v.result.unlock_key, wallet: "w", secret: { mnemonic: PHRASE } });
  assert.ok(sealed.ok);
  const d = callVault<{ digest: string }>(handle, "decode", { request });
  assert.ok(d.ok);
  const s = callVault<Record<string, string>>(handle, "sign", {
    secret: sealed.result.secret,
    wallet: "w",
    unlock_key: v.result.unlock_key,
    account: { derivation: "default", index: 0 },
    request,
    digest: d.result.digest,
  });
  assert.ok(s.ok);
  return s.result;
}

test("personal_sign: the window shows the text; the page gets the vault's signature for exactly it", async () => {
  const { page, window, service } = await connected();
  const asked = page(SITE)("personal_sign", ["0x48656c6c6f2066726f6d206120746573742e", ME_EVM]);
  const w = await window();
  assert.deepEqual([w.req.kind, w.req.method], ["sign", "evm_personal_sign"]);
  const review = ok<{ digest: string; display: { text: string } }>(await service.handle({ type: "dapp_review", id: w.id }));
  assert.equal(review.display.text, "Hello from a test.");
  // A digest that isn't the review's signs nothing.
  assert.equal(code(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: "00".repeat(32) })), "not_approved");
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  const expected = vaultSigns({ evm_personal_sign: { chain: "eip155:1776", signer: ME_EVM, message: "0x48656c6c6f2066726f6d206120746573742e" } });
  assert.deepEqual(await asked, { result: expected["signature"] });
  // Another account's address is refused before any window.
  assert.equal((await page(SITE)("personal_sign", ["0x00", THEM_EVM])).error?.code, 4100);
});

test("eth_sendTransaction: the wallet's own nonce, gas and fee; signed, broadcast, hash to the page", async () => {
  const { page, window, service, net } = await connected();
  // The page's gas price is ignored: Injective charges gas limit × max fee.
  const asked = page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, value: "0x2386f26fc10000", gasPrice: "0x174876e800" }]);
  const w = await window();
  const review = ok<{ digest: string; display: { to: string; value: string; gas_limit: string; max_fee_per_gas: string; nonce: string; call: { type: string } }; checkedBy: string }>(
    await service.handle({ type: "dapp_review", id: w.id }),
  );
  assert.deepEqual(
    [review.display.to, review.display.value, review.display.call.type, review.display.nonce, review.display.gas_limit, review.display.max_fee_per_gas],
    [THEM_EVM, (INJ / 100n).toString(), "transfer", "3", "25201", "160000000"],
  );
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  const reply = await asked;
  assert.match(String(reply.result), /^0x[0-9a-f]{64}$/);
  assert.equal(net.state.evmSent.length, 1);

  // A transaction the node says would revert never reaches a signature.
  const failing = page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, data: "0xdeadbeef" }]);
  const w2 = await window();
  assert.equal(code(await service.handle({ type: "dapp_review", id: w2.id })), "chain");
  ok(await service.handle({ type: "dapp_answer", id: w2.id, approve: false }));
  assert.equal((await failing).error?.code, 4001);
  // Someone else's from, a contract creation, another chain: refused at once.
  assert.equal((await page(SITE)("eth_sendTransaction", [{ from: THEM_EVM, to: ME_EVM }])).error?.code, 4100);
  assert.equal((await page(SITE)("eth_sendTransaction", [{ from: ME_EVM, data: "0x6080" }])).error?.code, -32602);
  assert.equal((await page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, chainId: "0x1" }])).error?.code, 4901);
});

test("switching network: only between Injective's, and only when the user agrees", async () => {
  const { page, window, service } = await connected();
  assert.equal((await page(SITE)("wallet_switchEthereumChain", [{ chainId: "0x1" }])).error?.code, 4902);
  assert.deepEqual(await page(SITE)("wallet_switchEthereumChain", [{ chainId: "0x6f0" }]), { result: null });
  const asked = page(SITE)("wallet_switchEthereumChain", [{ chainId: "0x59f" }]);
  const w = await window();
  assert.deepEqual([w.req.kind, w.req.to], ["switch", "testnet"]);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true }));
  assert.deepEqual(await asked, { result: null });
  assert.deepEqual(await page(SITE)("eth_chainId"), { result: "0x59f" });
});

test("window.choice: enable, getKey, signDirect (simulated first), sendTx", async () => {
  const { page, window, service, net } = await setup();
  const site = page(SITE);
  assert.equal((await site("choice_enable", { chainIds: ["cosmoshub-4"] })).error?.code, 4901);
  assert.equal((await site("choice_getKey", { chainId: "injective-1" })).error?.code, 4100);
  const enabled = site("choice_enable", { chainIds: ["injective-1"] });
  const w = await window();
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true }));
  assert.deepEqual(await enabled, { result: null });
  const key = (await site("choice_getKey", { chainId: "injective-1" })).result as Record<string, unknown>;
  assert.deepEqual([key["bech32Address"], key["algo"], key["ethereumHexAddress"], key["address"]], [ME, "ethsecp256k1", ME_EVM, ME_EVM.slice(2).toLowerCase()]);

  // A bank send built the way a dapp builds it (here by the vault's own builder).
  const built = callVault<{ request: { cosmos_direct: { body_bytes: string; auth_info_bytes: string; account_number: string } } }>(handle, "build_cosmos", {
    chain: "cosmos:injective-1",
    signer: key["pubKey"],
    messages: [{ type: "bank_send", to: THEM, amount: [{ denom: "inj", amount: INJ.toString() }] }],
    account_number: "1680321",
    sequence: "2",
    fee: { amount: [{ denom: "inj", amount: "16000000000000" }], gas_limit: "100000" },
  });
  assert.ok(built.ok);
  const doc = built.result.request.cosmos_direct;
  const signDoc = { bodyBytes: doc.body_bytes, authInfoBytes: doc.auth_info_bytes, chainId: "injective-1", accountNumber: "1680321" };
  assert.equal((await site("choice_signDirect", { chainId: "injective-1", signer: THEM, signDoc })).error?.code, 4100);
  assert.equal((await site("choice_signDirect", { chainId: "injective-888", signer: ME, signDoc })).error?.code, 4901);
  const asked = site("choice_signDirect", { chainId: "injective-1", signer: ME, signDoc });
  const w2 = await window();
  const review = ok<{ digest: string; simulation: { ok: boolean; changes: { denom: string; amount: string }[] }; risk: { findings: { rule: string }[] } }>(
    await service.handle({ type: "dapp_review", id: w2.id }),
  );
  // The simulation's view: 1 INJ out, the fee apart.
  assert.deepEqual(review.simulation, { ok: true, changes: [{ denom: "inj", amount: (-INJ).toString() }] });
  ok(await service.handle({ type: "dapp_answer", id: w2.id, approve: true, digest: review.digest }));
  const sig = (await asked).result as { signature: string; pub_key: { type: string; value: string } };
  const expected = vaultSigns(built.result.request);
  assert.equal(Buffer.from(sig.signature, "base64").toString("hex"), expected["signature"]);
  assert.equal(Buffer.from(sig.pub_key.value, "base64").toString("hex"), key["pubKey"]);

  // The dapp broadcasts the signed tx through the wallet.
  const sent = await site("choice_sendTx", { chainId: "injective-1", tx: expected["tx_raw"], mode: "sync" });
  assert.match(String(sent.result), /^[0-9A-F]{64}$/);
  assert.equal(net.state.broadcasts.length, 1);
});

test("only a tab's top frame, at https (or http on this machine), is a site", () => {
  const ext = "abcdefghijklmnopabcdefghijklmnop";
  const s = (o: Record<string, unknown>) => ({ id: ext, tab: {}, frameId: 0, origin: "https://app.example", url: "https://app.example/swap", ...o });
  assert.equal(dappOrigin(s({}), ext), "https://app.example");
  assert.equal(dappOrigin(s({ origin: "http://127.0.0.1:5173", url: "http://127.0.0.1:5173/" }), ext), "http://127.0.0.1:5173");
  assert.equal(dappOrigin(s({ origin: "http://app.example", url: "http://app.example/" }), ext), null);
  assert.equal(dappOrigin(s({ frameId: 2 }), ext), null);
  assert.equal(dappOrigin(s({ tab: undefined }), ext), null);
  assert.equal(dappOrigin(s({ id: "someone-else" }), ext), null);
  assert.equal(dappOrigin(s({ url: "https://evil.example/" }), ext), null);
  assert.equal(dappOrigin(s({ origin: "null" }), ext), null);
});

test("signArbitrary (ADR-036): the window shows the text; the page gets injective-ts's signature; verifyArbitrary checks it", async () => {
  const { page, window, service } = await connected();
  const site = page(SITE);
  const text = "Sign in to example.org\nNonce: 42";
  const data = Buffer.from(text).toString("hex");
  assert.equal((await site("choice_signArbitrary", { chainId: "injective-1", signer: THEM, data })).error?.code, 4100);
  const asked = site("choice_signArbitrary", { chainId: "injective-1", signer: ME, data });
  const w = await window();
  assert.deepEqual([w.req.kind, w.req.method], ["sign", "cosmos_arbitrary"]);
  const review = ok<{ digest: string; display: { text: string; signer: string }; risk: { level: string } }>(await service.handle({ type: "dapp_review", id: w.id }));
  assert.deepEqual([review.display.text, review.display.signer], [text, ME]);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  const got = (await asked).result as { pub_key: { type: string; value: string }; signature: string };
  // The same signature injective-ts makes (crates/injective/tests/vectors/adr36.json, "text").
  const expected = "8815d95c3fa82418693f4993d7f16939406b75539e1a2e8db7eb6ea114fd7f6c23280294df2e64d0c2d23d93f8a247652f463de8ecf1f";
  assert.ok(Buffer.from(got.signature, "base64").toString("hex").startsWith(expected), got.signature);
  assert.equal(got.pub_key.type, "tendermint/PubKeySecp256k1");
  assert.equal(await site("choice_verifyArbitrary", { chainId: "injective-1", signer: ME, data, signature: got }).then((r) => r.result), true);
  assert.equal(await site("choice_verifyArbitrary", { chainId: "injective-1", signer: ME, data: "00", signature: got }).then((r) => r.result), false);
});
