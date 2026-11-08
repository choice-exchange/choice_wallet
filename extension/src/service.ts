// The service worker's logic, without `chrome.*`, so it runs under test. It is the
// extension's host: it answers the UI's requests (`@choice-wallet/ui/protocol`).
//
// - The encrypted keystore, the public account list and the settings live in local storage.
// - While unlocked, the unlock key (Argon2id output, opens only this keystore) lives in
//   session storage, which Chrome keeps in memory and clears on browser restart or
//   extension update. Locking deletes it, and any send waiting for approval.
// - The vault is stateless: every call that needs a key gets the keystore and unlock key
//   from here. UI pages never see either.

import { cw20Address, evmAddress, isNetworkId, NETWORKS, Pool, type Fetch, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, NewSecret, Result, Settings, Status, TokenFilter, UiRequest } from "@choice-wallet/ui/protocol";
import { DEFAULT_FILTER } from "@choice-wallet/ui/token-filter";

import { createDapps, type DappReply } from "./dapp";
import { createSender } from "./send";

type UiResponse<T = unknown> = Result<T>;

/** A key-value store: `chrome.storage.local` / `.session`, or a map in tests. */
export interface Store {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface Deps {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  session: Store;
  fetch: Fetch;
  /** (Re)start the auto-lock timer. */
  scheduleLock(minutes: number): void;
  cancelLock(): void;
  /** Open the approval window for a site's request; its window ID. */
  openWindow(requestId: string): Promise<number | undefined>;
  /** Tell open pages that what they see (accounts, chain) may have changed. */
  notify(): void;
}

/** Minutes without activity before the wallet locks itself. */
export const AUTO_LOCK_MINUTES = 15;

const err = (code: string, message: string): UiResponse<never> => ({ ok: false, error: { code, message } });

/** User-set LCD endpoints per network; absent means the defaults. */
type Endpoints = Partial<Record<NetworkId, string[]>>;

/** A bank denom, as the Cosmos SDK allows them. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
/** Each of the filter's lists keeps at most this many denoms. */
const MAX_CHOICES = 500;
/** Tokens added by hand, per network. */
const MAX_CUSTOM = 100;

/** A filter from the UI or from storage, checked: null if it isn't one. */
function tokenFilterFrom(v: unknown): TokenFilter | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  const list = (x: unknown) =>
    Array.isArray(x) && x.length <= MAX_CHOICES && x.every((d) => typeof d === "string" && DENOM.test(d)) ? [...new Set(x as string[])] : null;
  const shown = list(f["shown"]);
  const hidden = list(f["hidden"]);
  if (typeof f["all"] !== "boolean" || typeof f["hideSmall"] !== "boolean" || !shown || !hidden) return null;
  if (shown.some((d) => hidden.includes(d))) return null;
  return { all: f["all"], hideSmall: f["hideSmall"], shown, hidden };
}

export function createService(d: Deps) {
  async function keystore(): Promise<{ keystore?: string; kind?: Status["kind"]; accounts?: AccountInfo[] }> {
    return (await d.local.get(["keystore", "kind", "accounts"])) as never;
  }

  async function unlockKey(): Promise<string | undefined> {
    const { unlock_key } = await d.session.get(["unlock_key"]);
    return typeof unlock_key === "string" ? unlock_key : undefined;
  }

  async function network(): Promise<NetworkId> {
    const { network } = await d.local.get(["network"]);
    return isNetworkId(network) ? network : "mainnet";
  }

  async function endpoints(net: NetworkId): Promise<string[]> {
    const { endpoints } = (await d.local.get(["endpoints"])) as { endpoints?: Endpoints };
    return endpoints?.[net] ?? [...NETWORKS[net].lcd];
  }

  async function evmEndpoints(net: NetworkId): Promise<string[]> {
    const { evm_endpoints } = (await d.local.get(["evm_endpoints"])) as { evm_endpoints?: Endpoints };
    return evm_endpoints?.[net] ?? [...NETWORKS[net].evmRpc];
  }

  async function showPrices(): Promise<boolean> {
    const { prices } = await d.local.get(["prices"]);
    return prices !== false;
  }

  const sender = createSender({ vault: d.vault, fetch: d.fetch, local: d.local, session: d.session, endpoints, evmEndpoints, prices: showPrices });

  const dapps = createDapps({
    vault: d.vault,
    local: d.local,
    sender,
    network,
    setNetwork: (n) => d.local.set({ network: n }),
    async unlocked() {
      const ks = await keystore();
      const key = await unlockKey();
      const account = ks.accounts?.[0];
      if (!ks.keystore || key === undefined || !account) return null;
      d.scheduleLock(AUTO_LOCK_MINUTES);
      return { account, keystore: ks.keystore, key };
    },
    openWindow: d.openWindow,
    notify: d.notify,
  });

  /** Add a token by contract address: an EVM-only token or a CW20 joins the list (kept per
   *  network, at most `MAX_CUSTOM`), and either way the token is shown even if the filter
   *  would hide it, since the user asked for it. */
  async function addToken(address: unknown): Promise<UiResponse<{ denom: string; symbol: string; filter: TokenFilter }>> {
    const net = await network();
    const found = await sender.inspectToken(net, address);
    if (!found.ok) return found;
    const { denom } = found.result;
    const a = evmAddress(denom) ?? cw20Address(denom);
    if (a) {
      const { custom_tokens } = (await d.local.get(["custom_tokens"])) as { custom_tokens?: Partial<Record<NetworkId, string[]>> };
      const list = Array.isArray(custom_tokens?.[net]) ? custom_tokens[net] : [];
      if (!list.includes(a)) {
        if (list.length >= MAX_CUSTOM) return err("too_many", `At most ${MAX_CUSTOM} added tokens.`);
        await d.local.set({ custom_tokens: { ...(custom_tokens ?? {}), [net]: [...list, a] } });
      }
    }
    const f = await tokenFilter(net);
    const next = { ...f, hidden: f.hidden.filter((x) => x !== denom), shown: f.shown.includes(denom) ? f.shown : [...f.shown, denom] };
    const saved = await saveTokenFilter(next);
    if (!saved.ok) return saved;
    return { ok: true, result: { ...found.result, filter: saved.result } };
  }

  async function tokenFilter(net: NetworkId): Promise<TokenFilter> {
    const { token_filter } = (await d.local.get(["token_filter"])) as { token_filter?: Partial<Record<NetworkId, unknown>> };
    return tokenFilterFrom(token_filter?.[net]) ?? DEFAULT_FILTER;
  }

  async function saveTokenFilter(filter: unknown): Promise<UiResponse<TokenFilter>> {
    const f = tokenFilterFrom(filter);
    if (!f) return err("bad_request", "Not a token filter.");
    const net = await network();
    const { token_filter } = (await d.local.get(["token_filter"])) as { token_filter?: Partial<Record<NetworkId, unknown>> };
    await d.local.set({ token_filter: { ...(token_filter ?? {}), [net]: f } });
    return { ok: true, result: f };
  }

  async function status(): Promise<Status> {
    const ks = await keystore();
    const unlocked = Boolean(ks.keystore) && (await unlockKey()) !== undefined;
    return {
      hasWallet: Boolean(ks.keystore),
      unlocked,
      kind: ks.kind ?? null,
      network: await network(),
      accounts: unlocked ? (ks.accounts ?? []) : [],
    };
  }

  /** Remember the unlock key and the account list, and start the auto-lock timer. */
  async function opened(keystoreHex: string, kind: NonNullable<Status["kind"]>, key: string): Promise<UiResponse<Status>> {
    const account = kind === "mnemonic" ? { derivation: "default", index: 0 } : { derivation: "imported" };
    const r = await d.vault<{ accounts: AccountInfo[] }>("accounts", {
      keystore: keystoreHex,
      unlock_key: key,
      accounts: [account],
    });
    if (!r.ok) return r;
    await d.session.set({ unlock_key: key });
    await d.local.set({ accounts: r.result.accounts });
    d.scheduleLock(AUTO_LOCK_MINUTES);
    d.notify();
    return { ok: true, result: await status() };
  }

  async function create(secret: NewSecret, password: string): Promise<UiResponse<Status>> {
    if ((await keystore()).keystore) return err("exists", "A wallet already exists on this device.");
    const made = await d.vault<{ keystore: string; kind: "mnemonic" | "private_key" }>("create_keystore", { secret, password });
    if (!made.ok) return made;
    const unlocked = await d.vault<{ unlock_key: string }>("unlock", { keystore: made.result.keystore, password });
    if (!unlocked.ok) return unlocked;
    await d.local.set({ keystore: made.result.keystore, kind: made.result.kind });
    return opened(made.result.keystore, made.result.kind, unlocked.result.unlock_key);
  }

  async function unlock(password: string): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore || !ks.kind) return err("no_wallet", "There is no wallet on this device yet.");
    const r = await d.vault<{ unlock_key: string }>("unlock", { keystore: ks.keystore, password });
    if (!r.ok) return r;
    return opened(ks.keystore, ks.kind, r.result.unlock_key);
  }

  async function lock(): Promise<UiResponse<Status>> {
    await d.session.remove(["unlock_key", "pending_send"]);
    d.cancelLock();
    d.notify();
    return { ok: true, result: await status() };
  }

  async function settings(): Promise<UiResponse<Settings>> {
    return {
      ok: true,
      result: {
        network: await network(),
        lcd: { mainnet: await endpoints("mainnet"), testnet: await endpoints("testnet") },
        lcdDefault: { mainnet: [...NETWORKS.mainnet.lcd], testnet: [...NETWORKS.testnet.lcd] },
        evm: { mainnet: await evmEndpoints("mainnet"), testnet: await evmEndpoints("testnet") },
        evmDefault: { mainnet: [...NETWORKS.mainnet.evmRpc], testnet: [...NETWORKS.testnet.evmRpc] },
        prices: await showPrices(),
      },
    };
  }

  /** A network's endpoint list after a change: `null` is the defaults; `undefined` leaves it. */
  function nextEndpoints(all: Endpoints, net: NetworkId, urls: unknown): Endpoints | UiResponse<never> {
    if (urls === undefined) return all;
    const next = { ...all };
    if (urls === null) {
      delete next[net];
      return next;
    }
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) return err("bad_request", "Endpoints must be a list.");
    try {
      next[net] = [...new Pool(urls as string[], { fetch: d.fetch, identify: async () => {} }).urls];
    } catch (e) {
      return err("invalid_endpoint", e instanceof Error ? `${e.message[0]?.toUpperCase()}${e.message.slice(1)}.` : "Invalid endpoint.");
    }
    return next;
  }

  async function saveSettings(net: unknown, lcd: unknown, evm: unknown, prices: unknown): Promise<UiResponse<Settings>> {
    if (!isNetworkId(net)) return err("bad_request", "Unknown network.");
    if (prices !== undefined && typeof prices !== "boolean") return err("bad_request", "prices must be true or false.");
    const stored = (await d.local.get(["endpoints", "evm_endpoints"])) as { endpoints?: Endpoints; evm_endpoints?: Endpoints };
    const lcdAll = nextEndpoints(stored.endpoints ?? {}, net, lcd);
    if ("ok" in lcdAll) return lcdAll as UiResponse<never>;
    const evmAll = nextEndpoints(stored.evm_endpoints ?? {}, net, evm);
    if ("ok" in evmAll) return evmAll as UiResponse<never>;
    const before = await network();
    await d.local.set({ network: net, endpoints: lcdAll, evm_endpoints: evmAll, ...(prices === undefined ? {} : { prices }) });
    if (net !== before) d.notify();
    return settings();
  }

  /** The first account and the network, for requests that need an unlocked wallet. */
  async function active(): Promise<{ account: AccountInfo; net: NetworkId; keystore: string; key: string } | UiResponse<never>> {
    const ks = await keystore();
    const key = await unlockKey();
    const account = ks.accounts?.[0];
    if (!ks.keystore || key === undefined || !account) return err("locked", "Unlock the wallet first.");
    d.scheduleLock(AUTO_LOCK_MINUTES);
    return { account, net: await network(), keystore: ks.keystore, key };
  }

  /** Handle one request from an extension page. */
  async function handle(req: unknown): Promise<UiResponse> {
    const r = req as UiRequest;
    switch (r?.type) {
      case "status": {
        const s = await status();
        if (s.unlocked) d.scheduleLock(AUTO_LOCK_MINUTES);
        return { ok: true, result: s };
      }
      case "generate":
        return d.vault("generate_mnemonic", { words: r.words });
      case "create":
        return create(r.secret, r.password);
      case "unlock":
        return unlock(r.password);
      case "lock":
        return lock();
      case "settings":
        return settings();
      case "save_settings":
        return saveSettings(r.network, r.lcd, r.evm, r.prices);
      case "save_token_filter":
        return saveTokenFilter(r.filter);
      case "add_token": {
        const a = await active();
        if ("ok" in a) return a;
        return addToken(r.address);
      }
      case "balances":
      case "activity":
      case "prepare_send":
      case "prepare_convert":
      case "confirm_send":
      case "tx_status": {
        const a = await active();
        if ("ok" in a) return a;
        if (r.type === "balances") {
          const b = await sender.balances(a.net, a.account);
          if (!b.ok) return b;
          return { ok: true, result: { ...b.result, filter: await tokenFilter(a.net), prices: await showPrices() } };
        }
        if (r.type === "activity") {
          const page = await sender.activity(a.net, a.account, r.page);
          if (!page.ok) return page;
          return { ok: true, result: { ...page.result, filter: await tokenFilter(a.net) } };
        }
        if (r.type === "prepare_send") return sender.prepare(a.net, a.account, r);
        if (r.type === "prepare_convert") return sender.prepareConvert(a.net, a.account, r);
        if (r.type === "confirm_send") return sender.confirm(a.keystore, a.key, r);
        return sender.status(a.net, r.hash);
      }
      case "dapp_request":
        return dapps.request(r.id);
      case "dapp_review":
        return dapps.review(r.id);
      case "dapp_answer":
        return dapps.answer(r.id, r.approve, r.digest, r.confirm);
      case "connections":
        return dapps.connections();
      case "disconnect":
        return dapps.disconnect(r.origin);
      default:
        return err("bad_request", "Unknown request.");
    }
  }

  /** A message from a web page, through the content script, at `origin` (from the browser). */
  function dapp(origin: string, message: unknown): Promise<DappReply> {
    return dapps.handle(origin, message);
  }

  return { handle, lock, status, dapp, windowClosed: dapps.windowClosed };
}

/** The origin of a web page talking through this extension's content script, if it may:
 *  the top frame of a tab, https (or plain http on this machine, for development). The
 *  origin is the browser's, never the page's say. */
export function dappOrigin(sender: { id?: string; origin?: string; url?: string; tab?: unknown; frameId?: number }, extensionId: string): string | null {
  if (sender.id !== extensionId || !sender.tab || sender.frameId !== 0 || typeof sender.origin !== "string") return null;
  let u: URL;
  try {
    u = new URL(sender.origin);
  } catch {
    return null;
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if ((u.protocol !== "https:" && !local) || u.origin !== sender.origin) return null;
  if (!(sender.url ?? "").startsWith(`${sender.origin}/`)) return null;
  return sender.origin;
}

/** Whether a message comes from one of this extension's own pages: never a web page or a
 *  content script, whose sender is the page it runs in. */
export function fromOwnPage(sender: { id?: string; origin?: string; url?: string }, extensionId: string): boolean {
  const origin = `chrome-extension://${extensionId}`;
  return sender.id === extensionId && sender.origin === origin && (sender.url ?? "").startsWith(`${origin}/`);
}
