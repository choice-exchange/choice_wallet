// The rescue address: where to move an account's funds when its key is lost or stolen, set
// ahead of time (ideally a hardware wallet), and the gas to do it with.
//
// - **Gas.** A key thief usually takes the INJ first, which leaves nothing to pay fees with.
//   So the rescue account, if it is one of this wallet's, can give this account a fee
//   allowance ahead of time: capped (`GAS_LIMIT`), with no end date, for the rescue's own
//   message types only. A thief with the key can spend at most the cap on fees.
// - **Rescue now.** One transaction (at most `MAX_MESSAGES`), to the rescue address: staking
//   rewards redirected there and claimed, every stake unstaked (it comes back to this
//   account after the unbonding period, three weeks: a race with a thief, which starting
//   early helps), the permissions and fee allowances this account gave taken back, every
//   CW20 and every bank coin sent. Injective's `MsgTransferDelegation` gives a stake away at
//   once, but only to addresses on a list governance sets (checked on the chain's source and
//   on both networks, 2026-11-09), so it is used only when the rescue address is on it. Its
//   fee comes from the balance if there's enough INJ, else from the rescue allowance. It
//   goes through prepare, review and confirm like any send.
//
// Not moved here (phase 2, Rescue Mode): stakes once they finish unbonding, NFTs, EVM-only
// tokens, orderbook subaccounts and liquidity positions.

import { isObject, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Coin, RescueSummary, Result, SendReview } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";
import type { Store } from "./service";
import { fail } from "./util";

type Sender = ReturnType<typeof createSender>;

/** The most fee the rescue allowance pays in all: 0.1 INJ, hundreds of rescues at today's
 *  gas price, and all a thief could burn. */
export const GAS_LIMIT = 100_000_000_000_000_000n;
/** What the allowance pays for: the rescue's messages, nothing else. */
export const RESCUE_MESSAGES = [
  "/cosmos.bank.v1beta1.MsgSend",
  "/cosmwasm.wasm.v1.MsgExecuteContract",
  "/cosmos.staking.v1beta1.MsgTransferDelegation",
  "/cosmos.staking.v1beta1.MsgUndelegate",
  "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress",
  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
  "/cosmos.authz.v1beta1.MsgRevoke",
  "/cosmos.feegrant.v1beta1.MsgRevokeAllowance",
];
/** Messages in one rescue transaction; what doesn't fit goes in the next one. */
export const MAX_MESSAGES = 30;

export interface RescueDeps {
  sender: Sender;
  local: Store;
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  /** Every account here, for the rescue account's name and whether it can sign. */
  accounts(): Promise<AccountInfo[]>;
}

export function createRescue(d: RescueDeps) {
  async function stored(): Promise<Record<string, string>> {
    const { rescue } = (await d.local.get(["rescue"])) as { rescue?: unknown };
    return isObject(rescue) ? (Object.fromEntries(Object.entries(rescue).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {};
  }

  /** The rescue address set for `account` (its inj1 form), if any. */
  async function addressFor(account: AccountInfo): Promise<string | null> {
    return (await stored())[account.addresses[NETWORKS.mainnet.cosmos] ?? ""] ?? null;
  }

  /** The account here behind `address`, if it can sign. */
  async function ownSigner(address: string): Promise<AccountInfo | null> {
    return (await d.accounts()).find((a) => a.addresses[NETWORKS.mainnet.cosmos] === address && a.account.derivation !== "watch") ?? null;
  }

  async function summary(network: NetworkId, account: AccountInfo): Promise<Result<RescueSummary>> {
    const net = NETWORKS[network];
    const address = await addressFor(account);
    if (!address) return { ok: true, result: { address: null } };
    const all = await d.accounts();
    const named = all.find((a) => a.addresses[net.cosmos] === address);
    const signer = await ownSigner(address);
    let gas: RescueSummary["gas"] = null;
    try {
      const g = (await (await d.sender.lcd(network)).feeGrants(address)).find((x) => x.grantee === account.addresses[net.cosmos]);
      if (g) gas = { limit: g.spendLimit, current: RESCUE_MESSAGES.every((m) => g.allowedMessages?.includes(m)) };
    } catch {
      // Not knowing the allowance isn't a reason to hide the rest.
    }
    let stakesMove = false;
    try {
      stakesMove = (await (await d.sender.lcd(network)).delegationTransferReceivers()).includes(address);
    } catch {
      // Unstaking is the fallback either way.
    }
    return { ok: true, result: { address, ...(named ? { name: named.name } : {}), canGrant: signer !== null, gas, stakesMove } };
  }

  /** Set (or clear, with null) where this account is rescued to. */
  async function set(account: AccountInfo, address: unknown): Promise<Result<RescueSummary>> {
    const key = account.addresses[NETWORKS.mainnet.cosmos] ?? "";
    const now = await stored();
    if (address === null) {
      delete now[key];
      await d.local.set({ rescue: now });
      return { ok: true, result: { address: null } };
    }
    if (typeof address !== "string") return fail("bad_request", "Enter an inj1… or 0x… address.");
    const r = await d.vault<{ addresses: Record<string, string> }>("addresses", { address: address.trim() });
    if (!r.ok) return fail("invalid_address", "That isn't an Injective account address.");
    const inj = r.result.addresses[NETWORKS.mainnet.cosmos]!;
    if (inj === key) return fail("same_account", "The rescue address must be another account.");
    await d.local.set({ rescue: { ...now, [key]: inj } });
    return { ok: true, result: { address: inj } };
  }

  /** The rescue account gives this one gas for a rescue: signed by the rescue account. */
  async function prepareGrant(network: NetworkId, account: AccountInfo): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const address = await addressFor(account);
    if (!address) return fail("no_rescue", "Set a rescue address first.");
    const rescuer = await ownSigner(address);
    if (!rescuer) return fail("not_here", "The rescue address isn't an account in this wallet, so it can't give gas from here.");
    const me = account.addresses[net.cosmos]!;
    // Gas given before that doesn't cover every rescue message is replaced in the same
    // transaction.
    let old = false;
    try {
      old = (await (await d.sender.lcd(network)).feeGrants(address)).some((g) => g.grantee === me);
    } catch (e) {
      return d.sender.chainFailure(e);
    }
    return d.sender.prepareCosmos(network, rescuer, {
      denom: net.feeDenom,
      amount: "0",
      noAmount: true,
      messages: () => [
        ...(old ? [{ type: "fee_revoke", grantee: me }] : []),
        { type: "fee_grant", grantee: me, spend_limit: [{ denom: net.feeDenom, amount: GAS_LIMIT.toString() }], allowed_messages: RESCUE_MESSAGES },
      ],
    });
  }

  /** Everything this transaction can move, to the rescue address. */
  async function prepare(network: NetworkId, account: AccountInfo): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const to = await addressFor(account);
    if (!to) return fail("no_rescue", "Set a rescue address first.");
    const me = account.addresses[net.cosmos]!;
    try {
      const lcd = await d.sender.lcd(network);
      const [coins, delegations, rewards, withdrawTo, grants, allowances, gas, receivers] = await Promise.all([
        lcd.balances(me),
        lcd.delegations(me),
        lcd.rewards(me),
        lcd.withdrawAddress(me),
        lcd.authzGrants(me),
        lcd.feeGrants(me),
        lcd.feeGrants(to).then((g) => g.find((x) => x.grantee === me) ?? null),
        lcd.delegationTransferReceivers(),
      ]);
      const stakesMove = receivers.includes(to);
      const held = await d.sender.balances(network, account);
      const cw20s = held.ok ? held.result.balances.filter((b) => b.denom.startsWith("cw20:") && BigInt(b.amount) > 0n) : [];

      const msgs: unknown[] = [];
      if (withdrawTo !== to && (delegations.length > 0 || rewards.size > 0)) msgs.push({ type: "set_withdraw_address", to });
      for (const [validator, amount] of rewards) if (amount > 0n) msgs.push({ type: "withdraw_rewards", validator });
      for (const s of delegations) {
        if (s.amount === 0n) continue;
        const amount = { denom: net.feeDenom, amount: s.amount.toString() };
        msgs.push(stakesMove ? { type: "transfer_delegation", validator: s.validator, to, amount } : { type: "undelegate", validator: s.validator, amount });
      }
      for (const g of grants) if (g.msgTypeUrl) msgs.push({ type: "authz_revoke", grantee: g.grantee, msg_type_url: g.msgTypeUrl });
      for (const a of allowances) msgs.push({ type: "fee_revoke", grantee: a.grantee });
      for (const c of cw20s) msgs.push({ type: "cw20_transfer", contract: c.denom.slice(5), to, amount: c.amount });
      const others: Coin[] = coins.filter((c) => c.denom !== net.feeDenom && BigInt(c.amount) > 0n);
      // Room for the bank send last.
      const fit = msgs.slice(0, MAX_MESSAGES - 1);
      const rest = msgs.length - fit.length;
      const inj = BigInt(coins.find((c) => c.denom === net.feeDenom)?.amount ?? "0");
      if (fit.length === 0 && others.length === 0 && inj === 0n) return fail("nothing", "There's nothing here to rescue.");

      // The fee: from the balance if there's enough INJ for it, else from the rescue
      // allowance. (A rough bound: the simulation sets the real fee.)
      const roughFee = BigInt(200_000 + 150_000 * (fit.length + 1)) * 2n * (await lcd.gasPrice());
      const useGrant = inj < roughFee && gas !== null;
      if (inj < roughFee && !useGrant) return fail("no_gas", "Not enough INJ for the fee, and the rescue address hasn't given this account gas.");

      const review = await d.sender.prepareCosmos(network, account, {
        denom: net.feeDenom,
        amount: "max",
        allowZero: true,
        recipient: to,
        ...(useGrant ? { feeGranter: to } : {}),
        messages: (amount) => {
          const send = [...(amount > 0n ? [{ denom: net.feeDenom, amount: amount.toString() }] : []), ...others];
          return [...fit, ...(send.length ? [{ type: "bank_send", to, amount: send }] : [])];
        },
      });
      return review.ok ? { ok: true, result: { ...review.result, rescue: { to, rest } } } : review;
    } catch (e) {
      return d.sender.chainFailure(e);
    }
  }

  return { summary, set, prepareGrant, prepare, addressFor };
}
