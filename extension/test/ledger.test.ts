// A Ledger account through the service worker's logic: added from the device's public key,
// its sends and a site's request handed to the device as the vault's exact bytes, and its
// signature taken only once the vault has checked it. The "device" here is the vault itself,
// signing with the test phrase on the Ledger Live path, which is what a Ledger with that
// phrase returns (the browser check, e2e.mjs, runs the real Ledger kit against a fake HID
// device).

import assert from "node:assert/strict";
import { test } from "node:test";

import { base58Decode, callVault, chain, code, handle, INJ, LUMA, ME_EVM, ME_SOL, ok, PASSWORD, PHRASE, SOLANA_MAINNET, solTransfer, THEM, THEM_EVM, THEM_KEY, THEM_SOL, wallet } from "./fake";

const SITE = "https://app.example";
type Reply = { result?: unknown; error?: { code: number; message: string } };

const PATH = "m/44'/60'/1'/0/0";
type Device = { app: string; kind: string; payload: string; path: string };
type Status = {
  wallets: { id: string; type: string; name: string }[];
  accounts: { wallet: string; account: Record<string, unknown>; name: string; public_key: string; addresses: Record<string, string>; ledger_solana?: { path: string; public_key: string } }[];
  active: number;
};
/** Its key in the Solana app, as the Ledger tab reads it for PATH: Ledger Live's account 1. */
const SOLANA_PATH = "m/44'/501'/1'";
/** That key. (The phrase's Phantom key stands in for the device's: the fake cluster knows
 *  that account.) */
const SOLANA_KEY = Buffer.from(base58Decode(ME_SOL)).toString("hex");
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The test phrase as a Ledger: its key on the Ledger Live path (`m/44'/60'/1'/0/0`). */
function device() {
  const v = callVault<{ unlock_key: string }>(handle, "create_vault", { password: PASSWORD });
  assert.ok(v.ok);
  const sealed = callVault<{ secret: string }>(handle, "seal_secret", { unlock_key: v.result.unlock_key, wallet: "d", secret: { mnemonic: PHRASE } });
  assert.ok(sealed.ok);
  const account = { derivation: "ledger_live", index: 1 };
  const info = callVault<{ accounts: { public_key: string; addresses: Record<string, string> }[] }>(handle, "accounts", { secret: sealed.result.secret, wallet: "d", unlock_key: v.result.unlock_key, accounts: [account] });
  assert.ok(info.ok);
  const me = info.result.accounts[0]!;
  return {
    publicKey: me.public_key,
    address: me.addresses["cosmos:injective-1"]!,
    evm: me.addresses["eip155:1776"]!,
    /** What the device returns for `request` (as the vault would sign it): DER for the
     *  Cosmos app, `r || s` for the Ethereum app. */
    sign(request: unknown, format: "der" | "rs"): string {
      const d = callVault<{ digest: string }>(handle, "decode", { request });
      assert.ok(d.ok);
      const s = callVault<{ signature: string }>(handle, "sign", { secret: sealed.result.secret, wallet: "d", unlock_key: v.result.unlock_key, account, request, digest: d.result.digest });
      assert.ok(s.ok, JSON.stringify(s));
      const rs = s.result.signature.replace(/^0x/, "").slice(0, 128);
      return format === "rs" ? rs : der(rs);
    },
    /** What the Solana app returns for a transaction's message: its 64-byte signature. */
    solanaSign(message: string): string {
      const request = { solana_transaction: { chain: SOLANA_MAINNET, signer: ME_SOL, message } };
      const d = callVault<{ digest: string }>(handle, "decode", { request });
      assert.ok(d.ok);
      const s = callVault<{ signature: string }>(handle, "sign", { secret: sealed.result.secret, wallet: "d", unlock_key: v.result.unlock_key, account: { derivation: "default", index: 0 }, request, digest: d.result.digest });
      assert.ok(s.ok, JSON.stringify(s));
      return s.result.signature;
    },
  };
}

/** `r || s` as ASN.1 DER, as Ledger's Cosmos app writes it. */
function der(rs: string): string {
  const int = (h: string) => {
    let b = Buffer.from(h, "hex");
    while (b.length > 1 && b[0] === 0) b = b.subarray(1);
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const body = Buffer.concat([int(rs.slice(0, 64)), int(rs.slice(64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString("hex");
}

test("a Ledger's accounts are added from its public keys, and never show a key", async () => {
  const { service } = await wallet();
  const dev = device();
  assert.equal(code(await service.handle({ type: "add_ledger", accounts: [{ path: "m/44'/118'/0'/0/0", public_key: dev.publicKey }] })), "bad_request");
  assert.equal(code(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: "02" + "00".repeat(32) }] })), "bad_request");
  const s = ok<Status>(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  const w = s.wallets.find((x) => x.type === "ledger")!;
  assert.equal(w.name, "Ledger 1");
  const a = s.accounts[s.active]!;
  assert.deepEqual([a.wallet, a.account, a.addresses["cosmos:injective-1"], a.name], [w.id, { derivation: "ledger", path: PATH }, dev.address, "Account 2"]);
  // The same key again is refused; the wallet has no phrase or key to show, or next account.
  assert.equal(code(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] })), "exists");
  assert.equal(code(await service.handle({ type: "reveal_secret", password: PASSWORD, wallet: w.id })), "ledger");
  assert.equal(code(await service.handle({ type: "reveal_secret", password: PASSWORD, index: s.active })), "ledger");
  assert.equal(code(await service.handle({ type: "add_account", wallet: w.id })), "ledger");
});

test("accounts saved before the vault knew a chain get its addresses at the next unlock, if the rest match", async () => {
  const { service, local } = await wallet(chain({ balances: { inj: INJ } }));
  const dev = device();
  ok(await service.handle({ type: "add_wallet", secret: { private_key: THEM_KEY } }));
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  ok(await service.handle({ type: "add_ledger_solana", accounts: [{ public_key: dev.publicKey, solana: { path: SOLANA_PATH, public_key: SOLANA_KEY } }] }));
  ok(await service.handle({ type: "add_watch", address: "0x" + "ab".repeat(20) }));
  ok(await service.handle({ type: "add_watch", address: "0x" + "cd".repeat(20) }));
  const { accounts } = (await local.get(["accounts"])) as { accounts: Status["accounts"] };
  assert.deepEqual(
    accounts.map((a) => a.account.derivation),
    ["default", "imported", "ledger", "watch", "watch"],
  );
  assert.equal(accounts[0]!.addresses["eip155:8453"], ME_EVM);
  assert.equal(accounts[2]!.addresses[SOLANA_MAINNET], ME_SOL);
  // As saved before the EVM chains: Injective's two sides, and Solana where there was a key.
  const before = (a: Status["accounts"][number]) => Object.fromEntries(Object.entries(a.addresses).filter(([k]) => /^(cosmos:|solana:|eip155:(1776|1439)$)/.test(k)));
  const old = accounts.map((a) => ({ ...a, addresses: before(a) }));
  // The last one's saved address isn't what its own gives: it stays as saved.
  old[4]!.addresses["eip155:1776"] = THEM_EVM;
  await local.set({ accounts: old });
  ok(await service.handle({ type: "lock" }));
  const s = ok<Status>(await service.handle({ type: "unlock", password: PASSWORD }));
  assert.deepEqual(
    s.accounts.slice(0, 4).map((a) => a.addresses),
    accounts.slice(0, 4).map((a) => a.addresses),
  );
  assert.deepEqual(s.accounts[4]!.addresses, old[4]!.addresses);
});

test("a Ledger send: amino JSON for the Cosmos app, its signature checked before broadcast", async () => {
  const net = chain({ balances: { inj: 5n * INJ } });
  const { service } = await wallet(net);
  const dev = device();
  net.state.funded.add(dev.address);
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  const review = ok<{ digest: string; display: { kind: string; signer: string } }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  assert.deepEqual([review.display.kind, review.display.signer], ["cosmos_amino_tx", dev.address]);
  const r = ok<{ device: Device }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.deepEqual([r.device.app, r.device.kind, r.device.path], ["cosmos", "amino", PATH]);
  const json = Buffer.from(r.device.payload, "hex").toString();
  assert.match(json, new RegExp(`"to_address":"${THEM}"`));
  // A second confirm finds nothing: the request waits for the device alone.
  assert.equal(code(await service.handle({ type: "confirm_send", digest: review.digest })), "not_approved");

  // Wrong signatures leave it waiting: junk, and a signature over other bytes.
  assert.equal(code(await service.handle({ type: "ledger_signed", digest: review.digest, signature: "3000", format: "der" })), "bad_signature");
  const other = dev.sign({ cosmos_amino: { chain: "cosmos:injective-1", signer: dev.publicKey, sign_doc: json.replace('"memo":""', '"memo":"x"') } }, "der");
  assert.equal(code(await service.handle({ type: "ledger_signed", digest: review.digest, signature: other, format: "der" })), "bad_signature");
  assert.equal(net.state.broadcasts.length, 0);
  // The device signs the JSON it was shown.
  const sig = dev.sign({ cosmos_amino: { chain: "cosmos:injective-1", signer: dev.publicKey, sign_doc: json } }, "der");
  ok(await service.handle({ type: "ledger_signed", digest: review.digest, signature: sig, format: "der" }));
  assert.equal(net.state.broadcasts.length, 1);
  assert.ok(Buffer.from(net.state.broadcasts[0]!, "base64").includes(Buffer.from(dev.publicKey, "hex")));
  // Used once.
  assert.equal(code(await service.handle({ type: "ledger_signed", digest: review.digest, signature: sig, format: "der" })), "not_approved");
});

test("a Ledger's EVM-only token send goes to its Ethereum app, never a software key", async () => {
  const net = chain({ balances: { inj: 5n * INJ }, evm: { [LUMA]: 3n * INJ } });
  const { service } = await wallet(net);
  const dev = device();
  net.state.funded.add(dev.address);
  net.state.evmAlso.push(dev.evm);
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  const review = ok<{ digest: string; display: { kind: string } }>(await service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: THEM_EVM, amount: INJ.toString() }));
  const r = ok<{ device: Device }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.deepEqual([r.device.app, r.device.path], ["ethereum", PATH]);
  assert.equal(net.state.evmSent.length, 0);
});

test("a site's request on a Ledger: the device gets the message, the page gets its checked signature", async () => {
  const { service, ui } = await wallet();
  const dev = device();
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  const site = (method: string, params?: unknown) => service.dapp(SITE, { method, params }) as Promise<Reply>;
  const nextWindow = async (seen: number) => {
    for (let i = 0; i < 200 && ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    return ui.opened.at(-1)!;
  };
  const connecting = site("eth_requestAccounts");
  ok(await service.handle({ type: "dapp_answer", id: await nextWindow(0), approve: true }));
  assert.deepEqual(await connecting, { result: [dev.evm.toLowerCase()] });
  // Keplr's flag tells Cosmos sites to ask for amino signatures.
  // Connected already: enabling the Cosmos side asks nothing more.
  assert.deepEqual(await site("choice_enable", { chainIds: ["injective-1"] }), { result: null });
  const key = (await site("choice_getKey", { chainId: "injective-1" })).result as Record<string, unknown>;
  assert.equal(key["isNanoLedger"], true);

  const message = "0x48656c6c6f2066726f6d206120746573742e";
  const asked = site("personal_sign", [message, dev.evm]);
  const id = await nextWindow(1);
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id }));
  const r = ok<{ device: Device }>(await service.handle({ type: "dapp_answer", id, approve: true, digest: review.digest }));
  assert.deepEqual([r.device.app, r.device.kind, `0x${r.device.payload}`, r.device.path], ["ethereum", "message", message, PATH]);
  // A bad signature leaves the request open; the page hears nothing yet.
  assert.equal(code(await service.handle({ type: "dapp_ledger_signed", id, digest: review.digest, signature: "00".repeat(64), format: "rs" })), "bad_signature");
  ok(await service.handle({ type: "dapp_request", id }));
  const rs = dev.sign({ evm_personal_sign: { chain: "eip155:1776", signer: dev.evm, message } }, "rs");
  ok(await service.handle({ type: "dapp_ledger_signed", id, digest: review.digest, signature: rs, format: "rs" }));
  const got = (await asked).result as string;
  assert.equal(got, `0x${rs}${got.slice(-2)}`);
  assert.ok(["1b", "1c"].includes(got.slice(-2)), got);

  // A SIGN_MODE_DIRECT request: a Ledger can't sign it, and the window says so first.
  const built = callVault<{ request: { cosmos_direct: { body_bytes: string; auth_info_bytes: string } } }>(handle, "build_cosmos", {
    chain: "cosmos:injective-1",
    signer: dev.publicKey,
    messages: [{ type: "bank_send", to: THEM, amount: [{ denom: "inj", amount: "1" }] }],
    account_number: "1",
    sequence: "0",
    fee: { amount: [{ denom: "inj", amount: "16000000000000" }], gas_limit: "100000" },
  });
  assert.ok(built.ok);
  const doc = built.result.request.cosmos_direct;
  void site("choice_signDirect", { chainId: "injective-1", signer: dev.address, signDoc: { bodyBytes: doc.body_bytes, authInfoBytes: doc.auth_info_bytes, chainId: "injective-1", accountNumber: "1" } });
  const direct = await nextWindow(2);
  assert.equal(ui.opened.length, 3, "signDirect from the Ledger account opens its window");
  assert.equal(code(await service.handle({ type: "dapp_review", id: direct })), "device_unsupported");
});

test("a Ledger's Solana: its key read from the Solana app, its sends signed there and checked", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  const dev = device();
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  // No Solana address until its Solana app's key is read.
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "sol", to: THEM_SOL, amount: "1000" })), "no_solana");
  const add = (path: string, account = dev.publicKey, key = SOLANA_KEY) => service.handle({ type: "add_ledger_solana", accounts: [{ public_key: account, solana: { path, public_key: key } }] });
  assert.equal(code(await add("m/44'/501'/1'/0'")), "bad_request");
  assert.equal(code(await add(SOLANA_PATH, "02" + "11".repeat(32))), "bad_request");
  // A program-derived address is no key a device holds.
  assert.equal(code(await add(SOLANA_PATH, dev.publicKey, hexOf(base58Decode("45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE")))), "bad_request");
  const s = ok<Status>(await add(SOLANA_PATH));
  const a = s.accounts[s.active]!;
  assert.deepEqual([a.addresses[SOLANA_MAINNET], a.ledger_solana], [ME_SOL, { path: SOLANA_PATH, public_key: SOLANA_KEY }]);

  // A send: the Solana app gets the message at its path; a bad signature sends nothing.
  const review = ok<{ digest: string; display: { signer: string } }>(await service.handle({ type: "prepare_send", denom: "sol", to: THEM_SOL, amount: "250000000" }));
  assert.equal(review.display.signer, ME_SOL);
  const r = ok<{ device: Device }>(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.deepEqual([r.device.app, r.device.kind, r.device.path], ["solana", "transaction", SOLANA_PATH]);
  assert.equal(code(await service.handle({ type: "ledger_signed", digest: review.digest, signature: "00".repeat(64), format: "rs" })), "bad_signature");
  assert.equal(net.state.solana.sent.length, 0);
  const sent = ok<{ chain?: string }>(await service.handle({ type: "ledger_signed", digest: review.digest, signature: dev.solanaSign(r.device.payload), format: "rs" }));
  assert.equal(sent.chain, SOLANA_MAINNET);
  assert.equal(net.state.solana.sent.length, 1);
});

test("a Solana site on a Ledger: its transaction to the Solana app, a message refused before review", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service, ui } = await wallet(net);
  const dev = device();
  ok(await service.handle({ type: "add_ledger", accounts: [{ path: PATH, public_key: dev.publicKey }] }));
  ok(await service.handle({ type: "add_ledger_solana", accounts: [{ public_key: dev.publicKey, solana: { path: SOLANA_PATH, public_key: SOLANA_KEY } }] }));
  const site = (method: string, params?: unknown) => service.dapp(SITE, { method, params }) as Promise<Reply>;
  const nextWindow = async (seen: number) => {
    for (let i = 0; i < 200 && ui.opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 5));
    return ui.opened.at(-1)!;
  };
  const connecting = site("solana_connect", {});
  ok(await service.handle({ type: "dapp_answer", id: await nextWindow(0), approve: true }));
  assert.deepEqual(((await connecting).result as { accounts: { address: string }[] }).accounts.map((x) => x.address), [ME_SOL]);

  net.state.solana.simulateSpend = 250_005_000n;
  const sending = site("solana_signAndSendTransaction", { account: ME_SOL, chain: "solana:mainnet", transaction: hexOf(solTransfer(250_000_000n)) });
  const id = await nextWindow(1);
  const review = ok<{ digest: string }>(await service.handle({ type: "dapp_review", id }));
  const r = ok<{ device: Device }>(await service.handle({ type: "dapp_answer", id, approve: true, digest: review.digest }));
  assert.deepEqual([r.device.app, r.device.kind, r.device.path], ["solana", "transaction", SOLANA_PATH]);
  assert.equal(code(await service.handle({ type: "dapp_ledger_signed", id, digest: review.digest, signature: "00".repeat(64), format: "rs" })), "bad_signature");
  assert.equal(net.state.solana.sent.length, 0);
  ok(await service.handle({ type: "dapp_ledger_signed", id, digest: review.digest, signature: dev.solanaSign(r.device.payload), format: "rs" }));
  assert.equal(((await sending).result as { signature: string }).signature, dev.solanaSign(r.device.payload));
  assert.equal(net.state.solana.sent.length, 1);

  // The Solana app signs no plain messages here: the window says so before the request.
  void site("solana_signMessage", { account: ME_SOL, message: hexOf(new TextEncoder().encode("Sign in")) });
  assert.equal(code(await service.handle({ type: "dapp_review", id: await nextWindow(2) })), "device_unsupported");
});
