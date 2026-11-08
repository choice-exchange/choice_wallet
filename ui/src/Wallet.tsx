// The unlocked wallet: home (balance and tokens), receive, send, tokens and settings.

import { formatShort, NETWORKS, shortDenom } from "@choice-wallet/chain";
import { useEffect, useRef, useState } from "react";

import mark from "./assets/choice-mark.svg";
import { useBackend } from "./backend";
import { CheckIcon, ChevronRightIcon, CopyIcon, EyeOffIcon, LockIcon, ReceiveIcon, SendIcon, SettingsIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, Segmented, shortAddress } from "./kit";
import type { Balance, SendReview, Sent, Status, TokenFilter } from "./protocol";
import { QrCode } from "./QrCode";
import { useRequest } from "./request";
import { Review, SendForm, SentView } from "./Send";
import { SettingsView } from "./Settings";
import { applyFilter, DEFAULT_FILTER } from "./tokenFilter";
import { TokenMark } from "./TokenMark";
import { TokensView } from "./Tokens";

type View =
  | { name: "home" }
  | { name: "receive" }
  | { name: "send"; denom?: string }
  | { name: "review"; review: SendReview; entered: string; denom: string }
  | { name: "sent"; sent: Sent }
  | { name: "tokens" }
  | { name: "settings" };

const COSMOS = "cosmos:injective-1";
const EVM = "eip155:1776";

export function Wallet({ status, onLock, onStatus }: { status: Status; onLock: () => void; onStatus: () => void }) {
  const backend = useBackend();
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [filter, setFilter] = useState<TokenFilter>(DEFAULT_FILTER);
  const [prices, setPrices] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const { run, error, setError } = useRequest();

  // The last filter save, so a refresh never reads the filter before it lands.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (view.name !== "home") return;
    let live = true;
    void saving.current.then(() => run({ type: "balances" })).then((r) => {
      if (live && r) {
        setBalances(r.balances);
        setFilter(r.filter);
        setPrices(r.prices);
      }
    });
    return () => {
      live = false;
    };
  }, [view.name, refresh, status.network]);

  const home = () => {
    setRefresh((n) => n + 1);
    setView({ name: "home" });
  };
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
  const account = status.accounts[0];
  const address = account?.addresses[COSMOS] ?? "";
  const sorted = balances ? applyFilter(balances, filter, NETWORKS[status.network].feeDenom) : null;
  const totalUsd = sorted?.totalUsd;

  switch (view.name) {
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
          onBack={() => setView({ name: "home" })}
        />
      );
    case "send":
      return (
        <SendForm
          balances={sorted?.shown ?? []}
          denom={view.denom}
          onReview={(review, entered, denom) => setView({ name: "review", review, entered, denom })}
          onBack={home}
        />
      );
    case "review":
      return (
        <Review
          review={view.review}
          entered={view.entered}
          network={status.network}
          onSent={(sent) => setView({ name: "sent", sent })}
          onCancel={() => setView({ name: "send", denom: view.denom })}
        />
      );
    case "sent":
      return <SentView sent={view.sent} onDone={home} />;
    case "settings":
      return (
        <SettingsView
          onLock={onLock}
          onDone={() => {
            onStatus();
            home();
          }}
        />
      );
    case "home": {
      const inj = balances?.find((b) => b.denom === "inj");
      return (
        <Screen
          top={
            <>
              <span className="brand">
                <img src={mark} alt="" />
              </span>
              <span className="title">Account 1</span>
              <button className="pill" onClick={() => setView({ name: "settings" })} aria-label={`Network: ${status.network}`}>
                <span className={status.network === "testnet" ? "dot testnet" : "dot"} />
                {status.network === "testnet" ? "Testnet" : "Mainnet"}
              </button>
              <button className="icon-btn" aria-label="Settings" onClick={() => setView({ name: "settings" })}>
                <SettingsIcon />
              </button>
              <button className="icon-btn" aria-label="Lock" onClick={onLock}>
                <LockIcon />
              </button>
            </>
          }
        >
          <div className="plate-warm">
            {/* The USD total when Choice can price something here; otherwise the INJ balance. */}
            <div className="eyebrow">{totalUsd === undefined ? "INJ balance" : "Total"}</div>
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
              <button className="action" disabled={!sorted?.shown.length} onClick={() => setView({ name: "send" })}>
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
                <button key={b.denom} className="token" title={b.denom} onClick={() => setView({ name: "send", denom: b.denom })}>
                  <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
                  <span className="name">
                    <span className="symbol">{b.symbol}</span>
                    <span className={b.known ? "sub" : "sub denom"}>{b.known ? b.name : shortDenom(b.denom)}</span>
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

