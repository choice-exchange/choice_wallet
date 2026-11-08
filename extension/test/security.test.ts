// Security: the recovery phrase or a key, shown only after the password; a new password;
// taking the wallet off the device; how long it stays unlocked. Against the real vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createService } from "../src/service";
import { callVault, chain, code, handle, INJ, memory, ok, PASSWORD, PHRASE, serviceOn, THEM, THEM_KEY, wallet } from "./fake";

type Status = { hasWallet: boolean; unlocked: boolean; accounts: { addresses: Record<string, string> }[] };
const NEW_PASSWORD = "a different long password";

test("the recovery phrase, or an account's key, only with the password", async () => {
  const { service } = await wallet();
  assert.equal(code(await service.handle({ type: "reveal_secret", password: "not it" })), "wrong_password");
  assert.equal(code(await service.handle({ type: "reveal_secret", password: "" })), "bad_request");
  assert.equal(ok<{ phrase: string }>(await service.handle({ type: "reveal_secret", password: PASSWORD })).phrase, PHRASE);

  // The second account's key opens, on its own, the same account.
  const s = ok<Status>(await service.handle({ type: "add_account" }));
  const { private_key } = ok<{ private_key: string }>(await service.handle({ type: "reveal_secret", password: PASSWORD, index: 1 }));
  const other = serviceOn(chain(), memory(), memory());
  const imported = ok<Status>(await other.handle({ type: "create", secret: { private_key }, password: PASSWORD }));
  assert.equal(imported.accounts[0]!.addresses["cosmos:injective-1"], s.accounts[1]!.addresses["cosmos:injective-1"]);

  ok(await service.handle({ type: "add_watch", address: THEM }));
  assert.equal(code(await service.handle({ type: "reveal_secret", password: PASSWORD, index: 2 })), "watch_only");
  assert.equal(code(await service.handle({ type: "reveal_secret", password: PASSWORD, index: 9 })), "bad_request");
  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "reveal_secret", password: PASSWORD })), "locked");

  // A wallet that is one imported key shows that key.
  const single = serviceOn(chain(), memory(), memory());
  ok(await single.handle({ type: "create", secret: { private_key: THEM_KEY }, password: PASSWORD }));
  assert.equal(ok<{ private_key: string }>(await single.handle({ type: "reveal_secret", password: PASSWORD })).private_key, THEM_KEY);
});

test("a new password: the old one stops working, the wallet stays unlocked and can still send", async () => {
  const { service, local, session, net } = await wallet();
  const before = { vault: local.data.get("vault"), wallets: local.data.get("wallets"), key: session.data.get("unlock_key") };
  assert.equal(code(await service.handle({ type: "change_password", password: "not it", new_password: NEW_PASSWORD })), "wrong_password");
  assert.equal(code(await service.handle({ type: "change_password", password: PASSWORD, new_password: "short" })), "weak_password");
  assert.equal(code(await service.handle({ type: "change_password", password: PASSWORD, new_password: PASSWORD })), "same_password");
  assert.equal(local.data.get("vault"), before.vault);

  assert.equal(ok<Status>(await service.handle({ type: "change_password", password: PASSWORD, new_password: NEW_PASSWORD })).unlocked, true);
  // The vault is re-wrapped; the wallets' secrets and the session's key stay as they were.
  assert.notEqual(local.data.get("vault"), before.vault);
  assert.deepEqual(local.data.get("wallets"), before.wallets);
  assert.equal(session.data.get("unlock_key"), before.key);
  // Still unlocked, with the new key: a send goes through.
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);

  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "unlock", password: PASSWORD })), "wrong_password");
  ok(await service.handle({ type: "unlock", password: NEW_PASSWORD }));
});

test("removing the wallet takes the password; settings stay, the wallet and its sites go", async () => {
  const { service, local, session } = await wallet();
  ok(await service.handle({ type: "save_settings", network: "testnet", lcd: ["https://lcd.example"] }));
  local.data.set("connections", { "https://app.example": { since: 1 } });
  assert.equal(code(await service.handle({ type: "reset", password: "not it" })), "wrong_password");
  assert.ok(local.data.has("vault"));

  const s = ok<Status>(await service.handle({ type: "reset", password: PASSWORD }));
  assert.deepEqual([s.hasWallet, s.unlocked], [false, false]);
  for (const k of ["vault", "wallets", "accounts", "active_account", "connections"]) assert.ok(!local.data.has(k), k);
  assert.ok(!session.data.has("unlock_key"));
  assert.deepEqual(local.data.get("endpoints"), { testnet: ["https://lcd.example"] });
  // A new wallet can be made at once.
  ok(await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD }));
});

test("lock after: one of the choices, applied from the next use", async () => {
  const locks: number[] = [];
  const service = createService({
    vault: async (method, params) => callVault(handle, method, params),
    local: memory(),
    session: memory(),
    fetch: chain().fetch,
    scheduleLock: (m) => void locks.push(m),
    cancelLock: () => {},
    openWindow: async () => undefined,
    notify: () => {},
  });
  ok(await service.handle({ type: "create", secret: { mnemonic: PHRASE }, password: PASSWORD }));
  assert.equal(locks.at(-1), 15);
  const s = ok<{ autoLock: number }>(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, autoLock: 60 }));
  assert.equal(s.autoLock, 60);
  assert.equal(locks.at(-1), 60);
  ok(await service.handle({ type: "status" }));
  assert.equal(locks.at(-1), 60);
  assert.equal(code(await service.handle({ type: "save_settings", network: "mainnet", lcd: null, autoLock: 7 })), "bad_request");
});
