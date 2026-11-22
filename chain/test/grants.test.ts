// What an account lets others do: grants, fee allowances, the rewards address, CW20 and
// ERC20 allowances. Bodies follow cosmos-sdk v0.50's LCD and Blockscout's getLogs (checked
// on Injective testnet, 2026-11-09).

import assert from "node:assert/strict";
import { test } from "node:test";

import { EvmIndex } from "../src/evmindex.ts";
import { grantedMsg, parseAuthzGrants, parseCw20Allowances, parseFeeGrants, parseWithdrawAddress } from "../src/grants.ts";
import { Down, type Fetch } from "../src/pool.ts";

const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const THEM = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";

test("the message type a grant covers, which a revoke names", () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "/cosmos.bank.v1beta1.MsgSend" }, "/cosmos.bank.v1beta1.MsgSend"],
    [{ "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "not a type" }, null],
    [{ "@type": "/cosmos.bank.v1beta1.SendAuthorization", spend_limit: [] }, "/cosmos.bank.v1beta1.MsgSend"],
    [{ "@type": "/cosmos.staking.v1beta1.StakeAuthorization", authorization_type: "AUTHORIZATION_TYPE_REDELEGATE" }, "/cosmos.staking.v1beta1.MsgBeginRedelegate"],
    [{ "@type": "/cosmos.staking.v1beta1.StakeAuthorization", authorization_type: "AUTHORIZATION_TYPE_UNSPECIFIED" }, null],
    [{ "@type": "/cosmwasm.wasm.v1.ContractExecutionAuthorization" }, "/cosmwasm.wasm.v1.MsgExecuteContract"],
    [{ "@type": "/injective.exchange.v1beta1.CreateSpotLimitOrderAuthz" }, "/injective.exchange.v1beta1.MsgCreateSpotLimitOrder"],
    [{ "@type": "/injective.exchange.v2.BatchUpdateOrdersAuthz" }, "/injective.exchange.v2.MsgBatchUpdateOrders"],
    [{ "@type": "/injective.exchange.v2.SomethingElseAuthz" }, null],
    [{ "@type": "/example.v1.MadeUpAuthorization" }, null],
  ];
  for (const [auth, want] of cases) assert.equal(grantedMsg(auth), want, JSON.stringify(auth));
});

test("authz grants: this granter's only, send limits kept, unreadable types still listed", () => {
  const grants = parseAuthzGrants(
    {
      grants: [
        { granter: ME, grantee: THEM, authorization: { "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "/cosmos.bank.v1beta1.MsgSend" }, expiration: null },
        {
          granter: ME,
          grantee: THEM,
          authorization: { "@type": "/cosmos.bank.v1beta1.SendAuthorization", spend_limit: [{ denom: "inj", amount: "5" }], allow_list: [] },
          expiration: "2027-01-01T00:00:00Z",
        },
        { granter: ME, grantee: THEM, authorization: { "@type": "/example.v1.MadeUpAuthorization" }, expiration: null },
      ],
      pagination: { next_key: null },
    },
    ME,
  );
  assert.deepEqual(
    grants.map((g) => [g.msgTypeUrl, g.expiration]),
    [
      ["/cosmos.bank.v1beta1.MsgSend", null],
      ["/cosmos.bank.v1beta1.MsgSend", "2027-01-01T00:00:00Z"],
      [null, null],
    ],
  );
  assert.deepEqual(grants[1]!.spendLimit, [{ denom: "inj", amount: "5" }]);
  assert.throws(() => parseAuthzGrants({ grants: [{ granter: THEM, grantee: ME, authorization: {} }] }, ME), /another account/);
  assert.throws(() => parseAuthzGrants({ grants: [{ granter: ME, grantee: "nobody", authorization: {} }] }, ME), Down);
});

test("fee grants: the limit and end found inside periodic and message-limited allowances", () => {
  const [basic, wrapped] = parseFeeGrants(
    {
      allowances: [
        { granter: ME, grantee: THEM, allowance: { "@type": "/cosmos.feegrant.v1beta1.BasicAllowance", spend_limit: [], expiration: null } },
        {
          granter: ME,
          grantee: THEM,
          allowance: {
            "@type": "/cosmos.feegrant.v1beta1.AllowedMsgAllowance",
            allowed_messages: ["/cosmos.bank.v1beta1.MsgSend"],
            allowance: {
              "@type": "/cosmos.feegrant.v1beta1.PeriodicAllowance",
              basic: { spend_limit: [{ denom: "inj", amount: "1000" }], expiration: "2027-01-01T00:00:00Z" },
              period: "86400s",
            },
          },
        },
      ],
    },
    ME,
  );
  assert.deepEqual(basic, { grantee: THEM, type: "/cosmos.feegrant.v1beta1.BasicAllowance", spendLimit: [], expiration: null });
  assert.deepEqual(wrapped, {
    grantee: THEM,
    type: "/cosmos.feegrant.v1beta1.AllowedMsgAllowance",
    spendLimit: [{ denom: "inj", amount: "1000" }],
    expiration: "2027-01-01T00:00:00Z",
    allowedMessages: ["/cosmos.bank.v1beta1.MsgSend"],
  });
});

test("rewards address and CW20 allowances", () => {
  assert.equal(parseWithdrawAddress({ withdraw_address: THEM }), THEM);
  assert.throws(() => parseWithdrawAddress({}), Down);
  assert.deepEqual(
    parseCw20Allowances({
      allowances: [
        { spender: THEM, allowance: "500", expires: { never: {} } },
        { spender: ME, allowance: "0", expires: { at_height: 9 } },
      ],
    }),
    [{ spender: THEM, amount: 500n, expires: '{"never":{}}' }],
  );
  assert.throws(() => parseCw20Allowances({ allowances: [{ spender: THEM, allowance: "-1" }] }), Down);
});

test("Blockscout's Approval logs: ERC20 shapes only, each (token, spender) once", async () => {
  const OWNER = "0x9858effd232b4033e47d90003d41ec34ecaeda94"; // the BIP-39 test phrase's account (published)
  const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const log = (token: string, spender: string, extra: Partial<{ topics: (string | null)[]; data: string }> = {}) => ({
    address: token,
    topics: [APPROVAL, pad(OWNER), pad(spender), null],
    data: `0x${"f".repeat(64)}`,
    ...extra,
  });
  const T1 = "0x5555555555555555555555555555555555555555";
  const S = "0x4444444444444444444444444444444444444444";
  let asked = "";
  const fetch: Fetch = async (input) => {
    asked = String(input);
    return new Response(
      JSON.stringify({
        message: "OK",
        status: "1",
        result: [
          log(T1, S),
          log(T1, S, { data: `0x${"0".repeat(64)}` }), // a later approve to 0: still one pair
          log(T1, S, { topics: [APPROVAL, pad(OWNER), pad(S), pad("0x01")] }), // ERC721: 4 topics
          log(T1, S, { topics: [APPROVAL, pad("0x1111111111111111111111111111111111111111"), pad(S), null] }), // someone else's
          log("not an address", S),
        ],
      }),
      { status: 200 },
    );
  };
  const found = await new EvmIndex(["https://blockscout.example"], fetch, 1000).approvals(OWNER);
  // The ERC721 log (4 topics) is an approval of token #1.
  assert.deepEqual(found, { pairs: [{ token: T1, spender: S }], nfts: [{ collection: T1, tokenId: "1" }], complete: true });
  const q = new URL(asked).searchParams;
  assert.equal(q.get("action"), "getLogs");
  assert.equal(q.get("topic1"), pad(OWNER));

  // Run-3: any contract can log Approvals naming the owner. A search that stops at its page
  // cap says so, so the screen never takes it as the whole list.
  let pages = 0;
  const flood: Fetch = async () => {
    pages++;
    return new Response(JSON.stringify({ message: "OK", status: "1", result: Array.from({ length: 1000 }, () => log(T1, S)) }), { status: 200 });
  };
  const capped = await new EvmIndex(["https://blockscout.example"], flood, 1000).approvals(OWNER);
  assert.equal(capped.complete, false);
  assert.equal(pages, 5);
});

test("operators and Permit2 allowances are found from their own logs", async () => {
  const OWNER = "0x1111111111111111111111111111111111111111";
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
  const P2_APPROVAL = "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b";
  const P2_PERMIT = "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec";
  const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const NFT = "0x4444444444444444444444444444444444444444";
  const OP = "0x5555555555555555555555555555555555555555";
  const TOKEN = "0x6666666666666666666666666666666666666666";
  const asked: URLSearchParams[] = [];
  const fetch: Fetch = async (input) => {
    const q = new URL(String(input)).searchParams;
    asked.push(q);
    const topic0 = q.get("topic0");
    const result =
      topic0 === FOR_ALL
        ? [{ address: NFT, topics: [FOR_ALL, pad(OWNER), pad(OP)], data: pad("0x01") }, { address: NFT, topics: [FOR_ALL, pad(OWNER), pad(OP)], data: pad("0x00") }]
        : topic0 === P2_APPROVAL
          ? [{ address: PERMIT2, topics: [P2_APPROVAL, pad(OWNER), pad(TOKEN), pad(OP)], data: "0x" }, { address: NFT, topics: [P2_APPROVAL, pad(OWNER), pad(TOKEN), pad(NFT)], data: "0x" }]
          : topic0 === P2_PERMIT
            ? [{ address: PERMIT2, topics: [P2_PERMIT, pad(OWNER), pad(TOKEN), pad(NFT)], data: "0x" }]
            : [];
    // An Etherscan-style index says "No records found" for none.
    return new Response(JSON.stringify(result.length ? { status: "1", message: "OK", result } : { status: "0", message: "No records found", result: "No records found" }), { status: 200 });
  };
  const index = new EvmIndex(["https://blockscout.example"], fetch, 1000);
  assert.deepEqual(await index.operators(OWNER), { pairs: [{ collection: NFT, operator: OP }], complete: true });
  // Only Permit2's own logs count: the look-alike from another contract is dropped.
  assert.deepEqual(await index.permit2Approvals(OWNER, PERMIT2), {
    pairs: [
      { token: TOKEN, spender: OP },
      { token: TOKEN, spender: NFT },
    ],
    complete: true,
  });
  assert.ok(asked.some((q) => q.get("address") === PERMIT2));
  assert.deepEqual(await index.approvals(OWNER), { pairs: [], nfts: [], complete: true });
});
