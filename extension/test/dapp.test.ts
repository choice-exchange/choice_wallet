// Sites talking to the wallet: what a page can see and ask, the approval each request waits
// for, and what reaches the page afterwards. Through the service worker's logic, against
// the real WASM vault and the fake mainnet (./fake.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { dappOrigin } from "../src/host/service";
import { ed25519 } from "@noble/curves/ed25519";
import type { DappReview } from "../../ui/src/protocol";
import { shown } from "../../ui/src/review";

import { BASE_USDC, base58Decode, bs58, callVault, chain, CHOICE_ROUTES, code, ERC20, exchangeDeposits, handle, INJ, ME, ME_EVM, ME_SOL, ME_SOL_USDC, ok, PASSWORD, PHRASE, SOL_USDC, solTransfer, THEM, THEM_EVM, THEM_SOL, USDT_ERC20, wallet } from "./fake";

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
  // Run-2 C8: verifyArbitrary too, whichever signer and key it names.
  const verify = (signer: string, key: string) => site("choice_verifyArbitrary", { chainId: "injective-1", signer, data: "00", signature: { pub_key: { type: "tendermint/PubKeySecp256k1", value: key }, signature: Buffer.alloc(64).toString("base64") } });
  const lockedVerify = await verify(ME, Buffer.alloc(33, 2).toString("base64"));
  assert.equal(lockedVerify.error?.code, 4100);
  for (const other of [await verify(THEM, Buffer.alloc(33, 2).toString("base64")), await verify(ME, Buffer.alloc(33, 3).toString("base64"))]) assert.deepEqual(other, lockedVerify);
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

// A connected site's requests come one window at a time: the next opens once the last is
// answered, so a site can't stack windows that each take the focus. Locking rejects them
// all and opens none.
test("a site's requests open one approval window at a time", async () => {
  const { page, window, service, ui } = await connected();
  const before = ui.opened.length;
  const asks = [0, 1, 2].map((i) => page(SITE)("personal_sign", [`0x0${i}`, ME_EVM]));
  const first = await window();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ui.opened.length, before + 1, "one window for three requests");
  ok(await service.handle({ type: "dapp_answer", id: first.id, approve: false }));
  assert.equal((await asks[0])!.error?.code, 4001);
  const second = await window();
  assert.notEqual(second.id, first.id);
  assert.equal(ui.opened.length, before + 2);
  ok(await service.handle({ type: "lock" }));
  for (const a of asks.slice(1)) assert.equal((await a).error?.code, 4001);
  assert.equal(ui.opened.length, before + 2, "no window opened by the lock");
});

// Review of #9: a request whose window can't be told apart would hold the site's queue for
// good. A window with no ID, or one closed before its ID came back, ends the request.
test("a request whose window can't be tracked ends, and the site's next one gets a window", async () => {
  const { page, service, ui } = await connected();
  ok(await service.handle({ type: "unlock", password: PASSWORD }));
  ui.noWindowId = true;
  assert.equal((await page(SITE)("personal_sign", ["0x01", ME_EVM])).error?.code, -32603);
  ui.noWindowId = false;
  // Closed before the browser said which window it was.
  service.windowClosed(ui.opened.length + 1);
  assert.equal((await page(SITE)("personal_sign", ["0x02", ME_EVM])).error?.code, 4001);
  // The queue is free: the next request gets its window.
  const before = ui.opened.length;
  void page(SITE)("personal_sign", ["0x03", ME_EVM]);
  for (let i = 0; i < 100 && ui.opened.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ui.opened.length, before + 1);
});

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

// Review of #8: a site's send to an exchange's shared deposit address got no memo check
// (the dapp review asked for facts about no recipient), and a check the endpoint couldn't
// answer passed as "not an exchange". Now both are said.
test("a site's send to an exchange is red; one whose deposits couldn't be read is amber", async () => {
  const net = chain();
  const { page, window, service } = await connected(net);
  const inj = (evm: string) => {
    const r = callVault<{ addresses: Record<string, string> }>(handle, "addresses", { address: evm });
    assert.ok(r.ok);
    return r.result.addresses["cosmos:injective-1"]!;
  };
  const EXCHANGE = "0x7777777777777777777777777777777777777777";
  const DOWN = "0x8888888888888888888888888888888888888888";
  net.state.deposits[inj(EXCHANGE)] = exchangeDeposits(inj(EXCHANGE));
  net.state.depositsDown.push(inj(DOWN));
  const review = async (to: string) => {
    const asked = page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to, value: "0x2386f26fc10000" }]);
    const w = await window();
    const r = ok<DappReview>(await service.handle({ type: "dapp_review", id: w.id }));
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    await asked;
    // Each finding but the first-visit note every new site gets.
    return r.risk.findings.filter((f) => f.rule !== "site_new").map((f) => `${f.rule} ${f.level}`);
  };
  assert.deepEqual(await review(EXCHANGE), ["memo_unsupported red"]);
  assert.deepEqual(await review(DOWN), ["memo_unchecked amber"]);
  assert.deepEqual(await review(THEM_EVM), []);
  // The failed check isn't remembered: the next review asks again.
  assert.equal(net.state.depositChecks.filter((a) => a === inj(DOWN)).length, 1);
  await review(DOWN);
  assert.equal(net.state.depositChecks.filter((a) => a === inj(DOWN)).length, 2);
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

// Run-3: a site's EVM call the wallet can't read is simulated on the user's own node, and what
// it would move is shown and weighed: the account's tokens paid to someone else is red.
test("a site's EVM transaction is simulated: what leaves the account is shown and weighed", async () => {
  const { page, window, service, net } = await connected();
  const site = page(SITE);
  assert.deepEqual(await site("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), { result: null });
  const usdc = BASE_USDC.toLowerCase();
  const router = `0x${"6f".repeat(20)}`;
  const payee = `0x${"bb".repeat(20)}`;
  const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const move = (from: string, to: string) => ({ address: usdc, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(from), topic(to)], data: `0x${(5_000_000n).toString(16).padStart(64, "0")}` });
  type Review = { digest: string; risk: { level: string; findings: { rule: string }[] }; simulation?: { ok: boolean; changes?: { denom: string; amount: string }[] } };
  const review = async (logs: ReturnType<typeof move>[] | null) => {
    net.state.base.simulate = logs;
    const asked = site("eth_sendTransaction", [{ from: ME_EVM, to: router, data: `0x3593564c${"00".repeat(32)}` }]);
    const w = await window();
    const r = ok<Review>(await service.handle({ type: "dapp_review", id: w.id }));
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    await asked;
    return r;
  };
  const rules = (r: Review) => r.risk.findings.map((f) => f.rule);
  // The router pays the account's USDC (its Permit2 allowance) to someone else.
  const drained = await review([move(ME_EVM, payee)]);
  assert.equal(drained.risk.level, "red");
  assert.ok(rules(drained).includes("simulated_loss"), rules(drained).join());
  assert.deepEqual(drained.simulation, { ok: true, changes: [{ denom: `evm:${usdc}`, amount: "-5000000" }] });
  // A swap: the chain's coin comes back. A trade the wallet can't weigh: amber, named.
  const swap = await review([move(ME_EVM, router), { ...move(router, ME_EVM), address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }]);
  assert.equal(swap.risk.level, "amber");
  assert.ok(rules(swap).includes("simulated_trade"), rules(swap).join());
  assert.ok(rules(swap).includes("contract_call_unread"));
  // Run-4: an unlisted token coming back is nothing the wallet can value. Paid to the
  // contract called: amber; to anyone else: red.
  const junk = { ...move(router, ME_EVM), address: `0x${"42".repeat(20)}` };
  const paid = await review([move(ME_EVM, router), junk]);
  assert.ok(rules(paid).includes("simulated_payment"), rules(paid).join());
  const robbed = await review([move(ME_EVM, payee), junk]);
  assert.equal(robbed.risk.level, "red");
  assert.ok(rules(robbed).includes("simulated_loss"), rules(robbed).join());
  // A node that can't simulate: no simulation, the unread call still amber.
  const blind = await review(null);
  assert.equal(blind.simulation, undefined);
  assert.equal(blind.risk.level, "amber");
});

// Hardening: two sites switching chains at once each read the map before either saved it,
// so one site's pick was lost.
test("two sites switching chains at once both keep their pick", async () => {
  const { page, window, service } = await connected();
  const asked = page(OTHER)("eth_requestAccounts");
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  await Promise.all([page(SITE)("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), page(OTHER)("wallet_switchEthereumChain", [{ chainId: "0x2105" }])]);
  assert.deepEqual(await page(SITE)("eth_chainId"), { result: "0x2105" });
  assert.deepEqual(await page(OTHER)("eth_chainId"), { result: "0x2105" });
});

// Run-2 C9: a site's chain pick is part of its grant. However the grant goes, the site is
// served as one that never connected, its pick is gone, and a reconnect starts on Injective.
test("a site's chain pick goes with its grant", async () => {
  const { page, window, service, net, local } = await connected();
  const site = page(SITE);
  net.state.base.eth = 7n * 10n ** 15n;
  const onBase = `0x${(7n * 10n ** 15n).toString(16)}`;
  const picks = () => (local.data.get("site_chains") ?? {}) as Record<string, unknown>;
  const reconnect = async () => {
    const asked = site("eth_requestAccounts");
    ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
    await asked;
  };
  const ways: [string, () => Promise<unknown>][] = [
    ["the user's disconnect", () => service.handle({ type: "disconnect", origin: SITE })],
    ["wallet_revokePermissions", () => site("wallet_revokePermissions", [{ eth_accounts: {} }])],
    ["solana_disconnect", () => site("solana_disconnect")],
  ];
  for (const [i, [how, revoke]] of ways.entries()) {
    if (i > 0) await reconnect();
    assert.deepEqual(await site("eth_chainId"), { result: "0x6f0" }, `${how}: a new grant starts on Injective`);
    assert.deepEqual(await site("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), { result: null });
    assert.deepEqual(await site("eth_getBalance", [ME_EVM, "latest"]), { result: onBase });
    await revoke();
    assert.deepEqual([await site("eth_chainId"), await site("net_version")], [{ result: "0x6f0" }, { result: "1776" }], how);
    assert.notDeepEqual(await site("eth_getBalance", [ME_EVM, "latest"]), { result: onBase }, `${how}: reads go to Injective`);
    assert.ok(!Object.hasOwn(picks(), SITE), `${how}: ${JSON.stringify(picks())}`);
  }
  // A switch racing a disconnect leaves no pick behind.
  await reconnect();
  await Promise.all([site("wallet_switchEthereumChain", [{ chainId: "0x2105" }]), service.handle({ type: "disconnect", origin: SITE })]);
  assert.ok(!Object.hasOwn(picks(), SITE), JSON.stringify(picks()));
  assert.deepEqual(await site("eth_chainId"), { result: "0x6f0" });
});

test("window.choice: enable, getKey, signDirect (simulated first), sendTx", async () => {
  const { page, window, service, net, local } = await setup();
  const site = page(SITE);
  assert.equal((await site("choice_enable", { chainIds: ["cosmoshub-4"] })).error?.code, 4901);
  assert.equal((await site("choice_getKey", { chainId: "injective-1" })).error?.code, 4100);
  const enabled = site("choice_enable", { chainIds: ["injective-1"] });
  const w = await window();
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true }));
  assert.deepEqual(await enabled, { result: null });
  const key = (await site("choice_getKey", { chainId: "injective-1" })).result as Record<string, unknown>;
  assert.deepEqual([key["bech32Address"], key["algo"], key["ethereumHexAddress"], key["address"]], [ME, "ethsecp256k1", ME_EVM, ME_EVM.slice(2).toLowerCase()]);
  // Hardening: the site gets the wallet's name, not the user's label for the account.
  ok(await service.handle({ type: "rename_account", index: 0, name: "Savings at home" }));
  const renamed = (await site("choice_getKey", { chainId: "injective-1" })).result as Record<string, unknown>;
  assert.equal(renamed["name"], "Choice Wallet");

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

  // The dapp broadcasts the signed tx through the wallet: the account's own, so followed.
  const sent = await site("choice_sendTx", { chainId: "injective-1", tx: expected["tx_raw"], mode: "sync" });
  assert.match(String(sent.result), /^[0-9A-F]{64}$/);
  assert.equal(net.state.broadcasts.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  const followed = () => ((local.data.get("watch_own") ?? []) as { hash: string }[]).map((o) => o.hash);
  assert.ok(followed().includes(String(sent.result)), "the account's own broadcast is followed");

  // F18: a transaction the site signed itself (here, with another signature) is the site's:
  // broadcast, but never followed or named as this account's.
  const theirs = expected["tx_raw"]!.replace(expected["signature"]!, "11".repeat(64));
  const other = await site("choice_sendTx", { chainId: "injective-1", tx: theirs, mode: "sync" });
  assert.match(String(other.result), /^[0-9A-F]{64}$/);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!followed().includes(String(other.result)), "a site's own broadcast isn't followed");
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

// Run-2 C2: a readable Approve of one unit, then a program that raises the same delegate's
// allowance to almost the whole balance. The instruction's small figure must not hide what
// the transaction leaves: the simulated allowance is graded and is the one the window shows.
test("a small Solana approve doesn't hide a larger simulated allowance", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  const program = bs58(new Uint8Array(32).fill(0x42));
  const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = [ME_SOL, ME_SOL_USDC, SOL_USDC, THEM_SOL, token, program].map(base58Decode);
  // ApproveChecked(1 unit, 6 decimals) over [account, mint, delegate, owner], then the program.
  const approveChecked = [13, 1, 0, 0, 0, 0, 0, 0, 0, 6];
  const message = Uint8Array.from([
    ...[1, 0, 4, 6],
    ...keys.flatMap((k) => [...k]),
    ...new Uint8Array(32).fill(9),
    ...[2, 4, 4, 1, 2, 3, 0, approveChecked.length, ...approveChecked],
    ...[5, 3, 1, 0, 4, 1, 7],
  ]);
  const wire = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  net.state.solana.simulateSpend = 5_000n;
  net.state.solana.simulateAfter = (a: string, r: unknown) => {
    if (a !== ME_SOL_USDC || r === null) return r;
    const acct = r as { data: [string, string] };
    const d = new Uint8Array(Buffer.from(acct.data[0], "base64"));
    const v = new DataView(d.buffer, d.byteOffset, d.length);
    v.setUint32(72, 1, true);
    d.set(base58Decode(THEM_SOL), 76);
    v.setBigUint64(121, 4_999_999n, true);
    return { ...acct, data: [Buffer.from(d).toString("base64"), "base64"] };
  };
  const signing = site("solana_signTransaction", { account: ME_SOL, transaction: hexOf(wire) });
  const w = await window();
  const review = ok<DappReview>(await service.handle({ type: "dapp_review", id: w.id }));
  const simulated = review.risk.findings.filter((f) => (f.params as { simulated?: boolean }).simulated === true);
  assert.deepEqual(
    simulated.map((f) => [f.rule, (f.params as { amount?: string }).amount]),
    [["solana_delegate", "4999999"]],
    JSON.stringify(review.risk),
  );
  // The approval card is the allowance the transaction leaves, not the instruction's 1 unit.
  const view = shown(review.display as Parameters<typeof shown>[0], "mainnet", undefined, review.risk.findings);
  assert.deepEqual(view.approvals, [{ token: `spl:${SOL_USDC}`, spender: THEM_SOL, amount: "4999999", via: "token" }]);
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  assert.equal(((await signing) as Reply).error?.code, 4001);
});

// Run-2 C3: a native stake account the account controls is as much its own as a token
// account. Handing its withdrawer away is red with GIVE, read from the Stake instruction or
// from the simulation of a program the wallet can't read; its SOL leaving is shown leaving.
test("a Solana transaction that hands away a stake account, or takes its SOL, says so", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  const STAKE = bs58(new Uint8Array(32).fill(0x53));
  const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
  const CLOCK = "SysvarC1ock11111111111111111111111111111111";
  const HISTORY = "SysvarStakeHistory1111111111111111111111111";
  const unread = bs58(new Uint8Array(32).fill(0x42));
  const stakeAccount = (withdrawer: string) => {
    const d = new Uint8Array(200);
    new DataView(d.buffer).setUint32(0, 2, true);
    d.set(base58Decode(ME_SOL), 12);
    d.set(base58Decode(withdrawer), 44);
    return { lamports: 100_000_000_000, owner: STAKE_PROGRAM, data: [Buffer.from(d).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: 200 };
  };
  net.state.solana.accounts[STAKE] = stakeAccount(ME_SOL);
  net.state.solana.simulateSpend = 5_000n;
  /** A legacy message: ME_SOL signs, `writable` more are writable, `readonly` follow; one instruction. */
  const tx = (writable: string[], readonly: string[], program: number, accounts: number[], data: number[]) => {
    const keys = [ME_SOL, ...writable, ...readonly].map(base58Decode);
    const message = Uint8Array.from([1, 0, readonly.length, keys.length, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 1, program, accounts.length, ...accounts, data.length, ...data]);
    return hexOf(Uint8Array.from([1, ...new Uint8Array(64), ...message]));
  };
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return [...b];
  };
  const u64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return [...b];
  };
  const review = async (transaction: string) => {
    const signing = site("solana_signTransaction", { account: ME_SOL, transaction });
    const w = await window();
    const r = ok<DappReview>(await service.handle({ type: "dapp_review", id: w.id }));
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    assert.equal(((await signing) as Reply).error?.code, 4001);
    return r;
  };
  const rules = (r: DappReview) => r.risk.findings.map((f) => f.rule);

  // The simulation hands the withdrawer to THEM.
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === STAKE ? stakeAccount(THEM_SOL) : r);
  // Through a program the wallet can't read.
  let r = await review(tx([STAKE], [unread], 2, [0, 1], [7]));
  assert.deepEqual([r.risk.level, r.risk.confirm], ["red", "GIVE"], JSON.stringify(r.risk));
  assert.ok(rules(r).includes("solana_stake_withdrawer"), JSON.stringify(r.risk));
  // Directly: Stake's Authorize(THEM, withdrawer), read by the vault and said once.
  r = await review(tx([STAKE], [CLOCK, STAKE_PROGRAM], 3, [1, 2, 0], [...u32(1), ...base58Decode(THEM_SOL), ...u32(1)]));
  assert.deepEqual([r.risk.level, r.risk.confirm], ["red", "GIVE"], JSON.stringify(r.risk));
  assert.equal(rules(r).filter((x) => x === "solana_stake_withdrawer").length, 1, JSON.stringify(r.risk));
  const shownAuthorize = shown(r.display as Parameters<typeof shown>[0], "mainnet", undefined, r.risk.findings);
  assert.ok(shownAuthorize.others.some((o) => o.startsWith("Gives stake account")), JSON.stringify(shownAuthorize.others));

  // Withdraw all 100 SOL to THEM: the simulation shows it leaving, and it reads as a send.
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === STAKE ? null : r);
  r = await review(tx([STAKE, THEM_SOL], [CLOCK, HISTORY, STAKE_PROGRAM], 5, [1, 2, 3, 4, 0], [...u32(4), ...u64(100_000_000_000n)]));
  assert.ok(rules(r).includes("solana_stake_withdraw"), JSON.stringify(r.risk));
  const sim = r.simulation as { ok: boolean; changes: { denom: string; amount: string }[] };
  assert.deepEqual(sim.changes, [{ denom: "sol", amount: (-(100_000_000_000n + 5_000n)).toString() }], JSON.stringify(sim));
  const shownWithdraw = shown(r.display as Parameters<typeof shown>[0], "mainnet", undefined, r.risk.findings);
  assert.deepEqual(shownWithdraw.sends, [{ coins: [{ denom: "sol", amount: "100000000000" }], to: THEM_SOL }]);
});

// Run-4: a Solana message's only tie to a cluster is its blockhash, or its durable nonce's
// value. One the reviewed cluster doesn't hold could be signed for another (a Devnet review,
// mainnet funds), so it isn't signed at all. A durable nonce account the account is the
// authority of is its own SOL, and handing it on is red with GIVE, whatever program does it.
test("a site's Solana transaction is signed only for the cluster it's reviewed on", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  const NONCE = bs58(new Uint8Array(32).fill(0x4e));
  const SYSTEM = "11111111111111111111111111111111";
  const RECENT = "SysvarRecentB1ockHashes11111111111111111111";
  const unread = bs58(new Uint8Array(32).fill(0x42));
  const nonceAccount = (authority: string, value: Uint8Array, lamports = 1_500_000) => {
    const d = new Uint8Array(80);
    new DataView(d.buffer).setUint32(0, 1, true);
    new DataView(d.buffer).setUint32(4, 1, true);
    d.set(base58Decode(authority), 8);
    d.set(value, 40);
    return { lamports, owner: SYSTEM, data: [Buffer.from(d).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: 80 };
  };
  /** A legacy message ME_SOL signs: `writable` then `readonly` keys, its blockhash, instructions. */
  const tx = (writable: string[], readonly: string[], blockhash: Uint8Array, ixs: { program: number; accounts: number[]; data: number[] }[]) => {
    const keys = [ME_SOL, ...writable, ...readonly].map(base58Decode);
    const body = ixs.flatMap((i) => [i.program, i.accounts.length, ...i.accounts, i.data.length, ...i.data]);
    const message = Uint8Array.from([1, 0, readonly.length, keys.length, ...keys.flatMap((k) => [...k]), ...blockhash, ixs.length, ...body]);
    return hexOf(Uint8Array.from([1, ...new Uint8Array(64), ...message]));
  };
  const review = async (transaction: string) => {
    const signing = site("solana_signTransaction", { account: ME_SOL, transaction });
    const w = await window();
    const r = await service.handle({ type: "dapp_review", id: w.id });
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    assert.equal(((await signing) as Reply).error?.code, 4001);
    return r;
  };
  net.state.solana.simulateSpend = 5_000n;
  const nop = { program: 1, accounts: [0], data: [7] };

  // A blockhash this cluster doesn't hold: refused before review, whatever it does.
  const foreign = await review(tx([], [unread], new Uint8Array(32).fill(8), [nop]));
  assert.equal(code(foreign), "bad_request", JSON.stringify(foreign));
  assert.match(JSON.stringify(foreign), /wasn't made on Solana/);
  // One it holds: reviewed.
  ok(await review(tx([], [unread], new Uint8Array(32).fill(9), [nop])));

  // A durable nonce: AdvanceNonceAccount first, the message's blockhash its value.
  const value = new Uint8Array(32).fill(0x33);
  const advance = { program: 3, accounts: [1, 2, 0], data: [4, 0, 0, 0] };
  const durable = tx([NONCE], [RECENT, SYSTEM, unread], value, [advance, { program: 4, accounts: [0], data: [7] }]);
  // No such nonce account here, or one holding another value: refused.
  assert.equal(code(await review(durable)), "bad_request");
  net.state.solana.accounts[NONCE] = nonceAccount(ME_SOL, new Uint8Array(32).fill(0x34));
  assert.equal(code(await review(durable)), "bad_request");
  // The cluster's nonce account holds it: reviewed.
  net.state.solana.accounts[NONCE] = nonceAccount(ME_SOL, value);
  ok(await review(durable));

  // A program the wallet can't read hands the nonce account to THEM: red with GIVE.
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === NONCE ? nonceAccount(THEM_SOL, value) : r);
  const handed = ok<DappReview>(await review(tx([NONCE], [unread], new Uint8Array(32).fill(9), [{ program: 2, accounts: [1, 0], data: [7] }])));
  assert.deepEqual([handed.risk.level, handed.risk.confirm], ["red", "GIVE"], JSON.stringify(handed.risk));
  assert.ok(handed.risk.findings.some((f) => f.rule === "solana_nonce_authority"), JSON.stringify(handed.risk));
  // Or empties it: its SOL is shown leaving.
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === NONCE ? null : r);
  const emptied = ok<DappReview>(await review(tx([NONCE], [unread], new Uint8Array(32).fill(9), [{ program: 2, accounts: [1, 0], data: [7] }])));
  assert.deepEqual((emptied.simulation as { changes: unknown[] }).changes, [{ denom: "sol", amount: (-(1_500_000n + 5_000n)).toString() }], JSON.stringify(emptied.simulation));
});

// Run-2 NV2: the review compares what a site's transaction writes before and after a
// simulation, which reports on at most 100 accounts. A transaction whose lookup table puts the
// account's USDC account 101st isn't simulated in part: it isn't signed at all.
test("a Solana transaction that writes more accounts than the wallet can check isn't signed", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  const program = bs58(new Uint8Array(32).fill(0x42));
  const TABLE = bs58(new Uint8Array(32).fill(0x61));
  const filler = (i: number) => bs58(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? 0x70 : k === 1 ? i : 7)));
  /** A v0 transaction: ME_SOL signs, the program reads, and every entry of the site's table
   *  (`fillers` accounts, then the account's USDC account) is loaded writable. With a `payer`,
   *  the site pays the fee and ME_SOL signs read-only. */
  const tx = (fillers: number, payer?: string) => {
    const entries = [...Array.from({ length: fillers }, (_, i) => filler(i)), ME_SOL_USDC];
    const table = new Uint8Array(56 + 32 * entries.length);
    entries.forEach((a, i) => table.set(base58Decode(a), 56 + 32 * i));
    net.state.solana.accounts[TABLE] = { lamports: 1_000_000, owner: "AddressLookupTab1e1111111111111111111111111", data: [Buffer.from(table).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: table.length };
    const signers = payer ? [payer, ME_SOL] : [ME_SOL];
    const keys = [...signers, program].map(base58Decode);
    const me = signers.length - 1;
    const message = Uint8Array.from([0x80, signers.length, me, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 1, keys.length - 1, 2, me, keys.length, 1, 7, 1, ...base58Decode(TABLE), entries.length, ...entries.map((_, i) => i), 0]);
    return Buffer.from(Uint8Array.from([signers.length, ...new Uint8Array(64 * signers.length), ...message])).toString("hex");
  };
  const review = async (transaction: string) => {
    const signing = site("solana_signTransaction", { account: ME_SOL, transaction });
    const w = await window();
    const r = await service.handle({ type: "dapp_review", id: w.id });
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    assert.equal(((await signing) as Reply).error?.code, 4001);
    return r;
  };
  // 99 fillers, then the USDC account: 101 with ME_SOL. Refused, not simulated in part.
  const over = await review(tx(99));
  assert.equal(code(over), "bad_request", JSON.stringify(over));
  assert.match((over as { error: { message: string } }).error.message, /changes 101 accounts\. The wallet can check at most 100/);
  // One fewer: every account it writes is checked, so the USDC account handed to THEM,
  // 100th in the table's order, is seen and red.
  net.state.solana.simulateAfter = (a: string, r: unknown) => {
    if (a !== ME_SOL_USDC || r === null) return r;
    const d = new Uint8Array(Buffer.from((r as { data: [string, string] }).data[0], "base64"));
    d.set(base58Decode(THEM_SOL), 32);
    return { ...(r as object), data: [Buffer.from(d).toString("base64"), "base64"] };
  };
  const whole = ok<DappReview>(await review(tx(98)));
  assert.deepEqual([whole.risk.level, whole.risk.confirm], ["red", "GIVE"], JSON.stringify(whole.risk));
  assert.ok(whole.risk.findings.some((f) => f.rule === "solana_token_account_owner"), JSON.stringify(whole.risk));
  // The site pays the fee and the account signs read-only: its own address can't change, so
  // it isn't counted. The payer, 98 fillers and the USDC account are 100, all checked.
  const PAYER = bs58(new Uint8Array(32).fill(0x62));
  const paid = ok<DappReview>(await review(tx(98, PAYER)));
  assert.deepEqual([paid.risk.level, paid.risk.confirm], ["red", "GIVE"], JSON.stringify(paid.risk));
  assert.ok(paid.risk.findings.some((f) => f.rule === "solana_token_account_owner"), JSON.stringify(paid.risk));
  const paidOver = await review(tx(99, PAYER));
  assert.match((paidOver as { error: { message: string } }).error.message, /changes 101 accounts\./);
});

// Run-2 C3 follow-up: SOL moving between the account's own stake accounts (a merge, a split
// into a new one) stays the account's, so no loss is shown. A lockup someone else holds, new
// on a stake account it withdraws from, keeps its SOL from it: red with GIVE, and shown leaving.
test("a Solana merge or split of the account's own stake moves nothing; a new lockup is red", async () => {
  const net = chain();
  const { page, window, service } = await setup(net);
  const site = page(SITE);
  const asked = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: (await window()).id, approve: true }));
  await asked;
  const A = bs58(new Uint8Array(32).fill(0x53));
  const B = bs58(new Uint8Array(32).fill(0x54));
  const unread = bs58(new Uint8Array(32).fill(0x42));
  const SOL1 = 1_000_000_000n;
  const stakeAccount = (lamports: bigint, lockup?: { until: bigint; custodian: string }) => {
    const d = new Uint8Array(200);
    const v = new DataView(d.buffer);
    v.setUint32(0, 2, true);
    d.set(base58Decode(ME_SOL), 12);
    d.set(base58Decode(ME_SOL), 44);
    if (lockup) {
      v.setBigInt64(76, lockup.until, true);
      d.set(base58Decode(lockup.custodian), 92);
    }
    return { lamports: Number(lamports), owner: "Stake11111111111111111111111111111111111111", data: [Buffer.from(d).toString("base64"), "base64"], executable: false, rentEpoch: 0, space: 200 };
  };
  net.state.solana.simulateSpend = 5_000n;
  // ME_SOL signs; A and B are writable; one instruction of a program the wallet can't read.
  const keys = [ME_SOL, A, B, unread].map(base58Decode);
  const message = Uint8Array.from([1, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Uint8Array(32).fill(9), 1, 3, 2, 1, 2, 1, 7]);
  const transaction = hexOf(Uint8Array.from([1, ...new Uint8Array(64), ...message]));
  const review = async () => {
    const signing = site("solana_signTransaction", { account: ME_SOL, transaction });
    const w = await window();
    const r = ok<DappReview>(await service.handle({ type: "dapp_review", id: w.id }));
    ok(await service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    assert.equal(((await signing) as Reply).error?.code, 4001);
    return { r, rules: r.risk.findings.map((f) => f.rule), changes: (r.simulation as { changes: { denom: string; amount: string }[] }).changes };
  };
  const feeOnly = [{ denom: "sol", amount: "-5000" }];

  // Merge: A's 100 SOL into B, A closed.
  net.state.solana.accounts[A] = stakeAccount(100n * SOL1);
  net.state.solana.accounts[B] = stakeAccount(50n * SOL1);
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === A ? null : a === B ? stakeAccount(150n * SOL1) : r);
  let v = await review();
  assert.deepEqual(v.changes, feeOnly, JSON.stringify(v.r.simulation));
  assert.ok(!v.rules.some((x) => x.startsWith("solana_stake_")), JSON.stringify(v.r.risk));

  // Split: 40 SOL of A into B, a stake account that didn't exist before.
  delete net.state.solana.accounts[B];
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === A ? stakeAccount(60n * SOL1) : a === B ? stakeAccount(40n * SOL1) : r);
  v = await review();
  assert.deepEqual(v.changes, feeOnly, JSON.stringify(v.r.simulation));

  // A split of a stake account already locked: the lockup it was under isn't new.
  const theirs = { until: 4_000_000_000n, custodian: THEM_SOL };
  net.state.solana.accounts[A] = stakeAccount(100n * SOL1, theirs);
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === A ? stakeAccount(60n * SOL1, theirs) : a === B ? stakeAccount(40n * SOL1, theirs) : r);
  v = await review();
  assert.deepEqual(v.changes, feeOnly, JSON.stringify(v.r.simulation));
  assert.ok(!v.rules.includes("solana_stake_lockup"), JSON.stringify(v.r.risk));

  // A lockup THEM holds, new on A: its 100 SOL is no longer the account's to take.
  net.state.solana.accounts[A] = stakeAccount(100n * SOL1);
  net.state.solana.simulateAfter = (a: string, r: unknown) => (a === A ? stakeAccount(100n * SOL1, theirs) : r);
  v = await review();
  assert.deepEqual([v.r.risk.level, v.r.risk.confirm], ["red", "GIVE"], JSON.stringify(v.r.risk));
  assert.ok(v.rules.includes("solana_stake_lockup"), JSON.stringify(v.r.risk));
  assert.deepEqual(v.changes, [{ denom: "sol", amount: (-(100n * SOL1 + 5_000n)).toString() }], JSON.stringify(v.r.simulation));
});

// F8: only the user's own use holds off the auto-lock. A site's reads, its connect
// window's status poll, and pages re-reading after a broadcast never restart the timer.
// Run-2 C10: a wallet page's own timer (Home's refresh, a transfer's status) or its reload
// after a broadcast is a poll; only the user's own requests restart the auto-lock timer.
test("a wallet page's polls never restart the auto-lock timer", async () => {
  const { service, ui } = await connected();
  ui.locks = [];
  for (let i = 0; i < 3; i++) {
    for (const r of [{ type: "balances" }, { type: "staking" }, { type: "activity", page: 1 }, { type: "bridge_pending" }]) {
      ok(await service.handle({ ...r, poll: true }));
    }
  }
  assert.deepEqual(ui.locks, [], "no poll restarts the timer");
  ok(await service.handle({ type: "balances" }));
  assert.equal(ui.locks.length, 1, "the user's own request does");
});

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
  // The user's own use does: the popup's status, and answering a request. A review doesn't:
  // a site opens that window without the user.
  ok(await service.handle({ type: "status" }));
  assert.equal(ui.locks.length, 1);
  const asked = site("personal_sign", ["0x6869", ME_EVM]);
  const w = await window();
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id: w.id }));
  assert.equal(ui.locks.length, 1, "a site's window doesn't hold off auto-lock");
  ok(await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest }));
  assert.equal(ui.locks.length, 2);
  await asked;
});

// A lock that lands while an approved request is being answered ends it: the page hears a
// rejection and nothing is signed for it afterwards.
test("a lock during an answer stops it before anything is signed", async () => {
  const { page, window, service, ui } = await connected();
  const asked = page(SITE)("personal_sign", ["0x6869", ME_EVM]);
  const w = await window();
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id: w.id }));
  // Auto-lock fires inside the answer, after it was claimed and before it signs.
  ui.onLockTimer = () => {
    ui.onLockTimer = undefined;
    void service.lock();
  };
  const r = await service.handle({ type: "dapp_answer", id: w.id, approve: true, digest: review.digest });
  assert.equal((await asked).error?.code, 4001);
  assert.equal(r.ok, false, "nothing is signed for a request the lock ended");
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

// Run-3: a request keeps the network its handler read and built it for. A switch landing
// between that read and the request's queueing (a site's approved switch, the popup's pick)
// used to leave a mainnet request under a window that named the testnet.
test("a request is reviewed only on the network it was built for", async () => {
  const s = await connected();
  const get = s.local.get.bind(s.local);
  let armed = false;
  s.local.get = async (keys) => {
    const r = await get(keys);
    // The grant check runs after the handler read the network and before the request queues.
    if (armed && keys.includes("connections")) {
      armed = false;
      s.local.data.set("network", "testnet");
    }
    return r;
  };
  armed = true;
  const asked = s.page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to: THEM_EVM, value: "0x1" }]);
  const w = await s.window();
  assert.equal(armed, false, "the switch landed");
  const req = ok<{ network: string }>(await s.service.handle({ type: "dapp_request", id: w.id }));
  assert.equal(req.network, "mainnet");
  assert.equal(code(await s.service.handle({ type: "dapp_review", id: w.id })), "network");
  ok(await s.service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  assert.equal((await asked).error?.code, 4001);
});

// Run-3: a site's swap through Choice's aggregator is weighed as the wallet's own are. A
// route whose minimum is dust (a pool or pair the site chose can return exactly that) is red.
test("a site's swap is weighed against Choice's prices", async () => {
  const s = await connected();
  const route = CHOICE_ROUTES["0x0000000000000000000000000000000000000000 0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13 1000000000000000000"]!;
  const tx = route["tx"] as { to: string; data: string; value: string };
  const review = async (data: string) => {
    const asked = s.page(SITE)("eth_sendTransaction", [{ from: ME_EVM, to: tx.to, data, value: `0x${BigInt(tx.value).toString(16)}` }]);
    const w = await s.window();
    const r = ok<{ risk: { level: string; findings: { rule: string }[] } }>(await s.service.handle({ type: "dapp_review", id: w.id }));
    ok(await s.service.handle({ type: "dapp_answer", id: w.id, approve: false }));
    await asked;
    return r.risk;
  };
  // Choice's own route: its minimum is worth what goes in.
  const fair = await review(tx.data);
  assert.ok(!fair.findings.some((f) => f.rule === "swap_value_lost" || f.rule === "swap_unweighed"), JSON.stringify(fair));
  // The same route with a minimum of one base unit.
  const min = (8145811).toString(16).padStart(64, "0");
  assert.ok(tx.data.includes(min));
  const dust = await review(tx.data.replace(min, "1".padStart(64, "0")));
  assert.equal(dust.level, "red");
  assert.ok(dust.findings.some((f) => f.rule === "swap_value_lost"), JSON.stringify(dust));
  // Run-4: an endpoint answering decimals() = 0 for USDT's pair can't turn the dust minimum
  // into a fair one: a listed token is weighed with the decimals the wallet pins.
  const real = ERC20[USDT_ERC20]!.decimals;
  ERC20[USDT_ERC20]!.decimals = 0;
  try {
    const lied = await review(tx.data.replace(min, "1".padStart(64, "0")));
    assert.equal(lied.level, "red");
    assert.ok(lied.findings.some((f) => f.rule === "swap_value_lost"), JSON.stringify(lied));
  } finally {
    ERC20[USDT_ERC20]!.decimals = real;
  }
});

// Run-3: a site's review describes a bounded number of tokens, however many it names, and a
// few at a time.
test("a site's review looks up at most a bounded number of tokens", async () => {
  const s = await connected();
  const coins = Array.from({ length: 300 }, (_, i) => ({ amount: "1", denom: `q${i.toString(36).padStart(4, "0")}` }));
  const doc = {
    chain_id: "injective-1",
    account_number: "1",
    sequence: "0",
    fee: { amount: [{ denom: "inj", amount: "100000000000000" }], gas: "200000" },
    msgs: [{ type: "cosmos-sdk/MsgSend", value: { from_address: ME, to_address: THEM, amount: coins } }],
    memo: "",
  };
  const asked = s.page(SITE)("choice_signAmino", { chainId: "injective-1", signer: ME, signDoc: doc });
  const w = await s.window();
  const before = s.net.state.metadataCalls;
  ok(await s.service.handle({ type: "dapp_review", id: w.id }));
  assert.ok(s.net.state.metadataCalls - before <= 64, `${s.net.state.metadataCalls - before} lookups`);
  ok(await s.service.handle({ type: "dapp_answer", id: w.id, approve: false }));
  await asked;
});

// Run-3: an unconnected site hears "Connect first." for any chain it names, and no message
// names the chains the user added.
test("an unconnected site can't read the chains the user added", async () => {
  const s = await setup();
  const site = s.page(SITE);
  for (const id of ["0x38", "0x6f0", "0x2a2a2a2a"]) assert.equal((await site("wallet_switchEthereumChain", [{ chainId: id }])).error?.code, 4100, id);
  assert.equal(s.ui.opened.length, 0);
});
