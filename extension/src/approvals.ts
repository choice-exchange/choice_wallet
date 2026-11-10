// Approvals and grants: what this account lets others do, and taking it back.
//
// - authz grants and fee allowances it gave, and where its staking rewards go (LCD);
// - CW20 allowances on the CW20s it holds or added (each contract's `all_allowances`);
// - ERC20 allowances: Blockscout names every (token, spender) the account ever approved,
//   and what is left of each comes from the token itself on the user's EVM endpoint.
//
// Revokes are the wallet's own transactions: the same prepare → review → confirm_send as a
// send, decoded and graded by the vault. Cosmos revokes go in one transaction; each ERC20
// revoke is its own (an `approve(spender, 0)` on that token).

import { cw20Address, evmAddress, evmDenom, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, ApprovalsSummary, Result, RevokeItem, SendReview } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";
import { fail } from "./util";

type Sender = ReturnType<typeof createSender>;

/** Most messages in one revoke transaction. */
export const MAX_REVOKES = 30;
/** CW20 contracts asked at once. */
const CW20_PARALLEL = 6;

const TYPE_URL = /^\/[A-Za-z0-9._]{1,127}$/;

export function createApprovals(sender: Sender) {
  async function summary(network: NetworkId, account: AccountInfo): Promise<Result<ApprovalsSummary>> {
    const net = NETWORKS[network];
    const address = account.addresses[net.cosmos];
    const evm0x = account.addresses[net.evm];
    if (!address || !evm0x) return fail("bad_request", "This account has no address on this network.");
    try {
      const client = await sender.lcd(network);
      const [grants, feeGrants, rewardsTo, held] = await Promise.all([
        client.authzGrants(address),
        client.feeGrants(address),
        client.withdrawAddress(address),
        sender.balances(network, account),
      ]);
      // CW20 allowances on every CW20 the wallet lists for this account.
      const contracts = held.ok ? held.result.balances.map((b) => cw20Address(b.denom)).filter((c): c is string => c !== null) : [];
      const cw20: ApprovalsSummary["cw20"] = [];
      for (let i = 0; i < contracts.length; i += CW20_PARALLEL) {
        const batch = contracts.slice(i, i + CW20_PARALLEL);
        const answers = await Promise.all(batch.map((c) => client.cw20Allowances(c, address).catch(() => null)));
        batch.forEach((c, j) => {
          for (const a of answers[j] ?? []) cw20.push({ token: `cw20:${c}`, spender: a.spender, amount: a.amount.toString(), expires: a.expires });
        });
      }

      // ERC20 allowances: Blockscout finds, the token answers.
      const erc20: ApprovalsSummary["erc20"] = [];
      let evmIndexDown = false;
      let evmDown = false;
      const index = await sender.evmIndex(network);
      let pairs: { token: string; spender: string }[] = [];
      if (index) {
        try {
          pairs = await index.approvals(evm0x);
        } catch {
          evmIndexDown = true;
        }
      }
      if (pairs.length > 0) {
        try {
          const left = await (await sender.evm(network)).erc20Allowances(pairs, evm0x);
          pairs.forEach((p, i) => {
            const a = left[i];
            if (a !== null && a !== undefined && a > 0n) erc20.push({ token: evmDenom(p.token), spender: p.spender, amount: a.toString() });
          });
        } catch {
          evmDown = true;
        }
      }

      const tokens = await sender.tokensFor(network, [...cw20.map((c) => c.token), ...erc20.map((e) => e.token)]);
      return {
        ok: true,
        result: {
          network,
          grants,
          feeGrants,
          rewardsTo: rewardsTo === address ? null : rewardsTo,
          cw20,
          erc20,
          tokens,
          ...(evmIndexDown ? { evmIndexDown: true as const } : {}),
          ...(evmDown ? { evmDown: true as const } : {}),
        },
      };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** One transaction taking back Cosmos-side permissions: grants, fee allowances, the
   *  rewards address and CW20 allowances. */
  async function prepare(network: NetworkId, account: AccountInfo, items: unknown): Promise<Result<SendReview>> {
    if (!Array.isArray(items) || items.length === 0) return fail("bad_request", "Nothing to revoke.");
    if (items.length > MAX_REVOKES) return fail("bad_request", `At most ${MAX_REVOKES} at once.`);
    const messages: unknown[] = [];
    for (const raw of items as RevokeItem[]) {
      const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
      switch (raw?.type) {
        case "authz":
          if (!str(raw.grantee) || !TYPE_URL.test(String(raw.msg_type_url))) return fail("bad_request", "Not a grant.");
          messages.push({ type: "authz_revoke", grantee: raw.grantee, msg_type_url: raw.msg_type_url });
          break;
        case "fee":
          if (!str(raw.grantee)) return fail("bad_request", "Not a fee grant.");
          messages.push({ type: "fee_revoke", grantee: raw.grantee });
          break;
        case "rewards":
          messages.push({ type: "reset_withdraw_address" });
          break;
        case "cw20":
          if (!str(raw.contract) || !str(raw.spender) || !/^[1-9][0-9]{0,77}$/.test(String(raw.amount))) return fail("bad_request", "Not an allowance.");
          messages.push({ type: "cw20_decrease_allowance", contract: raw.contract, spender: raw.spender, amount: raw.amount });
          break;
        default:
          return fail("bad_request", "Unknown revoke.");
      }
    }
    return sender.prepareCosmos(network, account, {
      denom: NETWORKS[network].feeDenom,
      amount: "",
      noAmount: true,
      messages: () => messages,
    });
  }

  /** `approve(spender, 0)` on one ERC20. */
  async function prepareErc20(network: NetworkId, account: AccountInfo, token: unknown, spender: unknown): Promise<Result<SendReview>> {
    if (typeof token !== "string" || !evmAddress(token) || typeof spender !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(spender)) {
      return fail("bad_request", "Not an allowance.");
    }
    return sender.prepareEvm(network, account, { denom: token, to: evmAddress(token)!, amount: "0", revoke: spender });
  }

  return { summary, prepare, prepareErc20 };
}
