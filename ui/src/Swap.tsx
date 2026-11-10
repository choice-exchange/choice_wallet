// Swap: one token for another through Choice, on Injective's EVM side. The quote is
// Choice's; the review shows the vault's own reading of the transaction, and the minimum
// in it is the only guarantee. A token that isn't INJ needs two approvals first, each for
// this swap's amount only; the flow walks through them.

import { formatShort, formatUnits, parseUnits } from "@choice-wallet/chain";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useBackend } from "./backend";
import { ArrowDownIcon, ChevronDownIcon } from "./icons";
import { useKept } from "./kept";
import { BackBar, Callout, Screen, Segmented, tokenSub } from "./kit";
import type { NetworkId, SendReview, SwapQuote, SwapToken } from "./protocol";
import { errorText, useRequest } from "./request";
import { TokenMark } from "./TokenMark";

/** What the user has typed, kept while they review and come back. */
export type SwapDraft = { from: string; to: string; amount: string; max: boolean; slippage: Slippage };

type Slippage = "10" | "50" | "100" | "300";
const SLIPPAGE: readonly (readonly [Slippage, string])[] = [
  ["10", "0.1%"],
  ["50", "0.5%"],
  ["100", "1%"],
  ["300", "3%"],
];
/** A quote this old is asked for again before review (the host refuses at two minutes). */
const FRESH_MS = 60_000;

const VENUES: Record<string, string> = { "pumex-v2": "Pumex V2", pumex: "Pumex", choice: "Choice", helix: "INJ orderbook" };
export const venueName = (v: string) => VENUES[v] ?? v;

export function newDraft(feeDenom: string): SwapDraft {
  return { from: feeDenom, to: "", amount: "", max: false, slippage: "50" };
}

export function SwapView({
  network,
  canSign,
  draft,
  onDraft,
  onReview,
  note,
  tabs,
}: {
  network: NetworkId;
  canSign: boolean;
  draft: SwapDraft;
  onDraft: (d: SwapDraft) => void;
  onReview: (review: SendReview, quote: SwapQuote) => void;
  /** Why the user is back here, if a swap stopped part way. */
  note?: string | null;
  tabs: ReactNode;
}) {
  const backend = useBackend();
  const { run, error, setError, busy } = useRequest();
  const tokens = useKept({ type: "swap_tokens" });
  const list = tokens.value;
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [quote, setQuote] = useState<{ q: SwapQuote; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const asked = useRef(0);
  const set = (p: Partial<SwapDraft>) => onDraft({ ...draft, ...p });

  useEffect(() => {
    if (tokens.error) setError(tokens.error);
  }, [tokens.error]);

  const from = list?.find((t) => t.denom === draft.from);
  const to = list?.find((t) => t.denom === draft.to);
  let amount: string | null = null;
  let problem: string | null = null;
  if (draft.max) amount = "max";
  else if (from && draft.amount.trim()) {
    try {
      const v = parseUnits(draft.amount, from.decimals);
      if (v === 0n) problem = "Enter an amount above zero.";
      else if (v > BigInt(from.amount ?? "0")) problem = `That's more ${from.symbol} than you have.`;
      else amount = v.toString();
    } catch (e) {
      problem = errorText(e);
    }
  }

  // Ask Choice once the form is complete, after the typing stops.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!from || !to || !amount) return;
    const n = ++asked.current;
    setQuoting(true);
    const t = setTimeout(() => {
      void backend
        .send({ type: "swap_quote", from: from.denom, to: to.denom, amount, slippageBps: Number(draft.slippage) })
        .then((r) => {
          if (n !== asked.current) return;
          if (r.ok) setQuote({ q: r.result, at: Date.now() });
          else setQuoteError(r.error.message);
        })
        .finally(() => n === asked.current && setQuoting(false));
    }, 450);
    return () => clearTimeout(t);
  }, [from?.denom, to?.denom, amount, draft.slippage]);

  async function review() {
    if (!from || !to || !amount) return;
    let q = quote?.q;
    // An old quote is asked for again first: the review must show today's minimum.
    if (!q || Date.now() - (quote?.at ?? 0) > FRESH_MS) {
      const fresh = await run({ type: "swap_quote", from: from.denom, to: to.denom, amount, slippageBps: Number(draft.slippage) });
      if (!fresh) return;
      setQuote({ q: fresh, at: Date.now() });
      q = fresh;
    }
    const r = await run({ type: "prepare_swap", quote: q.id });
    if (r) onReview(r, q);
  }

  if (picking) {
    return (
      <TokenPicker
        title={picking === "from" ? "Swap from" : "Swap to"}
        tokens={(list ?? []).filter((t) => (picking === "from" ? BigInt(t.amount ?? "0") > 0n : t.denom !== draft.from))}
        onPick={(d) => {
          if (picking === "from") set({ from: d, to: d === draft.to ? "" : draft.to, max: false, amount: "" });
          else set({ to: d });
          setPicking(null);
        }}
        onBack={() => setPicking(null)}
      />
    );
  }

  const q = quote?.q;
  const out = q && to ? formatShort(q.amountOut, to.decimals, 6) : "";
  const steps = q?.steps.filter((s) => s !== "swap").length ?? 0;
  return (
    <Screen
      tabs={tabs}
      top={<span className="title">Swap</span>}
      foot={
        <>
          {error && <Callout level="amber">{error}</Callout>}
          <button className="btn btn-gold" disabled={!canSign || !q || busy || quoting} onClick={() => void review()}>
            {!canSign ? "Watch-only" : busy ? "Checking…" : steps > 0 ? `Review (${steps + 1} steps)` : "Review swap"}
          </button>
        </>
      }
    >
      {note && <Callout level="amber">{note}</Callout>}
      <div className="surface-hero">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">You pay</span>
          <Chip token={from} placeholder="Pick a token" label="Choose the token to pay" onClick={() => setPicking("from")} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <input
            className="amount-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            aria-label="Amount to pay"
            value={draft.max ? "Max" : draft.amount}
            disabled={draft.max}
            onChange={(e) => set({ amount: e.target.value })}
          />
          <button type="button" className={draft.max ? "pill pill-gold" : "pill"} onClick={() => set({ max: !draft.max })} disabled={!from}>
            {draft.max ? "Clear" : "Max"}
          </button>
        </div>
        {from && (
          <div className="meta" style={{ marginTop: 6 }}>
            Balance {formatUnits(from.amount ?? "0", from.decimals)} {from.symbol}
            {draft.max && from.denom === "inj" ? ". Keeps 0.01 INJ for fees." : ""}
          </div>
        )}
        <div className="convert-arrow" aria-hidden="true">
          <ArrowDownIcon size={18} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">You get</span>
          <Chip token={to} placeholder="Pick a token" label="Choose the token to get" onClick={() => setPicking("to")} />
        </div>
        <div className="hero num" style={{ marginTop: 10, minHeight: 36, fontSize: out.length > 14 ? 22 : 28 }}>
          {quoting ? <span className="skeleton" style={{ display: "inline-block", width: 120, height: 28 }} /> : out ? `≈ ${out}` : ""}
        </div>
      </div>
      {problem && <p className="error">{problem}</p>}
      {quoteError && <Callout level="amber">{quoteError}</Callout>}
      {q && from && to && (
        <div className="well rows">
          <div className="row">
            <span>At least</span>
            <span className="num">
              {formatShort(q.minimumOut, to.decimals, 6)} {to.symbol}
            </span>
          </div>
          <div className="row">
            <span>Route</span>
            <span>{q.legs.map((l) => `${venueName(l.venue)}${l.portionBps < 10_000 ? ` ${l.portionBps / 100}%` : ""}`).join(", ") || "Choice"}</span>
          </div>
          <div className="row">
            <span>Choice fee</span>
            <span>{q.fee ? `${(q.fee.bps / 100).toFixed(2)}%` : "None"}</span>
          </div>
          {steps > 0 && (
            <div className="row">
              <span>First</span>
              <span>{steps === 2 ? "Two approvals, for this amount only" : "One approval, for this amount only"}</span>
            </div>
          )}
        </div>
      )}
      <div className="field">
        <span className="eyebrow">Slippage</span>
        <Segmented label="Slippage" options={SLIPPAGE} value={draft.slippage} onChange={(v) => set({ slippage: v })} />
      </div>
      <p className="footnote">Quotes and routes from Choice. Network: {network === "testnet" ? "Injective testnet" : "Injective"} (EVM).</p>
    </Screen>
  );
}

function Chip({ token, placeholder, label, onClick }: { token: SwapToken | undefined; placeholder: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="token-chip" onClick={onClick} aria-label={label}>
      {token ? <TokenMark denom={token.denom} symbol={token.symbol} known={token.known} small /> : null}
      {token ? token.symbol : placeholder}
      <ChevronDownIcon size={16} />
    </button>
  );
}

function TokenPicker({ title, tokens, onPick, onBack }: { title: string; tokens: SwapToken[]; onPick: (denom: string) => void; onBack: () => void }) {
  return (
    <Screen top={<BackBar title={title} onBack={onBack} />}>
      {tokens.length === 0 && <p className="empty">Nothing to swap here yet.</p>}
      <div className="token-list">
        {tokens.map((t) => (
          <button key={t.denom} className="token" title={t.denom} onClick={() => onPick(t.denom)}>
            <TokenMark denom={t.denom} symbol={t.symbol} known={t.known} />
            <span className="name">
              <span className="symbol">{t.symbol}</span>
              <span className={t.known ? "sub" : "sub denom"}>{tokenSub(t)}</span>
            </span>
            {t.amount !== undefined && <span className="amount">{formatShort(t.amount, t.decimals)}</span>}
          </button>
        ))}
      </div>
      <p className="footnote">Add a token by its contract in Wallet, Manage.</p>
    </Screen>
  );
}
