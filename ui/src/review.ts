// What a review shows, from the vault's decode of the transaction that will be signed: the
// sends, the conversions, anything else the transaction does, and the fee.

import { adapterCw20, adapterDenom, boundErc20, chainByCaip2, chainCoin, chainUsdc, cw20Denom, evmDenom, isContractAddress, NETWORKS } from "@choice-wallet/chain";

import type { Coin, CosmosDisplay, EvmDisplay, EvmSwapCall, NetworkId, SendReview, SolanaDisplay, SwapStepInfo } from "./protocol";

/** A token turned into its other form by the CW20 adapter, one for one. */
export type Conversion = { from: Coin; to: Coin; recipient: string };

/** A staking action by the signer. */
export type StakeLine = { kind: "stake" | "unstake" | "move" | "claim" | "cancel" | "give"; validator: string; to?: string; amount?: Coin };

const STAKE_KINDS: Record<string, StakeLine["kind"]> = {
  delegate: "stake",
  undelegate: "unstake",
  redelegate: "move",
  withdraw_rewards: "claim",
  cancel_unbonding: "cancel",
  transfer_delegation: "give",
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

/** USDC burned over Circle's CCTP on the chain it is signed on (`from`), as the vault read
 *  it. `recipient` is how the destination spells it (for Solana, a USDC account); `owner` the
 *  Solana wallet Circle opens it for. */
export type BridgeLine = {
  coin: Coin;
  maxFee: Coin;
  from: string | null;
  chain: string | null;
  recipient: string | null;
  owner: string | null;
  /** Who mints it there: Circle; anyone (Choice's bridge service on Injective, or whoever
   *  claims it); Choice's bridge contract with INJ for gas; or some contract's hook. */
  delivery: "circle" | "anyone" | "gas_drop" | "hook";
  /** Set when only this address may deliver. */
  caller: string | null;
  /** The most the INJ top-up costs. */
  dropFee: Coin | null;
  least: Coin;
};

/** A transfer Circle attested, minted on the chain it is signed on (`receiveMessage`). */
export type MintLine = { coin: Coin; fee: Coin; chain: string | null; recipient: string | null };

/** Coins the signer moves from one of its trading accounts back to its balance. */
export type MoveLine = { nonce: number; coin: Coin };

/** The signer's vote on a governance proposal. */
export type VoteLine = { proposal: string; option: "yes" | "no" | "abstain" | "no_with_veto" };

/** One NFT the signer gives away. */
export type NftLine = { collection: string; tokenId: string; to: string };

export type Shown = {
  sends: { coins: Coin[]; to: string }[];
  nfts: NftLine[];
  moves: MoveLine[];
  swaps: SwapLine[];
  bridges: BridgeLine[];
  mints: MintLine[];
  approvals: ApprovalLine[];
  converts: Conversion[];
  stakes: StakeLine[];
  revokes: RevokeLine[];
  votes: VoteLine[];
  /** One line each for anything else. */
  others: string[];
  /** For EVM: gas limit × max fee per gas, which is what Injective charges (no refund of
   *  unused gas). On another chain, in its coin (`native:<chain>`). */
  fee: Coin[];
  memo: string;
  evm: boolean;
  /** For Cosmos: the messages a send or conversion card above stands for, by index. Any
   *  other message is shown in full. */
  carded?: Set<number>;
};

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const coins = (v: unknown): Coin[] => (Array.isArray(v) ? v.filter((c): c is Coin => typeof obj(c)?.["denom"] === "string" && typeof obj(c)?.["amount"] === "string") : []);

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Names Choice's contracts, Permit2 and Circle's bridge go by, where the review names a
 *  spender. */
export function spenderName(network: NetworkId, a: string): string | null {
  const c = NETWORKS[network].choice;
  const is = (x: string | null) => x !== null && x.toLowerCase() === a.toLowerCase();
  return is(c.permit2) ? "Permit2" : is(c.aggregator) ? "Choice's aggregator" : is(c.universalRouter) ? "Choice's router" : is(NETWORKS[network].cctp.tokenMessenger) ? "Circle's bridge (CCTP)" : null;
}

/** A site's text as it will be signed, with what can't be seen made visible: control,
 *  bidi, zero-width and line-separator characters show as their code point, as ⟨U+202E⟩.
 *  Line breaks and tabs stay as they are. */
export function visible(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" || c === "\t" ? c : `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`));
}

/** `swap`, when given, names the wallet keys of a step's two tokens (a swap's, or a bridge
 *  transfer's USDC on both sides), so amounts show as the tokens the user picked. */
export function shown(display: SendReview["display"], network: NetworkId, swap?: Pick<SwapStepInfo, "from" | "to">): Shown {
  const net = NETWORKS[network];
  if (display.kind === "solana_transaction") return solanaShown(display as SolanaDisplay, net.solana.name);
  if (display.kind === "evm_transaction") {
    const d = display as EvmDisplay;
    // Signed on another EVM chain than Injective's: its fee is in that chain's coin.
    const feeDenom = d.chain !== net.evm ? `native:${d.chain}` : net.feeDenom;
    const base = { fee: [{ denom: feeDenom, amount: d.max_gas_cost }], memo: "", evm: true, converts: [], stakes: [], revokes: [], votes: [], swaps: [], bridges: [], mints: [], approvals: [], nfts: [], moves: [] };
    // On another EVM chain than Injective's: its coin and its USDC have their own keys.
    const here = chainByCaip2(network, d.chain);
    const away = here?.kind === "evm" ? here : undefined;
    const coin = away ? chainCoin(away.caip2) : net.feeDenom;
    // Native coin the transaction carries besides a token call, a swap's own input or a
    // bridge: a send of its own. (A plain call shows it on its contract-call card.)
    const nativeIn = d.call.type === "swap" && (d.call as EvmSwapCall).token_in.toLowerCase() === NATIVE && (d.call as EvmSwapCall).amount_in === d.value;
    const attached = d.value !== "0" && !nativeIn ? [{ coins: [{ denom: coin, amount: d.value }], to: d.to }] : [];
    // An address as a wallet key: the chain's coin, the swap's own tokens, USDC on another
    // chain, or an EVM token.
    const key = (a: string, side?: "from" | "to") => {
      if (a.toLowerCase() === NATIVE) return away ? chainCoin(away.caip2) : net.feeDenom;
      // The token the user picked, when the decoded contract is the one it is bound to. A
      // listed token's contract is pinned; any other contract is shown as itself.
      if (swap && side) {
        const bound = boundErc20(network, swap[side]);
        if (bound === undefined || (bound !== null && bound.toLowerCase() === a.toLowerCase())) return swap[side];
        return evmDenom(a);
      }
      if (away && !away.added && a.toLowerCase() === away.usdc.toLowerCase()) return chainUsdc(away.caip2);
      return evmDenom(a);
    };
    if (d.call.type === "swap") {
      const c = d.call as EvmSwapCall;
      const venues = [...new Set(c.venues.map((v) => v.venue))];
      return {
        ...base,
        sends: attached,
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
    if (d.call.type === "bridge") {
      const c = d.call;
      const usdc = key(c.token, "from");
      const at = (amount: string) => ({ denom: usdc, amount });
      const delivery = c.delivery === "claim" ? "anyone" : c.delivery;
      return {
        ...base,
        sends: attached,
        others: [],
        bridges: [{ coin: at(c.amount), maxFee: at(c.max_fee), from: d.network.name, chain: c.chain, recipient: c.recipient, owner: c.account_owner, delivery, caller: delivery === "gas_drop" ? null : c.destination_caller, dropFee: c.max_drop_fee === null ? null : at(c.max_drop_fee), least: at(c.least) }],
      };
    }
    if (d.call.type === "bridge_receive") {
      const c = d.call;
      const usdc = key(c.token, "to");
      return { ...base, sends: attached, others: [], mints: [{ coin: { denom: usdc, amount: c.minted }, fee: { denom: usdc, amount: c.fee }, chain: c.chain, recipient: c.recipient }] };
    }
    if (d.call.type === "approve" && d.call.amount !== "0") {
      return { ...base, sends: attached, others: [], approvals: [{ token: key(d.to, "from"), spender: d.call.spender, amount: d.call.amount, via: "token" }] };
    }
    if (d.call.type === "permit2_approve") {
      const c = d.call;
      return { ...base, sends: attached, others: [], approvals: [{ token: key(c.token, "from"), spender: c.spender, amount: c.amount, via: "permit2", until: c.expiration }] };
    }
    const call = d.call as Record<string, unknown>;
    if (call["type"] === "nft_transfer" && text(call["from"])?.toLowerCase() === d.from.toLowerCase() && text(call["to"]) && text(call["token_id"])) {
      return { ...base, sends: attached, others: [], nfts: [{ collection: d.to, tokenId: text(call["token_id"])!, to: text(call["to"])! }] };
    }
    if (d.call.type === "erc20_transfer") return { ...base, sends: [{ coins: [{ denom: key(d.to), amount: d.call.amount }], to: d.call.to }, ...attached], others: [] };
    if (d.call.type === "transfer") return { ...base, sends: [{ coins: [{ denom: coin, amount: d.value }], to: d.to }], others: [] };
    // approve(spender, 0): an allowance taken back.
    const revoke = /^0x095ea7b3(0{24}[0-9a-fA-F]{40})(0{64})$/.exec(String((d as { data?: unknown }).data ?? ""));
    if (revoke) return { ...base, sends: [], revokes: [{ kind: "allowance", token: evmDenom(d.to), spender: `0x${revoke[1]!.slice(24)}` }], others: [] };
    return { ...base, sends: [], others: [`Contract call to ${d.to}`] };
  }
  const c = display as CosmosDisplay;
  const carded = new Set<number>();
  const out: Shown = { sends: [], nfts: [], moves: [], swaps: [], bridges: [], mints: [], approvals: [], converts: [], stakes: [], revokes: [], votes: [], others: [], fee: c.fee.amount, memo: c.memo, evm: false, carded };
  for (const [i, msg] of c.messages.entries()) {
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
    const sub = text(m["subaccount_id"]);
    const [moved] = coins([m["amount"]]);
    if (m["type"] === "exchange_withdraw" && m["sender"] === c.signer && sub && /^0x[0-9a-f]{64}$/.test(sub) && moved) {
      out.moves.push({ nonce: parseInt(sub.slice(42), 16), coin: moved });
      continue;
    }
    if (m["type"] === "fee_grant" && m["granter"] === c.signer && text(m["grantee"])) {
      out.others.push(`Gas for ${text(m["grantee"])}: this account pays its fees, up to the limit, for the listed messages`);
      continue;
    }
    if (m["type"] === "set_withdraw_address" && m["delegator"] === c.signer && text(m["withdraw_address"])) {
      out.others.push(`Staking rewards go to ${text(m["withdraw_address"])} from now on`);
      continue;
    }
    const decrease = obj(m["call"]);
    if (m["type"] === "execute_contract" && m["sender"] === c.signer && decrease?.["type"] === "cw20_decrease_allowance" && text(m["contract"]) && text(decrease["spender"])) {
      out.revokes.push({ kind: "allowance", token: cw20Denom(text(m["contract"])!), spender: text(decrease["spender"])! });
      continue;
    }
    const option = text(m["option"]);
    if (m["type"] === "vote" && m["voter"] === c.signer && (typeof m["proposal_id"] === "number" || typeof m["proposal_id"] === "string") && (option === "yes" || option === "no" || option === "abstain" || option === "no_with_veto")) {
      out.votes.push({ proposal: String(m["proposal_id"]), option });
      continue;
    }
    if (kind && validator && m["delegator"] === c.signer) {
      const [amount] = coins([m["amount"]]);
      const to = text(m["to_validator"]) ?? text(m["receiver"]);
      out.stakes.push({ kind, validator, ...(to ? { to } : {}), ...(amount ? { amount } : {}) });
      continue;
    }
    if (m["type"] === "bank_send" && text(m["to"])) {
      out.sends.push({ coins: coins(m["amount"]), to: text(m["to"])! });
      carded.add(i);
      continue;
    }
    const contract = text(m["contract"]);
    const call = obj(m["call"]);
    if (m["type"] === "execute_contract" && contract && isContractAddress(contract) && call) {
      const funds = coins(m["funds"]);
      const amount = text(call["amount"]);
      // A CW721 transfer gives one of the signer's NFTs away.
      if (call["type"] === "nft_transfer" && m["sender"] === c.signer && text(call["recipient"]) && text(call["token_id"]) && funds.length === 0) {
        out.nfts.push({ collection: contract, tokenId: text(call["token_id"])!, to: text(call["recipient"])! });
        continue;
      }
      // A CW20 transfer moves the token held in `contract`.
      if (call["type"] === "cw20_transfer" && amount && text(call["recipient"]) && funds.length === 0) {
        out.sends.push({ coins: [{ denom: cw20Denom(contract), amount }], to: text(call["recipient"])! });
        carded.add(i);
        continue;
      }
      // Sending a CW20 to the adapter (with an empty message) mints its bank form to the sender.
      if (call["type"] === "cw20_send" && amount && call["contract"] === net.cw20Adapter && call["msg"] === "" && funds.length === 0) {
        out.converts.push({ from: { denom: cw20Denom(contract), amount }, to: { denom: adapterDenom(network, contract), amount }, recipient: c.signer });
        carded.add(i);
        continue;
      }
      // Redeeming at the adapter burns the attached bank form and returns the CW20.
      if (call["type"] === "adapter_redeem" && contract === net.cw20Adapter && funds.length === 1) {
        const inner = adapterCw20(network, funds[0]!.denom);
        if (inner) {
          out.converts.push({ from: funds[0]!, to: { denom: cw20Denom(inner), amount: funds[0]!.amount }, recipient: text(call["recipient"]) ?? c.signer });
          carded.add(i);
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

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** A Solana transaction, in the review's terms: SOL and tokens the signer sends (a token to
 *  the wallet whose account it is, when the vault could tell), approvals, a CCTP burn to
 *  Injective, and one line for anything else. Compute budget instructions are its fee. */
function solanaShown(d: SolanaDisplay, cluster: string): Shown {
  const out: Shown = { sends: [], nfts: [], moves: [], swaps: [], bridges: [], mints: [], approvals: [], converts: [], stakes: [], revokes: [], votes: [], others: [], fee: [{ denom: "sol", amount: d.fee.total }], memo: "", evm: false };
  for (const s of d.instructions) {
    const name = s.program_name ?? short(s.program);
    switch (s.type) {
      case "compute_budget":
        break;
      case "sol_transfer":
        if (s.from === d.signer) out.sends.push({ coins: [{ denom: "sol", amount: s.lamports }], to: s.to });
        else out.others.push(`Moves SOL from ${short(s.from)} to ${short(s.to)}`);
        break;
      case "token_transfer":
        if (s.authority === d.signer && s.mint) out.sends.push({ coins: [{ denom: `spl:${s.mint}`, amount: s.amount }], to: s.destination_owner ?? s.destination });
        else out.others.push(`Moves tokens to ${short(s.destination_owner ?? s.destination)}`);
        break;
      case "create_token_account":
        if (s.owner !== d.signer) out.others.push(`Opens ${short(s.owner)}'s account for this token, paying its rent`);
        break;
      case "token_approve":
        out.approvals.push({ token: s.mint ? `spl:${s.mint}` : s.source, spender: s.delegate, amount: s.amount, via: "token" });
        break;
      case "bridge": {
        const usdc = `spl:${s.token}`;
        const at = (amount: string) => ({ denom: usdc, amount });
        out.bridges.push({
          coin: at(s.amount),
          maxFee: at(s.max_fee),
          from: cluster,
          chain: s.chain,
          recipient: s.recipient,
          owner: null,
          delivery: s.delivery === "caller" ? "hook" : s.delivery,
          caller: null,
          dropFee: s.max_drop_fee === null ? null : at(s.max_drop_fee),
          least: at(s.least),
        });
        break;
      }
      case "bridge_reclaim":
        out.others.push("Takes back the rent of a finished bridge transfer's record");
        break;
      case "memo":
        out.memo = s.text ?? `0x${s.hex}`;
        break;
      case "assign":
        out.others.push(`Hands ${short(s.account)} to ${s.owner_name ?? short(s.owner)}`);
        break;
      case "token_set_authority":
        out.others.push(`Gives control of ${short(s.account)} to ${s.new_authority ? short(s.new_authority) : "nobody"}`);
        break;
      case "token_close":
        out.others.push(`Closes token account ${short(s.account)}; its SOL goes to ${short(s.destination)}`);
        break;
      case "unreadable":
        out.others.push(`${name}: an instruction the wallet can't read`);
        break;
      case "program":
        out.others.push(`${name}: the wallet can't read what this does`);
        break;
      default:
        out.others.push(`${name}: ${s.type.replaceAll("_", " ")}`);
    }
  }
  return out;
}
