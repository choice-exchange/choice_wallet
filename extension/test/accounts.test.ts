// Accounts: more from the recovery phrase, addresses to watch, which one is in use (for the
// wallet and for connected sites), names, and dropping one. Against the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { bech32Of, chain, code, ME, ME_EVM, memory, ok, PASSWORD, serviceOn, THEM, THEM_EVM, THEM_KEY, wallet } from "./fake";

type Account = { account: { derivation: string; index?: number }; name: string; addresses: Record<string, string>; public_key: string };
type Status = { unlocked: boolean; accounts: Account[]; active: number };
const COSMOS = "cosmos:injective-1";
const EVM = "eip155:1776";
// The BIP-39 test phrase's second account (m/44'/60'/0'/0/1), published.
const SECOND_EVM = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
const SITE = "https://app.example";

test("accounts: the next one from the phrase, in use at once, kept across a lock", async () => {
  const { service, ui, net } = await wallet();
  const first = ok<Status>(await service.handle({ type: "status" }));
  assert.deepEqual(
    first.accounts.map((a) => [a.name, a.addresses[COSMOS]]),
    [["Account 1", ME]],
  );
  assert.equal(first.active, 0);

  const notified = ui.notified;
  const two = ok<Status>(await service.handle({ type: "add_account" }));
  assert.deepEqual(two.accounts.map((a) => [a.name, a.account.derivation, a.account.index]), [
    ["Account 1", "default", 0],
    ["Account 2", "default", 1],
  ]);
  assert.equal(two.accounts[1]!.addresses[EVM], SECOND_EVM);
  assert.equal(two.active, 1);
  assert.ok(ui.notified > notified, "sites hear about the change");

  // The wallet now reads the second account.
  ok(await service.handle({ type: "balances" }));
  assert.equal(net.state.balanceAsked.at(-1), two.accounts[1]!.addresses[COSMOS]);

  // Locking and unlocking keeps the list and which one is in use.
  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "add_account" })), "locked");
  const back = ok<Status>(await service.handle({ type: "unlock", password: PASSWORD }));
  assert.deepEqual([back.accounts.length, back.active], [2, 1]);

  // Removing the one in use goes back to the first; a removed phrase account comes back as
  // the same address.
  const one = ok<Status>(await service.handle({ type: "remove_account", index: 1 }));
  assert.deepEqual([one.accounts.length, one.active], [1, 0]);
  const again = ok<Status>(await service.handle({ type: "add_account" }));
  assert.equal(again.accounts[1]!.addresses[EVM], SECOND_EVM);
  // A wallet's last account goes only with the wallet.
  ok(await service.handle({ type: "remove_account", index: 1 }));
  assert.equal(code(await service.handle({ type: "remove_account", index: 0 })), "last_account");
  assert.equal(code(await service.handle({ type: "switch_account", index: 5 })), "bad_request");
  assert.equal(code(await service.handle({ type: "switch_account", index: "1" })), "bad_request");
});

test("accounts: names are cleaned, never empty", async () => {
  const { service } = await wallet();
  const s = ok<Status>(await service.handle({ type: "rename_account", index: 0, name: "  Main‮   savings​ account that is far too long " }));
  assert.equal(s.accounts[0]!.name, "Main savings account th…");
  assert.equal(code(await service.handle({ type: "rename_account", index: 0, name: " ​ " })), "bad_request");
  assert.equal(code(await service.handle({ type: "rename_account", index: 0, name: 5 })), "bad_request");
});

test("accounts: an address to watch shows its balances, never signs, and sites see no account", async () => {
  const { service, net, local } = await wallet();
  local.data.set("connections", { [SITE]: { since: 1 } });
  const site = (method: string) => service.dapp(SITE, { method }) as Promise<{ result?: unknown; error?: { code: number } }>;
  assert.deepEqual(await site("eth_accounts"), { result: [ME_EVM.toLowerCase()] });

  // Either form of the address; the vault fills in the other.
  const s = ok<Status>(await service.handle({ type: "add_watch", address: THEM_EVM.toLowerCase() }));
  const w = s.accounts[1]!;
  assert.deepEqual([w.name, w.account.derivation, w.public_key, w.addresses[COSMOS], w.addresses[EVM], s.active], ["Watching 1", "watch", "", THEM, THEM_EVM, 1]);
  assert.equal(code(await service.handle({ type: "add_watch", address: THEM })), "exists");
  assert.equal(code(await service.handle({ type: "add_watch", address: ME })), "exists");
  for (const bad of ["inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55w", "0x123", "cosmos1npvwllfr9dqr8erajqqr6s0vxnk2ak55fsjtl6", 7]) {
    assert.equal(code(await service.handle({ type: "add_watch", address: bad as string })), "invalid_address", String(bad));
  }

  // Its balances and activity read; a send doesn't get as far as a review.
  const b = await service.handle({ type: "balances" });
  assert.ok(b.ok, `${JSON.stringify(b)} ${net.state.unhandled.join(", ")}`);
  assert.equal(net.state.balanceAsked.at(-1), THEM);
  const page = await service.handle({ type: "activity", page: 1 });
  assert.ok(page.ok, `${JSON.stringify(page)} ${net.state.unhandled.join(", ")}`);
  assert.equal(code(await service.handle({ type: "prepare_send", denom: "inj", to: ME, amount: "1" })), "watch_only");
  assert.equal(code(await service.handle({ type: "prepare_convert", denom: "inj", amount: "1" })), "watch_only");
  // A connected site sees no account while it is in use, and the signing one once back.
  assert.deepEqual(await site("eth_accounts"), { result: [] });
  ok(await service.handle({ type: "switch_account", index: 0 }));
  assert.deepEqual(await site("eth_accounts"), { result: [ME_EVM.toLowerCase()] });
});

test("accounts: a wallet that is one imported key has no others, but can watch", async () => {
  const net = chain();
  const service = serviceOn(net, memory(), memory());
  ok(await service.handle({ type: "create", secret: { private_key: THEM_KEY }, password: PASSWORD }));
  const s = ok<Status>(await service.handle({ type: "status" }));
  assert.deepEqual([s.accounts.length, s.accounts[0]!.account.derivation, s.accounts[0]!.addresses[COSMOS]], [1, "imported", await bech32Of(THEM_KEY)]);
  assert.equal(code(await service.handle({ type: "add_account" })), "no_phrase");
  assert.equal(ok<Status>(await service.handle({ type: "add_watch", address: ME })).accounts.length, 2);
});
