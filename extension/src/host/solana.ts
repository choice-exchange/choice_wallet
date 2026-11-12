// Solana for an account: its SOL and tokens, sending them, its history, and the transactions
// bridging USDC in from Solana signs there.
//
// Each recovery-phrase account has a Solana key (the vault derives it at Phantom's path), so
// the same address as in Phantom. The vault reads and signs every transaction
// (`solana_transaction`); this module builds them with injective-usdc-bridge's Solana
// toolkit (no Solana SDK ships), which also simulates each one first, so one that would fail
// is refused before anyone signs, and sizes its compute and priority fee. The cluster is
// asked through chain/'s SolanaRpc, on the endpoints the user set (or the defaults).
//
// Tokens: an endpoint that lists an owner's token accounts is asked; one that won't (the
// free mainnet endpoint) gets the accounts the owner's tokens would be at, for the tokens the
// wallet knows and the ones this account's history has shown.

import {
  base58ToBytes,
  bytesToBase58,
  bytesToBase64,
  bytesToHex,
  cleanText,
  hexToBytes,
  isSolanaAddress,
  joinSolanaTransaction,
  LOOKUP_TABLE_PROGRAM,
  lookupTableAddresses,
  NETWORKS,
  readSolanaMessage,
  SOL,
  SolanaRpc,
  splDenom,
  splitSolanaTransaction,
  splMint,
  summarizeSolana,
  tokenAccountOf,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ChainError,
  Unreachable,
  type Fetch,
  type NetworkId,
} from "@choice-wallet/chain";
import type { AccountInfo, ActivityItem, Balance, Result, Risk, SendReview, Sent, TokenInfo, TxState } from "@choice-wallet/ui/protocol";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  SolanaSimulationError,
  findProgramAddress,
  isWalletAddress,
  prepareSolanaTransaction,
  type SolanaInstruction,
} from "injective-usdc-bridge";

import type { RiskFacts } from "./contacts";
import type { Store } from "./service";
import { fail } from "./util";

export interface SolanaDeps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  fetch: Fetch;
  local: Store;
  session: Store;
  /** The Solana endpoints the user chose for a network's cluster (or the defaults). */
  endpoints(network: NetworkId): Promise<readonly string[]>;
  riskFacts(network: NetworkId, recipient: string | null): Promise<RiskFacts>;
}

/** A Solana transaction between its review and its broadcast (in `pending_send`). */
export interface SolanaPending {
  /** The message the vault reviewed, hex, and who signs it, in order (base58). */
  message: string;
  signers: string[];
  /** A CCTP burn's record: its one-off key (hex), which signs after the account. It holds
   *  nothing and can do nothing else, so it waits in session storage like the rest. */
  cosigner?: string;
  /** The message's blockhash stops being valid after this block height. */
  lastValidBlockHeight: number;
}

/** Tokens the wallet knows on each cluster, by mint (checked 2026-11-10: Circle's and
 *  Tether's mints, 6 decimals). */
const KNOWN: Readonly<Record<NetworkId, Readonly<Record<string, readonly [string, string, number]>>>> = {
  mainnet: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: ["USDC", "USD Coin", 6],
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: ["USDT", "Tether USD", 6],
  },
  testnet: {
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": ["USDC", "USD Coin", 6],
  },
};

const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const HISTORY_PAGE = 20;
const HISTORY_PARALLEL = 4;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A Solana transaction on the wire: the signatures in the signers' order (all zero where one
 *  is missing), then the message. */
export function wire(message: Uint8Array, signers: readonly string[], sigs: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const n = signers.length;
  const head = n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7];
  const out = new Uint8Array(head.length + 64 * n + message.length);
  out.set(head, 0);
  signers.forEach((s, i) => {
    const sig = sigs.get(s);
    if (sig) out.set(sig, head.length + 64 * i);
  });
  out.set(message, head.length + 64 * n);
  return out;
}

export function createSolana(d: SolanaDeps) {
  async function rpc(network: NetworkId): Promise<SolanaRpc> {
    return new SolanaRpc(NETWORKS[network].solana, await d.endpoints(network), d.fetch);
  }

  /** This account's Solana address, if it has one (an imported key or a Ledger doesn't). */
  function address(network: NetworkId, account: AccountInfo): string | null {
    return account.addresses[NETWORKS[network].solana.caip2] ?? null;
  }

  function ata(owner: string, mint: string, program: string): string {
    return findProgramAddress([base58ToBytes(owner), base58ToBytes(program), base58ToBytes(mint)], ASSOCIATED_TOKEN_PROGRAM);
  }

  const seenKey = (network: NetworkId, owner: string) => `solana_mints:${network}:${owner}`;

  /** Tokens this account's history has shown (beyond the wallet's own list). */
  async function seen(network: NetworkId, owner: string): Promise<string[]> {
    const k = seenKey(network, owner);
    const v = (await d.local.get([k]))[k];
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && isSolanaAddress(m)) : [];
  }

  async function remember(network: NetworkId, owner: string, mints: Iterable<string>): Promise<void> {
    const have = await seen(network, owner);
    const known = KNOWN[network];
    const fresh = [...new Set(mints)].filter((m) => !have.includes(m) && !known[m] && isSolanaAddress(m));
    if (fresh.length > 0) await d.local.set({ [seenKey(network, owner)]: [...have, ...fresh].slice(-50) });
  }

  /** How the wallet names a token: its own list, else the token's Metaplex metadata (which
   *  its creator chose, so it proves nothing and the token isn't marked known). Kept. */
  async function token(network: NetworkId, mint: string, decimals?: number): Promise<TokenInfo> {
    const chain = NETWORKS[network].solana.caip2;
    const k = KNOWN[network][mint];
    if (k) return { denom: splDenom(mint), symbol: k[0], name: k[1], decimals: k[2], known: true, chain };
    const cacheKey = `solana_token:${network}:${mint}`;
    const cached = (await d.local.get([cacheKey]))[cacheKey];
    if (cached && typeof cached === "object") return cached as TokenInfo;
    const short = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    let out: TokenInfo = { denom: splDenom(mint), symbol: short, name: "", decimals: decimals ?? 0, known: false, chain };
    try {
      const r = await rpc(network);
      const meta = findProgramAddress([utf8("metadata"), base58ToBytes(METAPLEX), base58ToBytes(mint)], METAPLEX);
      const [mintAcct, metaAcct] = await r.call("getMultipleAccounts", [[mint, meta], { encoding: "base64", commitment: "confirmed" }]).then((v) =>
        isRecord(v) && Array.isArray(v["value"]) ? v["value"] : [],
      );
      const mintData = accountBytes(mintAcct);
      // An SPL mint: decimals at byte 44.
      const dec = mintData && mintData.length >= 45 ? mintData[44]! : decimals;
      const named = metadataName(accountBytes(metaAcct));
      out = { ...out, decimals: dec ?? 0, ...(named ? { symbol: named.symbol || short, name: named.name } : {}) };
      if (dec !== undefined) await d.local.set({ [cacheKey]: out });
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
    }
    return out;
  }

  /** SOL and tokens. Null when the account has no Solana key; `down` when the cluster
   *  couldn't be asked. */
  async function holdings(network: NetworkId, account: AccountInfo): Promise<{ address: string; balances: Balance[]; down?: true } | null> {
    const owner = address(network, account);
    if (!owner) return null;
    const chain = NETWORKS[network].solana.caip2;
    try {
      const r = await rpc(network);
      const mints = [...Object.keys(KNOWN[network]), ...(await seen(network, owner))];
      const [lamports, accounts] = await Promise.all([
        r.balance(owner),
        r.tokenAccounts(owner, () => mints.flatMap((m) => [ata(owner, m, TOKEN_PROGRAM), ata(owner, m, TOKEN_2022_PROGRAM)])),
      ]);
      const byMint = new Map<string, { amount: bigint; decimals: number }>();
      for (const a of accounts) {
        const e = byMint.get(a.mint) ?? { amount: 0n, decimals: a.decimals };
        e.amount += a.amount;
        byMint.set(a.mint, e);
      }
      await remember(network, owner, [...byMint.keys()]);
      const tokens: Balance[] = await Promise.all(
        [...byMint].filter(([, e]) => e.amount > 0n).map(async ([mint, e]) => ({ ...(await token(network, mint, e.decimals)), amount: e.amount.toString() })),
      );
      const sol: Balance = { denom: SOL, symbol: "SOL", name: "Solana", decimals: 9, known: true, chain, amount: lamports.toString() };
      return { address: owner, balances: [sol, ...tokens.sort((a, b) => Number(b.known) - Number(a.known) || a.symbol.localeCompare(b.symbol))] };
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
      return { address: owner, balances: [], down: true };
    }
  }

  /** Build, simulate and price `instructions` (the account pays), have the vault read them,
   *  and keep the transaction for `confirm`. `context` adds to the risk rules' facts;
   *  `cosigner` is a CCTP burn record's one-off key. */
  async function prepareInstructions(
    network: NetworkId,
    account: AccountInfo,
    spec: {
      instructions: SolanaInstruction[];
      priorityAccounts: string[];
      recipient: string | null;
      balances: Record<string, string>;
      tokenAccounts?: Record<string, { owner: string; mint: string }>;
      tokens: Record<string, TokenInfo>;
      cosigner?: Uint8Array;
      /** A bridge burn: followed once broadcast. */
      deposit?: { to: string; amount: string; account: string; recipient: string; event: string; owner: string };
      extra?: Partial<SendReview>;
      /** Holds the vault's reading to what was asked; a message why not. */
      expect?: (display: Record<string, unknown>) => string | null;
    },
  ): Promise<Result<SendReview>> {
    const owner = address(network, account);
    if (!owner) return fail("no_solana", "This account has no Solana address.");
    const net = NETWORKS[network];
    let prepared: Awaited<ReturnType<typeof prepareSolanaTransaction>>;
    try {
      prepared = await prepareSolanaTransaction({
        rpcUrls: await d.endpoints(network),
        payer: owner,
        instructions: spec.instructions,
        priorityAccounts: spec.priorityAccounts,
        fetchImpl: d.fetch as typeof fetch,
      });
    } catch (e) {
      if (e instanceof SolanaSimulationError) return fail("reverts", simulationReason(e));
      return fail("chain", `${net.solana.name} couldn't be reached. Try again.`);
    }
    const message = prepared.message;
    const request = { solana_transaction: { chain: net.solana.caip2, signer: owner, message: bytesToHex(message.bytes) } };
    const facts = await d.riskFacts(network, spec.recipient);
    const symbols = Object.fromEntries(Object.values(spec.tokens).map((t) => [t.denom === SOL ? "native" : (splMint(t.denom) ?? t.denom), t.symbol]));
    const decoded = await d.vault<Pick<SendReview, "digest" | "display" | "risk">>("decode", {
      request,
      context: { ...facts, balances: spec.balances, symbols, ...(spec.tokenAccounts ? { solana_token_accounts: spec.tokenAccounts } : {}) },
    });
    if (!decoded.ok) return decoded;
    const { digest, display, risk } = decoded.result;
    const wrong = spec.expect?.(display as unknown as Record<string, unknown>);
    if (wrong) return fail("mismatch", wrong);
    await d.session.set({
      pending_send: {
        network,
        digest,
        request,
        account: account.account,
        wallet: account.wallet,
        // A Ledger signs in its Solana app, with the key read from there.
        ...(account.account.derivation === "ledger" && account.ledger_solana ? { ledgerKey: account.ledger_solana.public_key, ledgerPath: account.ledger_solana.path } : {}),
        confirm: risk.confirm ?? null,
        blocked: risk.level === "blocked",
        ...(spec.deposit ? { deposit: spec.deposit } : {}),
        solana: {
          message: bytesToHex(message.bytes),
          signers: message.signers,
          ...(spec.cosigner ? { cosigner: bytesToHex(spec.cosigner) } : {}),
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        } satisfies SolanaPending,
      },
    });
    const host = new URL((await d.endpoints(network))[0] ?? "https://solana").host;
    return { ok: true, result: { digest, display: display as SendReview["display"], risk: risk as Risk, tokens: spec.tokens, checkedBy: host, ...spec.extra } };
  }

  /** SOL or a token to another Solana wallet. A token goes to the recipient's associated
   *  account, opened first if it has none (the account pays its rent, about 0.002 SOL). */
  async function prepareSend(network: NetworkId, account: AccountInfo, req: { denom: string; to: string; amount: string }): Promise<Result<SendReview>> {
    const owner = address(network, account);
    if (!owner) return fail("no_solana", "This account has no Solana address.");
    const to = req.to.trim();
    if (!isSolanaAddress(to)) return fail("invalid_address", "That isn't a Solana address.");
    if (!/^[0-9]+$/.test(req.amount) || BigInt(req.amount) <= 0n) return fail("invalid_amount", "Enter an amount above zero.");
    const amount = BigInt(req.amount);
    const held = await holdings(network, account);
    if (!held || held.down) return fail("chain", `${NETWORKS[network].solana.name} couldn't be reached. Try again.`);
    const lamports = BigInt(held.balances.find((b) => b.denom === SOL)?.amount ?? "0");
    const balances: Record<string, string> = { native: lamports.toString() };
    const tokens: Record<string, TokenInfo> = { [SOL]: { denom: SOL, symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: NETWORKS[network].solana.caip2 } };
    if (req.denom === SOL) {
      const data = new Uint8Array(12);
      new DataView(data.buffer).setUint32(0, 2, true);
      new DataView(data.buffer).setBigUint64(4, amount, true);
      const transfer: SolanaInstruction = {
        programId: SYSTEM_PROGRAM,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: to, isSigner: false, isWritable: true },
        ],
        data,
      };
      return prepareInstructions(network, account, {
        instructions: [transfer],
        priorityAccounts: [owner, to],
        recipient: to,
        balances,
        tokens,
        expect: (display) => (sendMatches(display, { type: "sol_transfer", to, amount }) ? null : "The transaction isn't the send that was asked for."),
      });
    }
    const mint = splMint(req.denom);
    if (!mint || !isSolanaAddress(mint)) return fail("bad_request", "Not a Solana token.");
    // Tokens go to a wallet's own account for them: never to an account that is itself one.
    if (!isWalletAddress(to)) return fail("invalid_address", "That address can't hold tokens itself. Use the wallet's address.");
    const r = await rpc(network);
    let source: { address: string; program: string; decimals: number } | null = null;
    try {
      const accounts = await r.tokenAccounts(owner, () => [ata(owner, mint, TOKEN_PROGRAM), ata(owner, mint, TOKEN_2022_PROGRAM)]);
      const best = accounts.filter((a) => a.mint === mint).sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
      if (best) {
        source = { address: best.address, program: best.program, decimals: best.decimals };
        balances[mint] = best.amount.toString();
      }
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
      return fail("chain", `${NETWORKS[network].solana.name} couldn't be reached. Try again.`);
    }
    if (!source) return fail("insufficient", "This account holds none of that token.");
    const t = await token(network, mint, source.decimals);
    tokens[req.denom] = t;
    const dest = ata(to, mint, source.program);
    const create: SolanaInstruction = {
      programId: ASSOCIATED_TOKEN_PROGRAM,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: to, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: source.program, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]),
    };
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, amount, true);
    data[9] = source.decimals;
    const transfer: SolanaInstruction = {
      programId: source.program,
      keys: [
        { pubkey: source.address, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    };
    return prepareInstructions(network, account, {
      instructions: [create, transfer],
      priorityAccounts: [mint, dest],
      recipient: to,
      balances,
      tokens,
      tokenAccounts: { [source.address]: { owner, mint }, [dest]: { owner: to, mint } },
      expect: (display) => (sendMatches(display, { type: "token_transfer", to, amount, mint }) ? null : "The transaction isn't the send that was asked for."),
    });
  }

  /** The vault's signature (and a burn record's) into the transaction, then broadcast. It is
   *  kept (session storage) until it lands: Solana drops transactions under load, so each
   *  status check sends it again while its blockhash is valid. */
  async function broadcast(network: NetworkId, p: SolanaPending, signed: { signature: string; index: number }): Promise<Result<Sent>> {
    const message = hexToBytes(p.message);
    const sigs = new Map<string, Uint8Array>([[p.signers[signed.index]!, hexToBytes(signed.signature)]]);
    if (p.cosigner) {
      const key = hexToBytes(p.cosigner);
      sigs.set(bytesToBase58(ed25519.getPublicKey(key)), ed25519.sign(message, key));
    }
    if (p.signers.some((s) => !sigs.has(s))) return fail("bad_request", "A signer is missing.");
    const tx = bytesToBase64(wire(message, p.signers, sigs));
    const hash = bytesToBase58(sigs.get(p.signers[0]!)!);
    await d.session.set({ [`solana_sent:${hash}`]: { tx, lastValidBlockHeight: p.lastValidBlockHeight } });
    try {
      await (await rpc(network)).send(tx);
    } catch (e) {
      // Sent before (a retry): the cluster says so, and it's the same transaction.
      if (!(e instanceof ChainError && /already been processed/i.test(e.message))) {
        await d.session.remove([`solana_sent:${hash}`]);
        if (e instanceof ChainError) return fail("chain", `${NETWORKS[network].solana.name} refused it: ${e.message}`);
        if (e instanceof Unreachable) return fail("unreachable", `${NETWORKS[network].solana.name} couldn't be reached. Try again.`);
        throw e;
      }
    }
    const net = NETWORKS[network].solana;
    return { ok: true, result: { hash, explorer: net.explorerTx.replace("{hash}", hash), chain: net.caip2 } };
  }

  /** Where a transaction is. One the wallet sent and the cluster hasn't seen is sent again
   *  while its blockhash is valid, and said to have expired after. */
  async function status(network: NetworkId, signature: string): Promise<Result<TxState>> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return fail("bad_request", "Not a transaction signature.");
    const key = `solana_sent:${signature}`;
    try {
      const r = await rpc(network);
      const [s] = await r.statuses([signature]);
      if (s && s.confirmation !== "processed") {
        await d.session.remove([key]);
        return { ok: true, result: s.ok ? { state: "success" } : { state: "failed", log: "The transaction failed on Solana." } };
      }
      const kept = (await d.session.get([key]))[key] as { tx: string; lastValidBlockHeight: number } | undefined;
      if (kept && !s) {
        const height = await r.call("getBlockHeight", [{ commitment: "confirmed" }]);
        if (typeof height === "number" && height > kept.lastValidBlockHeight) {
          await d.session.remove([key]);
          return { ok: true, result: { state: "failed", log: "It expired before it landed. Nothing was sent." } };
        }
        await r.send(kept.tx).catch(() => {});
      }
      return { ok: true, result: { state: "pending" } };
    } catch (e) {
      if (e instanceof Unreachable) return fail("unreachable", `${NETWORKS[network].solana.name} couldn't be reached.`);
      if (e instanceof ChainError) return fail("chain", e.message);
      throw e;
    }
  }

  /** A page of history, newest first: transactions that touch the account or its token
   *  accounts. `before` is the last page's oldest signature. */
  async function activity(network: NetworkId, account: AccountInfo, before?: string): Promise<Result<{ items: ActivityItem[]; tokens: Record<string, TokenInfo>; next: string | null }>> {
    const owner = address(network, account);
    if (!owner) return { ok: true, result: { items: [], tokens: {}, next: null } };
    const caip2 = NETWORKS[network].solana.caip2;
    try {
      const r = await rpc(network);
      const mints = [...Object.keys(KNOWN[network]), ...(await seen(network, owner))];
      const tokenAccounts = mints.map((m) => ata(owner, m, TOKEN_PROGRAM));
      const lists = await Promise.all([owner, ...tokenAccounts].map((a, i) => r.signatures(a, i === 0 ? HISTORY_PAGE : 10, before).catch(() => [])));
      const bySig = new Map(lists.flat().map((s) => [s.signature, s]));
      const page = [...bySig.values()].sort((a, b) => b.slot - a.slot).slice(0, HISTORY_PAGE);
      const got: (ActivityItem | null)[] = new Array(page.length).fill(null);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(HISTORY_PARALLEL, page.length) }, async () => {
          while (next < page.length) {
            const i = next++;
            const tx = await r.transaction(page[i]!.signature).catch(() => null);
            got[i] = tx ? (summarizeSolana(tx, owner, caip2) as ActivityItem | null) : null;
          }
        }),
      );
      // A transaction that changed nothing here and that this account didn't sign (dust and
      // spam reach every busy address) is left out.
      const items = got
        .filter((a): a is ActivityItem => a !== null && (a.signed || a.changes.length > 0))
        // A burn to Injective names its recipient there (the high 12 bytes of a 0x one are 0).
        .map((a) =>
          a.bridge && a.bridge.domain === 29 && /^0x0{24}[0-9a-f]{40}$/.test(a.bridge.mintRecipient)
            ? { ...a, bridge: { ...a.bridge, chain: "Injective", recipient: `0x${a.bridge.mintRecipient.slice(26)}` } }
            : a,
        );
      const seenMints = items.flatMap((a) => a.changes.flatMap((c) => (splMint(c.denom) ? [splMint(c.denom)!] : [])));
      await remember(network, owner, seenMints);
      const tokens: Record<string, TokenInfo> = { [SOL]: { denom: SOL, symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: caip2 } };
      for (const m of new Set(seenMints)) tokens[splDenom(m)] = await token(network, m);
      return { ok: true, result: { items, tokens, next: page.length === HISTORY_PAGE ? page[page.length - 1]!.signature : null } };
    } catch (e) {
      if (e instanceof Unreachable) return fail("unreachable", `${NETWORKS[network].solana.name} couldn't be reached.`);
      if (e instanceof ChainError) return fail("chain", e.message);
      throw e;
    }
  }

  // -- A site's transaction (Wallet Standard) --

  /** A transaction a site asks this account to sign: the vault's request for it (with the
   *  lookup tables a v0 message reads, as the cluster holds them now), what a simulation says
   *  it moves for the account, and the tokens and context its review needs. The site's other
   *  signatures are kept for when it's signed. Throws a RangeError for what can't be signed. */
  async function siteTransaction(network: NetworkId, account: AccountInfo, wire: Uint8Array): Promise<SiteTransaction> {
    const net = NETWORKS[network];
    const owner = address(network, account);
    if (!owner) throw new RangeError("This account has no Solana address.");
    const { signatures, message } = splitSolanaTransaction(wire);
    const keys = readSolanaMessage(message);
    const index = keys.keys.indexOf(owner);
    if (index < 0 || index >= keys.signers) throw new RangeError("This account doesn't sign this transaction.");
    const r = await rpc(network);
    const tableAccounts = keys.lookups.length > 0 ? await r.rawAccounts(keys.lookups.map((l) => l.table)) : [];
    const tables = keys.lookups.map((l, i) => {
      const a = tableAccounts[i];
      if (!a || a.owner !== LOOKUP_TABLE_PROGRAM) throw new RangeError(`Its lookup table ${l.table} isn't on ${net.solana.name}.`);
      return { address: l.table, addresses: lookupTableAddresses(a.data) };
    });
    // What moves for the account: its SOL, and every token account of its that the
    // transaction writes (one it opens too), before and after a simulation.
    const writable = [...keys.keys.filter((_, i) => keys.writable[i]), ...keys.lookups.flatMap((l, i) => l.writable.map((j) => tables[i]!.addresses[j] ?? ""))].filter(Boolean);
    const watched = [...new Set([owner, ...writable])].slice(0, 100);
    const before = await r.rawAccounts(watched);
    const accounts: Record<string, { owner: string; mint: string }> = {};
    const moved = new Map<string, bigint>();
    /** Control passing to someone else, for the vault's rules (Context.solana_handovers). */
    const handovers: { kind: string; account?: string; mint?: string; to: string; all?: boolean }[] = [];
    let simulation: SiteTransaction["simulation"];
    try {
      const sim = await r.simulateWith(bytesToBase64(wire), watched);
      if (sim.err !== null) {
        simulation = { ok: false, error: siteFailure(sim.err, sim.logs) };
      } else {
        watched.forEach((a, i) => {
          const pre = before[i] ?? null;
          const post = sim.after[i] ?? null;
          if (a === owner) {
            moved.set(SOL, (post?.lamports ?? 0n) - (pre?.lamports ?? 0n));
            // A new program owner takes the account itself (System's Assign).
            if (pre && post && post.owner !== pre.owner) handovers.push({ kind: "assign", to: post.owner });
            return;
          }
          const t0 = pre ? tokenAccountOf(pre) : null;
          const t1 = post ? tokenAccountOf(post) : null;
          const t = t0 ?? t1;
          if (!t) return;
          // Named by who owns it now, before the transaction.
          accounts[a] = { owner: t.owner, mint: t.mint };
          // What the account holds before and after, by ownership: a token account it owned
          // before but not after is its whole balance leaving.
          const had = t0?.owner === owner ? t0.amount : 0n;
          const has = t1?.owner === owner ? t1.amount : 0n;
          if (had !== 0n || has !== 0n) moved.set(splDenom(t.mint), (moved.get(splDenom(t.mint)) ?? 0n) + has - had);
          if (t0?.owner === owner && t1 && t1.owner !== owner) handovers.push({ kind: "token_owner", account: a, mint: t1.mint, to: t1.owner });
          if (t1?.owner === owner) {
            if (t1.delegate && t1.delegate !== owner && t1.delegated > 0n && (t1.delegate !== t0?.delegate || t1.delegated > t0.delegated)) {
              handovers.push({ kind: "delegate", account: a, mint: t1.mint, to: t1.delegate, all: t1.delegated >= t1.amount });
            }
            if (t1.closeAuthority && t1.closeAuthority !== owner && t1.closeAuthority !== t0?.closeAuthority) {
              handovers.push({ kind: "close_authority", account: a, mint: t1.mint, to: t1.closeAuthority });
            }
          }
        });
        simulation = { ok: true, changes: [...moved].filter(([, v]) => v !== 0n).map(([denom, v]) => ({ denom, amount: v.toString() })) };
      }
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
      simulation = { ok: false, error: `${net.solana.name} couldn't simulate it.` };
    }
    // Every token account it writes, named, so the review can say whose it is.
    watched.forEach((a, i) => {
      const t = before[i] ? tokenAccountOf(before[i]!) : null;
      if (t && !accounts[a]) accounts[a] = { owner: t.owner, mint: t.mint };
    });
    const sol: TokenInfo = { denom: SOL, symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: net.solana.caip2 };
    const mints = [...new Set(Object.values(accounts).map((t) => t.mint))];
    const tokens: Record<string, TokenInfo> = { [SOL]: sol, ...Object.fromEntries(await Promise.all(mints.map(async (m) => [splDenom(m), await token(network, m)] as const))) };
    return {
      request: { solana_transaction: { chain: net.solana.caip2, signer: owner, message: bytesToHex(message), tables } },
      simulation,
      tokens,
      context: {
        balances: { native: (before[0]?.lamports ?? 0n).toString() },
        symbols: Object.fromEntries(Object.values(tokens).map((t) => [t.denom === SOL ? "native" : (splMint(t.denom) ?? t.denom), t.symbol])),
        solana_token_accounts: accounts,
        solana_handovers: handovers,
      },
      checkedBy: new URL(r.pool.current).host,
      signatures,
      message,
      index,
    };
  }

  /** A site's transaction once signed here: the account's signature in its place. Sent too
   *  when `send`; its signature (base58) either way. */
  async function siteSigned(network: NetworkId, t: Pick<SiteTransaction, "signatures" | "message" | "index">, signature: Uint8Array, send: boolean): Promise<{ wire: Uint8Array; signature: string }> {
    const signatures = t.signatures.map((s, i) => (i === t.index ? signature : s));
    const wire = joinSolanaTransaction(signatures, t.message);
    const sig = bytesToBase58(signatures[0]!);
    if (send) {
      if (signatures.some((s) => s.every((b) => b === 0))) throw new RangeError("Another signature it needs is missing.");
      await (await rpc(network)).send(bytesToBase64(wire));
    }
    return { wire, signature: sig };
  }

  return { rpc, address, ata, token, holdings, prepareInstructions, prepareSend, broadcast, status, activity, siteTransaction, siteSigned, known: (network: NetworkId) => KNOWN[network] };
}

/** Whether the vault's reading is the send that was asked for. */
function sendMatches(display: Record<string, unknown>, want: { type: "sol_transfer" | "token_transfer"; to: string; amount: bigint; mint?: string }): boolean {
  const steps = Array.isArray(display["instructions"]) ? (display["instructions"] as Record<string, unknown>[]) : [];
  const moves = steps.filter((s) => s["type"] === "sol_transfer" || s["type"] === "token_transfer");
  if (moves.length !== 1) return false;
  const m = moves[0]!;
  if (m["type"] !== want.type) return false;
  if (want.type === "sol_transfer") return m["to"] === want.to && m["lamports"] === want.amount.toString();
  return m["destination_owner"] === want.to && m["amount"] === want.amount.toString() && m["mint"] === want.mint;
}

/** A site's transaction, read for its review (see `siteTransaction`). */
export interface SiteTransaction {
  request: { solana_transaction: { chain: string; signer: string; message: string; tables: { address: string; addresses: string[] }[] } };
  simulation: { ok: true; changes: { denom: string; amount: string }[] } | { ok: false; error: string };
  tokens: Record<string, TokenInfo>;
  /** For the vault's rules: the account's SOL, token symbols, and whose each token account is. */
  context: Record<string, unknown>;
  checkedBy: string;
  signatures: Uint8Array[];
  message: Uint8Array;
  /** Where the account's signature goes. */
  index: number;
}

/** Why a site's transaction fails in simulation, in one line. */
function siteFailure(err: unknown, logs: readonly string[]): string {
  if (logs.some((l) => /insufficient (funds|lamports)/i.test(l))) return "It fails: not enough funds.";
  const line = [...logs].reverse().find((l) => /failed|error/i.test(l));
  return line ? `It fails: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}` : `It fails: ${JSON.stringify(err).slice(0, 160)}`;
}

function simulationReason(e: SolanaSimulationError): string {
  const logs = (e as unknown as { logs?: string[] }).logs ?? [];
  if (logs.some((l) => /insufficient (funds|lamports)/i.test(l))) return "Not enough SOL for this and its fee.";
  if (logs.some((l) => /insufficient funds/i.test(l))) return "Not enough of the token.";
  return "This would fail on Solana now. Check your balances and try again.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An account's data from a base64 `getMultipleAccounts` answer. */
function accountBytes(a: unknown): Uint8Array | null {
  if (!isRecord(a) || !Array.isArray(a["data"]) || typeof a["data"][0] !== "string") return null;
  try {
    const bin = atob(a["data"][0]);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Metaplex metadata: key (1), update authority (32), mint (32), then name and symbol, each a
 *  u32 length and that many bytes (padded with NULs). Cleaned like other on-chain names:
 *  no control, bidi or zero-width characters. */
export function metadataName(b: Uint8Array | null): { name: string; symbol: string } | null {
  if (!b || b.length < 69 + 4) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const str = (at: number): [string, number] | null => {
    if (at + 4 > b.length) return null;
    const n = view.getUint32(at, true);
    if (n > 200 || at + 4 + n > b.length) return null;
    const s = new TextDecoder().decode(b.slice(at + 4, at + 4 + n)).replace(/\0+$/, "");
    return [s, at + 4 + n];
  };
  const name = str(65);
  const symbol = name && str(name[1]);
  if (!name || !symbol) return null;
  return { name: cleanText(name[0], 40), symbol: cleanText(symbol[0], 12) };
}
