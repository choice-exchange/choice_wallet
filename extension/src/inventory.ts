// What the account holds beyond its balance (`@choice-wallet/chain`'s inventory.ts): INJ
// orderbook trading accounts, Choice XYK shares and CLMM positions, all read from the chain.
// A trading account's free coins move back to the balance through the usual prepare,
// review and confirm (exchange `MsgWithdraw`, built and graded by the vault).

import { clmmPositions, NETWORKS, subaccountId, subaccounts, xykPositions, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, InventoryView, Result, SendReview } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";

type Sender = ReturnType<typeof createSender>;
const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

export function createInventory(d: { sender: Sender }) {
  async function summary(network: NetworkId, account: AccountInfo): Promise<Result<InventoryView>> {
    const net = NETWORKS[network];
    const me = account.addresses[net.cosmos] ?? "";
    const owner0x = account.addresses[net.evm] ?? "";
    try {
      const lcd = await d.sender.lcd(network);
      const [subs, coins] = await Promise.all([subaccounts(lcd, owner0x), lcd.balances(me)]);
      const [xyk, clmm] = await Promise.all([xykPositions(lcd, coins), clmmPositions(lcd, net.choice.clmmManager, me)]);
      const denoms = new Set<string>([net.feeDenom]);
      for (const s of subs) for (const x of s.deposits) denoms.add(x.denom);
      for (const x of xyk) for (const a of x.assets) denoms.add(a.denom);
      for (const c of clmm) denoms.add(c.token0).add(c.token1);
      const tokens = await d.sender.tokensFor(network, denoms);
      return {
        ok: true,
        result: {
          subaccounts: subs.map((s) => ({ ...s, deposits: s.deposits.map((x) => ({ denom: x.denom, available: x.available.toString(), total: x.total.toString() })) })),
          xyk: xyk.map((x) => ({ pool: x.pool, share: x.share, amount: x.amount.toString(), totalShare: x.totalShare.toString(), assets: x.assets.map((a) => ({ denom: a.denom, amount: a.amount.toString() })) })),
          clmm: clmm.map((c) => ({ ...c, liquidity: c.liquidity.toString(), amount0: c.amount0.toString(), amount1: c.amount1.toString(), owed0: c.owed0.toString(), owed1: c.owed1.toString() })),
          tokens,
        },
      };
    } catch (e) {
      return d.sender.chainFailure(e);
    }
  }

  /** Every free coin of trading account `nonce` back to the balance. What backs open orders
   *  stays (the chain wouldn't let it go). */
  async function prepareWithdraw(network: NetworkId, account: AccountInfo, nonce: unknown): Promise<Result<SendReview>> {
    if (typeof nonce !== "number" || !Number.isInteger(nonce) || nonce < 0 || nonce > 255) return fail("bad_request", "Which trading account?");
    const net = NETWORKS[network];
    try {
      const lcd = await d.sender.lcd(network);
      const id = subaccountId(account.addresses[net.evm] ?? "", nonce);
      const [sub] = await subaccounts(lcd, account.addresses[net.evm] ?? "", nonce + 1).then((all) => all.filter((s) => s.id === id));
      const free = (sub?.deposits ?? []).filter((x) => x.available > 0n);
      if (free.length === 0) return fail("nothing", "Nothing in this trading account can move now. What's there backs open orders.");
      return d.sender.prepareCosmos(network, account, {
        denom: net.feeDenom,
        amount: "0",
        noAmount: true,
        messages: () => free.slice(0, 30).map((x) => ({ type: "exchange_withdraw", subaccount_id: id, amount: { denom: x.denom, amount: x.available.toString() } })),
      });
    } catch (e) {
      return d.sender.chainFailure(e);
    }
  }

  return { summary, prepareWithdraw };
}
