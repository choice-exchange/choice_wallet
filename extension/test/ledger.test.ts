// A Ledger account through the service worker's logic: added from the device's public key,
// its sends and a site's request handed to the device as the vault's exact bytes, and its
// signature taken only once the vault has checked it. The "device" here is the vault itself,
// signing with the test phrase on the Ledger Live path, which is what a Ledger with that
// phrase returns (the browser check, e2e.mjs, runs the real Ledger kit against a fake HID
// device).

import assert from "node:assert/strict";
import { test } from "node:test";

import { callVault, chain, code, handle, INJ, ok, PASSWORD, PHRASE, THEM, wallet } from "./fake";

const SITE = "https://app.example";
type Reply = { result?: unknown; error?: { code: number; message: string } };

const PATH = "m/44'/60'/1'/0/0";
type Device = { app: string; kind: string; payload: string; path: string };
type Status = { wallets: { id: string; type: string; name: string }[]; accounts: { wallet: string; account: Record<string, unknown>; name: string; public_key: string; addresses: Record<string, string> }[]; active: number };

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
