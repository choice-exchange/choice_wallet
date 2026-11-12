// Wallets and accounts: the host's side of the vault's envelope.
//
// One password opens a vault key; each wallet (a recovery phrase or an imported key) is its
// secret, sealed under that key and bound to the wallet's ID. Accounts belong to a wallet
// (a phrase's by index), or are addresses to watch, with no key at all. In local storage:
//
//   vault           the password-wrapped vault key
//   wallets         [{ id, type, name, secret }]   (secret: sealed, opens only with the key)
//   accounts        [{ wallet, account, name, public_key, addresses }]
//   active_account  which account is in use, for the wallet and for connected sites
//
// While unlocked, the vault key (the "unlock key") is in session storage, as before. A
// device from before vaults has `keystore` and `kind` instead: the first unlock moves it
// into a vault as "Recovery phrase 1" (or "Imported key 1"), keeping the account list.

import { addedChains, CHAINS, chainByKey, cleanText, NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, NewSecret, Result, Status, WalletInfo } from "@choice-wallet/ui/protocol";

import type { Store } from "./service";

type UiResponse<T = unknown> = Result<T>;
const err = (code: string, message: string): UiResponse<never> => ({ ok: false, error: { code, message } });

/** A wallet as stored: its sealed secret never leaves the host. */
export type Wallet = WalletInfo & { secret: string };

/** Accounts in the list, all wallets and watched addresses together. */
const MAX_ACCOUNTS = 50;
/** Wallets on one device. */
const MAX_WALLETS = 20;
/** Characters in a name. */
const MAX_NAME = 24;
/** A phrase's indexes looked at for history when it is imported (0 is always added). */
const DISCOVER = 10;
const WATCH = "watch";

/** Chains every account has an address on, beside Injective's two sides: each EVM chain (any
 *  secp256k1 key, or a watched 0x), from the registry, which matches the vault's list. Solana
 *  only for a phrase's account, or a Ledger once its Solana app's key is read. */
const BOTH: readonly NetworkId[] = ["mainnet", "testnet"];
const EVM_IDS = BOTH.flatMap((n) => CHAINS[n].filter((c) => c.kind === "evm").map((c) => c.caip2));
const SOLANA_IDS = BOTH.map((n) => NETWORKS[n].solana.caip2);

/** An account's addresses with its 0x on each chain the user added: the same 20 bytes the
 *  vault gives on every EVM chain (one key, or one watched address). */
function onAddedChains(addresses: Record<string, string>): Record<string, string> {
  const evm = addresses[NETWORKS.mainnet.evm];
  const extra = addedChains().filter((c) => !addresses[`eip155:${c.chainId}`]);
  if (!evm || extra.length === 0) return addresses;
  return { ...addresses, ...Object.fromEntries(extra.map((c) => [`eip155:${c.chainId}`, evm])) };
}

export const isWatch = (a: AccountInfo) => a.account.derivation === "watch";
export const isLedger = (a: AccountInfo) => a.account.derivation === "ledger";
/** The paths a Ledger account may use: Injective's coin type, either layout. */
const LEDGER_PATH = /^m\/44'\/60'\/\d{1,9}'\/0\/\d{1,9}$/;
/** A Ledger account's key in its Solana app: Ledger Live's layout, `m/44'/501'/n'`. */
const SOLANA_LEDGER_PATH = /^m\/44'\/501'\/\d{1,9}'$/;
/** Ledger accounts added at once. */
const MAX_LEDGER_ADD = 10;

export interface WalletsHost {
  vault<T>(method: string, params?: unknown): Promise<Result<T>>;
  local: Store;
  session: Store;
  notify(): void;
  /** Activity: restart the auto-lock timer. */
  touch(): Promise<void>;
  cancelLock(): void;
  network(): Promise<Status["network"]>;
  /** Whether an address has a balance or history on the current network (false if the
   *  network can't say). */
  used(address: string): Promise<boolean>;
}

type Stored = {
  vault?: string;
  /** From before vaults. */
  keystore?: string;
  kind?: "mnemonic" | "private_key";
  wallets: Wallet[];
  accounts: AccountInfo[];
  active: number;
};

/** "Recovery phrase 3", "Imported key 2", "Account 7": one more than the highest so far. */
function next(prefix: string, names: readonly string[]): string {
  const re = new RegExp(`^${prefix} (\\d+)$`);
  const n = Math.max(0, ...names.map((x) => Number(re.exec(x)?.[1] ?? 0)));
  return `${prefix} ${n + 1}`;
}
const walletPrefix = (type: Wallet["type"]) => (type === "mnemonic" ? "Recovery phrase" : type === "ledger" ? "Ledger" : "Imported key");
const cleanName = (name: unknown) => (typeof name === "string" ? cleanText(name.replace(/\s+/g, " "), MAX_NAME) : "");

export function createWallets(h: WalletsHost) {
  async function stored(): Promise<Stored> {
    const got = (await h.local.get(["vault", "keystore", "kind", "wallets", "accounts", "active_account"])) as {
      vault?: string;
      keystore?: string;
      kind?: Stored["kind"];
      wallets?: Wallet[];
      accounts?: AccountInfo[];
      active_account?: unknown;
    };
    const wallets = Array.isArray(got.wallets) ? got.wallets : [];
    // Lists from before names or wallets: "Account 1", …; the one wallet there was.
    const accounts = (got.accounts ?? []).map((a, i) => ({
      ...a,
      name: typeof a.name === "string" && a.name ? a.name : `Account ${i + 1}`,
      wallet: typeof a.wallet === "string" && a.wallet ? a.wallet : isWatch(a) ? WATCH : (wallets[0]?.id ?? ""),
      addresses: onAddedChains(a.addresses),
    }));
    const i = got.active_account;
    const active = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < accounts.length ? i : 0;
    return {
      ...(got.vault ? { vault: got.vault } : {}),
      ...(got.keystore ? { keystore: got.keystore } : {}),
      ...(got.kind ? { kind: got.kind } : {}),
      wallets,
      accounts,
      active,
    };
  }

  async function unlockKey(): Promise<string | undefined> {
    const { unlock_key } = await h.session.get(["unlock_key"]);
    return typeof unlock_key === "string" ? unlock_key : undefined;
  }

  /** The chain picked on Home, if the network has it; Injective otherwise. */
  async function chain(): Promise<Status["chain"]> {
    const { chain } = await h.local.get(["chain"]);
    return chainByKey(await h.network(), chain) ? (chain as string) : "injective";
  }

  /** This install's anti-phishing phrase, made once: three random words. Only the wallet's
   *  pages read it (sites never get a status; content scripts can't read local storage). */
  let making: Promise<string> | null = null;
  async function phrase(): Promise<string> {
    const { anti_phishing } = await h.local.get(["anti_phishing"]);
    if (typeof anti_phishing === "string" && anti_phishing) return anti_phishing;
    making ??= (async () => {
      const g = await h.vault<{ phrase: string }>("generate_mnemonic", { words: 12 });
      const words = g.ok ? g.result.phrase.split(" ").slice(0, 3).join(" ") : "";
      if (words) await h.local.set({ anti_phishing: words });
      return words;
    })().finally(() => (making = null));
    return making;
  }

  async function status(): Promise<Status> {
    const s = await stored();
    const unlocked = Boolean(s.vault) && (await unlockKey()) !== undefined;
    return {
      phrase: await phrase(),
      hasWallet: Boolean(s.vault || s.keystore),
      unlocked,
      network: await h.network(),
      chain: await chain(),
      wallets: unlocked ? s.wallets.map(({ id, type, name }) => ({ id, type, name })) : [],
      accounts: unlocked ? s.accounts : [],
      active: unlocked ? s.active : 0,
      added: [...addedChains()],
    };
  }

  async function save(change: { wallets?: Wallet[]; accounts?: AccountInfo[]; active?: number }): Promise<UiResponse<Status>> {
    await h.local.set({
      ...(change.wallets ? { wallets: change.wallets } : {}),
      ...(change.accounts ? { accounts: change.accounts } : {}),
      ...(change.active !== undefined ? { active_account: change.active } : {}),
    });
    h.notify();
    return { ok: true, result: await status() };
  }

  /** The unlocked state, or the reason there isn't one. */
  async function open(): Promise<(Stored & { vault: string; key: string }) | UiResponse<never>> {
    const s = await stored();
    const key = await unlockKey();
    if (!s.vault || key === undefined) return err("locked", "Unlock the wallet first.");
    await h.touch();
    return { ...s, vault: s.vault, key };
  }

  /** Accounts of a wallet, from its sealed secret. */
  async function derive(w: { id: string; secret: string }, key: string, accounts: AccountInfo["account"][]) {
    return h.vault<{ accounts: Omit<AccountInfo, "name" | "wallet">[] }>("accounts", { secret: w.secret, wallet: w.id, unlock_key: key, accounts });
  }

  /** A phrase's accounts with history among indexes 1 to `DISCOVER - 1`, named in turn. */
  async function discover(w: Wallet, key: string, names: string[]): Promise<AccountInfo[]> {
    const indexes = Array.from({ length: DISCOVER - 1 }, (_, i) => i + 1);
    const r = await derive(w, key, indexes.map((index) => ({ derivation: "default" as const, index })));
    if (!r.ok) return [];
    const net = NETWORKS[await h.network()];
    const used = await Promise.all(r.result.accounts.map((a) => h.used(a.addresses[net.cosmos] ?? "").catch(() => false)));
    const out: AccountInfo[] = [];
    r.result.accounts.forEach((a, i) => {
      if (!used[i]) return;
      const name = next("Account", names);
      names.push(name);
      out.push({ ...a, wallet: w.id, name });
    });
    return out;
  }

  /** Seal a new wallet's secret and make its first account (both checked by the vault). */
  async function newWallet(key: string, secret: NewSecret, existing: readonly Wallet[]) {
    const id = crypto.randomUUID();
    const sealed = await h.vault<{ secret: string; kind: Wallet["type"] }>("seal_secret", { unlock_key: key, wallet: id, secret });
    if (!sealed.ok) return sealed;
    const w: Wallet = { id, type: sealed.result.kind, name: next(walletPrefix(sealed.result.kind), existing.map((x) => x.name)), secret: sealed.result.secret };
    const first = await derive(w, key, [w.type === "mnemonic" ? { derivation: "default", index: 0 } : { derivation: "imported" }]);
    if (!first.ok) return first;
    return { ok: true as const, result: { wallet: w, first: first.result.accounts[0]! } };
  }

  /** The first wallet, and the password for every wallet after it. */
  async function create(secret: NewSecret, password: string, imported: boolean): Promise<UiResponse<Status>> {
    const s = await stored();
    if (s.vault || s.keystore) return err("exists", "A wallet already exists on this device.");
    const v = await h.vault<{ vault: string; unlock_key: string }>("create_vault", { password });
    if (!v.ok) return v;
    const made = await newWallet(v.result.unlock_key, secret, []);
    if (!made.ok) return made;
    const { wallet, first } = made.result;
    const names = ["Account 1"];
    const accounts: AccountInfo[] = [{ ...first, wallet: wallet.id, name: "Account 1" }];
    await h.local.set({ vault: v.result.vault, wallets: [wallet], accounts, active_account: 0 });
    await h.session.set({ unlock_key: v.result.unlock_key });
    if (imported && wallet.type === "mnemonic") accounts.push(...(await discover(wallet, v.result.unlock_key, names)));
    await h.local.set({ accounts });
    await h.touch();
    h.notify();
    return { ok: true, result: await status() };
  }

  /** Accounts keep the addresses the vault gave when they were added, so one saved before
   *  the vault knew a chain (Solana, then each EVM chain on CCTP) has none there. At unlock
   *  each such account is read again and the missing addresses added: a phrase's or an
   *  imported key's from its sealed secret, a Ledger's from its public keys, a watched one's
   *  from its address. The ones saved are kept, and must match; a failure leaves the account
   *  as it was. */
  async function fillAddresses(s: Stored, key: string): Promise<void> {
    const phrase = (a: AccountInfo) => !isWatch(a) && !isLedger(a) && a.account.derivation !== "imported";
    const wants = (a: AccountInfo) => (phrase(a) || a.ledger_solana ? [...EVM_IDS, ...SOLANA_IDS] : EVM_IDS);
    const stale = s.accounts.filter((a) => wants(a).some((id) => !a.addresses[id]));
    if (stale.length === 0) return;
    const accounts = [...s.accounts];
    const merge = (a: AccountInfo, got: Record<string, string> | undefined) => {
      const saved = Object.entries(a.addresses).filter(([k]) => got?.[k] !== undefined);
      if (!got || saved.length === 0 || saved.some(([k, v]) => got[k] !== v)) return;
      accounts[accounts.indexOf(a)] = { ...a, addresses: { ...got, ...a.addresses } };
    };
    for (const w of s.wallets) {
      const mine = stale.filter((a) => a.wallet === w.id && !isWatch(a) && !isLedger(a));
      if (mine.length === 0) continue;
      const r = await derive(w, key, mine.map((a) => a.account));
      if (r.ok) mine.forEach((a, i) => merge(a, r.result.accounts[i]?.addresses));
    }
    for (const a of stale.filter(isLedger)) {
      const r = await h.vault<{ addresses: Record<string, string> }>("key_addresses", { public_key: a.public_key, ...(a.ledger_solana ? { solana_public_key: a.ledger_solana.public_key } : {}) });
      if (r.ok) merge(a, r.result.addresses);
    }
    for (const a of stale.filter(isWatch)) {
      const r = await h.vault<{ addresses: Record<string, string> }>("addresses", { address: a.addresses[NETWORKS.mainnet.cosmos] ?? "" });
      if (r.ok) merge(a, r.result.addresses);
    }
    if (accounts.some((a, i) => a !== s.accounts[i])) await h.local.set({ accounts });
  }

  async function unlock(password: string): Promise<UiResponse<Status>> {
    const s = await stored();
    if (s.vault) {
      const r = await h.vault<{ unlock_key: string }>("unlock", { vault: s.vault, password });
      if (!r.ok) return r;
      await h.session.set({ unlock_key: r.result.unlock_key });
      await fillAddresses(s, r.result.unlock_key);
    } else if (s.keystore && s.kind) {
      // From before vaults: move the keystore into one, and read every account again from
      // the moved secret (so the list matches it, whatever it said before).
      const id = crypto.randomUUID();
      const m = await h.vault<{ vault: string; unlock_key: string; secret: string; kind: Wallet["type"] }>("migrate", { keystore: s.keystore, password, wallet: id });
      if (!m.ok) return m;
      const w: Wallet = { id, type: m.result.kind, name: `${walletPrefix(m.result.kind)} 1`, secret: m.result.secret };
      const owned = s.accounts.filter((a) => !isWatch(a) && (w.type === "mnemonic" ? a.account.derivation !== "imported" : a.account.derivation === "imported"));
      const want = owned.length > 0 ? owned.map((a) => a.account) : [w.type === "mnemonic" ? { derivation: "default" as const, index: 0 } : { derivation: "imported" as const }];
      const r = await derive(w, m.result.unlock_key, want);
      if (!r.ok) return r;
      const accounts: AccountInfo[] = [
        ...r.result.accounts.map((a, i) => ({ ...a, wallet: id, name: owned[i]?.name ?? "Account 1" })),
        ...s.accounts.filter(isWatch).map((a) => ({ ...a, wallet: WATCH })),
      ];
      const activeAddress = s.accounts[s.active]?.addresses[NETWORKS.mainnet.cosmos];
      const active = Math.max(0, accounts.findIndex((a) => a.addresses[NETWORKS.mainnet.cosmos] === activeAddress));
      await h.local.set({ vault: m.result.vault, wallets: [w], accounts, active_account: active });
      await h.local.remove(["keystore", "kind"]);
      await h.session.set({ unlock_key: m.result.unlock_key });
    } else {
      return err("no_wallet", "There is no wallet on this device yet.");
    }
    await h.touch();
    h.notify();
    return { ok: true, result: await status() };
  }

  /** Another wallet: a new or imported phrase, or an imported key. An imported phrase's
   *  accounts with history come with it. A secret already here is refused; a watched
   *  address that it turns out to own becomes that account. */
  async function addWallet(secret: unknown, created: boolean): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    const shape = secret as Partial<Record<"mnemonic" | "private_key", unknown>> | null;
    const ok = typeof shape === "object" && shape !== null && Object.keys(shape).length === 1 && (typeof shape.mnemonic === "string" || typeof shape.private_key === "string");
    if (!ok) return err("bad_request", "Give a recovery phrase or a private key.");
    if (s.wallets.length >= MAX_WALLETS) return err("too_many", `At most ${MAX_WALLETS} wallets.`);
    if (s.accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
    const made = await newWallet(s.key, secret as NewSecret, s.wallets);
    if (!made.ok) return made;
    const { wallet, first } = made.result;
    const cosmos = NETWORKS.mainnet.cosmos;
    const same = s.accounts.find((a) => !isWatch(a) && a.public_key === first.public_key);
    if (same) {
      const from = s.wallets.find((x) => x.id === same.wallet);
      return err("exists", `That's already here: ${same.name}${from ? `, in ${from.name}` : ""}.`);
    }
    const watched = s.accounts.findIndex((a) => isWatch(a) && a.addresses[cosmos] === first.addresses[cosmos]);
    const kept = s.accounts.filter((_, i) => i !== watched);
    const names = kept.map((a) => a.name);
    const name = watched >= 0 ? s.accounts[watched]!.name : next("Account", names);
    names.push(name);
    const added: AccountInfo[] = [{ ...first, wallet: wallet.id, name }];
    if (wallet.type === "mnemonic" && !created) added.push(...(await discover(wallet, s.key, names)));
    const accounts = [...kept, ...added.slice(0, MAX_ACCOUNTS - kept.length)];
    return save({ wallets: [...s.wallets, wallet], accounts, active: kept.length });
  }

  /** Accounts read from a Ledger (their paths and public keys; the vault gives their
   *  addresses): a new Ledger wallet, or more of `walletId`'s. An account already here is
   *  skipped; a watched address it turns out to be becomes the account. The device's
   *  signatures are checked against these keys at every signing. */
  async function addLedger(keys: unknown, walletId: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_LEDGER_ADD) return err("bad_request", `Pick 1 to ${MAX_LEDGER_ADD} accounts.`);
    const found: { path: string; public_key: string; addresses: Record<string, string> }[] = [];
    for (const k of keys as unknown[]) {
      const key = k as { path?: unknown; public_key?: unknown } | null;
      if (typeof key?.path !== "string" || !LEDGER_PATH.test(key.path) || typeof key.public_key !== "string") return err("bad_request", "Not a Ledger account.");
      const r = await h.vault<{ public_key: string; addresses: Record<string, string> }>("key_addresses", { public_key: key.public_key });
      if (!r.ok) return r;
      found.push({ path: key.path, ...r.result });
    }
    let w: Wallet | undefined;
    let wallets = s.wallets;
    if (walletId !== undefined) {
      w = s.wallets.find((x) => x.id === walletId && x.type === "ledger");
      if (!w) return err("bad_request", "No such Ledger.");
    } else {
      if (s.wallets.length >= MAX_WALLETS) return err("too_many", `At most ${MAX_WALLETS} wallets.`);
      w = { id: crypto.randomUUID(), type: "ledger", name: next("Ledger", s.wallets.map((x) => x.name)), secret: "" };
      wallets = [...s.wallets, w];
    }
    const cosmos = NETWORKS.mainnet.cosmos;
    const accounts = [...s.accounts];
    let active = s.active;
    let added = 0;
    for (const f of found) {
      const same = accounts.find((a) => !isWatch(a) && a.public_key === f.public_key);
      if (same) continue;
      if (accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
      const watched = accounts.findIndex((a) => isWatch(a) && a.addresses[cosmos] === f.addresses[cosmos]);
      const name = watched >= 0 ? accounts[watched]!.name : next("Account", accounts.map((a) => a.name));
      const account: AccountInfo = { wallet: w.id, account: { derivation: "ledger", path: f.path }, public_key: f.public_key, addresses: f.addresses, name };
      if (watched >= 0) accounts[watched] = account;
      else accounts.push(account);
      active = accounts.indexOf(account);
      added++;
    }
    if (added === 0) {
      const same = accounts.find((a) => a.public_key === found[0]!.public_key);
      return err("exists", found.length === 1 && same ? `That's already here: ${same.name}.` : "Those accounts are already here.");
    }
    return save({ wallets, accounts, active });
  }

  /** Solana keys read from a Ledger's Solana app for its accounts here (found by their
   *  Cosmos app key): each gets its Solana address, and its Solana transactions go to that
   *  app at that path. The vault checks every signature against the key. */
  async function addLedgerSolana(keys: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_ACCOUNTS) return err("bad_request", "Which accounts?");
    const accounts = [...s.accounts];
    for (const k of keys as unknown[]) {
      const key = k as { public_key?: unknown; solana?: { path?: unknown; public_key?: unknown } } | null;
      const path = key?.solana?.path;
      const solanaKey = key?.solana?.public_key;
      if (typeof path !== "string" || !SOLANA_LEDGER_PATH.test(path) || typeof solanaKey !== "string") return err("bad_request", "Not a Ledger Solana key.");
      const i = accounts.findIndex((a) => isLedger(a) && a.public_key === key?.public_key);
      if (i < 0) return err("bad_request", "No such Ledger account.");
      const a = accounts[i]!;
      const r = await h.vault<{ addresses: Record<string, string> }>("key_addresses", { public_key: a.public_key, solana_public_key: solanaKey });
      if (!r.ok) return r;
      accounts[i] = { ...a, addresses: r.result.addresses, ledger_solana: { path, public_key: solanaKey.toLowerCase() } };
    }
    return save({ wallets: s.wallets, accounts, active: s.active });
  }

  /** The next account of a phrase wallet (the one in use, unless named), in use at once. */
  async function addAccount(walletId: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    const inUse = s.accounts[s.active];
    const w =
      typeof walletId === "string"
        ? s.wallets.find((x) => x.id === walletId)
        : (s.wallets.find((x) => x.id === inUse?.wallet && x.type === "mnemonic") ?? s.wallets.find((x) => x.type === "mnemonic"));
    if (!w) return err(typeof walletId === "string" ? "bad_request" : "no_phrase", typeof walletId === "string" ? "No such wallet." : "There's no recovery phrase here to add an account from.");
    if (w.type === "ledger") return err("ledger", "Add a Ledger's accounts from the Ledger screen.");
    if (w.type !== "mnemonic") return err("no_phrase", "An imported key has just the one account.");
    if (s.accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
    const used = s.accounts.flatMap((a) => (a.wallet === w.id && a.account.derivation === "default" ? [a.account.index] : []));
    const r = await derive(w, s.key, [{ derivation: "default", index: Math.max(-1, ...used) + 1 }]);
    if (!r.ok) return r;
    const account = { ...r.result.accounts[0]!, wallet: w.id, name: next("Account", s.accounts.map((a) => a.name)) };
    return save({ accounts: [...s.accounts, account], active: s.accounts.length });
  }

  /** An address to follow: balances and activity, never a signature. */
  async function addWatch(address: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    if (typeof address !== "string" || address.length > 100) return err("invalid_address", "Enter an inj1… or 0x… address.");
    if (s.accounts.length >= MAX_ACCOUNTS) return err("too_many", `The list holds at most ${MAX_ACCOUNTS} accounts.`);
    const r = await h.vault<{ addresses: Record<string, string> }>("addresses", { address });
    if (!r.ok) return err("invalid_address", "That isn't an Injective account address.");
    const cosmos = r.result.addresses[NETWORKS.mainnet.cosmos];
    const already = s.accounts.find((a) => a.addresses[NETWORKS.mainnet.cosmos] === cosmos);
    if (already) return err("exists", `That's already in your list, as ${already.name}.`);
    const name = next("Watching", s.accounts.map((a) => a.name));
    return save({ accounts: [...s.accounts, { wallet: WATCH, account: { derivation: "watch" }, public_key: "", addresses: r.result.addresses, name }], active: s.accounts.length });
  }

  async function changeAccount(op: { type: "switch" | "rename" | "remove"; index: unknown; name?: unknown }): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    const i = op.index;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= s.accounts.length) return err("bad_request", "No such account.");
    if (op.type === "switch") return save({ active: i });
    if (op.type === "rename") {
      const name = cleanName(op.name);
      if (!name) return err("bad_request", "Give the account a name.");
      return save({ accounts: s.accounts.map((a, j) => (j === i ? { ...a, name } : a)) });
    }
    const a = s.accounts[i]!;
    if (!isWatch(a) && s.accounts.filter((x) => x.wallet === a.wallet).length === 1) {
      return err("last_account", "It's its wallet's only account. Remove the wallet instead.");
    }
    return save({ accounts: s.accounts.filter((_, j) => j !== i), active: s.active === i ? 0 : s.active > i ? s.active - 1 : s.active });
  }

  async function renameWallet(id: unknown, name: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    const clean = cleanName(name);
    if (!s.wallets.some((w) => w.id === id)) return err("bad_request", "No such wallet.");
    if (!clean) return err("bad_request", "Give the wallet a name.");
    return save({ wallets: s.wallets.map((w) => (w.id === id ? { ...w, name: clean } : w)) });
  }

  async function checkPassword(vault: string, password: unknown): Promise<UiResponse<never> | null> {
    if (typeof password !== "string" || !password) return err("bad_request", "Enter your password.");
    const r = await h.vault("unlock", { vault, password });
    if (!r.ok) return r.error.code === "wrong_password" ? err("wrong_password", "Wrong password.") : r;
    return null;
  }

  /** One wallet and its accounts off this device, after the password. The last one can't
   *  go this way: that is "Reset", which takes everything. */
  async function removeWallet(id: unknown, password: unknown): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    if (!s.wallets.some((w) => w.id === id)) return err("bad_request", "No such wallet.");
    if (s.wallets.length === 1) return err("last_wallet", "It's the only wallet. Reset Choice Wallet to remove it.");
    const bad = await checkPassword(s.vault, password);
    if (bad) return bad;
    const inUse = s.accounts[s.active];
    const accounts = s.accounts.filter((a) => a.wallet !== id);
    const active = Math.max(0, accounts.findIndex((a) => a === inUse));
    return save({ wallets: s.wallets.filter((w) => w.id !== id), accounts, active });
  }

  /** What the user asked to see, after their password: a wallet's recovery phrase (or its
   *  key), or account `index`'s private key. Nothing is kept. */
  async function reveal(password: unknown, walletId: unknown, index: unknown): Promise<UiResponse<{ phrase?: string; private_key?: string }>> {
    const s = await open();
    if ("ok" in s) return s;
    if (typeof password !== "string" || !password) return err("bad_request", "Enter your password.");
    let w: Wallet | undefined;
    let account: AccountInfo["account"] | undefined;
    if (index !== undefined) {
      const a = typeof index === "number" ? s.accounts[index] : undefined;
      if (!a) return err("bad_request", "No such account.");
      if (isWatch(a)) return err("watch_only", "A watch-only account has no key.");
      if (isLedger(a)) return err("ledger", "A Ledger's keys never leave it.");
      w = s.wallets.find((x) => x.id === a.wallet);
      account = a.account;
    } else {
      w = typeof walletId === "string" ? s.wallets.find((x) => x.id === walletId) : s.wallets[0];
    }
    if (!w) return err("bad_request", "No such wallet.");
    if (w.type === "ledger") return err("ledger", "A Ledger's keys never leave it.");
    const r = await h.vault<{ phrase?: string; private_key?: string }>("reveal", { vault: s.vault, password, secret: w.secret, wallet: w.id, ...(account ? { account } : {}) });
    if (!r.ok && r.error.code === "wrong_password") return err("wrong_password", "Wrong password.");
    return r;
  }

  /** The vault under a new password. Every wallet, and the unlocked session, stay as they are. */
  async function changePassword(password: unknown, next: unknown, minimum: number): Promise<UiResponse<Status>> {
    const s = await open();
    if ("ok" in s) return s;
    if (typeof password !== "string" || typeof next !== "string") return err("bad_request", "Enter both passwords.");
    if ([...next].length < minimum) return err("weak_password", `Use at least ${minimum} characters.`);
    if (next === password) return err("same_password", "That's the password it has now.");
    // A new vault key too: every secret is sealed again under it, so an old copy of the vault
    // (with the old password) or an unlock key taken before opens nothing from now on.
    const secrets = Object.fromEntries(s.wallets.filter((w) => w.secret).map((w) => [w.id, w.secret]));
    const r = await h.vault<{ vault: string; unlock_key: string; secrets: Record<string, string> }>("change_password", { vault: s.vault, password, new_password: next, secrets });
    if (!r.ok) return r.error.code === "wrong_password" ? err("wrong_password", "Wrong password.") : r;
    const wallets = s.wallets.map((w) => (w.secret ? { ...w, secret: r.result.secrets[w.id] ?? "" } : w));
    if (wallets.some((w, i) => s.wallets[i]!.secret && !w.secret)) return err("internal", "A wallet's secret didn't come back. Nothing changed.");
    await h.local.set({ vault: r.result.vault, wallets });
    await h.session.set({ unlock_key: r.result.unlock_key });
    return { ok: true, result: await status() };
  }

  /** Everything off this device, after the password: every wallet, account, connected site
   *  and token choice. Settings such as endpoints stay. */
  async function reset(password: unknown, walletKeys: readonly string[]): Promise<UiResponse<Status>> {
    const s = await stored();
    if (!s.vault && !s.keystore) return err("no_wallet", "There is no wallet on this device.");
    // A device from before vaults moves into one at its first unlock; reset comes after.
    if (!s.vault) return err("locked", "Unlock the wallet first.");
    const bad = await checkPassword(s.vault, password);
    if (bad) return bad;
    await h.session.remove(["unlock_key", "pending_send", "pending_device"]);
    await h.local.remove([...walletKeys]);
    h.cancelLock();
    h.notify();
    return { ok: true, result: await status() };
  }

  /** The account in use with what signs for it (none for a watched address), while unlocked. */
  async function inUse(): Promise<{ account: AccountInfo; key: string; signer: { secret: string; wallet: string } | null } | null> {
    const s = await stored();
    const key = await unlockKey();
    const account = s.accounts[s.active];
    if (!s.vault || key === undefined || !account) return null;
    const w = s.wallets.find((x) => x.id === account.wallet);
    return { account, key, signer: w ? { secret: w.secret, wallet: w.id } : null };
  }

  /** What signs for wallet `id`, while unlocked. */
  async function signer(id: string): Promise<{ secret: string; wallet: string } | null> {
    const w = (await stored()).wallets.find((x) => x.id === id);
    return w ? { secret: w.secret, wallet: w.id } : null;
  }

  return { stored, status, chain, unlockKey, create, unlock, addWallet, addAccount, addLedger, addLedgerSolana, addWatch, changeAccount, renameWallet, removeWallet, reveal, changePassword, reset, inUse, signer };
}
