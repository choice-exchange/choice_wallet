// Activity (a tab): what each recent transaction did to this account, newest first, from
// the user's own endpoints. Junk sent to the account (only tokens the filter hides, and
// not signed here) sits behind a row, like on the home screen. A row opens the explorer.

import { explorerTxUrl, formatShort, NETWORKS, shortDenom } from "@choice-wallet/chain";
import { useEffect, useState, type ReactNode } from "react";

import { useBackend } from "./backend";
import {
  ChartIcon,
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
import type { ActivityItem, ActivityKind, ActivityPage, Balance, Coin, NetworkId, TokenFilter } from "./protocol";
import { useRequest } from "./request";
import { hiddenWhy } from "./tokenFilter";

const TITLE: Record<ActivityKind, string> = {
  send: "Sent",
  receive: "Received",
  swap: "Swap",
  convert: "Converted",
  contract: "Contract call",
  evm: "EVM transaction",
  orderbook: "INJ orderbook",
  ibc: "Sent to another chain",
  stake: "Staked",
  unstake: "Unstaked",
  redelegate: "Redelegated",
  rewards: "Rewards claimed",
  other: "Transaction",
};

const ICON: Record<ActivityKind, (p: { size?: number }) => ReactNode> = {
  send: SendIcon,
  receive: ReceiveIcon,
  swap: SwapIcon,
  convert: SwapIcon,
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

export function ActivityView({ network, tabs }: { network: NetworkId; tabs: ReactNode }) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [tokens, setTokens] = useState<Tokens>({});
  const [filter, setFilter] = useState<TokenFilter | null>(null);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [reload, setReload] = useState(0);

  async function load(p: number) {
    const r = await run({ type: "activity", page: p });
    if (!r) return;
    setItems((prev) => {
      const seen = new Set((p === 1 ? [] : (prev ?? [])).map((a) => a.hash));
      const all = [...(p === 1 ? [] : (prev ?? [])), ...r.items.filter((a) => !seen.has(a.hash))];
      return all.sort((a, b) => (BigInt(b.height) > BigInt(a.height) ? 1 : BigInt(b.height) < BigInt(a.height) ? -1 : 0));
    });
    setTokens((prev) => ({ ...(p === 1 ? {} : prev), ...r.tokens }));
    setFilter(r.filter);
    setPage(p);
    setMore(r.more);
    setCutoff(r.cutoff);
  }

  useEffect(() => {
    void load(1);
  }, [network, reload]);

  const fee = NETWORKS[network].feeDenom;
  /** Junk: not signed here, and every token it brought is one the filter hides. */
  const junk = (a: ActivityItem) =>
    filter !== null &&
    !a.signed &&
    a.changes.length > 0 &&
    a.changes.every((c) => {
      const t = tokens[c.denom];
      const b: Balance = { denom: c.denom, symbol: t?.symbol ?? "", name: t?.name ?? "", decimals: t?.decimals ?? 0, known: t?.known ?? false, amount: "0", ...(t?.onChoice ? { onChoice: true } : {}) };
      return !c.amount.startsWith("-") && hiddenWhy(b, filter, fee) !== null;
    });
  const loaded = (items ?? []).filter((a) => cutoff === null || BigInt(a.height) >= BigInt(cutoff));
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
          <span className="title">Activity</span>
          <button className="icon-btn" aria-label="Refresh" disabled={busy} onClick={() => setReload((n) => n + 1)}>
            <RefreshIcon />
          </button>
        </>
      }
    >
      {error && <Callout level="amber">{error}</Callout>}
      {items === null ? (
        !error && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)
      ) : visible.length === 0 && hiddenCount === 0 && !more ? (
        <p className="empty">No activity yet.</p>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.day} className="activity-group">
              <div className="eyebrow">{g.day}</div>
              <div className="activity-list">
                {g.rows.map((a) => (
                  <Row key={a.hash} a={a} tokens={tokens} dim={junk(a)} onOpen={() => backend.openLink(explorerTxUrl(NETWORKS[network], a.hash))} />
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
          {more && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => void load(page + 1)}>
              {busy ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
      <p className="footnote">From your endpoints. How far back depends on the node.</p>
    </Screen>
  );
}

function Row({ a, tokens, dim, onOpen }: { a: ActivityItem; tokens: Tokens; dim: boolean; onOpen: () => void }) {
  const Icon = a.ok ? ICON[a.kind] : WarningIcon;
  const incoming = a.ok && a.changes.length > 0 && a.changes.every((c) => !c.amount.startsWith("-"));
  const title = a.kind === "other" ? (a.label ?? TITLE.other) : TITLE[a.kind];
  const who =
    a.counterparty === undefined
      ? ""
      : ` · ${a.kind === "receive" ? "from" : a.kind === "stake" || a.kind === "unstake" || a.kind === "redelegate" ? "with" : "to"} ${shortAddress(a.counterparty)}`;
  const lines = a.changes.slice(0, 2);
  return (
    <button className={dim ? "activity is-hidden" : "activity"} title={a.hash} onClick={onOpen}>
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
        {lines.length === 0 && a.fee.length > 0 && <span className="amount dim">Fee {amountLabel(a.fee[0]!, tokens).replace(/^[-+]/, "")}</span>}
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
