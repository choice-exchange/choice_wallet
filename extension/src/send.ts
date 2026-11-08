// Balances and sends, chrome-free so they run under test. A send is two requests:
//
// 1. prepare: read the account, balances and gas price; build the transaction, simulate it
//    for gas, build it again with the real fee; decode it and grade it with the risk rules
//    (the vault, like any dapp request). The review shows that decode. The prepared
//    request waits in session storage under its digest.
// 2. confirm: sign exactly the request whose digest the review showed, then broadcast.
//    The pending request is removed first, so a double click can't send twice.

import {
  ChainError,
  cosmosTxHash,
  describeToken,
  explorerTxUrl,
  Lcd,
  NETWORKS,
  shortDenom,
  Unreachable,
  type Coin,
  type Fetch,
  type NetworkId,
  type Token,
} from "@choice-wallet/chain";
import type { AccountInfo, Balance, Result, Risk, SendReview, Sent, TxState } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";

export interface SendDeps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  fetch: Fetch;
  session: Store;
  /** The endpoints the user chose for a network (or the defaults). */
  endpoints(network: NetworkId): Promise<readonly string[]>;
}

/** What `confirm` needs, kept in session storage between the two steps. */
interface Pending {
  network: NetworkId;
  digest: string;
  request: unknown;
  account: AccountInfo["account"];
  confirm: string | null;
  blocked: boolean;
}

/** Gas assumed for the simulation's own fee. */
const SIMULATION_GAS = 200_000n;
const MIN_GAS = 50_000n;
/** Above this a simulation result is not believed (a bank send uses about 83k). */
const MAX_GAS = 3_000_000n;

const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

export function createSender(d: SendDeps) {
  const clients = new Map<string, Lcd>();
  const tokenCache = new Map<string, Promise<Token>>();

  async function lcd(network: NetworkId): Promise<Lcd> {
    const urls = await d.endpoints(network);
    const key = `${network} ${urls.join(" ")}`;
    let c = clients.get(key);
    if (!c) {
      c = new Lcd(NETWORKS[network], urls, d.fetch);
      clients.set(key, c);
    }
    return c;
  }

  function token(network: NetworkId, client: Lcd, denom: string): Promise<Token> {
    const key = `${network} ${denom}`;
    let t = tokenCache.get(key);
    if (!t) {
      t = describeToken(client, network, denom);
      tokenCache.set(key, t);
    }
    return t;
  }

  /** Turn chain and network failures into one short line for the UI. */
  function chainFailure(e: unknown): Result<never> {
    if (e instanceof Unreachable) return fail("unreachable", "Couldn't reach the network. Check your connection or endpoints.");
    if (e instanceof ChainError) {
      if (/insufficient (funds|fee)/i.test(e.message)) return fail("insufficient", "Not enough funds for this send and its fee.");
      return fail("chain", e.message.length > 200 ? `${e.message.slice(0, 199)}…` : e.message);
    }
    throw e;
  }

  async function balances(network: NetworkId, account: AccountInfo): Promise<Result<{ network: NetworkId; balances: Balance[] }>> {
    const client = await lcd(network);
    try {
      const coins = await client.balances(address(network, account));
      const list = await Promise.all(coins.map(async (c) => ({ ...(await token(network, client, c.denom)), amount: c.amount })));
      // INJ first, then the wallet's known tokens, then the rest.
      list.sort((a, b) => rank(network, a) - rank(network, b) || a.symbol.localeCompare(b.symbol));
      return { ok: true, result: { network, balances: list } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  async function prepare(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string }): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const client = await lcd(network);
    const max = req.amount === "max";
    if (typeof req.denom !== "string" || !req.denom) return fail("bad_request", "Pick a token.");
    if (!max && !(typeof req.amount === "string" && /^[0-9]+$/.test(req.amount) && BigInt(req.amount) > 0n)) {
      return fail("invalid_amount", "Enter an amount above zero.");
    }
    try {
      const from = address(network, account);
      const [acct, coins, price] = await Promise.all([client.account(from), client.balances(from), client.gasPrice()]);
      if (!acct) return fail("no_funds", "This account has no funds yet.");
      const held = (denom: string) => BigInt(coins.find((c) => c.denom === denom)?.amount ?? "0");
      const symbol = (await token(network, client, req.denom)).symbol;
      const feeSymbol = (await token(network, client, net.feeDenom)).symbol;
      const sameDenom = req.denom === net.feeDenom;
      const amountFor = (fee: bigint) => (max ? held(req.denom) - (sameDenom ? fee : 0n) : BigInt(req.amount));
      const check = (amount: bigint, fee: bigint): Result<never> | null => {
        if (amount <= 0n || amount > held(req.denom)) return fail("insufficient", `Not enough ${symbol}.`);
        if ((sameDenom ? amount : 0n) + fee > held(net.feeDenom)) return fail("insufficient", `Not enough ${feeSymbol} for the fee.`);
        return null;
      };
      const build = (amount: bigint, gas: bigint) =>
        d.vault<{ request: unknown; simulate_tx: string }>("build_cosmos", {
          chain: net.cosmos,
          signer: account.public_key,
          messages: [{ type: "bank_send", to: req.to, amount: [{ denom: req.denom, amount: amount.toString() }] }],
          account_number: acct.accountNumber.toString(),
          sequence: acct.sequence.toString(),
          fee: { amount: [{ denom: net.feeDenom, amount: (gas * price).toString() }], gas_limit: gas.toString() },
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

      // Symbols for the risk rules' messages: the wallet's list, else the short denom (a
      // creator-chosen symbol could pass for another token).
      const symbols: Record<string, string> = {};
      for (const c of coins) {
        const t = await token(network, client, c.denom);
        symbols[c.denom] = t.known ? t.symbol : shortDenom(c.denom);
      }
      const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
        request: built.result.request,
        context: { balances: Object.fromEntries(coins.map((c) => [c.denom, c.amount])), symbols },
      });
      if (!decoded.ok) return decoded;
      const { digest, display, risk } = decoded.result;
      const pending: Pending = {
        network,
        digest,
        request: built.result.request,
        account: account.account,
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
      };
      await d.session.set({ pending_send: pending });
      const denoms = new Set<string>(display.fee.amount.map((c) => c.denom));
      for (const m of display.messages) if (Array.isArray(m["amount"])) for (const c of m["amount"] as Coin[]) denoms.add(c.denom);
      const tokens = Object.fromEntries(await Promise.all([...denoms].map(async (dn) => [dn, await token(network, client, dn)] as const)));
      return { ok: true, result: { digest, display, risk: risk as Risk, tokens, checkedBy } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  async function confirm(keystore: string, unlockKey: string, req: { digest: string; confirm?: string }): Promise<Result<Sent>> {
    const { pending_send } = await d.session.get(["pending_send"]);
    const p = pending_send as Pending | undefined;
    if (!p || p.digest !== req.digest) return fail("not_approved", "This send expired. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (req.confirm ?? "").trim() !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    await d.session.remove(["pending_send"]);
    const signed = await d.vault<{ tx_raw: string }>("sign", {
      keystore,
      unlock_key: unlockKey,
      account: p.account,
      request: p.request,
      digest: p.digest,
    });
    if (!signed.ok) return signed;
    const hash = await cosmosTxHash(signed.result.tx_raw);
    try {
      await (await lcd(p.network)).broadcast(signed.result.tx_raw, hash);
    } catch (e) {
      return chainFailure(e);
    }
    return { ok: true, result: { hash, explorer: explorerTxUrl(NETWORKS[p.network], hash) } };
  }

  async function status(network: NetworkId, hash: string): Promise<Result<TxState>> {
    if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    try {
      const tx = await (await lcd(network)).tx(hash);
      if (!tx) return { ok: true, result: { state: "pending" } };
      return { ok: true, result: tx.code === 0 ? { state: "success" } : { state: "failed", log: tx.log } };
    } catch (e) {
      return chainFailure(e);
    }
  }

  return { balances, prepare, confirm, status };
}

function address(network: NetworkId, account: AccountInfo): string {
  const a = account.addresses[NETWORKS[network].cosmos];
  if (!a) throw new Error(`no ${network} address for this account`);
  return a;
}

function rank(network: NetworkId, t: Token): number {
  return t.denom === NETWORKS[network].feeDenom ? 0 : t.known ? 1 : 2;
}
