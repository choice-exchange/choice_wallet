// The service worker's logic, without `chrome.*`, so it runs under test. It is the
// extension's host: it answers the UI's requests (`@choice-wallet/ui/protocol`).
//
// - The encrypted keystore, the public account list (names, addresses, which one is in
//   use) and the settings live in local storage. Accounts come from the keystore's
//   recovery phrase by index, or are addresses to watch, with no key at all.
// - While unlocked, the unlock key (Argon2id output, opens only this keystore) lives in
//   session storage, which Chrome keeps in memory and clears on browser restart or
//   extension update. Locking deletes it, and any send waiting for approval.
// - The vault is stateless: every call that needs a key gets the keystore and unlock key
//   from here. UI pages never see either.

import { cleanText, cw20Address, evmAddress, isNetworkId, NETWORKS, Pool, type Fetch, type NetworkId } from "@choice-wallet/chain";
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

/** Minutes without activity before the wallet locks itself, unless the user picks another
 *  of `LOCK_CHOICES` in Settings. */
export const AUTO_LOCK_MINUTES = 15;
const LOCK_CHOICES = [5, 15, 60, 240];
/** Local storage that belongs to the wallet, not the device: removing the wallet clears it.
 *  Endpoints, the network and other settings stay. */
const WALLET_KEYS = ["keystore", "kind", "accounts", "active_account", "connections", "custom_tokens", "token_filter"];
/** The shortest password, as the keystore takes it. */
const MIN_PASSWORD = 8;

const err = (code: string, message: string): UiResponse<never> => ({ ok: false, error: { code, message } });

/** User-set LCD endpoints per network; absent means the defaults. */
type Endpoints = Partial<Record<NetworkId, string[]>>;

/** A bank denom, as the Cosmos SDK allows them. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;
/** Each of the filter's lists keeps at most this many denoms. */
const MAX_CHOICES = 500;
/** Tokens added by hand, per network. */
const MAX_CUSTOM = 100;
/** Accounts in the list, derived and watched together. */
const MAX_ACCOUNTS = 50;
/** Characters in an account's name. */
const MAX_NAME = 24;

const isWatch = (a: AccountInfo) => a.account.derivation === "watch";

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
  async function keystore(): Promise<{ keystore?: string; kind?: Status["kind"]; accounts?: AccountInfo[]; active: number }> {
    const got = (await d.local.get(["keystore", "kind", "accounts", "active_account"])) as {
      keystore?: string;
      kind?: Status["kind"];
      accounts?: AccountInfo[];
      active_account?: unknown;
    };
    // Lists from before accounts had names read as "Account 1", "Account 2", ….
    const accounts = got.accounts?.map((a, i) => ({ ...a, name: typeof a.name === "string" && a.name ? a.name : `Account ${i + 1}` }));
    const n = accounts?.length ?? 0;
    const i = got.active_account;
    const active = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < n ? i : 0;
    return { ...(got.keystore ? { keystore: got.keystore } : {}), ...(got.kind ? { kind: got.kind } : {}), ...(accounts ? { accounts } : {}), active };
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

  /** Blockscout instances for EVM history; an empty list is off. */
  async function evmIndexEndpoints(net: NetworkId): Promise<string[]> {
    const { evm_index } = (await d.local.get(["evm_index"])) as { evm_index?: Endpoints };
    return evm_index?.[net] ?? [...NETWORKS[net].evmIndex];
  }

  /** Minutes to stay unlocked without activity. */
  async function lockAfter(): Promise<number> {
    const { auto_lock } = await d.local.get(["auto_lock"]);
    return typeof auto_lock === "number" && LOCK_CHOICES.includes(auto_lock) ? auto_lock : AUTO_LOCK_MINUTES;
  }
  /** Activity: start the auto-lock timer again. */
  async function touch(): Promise<void> {
    d.scheduleLock(await lockAfter());
  }

  async function showPrices(): Promise<boolean> {
    const { prices } = await d.local.get(["prices"]);
    return prices !== false;
  }

  const sender = createSender({ vault: d.vault, fetch: d.fetch, local: d.local, session: d.session, endpoints, evmEndpoints, evmIndexEndpoints, prices: showPrices });

  const dapps = createDapps({
    vault: d.vault,
    local: d.local,
    sender,
    network,
    setNetwork: (n) => d.local.set({ network: n }),
    async unlocked() {
      // Sites see the account in use, and none while it is watch-only: it can't sign.
      const ks = await keystore();
      const key = await unlockKey();
      const account = ks.accounts?.[ks.active];
      if (!ks.keystore || key === undefined || !account || isWatch(account)) return null;
      await touch();
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
      active: unlocked ? ks.active : 0,
    };
  }

  /** Remember the unlock key, and start the auto-lock timer. The account list stays as the
   *  user left it, unless it doesn't start with this keystore's own first account (a new
   *  wallet, or a list from another keystore): then it starts over with that one. */
  async function opened(keystoreHex: string, kind: NonNullable<Status["kind"]>, key: string): Promise<UiResponse<Status>> {
    const account = kind === "mnemonic" ? { derivation: "default", index: 0 } : { derivation: "imported" };
    const r = await d.vault<{ accounts: Omit<AccountInfo, "name">[] }>("accounts", {
      keystore: keystoreHex,
      unlock_key: key,
      accounts: [account],
    });
    if (!r.ok) return r;
    const first = r.result.accounts[0]!;
    const stored = (await keystore()).accounts;
    await d.session.set({ unlock_key: key });
    if (stored?.[0]?.public_key !== first.public_key) await d.local.set({ accounts: [{ ...first, name: "Account 1" }], active_account: 0 });
    await touch();
    d.notify();
    return { ok: true, result: await status() };
  }

  /** The list after a change, saved; sites hear about it. */
  async function saveAccounts(accounts: AccountInfo[], active: number): Promise<UiResponse<Status>> {
    await d.local.set({ accounts, active_account: active });
    d.notify();
    return { ok: true, result: await status() };
  }

  /** The next account from the recovery phrase, in use from now. */
  async function addAccount(): Promise<UiResponse<Status>> {
    const ks = await keystore();
    const key = await unlockKey();
    if (!ks.keystore || key === undefined || !ks.accounts) return err("locked", "Unlock the wallet first.");
    if (ks.kind !== "mnemonic") return err("no_phrase", "This wallet is one imported key. It has no other accounts.");
    if (ks.accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
    const used = ks.accounts.flatMap((a) => (a.account.derivation === "default" ? [a.account.index] : []));
    const index = Math.max(-1, ...used) + 1;
    const r = await d.vault<{ accounts: Omit<AccountInfo, "name">[] }>("accounts", {
      keystore: ks.keystore,
      unlock_key: key,
      accounts: [{ derivation: "default", index }],
    });
    if (!r.ok) return r;
    await touch();
    return saveAccounts([...ks.accounts, { ...r.result.accounts[0]!, name: `Account ${index + 1}` }], ks.accounts.length);
  }

  /** An address to follow: balances and activity, never a signature. */
  async function addWatch(address: unknown): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore || (await unlockKey()) === undefined || !ks.accounts) return err("locked", "Unlock the wallet first.");
    if (typeof address !== "string" || address.length > 100) return err("invalid_address", "Enter an inj1… or 0x… address.");
    if (ks.accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
    const r = await d.vault<{ addresses: Record<string, string> }>("addresses", { address });
    if (!r.ok) return err("invalid_address", "That isn't an Injective account address.");
    const cosmos = r.result.addresses[NETWORKS.mainnet.cosmos];
    const already = ks.accounts.findIndex((a) => a.addresses[NETWORKS.mainnet.cosmos] === cosmos);
    if (already >= 0) return err("exists", `That's already in your list, as ${ks.accounts[already]!.name}.`);
    const n = ks.accounts.filter(isWatch).length + 1;
    await touch();
    return saveAccounts([...ks.accounts, { account: { derivation: "watch" }, public_key: "", addresses: r.result.addresses, name: `Watching ${n}` }], ks.accounts.length);
  }

  async function changeAccounts(op: { type: "switch" | "rename" | "remove"; index: unknown; name?: unknown }): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore || (await unlockKey()) === undefined || !ks.accounts) return err("locked", "Unlock the wallet first.");
    const i = op.index;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= ks.accounts.length) return err("bad_request", "No such account.");
    await touch();
    if (op.type === "switch") return saveAccounts(ks.accounts, i);
    if (op.type === "rename") {
      const name = typeof op.name === "string" ? cleanText(op.name.replace(/\s+/g, " "), MAX_NAME) : "";
      if (!name) return err("bad_request", "Give the account a name.");
      return saveAccounts(ks.accounts.map((a, j) => (j === i ? { ...a, name } : a)), ks.active);
    }
    if (i === 0) return err("bad_request", "The first account is the keystore's own. It stays.");
    const active = ks.active === i ? 0 : ks.active > i ? ks.active - 1 : ks.active;
    return saveAccounts(ks.accounts.filter((_, j) => j !== i), active);
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

  /** What the user asked to see, after their password: the recovery phrase (or the wallet's
   *  one imported key), or account `index`'s private key. Nothing is kept. */
  async function revealSecret(password: unknown, index: unknown): Promise<UiResponse<{ phrase?: string; private_key?: string }>> {
    const ks = await keystore();
    if (!ks.keystore || (await unlockKey()) === undefined || !ks.accounts) return err("locked", "Unlock the wallet first.");
    if (typeof password !== "string" || !password) return err("bad_request", "Enter your password.");
    let account: AccountInfo["account"] | undefined;
    if (index !== undefined) {
      const a = typeof index === "number" ? ks.accounts[index] : undefined;
      if (!a) return err("bad_request", "No such account.");
      if (isWatch(a)) return err("watch_only", "A watch-only account has no key.");
      account = a.account;
    }
    await touch();
    const r = await d.vault<{ phrase?: string; private_key?: string }>("reveal", { keystore: ks.keystore, password, ...(account ? { account } : {}) });
    if (!r.ok && r.error.code === "wrong_password") return err("wrong_password", "Wrong password.");
    return r;
  }

  /** The keystore sealed under a new password; the wallet stays unlocked with its new key. */
  async function changePassword(password: unknown, next: unknown): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore || (await unlockKey()) === undefined) return err("locked", "Unlock the wallet first.");
    if (typeof password !== "string" || typeof next !== "string") return err("bad_request", "Enter both passwords.");
    if ([...next].length < MIN_PASSWORD) return err("weak_password", `Use at least ${MIN_PASSWORD} characters.`);
    if (next === password) return err("same_password", "That's the password it has now.");
    const r = await d.vault<{ keystore: string; unlock_key: string }>("change_password", { keystore: ks.keystore, password, new_password: next });
    if (!r.ok) return r.error.code === "wrong_password" ? err("wrong_password", "Wrong password.") : r;
    await d.local.set({ keystore: r.result.keystore });
    await d.session.set({ unlock_key: r.result.unlock_key });
    await touch();
    return { ok: true, result: await status() };
  }

  /** Take the wallet off this device, after its password. Only the recovery phrase (or the
   *  key) brings it back. Settings such as endpoints stay. */
  async function removeWallet(password: unknown): Promise<UiResponse<Status>> {
    const ks = await keystore();
    if (!ks.keystore) return err("no_wallet", "There is no wallet on this device.");
    if (typeof password !== "string" || !password) return err("bad_request", "Enter your password.");
    const r = await d.vault("unlock", { keystore: ks.keystore, password });
    if (!r.ok) return r.error.code === "wrong_password" ? err("wrong_password", "Wrong password.") : r;
    await d.session.remove(["unlock_key", "pending_send"]);
    await d.local.remove(WALLET_KEYS);
    d.cancelLock();
    d.notify();
    return { ok: true, result: await status() };
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
        evmIndex: { mainnet: await evmIndexEndpoints("mainnet"), testnet: await evmIndexEndpoints("testnet") },
        evmIndexDefault: { mainnet: [...NETWORKS.mainnet.evmIndex], testnet: [...NETWORKS.testnet.evmIndex] },
        prices: await showPrices(),
        autoLock: await lockAfter(),
      },
    };
  }

  /** A network's endpoint list after a change: `null` is the defaults; `undefined` leaves it.
   *  An empty list is allowed only where it means "off" (`canBeEmpty`). */
  function nextEndpoints(all: Endpoints, net: NetworkId, urls: unknown, canBeEmpty = false): Endpoints | UiResponse<never> {
    if (urls === undefined) return all;
    const next = { ...all };
    if (urls === null) {
      delete next[net];
      return next;
    }
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) return err("bad_request", "Endpoints must be a list.");
    if (canBeEmpty && urls.every((u) => !(u as string).trim())) {
      next[net] = [];
      return next;
    }
    try {
      next[net] = [...new Pool(urls as string[], { fetch: d.fetch, identify: async () => {} }).urls];
    } catch (e) {
      return err("invalid_endpoint", e instanceof Error ? `${e.message[0]?.toUpperCase()}${e.message.slice(1)}.` : "Invalid endpoint.");
    }
    return next;
  }

  async function saveSettings(net: unknown, lcd: unknown, evm: unknown, evmIndex: unknown, prices: unknown, autoLock: unknown): Promise<UiResponse<Settings>> {
    if (!isNetworkId(net)) return err("bad_request", "Unknown network.");
    if (prices !== undefined && typeof prices !== "boolean") return err("bad_request", "prices must be true or false.");
    if (autoLock !== undefined && !(typeof autoLock === "number" && LOCK_CHOICES.includes(autoLock))) return err("bad_request", `autoLock must be one of ${LOCK_CHOICES.join(", ")}.`);
    const stored = (await d.local.get(["endpoints", "evm_endpoints", "evm_index"])) as { endpoints?: Endpoints; evm_endpoints?: Endpoints; evm_index?: Endpoints };
    const lcdAll = nextEndpoints(stored.endpoints ?? {}, net, lcd);
    if ("ok" in lcdAll) return lcdAll as UiResponse<never>;
    const evmAll = nextEndpoints(stored.evm_endpoints ?? {}, net, evm);
    if ("ok" in evmAll) return evmAll as UiResponse<never>;
    const indexAll = nextEndpoints(stored.evm_index ?? {}, net, evmIndex, true);
    if ("ok" in indexAll) return indexAll as UiResponse<never>;
    const before = await network();
    await d.local.set({
      network: net,
      endpoints: lcdAll,
      evm_endpoints: evmAll,
      evm_index: indexAll,
      ...(prices === undefined ? {} : { prices }),
      ...(autoLock === undefined ? {} : { auto_lock: autoLock }),
    });
    if (autoLock !== undefined && (await unlockKey()) !== undefined) await touch();
    if (net !== before) d.notify();
    return settings();
  }

  /** The account in use and the network, for requests that need an unlocked wallet. */
  async function active(): Promise<{ account: AccountInfo; net: NetworkId; keystore: string; key: string } | UiResponse<never>> {
    const ks = await keystore();
    const key = await unlockKey();
    const account = ks.accounts?.[ks.active];
    if (!ks.keystore || key === undefined || !account) return err("locked", "Unlock the wallet first.");
    await touch();
    return { account, net: await network(), keystore: ks.keystore, key };
  }

  /** Handle one request from an extension page. */
  async function handle(req: unknown): Promise<UiResponse> {
    const r = req as UiRequest;
    switch (r?.type) {
      case "status": {
        const s = await status();
        if (s.unlocked) await touch();
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
      case "add_account":
        return addAccount();
      case "add_watch":
        return addWatch(r.address);
      case "switch_account":
        return changeAccounts({ type: "switch", index: r.index });
      case "rename_account":
        return changeAccounts({ type: "rename", index: r.index, name: r.name });
      case "remove_account":
        return changeAccounts({ type: "remove", index: r.index });
      case "reveal_secret":
        return revealSecret(r.password, r.index);
      case "change_password":
        return changePassword(r.password, r.new_password);
      case "remove_wallet":
        return removeWallet(r.password);
      case "settings":
        return settings();
      case "save_settings":
        return saveSettings(r.network, r.lcd, r.evm, r.evmIndex, r.prices, r.autoLock);
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
        if ((r.type === "prepare_send" || r.type === "prepare_convert") && isWatch(a.account)) {
          return err("watch_only", "This account is watch-only. Switch to one that can sign.");
        }
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
