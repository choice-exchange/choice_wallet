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
  unchecked: string[];
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
  // What the wallet can't read yet is named, so the screen never says nothing stands (run-3).
  // Run-4: classes the wallet signs for but has no reader for are always named.
  assert.deepEqual(s.unchecked, [
    "Solana token delegates, close and stake authorities",
    "CW20 allowances on CW20s the wallet doesn't list or you no longer hold",
    "ERC-777 operators",
    "signed but unfilled Seaport orders and Permit2 or token permits",
    "other EVM chains (pick one above)",
  ]);
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
        { type: "cw20", contract: CW, spender: THEM },
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
  // Hardening: down by the most there can be, so an LCD that under-reports the allowance
  // can't leave some of it in place.
  assert.ok(tx.includes(Buffer.from('"amount":"340282366920938463463374607431768211455"')), "decreased by the maximum");

  for (const bad of [[], [{ type: "authz", grantee: THEM, msg_type_url: "MsgSend" }], [{ type: "cw20", contract: CW, spender: "" }], [{ type: "grant_all" }]]) {
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

// Run-3 follow-up: NFT operators, single-NFT approvals and Permit2 allowances are read and
// can be taken back, each graded as a revoke.
test("approvals: NFT operators, NFT approvals and Permit2 allowances, read and revoked", async () => {
  const net = chain();
  const NFT = "0x7777777777777777777777777777777777777777";
  const OP = "0x8888888888888888888888888888888888888888";
  const GONE = "0x9999999999999999999999999999999999999999";
  net.state.operatorLogs = [
    { collection: NFT, operator: OP },
    { collection: NFT, operator: GONE },
  ];
  net.state.nftOperatorOn = { [`${NFT} ${OP}`]: true };
  net.state.nftApprovalLogs = [
    { collection: NFT, tokenId: "7", approved: OP },
    { collection: NFT, tokenId: "8", approved: OP },
  ];
  net.state.nftApproved = { [`${NFT} 7`]: OP };
  net.state.permit2Logs = [{ token: LUMA, spender: SPENDER }];
  net.state.permit2 = { [`${LUMA.toLowerCase()} ${SPENDER}`]: { amount: 2n ** 160n - 1n, expiration: 4_000_000_000 } };
  const { service } = await wallet(net);
  type Full = Summary & { nftOperators: { collection: string; operator: string }[]; nftApprovals: { collection: string; tokenId: string; approved: string }[]; permit2: { token: string; spender: string; amount: string }[]; chains: { key: string }[] };
  const s = ok<Full>(await service.handle({ type: "approvals" }));
  assert.deepEqual(s.nftOperators, [{ collection: NFT, operator: OP }], "a revoked operator isn't listed");
  assert.deepEqual(s.nftApprovals, [{ collection: NFT, tokenId: "7", approved: OP }], "an approval since cleared isn't listed");
  assert.deepEqual(s.permit2.map((p) => [p.token, p.spender]), [[`evm:${LUMA.toLowerCase()}`, SPENDER]]);
  assert.ok(!s.unchecked.includes("NFT approvals") && !s.unchecked.includes("Permit2 allowances"));
  assert.ok(s.chains.some((c) => c.key === "ethereum"), "other chains with a history index can be picked");

  type Rev = { risk: { level: string; findings: { rule: string }[] }; display: { to: string } };
  const all = ok<Rev>(await service.handle({ type: "prepare_revoke_evm", kind: "nft_all", contract: NFT, spender: OP }));
  assert.deepEqual([all.risk.level, all.risk.findings.map((f) => f.rule)], ["info", ["nft_approval_revoke"]]);
  const one = ok<Rev>(await service.handle({ type: "prepare_revoke_evm", kind: "nft_token", contract: NFT, token_id: "7" }));
  assert.deepEqual([one.risk.level, one.risk.findings.map((f) => f.rule)], ["info", ["approval_clear"]]);
  // Run-4: two steps. First the permits signed for it are cancelled (its nonce moved past
  // them, by Permit2's most); once that lands, the allowance is taken back.
  const P2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const pair = `${LUMA.toLowerCase()} ${SPENDER}`;
  net.state.permit2[pair]!.nonce = 3;
  const first = ok<Rev & { display: { call: Record<string, unknown> } }>(await service.handle({ type: "prepare_revoke_evm", kind: "permit2", contract: P2, token: LUMA, spender: SPENDER }));
  assert.deepEqual([first.risk.level, first.risk.findings.map((f) => f.rule)], ["info", ["permit2_cancel"]]);
  assert.equal(first.display.call["selector"], "0x65d9723c");
  // Not landed yet: the same first step again, and the screen doesn't say it's done.
  assert.deepEqual(ok<Rev>(await service.handle({ type: "prepare_revoke_evm", kind: "permit2", contract: P2, token: LUMA, spender: SPENDER })).risk.findings.map((f) => f.rule), ["permit2_cancel"]);
  assert.equal(ok<Full & { permit2: { permitsCancelled?: boolean }[] }>(await service.handle({ type: "approvals" })).permit2[0]?.permitsCancelled, undefined);
  net.state.permit2[pair]!.nonce = 3 + 65_535;
  assert.equal(ok<Full & { permit2: { permitsCancelled?: boolean }[] }>(await service.handle({ type: "approvals" })).permit2[0]?.permitsCancelled, true);
  const p2 = ok<Rev>(await service.handle({ type: "prepare_revoke_evm", kind: "permit2", contract: P2, token: LUMA, spender: SPENDER }));
  assert.deepEqual([p2.risk.level, p2.risk.findings.map((f) => f.rule)], ["info", ["allowance_revoke"]]);
  // A Permit2 revoke goes only to Permit2.
  assert.equal((await service.handle({ type: "prepare_revoke_evm", kind: "permit2", contract: NFT, token: LUMA, spender: SPENDER })).ok, false);
});

test("approvals name Seaport and Talis's contracts; Talis's only on Injective", async () => {
  const net = chain();
  const NFT = "0x7777777777777777777777777777777777777777";
  const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
  const AUCTION = "0xa4174A3aA35a04Fc6fA53817E74416B61CcC2C5F";
  net.state.operatorLogs = [{ collection: NFT, operator: SEAPORT }];
  net.state.nftOperatorOn = { [`${NFT} ${SEAPORT.toLowerCase()}`]: true };
  const { service } = await wallet(net);
  type Named = { nftOperators: { operator: string }[]; names?: Record<string, string> };
  const s = ok<Named>(await service.handle({ type: "approvals" }));
  assert.deepEqual(s.nftOperators.map((o) => o.operator.toLowerCase()), [SEAPORT.toLowerCase()]);
  assert.equal(s.names?.[SEAPORT.toLowerCase()], "Seaport");
  assert.equal(s.names?.[AUCTION.toLowerCase()], "Talis auction");
  assert.equal(s.names?.["0x000000000022d473030f116ddee9f6b43ac78ba3"], "Permit2");
  const other = ok<Named>(await service.handle({ type: "approvals", chain: "base" }));
  assert.equal(other.names?.[SEAPORT.toLowerCase()], "Seaport", "Seaport is at one address on every chain");
  assert.equal(other.names?.[AUCTION.toLowerCase()], undefined, "Talis's addresses are Injective's");
  // Taking Seaport's access back is named in the review.
  type Rev = { risk: { level: string; findings: { rule: string; message: string }[] } };
  const r = ok<Rev>(await service.handle({ type: "prepare_revoke_evm", kind: "nft_all", contract: NFT, spender: SEAPORT }));
  assert.deepEqual(
    r.risk.findings.map((f) => [f.rule, f.message]),
    [["nft_approval_revoke", "Removes Seaport's access to your NFTs in this collection."]],
  );
  // Run-4: a revoke only pauses listings signed before it; they can all be cancelled.
  const c = ok<Rev & { display: { call: Record<string, unknown> } }>(await service.handle({ type: "prepare_revoke_evm", kind: "seaport_cancel", contract: SEAPORT }));
  assert.deepEqual([c.risk.level, c.risk.findings.map((f) => [f.rule, f.message])], ["info", [["seaport_cancel", "Cancels every Seaport listing you signed."]]]);
  assert.equal(c.display.call["selector"], "0x5b34b966");
  assert.equal((await service.handle({ type: "prepare_revoke_evm", kind: "seaport_cancel", contract: NFT })).ok, false);
});

test("approvals on another EVM chain: only where the user looks, revoked there", async () => {
  const net = chain();
  const { service } = await wallet(net);
  // Base has no history index by default: nothing is asked, and the screen says so.
  const base = ok<{ chain?: string; erc20: unknown[]; unchecked: string[] }>(await service.handle({ type: "approvals", chain: "base" }));
  assert.equal(base.chain, "base");
  assert.deepEqual(base.erc20, []);
  assert.ok(base.unchecked.some((u) => /EVM history is off/.test(u)), base.unchecked.join());
  assert.equal((await service.handle({ type: "approvals", chain: "nowhere" })).ok, false);
  // A revoke there is built and graded on that chain.
  const NFT = "0x7777777777777777777777777777777777777777";
  const r = ok<{ risk: { level: string; findings: { rule: string }[] }; display: { chain: string } }>(
    await service.handle({ type: "prepare_revoke_evm", chain: "base", kind: "nft_all", contract: NFT, spender: "0x8888888888888888888888888888888888888888" }),
  );
  assert.deepEqual([r.display.chain, r.risk.level, r.risk.findings.map((f) => f.rule)], ["eip155:8453", "info", ["nft_approval_revoke"]]);
});

test("approvals: CW721 operators and NFT approvals, read and revoked in one transaction", async () => {
  const net = chain();
  const NFT = "inj10el8uln70el8uln70el8uln70el8uln70el8uln70el8uln70elqdgup33";
  net.state.cw721 = { [NFT]: { tokens: ["7", "8"], operators: [THEM], approvals: { "7": [THEM] } } };
  const { service, local } = await wallet(net);
  await local.set({ custom_nfts: { mainnet: [NFT] } });
  type Cw = { cw721Operators: { collection: string; operator: string }[]; cw721Approvals: { collection: string; tokenId: string; spender: string }[]; unchecked: string[] };
  const s = ok<Cw>(await service.handle({ type: "approvals" }));
  assert.deepEqual(s.cw721Operators, [{ collection: NFT, operator: THEM }]);
  assert.deepEqual(s.cw721Approvals, [{ collection: NFT, tokenId: "7", spender: THEM }]);
  assert.ok(!s.unchecked.some((u) => /CW721/.test(u)), s.unchecked.join());
  type Rev = { risk: { level: string; findings: { rule: string }[] } };
  const r = ok<Rev>(
    await service.handle({
      type: "prepare_revoke",
      items: [
        { type: "cw721_all", contract: NFT, operator: THEM },
        { type: "cw721_token", contract: NFT, spender: THEM, token_id: "7" },
      ],
    }),
  );
  assert.equal(r.risk.level, "info");
  assert.deepEqual(r.risk.findings.map((f) => f.rule).filter((x) => x === "nft_approval_revoke"), ["nft_approval_revoke", "nft_approval_revoke"]);
});
