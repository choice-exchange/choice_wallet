// Staking reads. Bodies follow what Injective mainnet sent on 2026-11-09.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import { Down, type Fetch } from "../src/pool.ts";
import { floorDecimal, parseDelegations, parseRewards, parseUnbonding, parseUnbondingTime, parseValidators } from "../src/staking.ts";

const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const V1 = "injvaloper1qzu3s7uzydpj0vcgrgp04j7u48pgkesy7zl7t3";
const V2 = "injvaloper1acgud5qpn3frwzjrayqcdsdr9vkl3p6hrz34ts";

const validator = (address: string, tokens: string, extra: Record<string, unknown> = {}) => ({
  operator_address: address,
  jailed: false,
  status: "BOND_STATUS_BONDED",
  tokens,
  delegator_shares: `${tokens}.000000000000000000`,
  description: { moniker: "Neptune Foundation", identity: "", website: "nept.finance", details: "" },
  commission: { commission_rates: { rate: "0.200000000000000000", max_rate: "0.200000000000000000", max_change_rate: "0.010000000000000000" } },
  ...extra,
});

test("validators: names cleaned, commission as a fraction, bad records refused", () => {
  const [v] = parseValidators({
    validators: [validator(V1, "255833301179852285998802", { description: { moniker: "Nep‮tune\n\n  Foundation", website: "nept.finance" } })],
  });
  assert.deepEqual(v, { address: V1, moniker: "Neptune Foundation", website: "nept.finance", commission: 0.2, tokens: 255833301179852285998802n, jailed: false });
  const long = parseValidators({ validators: [validator(V1, "1", { description: { moniker: "x".repeat(60) } })] })[0]!;
  assert.equal([...long.moniker].length, 40);
  for (const bad of [
    validator("inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz", "1"),
    validator(V1, "-1"),
    validator(V1, "1", { commission: { commission_rates: { rate: "1.5" } } }),
    validator(V1, "1", { commission: {} }),
  ]) {
    assert.throws(() => parseValidators({ validators: [bad] }), Down);
  }
});

test("delegations: only the bond denom, only this account", () => {
  const body = {
    delegation_responses: [
      { delegation: { delegator_address: ME, validator_address: V1, shares: "5.0" }, balance: { denom: "inj", amount: "5000000000000000000" } },
      { delegation: { delegator_address: ME, validator_address: V2, shares: "0.1" }, balance: { denom: "inj", amount: "0" } },
    ],
  };
  assert.deepEqual(parseDelegations(body, ME, "inj"), [{ validator: V1, amount: 5000000000000000000n }]);
  assert.throws(() => parseDelegations(body, "inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8", "inj"), /another account/);
});

test("unbonding: one row per entry, soonest first", () => {
  const rows = parseUnbonding(
    {
      unbonding_responses: [
        {
          delegator_address: ME,
          validator_address: V1,
          entries: [
            { creation_height: "200", completion_time: "2026-12-01T00:00:00Z", initial_balance: "3", balance: "3" },
            { creation_height: "100", completion_time: "2026-11-20T00:00:00.5Z", initial_balance: "2", balance: "2" },
          ],
        },
      ],
    },
    ME,
  );
  assert.deepEqual(
    rows.map((r) => [r.height, r.amount]),
    [
      [100n, 2n],
      [200n, 3n],
    ],
  );
  assert.throws(() => parseUnbonding({ unbonding_responses: [{ delegator_address: ME, validator_address: V1, entries: [{ creation_height: "1", completion_time: "soon", balance: "1" }] }] }, ME), Down);
});

test("rewards: decimals rounded down, dust and other denoms dropped", () => {
  const r = parseRewards(
    {
      rewards: [
        { validator_address: V1, reward: [{ denom: "inj", amount: "1234.999999999999999999" }, { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "9.0" }] },
        { validator_address: V2, reward: [{ denom: "inj", amount: "0.500000000000000000" }] },
      ],
      total: [],
    },
    "inj",
  );
  assert.deepEqual([...r], [[V1, 1234n]]);
  assert.equal(floorDecimal("7"), 7n);
  assert.throws(() => floorDecimal("1e18"), Down);
  assert.throws(() => floorDecimal("-1.0"), Down);
});

test("staking params: the unbonding time in seconds", () => {
  assert.equal(parseUnbondingTime({ params: { unbonding_time: "1814400s", bond_denom: "inj" } }), 1814400);
  assert.throws(() => parseUnbondingTime({ params: { unbonding_time: "21 days" } }), Down);
});

test("the LCD client: validators by power across pages, a fresh account has nothing staked", async () => {
  const fetch: Fetch = async (input) => {
    const url = new URL(input);
    const p = url.pathname;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (p.endsWith("/node_info")) return reply(200, { default_node_info: { network: "injective-1" } });
    if (p === "/cosmos/staking/v1beta1/validators") {
      assert.equal(url.searchParams.get("status"), "BOND_STATUS_BONDED");
      return url.searchParams.get("pagination.key")
        ? reply(200, { validators: [validator(V2, "900")], pagination: { next_key: null } })
        : reply(200, { validators: [validator(V1, "10")], pagination: { next_key: "abc=" } });
    }
    if (p.startsWith("/cosmos/staking/v1beta1/delegations/")) return reply(404, { code: 5, message: "not found" });
    if (p.endsWith("/unbonding_delegations")) return reply(200, { unbonding_responses: [], pagination: {} });
    if (p.endsWith("/rewards")) return reply(200, { rewards: [], total: [] });
    if (p === "/cosmos/staking/v1beta1/params") return reply(200, { params: { unbonding_time: "1814400s" } });
    return reply(404, { code: 12, message: "Not Implemented" });
  };
  const lcd = new Lcd(NETWORKS.mainnet, ["https://a.example"], fetch, 1000);
  assert.deepEqual(
    (await lcd.validators()).map((v) => v.address),
    [V2, V1],
  );
  assert.deepEqual(await lcd.delegations(ME), []);
  assert.deepEqual(await lcd.unbonding(ME), []);
  assert.equal((await lcd.rewards(ME)).size, 0);
  assert.equal(await lcd.unbondingTime(), 1814400);
});
