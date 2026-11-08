// Send: the form (with its token picker), the review, and the sent screen.

import { cw20Address, evmAddress, formatShort, formatUnits, parseUnits, shortDenom, usdValue } from "@choice-wallet/chain";
import { useEffect, useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { ArrowDownIcon, CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, ExternalIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, shortAddress, tokenSub } from "./kit";
import type { Balance, Coin, NetworkId, SendReview, Sent, TokenInfo, TxState } from "./protocol";
import { useRequest } from "./request";
import { shown } from "./review";
import { TokenMark } from "./TokenMark";

/** An amount typed into a form: base units (or "max"), or what's wrong with it. */
export function parseEntered(amount: string, max: boolean, token: Balance): { parsed: string | null; problem: string | null } {
  if (max) return { parsed: "max", problem: null };
  if (!amount.trim()) return { parsed: null, problem: null };
  try {
    const v = parseUnits(amount, token.decimals);
    if (v === 0n) return { parsed: null, problem: "Enter an amount above zero." };
    if (v > BigInt(token.amount)) return { parsed: null, problem: `That's more ${token.symbol} than you have.` };
    return { parsed: v.toString(), problem: null };
  } catch (e) {
    return { parsed: null, problem: e instanceof Error ? e.message : String(e) };
  }
}

export function SendForm({
  balances,
  denom: initial,
  onReview,
  onBack,
}: {
  balances: Balance[];
  denom?: string | undefined;
  onReview: (review: SendReview, entered: string, denom: string) => void;
  onBack: () => void;
}) {
  const [denom, setDenom] = useState(initial ?? balances[0]?.denom ?? "");
  const [picking, setPicking] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const { run, error, busy } = useRequest();
  const token = balances.find((b) => b.denom === denom);

  if (picking || !token) {
    return (
      <Screen top={<BackBar title="Choose a token" onBack={() => (token ? setPicking(false) : onBack())} />}>
        {balances.length === 0 && <p className="empty">Nothing to send yet.</p>}
        <div className="token-list">
          {balances.map((b) => (
            <button
              key={b.denom}
              className="token"
              onClick={() => {
                setDenom(b.denom);
                setMax(false);
                setPicking(false);
              }}
            >
              <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
              <span className="name">
                <span className="symbol">{b.symbol}</span>
                <span className={b.known ? "sub" : "sub denom"}>{tokenSub(b)}</span>
              </span>
              <span className="amount">{formatShort(b.amount, b.decimals)}</span>
            </button>
          ))}
        </div>
      </Screen>
    );
  }

  const { parsed, problem } = parseEntered(amount, max, token);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed || !token) return;
    const entered = to.trim();
    const review = await run({ type: "prepare_send", denom: token.denom, to: entered, amount: parsed });
    if (review) onReview(review, entered, token.denom);
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title="Send" onBack={onBack} />}
        foot={
          <>
            {error && <Callout level="amber">{error}</Callout>}
            <button className="btn btn-gold" type="submit" disabled={!parsed || !to.trim() || busy}>
              {busy ? "Checking…" : "Review"}
            </button>
          </>
        }
      >
        <div className="surface-hero">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="eyebrow">Amount</span>
            <button type="button" className="token-chip" onClick={() => setPicking(true)} aria-label="Choose a token">
              <TokenMark denom={token.denom} symbol={token.symbol} known={token.known} small />
              {token.symbol}
              <ChevronDownIcon size={16} />
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <input
              className="amount-input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              aria-label="Amount"
              value={max ? "Max" : amount}
              disabled={max}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className={max ? "pill pill-gold" : "pill"} onClick={() => setMax(!max)}>
              {max ? "Clear" : "Max"}
            </button>
          </div>
          <div className="meta" style={{ marginTop: 6 }}>
            Balance {formatUnits(token.amount, token.decimals)} {token.symbol}
          </div>
          {!token.known && <div className="meta mono" style={{ marginTop: 4 }}>{token.denom}</div>}
        </div>
        {problem && <p className="error">{problem}</p>}
        <label className="field">
          <span className="eyebrow">To</span>
          <input
            className="input mono"
            placeholder="inj1… or 0x…"
            autoComplete="off"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </Screen>
    </form>
  );
}

/** The approval screen. Everything on it comes from the vault's decode of the transaction
 *  that will be signed, not from what the form asked for. */
/** What a token is, in a word or two, for a review: an unlisted token's symbol is
 *  whatever its creator chose, so its contract or denom goes with it. */
export function realName(denom: string, t: TokenInfo | undefined): string | null {
  if (t?.known) return null;
  const evm = evmAddress(denom);
  if (evm) return `EVM token ${evm}`;
  const cw20 = cw20Address(denom);
  return cw20 ? `CW20 ${cw20}` : denom;
}

/** One amount, in full (never rounded), with its token. The type steps down as it gets longer. */
export function Figure({ coin, t }: { coin: Coin; t: TokenInfo | undefined }) {
  const figure = t ? formatUnits(coin.amount, t.decimals) : coin.amount;
  const size = figure.length > 16 ? 18 : figure.length > 10 ? 22 : 28;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
      <TokenMark denom={coin.denom} symbol={t?.symbol ?? coin.denom} known={t?.known ?? false} />
      <span className="hero" style={{ fontSize: size, lineHeight: `${size + 6}px`, wordBreak: "break-all" }}>
        {figure} <span className="unit">{t?.symbol ?? shortDenom(coin.denom)}</span>
      </span>
    </div>
  );
}

/** Which form a token is in, for a conversion. */
export const formName = (denom: string) => (cw20Address(denom) ? "CW20" : "Bank token");

export function Review({
  review,
  entered,
  network,
  onSent,
  onCancel,
}: {
  review: SendReview;
  entered: string;
  network: NetworkId;
  onSent: (sent: Sent) => void;
  onCancel: () => void;
}) {
  const { risk, tokens } = review;
  const view = shown(review.display, network);
  const converting = view.converts.length > 0 && view.sends.length === 0;
  const [typed, setTyped] = useState("");
  const { run, error, busy } = useRequest();
  const coin = (c: Coin) => {
    const t = tokens[c.denom];
    return t ? `${formatUnits(c.amount, t.decimals)} ${t.symbol}` : `${c.amount} ${c.denom}`;
  };
  /** "≈ $1.23" for coins Choice can price, else nothing. */
  const usd = (cs: Coin[]) => {
    let v = 0;
    for (const c of cs) {
      const t = tokens[c.denom];
      if (!t?.priceUsd) return null;
      v += usdValue(c.amount, t.decimals, t.priceUsd);
    }
    return cs.length ? `≈ ${formatUsd(v)}` : null;
  };
  const blocked = risk.level === "blocked";
  const needsWord = risk.confirm !== undefined && typed.trim() !== risk.confirm;

  async function confirm() {
    const sent = await run({ type: "confirm_send", digest: review.digest, ...(risk.confirm ? { confirm: typed.trim() } : {}) });
    if (sent) onSent(sent);
  }

  return (
    <Screen
      top={<BackBar title={converting ? "Review conversion" : "Review send"} onBack={onCancel} />}
      foot={
        <>
          {error && <Callout level="red">{error}</Callout>}
          <button
            className={risk.level === "red" || blocked ? "btn btn-danger" : "btn btn-gold"}
            disabled={busy || blocked || needsWord}
            onClick={() => void confirm()}
          >
            {converting ? (busy ? "Converting…" : "Confirm and convert") : busy ? "Sending…" : "Confirm and send"}
          </button>
          <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      }
    >
      {/* What the risk rules found comes first: it must never sit below the fold. */}
      {risk.findings.map((f, i) => (
        <Callout key={i} level={f.level}>
          {f.message}
        </Callout>
      ))}
      {view.sends.map((m, i) => (
        <div className="surface-hero" key={i}>
          <div className="eyebrow">You send</div>
          {m.coins.map((c) => (
            <Figure key={c.denom} coin={c} t={tokens[c.denom]} />
          ))}
          {usd(m.coins) && <div className="meta num" style={{ marginTop: 4, marginLeft: 46 }}>{usd(m.coins)}</div>}
          {m.coins.map((c) => {
            const real = realName(c.denom, tokens[c.denom]);
            return (
              real && (
                <div key={c.denom} className="meta mono" style={{ marginTop: 4, marginLeft: 46, wordBreak: "break-all" }}>
                  {real}
                </div>
              )
            );
          })}
          <hr className="divider" style={{ margin: "14px 0 12px" }} />
          <div className="eyebrow">To</div>
          <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: "21px" }}>
            {m.to}
          </code>
          {entered.toLowerCase() !== m.to.toLowerCase() && (
            <div className="meta" style={{ marginTop: 4, wordBreak: "break-all" }}>
              You entered {entered}
            </div>
          )}
        </div>
      ))}
      {view.converts.map((cv, i) => (
        <div className="surface-hero" key={`c${i}`}>
          <div className="eyebrow">You convert · {formName(cv.from.denom)}</div>
          <Figure coin={cv.from} t={tokens[cv.from.denom]} />
          {realName(cv.from.denom, tokens[cv.from.denom]) && (
            <div className="meta mono" style={{ marginTop: 4, marginLeft: 46, wordBreak: "break-all" }}>
              {realName(cv.from.denom, tokens[cv.from.denom])}
            </div>
          )}
          <div className="convert-arrow" aria-hidden="true">
            <ArrowDownIcon size={18} />
          </div>
          <div className="eyebrow">You get · {formName(cv.to.denom)}</div>
          <Figure coin={cv.to} t={tokens[cv.to.denom]} />
          {usd([cv.to]) && <div className="meta num" style={{ marginTop: 4, marginLeft: 46 }}>{usd([cv.to])}</div>}
          {cv.recipient !== (review.display as { signer?: string }).signer && (
            <div className="meta" style={{ marginTop: 8, wordBreak: "break-all" }}>
              Delivered to {cv.recipient}
            </div>
          )}
          <p className="meta" style={{ marginTop: 10 }}>
            Same token, other form, one for one. Through Injective&apos;s CW20 adapter.
          </p>
        </div>
      ))}
      {view.others.map((o, i) => (
        <div className="surface" key={`o${i}`}>
          <div className="eyebrow">Other message</div>
          <code className="mono">{o}</code>
        </div>
      ))}
      <div className="well rows">
        <div className="row">
          <span>Network fee</span>
          <span className="num">
            {view.fee.map(coin).join(" + ") || "None"}
            {usd(view.fee) && <span className="meta"> {usd(view.fee)}</span>}
          </span>
        </div>
        <div className="row">
          <span>Network</span>
          <span>
            {network === "testnet" ? "Injective testnet" : "Injective"}
            {view.evm ? " (EVM)" : ""}
          </span>
        </div>
        {view.memo && (
          <div className="row">
            <span>Memo</span>
            <span>{view.memo}</span>
          </div>
        )}
        <div className="row">
          <span>{view.evm ? "Estimated on" : "Simulated on"}</span>
          <span>{review.checkedBy}</span>
        </div>
      </div>
      {risk.confirm && (
        <label className="field">
          <span className="eyebrow">Type {risk.confirm} to continue</span>
          <input className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
    </Screen>
  );
}

const POLL_MS = 1500;
const POLL_TRIES = 40;

export function SentView({ sent, onDone, converting = false }: { sent: Sent; onDone: () => void; converting?: boolean }) {
  const backend = useBackend();
  const [state, setState] = useState<TxState | { state: "slow" }>({ state: "pending" });

  useEffect(() => {
    let live = true;
    let tries = 0;
    async function tick() {
      if (!live) return;
      try {
        const r = await backend.send({ type: "tx_status", hash: sent.hash });
        if (!live) return;
        if (r.ok && r.result.state !== "pending") {
          setState(r.result);
          return;
        }
      } catch {
        // Keep polling; the next try may get through.
      }
      if (++tries < POLL_TRIES) setTimeout(() => void tick(), POLL_MS);
      else setState({ state: "slow" });
    }
    void tick();
    return () => {
      live = false;
    };
  }, [sent.hash]);

  const s = state.state;
  const title = { pending: converting ? "Converting" : "Sending", slow: "Not confirmed yet", success: converting ? "Converted" : "Sent", failed: "Failed" }[s];
  const lead = {
    pending: "Waiting for the next block.",
    slow: "Check the explorer for its status.",
    success: "It's in a block.",
    failed: ("log" in state && state.log) || "The chain rejected it.",
  }[s];
  return (
    <Screen
      foot={
        <>
          <button className="btn" onClick={() => backend.openLink(sent.explorer)}>
            View on explorer <ExternalIcon size={16} />
          </button>
          <button className="btn btn-gold" onClick={onDone}>
            Done
          </button>
        </>
      }
    >
      <div className="status">
        <span className={`status-icon ${s}`}>
          {s === "success" && <CheckIcon size={30} />}
          {s === "failed" && <CloseIcon size={28} />}
          {s === "slow" && <ClockIcon size={28} />}
        </span>
        <h1 className="page-title">{title}</h1>
        <p className={s === "failed" ? "error" : "lead"}>{lead}</p>
        <code className="pill mono" title={sent.hash} data-hash={sent.hash}>
          {shortAddress(sent.hash)}
        </code>
      </div>
    </Screen>
  );
}
