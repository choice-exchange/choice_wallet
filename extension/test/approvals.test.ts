// Approvals and grants through the service: what the account lets others do, and taking it
// back. Against the real WASM vault and a fake chain.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, CW, code, LUMA, ME_EVM, ok, THEM, wallet } from "./fake";

type Summary = {
  grants: { grantee: string; msgTypeUrl: string | null }[];
  feeGrants: { grantee: string; spendLimit: unknown[] }[];
  rewardsTo: string | null;
  cw20: { token: string; spender: string; amount: string }[];
  erc20: { token: string; spender: string; amount: string }[];
  tokens: Record<string, { symbol: string }>;
  evmIndexDown?: true;
};
type Review = { digest: string; display: { messages?: Record<string, unknown>[]; data?: string; to?: string }; risk: { level: string; findings: { rule: string }[] } };

const SPENDER = "0x4444444444444444444444444444444444444444";
const SPENT = "0x5555555555555555555555555555555555555555";

function granted() {
  const net = chain({ cw20: { [CW]: 3n * 10n ** 18n } });
  net.state.grants = [
    { grantee: THEM, authorization: { "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "/cosmos.bank.v1beta1.MsgSend" }, expiration: null },
    { grantee: THEM, authorization: { "@type": "/example.v1.MadeUpAuthorization" }, expiration: null },
  ];
  net.state.feeGrants = [{ grantee: THEM, allowance: { "@type": "/cosmos.feegrant.v1beta1.BasicAllowance", spend_limit: [], expiration: null } }];
  net.state.rewardsTo = THEM;
  net.state.cw20Allowances = { [CW]: [{ spender: THEM, allowance: "500" }] };
  // Two approvals ever made on LUMA; one has since been spent down to nothing.
  net.state.approvalLogs = [
    { token: LUMA, spender: SPENDER },
    { token: LUMA, spender: SPENT },
  ];
  net.state.erc20Allowance = { [`${LUMA} ${SPENDER}`]: 2n ** 256n - 1n };
  return net;
}

test("approvals: grants, fee grants, rewards address, CW20 and ERC20 allowances", async () => {
  const net = granted();
  const { service } = await wallet(net);
  ok(await service.handle({ type: "add_token", address: CW }));
  const s = ok<Summary>(await service.handle({ type: "approvals" }));
  assert.deepEqual(
    s.grants.map((g) => [g.grantee, g.msgTypeUrl]),
    [
      [THEM, "/cosmos.bank.v1beta1.MsgSend"],
      [THEM, null],
    ],
  );
  assert.deepEqual(
    s.feeGrants.map((g) => [g.grantee, g.spendLimit]),
    [[THEM, []]],
  );
  assert.equal(s.rewardsTo, THEM);
  assert.deepEqual(s.cw20, [{ token: `cw20:${CW}`, spender: THEM, amount: "500", expires: '{"never":{}}' }]);
  // Only what is left: the spent approval is gone.
  assert.deepEqual(s.erc20, [{ token: `evm:${LUMA}`, spender: SPENDER, amount: (2n ** 256n - 1n).toString() }]);
  assert.equal(s.tokens[`evm:${LUMA}`]?.symbol, "LUMA");
  assert.equal(s.tokens[`cw20:${CW}`]?.symbol, "SHROOM");
  assert.ok(net.state.blockscoutCalls.some((q) => q.includes("action=getLogs") && q.includes(ME_EVM.slice(2).toLowerCase())));
  assert.deepEqual(net.state.unhandled, []);

  // Blockscout down: the rest still shows, with a note.
  net.state.blockscout = "down";
  const partial = ok<Summary>(await service.handle({ type: "approvals" }));
  assert.equal(partial.evmIndexDown, true);
  assert.deepEqual(partial.erc20, []);
  assert.equal(partial.grants.length, 2);
});

test("revoke: the Cosmos side in one transaction, graded Info, signed as reviewed", async () => {
  const net = granted();
  const { service } = await wallet(net);
  const review = ok<Review>(
    await service.handle({
      type: "prepare_revoke",
      items: [
        { type: "authz", grantee: THEM, msg_type_url: "/cosmos.bank.v1beta1.MsgSend" },
        { type: "fee", grantee: THEM },
        { type: "rewards" },
        { type: "cw20", contract: CW, spender: THEM, amount: "500" },
      ],
    }),
  );
  assert.deepEqual(
    review.display.messages!.map((m) => m["type"]),
    ["authz_revoke", "fee_revoke", "set_withdraw_address", "execute_contract"],
  );
  assert.equal(review.risk.level, "info");
  assert.deepEqual(
    review.risk.findings.map((f) => f.rule),
    ["authz_revoke", "fee_revoke", "allowance_decrease"],
  );
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  const tx = Buffer.from(net.state.broadcasts[0]!, "base64");
  for (const t of ["/cosmos.authz.v1beta1.MsgRevoke", "/cosmos.feegrant.v1beta1.MsgRevokeAllowance", "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress", "decrease_allowance"]) {
    assert.ok(tx.includes(Buffer.from(t)), t);
  }

  for (const bad of [[], [{ type: "authz", grantee: THEM, msg_type_url: "MsgSend" }], [{ type: "cw20", contract: CW, spender: THEM, amount: "0" }], [{ type: "grant_all" }]]) {
    assert.equal(code(await service.handle({ type: "prepare_revoke", items: bad as never })), "bad_request", JSON.stringify(bad));
  }
});

test("revoke an ERC20 allowance: approve(spender, 0) on the token", async () => {
  const net = granted();
  const { service } = await wallet(net);
  const review = ok<Review>(await service.handle({ type: "prepare_revoke_erc20", token: `evm:${LUMA}`, spender: SPENDER }));
  assert.equal(review.display.to?.toLowerCase(), LUMA);
  assert.equal(review.display.data, `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${"0".repeat(64)}`);
  assert.ok(review.risk.findings.some((f) => f.rule === "allowance_revoke"));
  ok(await service.handle({ type: "confirm_send", digest: review.digest }));
  assert.equal(net.state.evmSent.length, 1);
  assert.equal(code(await service.handle({ type: "prepare_revoke_erc20", token: LUMA, spender: SPENDER })), "bad_request");
});

test("a watched account sees its approvals but can't revoke", async () => {
  const { service } = await wallet(granted());
  ok(await service.handle({ type: "add_watch", address: "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v" }));
  ok(await service.handle({ type: "approvals" }));
  assert.equal(code(await service.handle({ type: "prepare_revoke", items: [{ type: "rewards" }] })), "watch_only");
  assert.equal(code(await service.handle({ type: "prepare_revoke_erc20", token: `evm:${LUMA}`, spender: SPENDER })), "watch_only");
});
