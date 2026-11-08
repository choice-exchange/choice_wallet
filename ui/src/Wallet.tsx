// The unlocked wallet: three tabs (Wallet, Activity, Settings), and the flows that open
// over them full screen (receive, a token, send, convert, manage tokens).

import { formatShort, NETWORKS, shortDenom } from "@choice-wallet/chain";
import { useEffect, useRef, useState } from "react";

import { AccountsView, isWatch } from "./Accounts";
import { ActivityView } from "./Activity";
import mark from "./assets/choice-mark.svg";
import { useBackend } from "./backend";
import { ActivityIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, EyeOffIcon, LockIcon, ReceiveIcon, SendIcon, SettingsIcon, WalletIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, Segmented, shortAddress, tokenSub } from "./kit";
import type { Balance, SendReview, Sent, Status, TokenFilter } from "./protocol";
import { QrCode } from "./QrCode";
import { useRequest } from "./request";
import { Review, SendForm, SentView } from "./Send";
import { SettingsView } from "./Settings";
import { ConvertForm, TokenView } from "./Token";
import { applyFilter, DEFAULT_FILTER } from "./tokenFilter";
import { TokenMark } from "./TokenMark";
import { TokensView } from "./Tokens";

type Tab = "wallet" | "activity" | "settings";

/** A flow opened over the tabs; "home" is the tabs themselves. */
type View =
  | { name: "home" }
  | { name: "accounts" }
  | { name: "receive" }
  | { name: "token"; denom: string }
  | { name: "send"; denom?: string }
  | { name: "convert"; denom: string }
  | { name: "review"; review: SendReview; entered: string; back: View }
  | { name: "sent"; sent: Sent; converting: boolean }
  | { name: "tokens" };

const COSMOS = "cosmos:injective-1";
const EVM = "eip155:1776";

const TABS: readonly (readonly [Tab, string, typeof WalletIcon])[] = [
  ["wallet", "Wallet", WalletIcon],
  ["activity", "Activity", ActivityIcon],
  ["settings", "Settings", SettingsIcon],
];

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map(([t, label, Icon]) => (
        <button key={t} type="button" aria-current={t === tab ? "page" : undefined} onClick={() => onTab(t)}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Wallet({ status, onLock, onStatus }: { status: Status; onLock: () => void; onStatus: (s?: Status) => void }) {
  const backend = useBackend();
  const [tab, setTab] = useState<Tab>("wallet");
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [filter, setFilter] = useState<TokenFilter>(DEFAULT_FILTER);
  const [prices, setPrices] = useState(true);
  const [evmDown, setEvmDown] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { run, error, setError } = useRequest();

  // The last filter save, so a refresh never reads the filter before it lands.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const account = status.accounts[status.active] ?? status.accounts[0];
  const address = account?.addresses[COSMOS] ?? "";
  const watch = isWatch(account);
  // Another account: its balances, never the last one's while they load.
  useEffect(() => setBalances(null), [address]);

  useEffect(() => {
    if (view.name !== "home" || tab !== "wallet") return;
    let live = true;
    void saving.current.then(() => run({ type: "balances" })).then((r) => {
      if (live && r) {
        setBalances(r.balances);
        setFilter(r.filter);
        setPrices(r.prices);
        setEvmDown(r.evmDown === true);
      }
    });
    return () => {
      live = false;
    };
  }, [view.name, tab, refresh, status.network, address]);

  const home = () => {
    setRefresh((n) => n + 1);
    setTab("wallet");
    setView({ name: "home" });
  };
  const tabs = (
    <TabBar
      tab={tab}
      onTab={(t) => {
        if (t === "wallet" && tab !== "wallet") setRefresh((n) => n + 1);
        setTab(t);
      }}
    />
  );
  /** Apply a filter change now; put it back if the host refuses it. */
  const changeFilter = (next: TokenFilter) => {
    const before = filter;
    setFilter(next);
    saving.current = saving.current
      .then(() => backend.send({ type: "save_token_filter", filter: next }))
      .then((r) => {
        if (!r.ok) {
          setFilter(before);
          setError(r.error.message);
        }
      });
  };
  /** Add a token by contract; null when it worked, else what went wrong. */
  const addToken = async (contract: string): Promise<string | null> => {
    await saving.current;
    const r = await backend.send({ type: "add_token", address: contract });
    if (!r.ok) return r.error.message;
    setFilter(r.result.filter);
    const b = await backend.send({ type: "balances" });
    if (b.ok) {
      setBalances(b.result.balances);
      setFilter(b.result.filter);
      setEvmDown(b.result.evmDown === true);
    }
    return null;
  };
  const sorted = balances ? applyFilter(balances, filter, NETWORKS[status.network].feeDenom) : null;
  const totalUsd = sorted?.totalUsd;

  switch (view.name) {
    case "accounts":
      return <AccountsView status={status} onStatus={(s) => onStatus(s)} onBack={home} />;
    case "receive":
      return <Receive addresses={account?.addresses ?? {}} onBack={home} />;
    case "tokens":
      return (
        <TokensView
          balances={balances ?? []}
          filter={filter}
          network={status.network}
          prices={prices}
          onChange={changeFilter}
          onAdd={addToken}
          onBack={() => setView({ name: "home" })}
        />
      );
    case "token": {
      const t = balances?.find((b) => b.denom === view.denom);
      if (!t) return null;
      return (
        <TokenView
          token={t}
          feeDenom={NETWORKS[status.network].feeDenom}
          canSign={!watch}
          onSend={() => setView({ name: "send", denom: t.denom })}
          onConvert={() => setView({ name: "convert", denom: t.denom })}
          onBack={home}
        />
      );
    }
    case "send":
      return (
        <SendForm
          balances={sorted?.shown ?? []}
          denom={view.denom}
          onReview={(review, entered, denom) => setView({ name: "review", review, entered, back: { name: "send", denom } })}
          onBack={home}
        />
      );
    case "convert": {
      const t = balances?.find((b) => b.denom === view.denom);
      if (!t) return null;
      return (
        <ConvertForm
          token={t}
          onReview={(review) => setView({ name: "review", review, entered: "", back: { name: "convert", denom: t.denom } })}
          onBack={() => setView({ name: "token", denom: t.denom })}
        />
      );
    }
    case "review":
      return (
        <Review
          review={view.review}
          entered={view.entered}
          network={status.network}
          onSent={(sent) => {
            const back = view.back;
            // What a conversion makes is what the user asked for: show it, like a token added by hand.
            const made = back.name === "convert" ? balances?.find((b) => b.denom === back.denom)?.convertsTo : undefined;
            if (made && !filter.shown.includes(made)) changeFilter({ ...filter, shown: [...filter.shown, made], hidden: filter.hidden.filter((x) => x !== made) });
            setView({ name: "sent", sent, converting: back.name === "convert" });
          }}
          onCancel={() => setView(view.back)}
        />
      );
    case "sent":
      return <SentView sent={view.sent} onDone={home} converting={view.converting} />;
    case "home": {
      if (tab === "activity") return <ActivityView key={address} network={status.network} tabs={tabs} />;
      if (tab === "settings") {
        return (
          <SettingsView
            status={status}
            onStatus={(s) => onStatus(s)}
            tabs={tabs}
            onLock={onLock}
            onDone={() => {
              onStatus();
              home();
            }}
          />
        );
      }
      const inj = balances?.find((b) => b.denom === "inj");
      return (
        <Screen
          tabs={tabs}
          top={
            <>
              <span className="brand">
                <img src={mark} alt="" />
              </span>
              <button className="title account-switch" aria-label={`Account: ${account?.name ?? ""}. Switch accounts`} onClick={() => setView({ name: "accounts" })}>
                <span className="account-name">{account?.name}</span>
                <ChevronDownIcon size={16} />
              </button>
              <button className="pill" onClick={() => setTab("settings")} aria-label={`Network: ${status.network}`}>
                <span className={status.network === "testnet" ? "dot testnet" : "dot"} />
                {status.network === "testnet" ? "Testnet" : "Mainnet"}
              </button>
              <button className="icon-btn" aria-label="Lock" onClick={onLock}>
                <LockIcon />
              </button>
            </>
          }
        >
          <div className="plate-warm">
            {/* The USD total when Choice can price something here; otherwise the INJ balance. */}
            <div className="eyebrow">
              {totalUsd === undefined ? "INJ balance" : "Total"}
              {watch && <span className="flag quiet">Watch-only</span>}
            </div>
            {balances === null ? (
              <div className="skeleton" style={{ width: 140, height: 36, margin: "6px 0 4px" }} />
            ) : totalUsd === undefined ? (
              <div className="hero" style={{ margin: "4px 0 2px" }}>
                {formatShort(inj?.amount ?? "0", 18, 4)}
                <span className="unit">INJ</span>
              </div>
            ) : (
              <>
                <div className="hero" style={{ margin: "4px 0 0" }}>
                  {formatUsd(totalUsd)}
                </div>
                <div className="meta num" style={{ marginBottom: 8 }}>
                  {formatShort(inj?.amount ?? "0", 18, 4)} INJ
                </div>
              </>
            )}
            <CopyPill address={address} />
            <div className="actions" style={{ marginTop: 14 }}>
              <button className="action" disabled={watch || !sorted?.shown.length} onClick={() => setView({ name: "send" })}>
                <SendIcon /> Send
              </button>
              <button className="action plain" onClick={() => setView({ name: "receive" })}>
                <ReceiveIcon /> Receive
              </button>
            </div>
          </div>

          <div className="section-head">
            <span className="eyebrow">Tokens{sorted?.shown.length ? ` · ${sorted.shown.length}` : ""}</span>
            {balances !== null && balances.length > 0 && (
              <button className="link" onClick={() => setView({ name: "tokens" })}>
                Manage
              </button>
            )}
          </div>
          {error && <Callout level="amber">{error}</Callout>}
          {sorted === null ? (
            !error && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)
          ) : sorted.shown.length === 0 && sorted.hidden.length === 0 ? (
            <p className="empty">No tokens yet. Use Receive to get your address.</p>
          ) : (
            <div className="token-list">
              {sorted.shown.map((b) => (
                <button
                  key={b.denom}
                  className="token"
                  title={b.denom}
                  onClick={() => setView({ name: "token", denom: b.denom })}
                >
                  <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
                  <span className="name">
                    <span className="symbol">{b.symbol}</span>
                    <span className={b.known ? "sub" : "sub denom"}>{tokenSub(b)}</span>
                  </span>
                  <span className="value">
                    <span className="amount">{formatShort(b.amount, b.decimals)}</span>
                    {b.usd !== undefined && <span className="usd">{formatUsd(b.usd)}</span>}
                  </span>
                </button>
              ))}
              {sorted.hidden.length > 0 && (
                <button className="hidden-row" onClick={() => setView({ name: "tokens" })}>
                  <EyeOffIcon size={16} />
                  {sorted.hidden.length} hidden {sorted.hidden.length === 1 ? "token" : "tokens"}
                  <ChevronRightIcon size={16} />
                </button>
              )}
            </div>
          )}
          {evmDown && <p className="meta warn">EVM tokens may be missing: no EVM endpoint answered.</p>}
          <p className="footnote">{totalUsd === undefined ? "Pre-alpha. Not for real funds." : "Prices from Choice. Pre-alpha. Not for real funds."}</p>
        </Screen>
      );
    }
  }
}

function CopyPill({ address }: { address: string }) {
  const backend = useBackend();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="pill"
      title={address}
      aria-label="Copy address"
      onClick={() =>
        void backend.copy(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <span className="mono" style={{ fontSize: 12 }}>
        {shortAddress(address)}
      </span>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

function Receive({ addresses, onBack }: { addresses: Record<string, string>; onBack: () => void }) {
  const backend = useBackend();
  const [side, setSide] = useState<"cosmos" | "evm">("cosmos");
  const [copied, setCopied] = useState(false);
  const address = (side === "cosmos" ? addresses[COSMOS] : addresses[EVM]) ?? "";
  return (
    <Screen
      top={<BackBar title="Receive" onBack={onBack} />}
      foot={
        <button
          className="btn btn-gold"
          onClick={() =>
            void backend.copy(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy address"}
        </button>
      }
    >
      <Segmented
        label="Address format"
        options={[
          ["cosmos", "Injective"],
          ["evm", "EVM (0x)"],
        ]}
        value={side}
        onChange={(v) => {
          setSide(v);
          setCopied(false);
        }}
      />
      <div className="surface-hero">
        <div className="eyebrow">{side === "cosmos" ? "Injective address" : "EVM address"}</div>
        {address && (
          <div className="qr-frame">
            <QrCode text={address} />
          </div>
        )}
        <div className="well">
          <code className="mono address" style={{ fontSize: 15, lineHeight: "22px" }}>
            {address}
          </code>
        </div>
      </div>
      <p className="lead">Both addresses are the same account.</p>
    </Screen>
  );
}

