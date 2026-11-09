// The address book and exchange memos through the service, against the real WASM vault and
// a fake chain: contacts are checked and kept, and every send's review knows them, the
// user's own accounts, and recipients whose deposits carry a memo.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, code, exchangeDeposits, INJ, LUMA, ME, ok, THEM, wallet } from "./fake";

type Contact = { id: string; name: string; address: string; evm: string; memo: string };
type Review = { digest: string; risk: { level: string; findings: { rule: string; message: string }[] } };

// Test addresses made of one repeated byte: they belong to no one.
const EXCHANGE_EVM = "0x7777777777777777777777777777777777777777";

const rules = (r: Review) => r.risk.findings.map((f) => f.rule);

test("contacts: checked, kept in both forms, edited and removed", async () => {
  const { service, local } = await wallet();
  const [c] = ok<Contact[]>(await service.handle({ type: "save_contact", name: " My exchange ", address: EXCHANGE_EVM, memo: " 101234567 " }));
  assert.ok(c!.address.startsWith("inj1"));
  assert.equal(c!.evm, EXCHANGE_EVM);
  assert.equal(c!.name, "My exchange");
  assert.equal(c!.memo, "101234567");
  assert.deepEqual(ok<Contact[]>(await service.handle({ type: "contacts" })), [c]);

  // The same account in its other form, the user's own account, and things that aren't contacts.
  const bad: [Record<string, unknown>, string][] = [
    [{ name: "Again", address: c!.address, memo: "" }, "already_saved"],
    [{ name: "Me", address: ME, memo: "" }, "already_saved"],
    [{ name: "Typo", address: "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dx", memo: "" }, "invalid_address"],
    // 32 bytes: a contract's length, not an account.
    [{ name: "Contract", address: "inj1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sax6t9f", memo: "" }, "invalid_address"],
    [{ name: "   ", address: THEM, memo: "" }, "bad_request"],
    [{ name: "x".repeat(41), address: THEM, memo: "" }, "bad_request"],
    [{ name: "Lines", address: THEM, memo: "one\ntwo" }, "bad_request"],
    [{ name: "Long", address: THEM, memo: "é".repeat(129) }, "bad_request"],
  ];
  for (const [req, want] of bad) assert.equal(code(await service.handle({ type: "save_contact", ...req } as never)), want, JSON.stringify(req));
  const mine = await service.handle({ type: "save_contact", name: "Me", address: ME, memo: "" });
  assert.match(JSON.stringify(mine), /That's your account Account 1/);

  // Edit by id; the list stays sorted by name.
  ok(await service.handle({ type: "save_contact", name: "Alice", address: THEM, memo: "" }));
  const edited = ok<Contact[]>(await service.handle({ type: "save_contact", id: c!.id, name: "Zed exchange", address: EXCHANGE_EVM, memo: "7" }));
  assert.deepEqual(
    edited.map((x) => [x.name, x.memo]),
    [
      ["Alice", ""],
      ["Zed exchange", "7"],
    ],
  );
  assert.equal(code(await service.handle({ type: "save_contact", id: "0000000000000000", name: "Gone", address: EXCHANGE_EVM, memo: "" })), "not_found");
  assert.equal(ok<Contact[]>(await service.handle({ type: "remove_contact", id: c!.id })).length, 1);
  assert.equal(code(await service.handle({ type: "remove_contact", id: c!.id })), "not_found");

  // Locked: none of it.
  ok(await service.handle({ type: "lock" }));
  assert.equal(code(await service.handle({ type: "contacts" })), "locked");
  assert.ok(local.data.has("address_book"));
});

test("a saved memo: the send must carry it", async () => {
  const net = chain();
  const { service } = await wallet(net);
  const [c] = ok<Contact[]>(await service.handle({ type: "save_contact", name: "My exchange", address: EXCHANGE_EVM, memo: "101234567" }));
  const send = (memo?: string) => service.handle({ type: "prepare_send", denom: "inj", to: c!.address, amount: INJ.toString(), ...(memo === undefined ? {} : { memo }) });

  const none = ok<Review>(await send());
  assert.equal(none.risk.level, "red");
  assert.deepEqual(rules(none), ["memo_missing", "address_book"]);
  assert.equal(none.risk.findings[0]!.message, "My exchange needs memo 101234567. This send has none.");
  assert.equal(rules(ok<Review>(await send("1"))).join(), "memo_differs,address_book");

  const right = ok<Review>(await send("101234567"));
  assert.equal(right.risk.level, "info");
  assert.deepEqual(rules(right), ["address_book"]);
  ok(await service.handle({ type: "confirm_send", digest: right.digest }));
  assert.ok(Buffer.from(net.state.broadcasts[0]!, "base64").includes(Buffer.from("101234567")));
  // A saved memo settles it: the chain isn't asked.
  assert.deepEqual(net.state.depositChecks, []);

  assert.equal(code(await send("a\u0000b")), "bad_request");
});

test("an exchange found on the chain: its deposits carry memos, so a send needs one", async () => {
  const net = chain();
  const { service } = await wallet(net);
  // The exchange's inj1 form, through the vault.
  const [c] = ok<Contact[]>(await service.handle({ type: "save_contact", name: "tmp", address: EXCHANGE_EVM, memo: "" }));
  ok(await service.handle({ type: "remove_contact", id: c!.id }));
  const exchange = c!.address;
  net.state.deposits[exchange] = exchangeDeposits(exchange);

  assert.deepEqual(ok(await service.handle({ type: "check_recipient", to: EXCHANGE_EVM })), { takesMemo: true });
  const none = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: exchange, amount: INJ.toString() }));
  assert.equal(none.risk.level, "red");
  assert.match(none.risk.findings[0]!.message, /looks like an exchange: its deposits carry a memo\. This send has none\./);
  const tagged = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: exchange, amount: INJ.toString(), memo: "12345" }));
  assert.deepEqual(rules(tagged), []);
  // Asked once, then remembered.
  assert.deepEqual(net.state.depositChecks, [exchange]);

  // An ordinary account isn't one; the user's own accounts aren't asked.
  assert.deepEqual(ok(await service.handle({ type: "check_recipient", to: THEM })), { takesMemo: false });
  assert.deepEqual(ok(await service.handle({ type: "check_recipient", to: ME })), { mine: "Account 1", takesMemo: false });
  assert.deepEqual(ok(await service.handle({ type: "check_recipient", to: "not an address" })), { takesMemo: false });
  assert.deepEqual(net.state.depositChecks, [exchange, THEM]);
});

test("an EVM-only token's send can't carry a memo", async () => {
  const net = chain({ evm: { [LUMA]: 3000n * INJ } });
  const { service } = await wallet(net);
  ok(await service.handle({ type: "save_contact", name: "My exchange", address: EXCHANGE_EVM, memo: "101234567" }));
  const send = (memo?: string) => service.handle({ type: "prepare_send", denom: `evm:${LUMA}`, to: EXCHANGE_EVM, amount: INJ.toString(), ...(memo ? { memo } : {}) });
  assert.equal(code(await send("101234567")), "bad_request");
  const r = ok<Review>(await send());
  assert.equal(r.risk.level, "red");
  assert.equal(rules(r)[0], "memo_unsupported");
  assert.equal(r.risk.findings[0]!.message, "My exchange needs memo 101234567, which an EVM send can't carry.");
});

test("the user's own accounts are named in reviews", async () => {
  const { service } = await wallet();
  const status = ok<{ accounts: { addresses: Record<string, string> }[] }>(await service.handle({ type: "add_account" }));
  const second = status.accounts[1]!.addresses["cosmos:injective-1"]!;
  ok(await service.handle({ type: "switch_account", index: 0 }));
  const r = ok<Review>(await service.handle({ type: "prepare_send", denom: "inj", to: second, amount: INJ.toString() }));
  assert.equal(r.risk.findings.find((f) => f.rule === "address_book")?.message, "To your account Account 2.");
});
