// Sends, chrome-free so they run under test, on top of what the account holds
// (./holdings.ts, whose balances and clients the returned object passes on). A send is two
// requests:
//
// 1. prepare: read the account, balances and gas price; build the transaction, simulate it
//    for gas, build it again with the real fee; decode it and grade it with the risk rules
//    (the vault, like any dapp request). The review shows that decode. The prepared
//    request waits in session storage under its digest.
// 2. confirm: sign exactly the request whose digest the review showed, then broadcast.
//    The pending request is removed first, so a double click can't send twice.

import {
  adapterCw20,
  adapterDenom,
  ChainError,
  cosmosTxHash,
  cw20Address,
  cw20Denom,
  EvmRpc,
  evmAddress,
  explorerTxUrl,
  isContractAddress,
  isObject,
  MIN_GAS_PRICE,
  word,
  NETWORKS,
  shortDenom,
  type Coin,
  type NetworkId,
} from "@choice-wallet/chain";
import type { AccountInfo, CosmosDisplay, DeviceRequest, Result, Risk, SendReview, Sent, TokenInfo, TxState } from "@choice-wallet/ui/protocol";

import { memoFrom, type RiskFacts } from "./contacts";
import { cosmosAddress, createHoldings, type HoldingsDeps } from "./holdings";
import type { SolanaPending } from "./solana";
import type { Store } from "./service";
import { fail } from "./util";
import { isLedger } from "./wallets";

export interface SendDeps extends HoldingsDeps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  session: Store;
  /** The address book and the user's accounts for the risk rules, and whether `recipient`
   *  takes deposits with a memo (./contacts.ts). */
  riskFacts(network: NetworkId, recipient: string | null): Promise<RiskFacts>;
  /** A transaction the wallet just broadcast, signed by `from` (./watch.ts follows it). */
  onBroadcast?(network: NetworkId, hash: string, from: string): void;
  /** A deposit's burn just broadcast on the chain it comes from (./bridge.ts follows it). */
  onDeposit?(network: NetworkId, deposit: DepositSent): Promise<void>;
  /** Broadcasts a Solana transaction the vault signed (./solana.ts). */
  solanaBroadcast?(network: NetworkId, p: SolanaPending, signed: { signature: string; index: number }): Promise<Result<Sent>>;
}

/** Another EVM chain, where the wallet signs only bridge transfers into Injective (the vault
 *  refuses anything else there): what sending on it needs. */
export interface SourceChain {
  /** The bridge registry's key ("base"). */
  key: string;
  name: string;
  /** CAIP-2 ID, as the vault names it. */
  caip2: string;
  chainId: number;
  /** Its gas coin. */
  symbol: string;
  /** Gas is paid in USDC (Arc): the coin and the token are one balance. */
  gasIsUsdc: boolean;
  /** An OP Stack chain: besides gas, each transaction pays an Ethereum data fee, which its
   *  GasPriceOracle bounds. */
  opStack: boolean;
  usdc: string;
  rpcUrls: readonly string[];
  /** Transaction page, `{hash}` replaced. */
  explorerTx: string;
}

/** A deposit's burn, once broadcast. */
export interface DepositSent {
  chain: string;
  hash: string;
  amount: string;
  /** The account's 0x address. */
  account: string;
  /** On Solana: the burn's record (its rent comes back later) and the account's Solana
   *  address, which paid it. */
  event?: string;
  owner?: string;
}

/** OP Stack's GasPriceOracle predeploy, and `getL1FeeUpperBound(uint256 unsignedTxSize)`. */
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";

/** The most an OP Stack chain's Ethereum data fee can be for a transaction of `bytes` (wei);
 *  0 elsewhere. */
export async function dataFeeBound(rpc: EvmRpc, s: Pick<SourceChain, "opStack">, bytes: number): Promise<bigint> {
  if (!s.opStack) return 0n;
  return quantity(await rpc.call("eth_call", [{ to: GAS_PRICE_ORACLE, data: `0xf1c7a58b${bytes.toString(16).padStart(64, "0")}` }, "latest"]), "data fee");
}

/** The wallet keys of a source chain's coin (the review's fee) and of its USDC. */
export const sourceCoin = (s: Pick<SourceChain, "caip2">) => `native:${s.caip2}`;
export const sourceUsdc = (s: Pick<SourceChain, "caip2">) => `usdc:${s.caip2}`;


/** What `confirm` needs, kept in session storage between the two steps. */
interface Pending {
  network: NetworkId;
  digest: string;
  request: unknown;
  account: AccountInfo["account"];
  /** The wallet that signs for it. */
  wallet: string;
  confirm: string | null;
  blocked: boolean;
  /** An EVM transaction (broadcast with eth_sendRawTransaction), not a Cosmos one. */
  evm?: boolean;
  /** A Ledger account's public key: the device signs, and the vault checks it against this. */
  ledgerKey?: string;
  /** Where the device signs, when not at the account's own path (a Solana transaction: its
   *  key in the Solana app). */
  ledgerPath?: string;
  /** The signer's inj1 address, for following the transaction once it is broadcast. */
  from?: string;
  /** Signed on another chain, where USDC comes from: broadcast there. */
  source?: SourceChain;
  /** A deposit's burn, followed once broadcast. */
  deposit?: { amount: string; account: string; event?: string; owner?: string };
  /** A Solana transaction, signed with the account's Solana key (./solana.ts). */
  solana?: SolanaPending;
}

/** A Ledger send between its two steps: the vault gave the device its bytes; its signature
 *  comes back with `ledger_signed`. */
interface PendingDevice {
  pending: Pending;
  device: DeviceRequest;
}

/** Who signs a prepared send, as `confirm` needs it. */
const signerFields = (a: AccountInfo) => ({ account: a.account, wallet: a.wallet, ...(isLedger(a) ? { ledgerKey: a.public_key } : {}) });


/** Gas assumed while estimating an EVM transfer, and the most an estimate is believed
 *  (an ERC20 transfer uses about 35k to 60k). */
const EVM_SIMULATION_GAS = 100_000n;
const EVM_MAX_GAS = 1_000_000n;
/** The most gas a contract call the wallet makes (a swap step) may take. */
const EVM_MAX_CALL_GAS = 3_000_000n;
/** The most a bridge step on another chain may take (a burn uses about 100k to 200k). */
const SOURCE_MAX_GAS = 1_000_000n;

/** A JSON-RPC quantity, or why the node's answer isn't one. */
function quantity(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new ChainError(-1, `the node returned no ${what}`);
  return BigInt(v);
}

/** The vault's display of an EVM transaction, as far as `prepareEvmCall`'s checks read it. */
export type EvmDisplayLike = { kind: string; to: string; value: string; call: Record<string, unknown> };


/** Gas assumed for the simulation's own fee. */
const SIMULATION_GAS = 200_000n;
const MIN_GAS = 50_000n;
/** Above this a simulation result is not believed (a bank send uses about 83k). */
const MAX_GAS = 3_000_000n;


export function createSender(d: SendDeps) {
  const holdings = createHoldings(d);
  const { lcd, evm, sourceRpc, erc20Token, token, tokensFor, pairsFor, choiceFor, chainFailure } = holdings;

  async function prepare(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string; memo?: unknown }): Promise<Result<SendReview>> {
    if (typeof req.denom !== "string" || !req.denom) return fail("bad_request", "Pick a token.");
    if (typeof req.to !== "string" || req.to.length > 128) return fail("invalid_address", "Check the recipient address.");
    const memo = memoFrom(req.memo);
    if (memo === null) return fail("bad_request", "A memo is at most 256 characters, on one line.");
    if (evmAddress(req.denom)) {
      if (memo) return fail("bad_request", "An EVM-only token's send can't carry a memo.");
      return prepareEvm(network, account, { denom: req.denom, to: req.to, amount: req.amount });
    }
    const cw20 = cw20Address(req.denom);
    return prepareCosmos(network, account, {
      denom: req.denom,
      amount: req.amount,
      memo,
      recipient: req.to,
      messages: (amount) => [
        cw20
          ? { type: "cw20_transfer", contract: cw20, to: req.to, amount: amount.toString() }
          : { type: "bank_send", to: req.to, amount: [{ denom: req.denom, amount: amount.toString() }] },
      ],
    });
  }

  /** Convert a token into its other form through the network's CW20 adapter: a CW20 into
   *  its bank denom (which also makes it an ERC20 where it has a pair), or back. One for
   *  one; the adapter is the only contract involved. */
  async function prepareConvert(network: NetworkId, account: AccountInfo, req: { denom: string; amount: string }): Promise<Result<SendReview>> {
    if (typeof req.denom !== "string") return fail("bad_request", "Pick a token.");
    const cw20 = cw20Address(req.denom);
    const inner = adapterCw20(network, req.denom);
    if (!cw20 && !inner) return fail("bad_request", "This token has no other form.");
    return prepareCosmos(network, account, {
      denom: req.denom,
      amount: req.amount,
      knownContracts: [NETWORKS[network].cw20Adapter],
      returned: true,
      messages: (amount) => [cw20 ? { type: "cw20_to_bank", contract: cw20, amount: amount.toString() } : { type: "bank_to_cw20", contract: inner, amount: amount.toString() }],
    });
  }

  /** A Cosmos transaction the wallet builds, spending `amount` (or all, "max") of `denom`
   *  (a bank denom or a `cw20:` key): simulate it for gas, build it again with the real
   *  fee, decode and grade it. */
  async function prepareCosmos(
    network: NetworkId,
    account: AccountInfo,
    spec: {
      denom: string;
      amount: string;
      messages: (amount: bigint) => unknown[];
      knownContracts?: string[];
      /** It all comes back in another form (a conversion): the share-of-balance warnings
       *  don't apply, so the spent token's balance is left out of the risk context. The
       *  amount was checked against it here. */
      returned?: boolean;
      /** The amount comes from somewhere other than this account's balance of `denom` (a
       *  stake being unstaked or moved): how much is there, and what to call it when there
       *  isn't enough. The fee is still paid from the balance. */
      source?: { available: bigint; short: string };
      /** Kept back from the balance on "max", for later fees. */
      reserve?: bigint;
      /** There is no amount (claiming rewards); `amount` is ignored. */
      noAmount?: boolean;
      memo?: string;
      /** Who receives the amount, for the address book and the memo check. */
      recipient?: string;
      /** Who pays the fee through a fee allowance (a rescue's gas): the fee isn't taken from
       *  the balance, so "max" sends all of it. */
      feeGranter?: string;
      /** A "max" that comes to nothing is fine (a rescue with no INJ left still moves the
       *  rest). */
      allowZero?: boolean;
    },
  ): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const client = await lcd(network);
    // Read alongside the rest; the risk rules need it at the end.
    const facts = d.riskFacts(network, spec.recipient ?? null);
    facts.catch(() => {});
    const max = !spec.noAmount && spec.amount === "max";
    if (!spec.noAmount && !max && !(typeof spec.amount === "string" && /^[0-9]+$/.test(spec.amount) && BigInt(spec.amount) > 0n)) {
      return fail("invalid_amount", "Enter an amount above zero.");
    }
    const cw20 = cw20Address(spec.denom);
    try {
      const from = cosmosAddress(network, account);
      const [acct, coins, price, cw20Held] = await Promise.all([
        client.account(from),
        client.balances(from),
        client.gasPrice(),
        cw20 ? client.cw20Balance(cw20, from) : Promise.resolve(null),
      ]);
      if (!acct) return fail("no_funds", "This account has no funds yet.");
      if (cw20 && cw20Held === null) return fail("not_a_token", "That contract isn't a CW20 token.");
      const held = (denom: string) => (cw20 && denom === spec.denom ? cw20Held! : BigInt(coins.find((c) => c.denom === denom)?.amount ?? "0"));
      const symbol = (await token(network, client, spec.denom)).symbol;
      const feeSymbol = (await token(network, client, net.feeDenom)).symbol;
      // Whether the amount leaves the balance the fee is paid from.
      const fromBalance = !spec.source && !spec.noAmount;
      const sameDenom = fromBalance && spec.denom === net.feeDenom && !spec.feeGranter;
      const ownFee = (fee: bigint) => (spec.feeGranter ? 0n : fee);
      const available = () => spec.source?.available ?? held(spec.denom);
      const amountFor = (fee: bigint) =>
        spec.noAmount ? 0n : max ? (spec.source ? spec.source.available : held(spec.denom) - (sameDenom ? fee + (spec.reserve ?? 0n) : 0n)) : BigInt(spec.amount);
      const check = (amount: bigint, fee: bigint): Result<never> | null => {
        if (!spec.noAmount && (amount < 0n || (amount === 0n && !spec.allowZero) || amount > available())) {
          return fail("insufficient", spec.source ? `That's more than ${spec.source.short}.` : `Not enough ${symbol}.`);
        }
        if ((sameDenom ? amount : 0n) + ownFee(fee) > held(net.feeDenom)) return fail("insufficient", `Not enough ${feeSymbol} for the fee.`);
        return null;
      };
      const build = (amount: bigint, gas: bigint) =>
        d.vault<{ request: unknown; simulate_tx: string }>("build_cosmos", {
          chain: net.cosmos,
          signer: account.public_key,
          messages: spec.messages(amount),
          account_number: acct.accountNumber.toString(),
          sequence: acct.sequence.toString(),
          fee: { amount: [{ denom: net.feeDenom, amount: (gas * price).toString() }], gas_limit: gas.toString(), ...(spec.feeGranter ? { granter: spec.feeGranter } : {}) },
          memo: spec.memo ?? "",
          // Ledger's Cosmos app signs amino JSON only.
          ...(isLedger(account) ? { sign_mode: "amino_json" } : {}),
        });

      // Simulate with a provisional fee, then build with the real one.
      let amount = amountFor(SIMULATION_GAS * price);
      const early = check(amount, SIMULATION_GAS * price);
      if (early) return early;
      const sim = await build(amount, SIMULATION_GAS);
      if (!sim.ok) {
        return sim.error.message.startsWith("invalid address") ? fail("invalid_address", "Check the recipient address.") : sim;
      }
      const used = await client.simulate(sim.result.simulate_tx);
      const checkedBy = new URL(client.pool.current).host;
      let gas = (used * 13n) / 10n + 1n;
      if (gas < MIN_GAS) gas = MIN_GAS;
      if (gas > MAX_GAS) return fail("chain", "The gas estimate looks wrong. Try another endpoint.");
      amount = amountFor(gas * price);
      const late = check(amount, gas * price);
      if (late) return late;
      const built = await build(amount, gas);
      if (!built.ok) return built;

      // Balances and symbols for the risk rules, keyed as they are: bank denoms, and a
      // CW20 by its contract. Symbols are the wallet's list, else the short denom (a
      // creator-chosen symbol could pass for another token).
      const balances: Record<string, string> = Object.fromEntries(coins.map((c) => [c.denom, c.amount]));
      const symbols: Record<string, string> = {};
      for (const c of coins) {
        const t = await token(network, client, c.denom);
        symbols[c.denom] = t.known ? t.symbol : shortDenom(c.denom);
      }
      if (cw20) {
        balances[cw20] = cw20Held!.toString();
        symbols[cw20] = shortDenom(spec.denom);
      }
      if (spec.returned) delete balances[cw20 ?? spec.denom];
      const decoded = await d.vault<Pick<SendReview, "digest" | "risk"> & { display: CosmosDisplay }>("decode", {
        request: built.result.request,
        context: { balances, symbols, known_contracts: spec.knownContracts ?? [], ...(await facts) },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        ...signerFields(account),
        from: account.addresses[NETWORKS[network].cosmos] ?? "",
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
      };
      await d.session.set({ pending_send: pending });
      const tokens = await tokensFor(network, displayDenoms(network, display));
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** An EVM-only token's send: an ERC20 `transfer` on the EVM side, fee in INJ. Same shape
   *  as a bank send: build, estimate, build again with the real gas, decode and grade. With
   *  `revoke` (a spender), an `approve(spender, 0)` on the token instead, and no amount. */
  async function prepareEvm(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string; revoke?: string }): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const contract = evmAddress(req.denom)!;
    const from = account.addresses[net.evm];
    if (!from) return fail("bad_request", "This account has no EVM address.");
    const client = await lcd(network);
    const facts = d.riskFacts(network, req.revoke ? null : req.to);
    facts.catch(() => {});
    try {
      const rpc = await evm(network);
      const t = await erc20Token(network, rpc, contract);
      if (!t) return fail("not_a_token", "That contract isn't an ERC20 token.");
      const [nonce, block, tip, native, held] = await rpc.batch([
        { method: "eth_getTransactionCount", params: [from, "pending"] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        { method: "eth_maxPriorityFeePerGas", params: [] },
        { method: "eth_getBalance", params: [from, "latest"] },
        { method: "eth_call", params: [{ to: contract, data: `0x70a08231${word(from)}` }, "latest"] },
      ]);
      const tokenHeld = quantity(held, "token balance");
      const injHeld = quantity(native, "balance");
      const base = isObject(block) ? quantity(block["baseFeePerGas"], "base fee") : MIN_GAS_PRICE;
      // The chain's own bounds, as for Cosmos fees; a tip above the base fee isn't believed.
      const baseFee = base < MIN_GAS_PRICE ? MIN_GAS_PRICE : base > MIN_GAS_PRICE * 1000n ? MIN_GAS_PRICE * 1000n : base;
      const tipped = typeof tip === "string" ? quantity(tip, "tip") : 0n;
      const priority = tipped > baseFee ? baseFee : tipped;
      // Injective EVM charges gas limit × max fee per gas, with no refund of unused gas or
      // of the gap to the base fee (measured on testnet 2026-11-09). So no headroom on the
      // fee, whose base sits at the chain minimum, and a smaller gas margin than Cosmos's.
      const maxFee = baseFee + priority;
      const amount = req.revoke ? 0n : req.amount === "max" ? tokenHeld : BigInt(req.amount);
      if (!req.revoke && (amount <= 0n || amount > tokenHeld)) return fail("insufficient", `Not enough ${t.symbol}.`);
      const build = (gas: bigint) =>
        d.vault<{ request: { evm_transaction: { tx: { to: string; data: string } } } }>("build_evm", {
          chain: net.evm,
          from,
          to: req.revoke ? contract : req.to,
          token: contract,
          ...(req.revoke ? { revoke: req.revoke } : {}),
          amount: amount.toString(),
          nonce: Number(quantity(nonce, "nonce")),
          gas_limit: Number(gas),
          max_fee_per_gas: maxFee.toString(),
          max_priority_fee_per_gas: priority.toString(),
        });
      const sim = await build(EVM_SIMULATION_GAS);
      if (!sim.ok) return sim.error.message.startsWith("invalid address") ? fail("invalid_address", "Check the recipient address.") : sim;
      const { to, data } = sim.result.request.evm_transaction.tx;
      const used = quantity(await rpc.call("eth_estimateGas", [{ from, to, data, value: "0x0" }]), "gas estimate");
      const checkedBy = new URL(rpc.pool.current).host;
      let gas = (used * 12n) / 10n + 1n;
      if (gas < 21_000n) gas = 21_000n;
      if (gas > EVM_MAX_GAS) return fail("chain", "The gas estimate looks wrong. Try another endpoint.");
      if (gas * maxFee > injHeld) return fail("insufficient", "Not enough INJ for the fee.");
      const built = await build(gas);
      if (!built.ok) return built;

      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: {
          balances: { native: injHeld.toString(), [to]: tokenHeld.toString() },
          symbols: { [to]: t.known ? t.symbol : shortDenom(req.denom) },
          ...(await facts),
        },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        // A Ledger signs this too: its key goes along, as on the other paths.
        ...signerFields(account),
        from: account.addresses[net.cosmos] ?? "",
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
        evm: true,
      };
      await d.session.set({ pending_send: pending });
      const choice = await choiceFor(network, client, [net.feeDenom]);
      const price = choice.priceOf(contract);
      const fee = await token(network, client, net.feeDenom);
      const feePrice = choice.prices.get(net.feeDenom);
      const tokens = {
        [req.denom]: price ? { ...t, priceUsd: price } : t,
        [net.feeDenom]: feePrice ? { ...fee, priceUsd: feePrice } : fee,
      };
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** A contract call the wallet makes itself on the EVM side (a swap step): `call` is the
   *  vault's own-call spec (`build_evm`), `amount` the INJ sent or the allowance given. Gas
   *  is the larger of the node's estimate and `gasHint`, with half again on top: Injective
   *  charges the whole limit, but `eth_estimateGas` can come in low there, and a swap that
   *  runs out of gas fails after costing its fee. `expect` checks the vault's reading
   *  against what the host asked for; any difference stops it. */
  async function prepareEvmCall(
    network: NetworkId,
    account: AccountInfo,
    spec: {
      to: string;
      amount: bigint;
      call: unknown;
      gasHint?: bigint | null;
      tokens: string[];
      expect: (display: EvmDisplayLike) => string | null;
      extra?: Partial<SendReview>;
    },
  ): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const from = account.addresses[net.evm];
    if (!from) return fail("bad_request", "This account has no EVM address.");
    try {
      const rpc = await evm(network);
      const [nonce, block, tip, native] = await rpc.batch([
        { method: "eth_getTransactionCount", params: [from, "pending"] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        { method: "eth_maxPriorityFeePerGas", params: [] },
        { method: "eth_getBalance", params: [from, "latest"] },
      ]);
      const injHeld = quantity(native, "balance");
      const base = isObject(block) ? quantity(block["baseFeePerGas"], "base fee") : MIN_GAS_PRICE;
      const baseFee = base < MIN_GAS_PRICE ? MIN_GAS_PRICE : base > MIN_GAS_PRICE * 1000n ? MIN_GAS_PRICE * 1000n : base;
      const tipped = typeof tip === "string" ? quantity(tip, "tip") : 0n;
      const priority = tipped > baseFee ? baseFee : tipped;
      const maxFee = baseFee + priority;
      const build = (gas: bigint) =>
        d.vault<{ request: { evm_transaction: { tx: { to: string; data: string; value: string } } } }>("build_evm", {
          chain: net.evm,
          from,
          to: spec.to,
          amount: spec.amount.toString(),
          call: spec.call,
          nonce: Number(quantity(nonce, "nonce")),
          gas_limit: Number(gas),
          max_fee_per_gas: maxFee.toString(),
          max_priority_fee_per_gas: priority.toString(),
        });
      const sim = await build(EVM_MAX_CALL_GAS);
      if (!sim.ok) return sim;
      const t = sim.result.request.evm_transaction.tx;
      let used: bigint;
      try {
        used = quantity(await rpc.call("eth_estimateGas", [{ from, to: t.to, data: t.data, value: t.value }]), "gas estimate");
      } catch (e) {
        if (e instanceof ChainError && /revert/i.test(e.message)) return fail("reverts", "This would fail on chain now. Get a new quote and try again.");
        throw e;
      }
      const checkedBy = new URL(rpc.pool.current).host;
      const hint = spec.gasHint ?? 0n;
      let gas = ((used > hint ? used : hint) * 3n) / 2n;
      if (gas < 60_000n) gas = 60_000n;
      if (gas > EVM_MAX_CALL_GAS) return fail("chain", "The gas estimate looks wrong. Try another endpoint.");
      if (gas * maxFee + quantity(t.value, "value") > injHeld) return fail("insufficient", "Not enough INJ for this and its fee.");
      const built = await build(gas);
      if (!built.ok) return built;
      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: { balances: { native: injHeld.toString() }, ...(await d.riskFacts(network, null)) },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const wrong = spec.expect(display as unknown as EvmDisplayLike);
      if (wrong) return fail("mismatch", wrong);
      await d.session.set({
        pending_send: { network, digest, request: built.result.request, ...signerFields(account), from: account.addresses[NETWORKS[network].cosmos] ?? "", confirm: risk.confirm ?? null, blocked: risk.level === "blocked", evm: true } satisfies Pending,
      });
      const tokens = await tokensFor(network, [...spec.tokens, net.feeDenom]);
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy, ...spec.extra } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** One step of a bridge transfer into Injective, on the chain the USDC comes from: the
   *  vault's own-call spec (`build_evm` on that chain), which it builds, shows and signs only
   *  as an exact USDC approval for Circle's bridge or a deposit into this account on
   *  Injective. The fee is that chain's EIP-1559 price (twice the base fee, plus its tip),
   *  paid in its coin; `burns` is the USDC a burn takes, which on Arc comes out of the same
   *  balance as the fee. `expect` holds the vault's reading to what the host asked for. */
  async function prepareSourceCall(
    network: NetworkId,
    account: AccountInfo,
    source: SourceChain,
    spec: {
      to: string;
      amount: bigint;
      call: unknown;
      usdcHeld: bigint;
      burns: bigint;
      expect: (display: EvmDisplayLike) => string | null;
      extra?: Partial<SendReview>;
      deposit?: { amount: string; account: string };
    },
  ): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const from = account.addresses[net.evm];
    if (!from) return fail("bad_request", "This account has no EVM address.");
    try {
      const rpc = sourceRpc(source);
      const [nonce, block, tip, native] = await Promise.all([
        rpc.call("eth_getTransactionCount", [from, "pending"]),
        rpc.call("eth_getBlockByNumber", ["latest", false]),
        rpc.call("eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
        rpc.call("eth_getBalance", [from, "latest"]),
      ]);
      const held = quantity(native, "balance");
      const base = isObject(block) ? quantity(block["baseFeePerGas"], "base fee") : 0n;
      const priority = quantity(tip, "tip");
      const maxFee = base * 2n + priority;
      const build = (gas: bigint) =>
        d.vault<{ request: { evm_transaction: { tx: { to: string; data: string; value: string } } } }>("build_evm", {
          chain: source.caip2,
          from,
          to: spec.to,
          amount: spec.amount.toString(),
          call: spec.call,
          nonce: Number(quantity(nonce, "nonce")),
          gas_limit: Number(gas),
          max_fee_per_gas: maxFee.toString(),
          max_priority_fee_per_gas: priority.toString(),
        });
      const sim = await build(SOURCE_MAX_GAS);
      if (!sim.ok) return sim;
      const t = sim.result.request.evm_transaction.tx;
      let used: bigint;
      try {
        used = quantity(await rpc.call("eth_estimateGas", [{ from, to: t.to, data: t.data, value: t.value }]), "gas estimate");
      } catch (e) {
        if (e instanceof ChainError && /revert|exceeds balance|insufficient/i.test(e.message)) return fail("reverts", `This would fail on ${source.name} now. Check your USDC there and try again.`);
        throw e;
      }
      let gas = (used * 13n) / 10n;
      if (gas < 50_000n) gas = 50_000n;
      if (gas > SOURCE_MAX_GAS) return fail("chain", `The gas estimate on ${source.name} looks wrong. Try again later.`);
      const built = await build(gas);
      if (!built.ok) return built;
      // An unsigned EIP-1559 transaction is its calldata and about 120 bytes more.
      const dataFee = await dataFeeBound(rpc, source, (built.result.request.evm_transaction.tx.data.length - 2) / 2 + 120);
      const coin = gas * maxFee + dataFee + (source.gasIsUsdc ? spec.burns * 10n ** 12n : 0n);
      if (coin > held) return fail("gas", `Not enough ${source.symbol} on ${source.name} for the fee.`);
      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: { balances: { native: held.toString(), [source.usdc]: spec.usdcHeld.toString() } },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const wrong = spec.expect(display as unknown as EvmDisplayLike);
      if (wrong) return fail("mismatch", wrong);
      await d.session.set({
        pending_send: {
          network,
          digest,
          request: built.result.request,
          ...signerFields(account),
          from: account.addresses[net.cosmos] ?? "",
          confirm: risk.confirm ?? null,
          blocked: risk.level === "blocked",
          evm: true,
          source,
          ...(spec.deposit ? { deposit: spec.deposit } : {}),
        } satisfies Pending,
      });
      const usdc = sourceUsdc(source);
      const coinKey = sourceCoin(source);
      const tokens: Record<string, TokenInfo> = {
        [usdc]: { denom: usdc, symbol: "USDC", name: `USDC on ${source.name}`, decimals: 6, known: true },
        [coinKey]: { denom: coinKey, symbol: source.symbol, name: `${source.symbol} on ${source.name}`, decimals: 18, known: true },
      };
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy: new URL(rpc.pool.current).host, ...(dataFee > 0n ? { dataFee: dataFee.toString() } : {}), ...spec.extra } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  /** Sign the send the review showed, with the wallet that prepared it, then broadcast. */
  async function confirm(
    unlockKey: string,
    signerOf: (wallet: string) => Promise<{ secret: string; wallet: string } | null>,
    req: { digest: string; confirm?: string },
  ): Promise<Result<Sent | { device: DeviceRequest }>> {
    const { pending_send } = await d.session.get(["pending_send"]);
    const p = pending_send as Pending | undefined;
    if (!p || p.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (req.confirm ?? "").trim() !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    await d.session.remove(["pending_send"]);
    const signer = await signerOf(p.wallet);
    if (!signer) return fail("not_approved", "That wallet is gone. Review the send again.");
    if (p.ledgerKey && p.account.derivation === "ledger") {
      // The device signs: hand it the vault's bytes, and wait for its signature.
      const dev = await d.vault<Omit<DeviceRequest, "path">>("device_request", { request: p.request, digest: p.digest });
      if (!dev.ok) return dev;
      const device: DeviceRequest = { ...dev.result, path: p.ledgerPath ?? p.account.path };
      await d.session.set({ pending_device: { pending: p, device } satisfies PendingDevice });
      return { ok: true, result: { device } };
    }
    const signed = await d.vault<{ tx_raw: string } & { raw: string; hash: string }>("sign", {
      ...signer,
      unlock_key: unlockKey,
      account: p.account,
      request: p.request,
      digest: p.digest,
    });
    if (!signed.ok) return signed;
    return broadcast(p, signed.result);
  }

  /** A Ledger's signature for the send `confirm` handed it: checked by the vault against the
   *  account's key and the request's exact bytes, then broadcast. A rejected or failed
   *  signature leaves it waiting, so the user can try the device again. */
  async function deviceSigned(req: { digest: unknown; signature: unknown; format: unknown }): Promise<Result<Sent>> {
    const { pending_device } = await d.session.get(["pending_device"]);
    const w = pending_device as PendingDevice | undefined;
    if (!w || w.pending.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (typeof req.signature !== "string" || (req.format !== "der" && req.format !== "rs")) return fail("bad_request", "Not a signature.");
    const p = w.pending;
    const signed = await d.vault<{ tx_raw: string } & { raw: string; hash: string }>("device_sign", {
      request: p.request,
      digest: p.digest,
      public_key: p.ledgerKey,
      signature: req.signature,
      format: req.format,
    });
    if (!signed.ok) return signed;
    await d.session.remove(["pending_device"]);
    return broadcast(p, signed.result);
  }

  async function broadcast(p: Pending, signed: { tx_raw: string } & { raw: string; hash: string }): Promise<Result<Sent>> {
    if (p.solana) {
      if (!d.solanaBroadcast) return fail("bad_request", "Solana isn't set up.");
      const sent = await d.solanaBroadcast(p.network, p.solana, signed as unknown as { signature: string; index: number });
      if (sent.ok && p.deposit) await d.onDeposit?.(p.network, { chain: "solana", hash: sent.result.hash, ...p.deposit });
      return sent;
    }
    if (p.source) {
      // On the chain the USDC comes from. The background watcher follows Injective only; a
      // deposit's burn is followed by ./bridge.ts instead.
      const hash = signed.hash.toLowerCase();
      try {
        await sourceRpc(p.source).call("eth_sendRawTransaction", [signed.raw]);
      } catch (e) {
        if (!(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) return chainFailure(e);
      }
      if (p.deposit) await d.onDeposit?.(p.network, { chain: p.source.key, hash, ...p.deposit });
      return { ok: true, result: { hash, explorer: p.source.explorerTx.replace("{hash}", hash), chain: p.source.key } };
    }
    if (p.evm) {
      // The vault hashes what it signed; a node that already has the tx (a retry) is fine.
      const hash = signed.hash.toLowerCase();
      try {
        await (await evm(p.network)).call("eth_sendRawTransaction", [signed.raw]);
      } catch (e) {
        if (!(e instanceof ChainError && /already known|already imported|known transaction/i.test(e.message))) return chainFailure(e);
      }
      d.onBroadcast?.(p.network, hash, p.from ?? "");
      return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
    }
    const hash = await cosmosTxHash(signed.tx_raw);
    try {
      await (await lcd(p.network)).broadcast(signed.tx_raw, hash);
    } catch (e) {
      return chainFailure(e);
    }
    d.onBroadcast?.(p.network, hash, p.from ?? "");
    return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
  }

  /** A transaction's state: on Injective, or on `source` when it was signed there. */
  async function status(network: NetworkId, hash: string, source?: SourceChain): Promise<Result<TxState>> {
    if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
      try {
        const r = await (source ? sourceRpc(source) : await evm(network)).call("eth_getTransactionReceipt", [hash]);
        if (!isObject(r)) return { ok: true, result: { state: "pending" } };
        return { ok: true, result: r["status"] === "0x1" ? { state: "success" } : { state: "failed", log: "The transaction reverted." } };
      } catch (e) {
        return chainFailure(e);
      }
    }
    if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    try {
      const tx = await (await lcd(network)).tx(hash);
      if (!tx) return { ok: true, result: { state: "pending" } };
      return { ok: true, result: tx.code === 0 ? { state: "success" } : { state: "failed", log: tx.log } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  return {
    balances: holdings.balances,
    activity: holdings.activity,
    inspectToken: holdings.inspectToken,
    prepare,
    prepareConvert,
    prepareCosmos,
    prepareEvm,
    prepareEvmCall,
    prepareSourceCall,
    sourceRpc,
    pairs: async (network: NetworkId) => pairsFor(network, await lcd(network)),
    solanaPrices: holdings.solanaPrices,
    confirm,
    deviceSigned,
    status,
    lcd,
    evm,
    evmIndex: holdings.evmIndex,
    tokensFor,
    labels: holdings.labels,
    /** Report a broadcast made outside `confirm` (a site's), for the watcher. */
    broadcasted: (network: NetworkId, hash: string, from: string) => d.onBroadcast?.(network, hash, from),
    chainFailure,
    token,
    riskFacts: d.riskFacts,
  };
}

/** Every token a decoded Cosmos transaction moves, by the wallet's keys: the fee, coins
 *  sent or attached, a CW20 by its `cw20:` key, and what an adapter conversion returns. */
export function displayDenoms(network: NetworkId, display: CosmosDisplay): Set<string> {
  const out = new Set<string>(display.fee.amount.map((c) => c.denom));
  const coins = (v: unknown) => (Array.isArray(v) ? (v as Coin[]).filter((c) => typeof c?.denom === "string") : []);
  for (const msg of display.messages) {
    const m = msg as Record<string, unknown>;
    for (const c of [...coins(m["amount"]), ...coins(m["funds"])]) out.add(c.denom);
    const call = isObject(m["call"]) ? m["call"] : null;
    const contract = typeof m["contract"] === "string" ? m["contract"] : "";
    if (!call || !isContractAddress(contract)) continue;
    if (["cw20_transfer", "cw20_send", "cw20_increase_allowance", "cw20_decrease_allowance"].includes(String(call["type"]))) out.add(cw20Denom(contract));
    // A CW20 sent to the adapter comes back as its bank form.
    if (call["type"] === "cw20_send" && call["contract"] === NETWORKS[network].cw20Adapter) out.add(adapterDenom(network, contract));
    if (call["type"] === "adapter_redeem") {
      for (const f of coins(m["funds"])) {
        const inner = adapterCw20(network, f.denom);
        if (inner) out.add(cw20Denom(inner));
      }
    }
  }
  return out;
}

