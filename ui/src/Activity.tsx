// Activity (a tab): what each recent transaction did to this account, newest first, from
// the user's own endpoints (Blockscout only finds EVM transfers others made; the LCD has
// the say). Junk (not signed here, and only tokens the filter hides, in or out) sits behind
// a row, like on the home screen. A row opens the explorer: Blockscout for an EVM one.

import { chainByCaip2, chainByKey, explorerTxUrl, formatShort, NETWORKS, shortDenom } from "@choice-wallet/chain";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useBackend } from "./backend";
import { ChainMark } from "./Chains";
import {
  ChartIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  EyeOffIcon,
  GiftIcon,
  GlobeIcon,
  InfoIcon,
  ReceiveIcon,
  RefreshIcon,
  SendIcon,
  StakeIcon,
  SwapIcon,
  WarningIcon,
} from "./icons";
import { Callout, Screen, shortAddress } from "./kit";
import type { ActivityItem, ActivityKind, ActivityPage, Balance, ChainView, Coin, NetworkId, Replies } from "./protocol";
import { useRequest } from "./request";
import { ACTIVITY_FRESH_MS, merge, type ActivityState } from "./activityState";
import { hiddenWhy } from "./tokenFilter";

const TITLE: Record<ActivityKind, string> = {
  send: "Sent",
  receive: "Received",
  swap: "Swap",
  convert: "Converted",
  approve: "Approved",
  bridge: "Bridged",
  contract: "Contract call",
  evm: "EVM transaction",
  orderbook: "INJ orderbook",
  ibc: "Sent to another chain",
  stake: "Staked",
  unstake: "Unstaked",
  redelegate: "Stake moved",
  rewards: "Rewards claimed",
  other: "Transaction",
};

const ICON: Record<ActivityKind, (p: { size?: number }) => ReactNode> = {
  send: SendIcon,
  receive: ReceiveIcon,
  swap: SwapIcon,
  convert: SwapIcon,
  approve: CheckIcon,
  bridge: GlobeIcon,
  contract: CodeIcon,
  evm: CodeIcon,
  orderbook: ChartIcon,
  ibc: GlobeIcon,
  stake: StakeIcon,
  unstake: StakeIcon,
  redelegate: StakeIcon,
  rewards: GiftIcon,
  other: InfoIcon,
};

type Tokens = ActivityPage["tokens"];

/** `kept`: what the tab showed last (this popup session, or the saved copy from disk).
 *  `onKeep` gets every change, for the next visit. */
export function ActivityView({
  network,
  chain,
  tabs,
  kept,
  onKeep,
}: {
  network: NetworkId;
  /** Whose history: Injective's, or the account's Solana key's. */
  chain: ChainView;
  tabs: ReactNode;
  kept?: ActivityState | null;
  onKeep?: (s: ActivityState) => void;
}) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [st, setSt] = useState<ActivityState | null>(kept ?? null);
  const [showHidden, setShowHidden] = useState(false);
  /** The account's Solana history (its own key), when that's the chain shown. */
  const [sol, setSol] = useState<Replies["solana_activity"] | null>(null);
  const onSolana = chain === "solana";
  /** An EVM chain beside Injective: its history, page by page. */
  const evmChain = chainByKey(network, chain)?.kind === "evm" ? chainByKey(network, chain) : undefined;
  const [evm, setEvm] = useState<Replies["chain_activity"] | null>(null);
  const live = useRef(true);

  async function load(p: number) {
    if (onSolana) return loadSolana();
    if (evmChain) return loadChain(1);
    const r = await run({ type: "activity", page: p });
    if (r && live.current) setSt((prev) => merge(prev, r, p, Date.now()));
  }

  async function loadSolana(before?: string) {
    const r = await run({ type: "solana_activity", ...(before ? { before } : {}) });
    if (!r || !live.current) return;
    setSol((prev) => (before && prev ? { items: [...prev.items, ...r.items], tokens: { ...prev.tokens, ...r.tokens }, next: r.next } : r));
  }

  async function loadChain(p: number) {
    const r = await run({ type: "chain_activity", chain, page: p });
    if (!r || !live.current) return;
    setEvm((prev) => (p > 1 && prev ? { ...r, items: [...prev.items, ...r.items.filter((i) => !prev.items.some((x) => x.hash === i.hash))], tokens: { ...prev.tokens, ...r.tokens } } : r));
  }

  useEffect(() => {
    if (st) onKeep?.(st);
  }, [st]);

  // Shown at once; asked again only when it is old, or when something happened.
  useEffect(() => {
    live.current = true;
    if (onSolana || evmChain || !kept || Date.now() - kept.at > ACTIVITY_FRESH_MS) void load(1);
    const off = backend.onRefresh?.(() => void load(1));
    return () => {
      live.current = false;
      off?.();
    };
  }, [network, chain]);

  // A saved copy that arrives after the tab opened (the wallet reads it from disk at start).
  useEffect(() => {
    if (kept && st === null) setSt(kept);
  }, [kept]);

  const other = onSolana || evmChain !== undefined;
  const items = onSolana ? (sol?.items ?? null) : evmChain ? (evm?.items ?? null) : (st?.items ?? null);
  const tokens: Tokens = onSolana ? (sol?.tokens ?? {}) : evmChain ? (evm?.tokens ?? {}) : (st?.tokens ?? {});
  const validators = st?.validators ?? {};
  const filter = st?.filter ?? null;
  const page = st?.page ?? 1;
  const more = st?.more ?? false;
  const cutoff = st?.cutoff ?? null;
  const indexDown = st?.indexDown ?? false;

  const fee = NETWORKS[network].feeDenom;
  /** Junk: not signed here, and every token it moved is one the filter hides. Out counts
   *  too: any contract can log a "transfer" from this account of a token it made up. */
  const junk = (a: ActivityItem) =>
    filter !== null &&
    !a.signed &&
    a.changes.length > 0 &&
    a.changes.every((c) => {
      const t = tokens[c.denom];
      const b: Balance = { denom: c.denom, symbol: t?.symbol ?? "", name: t?.name ?? "", decimals: t?.decimals ?? 0, known: t?.known ?? false, amount: "0", ...(t?.onChoice ? { onChoice: true } : {}) };
      return hiddenWhy(b, filter, fee) !== null;
    });
  const loaded = other ? (items ?? []) : (items ?? []).filter((a) => cutoff === null || BigInt(a.height) >= BigInt(cutoff));
  const hiddenCount = loaded.filter(junk).length;
  const visible = showHidden ? loaded : loaded.filter((a) => !junk(a));

  // Group by local day.
  const groups: { day: string; rows: ActivityItem[] }[] = [];
  for (const a of visible) {
    const day = dayLabel(a.time);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(a);
    else groups.push({ day, rows: [a] });
  }

  return (
    <Screen
      tabs={tabs}
      top={
        <>
          <ChainMark chain={chain} network={network} small />
          <span className="title">Activity</span>
          <button className={busy ? "icon-btn busy" : "icon-btn"} aria-label="Refresh" disabled={busy} onClick={() => void load(1)}>
            <RefreshIcon />
          </button>
        </>
      }
    >
      {error && <Callout level="amber">{error}</Callout>}
      {items === null ? (
        !error && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)
      ) : visible.length === 0 && hiddenCount === 0 && !more && !sol?.next && !evm?.next ? (
        <p className="empty">No activity yet.</p>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.day} className="activity-group">
              <div className="eyebrow">{g.day}</div>
              <div className="activity-list">
                {g.rows.map((a) => (
                  <Row
                    key={a.hash}
                    a={a}
                    tokens={tokens}
                    validators={validators}
                    dim={junk(a)}
                    onOpen={() =>
                      backend.openLink(
                        a.chain?.startsWith("eip155:")
                          ? (chainByCaip2(network, a.chain)?.explorerTx ?? "").replace("{hash}", a.hash)
                          : a.chain
                            ? NETWORKS[network].solana.explorerTx.replace("{hash}", a.hash)
                            : explorerTxUrl(NETWORKS[network], a.evmHash ?? a.hash),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
          {hiddenCount > 0 && !showHidden && (
            <button className="hidden-row" onClick={() => setShowHidden(true)}>
              <EyeOffIcon size={16} />
              {hiddenCount} from hidden tokens
              <ChevronDownIcon size={16} />
            </button>
          )}
          {(onSolana ? sol?.next : evmChain ? evm?.next : more) && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => void (onSolana ? loadSolana(sol!.next!) : evmChain ? loadChain(evm!.next!) : load(page + 1))}>
              {busy ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
      {!other && indexDown && <p className="footnote">Blockscout didn't answer, so some EVM transfers may be missing.</p>}
      {evmChain && evm?.indexDown && <p className="footnote">The index didn&apos;t answer: only what this wallet sent shows.</p>}
      {evmChain && evm && !evm.indexed ? (
        <p className="footnote">Only what this wallet sent on {evmChain.name}. Add an index in Settings for the rest.</p>
      ) : (
        <p className="footnote">From your endpoints. How far back depends on the node.</p>
      )}
    </Screen>
  );
}

function Row({ a, tokens, validators, dim, onOpen }: { a: ActivityItem; tokens: Tokens; validators: Record<string, string>; dim: boolean; onOpen: () => void }) {
  const Icon = a.ok ? ICON[a.kind] : WarningIcon;
  const incoming = a.ok && a.changes.length > 0 && a.changes.every((c) => !c.amount.startsWith("-"));
  const revoked = a.approval?.amount === "0";
  const title = a.kind === "other" ? (a.label ?? TITLE.other) : revoked ? "Approval removed" : a.kind === "bridge" && a.bridge?.chain ? `Bridged ${a.bridge.incoming ? "from" : "to"} ${a.bridge.chain}` : TITLE[a.kind];
  const preposition = a.kind === "receive" ? "from" : a.kind === "approve" ? "for" : a.kind === "stake" || a.kind === "unstake" ? "with" : "to";
  // A validator by its name when the active set has it (the name is the validator's own).
  const party = a.counterparty === undefined ? "" : (validators[a.counterparty] ?? shortAddress(a.counterparty));
  const who = a.bridge?.recipient && !a.bridge.incoming ? ` · to ${shortAddress(a.bridge.recipient)}` : a.counterparty === undefined ? "" : ` · ${preposition} ${party}`;
  const lines = a.changes.slice(0, 2);
  return (
    <button className={dim ? "activity is-hidden" : "activity"} title={a.evmHash ?? a.hash} onClick={onOpen}>
      <span className={`activity-icon${!a.ok ? " failed" : incoming ? " in" : ""}`}>
        <Icon size={18} />
      </span>
      <span className="name">
        <span className="title-line">
          {title}
          {!a.ok && <span className="flag red">Failed</span>}
        </span>
        <span className="sub">
          {timeLabel(a.time)}
          {who}
        </span>
      </span>
      <span className="value">
        {lines.map((c) => (
          <span key={c.denom} className={c.amount.startsWith("-") ? "amount" : "amount in"}>
            {amountLabel(c, tokens)}
          </span>
        ))}
        {a.changes.length > 2 && <span className="amount dim">+{a.changes.length - 2} more</span>}
        {a.approval && !revoked && <span className="amount dim">{allowanceLabel(a.approval, tokens)}</span>}
        {lines.length === 0 && (!a.approval || revoked) && a.fee.length > 0 && <span className="amount dim">Fee {amountLabel(a.fee[0]!, tokens).replace(/^[-+]/, "")}</span>}
      </span>
    </button>
  );
}

function amountLabel(c: Coin, tokens: Tokens): string {
  const t = tokens[c.denom];
  const neg = c.amount.startsWith("-");
  const abs = neg ? c.amount.slice(1) : c.amount;
  const symbol = t ? (t.known ? t.symbol : t.symbol || shortDenom(c.denom)) : shortDenom(c.denom);
  return `${neg ? "-" : "+"}${formatShort(abs, t?.decimals ?? 0, 4)} ${symbol}`;
}

/** An allowance: "Unlimited USDT" at the sizes wallets and routers use for "all of it". */
function allowanceLabel(ap: NonNullable<ActivityItem["approval"]>, tokens: Tokens): string {
  const t = tokens[ap.denom];
  const symbol = t ? (t.known ? t.symbol : t.symbol || shortDenom(ap.denom)) : shortDenom(ap.denom);
  if (BigInt(ap.amount) >= 2n ** 128n) return `Unlimited ${symbol}`;
  return `${formatShort(ap.amount, t?.decimals ?? 0, 4)} ${symbol}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const same = (x: Date, y: Date) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
