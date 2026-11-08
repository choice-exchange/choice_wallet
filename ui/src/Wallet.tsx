// The unlocked wallet: home (balance and tokens), receive, send and settings.

import { formatShort, shortDenom } from "@choice-wallet/chain";
import { useEffect, useState } from "react";

import mark from "./assets/choice-mark.svg";
import { useBackend } from "./backend";
import { CheckIcon, CopyIcon, LockIcon, ReceiveIcon, SendIcon, SettingsIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, Segmented, shortAddress } from "./kit";
import type { Balance, SendReview, Sent, Status } from "./protocol";
import { useRequest } from "./request";
import { Review, SendForm, SentView } from "./Send";
import { SettingsView } from "./Settings";
import { TokenMark } from "./TokenMark";

type View =
  | { name: "home" }
  | { name: "receive" }
  | { name: "send"; denom?: string }
  | { name: "review"; review: SendReview; entered: string; denom: string }
  | { name: "sent"; sent: Sent }
  | { name: "settings" };

const COSMOS = "cosmos:injective-1";
const EVM = "eip155:1776";

export function Wallet({ status, onLock, onStatus }: { status: Status; onLock: () => void; onStatus: () => void }) {
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [totalUsd, setTotalUsd] = useState<number | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const { run, error } = useRequest();

  useEffect(() => {
    if (view.name !== "home") return;
    let live = true;
    void run({ type: "balances" }).then((r) => {
      if (live && r) {
        setBalances(r.balances);
        setTotalUsd(r.totalUsd);
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
  const account = status.accounts[0];
  const address = account?.addresses[COSMOS] ?? "";

  switch (view.name) {
    case "receive":
      return <Receive addresses={account?.addresses ?? {}} onBack={home} />;
    case "send":
      return (
        <SendForm
          balances={balances ?? []}
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
              <button className="action" disabled={!balances?.length} onClick={() => setView({ name: "send" })}>
                <SendIcon /> Send
              </button>
              <button className="action plain" onClick={() => setView({ name: "receive" })}>
                <ReceiveIcon /> Receive
              </button>
            </div>
          </div>

          <div className="eyebrow" style={{ marginTop: 6 }}>
            Tokens{balances?.length ? ` · ${balances.length}` : ""}
          </div>
          {error && <Callout level="amber">{error}</Callout>}
          {balances === null ? (
            !error && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)
          ) : balances.length === 0 ? (
            <p className="empty">No tokens yet. Use Receive to get your address.</p>
          ) : (
            <div className="token-list">
              {balances.map((b) => (
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
        <div className="well" style={{ marginTop: 10 }}>
          <code className="mono address" style={{ fontSize: 15, lineHeight: "22px" }}>
            {address}
          </code>
        </div>
      </div>
      <p className="lead">Both addresses are the same account.</p>
    </Screen>
  );
}

