// Sites: what a web page may ask of the wallet, and the approvals it waits for. Chrome-free,
// so it runs under test; the service worker passes in how to open an approval window.
//
// - A site's origin comes from the browser (the content script's sender), never the page.
// - Connecting is a grant per origin, kept in local storage until the user disconnects.
//   A site that isn't connected sees no account; a locked wallet shows none to anyone.
// - Anything that signs or changes the wallet waits for an approval window. The window
//   shows the vault's decode of exactly what will be signed (prepared when the window asks,
//   so the nonce and fee are fresh), and approving names that decode's digest. A request
//   is answered once; closing the window rejects it.
// - Requests live in this worker's memory. If the worker stops, they fail, and the site
//   can ask again.
//
// Each chain's requests are handled in its own file (./evm.ts, ./cosmos.ts, ./solana.ts);
// this one keeps the grants, the requests waiting and the approval window's side.

import { ChainError, isObject, NETWORKS, Unreachable, type Coin, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Connection, CosmosDisplay, DappRequest, DappReview, DeviceRequest, Result, Risk } from "@choice-wallet/ui/protocol";

import { displayDenoms } from "../send";
import { fail, randomId, turns, type Turn } from "../util";
import { createCosmosSite } from "./cosmos";
import { createEvmSite } from "./evm";
import { INTERNAL, INVALID_PARAMS, no, PENDING, UNAUTHORIZED, UNSUPPORTED, USER_REJECTED, type DappHost, type DappReply, type Grants, type Named, type Waiting } from "./shared";
import { createSolanaSite } from "./solana";
import { recipientsOf } from "./recipients";

export type { DappHost, DappReply } from "./shared";

/** Requests waiting at once: in all, and per site. */
const MAX_WAITING = 10;
const MAX_PER_SITE = 3;

export function createDapps(h: DappHost) {
  const waiting = new Map<string, Waiting>();

  async function grants(): Promise<Grants> {
    const { connections } = (await h.local.get(["connections"])) as { connections?: Grants };
    return connections ?? {};
  }

  /** Every change to the grants runs here, one at a time, on the map as it is in its turn,
   *  so no writer overwrites another's change (a user's disconnect, a site's revoke, a
   *  connect). `change` edits the map and says whether it changed it; only then is it saved. */
  /** Run `work` in the grants' turn: the host's records queue, which an added chain's removal
   *  shares too. A site's chain pick is saved and removed there, so none is saved for a site
   *  without a grant, nor outlives one (run-2 C9). */
  const inGrantTurn: Turn = h.turn ?? turns();
  function changeGrants(change: (all: Grants) => boolean): Promise<boolean> {
    return inGrantTurn(async () => {
      const all = await grants();
      if (!change(all)) return false;
      await h.local.set({ connections: all });
      return true;
    });
  }

  /** Drop a site's chain picks, in the grants' turn: when its grant goes, and when a new
   *  one starts (so a reconnect starts on Injective's EVM side). Writes nothing when it
   *  has none. */
  function forgetSiteChains(origin: string): Promise<void> {
    return inGrantTurn(async () => {
      const { site_chains } = (await h.local.get(["site_chains"])) as { site_chains?: Record<string, unknown> };
      if (!site_chains || !Object.hasOwn(site_chains, origin)) return;
      const rest = { ...site_chains };
      delete rest[origin];
      await h.local.set({ site_chains: rest });
    });
  }

  async function isConnected(origin: string): Promise<boolean> {
    return (await grants())[origin] !== undefined;
  }

  /** Put a request in front of the user. Resolves when they answer or close the window. */
  async function ask(w: Omit<Waiting, "req" | "resolve">, req: Omit<DappRequest, "id">): Promise<DappReply> {
    const site = [...waiting.values()].filter((x) => x.req.origin === req.origin);
    if (waiting.size >= MAX_WAITING || site.length >= MAX_PER_SITE) return no(PENDING, "Too many requests are waiting. Answer them in the wallet first.");
    if (req.kind !== "sign" && site.some((x) => x.req.kind === req.kind)) return no(PENDING, "A request like this is already waiting in the wallet.");
    const id = randomId(16);
    return new Promise<DappReply>((resolve) => {
      const entry: Waiting = { ...w, req: { ...req, id }, resolve };
      // One window per site at a time: the next waits until this one is answered, so a site
      // can't stack windows that take the focus one after another.
      const behind = site.some((x) => x.shown);
      waiting.set(id, entry);
      if (!behind) show(entry);
    });
  }

  /** Windows closed that no request was known by yet: one closed before its ID came back. */
  const closedEarly: number[] = [];

  function show(entry: Waiting) {
    entry.shown = true;
    const failed = () => settle(entry.req.id, no(INTERNAL, "The wallet couldn't open its approval window."));
    // A request whose window can't be told apart is ended, never left holding the site's
    // queue: one with no window ID, or whose window already closed.
    h.openWindow(entry.req.id).then((windowId) => {
      if (windowId === undefined) return failed();
      if (closedEarly.includes(windowId)) return settle(entry.req.id, no(USER_REJECTED, "The user closed the request."));
      entry.windowId = windowId;
    }, failed);
  }

  /** A request leaves the queue (answered, rejected, or handed to its signer): the site's
   *  next one, if any, gets its window, unless everything is being rejected at once. */
  function leave(id: string, next = true) {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (!next || !w.shown) return;
    const queued = [...waiting.values()].find((x) => x.req.origin === w.req.origin && !x.shown);
    if (queued) show(queued);
  }

  function settle(id: string, reply: DappReply, next = true) {
    const w = waiting.get(id);
    if (!w) return;
    leave(id, next);
    w.resolve(reply);
  }

  async function connect(origin: string, then: () => Promise<DappReply>): Promise<DappReply> {
    if ((await isConnected(origin)) && (await h.unlocked())) return then();
    return ask(
      {
        approve: async () => {
          let fresh = false;
          await changeGrants((all) => {
            if (Object.hasOwn(all, origin)) return false;
            all[origin] = { since: Date.now() };
            fresh = true;
            return true;
          });
          if (fresh) await forgetSiteChains(origin);
          h.notify();
          return then();
        },
      },
      { origin, network: await h.network(), kind: "connect" },
    );
  }

  /** A signature request: checked now, built and decoded when the window asks. */
  async function sign(
    origin: string,
    method: string,
    build: NonNullable<Waiting["build"]>,
    finish: NonNullable<Waiting["finish"]>,
    named?: Named,
  ): Promise<DappReply> {
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect to Choice Wallet first.");
    if (named && !named.address) return no(UNAUTHORIZED, "Name the account to sign with.");
    return ask({ build, finish, ...(named ? { named } : {}) }, { origin, network: await h.network(), kind: "sign", method });
  }

  const core = { h, isConnected, connect, ask, sign, disconnect, inGrantTurn };
  const sites = [createEvmSite(core), createCosmosSite(core), createSolanaSite(core)];

  /** Handle one message from a page, at `origin`. */
  async function handle(origin: string, msg: unknown): Promise<DappReply> {
    if (!isObject(msg) || typeof msg["method"] !== "string") return no(INVALID_PARAMS, "Not a request.");
    const method = msg["method"];
    const params = msg["params"];
    try {
      for (const site of sites) {
        const reply = await site.handle(origin, method, params);
        if (reply) return reply;
      }
      return no(UNSUPPORTED, `${method} isn't supported.`);
    } catch (e) {
      if (e instanceof ChainError) return no(INTERNAL, e.message);
      if (e instanceof Unreachable) return no(INTERNAL, "Couldn't reach the network.");
      if (e instanceof RangeError) return no(INVALID_PARAMS, e.message);
      throw e;
    }
  }

  // -- The approval window's side --

  function request(id: unknown): Result<DappRequest> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    return w ? { ok: true, result: w.req } : fail("not_found", "This request is no longer open.");
  }

  async function review(id: unknown): Promise<Result<DappReview>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    if (!w.build) return fail("bad_request", "Nothing to review.");
    const u = await h.unlocked();
    if (!u) return fail("locked", "Unlock the wallet first.");
    await h.touch();
    // Only the account the site named answers it.
    if (w.named && w.named.of(u.account) !== w.named.address) return fail("wrong_account", "The account in use isn't the one this site asked to sign with. Switch back, or ask the site again.");
    const network = w.req.network;
    if (network !== (await h.network())) return fail("network", "The wallet changed network. Ask the site again.");
    try {
      const built = await w.build(u.account);
      const all = await grants();
      const known = (all[w.req.origin]?.approvals ?? 0) > 0;
      const context = built.context
        ? { origin: w.req.origin, origin_known: known, ...(await h.sender.riskFacts(network, null)), ...built.context }
        : await reviewContext(network, u.account, w.req.origin, known);
      type Decoded = { digest: string; display: DappReview["display"]; risk: Risk };
      let d = await h.vault<Decoded>("decode", { request: built.request, context });
      if (!d.ok) return d;
      // Who it pays is known once it's read: then the exchange-memo facts for them, and the
      // rules again with those (the signed bytes, and so the digest, are the same).
      const paid = recipientsOf(network, d.result.display);
      if (paid.length > 0) {
        const facts = await h.sender.riskFacts(network, paid);
        d = await h.vault<Decoded>("decode", { request: built.request, context: { ...context, memo_addresses: facts.memo_addresses, memo_unchecked: facts.memo_unchecked } });
        if (!d.ok) return d;
      }
      const { digest, display, risk } = d.result;
      // What a Ledger can't sign is said before the user reads the whole request.
      const kind = (display as { kind?: unknown }).kind;
      if (u.account.account.derivation === "ledger" && (kind === "cosmos_direct" || kind === "evm_typed_data" || kind === "solana_message")) {
        return fail(
          "device_unsupported",
          kind === "cosmos_direct"
            ? "This account is on a Ledger, which signs amino JSON only. The site must ask for an amino signature."
            : kind === "solana_message"
              ? "A Ledger account can't sign Solana messages in Choice Wallet."
              : "A Ledger account can't sign typed data in Choice Wallet yet.",
        );
      }
      w.prepared = { request: built.request, digest, confirm: risk.confirm ?? null, blocked: risk.level === "blocked" };
      const tokens = built.tokens ?? (await h.sender.tokensFor(network, reviewDenoms(network, display, built.simulation?.ok ? built.simulation.changes : [])));
      return { ok: true, result: { digest, display, risk, tokens, checkedBy: built.checkedBy ?? "", ...(built.simulation ? { simulation: built.simulation } : {}) } };
    } catch (e) {
      if (e instanceof RangeError) return fail("bad_request", e.message);
      return h.sender.chainFailure(e);
    }
  }

  async function reviewContext(network: NetworkId, account: AccountInfo, origin: string, known: boolean) {
    const net = NETWORKS[network];
    const balances: Record<string, string> = {};
    try {
      const me = account.addresses[net.cosmos]!;
      for (const c of await (await h.sender.lcd(network)).balances(me)) balances[c.denom] = c.amount;
      if (balances["inj"]) balances["native"] = balances["inj"];
    } catch (e) {
      if (!(e instanceof Unreachable || e instanceof ChainError)) throw e;
    }
    // The pinned CW20 adapter is the wallet's conversion; any other redeem-shaped contract is new.
    return { origin, origin_known: known, balances, known_contracts: [net.cw20Adapter], symbols: { native: "INJ", inj: "INJ" }, ...(await h.sender.riskFacts(network, null)) };
  }

  /** One answer at a time per request: claimed at once, before anything is awaited. */
  async function claimed<T>(id: unknown, run: (w: Waiting) => Promise<Result<T>>): Promise<Result<T>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    if (w.busy) return fail("busy", "This request is already being answered.");
    w.busy = true;
    try {
      return await run(w);
    } finally {
      w.busy = false;
    }
  }

  function answer(id: unknown, approve: unknown, digest: unknown, confirm: unknown): Promise<Result<{ done: true; hash?: string } | { device: DeviceRequest }>> {
    return claimed(id, (w) => answerOnce(w, approve, digest, confirm));
  }

  async function answerOnce(w: Waiting, approve: unknown, digest: unknown, confirm: unknown): Promise<Result<{ done: true; hash?: string } | { device: DeviceRequest }>> {
    if (approve !== true) {
      settle(w.req.id, no(USER_REJECTED, "The user rejected the request."));
      return { ok: true, result: { done: true } };
    }
    const u = await h.unlocked();
    if (!u) return fail("locked", "Unlock the wallet first.");
    await h.touch();
    if (w.approve) {
      const checked = w.check ? await w.check() : null;
      if (checked && !checked.ok) return checked;
      const reply = await w.approve();
      settle(w.req.id, reply);
      return { ok: true, result: { done: true } };
    }
    const p = w.prepared;
    if (!p || p.digest !== digest) return fail("not_approved", "This request changed. Review it again.");
    if (p.blocked) return fail("blocked", "The wallet won't sign this.");
    if (p.confirm && (typeof confirm === "string" ? confirm.trim() : "") !== p.confirm) return fail("confirm", `Type ${p.confirm} to continue.`);
    if (u.account.account.derivation === "ledger") {
      // The device signs: it gets the vault's bytes; the request waits for its signature.
      const dev = await h.vault<Omit<DeviceRequest, "path">>("device_request", { request: p.request, digest: p.digest });
      if (!dev.ok) return dev;
      // A Solana request goes to the Solana app, with the key read from there.
      const sol = dev.result.app === "solana" ? u.account.ledger_solana : undefined;
      if (dev.result.app === "solana" && !sol) return fail("device_unsupported", "Add this account's Solana key from your Ledger first.");
      const request: DeviceRequest = { ...dev.result, path: sol?.path ?? u.account.account.path };
      w.device = { request, publicKey: sol?.public_key ?? u.account.public_key };
      return { ok: true, result: { device: request } };
    }
    // Answered once: from here the request is the page's, whatever happens.
    leave(w.req.id);
    const signed = await h.vault<Record<string, unknown>>("sign", { secret: u.secret, wallet: u.wallet, unlock_key: u.key, account: u.account.account, request: p.request, digest: p.digest });
    if (!signed.ok) {
      w.resolve(no(INTERNAL, signed.error.message));
      return signed;
    }
    return complete(w, signed.result);
  }

  /** A Ledger's signature for request `id`: the vault checks it against the account's key
   *  and the exact bytes before the page gets anything. A bad one leaves the request open. */
  function deviceSigned(id: unknown, digest: unknown, signature: unknown, format: unknown): Promise<Result<{ done: true; hash?: string }>> {
    return claimed(id, (w) => deviceSignedOnce(w, digest, signature, format));
  }

  async function deviceSignedOnce(w: Waiting, digest: unknown, signature: unknown, format: unknown): Promise<Result<{ done: true; hash?: string }>> {
    const p = w.prepared;
    if (!p || !w.device || p.digest !== digest) return fail("not_approved", "This request changed. Review it again.");
    if (typeof signature !== "string" || (format !== "der" && format !== "rs")) return fail("bad_request", "Not a signature.");
    const signed = await h.vault<Record<string, unknown>>("device_sign", { request: p.request, digest: p.digest, public_key: w.device.publicKey, signature, format });
    if (!signed.ok) return signed;
    leave(w.req.id);
    return complete(w, signed.result);
  }

  /** Hand a signed request's result to the page (broadcasting first, for a transaction). */
  async function complete(w: Waiting, signed: Record<string, unknown>): Promise<Result<{ done: true; hash?: string }>> {
    try {
      const result = await w.finish!(signed);
      const origin = w.req.origin;
      await changeGrants((all) => {
        const g = Object.hasOwn(all, origin) ? all[origin] : undefined;
        if (g) all[origin] = { ...g, approvals: (g.approvals ?? 0) + 1 };
        return g !== undefined;
      });
      w.resolve({ result });
      return { ok: true, result: { done: true, ...(typeof result === "string" && result.startsWith("0x") && result.length === 66 ? { hash: result } : {}) } };
    } catch (e) {
      const r = e instanceof ChainError || e instanceof Unreachable ? h.sender.chainFailure(e) : fail("internal", String(e));
      w.resolve(no(INTERNAL, r.ok ? "failed" : r.error.message));
      return r;
    }
  }

  async function connections(): Promise<Result<Connection[]>> {
    const all = await grants();
    return { ok: true, result: Object.entries(all).map(([origin, g]) => ({ origin, since: g.since })).sort((a, b) => b.since - a.since) };
  }

  async function disconnect(origin: unknown): Promise<Result<Connection[]>> {
    if (typeof origin !== "string") return fail("bad_request", "Which site?");
    // A site without a grant changes nothing, and nobody is told.
    const changed = await changeGrants((all) => {
      if (!Object.hasOwn(all, origin)) return false;
      delete all[origin];
      return true;
    });
    if (changed) {
      // Its chain picks go with the grant they belong to.
      await forgetSiteChains(origin);
      // Its requests still waiting end with it.
      for (const w of [...waiting.values()]) if (w.req.origin === origin) settle(w.req.id, no(USER_REJECTED, "The site was disconnected."), false);
      // Its grant is gone: told by name, so it drops the account it shows.
      h.notify(origin);
    }
    return connections();
  }

  /** The window for a request closed: an unanswered request is rejected. */
  function windowClosed(windowId: number) {
    const ended = [...waiting.values()].filter((w) => w.windowId === windowId);
    for (const w of ended) settle(w.req.id, no(USER_REJECTED, "The user closed the request."));
    if (ended.length === 0) {
      closedEarly.push(windowId);
      if (closedEarly.length > 20) closedEarly.shift();
    }
  }

  /** The wallet locked or was reset: every request still waiting is rejected, so none is
   *  answered later by an account the user didn't review it for. */
  function rejectAll(message: string) {
    for (const w of [...waiting.values()]) settle(w.req.id, no(USER_REJECTED, message), false);
  }

  return { handle, request, review, answer, deviceSigned, connections, disconnect, windowClosed, rejectAll };
}

/** The tokens an approval screen names: what a Cosmos tx moves, what simulation says moves,
 *  the fee, and an EVM transfer's token. */
function reviewDenoms(network: NetworkId, display: DappReview["display"], changes: readonly Coin[]): string[] {
  const out = new Set<string>(changes.map((c) => c.denom));
  out.add(NETWORKS[network].feeDenom);
  const d = display as Record<string, unknown>;
  if (d["kind"] === "cosmos_direct" || d["kind"] === "cosmos_amino") for (const dn of displayDenoms(network, display as CosmosDisplay)) out.add(dn);
  if (d["kind"] === "evm_transaction" && isObject(d["call"]) && d["call"]["type"] === "erc20_transfer" && typeof d["to"] === "string") out.add(`evm:${d["to"].toLowerCase()}`);
  // A Choice swap's two tokens, and the token an approval is for, as the review keys them.
  if (d["kind"] === "evm_transaction" && isObject(d["call"])) {
    const c = d["call"];
    const key = (a: unknown) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a) ? `evm:${a.toLowerCase()}` : null);
    const keys = c["type"] === "swap" ? [key(c["token_in"]), key(c["token_out"])] : c["type"] === "approve" ? [key(d["to"])] : c["type"] === "permit2_approve" ? [key(c["token"])] : [];
    for (const k of keys) if (k) out.add(k);
  }
  const injTx = d["injective_tx"];
  if (isObject(injTx) && Array.isArray(injTx["messages"])) {
    const fee = isObject(injTx["fee"]) && Array.isArray(injTx["fee"]["amount"]) ? (injTx["fee"]["amount"] as Coin[]) : [];
    for (const dn of displayDenoms(network, { kind: "", chain: "", signer: "", memo: "", fee: { amount: fee, gas_limit: "0", granter: null, payer: null }, messages: injTx["messages"] as CosmosDisplay["messages"] })) out.add(dn);
  }
  return [...out];
}
