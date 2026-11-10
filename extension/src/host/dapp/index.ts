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
import { fail, randomId } from "../util";
import { createCosmosSite } from "./cosmos";
import { createEvmSite } from "./evm";
import { INTERNAL, INVALID_PARAMS, no, PENDING, UNAUTHORIZED, UNSUPPORTED, USER_REJECTED, type DappHost, type DappReply, type Grants, type Waiting } from "./shared";
import { createSolanaSite } from "./solana";

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
      waiting.set(id, entry);
      h.openWindow(id).then(
        (windowId) => {
          if (windowId !== undefined) entry.windowId = windowId;
        },
        () => settle(id, no(INTERNAL, "The wallet couldn't open its approval window.")),
      );
    });
  }

  function settle(id: string, reply: DappReply) {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    w.resolve(reply);
  }

  async function connect(origin: string, then: () => Promise<DappReply>): Promise<DappReply> {
    if ((await isConnected(origin)) && (await h.unlocked())) return then();
    return ask(
      {
        approve: async () => {
          const all = await grants();
          await h.local.set({ connections: { ...all, [origin]: all[origin] ?? { since: Date.now() } } });
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
  ): Promise<DappReply> {
    if (!(await isConnected(origin))) return no(UNAUTHORIZED, "Connect to Choice Wallet first.");
    return ask({ build, finish }, { origin, network: await h.network(), kind: "sign", method });
  }

  const core = { h, isConnected, connect, ask, sign, disconnect };
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
    const network = w.req.network;
    if (network !== (await h.network())) return fail("network", "The wallet changed network. Ask the site again.");
    try {
      const built = await w.build(u.account);
      const all = await grants();
      const known = (all[w.req.origin]?.approvals ?? 0) > 0;
      const context = built.context
        ? { origin: w.req.origin, origin_known: known, ...(await h.sender.riskFacts(network, null)), ...built.context }
        : await reviewContext(network, u.account, w.req.origin, known);
      const d = await h.vault<{ digest: string; display: DappReview["display"]; risk: Risk }>("decode", { request: built.request, context });
      if (!d.ok) return d;
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
    return { origin, origin_known: known, balances, ...(await h.sender.riskFacts(network, null)) };
  }

  async function answer(id: unknown, approve: unknown, digest: unknown, confirm: unknown): Promise<Result<{ done: true; hash?: string } | { device: DeviceRequest }>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    if (approve !== true) {
      settle(w.req.id, no(USER_REJECTED, "The user rejected the request."));
      return { ok: true, result: { done: true } };
    }
    const u = await h.unlocked();
    if (!u) return fail("locked", "Unlock the wallet first.");
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
    waiting.delete(w.req.id);
    const signed = await h.vault<Record<string, unknown>>("sign", { secret: u.secret, wallet: u.wallet, unlock_key: u.key, account: u.account.account, request: p.request, digest: p.digest });
    if (!signed.ok) {
      w.resolve(no(INTERNAL, signed.error.message));
      return signed;
    }
    return complete(w, signed.result);
  }

  /** A Ledger's signature for request `id`: the vault checks it against the account's key
   *  and the exact bytes before the page gets anything. A bad one leaves the request open. */
  async function deviceSigned(id: unknown, digest: unknown, signature: unknown, format: unknown): Promise<Result<{ done: true; hash?: string }>> {
    const w = typeof id === "string" ? waiting.get(id) : undefined;
    if (!w) return fail("not_found", "This request is no longer open.");
    const p = w.prepared;
    if (!p || !w.device || p.digest !== digest) return fail("not_approved", "This request changed. Review it again.");
    if (typeof signature !== "string" || (format !== "der" && format !== "rs")) return fail("bad_request", "Not a signature.");
    const signed = await h.vault<Record<string, unknown>>("device_sign", { request: p.request, digest: p.digest, public_key: w.device.publicKey, signature, format });
    if (!signed.ok) return signed;
    waiting.delete(w.req.id);
    return complete(w, signed.result);
  }

  /** Hand a signed request's result to the page (broadcasting first, for a transaction). */
  async function complete(w: Waiting, signed: Record<string, unknown>): Promise<Result<{ done: true; hash?: string }>> {
    try {
      const result = await w.finish!(signed);
      const all = await grants();
      const g = all[w.req.origin];
      if (g) await h.local.set({ connections: { ...all, [w.req.origin]: { ...g, approvals: (g.approvals ?? 0) + 1 } } });
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
    const all = await grants();
    delete all[origin];
    await h.local.set({ connections: all });
    h.notify();
    return connections();
  }

  /** The window for a request closed: an unanswered request is rejected. */
  function windowClosed(windowId: number) {
    for (const w of [...waiting.values()]) if (w.windowId === windowId) settle(w.req.id, no(USER_REJECTED, "The user closed the request."));
  }

  return { handle, request, review, answer, deviceSigned, connections, disconnect, windowClosed };
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
