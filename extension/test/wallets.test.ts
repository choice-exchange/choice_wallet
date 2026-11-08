// Several wallets behind one password: another phrase (its used accounts found), an
// imported key, duplicates refused, a watched address that turns out to be ours, signing
// with the right wallet, renaming and removing one. Against the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { callVault, chain, code, handle, INJ, ME, ok, PASSWORD, PHRASE, THEM, THEM_EVM, THEM_KEY, wallet } from "./fake";

type Status = {
  wallets: { id: string; type: string; name: string }[];
  accounts: { wallet: string; name: string; account: { derivation: string; index?: number }; addresses: Record<string, string> }[];
  active: number;
};
const COSMOS = "cosmos:injective-1";
// Hardhat's test phrase (published) and its third account (m/44'/60'/0'/0/2).
const JUNK = "test test test test test test test test test test test junk";
const JUNK_2_EVM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const injOf = (address: string) => {
  const r = callVault<{ addresses: Record<string, string> }>(handle, "addresses", { address });
  assert.ok(r.ok);
  return r.result.addresses[COSMOS]!;
};

test("another phrase joins behind the same password, with its used accounts", async () => {
  const net = chain();
  net.state.funded.add(injOf(JUNK_2_EVM));
  const { service } = await wallet(net);
  const s = ok<Status>(await service.handle({ type: "add_wallet", secret: { mnemonic: JUNK } }));
  assert.deepEqual(s.wallets.map((w) => [w.type, w.name]), [
    ["mnemonic", "Recovery phrase 1"],
    ["mnemonic", "Recovery phrase 2"],
  ]);
  const junk = s.wallets[1]!.id;
  // Index 0 always, and index 2, which has a balance; index 1 has nothing.
  assert.deepEqual(
    s.accounts.map((a) => [a.name, a.wallet === junk, a.account.index]),
    [["Account 1", false, 0], ["Account 2", true, 0], ["Account 3", true, 2]],
  );
  assert.equal(s.active, 1);
  // A new phrase (created here) isn't searched; the same phrase twice is refused.
  assert.equal(code(await service.handle({ type: "add_wallet", secret: { mnemonic: PHRASE } })), "exists");
  assert.equal(code(await service.handle({ type: "add_wallet", secret: { mnemonic: "not a phrase" } })), "keystore");
  assert.equal(code(await service.handle({ type: "add_wallet", secret: { seed: "x" } })), "bad_request");
  // One unlock opens both.
  ok(await service.handle({ type: "lock" }));
  const back = ok<Status>(await service.handle({ type: "unlock", password: PASSWORD }));
  assert.equal(back.wallets.length, 2);
  // Accounts are added to the phrase they're asked of.
  const more = ok<Status>(await service.handle({ type: "add_account", wallet: junk }));
  assert.deepEqual([more.accounts.at(-1)!.wallet, more.accounts.at(-1)!.account.index, more.accounts.at(-1)!.name], [junk, 3, "Account 4"]);
});

test("each account signs with its own wallet", async () => {
  const net = chain();
  const junk2 = injOf(JUNK_2_EVM);
  net.state.funded.add(junk2);
  const { service } = await wallet(net);
  const s = ok<Status>(await service.handle({ type: "add_wallet", secret: { mnemonic: JUNK } }));
  ok(await service.handle({ type: "switch_account", index: s.accounts.findIndex((a) => a.addresses[COSMOS] === junk2) }));
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);
});

test("an imported key: refused if it's already here, and a watched address becomes it", async () => {
  const { service } = await wallet();
  ok(await service.handle({ type: "add_watch", address: THEM }));
  const s = ok<Status>(await service.handle({ type: "add_wallet", secret: { private_key: THEM_KEY } }));
  assert.deepEqual(s.wallets.map((w) => [w.type, w.name]), [
    ["mnemonic", "Recovery phrase 1"],
    ["private_key", "Imported key 1"],
  ]);
  // The watched entry is now the imported account, keeping its name.
  assert.deepEqual(
    s.accounts.map((a) => [a.name, a.account.derivation, a.addresses["eip155:1776"]]),
    [["Account 1", "default", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"], ["Watching 1", "imported", THEM_EVM]],
  );
  assert.equal(code(await service.handle({ type: "add_wallet", secret: { private_key: THEM_KEY } })), "exists");
  // An imported key has the one account.
  assert.equal(code(await service.handle({ type: "add_account", wallet: s.wallets[1]!.id })), "no_phrase");
  // The first phrase's own account, imported as a key, is already here too.
  const { private_key } = ok<{ private_key: string }>(await service.handle({ type: "reveal_secret", password: PASSWORD, index: 0 }));
  assert.equal(code(await service.handle({ type: "add_wallet", secret: { private_key } })), "exists");
  assert.equal(ok<{ private_key: string }>(await service.handle({ type: "reveal_secret", password: PASSWORD, wallet: s.wallets[1]!.id })).private_key, THEM_KEY);
});

test("wallets are renamed, and removed with their accounts after the password; the last one stays", async () => {
  const { service, ui } = await wallet();
  const s = ok<Status>(await service.handle({ type: "add_wallet", secret: { private_key: THEM_KEY } }));
  const [phrase, key] = s.wallets;
  const named = ok<Status>(await service.handle({ type: "rename_wallet", wallet: key!.id, name: "  Bot​ key " }));
  assert.equal(named.wallets[1]!.name, "Bot key");
  assert.equal(code(await service.handle({ type: "rename_wallet", wallet: "nope", name: "x" })), "bad_request");
  assert.equal(code(await service.handle({ type: "remove_wallet", wallet: key!.id, password: "not it" })), "wrong_password");
  const notified = ui.notified;
  const left = ok<Status>(await service.handle({ type: "remove_wallet", wallet: key!.id, password: PASSWORD }));
  assert.deepEqual([left.wallets.length, left.accounts.length, left.active, left.accounts[0]!.addresses[COSMOS]], [1, 1, 0, ME]);
  assert.ok(ui.notified > notified);
  assert.equal(code(await service.handle({ type: "remove_wallet", wallet: phrase!.id, password: PASSWORD })), "last_wallet");
});

// A keystore as devices stored it before vaults: the BIP-39 test phrase sealed under
// PASSWORD itself (format v1, Argon2id at the core's minimum cost so the test is quick).
const LEGACY = "43574b53010100004c000000000200000001bdc4ab939ccf49693869cc1c3625b0aad34b4fd213556c6e326cec3261b059cf3bf2357eb0ec769894b961d3f431e8c3f3db50bee88f5bc14a72e163d1a116c916433895175af000bd";

test("a device from before vaults moves into one at its first unlock, its list kept", async () => {
  const net = chain();
  const { service, local } = await wallet(net);
  // Put the old shape in place of the new one.
  const second = injOf("0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0");
  await service.handle({ type: "lock" });
  for (const k of ["vault", "wallets"]) local.data.delete(k);
  local.data.set("keystore", LEGACY);
  local.data.set("kind", "mnemonic");
  local.data.set("accounts", [
    { account: { derivation: "default", index: 0 }, public_key: "", addresses: { [COSMOS]: ME }, name: "Main" },
    { account: { derivation: "default", index: 1 }, public_key: "", addresses: { [COSMOS]: second }, name: "Trading" },
    { account: { derivation: "watch" }, public_key: "", addresses: { [COSMOS]: THEM }, name: "Whale" },
  ]);
  local.data.set("active_account", 1);
  const before = ok<{ hasWallet: boolean; unlocked: boolean }>(await service.handle({ type: "status" }));
  assert.deepEqual([before.hasWallet, before.unlocked], [true, false]);

  assert.equal(code(await service.handle({ type: "unlock", password: "not it" })), "wrong_password");
  assert.ok(local.data.has("keystore"));
  const s = ok<Status>(await service.handle({ type: "unlock", password: PASSWORD }));
  assert.ok(local.data.has("vault") && !local.data.has("keystore") && !local.data.has("kind"));
  assert.deepEqual(s.wallets.map((w) => [w.type, w.name]), [["mnemonic", "Recovery phrase 1"]]);
  const id = s.wallets[0]!.id;
  assert.deepEqual(
    s.accounts.map((a) => [a.name, a.wallet === id ? "phrase" : a.wallet, a.addresses[COSMOS]]),
    [["Main", "phrase", ME], ["Trading", "phrase", second], ["Whale", "watch", THEM]],
  );
  assert.equal(s.active, 1);
  // From now on it's a vault: the same password opens it, and it signs.
  ok(await service.handle({ type: "lock" }));
  ok(await service.handle({ type: "unlock", password: PASSWORD }));
  ok(await service.handle({ type: "switch_account", index: 0 }));
  const review = ok<{ digest: string }>(await service.handle({ type: "prepare_send", denom: "inj", to: THEM, amount: INJ.toString() }));
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.broadcasts.length, 1);
});
