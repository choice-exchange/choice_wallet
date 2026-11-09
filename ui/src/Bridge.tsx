// Bridge: native USDC from Injective to another chain, over Circle's CCTP. Circle delivers
// it there and keeps its fee out of it (the most is shown before signing). On an EVM chain it
// arrives at this account's own address unless another is given (the same key, so the same
// address); on Solana at a wallet's USDC account, which Circle opens if there is none. Like
// a swap, a first transfer needs an approval for its amount.

import { formatShort, formatUnits, parseUnits } from "@choice-wallet/chain";
import { useEffect, useRef, useState } from "react";

import { useBackend } from "./backend";
import { ArrowDownIcon, ChevronDownIcon } from "./icons";
import { useKept } from "./kept";
import { BackBar, Callout, Screen, Segmented, shortAddress } from "./kit";
import type { BridgeChain, BridgeQuote, BridgeStepInfo, Coin, NetworkId, SendReview, TokenInfo } from "./protocol";
import { useRequest } from "./request";
import type { BridgeLine } from "./review";
import { Figure } from "./Send";

/** What the user has typed, kept while they review and come back. */
export type BridgeDraft = { chain: string; amount: string; max: boolean; other: boolean; recipient: string };

export const newBridgeDraft = (): BridgeDraft => ({ chain: "", amount: "", max: false, other: false, recipient: "" });

/** A quote this old is asked for again before review (the host re-asks Circle at two minutes). */
const FRESH_MS = 60_000;
const USDC_DECIMALS = 6;

/** A round tile with a chain's first letters: the wallet ships no chain logos. */
export function ChainTile({ name, small }: { name: string; small?: boolean }) {
  const letters = name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean);
  const text = (letters.length > 1 ? letters[0]![0]! + letters[1]![0]! : name.slice(0, 2)).toUpperCase();
  return (
    <span className={small ? "nft-tile chain-tile small" : "nft-tile chain-tile"} aria-hidden="true">
      {text}
    </span>
  );
}

export function BridgeView({
  network,
  canSign,
  draft,
  onDraft,
  onReview,
  onBack,
  note,
}: {
  network: NetworkId;
  canSign: boolean;
  draft: BridgeDraft;
  onDraft: (d: BridgeDraft) => void;
  onReview: (review: SendReview, quote: BridgeQuote) => void;
  onBack: () => void;
  /** Why the user is back here, if a transfer stopped part way. */
  note?: string | null;
}) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const routes = useKept({ type: "bridge_routes" });
  const r = routes.value;
  const [picking, setPicking] = useState(false);
  const [quote, setQuote] = useState<{ q: BridgeQuote; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const asked = useRef(0);
  const set = (p: Partial<BridgeDraft>) => onDraft({ ...draft, ...p });

  const chain = r?.chains.find((c) => c.key === draft.chain);
  const balance = BigInt(r?.balance ?? "0");
  const evm = chain?.kind === "evm";
  const recipient = chain ? (evm && !draft.other ? (r?.address ?? "") : draft.recipient.trim()) : "";
  let amount: string | null = null;
  let problem: string | null = null;
  if (draft.max) amount = balance > 0n ? "max" : null;
  else if (draft.amount.trim()) {
    try {
      const v = parseUnits(draft.amount, USDC_DECIMALS);
      if (v === 0n) problem = "Enter an amount above zero.";
      else if (v > balance) problem = "That's more USDC than you have.";
      else amount = v.toString();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  // Ask Circle once the form is complete, after the typing stops.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!chain || !amount || !recipient) return;
    const n = ++asked.current;
    setQuoting(true);
    const t = setTimeout(() => {
      void backend
        .send({ type: "bridge_quote", to: chain.key, amount, recipient })
        .then((x) => {
          if (n !== asked.current) return;
          if (x.ok) setQuote({ q: x.result, at: Date.now() });
          else setQuoteError(x.error.message);
        })
        .catch(() => n === asked.current && setQuoteError("The wallet didn't answer. Try again."))
        .finally(() => n === asked.current && setQuoting(false));
    }, 450);
    return () => clearTimeout(t);
  }, [chain?.key, amount, recipient]);

  async function review() {
    if (!chain || !amount || !recipient) return;
    let q = quote?.q;
    // An old quote is asked for again first: the review must show today's fee.
    if (!q || Date.now() - (quote?.at ?? 0) > FRESH_MS) {
      const fresh = await run({ type: "bridge_quote", to: chain.key, amount, recipient });
      if (!fresh) return;
      setQuote({ q: fresh, at: Date.now() });
      q = fresh;
    }
    const x = await run({ type: "prepare_bridge", quote: q.id });
    if (x) onReview(x, q);
  }

  if (picking && r) {
    return (
      <ChainPicker
        chains={r.chains}
        onPick={(c) => {
          set({ chain: c.key, recipient: c.kind === (chain?.kind ?? c.kind) ? draft.recipient : "", other: c.kind === "solana" ? true : draft.other && chain?.kind === "evm" });
          setPicking(false);
        }}
        onBack={() => setPicking(false)}
      />
    );
  }

  const q = quote?.q;
  const usdc = (v: string) => `${formatShort(v, USDC_DECIMALS, 6)} USDC`;
  return (
    <Screen
      top={<BackBar title="Bridge USDC" onBack={onBack} />}
      foot={
        <>
          {error && <Callout level="amber">{error}</Callout>}
          <button className="btn btn-gold" disabled={!canSign || !q || busy || quoting} onClick={() => void review()}>
            {!canSign ? "Watch-only" : busy ? "Checking…" : q && q.steps.length > 1 ? "Review (2 steps)" : "Review transfer"}
          </button>
        </>
      }
    >
      {note && <Callout level="amber">{note}</Callout>}
      {routes.error && <Callout level="amber">{routes.error}</Callout>}
      <div className="surface-hero">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">From Injective</span>
          <span className="meta num">Balance {formatUnits(r?.balance ?? "0", USDC_DECIMALS)} USDC</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <input
            className="amount-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            aria-label="Amount of USDC"
            value={draft.max ? "Max" : draft.amount}
            disabled={draft.max}
            onChange={(e) => set({ amount: e.target.value })}
          />
          <button type="button" className={draft.max ? "pill pill-gold" : "pill"} onClick={() => set({ max: !draft.max })} disabled={balance === 0n}>
            {draft.max ? "Clear" : "Max"}
          </button>
        </div>
        <div className="convert-arrow" aria-hidden="true">
          <ArrowDownIcon size={18} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">To</span>
          <button type="button" className="token-chip" onClick={() => setPicking(true)} aria-label="Choose the chain" disabled={!r}>
            {chain && <ChainTile name={chain.name} small />}
            {chain ? chain.name : "Pick a chain"}
            <ChevronDownIcon size={16} />
          </button>
        </div>
        <div className="hero num" style={{ marginTop: 10, minHeight: 36, fontSize: 28 }}>
          {quoting ? (
            <span className="skeleton" style={{ display: "inline-block", width: 120, height: 28 }} />
          ) : q ? (
            <>
              ≈ {formatShort(q.minReceived, USDC_DECIMALS, 6)}
              <span className="unit">USDC</span>
            </>
          ) : (
            ""
          )}
        </div>
      </div>
      {chain && evm && (
        <Segmented
          label="Who receives it"
          options={[
            ["mine", "My address"],
            ["other", "Another address"],
          ]}
          value={draft.other ? "other" : "mine"}
          onChange={(v) => set({ other: v === "other" })}
        />
      )}
      {chain && evm && !draft.other && <p className="meta">To {shortAddress(r?.address ?? "")} on {chain.name}: the same address as here.</p>}
      {chain && (!evm || draft.other) && (
        <input
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={evm ? `0x address on ${chain.name}` : "Solana wallet address"}
          aria-label={evm ? `Address on ${chain.name}` : "Solana wallet address"}
          value={draft.recipient}
          onChange={(e) => set({ recipient: e.target.value })}
        />
      )}
      {problem && <p className="error">{problem}</p>}
      {quoteError && <Callout level="amber">{quoteError}</Callout>}
      {q && chain && (
        <div className="well rows">
          <div className="row">
            <span>Arrives</span>
            <span className="num">At least {usdc(q.minReceived)}</span>
          </div>
          <div className="row">
            <span>Circle&apos;s fee</span>
            <span className="num">Up to {usdc(q.maxFee)}</span>
          </div>
          {q.recipientSetup && (
            <div className="row">
              <span>Also</span>
              <span>Circle opens its USDC account</span>
            </div>
          )}
          <div className="row">
            <span>Time</span>
            <span>Usually under a minute</span>
          </div>
          {q.steps.length > 1 && (
            <div className="row">
              <span>First</span>
              <span>One approval, for this amount only</span>
            </div>
          )}
        </div>
      )}
      <p className="footnote">Native USDC over Circle&apos;s CCTP. Circle delivers it.</p>
    </Screen>
  );
}

function ChainPicker({ chains, onPick, onBack }: { chains: BridgeChain[]; onPick: (c: BridgeChain) => void; onBack: () => void }) {
  return (
    <Screen top={<BackBar title="Bridge to" onBack={onBack} />}>
      <div className="token-list">
        {chains.map((c) => (
          <button key={c.key} className="token" onClick={() => onPick(c)}>
            <ChainTile name={c.name} />
            <span className="name">
              <span className="symbol">{c.name}</span>
              <span className="sub">{c.kind === "solana" ? "To a Solana wallet" : "To a 0x address"}</span>
            </span>
          </button>
        ))}
      </div>
    </Screen>
  );
}

/** The review's card for a burn, from the vault's reading; `info` is what the quote said. */
export function BridgeCard({ line, tokens, info, from }: { line: BridgeLine; tokens: Record<string, TokenInfo>; info?: BridgeStepInfo; from: string }) {
  const t = tokens[line.coin.denom];
  const fee = (c: Coin) => (t ? `${formatShort(c.amount, t.decimals, 6)} ${t.symbol}` : c.amount);
  const least: Coin = { denom: line.coin.denom, amount: (BigInt(line.coin.amount) - BigInt(line.maxFee.amount)).toString() };
  const own = line.recipient !== null && line.recipient.toLowerCase() === from.toLowerCase();
  const chain = line.chain ?? "an unknown chain";
  // Solana: the burn names a USDC account. The wallet it belongs to is in the burn when Circle
  // opens it; otherwise it is the one the quote was for (the host checked the account is its).
  const solana = line.recipient !== null && !line.recipient.startsWith("0x");
  const wallet = line.owner ?? (solana && info ? info.recipient : null);
  return (
    <div className="surface-hero">
      <div className="eyebrow">You bridge</div>
      <Figure coin={line.coin} t={t} />
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="eyebrow">To {chain}</div>
      <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: "21px" }}>
        {wallet ?? line.recipient ?? "No usable address"}
      </code>
      {own && <div className="meta" style={{ marginTop: 4 }}>Your own address there.</div>}
      {solana && wallet && (
        <div className="meta" style={{ marginTop: 4, wordBreak: "break-all" }}>
          Into its USDC account {shortAddress(line.recipient!)}{line.owner ? ", which Circle opens." : "."}
        </div>
      )}
      {solana && !wallet && <div className="meta" style={{ marginTop: 4 }}>A Solana USDC account.</div>}
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="rows">
        <div className="row">
          <span>Arrives</span>
          <span className="num">At least {fee(least)}</span>
        </div>
        <div className="row">
          <span>Circle&apos;s fee</span>
          <span className="num">Up to {fee(line.maxFee)}</span>
        </div>
        <div className="row">
          <span>Delivered by</span>
          <span>{line.delivery === "circle" ? (line.caller ? "Only " + shortAddress(line.caller) : "Circle") : line.delivery === "claim" ? "Whoever claims it" : "A contract there"}</span>
        </div>
      </div>
    </div>
  );
}
