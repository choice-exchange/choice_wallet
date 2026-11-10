// Native USDC from Injective to other chains, over Circle's CCTP, with injective-usdc-bridge.
//
// 1. Routes: the chains Circle delivers to from Injective (the package's registry).
// 2. Quote: Circle's fees from Iris (`quoteTransfer`), for this amount and destination, and
//    the recipient checked: a 0x address on EVM chains (this account's own by default, the
//    same key), or a Solana wallet, whose USDC account Circle opens if it has none. The
//    quote waits in session storage.
// 3. Steps, each reviewed and confirmed like a send:
//    - `approve`: TokenMessengerV2 may take exactly this amount of USDC (when it can't yet);
//    - `burn`: the package's calldata, which the vault reads and builds only as a USDC burn
//      to a chain it names, delivered by Circle, to a usable address (vault `cctp`). The
//      vault's reading is then held to the quote the user saw.
//    After each step lands, the UI asks for the next one.
// 4. Status: Circle's attestation service (Iris) says when the burn is attested and when its
//    Forwarding Service minted on the destination.
//
// Circle learns the burn (it is on chain anyway); for a Solana recipient the package's
// Solana RPC is asked whether the wallet already has a USDC account.
//

import { NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, BridgeQuote, BridgeRoutes, BridgeStatus, BridgeStep, Result, SendReview } from "@choice-wallet/ui/protocol";
import {
  INJECTIVE_DOMAIN,
  RouteError,
  associatedTokenAddress,
  buildBurn,
  chainByKey,
  checkSolanaRecipient,
  explorerTxUrl,
  injective,
  peers,
  quoteTransfer,
  toEvmAddress,
  type Chain,
  type Quote,
} from "injective-usdc-bridge";

import type { EvmDisplayLike } from "../send";
import { fail, randomId } from "../util";
import { BRIDGE_QUOTE_TTL_MS, bridgeChains, same, tokenMessenger, TRACK_URL, type BridgeContext } from "./shared";

/** What waits between the quote and its steps. Amounts are decimal strings. */
interface Stored {
  id: string;
  network: NetworkId;
  /** This account's 0x address, which signs. */
  account: string;
  chain: string;
  /** As the burn names it: a 0x address, or the Solana wallet. */
  recipient: string;
  amount: string;
  recipientSetup: boolean;
  maxFee: string;
  minReceived: string;
  at: number;
}

export function createBridgeOut(c: BridgeContext) {
  const { sender, session, now, plainFetch, iris, usdc } = c;

  async function routes(network: NetworkId, account: AccountInfo): Promise<Result<BridgeRoutes>> {
    const u = await usdc(network, account);
    if (!u.ok) return u;
    return {
      ok: true,
      result: {
        chains: bridgeChains(network).map((c) => ({ key: c.key, name: c.name, kind: c.kind })),
        usdc: u.result.denom,
        balance: u.result.balance.toString(),
        address: account.addresses[NETWORKS[network].evm] ?? "",
      },
    };
  }

  /** The recipient as the burn names it, or why it can't be one. */
  async function recipientFor(chain: Chain, typed: string): Promise<Result<{ recipient: string; setup: boolean }>> {
    const s = typed.trim();
    if (chain.kind === "evm") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return fail("bad_recipient", `Enter a 0x address on ${chain.name}.`);
      const checksummed = toEvmAddress(s);
      if (!checksummed) return fail("bad_recipient", `Enter a 0x address on ${chain.name}.`);
      // Mixed case is a checksum; one that doesn't match is a typo.
      if (s !== s.toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase() && s !== checksummed) return fail("bad_recipient", "That address has a typo: its capital letters don't match.");
      return { ok: true, result: { recipient: checksummed, setup: false } };
    }
    let check;
    try {
      check = await checkSolanaRecipient(chain.rpcUrls, s, chain.usdcMint, plainFetch);
    } catch {
      return fail("unreachable", "Couldn't check that Solana address. Try again.");
    }
    if (!check.ok) {
      const why = { not_an_address: "That isn't a Solana address.", token_account: "That's a USDC account. Enter the wallet address it belongs to.", not_a_wallet: "That Solana address isn't a wallet." }[check.reason];
      return fail("bad_recipient", why ?? "That Solana address can't receive USDC.");
    }
    return { ok: true, result: { recipient: s, setup: !check.tokenAccountExists } };
  }

  async function ask(network: NetworkId, chain: Chain, amount: bigint, setup: boolean): Promise<Result<Quote>> {
    try {
      const q = await quoteTransfer({ iris: iris(network), route: { source: injective(network), destination: chain }, amount, forward: true, recipientSetup: setup });
      return { ok: true, result: q };
    } catch (e) {
      if (e instanceof RouteError) return fail("bridge_amount", /does not cover fees/.test(e.message) ? "That's not enough to cover Circle's fee." : e.message);
      return fail("unreachable", "Couldn't reach Circle for its fee. Try again.");
    }
  }

  async function quote(network: NetworkId, account: AccountInfo, req: { to?: unknown; amount?: unknown; recipient?: unknown }): Promise<Result<BridgeQuote>> {
    const me = account.addresses[NETWORKS[network].evm];
    if (!me) return fail("bad_request", "This account has no EVM address.");
    const chain = typeof req.to === "string" ? bridgeChains(network).find((c) => c.key === req.to) : undefined;
    if (!chain) return fail("bad_request", "Pick a chain to bridge to.");
    if (typeof req.recipient !== "string") return fail("bad_recipient", "Enter who receives it.");
    const r = await recipientFor(chain, req.recipient);
    if (!r.ok) return r;
    const u = await usdc(network, account);
    if (!u.ok) return u;
    let amount: bigint;
    if (req.amount === "max") amount = u.result.balance;
    else if (typeof req.amount === "string" && /^[0-9]{1,30}$/.test(req.amount)) amount = BigInt(req.amount);
    else return fail("invalid_amount", "Enter an amount above zero.");
    if (amount <= 0n) return fail("invalid_amount", u.result.balance === 0n ? "This account has no USDC." : "Enter an amount above zero.");
    if (amount > u.result.balance) return fail("insufficient", "That's more USDC than you have.");
    const q = await ask(network, chain, amount, r.result.setup);
    if (!q.ok) return q;
    const id = randomId();
    const stored: Stored = {
      id,
      network,
      account: me,
      chain: chain.key,
      recipient: r.result.recipient,
      amount: amount.toString(),
      recipientSetup: r.result.setup,
      maxFee: q.result.maxFee.toString(),
      minReceived: q.result.minReceived.toString(),
      at: now(),
    };
    await session.set({ bridge_quote: stored });
    const steps = await stepsFor(network, stored);
    if (!steps.ok) return steps;
    return { ok: true, result: view(stored, chain, steps.result) };
  }

  function view(s: Stored, chain: Chain, steps: BridgeStep[]): BridgeQuote {
    return {
      id: s.id,
      chain: chain.key,
      chainName: chain.name,
      recipient: s.recipient,
      amount: s.amount,
      maxFee: s.maxFee,
      minReceived: s.minReceived,
      recipientSetup: s.recipientSetup,
      steps,
    };
  }

  /** What a stored quote still needs, in order. */
  async function stepsFor(network: NetworkId, s: Stored): Promise<Result<BridgeStep[]>> {
    try {
      const rpc = await sender.evm(network);
      const [allowed] = await rpc.erc20Allowances([{ token: injective(network).usdc, spender: tokenMessenger(network) }], s.account);
      return { ok: true, result: allowed === null || allowed === undefined || allowed < BigInt(s.amount) ? ["approve", "burn"] : ["burn"] };
    } catch (e) {
      return sender.chainFailure(e);
    }
  }

  /** The next step of the stored quote, ready to review. */
  async function prepare(network: NetworkId, account: AccountInfo, id: unknown): Promise<Result<SendReview>> {
    const { bridge_quote } = await session.get(["bridge_quote"]);
    const s = bridge_quote as Stored | undefined;
    const me = account.addresses[NETWORKS[network].evm];
    const chain = s ? chainByKey(network, s.chain) : undefined;
    if (!s || s.id !== id || s.network !== network || !me || !same(s.account, me) || !chain) return fail("not_found", "This quote is gone. Get a new one.");
    const steps = await stepsFor(network, s);
    if (!steps.ok) return steps;
    const step = steps.result[0]!;
    // Circle's fee is asked again before the burn if the quote aged (approvals don't depend
    // on it); the review shows the new most before anything is signed.
    if (step === "burn" && now() - s.at > BRIDGE_QUOTE_TTL_MS) {
      const q = await ask(network, chain, BigInt(s.amount), s.recipientSetup);
      if (!q.ok) return q;
      s.maxFee = q.result.maxFee.toString();
      s.minReceived = q.result.minReceived.toString();
      s.at = now();
      await session.set({ bridge_quote: s });
    }
    const u = await usdc(network, account);
    if (!u.ok) return u;
    const amount = BigInt(s.amount);
    const extra = {
      bridge: { step, left: steps.result.length - 1, chain: chain.name, recipient: s.recipient, amount: s.amount, maxFee: s.maxFee, minReceived: s.minReceived, usdc: u.result.denom },
    } satisfies Partial<SendReview>;
    if (step === "approve") {
      return sender.prepareEvmCall(network, account, {
        to: injective(network).usdc,
        amount,
        call: { type: "bridge_approve" },
        tokens: [u.result.denom],
        extra,
        expect: (d) => (d.call["type"] === "approve" && same(String(d.call["spender"]), tokenMessenger(network)) && d.call["amount"] === s.amount ? null : "The approval isn't the one asked for."),
      });
    }
    // The quote as asked. Injective is never a fast source: its transfers attest at standard
    // finality, which there takes seconds.
    const quoted: Quote = {
      direction: "withdraw",
      amount,
      speed: "standard",
      minFinalityThreshold: 2000,
      protocolFee: 0n,
      forwardingFee: BigInt(s.maxFee),
      gasDropFee: 0n,
      bridgeFee: 0n,
      maxFee: BigInt(s.maxFee),
      minReceived: BigInt(s.minReceived),
      forwarded: true,
      recipientSetup: s.recipientSetup,
    };
    let data: string;
    try {
      const route = { source: injective(network), destination: chain };
      data = buildBurn({ network, route, quote: quoted, recipient: s.recipient, allowance: amount }).burn.data;
    } catch (e) {
      return fail("bad_request", e instanceof Error ? e.message : "Couldn't build the transfer.");
    }
    return sender.prepareEvmCall(network, account, {
      to: tokenMessenger(network),
      amount: 0n,
      call: { type: "bridge", data },
      tokens: [u.result.denom],
      extra,
      expect: (d) => matchesQuote(d, s, chain),
    });
  }

  /** Where a burn is: Iris has it, Circle attested it, Circle's mint landed. */
  async function status(network: NetworkId, hash: unknown): Promise<Result<BridgeStatus>> {
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return fail("bad_request", "Not a transaction hash.");
    const track = `${TRACK_URL}/${INJECTIVE_DOMAIN}/${hash}`;
    let messages;
    try {
      messages = await iris(network).getMessages(INJECTIVE_DOMAIN, hash as `0x${string}`);
    } catch {
      return fail("unreachable", "Couldn't reach Circle. Try again.");
    }
    const m = messages[0];
    if (!m) return { ok: true, result: { phase: "pending", track } };
    if (m.status !== "complete") return { ok: true, result: { phase: "attesting", track } };
    const dest = m.decodedMessage?.destinationDomain === undefined ? undefined : peers(network).find((c) => String(c.domain) === String(m.decodedMessage?.destinationDomain));
    if (m.forwardState === "CONFIRMED" && m.forwardTxHash) {
      return { ok: true, result: { phase: "delivered", track, mintTx: m.forwardTxHash, ...(dest ? { mintUrl: explorerTxUrl(dest, m.forwardTxHash) } : {}) } };
    }
    if (m.forwardState === "FAILED") return { ok: true, result: { phase: "stuck", track } };
    return { ok: true, result: { phase: "delivering", track } };
  }


  return { routes, quote, prepare, status };
}

/** The vault's reading of the burn against the quote the user saw. */
function matchesQuote(d: EvmDisplayLike, s: Stored, chain: Chain): string | null {
  const c = d.call;
  if (c["type"] !== "bridge") return "The transfer isn't one the wallet can read.";
  if (c["chain"] !== chain.name || c["delivery"] !== "circle") return "The transfer goes somewhere other than its quote.";
  if (c["amount"] !== s.amount || c["max_fee"] !== s.maxFee) return "The transfer doesn't match its quote.";
  const expected = chain.kind === "solana" ? associatedTokenAddress(s.recipient, chain.usdcMint) : s.recipient;
  if (typeof c["recipient"] !== "string" || !same(c["recipient"], expected)) return "The transfer pays someone else.";
  if (chain.kind === "solana" && s.recipientSetup && c["account_owner"] !== s.recipient) return "The transfer opens an account for someone else.";
  return null;
}
