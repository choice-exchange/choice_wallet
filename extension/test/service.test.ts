// The service worker's logic against the real WASM vault, with in-memory storage.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { handle, initSync } from "choice-wallet-vault-glue";

import { createService, fromOwnPage, type Store } from "../src/service";
import { callVault } from "../src/vault";

initSync({ module: readFileSync(new URL("./choice_wallet_wasm_bg.wasm", import.meta.url)) });

// The BIP-39 test phrase and EIP-155's example key: published, owned by no one.
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EIP155_KEY = "4646464646464646464646464646464646464646464646464646464646464646";
const PASSWORD = "correct horse battery staple";

function memory(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) data.delete(k);
    },
  };
}

function setup() {
  const local = memory();
  const session = memory();
  const locks = { scheduled: [] as number[], cancelled: 0 };
  const service = createService({
    vault: async (method, params) => callVault(handle, method, params),
    local,
    session,
    scheduleLock: (m) => void locks.scheduled.push(m),
    cancelLock: () => void locks.cancelled++,
  });
  return { service, local, session, locks };
}

test("create, lock and unlock a wallet", async () => {
  const { service, local, session, locks } = setup();
  assert.deepEqual(await service.handle({ type: "status" }), {
    ok: true,
    result: { hasWallet: false, unlocked: false, kind: null, accounts: [] },
  });

  const created = await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD });
  assert.ok(created.ok);
  const s = created.result as { unlocked: boolean; kind: string; accounts: { addresses: Record<string, string> }[] };
  assert.equal(s.unlocked, true);
  assert.equal(s.kind, "mnemonic");
  assert.equal(s.accounts[0]?.addresses["cosmos:injective-1"], "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz");
  assert.equal(s.accounts[0]?.addresses["eip155:1776"], "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  assert.deepEqual(locks.scheduled, [15]);

  // The page gets neither the keystore nor the unlock key.
  const sent = JSON.stringify(created);
  assert.ok(!sent.includes(local.data.get("keystore") as string));
  assert.ok(!sent.includes(session.data.get("unlock_key") as string));

  const locked = await service.handle({ type: "lock" });
  assert.deepEqual((locked as { result: unknown }).result, { hasWallet: true, unlocked: false, kind: "mnemonic", accounts: [] });
  assert.equal(session.data.has("unlock_key"), false);
  assert.equal(locks.cancelled, 1);

  const wrong = await service.handle({ type: "unlock", password: "not the password" });
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.error.code, "wrong_password");

  const unlocked = await service.handle({ type: "unlock", password: PASSWORD });
  assert.equal(unlocked.ok && (unlocked.result as { unlocked: boolean }).unlocked, true);

  const again = await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD });
  assert.equal(!again.ok && again.error.code, "exists");
});

test("imported private keys", async () => {
  const { service } = setup();
  const r = await service.handle({ type: "create", secret: { private_key: EIP155_KEY }, password: PASSWORD });
  assert.ok(r.ok);
  const s = r.result as { kind: string; accounts: { addresses: Record<string, string> }[] };
  assert.equal(s.kind, "private_key");
  assert.equal(s.accounts[0]?.addresses["eip155:1776"], "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F");
});

test("bad input is refused, not thrown", async () => {
  const { service } = setup();
  for (const req of [null, {}, { type: "export" }, "status"]) {
    const r = await service.handle(req);
    assert.equal(!r.ok && r.error.code, "bad_request", JSON.stringify(req));
  }
  const short = await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: "short" });
  assert.equal(!short.ok && short.error.code, "keystore");
  const g = await service.handle({ type: "generate", words: 24 });
  assert.equal(g.ok && (g.result as { phrase: string }).phrase.split(" ").length, 24);
});

test("only the extension's own pages are answered", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const own = `chrome-extension://${id}`;
  assert.equal(fromOwnPage({ id, origin: own, url: `${own}/popup.html` }, id), true);
  // A content script: same extension ID, but the sender is the web page.
  assert.equal(fromOwnPage({ id, origin: "https://evil.example", url: "https://evil.example/" }, id), false);
  // Another extension, or a page claiming our URL from another origin.
  assert.equal(fromOwnPage({ id: "other", origin: own, url: `${own}/popup.html` }, id), false);
  assert.equal(fromOwnPage({ id, origin: "https://evil.example", url: `${own}/popup.html` }, id), false);
  assert.equal(fromOwnPage({}, id), false);
});
