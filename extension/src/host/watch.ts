// The background watcher: tokens coming in and going out, while the popup is closed, and
// even while the wallet is locked (it needs only addresses, which local storage keeps in
// the clear anyway). Chrome wakes the service worker for it once a minute (an alarm), and
// it asks the user's own LCD endpoints; no server of ours is involved, and nothing is sent
// anywhere but there.
//
// - Each watched account's balances are read as the wallet's list reads them (bank tokens,
//   CW20s and EVM-only tokens, with token data from the disk caches, and without asking
//   Choice for prices) and compared with the last answer. The first answer is only kept:
//   nothing is shown for it. Like the list, it covers the tokens the wallet knows to ask
//   about: CW20s held, added or priced, and EVM-only tokens priced this week or added.
// - When they changed, the tx index says why: the latest transactions in which the account
//   received or spent coins, after the last check, and for a CW20 the ones whose contract
//   events moved it to or from the account (`wasm.to`, `wasm.from`). An EVM-only token's
//   transfer is named only inside its log, which no index query matches, so Blockscout's
//   latest transfers for the account are looked up on the LCD, as Activity does. Each
//   becomes a notification ("Received 5 INJ · from Alice"), read like an Activity row
//   (`summarize`).
// - Junk stays quiet, as everywhere in the wallet: a transaction this account didn't sign,
//   moving only tokens the token filter hides (spam airdrops, address poisoning), notifies
//   nothing.
// - A change no transaction explains (unstaked INJ coming back, which no transaction does;
//   or an index that hasn't caught up) is asked about once more on the next check, then
//   shown as the balance change it is.
// - The wallet's own transactions (sends, and what sites had it broadcast) are followed
//   from the moment they are broadcast, every 2 seconds for the first 2 minutes, then on
//   each check: "Sent 1 INJ · confirmed", or why it failed. Their balance changes aren't
//   notified again.
//
// While the popup is open it shows all of this itself: nothing pops up, the popup is told
// to refresh. Notifications go only to this browser.

import { formatShort, NETWORKS, shortDenom, summarize, type Activity, type ActivityKind, type EvmView, type IndexedTx, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, NotifyMode, TokenFilter } from "@choice-wallet/ui/protocol";
import { hiddenWhy } from "@choice-wallet/ui/token-filter";

import { bridgeLabel } from "./bridge";
import type { createSender } from "./send";
import type { Store } from "./service";

type Sender = ReturnType<typeof createSender>;

export const DEFAULT_MODE: NotifyMode = "active";
/** Accounts watched at once with "all accounts". */
export const MAX_WATCHED = 10;
/** Transactions the index is asked for, per direction, when a balance changed. */
const LOOKBACK = 10;
/** Block times are the chain's clock: a little slack for this computer's. */
const SLACK_MS = 2 * 60_000;
/** The wallet's own transactions: followed closely for this long after the broadcast... */
const FOLLOW_MS = 2 * 60_000;
const FOLLOW_EVERY_MS = 2_000;
/** ...and on each check after that, until this long has passed. */
const OWN_GIVE_UP_MS = 15 * 60_000;
/** Notifications from one check; past that, one says how many more. */
const MAX_NOTICES = 3;
/** Transactions (per account) remembered as notified or the wallet's own. */
const SEEN = 300;

export interface Notice {
  /** `<network>|<hash>|<account>`: the click opens the transaction. One per account, so a
   *  send between two watched accounts shows on both. */
  id: string;
  title: string;
  message: string;
}

export interface WatchDeps {
  local: Store;
  sender: Sender;
  network(): Promise<NetworkId>;
  accounts(): Promise<{ accounts: AccountInfo[]; active: number }>;
  mode(): Promise<NotifyMode>;
  filter(network: NetworkId): Promise<TokenFilter>;
  /** Who addresses are, for the text: the user's accounts and address book (inj1… and
   *  lowercase 0x…). */
  names(network: NetworkId): Promise<Map<string, string>>;
  /** Show a notification. False when it wasn't (the popup is open and shows it). */
  show(n: Notice): Promise<boolean>;
  /** The count on the toolbar icon ("" clears it). */
  badge(text: string): void;
  /** Tell the wallet's open pages to refresh. */
  changed(): void;
  now?(): number;
}

/** An account's last balances and when they were read; `from`: when watching it began,
 *  the earliest a transaction can be and still be notified. `v`: what the balances cover
 *  (2: bank, CW20 and EVM-only); one from before is kept again, not compared. */
type Seen = { coins: Record<string, string>; at: number; from: number; misses?: number; v?: number };
const VERSION = 2;
/** Blockscout transfers looked up on the LCD when an EVM-only token changed. */
const EVM_LOOKBACK = 5;
type Own = { network: NetworkId; hash: string; address: string; at: number; done?: boolean };
/** `seen`: `<address> <hash>` of each transaction already notified for that account. */
type State = { accounts: Record<string, Seen>; seen: string[]; badge: number };

const STATE = "watch";
const OWN = "watch_own";

const DONE: Record<ActivityKind, string> = {
  send: "Sent",
  receive: "Received",
  swap: "Swapped",
  convert: "Converted",
  approve: "Approved",
  bridge: "Bridged",
  contract: "Contract call",
  evm: "EVM transaction",
  orderbook: "INJ orderbook",
  ibc: "Sent to another chain",
  stake: "Staked",
  unstake: "Unstaking",
  redelegate: "Stake moved",
  rewards: "Rewards claimed",
  other: "Transaction",
};

export function createWatcher(d: WatchDeps) {
  const now = d.now ?? Date.now;
  let running: Promise<void> | null = null;
  let following: Promise<void> | null = null;
  // Everything that reads and writes the stored state takes turns, so a check and the
  // follow-up of a broadcast never undo each other's writes.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }

  async function state(): Promise<State> {
    const v = (await d.local.get([STATE]))[STATE] as Partial<State> | undefined;
    return { accounts: v?.accounts ?? {}, seen: v?.seen ?? [], badge: v?.badge ?? 0 };
  }
  async function own(): Promise<Own[]> {
    const v = (await d.local.get([OWN]))[OWN];
    return Array.isArray(v) ? (v as Own[]) : [];
  }
  const seenKey = (address: string, hash: string) => `${address} ${hash.toUpperCase()}`;
  function remember(s: State, address: string, hashes: Iterable<string>) {
    const set = new Set(s.seen);
    for (const h of hashes) set.add(seenKey(address, h));
    s.seen = [...set].slice(-SEEN);
  }

  /** Who is watched: the account in use, or every account (each address once). */
  async function watched(mode: NotifyMode): Promise<AccountInfo[]> {
    const { accounts, active } = await d.accounts();
    const net = NETWORKS[await d.network()];
    const first = accounts[active];
    const list = mode === "all" ? [...(first ? [first] : []), ...accounts.filter((a) => a !== first)] : first ? [first] : [];
    const out: AccountInfo[] = [];
    for (const a of list) {
      const addr = a.addresses[net.cosmos];
      if (addr && !out.some((o) => o.addresses[net.cosmos] === addr)) out.push(a);
    }
    return out.slice(0, MAX_WATCHED);
  }

  /** One check of every watched account. Checks never overlap. */
  function tick(): Promise<void> {
    running ??= exclusive(check).finally(() => (running = null));
    return running;
  }

  async function check(): Promise<void> {
    const mode = await d.mode();
    if (mode === "off") return;
    const network = await d.network();
    const notices: Notice[] = [];
    const s = await state();
    notices.push(...(await ownResults(network, s)));
    const net = NETWORKS[network];
    let moved = false;
    for (const account of await watched(mode)) {
      const address = account.addresses[net.cosmos]!;
      const key = `${network} ${address}`;
      const read = await d.sender.balances(network, account, { askChoice: false }).catch(() => null);
      if (!read?.ok) continue; // offline or no endpoint: the next check tries again
      let coins: Record<string, string> = Object.fromEntries(read.result.balances.map((b) => [b.denom, b.amount]));
      const before = s.accounts[key];
      if (!before || before.v !== VERSION) {
        s.accounts[key] = { coins, at: now(), from: before?.from ?? now(), v: VERSION };
        continue;
      }
      // No EVM endpoint answered: EVM-only tokens are as they were, not gone.
      if (read.result.evmDown) coins = { ...Object.fromEntries(Object.entries(before.coins).filter(([dn]) => dn.startsWith("evm:"))), ...coins };
      const from = before.from ?? before.at;
      if (sameCoins(before.coins, coins)) {
        s.accounts[key] = { coins, at: now(), from, v: VERSION };
        continue;
      }
      const changed = [...new Set([...Object.keys(before.coins), ...Object.keys(coins)])].filter((dn) => before.coins[dn] !== coins[dn]);
      let found: Awaited<ReturnType<typeof explain>>;
      try {
        // Never from before watching began: what happened then isn't news.
        found = await explain(network, account, Math.max(before.at - SLACK_MS, from), s, changed);
      } catch {
        continue; // the index didn't answer: ask again next time, from the same point
      }
      if (found.txs === 0 && (before.misses ?? 0) < 1) {
        s.accounts[key] = { ...before, misses: 1 };
        continue;
      }
      moved = true;
      notices.push(...found.notices);
      if (found.txs === 0) {
        const n = await balanceNotice(network, account, before.coins, coins);
        if (n) notices.push(n);
      }
      s.accounts[key] = { coins, at: now(), from, v: VERSION };
    }
    await deliver(s, notices);
    await d.local.set({ [STATE]: s });
    if (moved || notices.length > 0) d.changed();
  }

  /** Show what a check found. Past `MAX_NOTICES`, one notice says how many more. */
  async function deliver(s: State, notices: Notice[]): Promise<void> {
    if (notices.length === 0) return;
    const list = notices.length > MAX_NOTICES ? [...notices.slice(0, MAX_NOTICES - 1), { id: notices[MAX_NOTICES - 1]!.id, title: `${notices.length - MAX_NOTICES + 1} more transactions`, message: "Open the wallet to see them." }] : notices;
    let shown = 0;
    for (const n of list) if (await d.show(n)) shown++;
    if (shown > 0) {
      s.badge += notices.length;
      d.badge(s.badge > 99 ? "99+" : String(s.badge));
    }
  }

  /** The transactions behind a balance change: the account's latest received and spent,
   *  after `since`, that haven't been notified. `txs` counts every one found, notified
   *  before or not, so a change that one of the wallet's own sends explains isn't shown
   *  again as a bare balance change. */
  async function explain(network: NetworkId, account: AccountInfo, since: number, s: State, changed: readonly string[]): Promise<{ notices: Notice[]; txs: number }> {
    const net = NETWORKS[network];
    const me = account.addresses[net.cosmos]!;
    const client = await d.sender.lcd(network);
    const queries = [`coin_received.receiver='${me}'`, `coin_spent.spender='${me}'`];
    // A CW20 moves in its contract's events: to the account, or from it (its own send, or
    // someone with an allowance taking it).
    if (changed.some((dn) => dn.startsWith("cw20:"))) queries.push(`wasm.to='${me}'`, `wasm.from='${me}'`);
    const pages = await Promise.all(queries.map((q) => client.searchTxs(q, 1, LOOKBACK)));
    const byHash = new Map<string, IndexedTx>();
    for (const p of pages) for (const tx of p.txs) if (Date.parse(tx.time) >= since) byHash.set(tx.hash, tx);
    // An EVM-only token: Blockscout names the transactions, the LCD has the say.
    const me0x = account.addresses[net.evm];
    const index = me0x && changed.some((dn) => dn.startsWith("evm:")) ? await d.sender.evmIndex(network) : null;
    if (index && me0x) {
      const have = new Set([...byHash.values()].map((tx) => tx.evm?.hash).filter(Boolean));
      const named = await index.transfers(me0x, 1, EVM_LOOKBACK).catch(() => null);
      for (const t of named?.txs ?? []) {
        if (have.has(t.hash)) continue;
        const tx = await client.txByEvmHash(t.hash).catch(() => null);
        if (tx && Date.parse(tx.time) >= since) byHash.set(tx.hash, tx);
      }
    }
    const txs = [...byHash.values()].sort((a, b) => (a.height < b.height ? -1 : a.height > b.height ? 1 : 0));
    const fresh = txs.filter((tx) => !s.seen.includes(seenKey(me, tx.hash)));
    const view = await evmView(network, account);
    const notices: Notice[] = [];
    for (const tx of fresh) {
      const n = await activityNotice(network, account, summarize(tx, me, view));
      if (n) notices.push(n);
    }
    // Only once every notice is made: a failure above asks again next time.
    remember(s, me, fresh.map((tx) => tx.hash));
    return { notices, txs: txs.length };
  }

  async function evmView(network: NetworkId, account: AccountInfo): Promise<EvmView | undefined> {
    const me0x = account.addresses[NETWORKS[network].evm];
    if (!me0x) return undefined;
    const pairs = await d.sender.pairs(network).catch(() => null);
    return { address: me0x, pairs: pairs ? new Map([...pairs].map(([denom, erc20]) => [erc20.toLowerCase(), denom])) : null };
  }

  /** One transaction as a notification; null for junk, or one that moved nothing. */
  async function activityNotice(network: NetworkId, account: AccountInfo, a: Activity, ownResult?: string): Promise<Notice | null> {
    const visible = await shownDenoms(network, a.changes.map((c) => c.denom));
    // What others did shows only in tokens the filter shows; what this account signed, all
    // of it (signed somewhere else with this key, it is worth knowing about).
    const changes = a.signed ? a.changes : a.changes.filter((c) => visible.has(c.denom));
    if (!ownResult && !a.signed && (!a.ok || changes.length === 0)) return null;
    const ins = await amounts(network, changes.filter((c) => !c.amount.startsWith("-")));
    const outs = await amounts(network, changes.filter((c) => c.amount.startsWith("-")));
    const names = await d.names(network);
    const who = a.counterparty ? (names.get(a.counterparty) ?? names.get(a.counterparty.toLowerCase()) ?? short(a.counterparty)) : null;
    const done = a.label && a.kind === "other" ? a.label : DONE[a.kind];
    const title =
      a.kind === "receive"
        ? `Received ${ins || "tokens"}`
        : a.kind === "swap" || a.kind === "convert"
          ? `${done} ${outs}${ins ? ` for ${ins}` : ""}`.trim()
          : `${done}${outs ? ` ${outs}` : ins ? ` ${ins}` : ""}`;
    const parts = [account.name];
    if (who && a.kind === "receive") parts.push(`from ${who}`);
    else if (who && (a.kind === "send" || a.kind === "ibc")) parts.push(`to ${who}`);
    else if (a.kind === "bridge" && a.bridge) {
      const chain = bridgeLabel(network, a.bridge.domain, a.bridge.mintRecipient).chain;
      if (chain) parts.push(`${a.bridge.incoming ? "from" : "to"} ${chain}`);
    }
    if (ownResult) parts.push(ownResult);
    else if (!a.ok) parts.push("failed");
    return { id: `${network}|${a.evmHash ?? a.hash}|${account.addresses[NETWORKS[network].cosmos]}`, title, message: parts.join(" · ") };
  }

  /** Which of these denoms the user's token filter shows. */
  async function shownDenoms(network: NetworkId, denoms: string[]): Promise<Set<string>> {
    if (denoms.length === 0) return new Set();
    const [info, filter] = await Promise.all([d.sender.labels(network, denoms, false), d.filter(network)]);
    const fee = NETWORKS[network].feeDenom;
    return new Set(
      denoms.filter((dn) => {
        const t = info[dn];
        return hiddenWhy({ denom: dn, symbol: t?.symbol ?? "", name: t?.name ?? "", decimals: t?.decimals ?? 0, known: t?.known ?? false, amount: "0", ...(t?.onChoice ? { onChoice: true } : {}) }, filter, fee) === null;
      }),
    );
  }

  /** "5 INJ, 2 USDT" (at most two, then how many more). */
  async function amounts(network: NetworkId, coins: { denom: string; amount: string }[]): Promise<string> {
    if (coins.length === 0) return "";
    const info = await d.sender.labels(network, coins.map((c) => c.denom), false);
    const text = coins.slice(0, 2).map((c) => {
      const t = info[c.denom];
      const abs = c.amount.replace(/^-/, "");
      return t ? `${formatShort(abs, t.decimals, 4)} ${t.symbol}` : `${abs} ${shortDenom(c.denom)}`;
    });
    return coins.length > 2 ? `${text.join(", ")} +${coins.length - 2} more` : text.join(", ");
  }

  /** A balance change no transaction explains: shown as what it is. */
  async function balanceNotice(network: NetworkId, account: AccountInfo, before: Record<string, string>, after: Record<string, string>): Promise<Notice | null> {
    const changes: { denom: string; amount: string }[] = [];
    for (const dn of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const delta = BigInt(after[dn] ?? "0") - BigInt(before[dn] ?? "0");
      if (delta !== 0n) changes.push({ denom: dn, amount: delta.toString() });
    }
    const visible = await shownDenoms(network, changes.map((c) => c.denom));
    const shown = changes.filter((c) => visible.has(c.denom));
    if (shown.length === 0) return null;
    const ins = await amounts(network, shown.filter((c) => !c.amount.startsWith("-")));
    const outs = await amounts(network, shown.filter((c) => c.amount.startsWith("-")));
    const text = [ins && `+${ins}`, outs && `−${outs}`].filter(Boolean).join(", ");
    return { id: `${network}|balance ${now()}|${account.addresses[NETWORKS[network].cosmos]}`, title: "Balance changed", message: `${account.name} · ${text}` };
  }

  /** The wallet's own broadcasts that are now in a block (or failed), as notices. */
  async function ownResults(network: NetworkId, s: State, only?: string): Promise<Notice[]> {
    const list = await own();
    const open = list.filter((o) => !o.done && o.network === network && (!only || o.hash === only));
    if (open.length === 0) return [];
    const { accounts } = await d.accounts();
    const out: Notice[] = [];
    for (const o of open) {
      if (now() - o.at > OWN_GIVE_UP_MS) {
        o.done = true;
        continue;
      }
      const r = await d.sender.status(o.network, o.hash).catch(() => null);
      if (!r || !r.ok || r.result.state === "pending") continue;
      o.done = true;
      remember(s, o.address, [o.hash]);
      const account = accounts.find((a) => a.addresses[NETWORKS[network].cosmos] === o.address);
      const failed = r.result.state === "failed";
      let n: Notice | null = null;
      if (account) {
        // Read like an Activity row when the index has it; a plain notice otherwise.
        try {
          const tx = await lookUp(network, o.hash);
          if (tx) {
            n = await activityNotice(network, account, summarize(tx, o.address, await evmView(network, account)), failed ? "failed" : "confirmed");
            remember(s, o.address, [tx.hash]);
          }
        } catch {
          n = null;
        }
      }
      n ??= { id: `${network}|${o.hash}|${o.address}`, title: failed ? "Transaction failed" : "Transaction confirmed", message: account?.name ?? "" };
      if (failed && r.result.log) n = { ...n, message: `${n.message}${n.message ? " · " : ""}${r.result.log.slice(0, 140)}` };
      out.push(n);
    }
    await d.local.set({ [OWN]: list.filter((o) => !o.done || now() - o.at < OWN_GIVE_UP_MS).slice(-30) });
    return out;
  }

  async function lookUp(network: NetworkId, hash: string): Promise<IndexedTx | null> {
    const client = await d.sender.lcd(network);
    return hash.startsWith("0x") ? client.txByEvmHash(hash) : client.indexedTx(hash);
  }

  /** A transaction the wallet just broadcast for `address`: followed until it lands. */
  async function track(network: NetworkId, hash: string, address: string): Promise<void> {
    await exclusive(async () => {
      const list = await own();
      if (!list.some((o) => o.hash === hash)) list.push({ network, hash, address, at: now() });
      await d.local.set({ [OWN]: list.slice(-30) });
    });
    following ??= follow().finally(() => (following = null));
  }

  /** Every 2 seconds, while a broadcast is younger than `FOLLOW_MS`. The service worker
   *  stays up meanwhile: it is making requests. */
  async function follow(): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, FOLLOW_EVERY_MS));
      const more = await exclusive(async () => {
        const network = await d.network();
        const open = (await own()).filter((o) => !o.done && o.network === network && now() - o.at < FOLLOW_MS);
        if (open.length === 0 || (await d.mode()) === "off") return false;
        const s = await state();
        const notices: Notice[] = [];
        for (const o of open) notices.push(...(await ownResults(network, s, o.hash)));
        if (notices.length > 0) {
          await deliver(s, notices);
          await d.local.set({ [STATE]: s });
          d.changed();
        }
        return true;
      });
      if (!more) return;
    }
  }

  /** The popup opened: clear the count. */
  function seen(): Promise<void> {
    return exclusive(async () => {
      const s = await state();
      if (s.badge === 0) return;
      await d.local.set({ [STATE]: { ...s, badge: 0 } });
      d.badge("");
    });
  }

  /** Forget accounts that are gone, and every account when notifications go off (so
   *  turning them on again starts from what is there then). */
  function forget(keep: readonly string[] | null): Promise<void> {
    return exclusive(async () => {
      const s = await state();
      const set = new Set(keep ?? []);
      for (const k of Object.keys(s.accounts)) if (!set.has(k.split(" ")[1] ?? "")) delete s.accounts[k];
      await d.local.set({ [STATE]: s });
    });
  }

  return { tick, track, seen, forget, settled: async () => void (await Promise.all([running, following, queue])) };
}

function sameCoins(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
