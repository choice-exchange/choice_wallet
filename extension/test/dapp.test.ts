// Sites talking to the wallet: what a page can see and ask, the approval each request waits
// for, and what reaches the page afterwards. Through the service worker's logic, against
// the real WASM vault and the fake mainnet (./fake.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { dappOrigin } from "../src/host/service";
import { ed25519 } from "@noble/curves/ed25519";

import { base58Decode, bs58, callVault, chain, code, handle, INJ, ME, ME_EVM, ME_SOL, ME_SOL_USDC, ok, PASSWORD, PHRASE, SOL_USDC, solTransfer, THEM, THEM_EVM, THEM_SOL, wallet } from "./fake";

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

  // Locked: no accounts for anyone, and one answer to any signature request, whichever
  // address it names (no guessing the account). Disconnected: none again, and it must ask.
  ok(await service.handle({ type: "lock" }));
  assert.deepEqual(await site("eth_accounts"), { result: [] });
  const opened2 = ui.opened.length;
  const right = await site("personal_sign", ["0x6869", ME_EVM]);
  const wrong = await site("personal_sign", ["0x6869", THEM_EVM]);
  assert.equal(right.error?.code, 4100);
  assert.deepEqual(right, wrong);
  const amino = { chain_id: "injective-1", account_number: "1", sequence: "0", fee: { amount: [], gas: "1" }, msgs: [], memo: "" };
  assert.deepEqual(await site("choice_signAmino", { chainId: "injective-1", signer: ME, signDoc: amino }), await site("choice_signAmino", { chainId: "injective-1", signer: THEM, signDoc: amino }));
  assert.equal(ui.opened.length, opened2, "no window while locked");
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

test("each site on its own EVM chain: switched freely within the network, the network only when the user agrees", async () => {
  const { page, window, service, net } = await connected();
  const site = page(SITE);
  assert.equal((await site("wallet_switchEthereumChain", [{ chainId: "0x38" }])).error?.code, 4902);
  assert.deepEqual(await site("wallet_switchEthereumChain", [{ chainId: "0x6f0" }]), { result: null });
  // Base: the site alone moves there; another site stays on Injective.
  assert.deepEqual(await site("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), { result: null });
  assert.deepEqual(await site("eth_chainId"), { result: "0x2105" });
  assert.deepEqual(await site("net_version"), { result: "8453" });
  assert.deepEqual(await page(OTHER)("eth_chainId"), { result: "0x6f0" });
  // Reads go to Base's endpoints.
  net.state.base.eth = 7n * 10n ** 15n;
  assert.deepEqual(await site("eth_getBalance", [ME_EVM, "latest"]), { result: `0x${(7n * 10n ** 15n).toString(16)}` });
  // A transaction there: Base's nonce and fees, shown as ETH on Base, sent there.
  net.state.base.usdc = 10_000_000n;
  const asked = site("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, value: "0x2386f26fc10000" }]);
  const w = await window();
  const review = ok<{ digest: string; display: { chain: string; network: { name: string }; call: { type: string } }; tokens: Record<string, { symbol: string }> }>(await service.handle({ type: "dapp_review", id: w.id }));
  assert.deepEqual([review.display.chain, review.display.network.name, review.display.call.type], ["eip155:8453", "Base", "transfer"]);
  assert.equal(review.tokens["native:eip155:8453"]?.symbol, "ETH");
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  assert.match(String((await asked).result), /^0x[0-9a-f]{64}$/);
  assert.equal(net.state.base.sent.length, 1);
  assert.equal(net.state.evmSent.length, 0);
  // Its transaction's chain ID must be Base's now.
  assert.equal((await site("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, chainId: "0x6f0" }])).error?.code, 4901);
  // The test networks: the whole wallet moves, so the user is asked.
  const moved = site("wallet_switchEthereumChain", [{ chainId: "0x14a34" }]);
  const sw = await window();
  assert.deepEqual([sw.req.kind, sw.req.to, (sw.req as { toChain?: string }).toChain], ["switch", "testnet", "base"]);
  ok(await service.handle({ type: "dapp_answer", id: sw.id, approve: true }));
  assert.deepEqual(await moved, { result: null });
  assert.deepEqual(await site("eth_chainId"), { result: "0x14a34" });
  assert.deepEqual(await page(OTHER)("eth_chainId"), { result: "0x59f" });
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

// F2: a program the vault can't read can hand a token account, a delegate over it, or the
// account itself to someone else. The simulation shows it, and the rules grade it as they
// grade the instruction that does it directly.
test("a Solana simulation that hands control away is red, whatever program does it", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  // One instruction of an unread program over the account and its USDC account.
  const program = bs58(new Uint8Array(32).fill(0x42));
  const keys = [ME_SOL, ME_SOL_USDC, program].map(base58Decode);
  const message = Uint8Array.from([1, 0, 1, 3, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 1, 2, 2, 0, 1, 1, 7]);
  const wire = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  const usdcAfter = (edit: (d: Uint8Array, v: DataView) => void) => (a: string, r: unknown) => {
    if (a !== ME_SOL_USDC || r === null) return r;
    const acct = r as { data: [string, string] };
    const d = new Uint8Array(Buffer.from(acct.data[0], "base64"));
    edit(d, new DataView(d.buffer, d.byteOffset, d.length));
    return { ...acct, data: [Buffer.from(d).toString("base64"), "base64"] };
  };
  const cases = [
    { after: usdcAfter((d) => d.set(base58Decode(THEM_SOL), 32)), rule: "solana_token_account_owner", confirm: "GIVE" },
    {
      after: usdcAfter((d, v) => {
        v.setUint32(72, 1, true);
        d.set(base58Decode(THEM_SOL), 76);
        v.setBigUint64(121, 5_000_000n, true);
      }),
      rule: "solana_unlimited_delegate",
      confirm: undefined,
    },
    { after: (a: string, r: unknown) => (a === ME_SOL && r ? { ...(r as object), owner: program } : r), rule: "solana_assign", confirm: "GIVE" },
  ];
  net.state.solana.simulateSpend = 5_000n;
  for (const c of cases) {
    net.state.solana.simulateAfter = c.after;
    const signing = site("solana_signTransaction", { account: ME_SOL, transaction: hexOf(wire) });
    const w = await window();
    const review = ok<{ risk: { level: string; confirm?: string; findings: { rule: string }[] }; simulation: { ok: boolean; changes: { denom: string; amount: string }[] } }>(
      await service.handle({ type: "dapp_review", id: w.id }),
    );
    assert.equal(review.risk.level, "red", `${c.rule}: ${JSON.stringify(review.risk)}`);
    assert.equal(review.risk.confirm, c.confirm, c.rule);
    assert.ok(review.risk.findings.some((f) => f.rule === c.rule), `${c.rule}: ${JSON.stringify(review.risk)}`);
    if (c.rule === "solana_token_account_owner") {
      // Owned before, not after: its whole balance leaves.
      assert.ok(review.simulation.changes.some((x) => x.denom === `spl:${SOL_USDC}` && x.amount === "-5000000"), JSON.stringify(review.simulation));
    }
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    assert.equal(((await signing) as Reply).error?.code, 4001);
  }
});

// F8: only the user's own use holds off the auto-lock. A site's reads, its connect
// window's status poll, and pages re-reading after a broadcast never restart the timer.
test("sites and the approval window's poll never restart the auto-lock timer", async () => {
  const { page, window, service, ui } = await connected();
  const site = page(SITE);
  // One grant per origin: the other providers see the account without asking again.
  assert.deepEqual(await site("choice_enable", { chainIds: ["injective-1"] }), { result: null });
  await site("solana_connect", {});
  ui.locks = [];
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await site("eth_accounts"), { result: [ME_EVM.toLowerCase()] });
    await site("wallet_getPermissions");
    await site("choice_getKey", { chainId: "injective-1" });
    await site("solana_accounts");
    await page(OTHER)("wallet_revokePermissions", [{ eth_accounts: {} }]);
    ok(await service.handle({ type: "status", poll: true }));
  }
  assert.deepEqual(ui.locks, [], "no site read or poll restarts the timer");
  // The user's own use does: the popup's status, and reviewing or answering a request.
  ok(await service.handle({ type: "status" }));
  assert.equal(ui.locks.length, 1);
  const asked = site("personal_sign", ["0x6869", ME_EVM]);
  const w = await window();
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id: w.id }));
  assert.equal(ui.locks.length, 2);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  assert.equal(ui.locks.length, 3);
  await asked;
});

// F16: a page with no grant could flood revokes, each rewriting every site's grants and
// broadcasting, and so undo the user's disconnect. A revoke of no grant does nothing.
test("a revoke from a site with no grant writes and tells nothing", async () => {
  const { page, service, local, ui } = await connected();
  const before = JSON.stringify(local.data.get("connections"));
  const notified = ui.notified;
  for (let i = 0; i < 5; i++) {
    await page(OTHER)("wallet_revokePermissions", [{ eth_accounts: {} }]);
    await page(OTHER)("solana_disconnect");
  }
  assert.equal(ui.notified, notified);
  assert.equal(JSON.stringify(local.data.get("connections")), before);
  // The connected site's own revoke, and the user's disconnect racing it, both hold.
  await Promise.all([page(SITE)("wallet_revokePermissions", [{ eth_accounts: {} }]), service.handle({ type: "disconnect", origin: SITE }), page(OTHER)("wallet_revokePermissions", [{ eth_accounts: {} }])]);
  assert.deepEqual(local.data.get("connections"), {});
  assert.equal(ui.notified, notified + 1);
});

// Hardening: two answers to one request can't both sign, and locking rejects what waits.
test("one request, one signature: concurrent approvals sign once; locking rejects what waits", async () => {
  const { page, window, service, net } = await connected();
  const site = page(SITE);
  const asked = site("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, value: "0x1" }]);
  const w = await window();
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id: w.id }));
  const answers = await Promise.all([1, 2].map(() => service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest })));
  assert.equal(answers.filter((a) => (a as { ok: boolean }).ok).length, 1, JSON.stringify(answers));
  assert.match(String((await asked).result), /^0x[0-9a-f]{64}$/);
  assert.equal(net.state.evmSent.length, 1);

  // A request still waiting when the wallet locks is rejected, not answered later.
  const waiting = site("personal_sign", ["0x6869", ME_EVM]);
  await window();
  ok(await service.handle({ type: "lock" }));
  assert.equal((await waiting).error?.code, 4001);
});

// F15: the account the site named signs, or nobody: a switch before the review is refused.
test("only the account a site named answers its signature request", async () => {
  const { page, window, service } = await connected();
  ok(await service.handle({ type: "add_account" }));
  ok(await service.handle({ type: "switch_account", index: 0 }));
  const asked = page(SITE)("personal_sign", ["0x6869", ME_EVM]);
  const w = await window();
  ok(await service.handle({ type: "switch_account", index: 1 }));
  assert.equal(code(await service.handle({ type: "dapp_review", id: w.id })), "wrong_account");
  ok(await service.handle({ type: "switch_account", index: 0 }));
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id: w.id }));
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  const expected = vaultSigns({ evm_personal_sign: { chain: "eip155:1776", signer: ME_EVM, message: "0x6869" } });
  assert.deepEqual(await asked, { result: expected["signature"] });
  // No account named: refused before any window.
  assert.equal((await page(SITE)("personal_sign", ["0x6869", ""])).error?.code, 4100);
});

// F13: oversized typed data (and personal_sign messages) are refused before they reach
// the vault, so a site can't hold the worker with one.
test("oversized typed data and messages are refused before any window", async () => {
  const { page, ui } = await connected();
  const opened = ui.opened.length;
  const td = { types: { EIP712Domain: [], M: [{ name: "s", type: "string" }] }, primaryType: "M", domain: {}, message: { s: "a".repeat(200_000) } };
  assert.equal((await page(SITE)("eth_signTypedData_v4", [ME_EVM, JSON.stringify(td)])).error?.code, -32602);
  assert.equal((await page(SITE)("personal_sign", [`0x${"61".repeat(70_000)}`, ME_EVM])).error?.code, -32602);
  assert.equal(ui.opened.length, opened);
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

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("Solana sites (Wallet Standard): connect, a transfer read by the vault and simulated, signed and sent; a message", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const none = { result: { accounts: [], chains: ["solana:mainnet"] } };
  assert.deepEqual(await site("solana_accounts"), none);
  // A silent connect asks nobody.
  assert.deepEqual(await site("solana_connect", { silent: true }), none);
  const asked = site("solana_connect", {});
  const c = await window();
  assert.equal(c.req.kind, "connect");
  ok(await service.handle({ type: "dapp_answer", id: c.id, approve: true }));
  const me = { address: ME_SOL, publicKey: hexOf(base58Decode(ME_SOL)) };
  assert.deepEqual(await asked, { result: { accounts: [me], chains: ["solana:mainnet"] } });

  // The site's transfer: the vault reads it, a simulation says what it costs the account.
  const wire = solTransfer(250_000_000n);
  net.state.solana.simulateSpend = 250_005_000n;
  const sending = site("solana_signAndSendTransaction", { account: ME_SOL, chain: "solana:mainnet", transaction: hexOf(wire) });
  const s = await window();
  assert.deepEqual([s.req.kind, s.req.method], ["sign", "solana_transaction"]);
  const review = ok<{ digest: string; display: { kind: string; instructions: Record<string, unknown>[] }; simulation: unknown; tokens: Record<string, unknown> }>(
    await service.handle({ type: "dapp_review", id: s.id }),
  );
  assert.equal(review.display.kind, "solana_transaction");
  const move = review.display.instructions.find((i) => i["type"] === "sol_transfer")!;
  assert.deepEqual([move["to"], move["lamports"]], [THEM_SOL, "250000000"]);
  assert.deepEqual(review.simulation, { ok: true, changes: [{ denom: "sol", amount: "-250005000" }] });
  assert.ok(review.tokens["sol"]);
  ok(await service.handle({ type: "dapp_answer", id: s.id, approve: true, digest: review.digest }));
  const sent = (await sending) as { result: { signature: string } };
  // Sent once, its signature checked by the fake node; the page gets that signature.
  assert.equal(net.state.solana.sent.length, 1);
  assert.equal(bs58(Buffer.from(sent.result.signature, "hex")), bs58(Buffer.from(net.state.solana.sent[0]!, "base64").subarray(1, 65)));

  // Another cluster, another account, or bytes that aren't a transaction: refused.
  assert.equal((await site("solana_signTransaction", { account: ME_SOL, chain: "solana:devnet", transaction: hexOf(wire) })).error?.code, 4901);
  assert.equal((await site("solana_signTransaction", { account: THEM_SOL, transaction: hexOf(wire) })).error?.code, 4100);
  const bad = site("solana_signTransaction", { account: ME_SOL, transaction: "0102" });
  const b = await window();
  assert.equal(code(await service.handle({ type: "dapp_review", id: b.id })), "bad_request");
  ok(await service.handle({ type: "dapp_answer", id: b.id, approve: false }));
  assert.equal(((await bad) as Reply).error?.code, 4001);

  // signMessage: the vault's ed25519 signature of exactly the bytes.
  const text = new TextEncoder().encode("Sign in to app.example");
  const signing = site("solana_signMessage", { account: ME_SOL, message: hexOf(text) });
  const m = await window();
  const mr = ok<{ digest: string; display: { kind: string } }>(await service.handle({ type: "dapp_review", id: m.id }));
  assert.equal(mr.display.kind, "solana_message");
  ok(await service.handle({ type: "dapp_answer", id: m.id, approve: true, digest: mr.digest }));
  const sig = ((await signing) as { result: { signature: string } }).result.signature;
  assert.ok(ed25519.verify(Buffer.from(sig, "hex"), text, base58Decode(ME_SOL)));
});
