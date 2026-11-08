// Activity from indexed transactions. Event shapes as Injective mainnet's LCD returns them
// (recorded 2026-11-09): bank `coin_spent` / `coin_received` / `transfer`, and the ante
// handler's `tx` event with `fee` and `fee_payer`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeActivity, parseCoins, summarize } from "../src/activity.ts";
import { Lcd } from "../src/lcd.ts";
import { NETWORKS } from "../src/networks.ts";
import type { IndexedTx, TxEvent } from "../src/lcd.ts";

const ME = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const THEM = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
const FEE_COLLECTOR = "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9";
const POOL = "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpool";
const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
const JUNK = "factory/inj1junk/claim";
const FEE = "17216480000000";

const ev = (type: string, attrs: Record<string, string>): TxEvent => ({
  type,
  attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
});
const move = (from: string, to: string, amount: string): TxEvent[] => [
  ev("coin_spent", { spender: from, amount }),
  ev("coin_received", { receiver: to, amount }),
  ev("transfer", { recipient: to, sender: from, amount }),
];
const feePaidBy = (who: string): TxEvent[] => [...move(who, FEE_COLLECTOR, `${FEE}inj`), ev("tx", { fee: `${FEE}inj`, fee_payer: who })];

function tx(height: number, messages: Record<string, unknown>[], events: TxEvent[], code = 0): IndexedTx {
  return {
    hash: height.toString(16).padStart(64, "0").toUpperCase(),
    height: BigInt(height),
    time: "2026-11-09T08:00:00Z",
    code,
    messages,
    fee: [{ denom: "inj", amount: FEE }],
    events,
  };
}
const send = (from: string, to: string, amount: string) => ({
  "@type": "/cosmos.bank.v1beta1.MsgSend",
  from_address: from,
  to_address: to,
  amount: parseCoins(amount),
});

test("event amounts parse as coin lists", () => {
  assert.deepEqual(parseCoins(`1500inj,2500000${USDT}`), [
    { denom: "inj", amount: "1500" },
    { denom: USDT, amount: "2500000" },
  ]);
  assert.deepEqual(parseCoins(""), []);
  assert.deepEqual(parseCoins("12"), []);
});

test("a send: the amount out, the fee apart, the recipient", () => {
  const a = summarize(tx(10, [send(ME, THEM, "1500000000000000000inj")], [...feePaidBy(ME), ...move(ME, THEM, "1500000000000000000inj")]), ME);
  assert.equal(a.kind, "send");
  assert.equal(a.counterparty, THEM);
  assert.equal(a.signed, true);
  assert.deepEqual(a.changes, [{ denom: "inj", amount: "-1500000000000000000" }]);
  assert.deepEqual(a.fee, [{ denom: "inj", amount: FEE }]);
  assert.equal(a.ok, true);
});

test("a receive: someone else's send, no fee on us", () => {
  const a = summarize(tx(11, [send(THEM, ME, `2500000${USDT}`)], [...feePaidBy(THEM), ...move(THEM, ME, `2500000${USDT}`)]), ME);
  assert.equal(a.kind, "receive");
  assert.equal(a.counterparty, THEM);
  assert.equal(a.signed, false);
  assert.deepEqual(a.changes, [{ denom: USDT, amount: "2500000" }]);
  assert.deepEqual(a.fee, []);
});

test("a swap through a contract: one token out, one in", () => {
  const exec = { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: ME, contract: POOL, msg: {}, funds: [] };
  const a = summarize(tx(12, [exec], [...feePaidBy(ME), ...move(ME, POOL, "1000000000000000000inj"), ...move(POOL, ME, `8100000${USDT}`)]), ME);
  assert.equal(a.kind, "swap");
  assert.deepEqual(a.changes, [
    { denom: "inj", amount: "-1000000000000000000" },
    { denom: USDT, amount: "8100000" },
  ]);
  // Two tokens out for one in (adding liquidity) is a contract call, not a swap.
  const lp = summarize(
    tx(13, [exec], [...feePaidBy(ME), ...move(ME, POOL, "1inj"), ...move(ME, POOL, `1${USDT}`), ...move(POOL, ME, "5factory/inj1pool/lp")]),
    ME,
  );
  assert.equal(lp.kind, "contract");
  assert.equal(lp.counterparty, POOL);
});

test("an airdrop through someone else's contract call reads as a receive from the contract", () => {
  const exec = { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: THEM, contract: POOL, msg: {}, funds: [] };
  const a = summarize(tx(14, [exec], [...feePaidBy(THEM), ...move(POOL, ME, `1000000${JUNK}`)]), ME);
  assert.equal(a.kind, "receive");
  assert.equal(a.counterparty, POOL);
  assert.deepEqual(a.changes, [{ denom: JUNK, amount: "1000000" }]);
});

// SHROOM's CW20 and the mainnet CW20 adapter (both published contracts).
const CW = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const ADAPTER = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";
const BANK_FORM = `factory/${ADAPTER}/${CW}`;
const wasm = (attrs: Record<string, string>) => ev("wasm", { _contract_address: CW, ...attrs });

test("CW20 tokens: a transfer is a send, someone else's is a receive", () => {
  const exec = { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: ME, contract: CW, msg: { transfer: { recipient: THEM, amount: "5" } }, funds: [] };
  const out = summarize(tx(30, [exec], [...feePaidBy(ME), wasm({ action: "transfer", from: ME, to: THEM, amount: "5" })]), ME);
  assert.equal(out.kind, "send");
  assert.equal(out.counterparty, THEM);
  assert.deepEqual(out.changes, [{ denom: `cw20:${CW}`, amount: "-5" }]);

  const theirs = { ...exec, sender: THEM, msg: { transfer: { recipient: ME, amount: "7" } } };
  const back = summarize(tx(31, [theirs], [...feePaidBy(THEM), wasm({ action: "transfer", from: THEM, to: ME, amount: "7" })]), ME);
  assert.equal(back.kind, "receive");
  assert.equal(back.counterparty, THEM);
  assert.deepEqual(back.changes, [{ denom: `cw20:${CW}`, amount: "7" }]);
});

test("CW20 adapter conversions, both ways, read as conversions", () => {
  const toBank = { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: ME, contract: CW, msg: { send: { contract: ADAPTER, amount: "9", msg: "" } }, funds: [] };
  const a = summarize(
    tx(32, [toBank], [...feePaidBy(ME), wasm({ action: "send", from: ME, to: ADAPTER, amount: "9" }), ev("coin_received", { receiver: ME, amount: `9${BANK_FORM}` })]),
    ME,
  );
  assert.equal(a.kind, "convert");
  assert.deepEqual(a.changes, [
    { denom: `cw20:${CW}`, amount: "-9" },
    { denom: BANK_FORM, amount: "9" },
  ]);

  const redeem = { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: ME, contract: ADAPTER, msg: { redeem_and_transfer: { recipient: ME } }, funds: [{ denom: BANK_FORM, amount: "4" }] };
  const b = summarize(tx(33, [redeem], [...feePaidBy(ME), ...move(ME, ADAPTER, `4${BANK_FORM}`), wasm({ action: "transfer", from: ADAPTER, to: ME, amount: "4" })]), ME);
  assert.equal(b.kind, "convert");

  // Different amounts are a swap, not a conversion.
  const c = summarize(tx(34, [redeem], [...feePaidBy(ME), ...move(ME, ADAPTER, `4${BANK_FORM}`), wasm({ action: "transfer", from: ADAPTER, to: ME, amount: "3" })]), ME);
  assert.equal(c.kind, "swap");
});

test("a failed send: nothing moved but the fee", () => {
  const a = summarize(tx(15, [send(ME, THEM, "99inj")], feePaidBy(ME), 5), ME);
  assert.equal(a.ok, false);
  assert.equal(a.kind, "send");
  assert.deepEqual(a.changes, []);
  assert.deepEqual(a.fee, [{ denom: "inj", amount: FEE }]);
});

test("staking, rewards, IBC, the orderbook, and anything else by its name", () => {
  const val = "injvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const kind = (m: Record<string, unknown>, events: TxEvent[] = feePaidBy(ME)) => {
    const a = summarize(tx(16, [m], events), ME);
    return [a.kind, a.label, a.counterparty];
  };
  assert.deepEqual(kind({ "@type": "/cosmos.staking.v1beta1.MsgDelegate", validator_address: val }), ["stake", undefined, val]);
  assert.deepEqual(kind({ "@type": "/cosmos.staking.v1beta1.MsgUndelegate", validator_address: val }), ["unstake", undefined, val]);
  assert.deepEqual(kind({ "@type": "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward" }), ["rewards", undefined, undefined]);
  assert.deepEqual(kind({ "@type": "/ibc.applications.transfer.v1.MsgTransfer", receiver: "cosmos1abc" }), ["ibc", undefined, "cosmos1abc"]);
  assert.deepEqual(kind({ "@type": "/injective.exchange.v2.MsgCreateSpotLimitOrder" }), ["orderbook", undefined, undefined]);
  assert.deepEqual(kind({ "@type": "/cosmos.gov.v1.MsgVote" }), ["other", "Vote", undefined]);
  // An IBC transfer arriving: relayed by someone else.
  const relayed = summarize(
    tx(17, [{ "@type": "/ibc.core.client.v1.MsgUpdateClient" }, { "@type": "/ibc.core.channel.v1.MsgRecvPacket" }], [...feePaidBy(THEM), ...move(POOL, ME, "5ibc/ABC")]),
    ME,
  );
  assert.equal(relayed.kind, "receive");
});

test("two queries' pages merge: each tx once, newest first", () => {
  const a = summarize(tx(20, [send(ME, THEM, "1inj")], [...feePaidBy(ME), ...move(ME, THEM, "1inj")]), ME);
  const b = summarize(tx(25, [send(THEM, ME, "2inj")], [...feePaidBy(THEM), ...move(THEM, ME, "2inj")]), ME);
  const c = summarize(tx(22, [send(ME, THEM, "3inj")], [...feePaidBy(ME), ...move(ME, THEM, "3inj")]), ME);
  assert.deepEqual(mergeActivity([[c, a], [b, a]]).map((x) => x.height), ["25", "22", "20"]);
});

test("tx search: past the end is empty; a node missing old blocks is skipped", async () => {
  const calls: string[] = [];
  const fetch = async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/node_info")) return new Response(JSON.stringify({ default_node_info: { network: "injective-1" } }));
    calls.push(url.host);
    const page = url.searchParams.get("page");
    if (url.host === "pruned.example") {
      return new Response(JSON.stringify({ code: 13, message: "height 190796912 is not available, lowest height is 190817313", details: [] }), { status: 500 });
    }
    if (page === "9") return new Response(JSON.stringify({ code: 13, message: "failed to search for txs: page should be within [1, 1] range, given 9" }), { status: 500 });
    assert.equal(url.searchParams.get("query"), `coin_received.receiver='${ME}'`);
    assert.equal(url.searchParams.get("order_by"), "ORDER_BY_DESC");
    return new Response(
      JSON.stringify({
        tx_responses: [
          {
            txhash: "ab".repeat(32),
            height: "190917315",
            timestamp: "2026-11-09T08:00:00Z",
            code: 0,
            tx: { body: { messages: [send(THEM, ME, "2inj")] }, auth_info: { fee: { amount: [{ denom: "inj", amount: FEE }] } } },
            events: move(THEM, ME, "2inj"),
          },
        ],
        total: "1",
      }),
    );
  };
  const lcd = new Lcd(NETWORKS.mainnet, ["https://pruned.example", "https://deep.example"], fetch);
  const page = await lcd.searchTxs(`coin_received.receiver='${ME}'`, 1, 20);
  assert.equal(page.txs.length, 1);
  assert.equal(page.txs[0]!.hash, "AB".repeat(32));
  assert.equal(page.done, true); // total 1 fits in a page of 20
  assert.equal(summarize(page.txs[0]!, ME).kind, "receive");
  assert.deepEqual(calls, ["pruned.example", "deep.example"]);
  assert.deepEqual(await lcd.searchTxs(`coin_received.receiver='${ME}'`, 9, 20), { txs: [], done: true });
  // Exactly full: total 1 at limit 1 is done too.
  assert.equal((await lcd.searchTxs(`coin_received.receiver='${ME}'`, 1, 1)).done, true);
});

test("tx search: a total beyond the page means more to come", async () => {
  const fetch = async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/node_info")) return new Response(JSON.stringify({ default_node_info: { network: "injective-1" } }));
    return new Response(JSON.stringify({ tx_responses: [], total: "0" }));
  };
  const lcd = new Lcd(NETWORKS.mainnet, ["https://a.example"], fetch);
  assert.deepEqual(await lcd.searchTxs("x='y'", 1, 50), { txs: [], done: true });
  const busy = new Lcd(NETWORKS.mainnet, ["https://b.example"], async (input: string) => {
    if (new URL(input).pathname.endsWith("/node_info")) return new Response(JSON.stringify({ default_node_info: { network: "injective-1" } }));
    return new Response(
      JSON.stringify({
        tx_responses: [{ txhash: "cd".repeat(32), height: "5", timestamp: "2026-11-09T08:00:00Z", code: 0, tx: { body: { messages: [] }, auth_info: { fee: { amount: [] } } }, events: [] }],
        total: "262070",
      }),
    );
  });
  const p = await busy.searchTxs("x='y'", 1, 50);
  assert.deepEqual([p.txs.length, p.done], [1, false]);
});
