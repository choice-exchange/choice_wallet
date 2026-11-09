// Staking: what the account has staked, is unstaking and has earned, and the wallet's own
// staking transactions. They go through the same prepare → review → confirm as a send
// (`pending_send`), so the vault decodes and grades each one before it is signed.

import { NETWORKS, type Delegation, type Lcd, type NetworkId, type Validator } from "@choice-wallet/chain";
import type { AccountInfo, Result, SendReview, StakeRequest, StakingSummary, ValidatorInfo } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";

type Sender = ReturnType<typeof createSender>;

/** Kept back when staking "max": a few later fees (unstaking, claiming). 0.01 INJ. */
export const STAKE_RESERVE = 10_000_000_000_000_000n;
/** Validators are listed again after this long. */
const VALIDATORS_TTL_MS = 5 * 60_000;
/** Most rewards claimed in one transaction. */
const MAX_CLAIMS = 30;

const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

const info = (v: Validator, rank: number | null): ValidatorInfo => ({
  address: v.address,
  moniker: v.moniker,
  website: v.website,
  commission: v.commission,
  tokens: v.tokens.toString(),
  jailed: v.jailed,
  active: rank !== null,
  rank,
});

export function createStaking(sender: Sender) {
  // By client: a new endpoint list makes a new client, so a set read from other endpoints
  // is never reused.
  const validatorCache = new WeakMap<Lcd, { at: number; list: Promise<Validator[]> }>();

  function activeSet(client: Lcd): Promise<Validator[]> {
    const hit = validatorCache.get(client);
    if (hit && Date.now() - hit.at < VALIDATORS_TTL_MS) return hit.list;
    const list = client.validators();
    validatorCache.set(client, { at: Date.now(), list });
    list.catch(() => validatorCache.delete(client));
    return list;
  }

  async function summary(network: NetworkId, account: AccountInfo): Promise<Result<StakingSummary>> {
    const net = NETWORKS[network];
    const address = account.addresses[net.cosmos];
    if (!address) return fail("bad_request", "This account has no address on this network.");
    try {
      const client = await sender.lcd(network);
      const [set, stakes, unbonding, rewards, seconds] = await Promise.all([
        activeSet(client),
        client.delegations(address),
        client.unbonding(address),
        client.rewards(address),
        client.unbondingTime(),
      ]);
      const ranked = new Map(set.map((v, i) => [v.address, info(v, i + 1)]));
      // Stakes and unbonding with validators outside the active set: look each up.
      const missing = [...new Set([...stakes.map((s) => s.validator), ...unbonding.map((u) => u.validator), ...rewards.keys()])].filter((a) => !ranked.has(a));
      const others = (await Promise.all(missing.map((a) => client.validator(a)))).filter((v): v is Validator => v !== null).map((v) => info(v, null));
      const sum = (xs: Iterable<bigint>) => [...xs].reduce((a, b) => a + b, 0n);
      return {
        ok: true,
        result: {
          network,
          denom: net.feeDenom,
          staked: sum(stakes.map((s) => s.amount)).toString(),
          unbondingTotal: sum(unbonding.map((u) => u.amount)).toString(),
          rewards: sum(rewards.values()).toString(),
          stakes: stakes
            .map((s) => ({ validator: s.validator, amount: s.amount.toString(), rewards: (rewards.get(s.validator) ?? 0n).toString() }))
            .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1)),
          unbonding: unbonding.map((u) => ({ validator: u.validator, amount: u.amount.toString(), height: u.height.toString(), completes: u.completes })),
          validators: [...ranked.values(), ...others],
          unbondingDays: Math.round(seconds / 86_400),
        },
      };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** Build, simulate, decode and grade one staking action, ready for `confirm_send`. */
  async function prepare(network: NetworkId, account: AccountInfo, req: StakeRequest): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const address = account.addresses[net.cosmos];
    if (!address) return fail("bad_request", "This account has no address on this network.");
    const denom = net.feeDenom;
    const amount = typeof req.amount === "string" ? req.amount : "";
    try {
      const client = await sender.lcd(network);
      const usable = async (v: unknown): Promise<Result<never> | null> => {
        const set = await activeSet(client);
        const found = set.find((x) => x.address === v);
        if (!found) return fail("bad_request", "Pick a validator in the active set.");
        if (found.jailed) return fail("bad_request", "That validator is jailed.");
        return null;
      };
      const stakeWith = async (v: unknown): Promise<Delegation | null> => (await client.delegations(address)).find((d) => d.validator === v) ?? null;
      const coin = (n: bigint) => ({ denom, amount: n.toString() });

      switch (req.action) {
        case "stake": {
          const bad = await usable(req.validator);
          if (bad) return bad;
          return sender.prepareCosmos(network, account, {
            denom,
            amount,
            reserve: STAKE_RESERVE,
            messages: (n) => [{ type: "delegate", validator: req.validator, amount: coin(n) }],
          });
        }
        case "unstake": {
          const s = await stakeWith(req.validator);
          if (!s) return fail("bad_request", "Nothing is staked with that validator.");
          return sender.prepareCosmos(network, account, {
            denom,
            amount,
            source: { available: s.amount, short: "is staked with this validator" },
            messages: (n) => [{ type: "undelegate", validator: req.validator, amount: coin(n) }],
          });
        }
        case "move": {
          if (req.to === req.validator) return fail("bad_request", "Pick a different validator.");
          const bad = await usable(req.to);
          if (bad) return bad;
          const s = await stakeWith(req.validator);
          if (!s) return fail("bad_request", "Nothing is staked with that validator.");
          return sender.prepareCosmos(network, account, {
            denom,
            amount,
            source: { available: s.amount, short: "is staked with this validator" },
            messages: (n) => [{ type: "redelegate", from: req.validator, to: req.to, amount: coin(n) }],
          });
        }
        case "claim": {
          const rewards = await client.rewards(address);
          const from = req.validator === undefined ? [...rewards.keys()] : rewards.has(String(req.validator)) ? [String(req.validator)] : [];
          if (from.length === 0) return fail("bad_request", "There are no rewards to claim.");
          const claims = from.sort((a, b) => (rewards.get(b)! > rewards.get(a)! ? 1 : -1)).slice(0, MAX_CLAIMS);
          return sender.prepareCosmos(network, account, {
            denom,
            amount: "",
            noAmount: true,
            messages: () => claims.map((validator) => ({ type: "withdraw_rewards", validator })),
          });
        }
        case "cancel": {
          const entry = (await client.unbonding(address)).find((u) => u.validator === req.validator && u.height.toString() === req.height);
          if (!entry) return fail("bad_request", "That unstaking has finished or was cancelled.");
          return sender.prepareCosmos(network, account, {
            denom,
            amount: "max",
            source: { available: entry.amount, short: "is unstaking" },
            messages: (n) => [{ type: "cancel_unbonding", validator: req.validator, amount: coin(n), height: entry.height.toString() }],
          });
        }
        default:
          return fail("bad_request", "Unknown staking action.");
      }
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  return { summary, prepare };
}
