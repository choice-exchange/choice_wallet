// What a review shows, from the vault's decode of the transaction that will be signed: the
// sends, the conversions, anything else the transaction does, and the fee.

import { adapterCw20, adapterDenom, cw20Denom, evmDenom, isContractAddress, NETWORKS } from "@choice-wallet/chain";

import type { Coin, CosmosDisplay, EvmDisplay, EvmSwapCall, NetworkId, SendReview, SwapStepInfo } from "./protocol";

/** A token turned into its other form by the CW20 adapter, one for one. */
export type Conversion = { from: Coin; to: Coin; recipient: string };

/** A staking action by the signer. */
export type StakeLine = { kind: "stake" | "unstake" | "move" | "claim" | "cancel"; validator: string; to?: string; amount?: Coin };

const STAKE_KINDS: Record<string, StakeLine["kind"]> = {
  delegate: "stake",
  undelegate: "unstake",
  redelegate: "move",
  withdraw_rewards: "claim",
  cancel_unbonding: "cancel",
};

/** A permission the signer takes back. */
export type RevokeLine =
  | { kind: "grant"; grantee: string; msgTypeUrl: string }
  | { kind: "fee"; grantee: string }
  | { kind: "rewards" }
  | { kind: "allowance"; token: string; spender: string };

/** A swap through Choice, as the vault read it. */
export type SwapLine = {
  from: Coin;
  /** The least that arrives (after Choice's fee, if any). */
  minimum: Coin;
  recipient: string;
  feeBps: number;
  venues: string[];
  executor: "aggregator" | "router";
};

/** An allowance a swap needs first, for its amount. */
export type ApprovalLine = { token: string; spender: string; amount: string; via: "token" | "permit2"; until?: number };

export type Shown = {
  sends: { coins: Coin[]; to: string }[];
  swaps: SwapLine[];
  approvals: ApprovalLine[];
  converts: Conversion[];
  stakes: StakeLine[];
  revokes: RevokeLine[];
  /** One line each for anything else. */
  others: string[];
  /** For EVM: gas limit × max fee per gas, which is what Injective charges (no refund of
   *  unused gas). */
  fee: Coin[];
  memo: string;
  evm: boolean;
};

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const coins = (v: unknown): Coin[] => (Array.isArray(v) ? v.filter((c): c is Coin => typeof obj(c)?.["denom"] === "string" && typeof obj(c)?.["amount"] === "string") : []);

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Names Choice's contracts and Permit2 go by, where the review names a spender. */
export function spenderName(network: NetworkId, a: string): string | null {
  const c = NETWORKS[network].choice;
  const is = (x: string | null) => x !== null && x.toLowerCase() === a.toLowerCase();
  return is(c.permit2) ? "Permit2" : is(c.aggregator) ? "Choice's aggregator" : is(c.universalRouter) ? "Choice's router" : null;
}

/** `swap`, when given, names the wallet keys of a swap step's two tokens, so amounts show
 *  as the tokens the user picked. */
export function shown(display: SendReview["display"], network: NetworkId, swap?: SwapStepInfo): Shown {
  const net = NETWORKS[network];
  if (display.kind === "evm_transaction") {
    const d = display as EvmDisplay;
    const base = { fee: [{ denom: net.feeDenom, amount: d.max_gas_cost }], memo: "", evm: true, converts: [], stakes: [], revokes: [], swaps: [], approvals: [] };
    // An address as a wallet key: INJ, or the swap's own tokens, or an EVM token.
    const key = (a: string, side?: "from" | "to") => {
      if (a.toLowerCase() === NATIVE) return net.feeDenom;
      if (swap && side) return swap[side];
      return evmDenom(a);
    };
    if (d.call.type === "swap") {
      const c = d.call as EvmSwapCall;
      const venues = [...new Set(c.venues.map((v) => v.venue))];
      return {
        ...base,
        sends: [],
        others: [],
        swaps: [
          {
            from: { denom: key(c.token_in, "from"), amount: c.amount_in },
            minimum: { denom: key(c.token_out, "to"), amount: c.minimum_out },
            recipient: c.recipient,
            feeBps: c.fee_bps,
            venues,
            executor: c.executor,
          },
        ],
      };
    }
    if (d.call.type === "approve" && d.call.amount !== "0") {
      return { ...base, sends: [], others: [], approvals: [{ token: key(d.to, "from"), spender: d.call.spender, amount: d.call.amount, via: "token" }] };
    }
    if (d.call.type === "permit2_approve") {
      const c = d.call;
      return { ...base, sends: [], others: [], approvals: [{ token: key(c.token, "from"), spender: c.spender, amount: c.amount, via: "permit2", until: c.expiration }] };
    }
    if (d.call.type === "erc20_transfer") return { ...base, sends: [{ coins: [{ denom: evmDenom(d.to), amount: d.call.amount }], to: d.call.to }], others: [] };
    if (d.call.type === "transfer") return { ...base, sends: [{ coins: [{ denom: net.feeDenom, amount: d.value }], to: d.to }], others: [] };
    // approve(spender, 0): an allowance taken back.
    const revoke = /^0x095ea7b3(0{24}[0-9a-fA-F]{40})(0{64})$/.exec(String((d as { data?: unknown }).data ?? ""));
    if (revoke) return { ...base, sends: [], revokes: [{ kind: "allowance", token: evmDenom(d.to), spender: `0x${revoke[1]!.slice(24)}` }], others: [] };
    return { ...base, sends: [], others: [`Contract call to ${d.to}`] };
  }
  const c = display as CosmosDisplay;
  const out: Shown = { sends: [], swaps: [], approvals: [], converts: [], stakes: [], revokes: [], others: [], fee: c.fee.amount, memo: c.memo, evm: false };
  for (const msg of c.messages) {
    const m = msg as Record<string, unknown>;
    const kind = STAKE_KINDS[String(m["type"])];
    const validator = text(m["validator"]) ?? text(m["from_validator"]);
    if (m["type"] === "authz_revoke" && m["granter"] === c.signer && text(m["grantee"]) && text(m["msg_type_url"])) {
      out.revokes.push({ kind: "grant", grantee: text(m["grantee"])!, msgTypeUrl: text(m["msg_type_url"])! });
      continue;
    }
    if (m["type"] === "fee_revoke" && m["granter"] === c.signer && text(m["grantee"])) {
      out.revokes.push({ kind: "fee", grantee: text(m["grantee"])! });
      continue;
    }
    if (m["type"] === "set_withdraw_address" && m["delegator"] === c.signer && m["withdraw_address"] === c.signer) {
      out.revokes.push({ kind: "rewards" });
      continue;
    }
    const decrease = obj(m["call"]);
    if (m["type"] === "execute_contract" && m["sender"] === c.signer && decrease?.["type"] === "cw20_decrease_allowance" && text(m["contract"]) && text(decrease["spender"])) {
      out.revokes.push({ kind: "allowance", token: cw20Denom(text(m["contract"])!), spender: text(decrease["spender"])! });
      continue;
    }
    if (kind && validator && m["delegator"] === c.signer) {
      const [amount] = coins([m["amount"]]);
      const to = text(m["to_validator"]);
      out.stakes.push({ kind, validator, ...(to ? { to } : {}), ...(amount ? { amount } : {}) });
      continue;
    }
    if (m["type"] === "bank_send" && text(m["to"])) {
      out.sends.push({ coins: coins(m["amount"]), to: text(m["to"])! });
      continue;
    }
    const contract = text(m["contract"]);
    const call = obj(m["call"]);
    if (m["type"] === "execute_contract" && contract && isContractAddress(contract) && call) {
      const funds = coins(m["funds"]);
      const amount = text(call["amount"]);
      // A CW20 transfer moves the token held in `contract`.
      if (call["type"] === "cw20_transfer" && amount && text(call["recipient"]) && funds.length === 0) {
        out.sends.push({ coins: [{ denom: cw20Denom(contract), amount }], to: text(call["recipient"])! });
        continue;
      }
      // Sending a CW20 to the adapter (with an empty message) mints its bank form to the sender.
      if (call["type"] === "cw20_send" && amount && call["contract"] === net.cw20Adapter && call["msg"] === "" && funds.length === 0) {
        out.converts.push({ from: { denom: cw20Denom(contract), amount }, to: { denom: adapterDenom(network, contract), amount }, recipient: c.signer });
        continue;
      }
      // Redeeming at the adapter burns the attached bank form and returns the CW20.
      if (call["type"] === "adapter_redeem" && contract === net.cw20Adapter && funds.length === 1) {
        const inner = adapterCw20(network, funds[0]!.denom);
        if (inner) {
          out.converts.push({ from: funds[0]!, to: { denom: cw20Denom(inner), amount: funds[0]!.amount }, recipient: text(call["recipient"]) ?? c.signer });
          continue;
        }
      }
      out.others.push(`Contract call to ${contract}`);
      continue;
    }
    out.others.push(String(m["type"] ?? "message"));
  }
  return out;
}
