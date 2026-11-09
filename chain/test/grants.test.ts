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
  assert.deepEqual(found, [{ token: T1, spender: S }]);
  const q = new URL(asked).searchParams;
  assert.equal(q.get("action"), "getLogs");
  assert.equal(q.get("topic1"), pad(OWNER));
});
