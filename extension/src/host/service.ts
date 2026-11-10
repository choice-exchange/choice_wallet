// The service worker's logic, without `chrome.*`, so it runs under test. It is the
// extension's host: it answers the UI's requests (`@choice-wallet/ui/protocol`).
//
// - The vault, each wallet's sealed secret, the public account list (names, addresses,
//   which one is in use) and the settings live in local storage (see ./wallets.ts).
// - While unlocked, the unlock key (Argon2id output, opens only this keystore) lives in
//   session storage, which Chrome keeps in memory and clears on browser restart or
//   extension update. Locking deletes it, and any send waiting for approval.
// - The vault is stateless: every call that needs a key gets the keystore and unlock key
//   from here. UI pages never see either.

import { chainByCaip2, chainByKey, chainDenom, cw20Address, evmAddress, isNetworkId, isSolanaDenom, NETWORKS, Pool, usdValue, type Fetch, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Balance, NotifyMode, Result, Settings, SnapshotView, Status, TokenFilter, UiRequest } from "@choice-wallet/ui/protocol";
import { DEFAULT_FILTER } from "@choice-wallet/ui/token-filter";

import { createDapps, type DappReply } from "./dapp";
import { createEvmChains, evmChains as evmChainsOf, type ChainEndpoints } from "./evmchains";
import { createSender, sourceOfChain } from "./send";
import { createApprovals } from "./approvals";
import { createInventory } from "./inventory";
import { createNfts } from "./nfts";
import { createRescue } from "./rescue";
import { createContacts } from "./contacts";
import { createStaking } from "./staking";
import { createBridge } from "./bridge";
import { createSolana } from "./solana";
import { createSwaps } from "./swap";
import { createWallets, isWatch } from "./wallets";
import { settled as cachesSettled } from "./cache";
import { createSnapshots } from "./snapshots";
import { createWatcher, DEFAULT_MODE, type Notice } from "./watch";

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
  /** Tell the wallet's own open pages (the popup) to read their data again. */
  refresh?(): void;
  /** A browser notification; false when it wasn't shown (the popup is open). */
  showNotice?(n: Notice): Promise<boolean>;
  /** The count on the toolbar icon; "" clears it. */
  badge?(text: string): void;
  /** Start or stop the background watcher's alarm. */
  scheduleWatch?(on: boolean): void;
}

/** Minutes without activity before the wallet locks itself, unless the user picks another
 *  of `LOCK_CHOICES` in Settings. */
export const AUTO_LOCK_MINUTES = 15;
const LOCK_CHOICES = [5, 15, 60, 240];
/** Local storage that belongs to the wallet, not the device: removing the wallet clears it.
 *  Endpoints, the network and other settings stay. */
const WALLET_KEYS = ["vault", "wallets", "keystore", "kind", "accounts", "active_account", "connections", "custom_tokens", "custom_nfts", "rescue", "token_filter", "address_book", "watch", "watch_own", "bridge_in_pending"];
const NOTIFY_MODES: readonly NotifyMode[] = ["off", "active", "all"];
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

  /** Solana endpoints for a network's cluster. */
  async function solanaEndpoints(net: NetworkId): Promise<string[]> {
    const { solana_endpoints } = (await d.local.get(["solana_endpoints"])) as { solana_endpoints?: Endpoints };
    return solana_endpoints?.[net] ?? [...NETWORKS[net].solana.rpc];
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

  async function notifyMode(): Promise<NotifyMode> {
    const { notify } = await d.local.get(["notify"]);
    return NOTIFY_MODES.includes(notify as NotifyMode) ? (notify as NotifyMode) : DEFAULT_MODE;
  }

  const solana = createSolana({
    vault: d.vault,
    fetch: d.fetch,
    local: d.local,
    session: d.session,
    endpoints: solanaEndpoints,
    riskFacts: (n, recipient) => contacts.facts(n, recipient),
  });
  const evmChains = createEvmChains({ fetch: d.fetch, local: d.local, prices: showPrices });
  const sender = createSender({
    vault: d.vault,
    fetch: d.fetch,
    local: d.local,
    session: d.session,
    endpoints,
    evmEndpoints,
    evmIndexEndpoints,
    prices: showPrices,
    riskFacts: (n, recipient) => contacts.facts(n, recipient),
    onBroadcast: (n, hash, from) => void watcher.track(n, hash, from).catch(() => {}),
    onDeposit: (n, deposit) => bridge.track(n, deposit),
    solanaBroadcast: (n, p, signed) => solana.broadcast(n, p, signed),
    chainRpc: (n, key) => evmChains.rpc(n, key),
  });
  const staking = createStaking(sender);
  const swaps = createSwaps(sender, d.session, d.fetch, async (net) => (await tokenFilter(net)).shown);
  const bridge = createBridge(sender, d.session, d.local, d.fetch, Date.now, solana);
  const approvals = createApprovals(sender);

  const wallets = createWallets({
    vault: d.vault,
    local: d.local,
    session: d.session,
    notify: d.notify,
    touch,
    cancelLock: d.cancelLock,
    network,
    async used(address) {
      const client = await sender.lcd(await network());
      try {
        if ((await client.balances(address)).length > 0) return true;
        return (await client.searchTxs(`message.sender='${address}'`, 1, 1)).txs.length > 0;
      } catch {
        return false;
      }
    },
  });
  const status = wallets.status;
  const nfts = createNfts({ sender, local: d.local, vault: d.vault });
  const inventory = createInventory({ sender });
  const rescue = createRescue({ sender, local: d.local, vault: d.vault, accounts: async () => (await wallets.stored()).accounts });
  const contacts = createContacts({
    vault: d.vault,
    local: d.local,
    lcd: sender.lcd,
    accounts: async () => (await wallets.stored()).accounts,
    rescue: async () => {
      const u = await wallets.inUse();
      return u ? rescue.addressFor(u.account) : null;
    },
  });

  const snapshots = createSnapshots(d.local);
  const watcher = createWatcher({
    local: d.local,
    sender,
    network,
    accounts: async () => {
      const s = await wallets.stored();
      return { accounts: s.accounts, active: s.active };
    },
    mode: notifyMode,
    filter: tokenFilter,
    async names(net) {
      const out = new Map<string, string>();
      for (const c of await contacts.list()) {
        out.set(c.address, c.name);
        if (c.evm) out.set(c.evm.toLowerCase(), c.name);
      }
      for (const a of (await wallets.stored()).accounts) {
        const inj = a.addresses[NETWORKS[net].cosmos];
        const evm = a.addresses[NETWORKS[net].evm];
        if (inj) out.set(inj, a.name);
        if (evm) out.set(evm.toLowerCase(), a.name);
      }
      return out;
    },
    show: async (n) => (d.showNotice ? d.showNotice(n) : false),
    badge: (text) => d.badge?.(text),
    changed: () => d.refresh?.(),
  });

  /** After accounts went away: forget what was kept for them. */
  async function forgetGone(): Promise<void> {
    const left = (await wallets.stored()).accounts.flatMap((a) => Object.values(a.addresses));
    await snapshots.keepOnly(left);
    await watcher.forget(left);
  }

  /** Keep the account's latest answer for the next time the popup opens. Never in the way
   *  of the answer itself. */
  function keep(net: NetworkId, account: AccountInfo, part: "balances" | "staking" | "activity", value: unknown) {
    void snapshots.save(net, account.addresses[NETWORKS[net].cosmos] ?? "", part, value).catch(() => {});
  }

  async function snapshot(net: NetworkId, account: AccountInfo): Promise<SnapshotView | null> {
    const snap = await snapshots.get(net, account.addresses[NETWORKS[net].cosmos] ?? "");
    if (!snap) return null;
    // The lists as the user's settings say now, not as they were then.
    const filter = await tokenFilter(net);
    const out: SnapshotView = {};
    type Value<K extends keyof SnapshotView> = NonNullable<SnapshotView[K]>["value"];
    if (snap.balances) out.balances = { at: snap.balances.at, value: { ...(snap.balances.value as Value<"balances">), filter, prices: await showPrices() } };
    if (snap.staking) out.staking = { at: snap.staking.at, value: snap.staking.value as Value<"staking"> };
    if (snap.activity) out.activity = { at: snap.activity.at, value: { ...(snap.activity.value as Value<"activity">), filter } };
    return out;
  }

  const dapps = createDapps({
    vault: d.vault,
    local: d.local,
    sender,
    solana,
    network,
    setNetwork: (n) => d.local.set({ network: n }),
    async unlocked() {
      // Sites see the account in use, and none while it is watch-only: it can't sign.
      const u = await wallets.inUse();
      if (!u || !u.signer || isWatch(u.account)) return null;
      await touch();
      return { account: u.account, key: u.key, ...u.signer };
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

  async function lock(): Promise<UiResponse<Status>> {
    await d.session.remove(["unlock_key", "pending_send", "pending_device"]);
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
        solana: { mainnet: await solanaEndpoints("mainnet"), testnet: await solanaEndpoints("testnet") },
        solanaDefault: { mainnet: [...NETWORKS.mainnet.solana.rpc], testnet: [...NETWORKS.testnet.solana.rpc] },
        chains: { mainnet: await chainEndpoints("mainnet"), testnet: await chainEndpoints("testnet") },
        chainsDefault: { mainnet: chainDefaults("mainnet"), testnet: chainDefaults("testnet") },
        prices: await showPrices(),
        autoLock: await lockAfter(),
        notify: await notifyMode(),
      },
    };
  }

  /** Each EVM chain's endpoints in use on a network (Injective's own are `evm`). */
  async function chainEndpoints(net: NetworkId): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const c of evmChainsOf(net)) out[c.key] = [...(await evmChains.endpoints(net, c.key))];
    return out;
  }
  function chainDefaults(net: NetworkId): Record<string, string[]> {
    return Object.fromEntries(evmChainsOf(net).map((c) => [c.key, [...c.rpc]]));
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

  async function saveSettings(net: unknown, lcd: unknown, evm: unknown, evmIndex: unknown, prices: unknown, autoLock: unknown, notify?: unknown, solana?: unknown, chain?: unknown): Promise<UiResponse<Settings>> {
    if (!isNetworkId(net)) return err("bad_request", "Unknown network.");
    if (notify !== undefined && !NOTIFY_MODES.includes(notify as NotifyMode)) return err("bad_request", `notify must be one of ${NOTIFY_MODES.join(", ")}.`);
    if (prices !== undefined && typeof prices !== "boolean") return err("bad_request", "prices must be true or false.");
    if (autoLock !== undefined && !(typeof autoLock === "number" && LOCK_CHOICES.includes(autoLock))) return err("bad_request", `autoLock must be one of ${LOCK_CHOICES.join(", ")}.`);
    const stored = (await d.local.get(["endpoints", "evm_endpoints", "evm_index", "solana_endpoints"])) as { endpoints?: Endpoints; evm_endpoints?: Endpoints; evm_index?: Endpoints; solana_endpoints?: Endpoints };
    const lcdAll = nextEndpoints(stored.endpoints ?? {}, net, lcd);
    if ("ok" in lcdAll) return lcdAll as UiResponse<never>;
    const evmAll = nextEndpoints(stored.evm_endpoints ?? {}, net, evm);
    if ("ok" in evmAll) return evmAll as UiResponse<never>;
    const indexAll = nextEndpoints(stored.evm_index ?? {}, net, evmIndex, true);
    if ("ok" in indexAll) return indexAll as UiResponse<never>;
    const solanaAll = nextEndpoints(stored.solana_endpoints ?? {}, net, solana);
    if ("ok" in solanaAll) return solanaAll as UiResponse<never>;
    // One EVM chain's endpoints: { key, rpc } (rpc null for its defaults).
    const { chain_endpoints } = (await d.local.get(["chain_endpoints"])) as { chain_endpoints?: ChainEndpoints };
    let chainsAll: ChainEndpoints = chain_endpoints ?? {};
    if (chain !== undefined) {
      const c = chain as { key?: unknown; rpc?: unknown };
      const info = typeof c === "object" && c !== null ? chainByKey(net, c.key) : undefined;
      if (!info || info.kind !== "evm") return err("bad_request", "Unknown chain.");
      const forChain = nextEndpoints({ [net]: chainsAll[net]?.[info.key] ?? [] } as Endpoints, net, c.rpc);
      if ("ok" in forChain) return forChain as UiResponse<never>;
      const mine = { ...(chainsAll[net] ?? {}) };
      const urls = (forChain as Endpoints)[net];
      if (urls && urls.length > 0) mine[info.key] = [...urls];
      else delete mine[info.key];
      chainsAll = { ...chainsAll, [net]: mine };
    }
    const before = await network();
    await d.local.set({
      network: net,
      endpoints: lcdAll,
      evm_endpoints: evmAll,
      evm_index: indexAll,
      solana_endpoints: solanaAll,
      chain_endpoints: chainsAll,
      ...(prices === undefined ? {} : { prices }),
      ...(autoLock === undefined ? {} : { auto_lock: autoLock }),
      ...(notify === undefined ? {} : { notify }),
    });
    if (autoLock !== undefined && (await unlockKey()) !== undefined) await touch();
    if (notify !== undefined) {
      d.scheduleWatch?.(notify !== "off");
      // Off forgets what was seen, so turning it on later starts from what is there then.
      if (notify === "off") {
        await watcher.forget(null);
        await watcher.seen();
      }
    }
    if (net !== before) d.notify();
    return settings();
  }

  /** The account in use and the network, for requests that need an unlocked wallet. */
  async function active(): Promise<{ account: AccountInfo; net: NetworkId; key: string } | UiResponse<never>> {
    const u = await wallets.inUse();
    if (!u) return err("locked", "Unlock the wallet first.");
    await touch();
    return { account: u.account, net: await network(), key: u.key };
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
        return wallets.create(r.secret, r.password, r.imported === true);
      case "unlock":
        return wallets.unlock(r.password);
      case "lock":
        return lock();
      case "add_account":
        return wallets.addAccount(r.wallet);
      case "add_watch":
        return wallets.addWatch(r.address);
      case "add_ledger":
        return wallets.addLedger(r.accounts, r.wallet);
      case "add_ledger_solana":
        return wallets.addLedgerSolana(r.accounts);
      case "add_wallet":
        return wallets.addWallet(r.secret, r.created === true);
      case "rename_wallet":
        return wallets.renameWallet(r.wallet, r.name);
      case "remove_wallet": {
        const out = await wallets.removeWallet(r.wallet, r.password);
        if (out.ok) await forgetGone();
        return out;
      }
      case "switch_account":
        return wallets.changeAccount({ type: "switch", index: r.index });
      case "rename_account":
        return wallets.changeAccount({ type: "rename", index: r.index, name: r.name });
      case "remove_account": {
        const out = await wallets.changeAccount({ type: "remove", index: r.index });
        if (out.ok) await forgetGone();
        return out;
      }
      case "reveal_secret":
        return wallets.reveal(r.password, r.wallet, r.index);
      case "change_password":
        return wallets.changePassword(r.password, r.new_password, MIN_PASSWORD);
      case "reset": {
        const out = await wallets.reset(r.password, [...WALLET_KEYS, ...(await snapshots.keys())]);
        if (out.ok) d.badge?.("");
        return out;
      }
      case "settings":
        return settings();
      case "pick_chain": {
        if (r.network !== undefined && !isNetworkId(r.network)) return err("bad_request", "Unknown network.");
        const before = await network();
        const next = r.network ?? before;
        // Switching networks keeps the chain where it has one there (no Polygon on the test
        // networks: Injective's then).
        if (!chainByKey(next, r.chain) && !(r.network && r.network !== before && chainByKey(before, r.chain))) return err("bad_request", "Unknown chain.");
        const chain = chainByKey(next, r.chain) ? r.chain : "injective";
        await d.local.set({ chain, ...(r.network ? { network: r.network } : {}) });
        if (r.network && r.network !== before) d.notify();
        return { ok: true, result: await status() };
      }
      case "save_settings":
        return saveSettings(r.network, r.lcd, r.evm, r.evmIndex, r.prices, r.autoLock, r.notify, r.solana, r.chain);
      case "seen":
        await watcher.seen();
        return { ok: true, result: null };
      case "save_token_filter":
        return saveTokenFilter(r.filter);
      case "add_token": {
        const a = await active();
        if ("ok" in a) return a;
        return addToken(r.address);
      }
      case "contacts":
      case "save_contact":
      case "remove_contact":
      case "check_recipient": {
        const a = await active();
        if ("ok" in a) return a;
        if (r.type === "contacts") return { ok: true, result: await contacts.list() };
        if (r.type === "save_contact") return contacts.save(r);
        if (r.type === "remove_contact") return contacts.remove(r.id);
        return contacts.check(a.net, r.to);
      }
      case "balances":
      case "snapshot":
      case "activity":
      case "solana_activity":
      case "prepare_send":
      case "prepare_convert":
      case "staking":
      case "prepare_stake":
      case "approvals":
      case "swap_tokens":
      case "swap_quote":
      case "prepare_swap":
      case "bridge_routes":
      case "bridge_quote":
      case "prepare_bridge":
      case "bridge_status":
      case "bridge_in_routes":
      case "bridge_in_balances":
      case "bridge_in_quote":
      case "prepare_bridge_in":
      case "bridge_in_status":
      case "prepare_bridge_receive":
      case "bridge_in_pending":
      case "bridge_reclaims":
      case "prepare_bridge_reclaim":
      case "prepare_revoke":
      case "prepare_revoke_erc20":
      case "inventory":
      case "prepare_subaccount_withdraw":
      case "rescue":
      case "set_rescue":
      case "prepare_rescue_grant":
      case "prepare_rescue":
      case "nfts":
      case "add_nft_collection":
      case "prepare_nft_send":
      case "confirm_send":
      case "ledger_signed":
      case "tx_status": {
        const a = await active();
        if ("ok" in a) return a;
        if ((r.type === "prepare_send" || r.type === "prepare_convert" || r.type === "prepare_stake" || r.type === "prepare_revoke" || r.type === "prepare_revoke_erc20" || r.type === "prepare_swap" || r.type === "prepare_bridge" || r.type === "prepare_bridge_in" || r.type === "prepare_bridge_receive" || r.type === "prepare_bridge_reclaim" || r.type === "prepare_nft_send" || r.type === "prepare_rescue" || r.type === "prepare_rescue_grant" || r.type === "prepare_subaccount_withdraw") && isWatch(a.account)) {
          return err("watch_only", "This account is watch-only. Switch to one that can sign.");
        }
        if (r.type === "snapshot") return { ok: true, result: await snapshot(a.net, a.account) };
        if (r.type === "balances") {
          const picked = await wallets.chain();
          const [b, held, prices, chains] = await Promise.all([
            sender.balances(a.net, a.account),
            solana.holdings(a.net, a.account),
            sender.solanaPrices(a.net).catch(() => new Map<string, string>()),
            evmChains.all(a.net, a.account, picked),
          ]);
          if (!b.ok) return b;
          const priced = (x: Balance) => {
            const p = prices.get(x.denom);
            return p ? { ...x, priceUsd: p, usd: usdValue(x.amount, x.decimals, p) } : x;
          };
          const sol = held ? { ...held, balances: held.balances.map(priced) } : null;
          const result = { ...b.result, ...(sol ? { solana: sol } : {}), chains };
          keep(a.net, a.account, "balances", result);
          return { ok: true, result: { ...result, filter: await tokenFilter(a.net), prices: await showPrices() } };
        }
        if (r.type === "solana_activity") return solana.activity(a.net, a.account, typeof r.before === "string" ? r.before : undefined);
        if (r.type === "activity") {
          const page = await sender.activity(a.net, a.account, r.page);
          if (!page.ok) return page;
          const named = [...new Set(page.result.items.map((i) => i.counterparty ?? "").filter((c) => /^[a-z]+valoper1/.test(c)))];
          const result = { ...page.result, validators: await staking.names(a.net, named) };
          if (r.page === 1) keep(a.net, a.account, "activity", result);
          return { ok: true, result: { ...result, filter: await tokenFilter(a.net) } };
        }
        if (r.type === "prepare_send") {
          if (isSolanaDenom(r.denom)) return solana.prepareSend(a.net, a.account, r);
          if (chainDenom(r.denom)) return sender.prepareChainSend(a.net, a.account, r);
          return sender.prepare(a.net, a.account, r);
        }
        if (r.type === "prepare_convert") return sender.prepareConvert(a.net, a.account, r);
        if (r.type === "staking") {
          const st = await staking.summary(a.net, a.account);
          if (st.ok) keep(a.net, a.account, "staking", st.result);
          return st;
        }
        if (r.type === "prepare_stake") return staking.prepare(a.net, a.account, r);
        if (r.type === "approvals") return approvals.summary(a.net, a.account);
        if (r.type === "swap_tokens") return swaps.tokens(a.net, a.account);
        if (r.type === "swap_quote") return swaps.quote(a.net, a.account, r);
        if (r.type === "prepare_swap") return swaps.prepare(a.net, a.account, r.quote);
        if (r.type === "bridge_routes") return bridge.routes(a.net, a.account);
        if (r.type === "bridge_quote") return bridge.quote(a.net, a.account, r);
        if (r.type === "prepare_bridge") return bridge.prepare(a.net, a.account, r.quote);
        if (r.type === "bridge_status") return bridge.status(a.net, r.hash);
        if (r.type === "bridge_in_routes") return bridge.inRoutes(a.net, a.account);
        if (r.type === "bridge_in_balances") return bridge.inBalances(a.net, a.account);
        if (r.type === "bridge_in_quote") return bridge.inQuote(a.net, a.account, r);
        if (r.type === "prepare_bridge_in") return bridge.prepareIn(a.net, a.account, r.quote);
        if (r.type === "bridge_in_status") return bridge.inStatus(a.net, a.account, r);
        if (r.type === "prepare_bridge_receive") return bridge.prepareReceive(a.net, a.account, r);
        if (r.type === "bridge_in_pending") return bridge.inPending(a.net, a.account);
        if (r.type === "bridge_reclaims") return bridge.reclaims(a.net, a.account);
        if (r.type === "prepare_bridge_reclaim") return bridge.prepareReclaim(a.net, a.account, r.hash);
        if (r.type === "prepare_revoke") return approvals.prepare(a.net, a.account, r.items);
        if (r.type === "prepare_revoke_erc20") return approvals.prepareErc20(a.net, a.account, r.token, r.spender);
        if (r.type === "inventory") return inventory.summary(a.net, a.account);
        if (r.type === "prepare_subaccount_withdraw") return inventory.prepareWithdraw(a.net, a.account, r.nonce);
        if (r.type === "rescue") return rescue.summary(a.net, a.account);
        if (r.type === "set_rescue") return rescue.set(a.account, r.address);
        if (r.type === "prepare_rescue_grant") return rescue.prepareGrant(a.net, a.account);
        if (r.type === "prepare_rescue") return rescue.prepare(a.net, a.account);
        if (r.type === "nfts") return nfts.list(a.net, a.account);
        if (r.type === "add_nft_collection") return nfts.add(a.net, a.account, r.address);
        if (r.type === "prepare_nft_send") return nfts.prepare(a.net, a.account, r);
        if (r.type === "confirm_send") return sender.confirm(a.key, wallets.signer, r);
        if (r.type === "ledger_signed") return sender.deviceSigned(r);
        if (r.chain !== undefined && r.chain === NETWORKS[a.net].solana.caip2) return solana.status(a.net, r.hash);
        if (r.chain !== undefined) {
          // Any EVM chain on the wallet's list, by key ("base") or CAIP-2 ID.
          const c = chainByKey(a.net, r.chain) ?? (typeof r.chain === "string" ? chainByCaip2(a.net, r.chain) : undefined);
          if (!c || c.kind !== "evm") return err("bad_request", "Not a chain the wallet knows.");
          return sender.status(a.net, r.hash, sourceOfChain(c));
        }
        return sender.status(a.net, r.hash);
      }
      case "dapp_request":
        return dapps.request(r.id);
      case "dapp_review":
        return dapps.review(r.id);
      case "dapp_answer":
        return dapps.answer(r.id, r.approve, r.digest, r.confirm);
      case "dapp_ledger_signed":
        return dapps.deviceSigned(r.id, r.digest, r.signature, r.format);
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

  return {
    handle,
    lock,
    status,
    dapp,
    windowClosed: dapps.windowClosed,
    /** The background watcher's check (the alarm's), and whether it is on. */
    watch: watcher.tick,
    watching: async () => (await notifyMode()) !== "off",
    /** Every write the caches and the watcher have started is done (tests). */
    async settled() {
      await watcher.settled();
      await cachesSettled();
    },
  };
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
