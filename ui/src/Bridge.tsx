// Bridge: native USDC between any two chains the wallet holds an account on, over Circle's
// CCTP. It starts on the chain picked on Home (or wherever the USDC is) and goes to Injective
// unless another chain is picked, at the account's own address there unless another is
// given (the same 0x on every EVM chain; its Solana key's address on Solana).
//
// Signed on the chain the USDC is on and paid for in its coin: an exact approval first where
// an EVM chain needs one, then the burn. Circle delivers where it forwards (opening a Solana
// wallet's USDC account if it has none). Into Injective, Choice's bridge service mints it, or
// Choice's contract when it also buys INJ for gas; where nobody delivers (Plasma), this
// account mints it itself, with gas there.

import { formatShort, formatUnits, parseUnits } from "@choice-wallet/chain";
import { useEffect, useRef, useState } from "react";

import { useBackend } from "./backend";
import { ChainMark } from "./Chains";
import { ArrowDownIcon, ChevronDownIcon } from "./icons";
import { useKept } from "./kept";
import { BackBar, Callout, Screen, Segmented, shortAddress, Switch } from "./kit";
import type { BridgeEnd, BridgePending, BridgeQuote, BridgeStatus, BridgeStepInfo, Coin, NetworkId, SendReview, TokenInfo } from "./protocol";
import { errorText, useRequest } from "./request";
import type { BridgeLine, MintLine } from "./review";
import { about, Figure } from "./Send";

/** What the user has typed, kept while they review and come back. `from` and `to` are chain
 *  keys (empty: not picked yet); `gasDrop` null is on when the account has no INJ. */
export type BridgeDraft = {
  from: string;
  to: string;
  amount: string;
  max: boolean;
  other: boolean;
  recipient: string;
  gasDrop: boolean | null;
};

export const newBridgeDraft = (): BridgeDraft => ({ from: "", to: "", amount: "", max: false, other: false, recipient: "", gasDrop: null });

type BridgeProps = {
  network: NetworkId;
  canSign: boolean;
  draft: BridgeDraft;
  onDraft: (d: BridgeDraft) => void;
  onReview: (review: SendReview, quote: string) => void;
  onBack: () => void;
  /** Why the user is back here, if a transfer stopped part way. */
  note?: string | null;
  /** Mint a transfer nobody has minted, from this account, on its destination. */
  onFinish: (from: string, hash: string) => void;
};

/** A quote this old is asked for again before review (the host re-asks Circle at two minutes). */
const FRESH_MS = 60_000;
const USDC_DECIMALS = 6;
/** Choice's bridge service gets this long to mint a transfer into Injective before this
 *  account is offered to. */
const RELAY_GRACE_MS = 3 * 60_000;

export function BridgeView({ network, canSign, draft, onDraft, onReview, onBack, note, onFinish }: BridgeProps) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const routes = useKept({ type: "bridge_routes" });
  const pending = useKept({ type: "bridge_pending" });
  /** Burns on Solana whose record's rent comes back to the account, 5 days on. */
  const rent = useKept({ type: "bridge_reclaims" });
  const r = routes.value;
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [quote, setQuote] = useState<{ q: BridgeQuote; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const asked = useRef(0);
  const set = (p: Partial<BridgeDraft>) => onDraft({ ...draft, ...p });

  // Start where the USDC is (unless a chain was picked), and go to Injective.
  useEffect(() => {
    if (!r) return;
    const usdcOf = (c: BridgeEnd) => (c.usdc ? BigInt(c.usdc) : 0n);
    const from = draft.from || ([...r.chains].filter((c) => c.address && usdcOf(c) > 0n).sort((a, b) => (usdcOf(b) > usdcOf(a) ? 1 : -1))[0]?.key ?? "injective");
    const to = draft.to && draft.to !== from ? draft.to : from !== "injective" ? "injective" : "";
    if (from !== draft.from || to !== draft.to) set({ from, to });
  }, [r]);

  const from = r?.chains.find((c) => c.key === draft.from);
  const to = r?.chains.find((c) => c.key === draft.to);
  const balance = from?.usdc ? BigInt(from.usdc) : null;
  // The account's own address there, unless another is given.
  const mine = to?.address ?? "";
  const recipient = to ? (!draft.other && mine ? mine : draft.recipient.trim()) : "";
  const gasDrop = to?.kind === "injective" && r?.gasDrop === true && (draft.gasDrop ?? BigInt(r.inj) === 0n);
  let amount: string | null = null;
  let problem: string | null = null;
  if (draft.max) amount = balance !== null && balance > 0n ? "max" : null;
  else if (draft.amount.trim()) {
    try {
      const v = parseUnits(draft.amount, USDC_DECIMALS);
      if (v === 0n) problem = "Enter an amount above zero.";
      else if (balance !== null && v > balance) problem = `That's more USDC than you have on ${from?.name ?? "that chain"}.`;
      else amount = v.toString();
    } catch (e) {
      problem = errorText(e);
    }
  }

  // Ask Circle once the form is complete, after the typing stops. Any change makes an answer
  // still on its way stale.
  useEffect(() => {
    const n = ++asked.current;
    setQuote(null);
    setQuoteError(null);
    setQuoting(false);
    if (!from || !to || !amount || !recipient) return;
    setQuoting(true);
    const t = setTimeout(() => {
      void backend
        .send({ type: "bridge_quote", from: from.key, to: to.key, amount, recipient, gasDrop })
        .then((x) => {
          if (n !== asked.current) return;
          if (x.ok) setQuote({ q: x.result, at: Date.now() });
          else setQuoteError(x.error.message);
        })
        .catch(() => n === asked.current && setQuoteError("The wallet didn't answer. Try again."))
        .finally(() => n === asked.current && setQuoting(false));
    }, 450);
    return () => clearTimeout(t);
  }, [from?.key, to?.key, amount, recipient, gasDrop]);

  async function review() {
    if (!from || !to || !amount || !recipient) return;
    let q = quote?.q;
    // An old quote is asked for again first: the review must show today's fee.
    if (!q || Date.now() - (quote?.at ?? 0) > FRESH_MS) {
      const fresh = await run({ type: "bridge_quote", from: from.key, to: to.key, amount, recipient, gasDrop });
      if (!fresh) return;
      setQuote({ q: fresh, at: Date.now() });
      q = fresh;
    }
    const x = await run({ type: "prepare_bridge", quote: q.id });
    if (x) onReview(x, q.id);
  }

  if (picking && r) {
    const list = picking === "from" ? r.chains.filter((c) => c.address) : r.chains.filter((c) => c.key !== draft.from);
    return (
      <ChainList
        title={picking === "from" ? "Bridge from" : "Bridge to"}
        network={network}
        chains={list}
        side={picking}
        onPick={(c) => {
          if (picking === "from") set({ from: c.key, max: false, ...(c.key === draft.to ? { to: draft.from } : {}) });
          // Another kind of chain spells addresses differently: what was typed goes.
          else set({ to: c.key, ...(to && to.kind !== "solana" && c.kind !== "solana" ? {} : { recipient: "" }), other: !c.address });
          setPicking(null);
        }}
        onBack={() => setPicking(null)}
      />
    );
  }

  const q = quote?.q;
  const usdc = (v: string) => `${formatShort(v, USDC_DECIMALS, 6)} USDC`;
  const coin = (v: string) => (q ? `${formatShort(v, q.gasDecimals, 6)} ${q.gasSymbol}` : v);
  const short = q !== undefined && BigInt(q.gasHeld) < BigInt(q.gasNeed);
  const deliveredBy = q ? { circle: "Circle", gas_drop: "Choice's bridge contract", anyone: q.to === "injective" ? "Choice's bridge service" : "You, with gas there" }[q.delivery] : "";
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
      {(pending.value ?? []).map((p) => (
        <PendingTransfer key={p.hash} item={p} network={network} onFinish={() => onFinish(p.from, p.hash)} onArrived={() => void pending.reload()} />
      ))}
      {(rent.value ?? []).map((x) => (
        <div className="surface" key={x.hash} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ChainMark chain="solana" network={network} small />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="num">Rent from a transfer</div>
            <div className="meta">{x.ready ? "About 0.004 SOL, yours to take back" : `Yours to take back from ${new Date(x.at + 5 * 86_400_000).toLocaleDateString()}`}</div>
          </div>
          {x.ready && canSign && (
            <button
              type="button"
              className="pill pill-gold"
              disabled={busy}
              onClick={() =>
                void run({ type: "prepare_bridge_reclaim", hash: x.hash }).then((rv) => {
                  if (rv) onReview(rv, "");
                })
              }
            >
              Take back
            </button>
          )}
        </div>
      ))}
      <div className="surface-hero">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">From</span>
          <button type="button" className="token-chip" onClick={() => setPicking("from")} aria-label="Choose where it comes from" disabled={!r}>
            {from && <ChainMark chain={from.key} network={network} small />}
            {from ? from.name : "Pick a chain"}
            <ChevronDownIcon size={16} />
          </button>
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
          <button type="button" className={draft.max ? "pill pill-gold" : "pill"} onClick={() => set({ max: !draft.max })} disabled={!balance}>
            {draft.max ? "Clear" : "Max"}
          </button>
        </div>
        <div className="meta num" style={{ marginTop: 6 }}>
          {!from ? "" : r === null ? "Checking your balance there…" : from.usdc === null ? `Couldn't read your balance on ${from.name}.` : `Balance ${formatUnits(from.usdc, USDC_DECIMALS)} USDC`}
        </div>
        <div className="convert-arrow" aria-hidden="true">
          <ArrowDownIcon size={18} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">To</span>
          <button type="button" className="token-chip" onClick={() => setPicking("to")} aria-label="Choose the chain" disabled={!r}>
            {to && <ChainMark chain={to.key} network={network} small />}
            {to ? to.name : "Pick a chain"}
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
      {to && mine && (
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
      {to && mine && !draft.other && <p className="meta">To your address on {to.name}, {shortAddress(mine)}.</p>}
      {to && (!mine || draft.other) && (
        <input
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={to.kind === "solana" ? "Solana wallet address" : `0x address on ${to.name}`}
          aria-label={to.kind === "solana" ? "Solana wallet address" : `Address on ${to.name}`}
          value={draft.recipient}
          onChange={(e) => set({ recipient: e.target.value })}
        />
      )}
      {to?.kind === "injective" && r?.gasDrop && (
        <>
          <Switch label="Also get INJ for gas" checked={gasDrop} onChange={(v) => set({ gasDrop: v })} />
          <p className="meta">{q && BigInt(q.gasDropFee) > 0n ? `About ${formatShort(q.gasDropInj, 18, 4)} INJ, for at most ${usdc(q.gasDropFee)}.` : "Pays for your first transactions on Injective."}</p>
        </>
      )}
      {problem && <p className="error">{problem}</p>}
      {quoteError && <Callout level="amber">{quoteError}</Callout>}
      {q && short && (
        <Callout level="amber">
          You need about {coin(q.gasNeed)} on {q.fromName} for its fee.
        </Callout>
      )}
      {q && (
        <div className="well rows">
          <div className="row">
            <span>Arrives</span>
            <span className="num">At least {usdc(q.minReceived)}</span>
          </div>
          <div className="row">
            <span>Circle&apos;s fee</span>
            <span className="num">{BigInt(q.maxFee) > 0n ? `Up to ${usdc(q.maxFee)}` : "None"}</span>
          </div>
          {q.recipientSetup && (
            <div className="row">
              <span>Also</span>
              <span>Circle opens its USDC account</span>
            </div>
          )}
          <div className="row">
            <span>Time</span>
            <span>About {about(q.etaMs)}</span>
          </div>
          <div className="row">
            <span>Fee on {q.fromName}</span>
            <span className="num">About {coin(q.gasNeed)}</span>
          </div>
          <div className="row">
            <span>Delivered by</span>
            <span>{deliveredBy}</span>
          </div>
          {q.steps.length > 1 && (
            <div className="row">
              <span>First</span>
              <span>One approval, for this amount only</span>
            </div>
          )}
        </div>
      )}
      {q && !q.own && <p className="meta">To someone else&apos;s address. Check it: a transfer can&apos;t be undone.</p>}
      <p className="footnote">Native USDC over Circle&apos;s CCTP.</p>
    </Screen>
  );
}

/** Chains to pick from: where it comes from (with the account's USDC there, most first), or
 *  where it goes. */
function ChainList({ title, network, chains, side, onPick, onBack }: { title: string; network: NetworkId; chains: BridgeEnd[]; side: "from" | "to"; onPick: (c: BridgeEnd) => void; onBack: () => void }) {
  const usdcOf = (c: BridgeEnd) => (c.usdc ? BigInt(c.usdc) : -1n);
  const sorted = side === "from" ? [...chains].sort((a, b) => (usdcOf(b) > usdcOf(a) ? 1 : usdcOf(b) < usdcOf(a) ? -1 : 0)) : chains;
  return (
    <Screen top={<BackBar title={title} onBack={onBack} />}>
      <div className="token-list">
        {sorted.map((c) => (
          <button key={c.key} className="token" onClick={() => onPick(c)}>
            <ChainMark chain={c.key} network={network} />
            <span className="name">
              <span className="symbol">{c.name}</span>
              <span className="sub">
                {side === "from"
                  ? c.usdc !== null
                    ? `${formatShort(c.usdc, USDC_DECIMALS, 2)} USDC · ${formatShort(c.native ?? "0", c.decimals, 4)} ${c.symbol}`
                    : "Balance unknown"
                  : c.address
                    ? `To your address, ${shortAddress(c.address)}`
                    : c.kind === "solana"
                      ? "To a Solana wallet"
                      : "To a 0x address"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Screen>
  );
}

/** A transfer that hasn't landed: where it is, and a way to finish it from here once
 *  whoever else would have minted it had their chance. */
function PendingTransfer({ item, network, onFinish, onArrived }: { item: BridgePending; network: NetworkId; onFinish: () => void; onArrived: () => void }) {
  const backend = useBackend();
  const [st, setSt] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    let live = true;
    async function tick() {
      if (!live) return;
      const r = await backend.send({ type: "bridge_status", from: item.from, hash: item.hash }).catch(() => null);
      if (!live) return;
      if (r?.ok) {
        setSt(r.result);
        if (r.result.phase === "delivered") {
          onArrived();
          return;
        }
      }
      setTimeout(() => void tick(), 5_000);
    }
    void tick();
    return () => {
      live = false;
    };
  }, [item.hash]);
  // Into Injective on mainnet, Choice's bridge service mints it; elsewhere nobody else will.
  const waits = item.to === "injective" && network === "mainnet" ? RELAY_GRACE_MS : 0;
  const canFinish = st?.selfMint === true && (st.phase === "stuck" || (st.phase === "ready" && Date.now() - item.at > waits));
  const what = canFinish
    ? "Not minted yet"
    : { pending: "Circle is picking it up", attesting: "Circle is confirming it", delivering: `Circle is delivering it`, ready: `Being minted on ${item.toName}`, delivered: "Arrived", stuck: "Circle hasn't delivered it" }[st?.phase ?? "pending"];
  return (
    <div className="surface" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <ChainMark chain={item.to} network={network} small />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="num">
          {formatShort(item.amount, USDC_DECIMALS, 6)} USDC, {item.fromName} to {item.toName}
        </div>
        <div className="meta">{what}</div>
      </div>
      {canFinish && (
        <button type="button" className="pill pill-gold" onClick={onFinish}>
          Finish
        </button>
      )}
    </div>
  );
}

/** The review's card for a burn, from the vault's reading; `info` is what the quote said. */
export function BridgeCard({ line, tokens, info, from }: { line: BridgeLine; tokens: Record<string, TokenInfo>; info?: BridgeStepInfo; from: string }) {
  const t = tokens[line.coin.denom];
  const fee = (c: Coin) => (t ? `${formatShort(c.amount, t.decimals, 6)} ${t.symbol}` : c.amount);
  const own = line.recipient !== null && line.recipient.toLowerCase() === from.toLowerCase();
  const chain = line.chain ?? "an unknown chain";
  // Solana: the burn names a USDC account. The wallet it belongs to is in the burn when Circle
  // opens it; otherwise it is the one the quote was for (the host checked the account is its).
  const solana = line.recipient !== null && !line.recipient.startsWith("0x");
  const wallet = line.owner ?? (solana && info ? info.recipient : null);
  const deliveredBy =
    line.delivery === "circle"
      ? line.caller
        ? "Only " + shortAddress(line.caller)
        : "Circle"
      : line.delivery === "gas_drop"
        ? "Choice's bridge contract"
        : line.delivery === "anyone"
          ? info?.toKey === "injective"
            ? "Choice's bridge service"
            : "Whoever claims it there"
          : line.caller
            ? "Only " + shortAddress(line.caller)
            : "A contract there";
  return (
    <div className="surface-hero">
      <div className="eyebrow">You bridge{(info?.from ?? line.from) ? ` from ${info?.from ?? line.from}` : ""}</div>
      <Figure coin={line.coin} t={t} />
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="eyebrow">To {chain}</div>
      <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: "21px" }}>
        {wallet ?? line.recipient ?? "No usable address"}
      </code>
      {own && <div className="meta" style={{ marginTop: 4 }}>Your own address there.</div>}
      {solana && wallet && (
        <div className="meta" style={{ marginTop: 4, wordBreak: "break-all" }}>
          Into its USDC account {shortAddress(line.recipient!)}
          {line.owner ? ", which Circle opens." : "."}
        </div>
      )}
      {solana && !wallet && <div className="meta" style={{ marginTop: 4 }}>A Solana USDC account.</div>}
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="rows">
        <div className="row">
          <span>Arrives</span>
          <span className="num">At least {fee(line.least)}</span>
        </div>
        <div className="row">
          <span>Circle&apos;s fee</span>
          <span className="num">{BigInt(line.maxFee.amount) > 0n ? `Up to ${fee(line.maxFee)}` : "None"}</span>
        </div>
        {line.dropFee && (
          <div className="row">
            <span>INJ for gas</span>
            <span className="num">
              {info && BigInt(info.gasDropInj) > 0n ? `${formatShort(info.gasDropInj, 18, 4)} INJ for ` : "For "}up to {fee(line.dropFee)}
            </span>
          </div>
        )}
        <div className="row">
          <span>Delivered by</span>
          <span>{deliveredBy}</span>
        </div>
      </div>
    </div>
  );
}

/** The review's card for minting a transfer on its destination. */
export function MintCard({ line, tokens, from }: { line: MintLine; tokens: Record<string, TokenInfo>; from: string }) {
  const t = tokens[line.coin.denom];
  const own = line.recipient !== null && line.recipient.toLowerCase() === from.toLowerCase();
  return (
    <div className="surface-hero">
      <div className="eyebrow">You receive</div>
      <Figure coin={line.coin} t={t} />
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="eyebrow">From {line.chain ?? "another chain"}</div>
      <p className="meta" style={{ marginTop: 6 }}>
        A USDC transfer Circle confirmed. Minting it costs only the network fee.
      </p>
      {!own && (
        <div className="meta danger-text" style={{ marginTop: 8, wordBreak: "break-all" }}>
          Paid to {line.recipient ?? "an account that isn't an address here"}
        </div>
      )}
      {BigInt(line.fee.amount) > 0n && (
        <div className="rows" style={{ marginTop: 10 }}>
          <div className="row">
            <span>Circle kept</span>
            <span className="num">{t ? `${formatShort(line.fee.amount, t.decimals, 6)} ${t.symbol}` : line.fee.amount}</span>
          </div>
        </div>
      )}
    </div>
  );
}
