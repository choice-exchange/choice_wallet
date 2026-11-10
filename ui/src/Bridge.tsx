// Bridge: native USDC between Injective and other chains, over Circle's CCTP.
//
// Out: Circle delivers it there and keeps its fee out of it (the most is shown before
// signing). On an EVM chain it arrives at this account's own address unless another is given
// (the same key, so the same address); on Solana at a wallet's USDC account, which Circle
// opens if there is none. Like a swap, a first transfer needs an approval for its amount.
//
// In: from this account's own address on another EVM chain (the same key), signed there and
// paid for in that chain's coin, into this account. Choice's bridge service mints it on
// Injective; if it hasn't, the account can (a little INJ). On mainnet the transfer can also
// buy INJ for gas.

import { formatShort, formatUnits, parseUnits } from "@choice-wallet/chain";
import { useEffect, useRef, useState } from "react";

import { useBackend } from "./backend";
import { ArrowDownIcon, ChevronDownIcon } from "./icons";
import { useKept } from "./kept";
import { BackBar, Callout, Screen, Segmented, shortAddress, Switch } from "./kit";
import type { BridgeChain, BridgeInBalance, BridgeInPending, BridgeInQuote, BridgeInStatus, BridgeInStepInfo, BridgeQuote, BridgeSource, BridgeStepInfo, Coin, NetworkId, SendReview, TokenInfo } from "./protocol";
import { errorText, useRequest } from "./request";
import type { BridgeInLine, BridgeLine, MintLine } from "./review";
import { about, Figure } from "./Send";

/** What the user has typed, kept while they review and come back. `dir` is the direction;
 *  out: `chain` and `recipient`; in: `from`, and `gasDrop` (null: on when the account has no
 *  INJ). */
export type BridgeDraft = {
  dir: "out" | "in";
  chain: string;
  amount: string;
  max: boolean;
  other: boolean;
  recipient: string;
  from: string;
  inAmount: string;
  inMax: boolean;
  gasDrop: boolean | null;
};

export const newBridgeDraft = (): BridgeDraft => ({ dir: "out", chain: "", amount: "", max: false, other: false, recipient: "", from: "", inAmount: "", inMax: false, gasDrop: null });

/** What a review was made from: the quote, and which way it goes. */
export type BridgeReviewed = { id: string; dir: "out" | "in" };

type BridgeProps = {
  network: NetworkId;
  canSign: boolean;
  draft: BridgeDraft;
  onDraft: (d: BridgeDraft) => void;
  onReview: (review: SendReview, quote: BridgeReviewed) => void;
  onBack: () => void;
  /** Why the user is back here, if a transfer stopped part way. */
  note?: string | null;
  /** Mint a transfer in that nobody has minted, from this account. */
  onFinish: (chain: string, hash: string) => void;
};

function Direction({ value, onChange }: { value: "out" | "in"; onChange: (v: "out" | "in") => void }) {
  return (
    <Segmented
      label="Direction"
      options={[
        ["out", "To another chain"],
        ["in", "To Injective"],
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

export function BridgeView(props: BridgeProps) {
  return props.draft.dir === "in" ? <BridgeInView {...props} /> : <BridgeOutView {...props} />;
}

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

function BridgeOutView({ canSign, draft, onDraft, onReview, onBack, note }: BridgeProps) {
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
      problem = errorText(e);
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
    if (x) onReview(x, { id: q.id, dir: "out" });
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
      <Direction value="out" onChange={(dir) => set({ dir })} />
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

/** Ask Choice's bridge service this long before offering to mint a transfer in from here. */
const RELAY_GRACE_MS = 3 * 60_000;

function BridgeInView({ network, canSign, draft, onDraft, onReview, onBack, note, onFinish }: BridgeProps) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const routes = useKept({ type: "bridge_in_routes" });
  const balances = useKept({ type: "bridge_in_balances" });
  const pending = useKept({ type: "bridge_in_pending" });
  /** Burns on Solana whose record's rent comes back to the account, 5 days on. */
  const rent = useKept({ type: "bridge_reclaims" });
  const r = routes.value;
  const [picking, setPicking] = useState(false);
  const [quote, setQuote] = useState<{ q: BridgeInQuote; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const asked = useRef(0);
  const set = (p: Partial<BridgeDraft>) => onDraft({ ...draft, ...p });
  const held = new Map((balances.value ?? []).map((b) => [b.chain, b]));

  // Start where the USDC is.
  useEffect(() => {
    if (draft.from || !r || !balances.value) return;
    const most = balances.value.filter((b) => b.usdc !== null && BigInt(b.usdc) > 0n).sort((a, b) => (BigInt(b.usdc!) > BigInt(a.usdc!) ? 1 : -1))[0];
    set({ from: most?.chain ?? r.chains.find((c) => c.key === "base")?.key ?? r.chains[0]?.key ?? "" });
  }, [r, balances.value]);

  const chain = r?.chains.find((c) => c.key === draft.from);
  const b = chain ? held.get(chain.key) : undefined;
  const balance = b?.usdc ? BigInt(b.usdc) : null;
  const gasDrop = r?.gasDrop === true && (draft.gasDrop ?? BigInt(r.inj) === 0n);
  let amount: string | null = null;
  let problem: string | null = null;
  if (draft.inMax) amount = balance !== null && balance > 0n ? "max" : null;
  else if (draft.inAmount.trim()) {
    try {
      const v = parseUnits(draft.inAmount, USDC_DECIMALS);
      if (v === 0n) problem = "Enter an amount above zero.";
      else if (balance !== null && v > balance) problem = `That's more USDC than you have on ${chain?.name ?? "that chain"}.`;
      else amount = v.toString();
    } catch (e) {
      problem = errorText(e);
    }
  }

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!chain || !amount) return;
    const n = ++asked.current;
    setQuoting(true);
    const t = setTimeout(() => {
      void backend
        .send({ type: "bridge_in_quote", from: chain.key, amount, gasDrop })
        .then((x) => {
          if (n !== asked.current) return;
          if (x.ok) setQuote({ q: x.result, at: Date.now() });
          else setQuoteError(x.error.message);
        })
        .catch(() => n === asked.current && setQuoteError("The wallet didn't answer. Try again."))
        .finally(() => n === asked.current && setQuoting(false));
    }, 450);
    return () => clearTimeout(t);
  }, [chain?.key, amount, gasDrop]);

  async function review() {
    if (!chain || !amount) return;
    let q = quote?.q;
    if (!q || Date.now() - (quote?.at ?? 0) > FRESH_MS) {
      const fresh = await run({ type: "bridge_in_quote", from: chain.key, amount, gasDrop });
      if (!fresh) return;
      setQuote({ q: fresh, at: Date.now() });
      q = fresh;
    }
    const x = await run({ type: "prepare_bridge_in", quote: q.id });
    if (x) onReview(x, { id: q.id, dir: "in" });
  }

  if (picking && r) {
    return (
      <SourcePicker
        chains={r.chains}
        held={held}
        onPick={(c) => {
          set({ from: c.key, inMax: false });
          setPicking(false);
        }}
        onBack={() => setPicking(false)}
      />
    );
  }

  const q = quote?.q;
  const usdc = (v: string) => `${formatShort(v, USDC_DECIMALS, 6)} USDC`;
  const coin = (v: string) => `${formatShort(v, chain?.decimals ?? 18, 6)} ${chain?.symbol ?? ""}`;
  const short = q !== undefined && BigInt(q.gasHeld) < BigInt(q.gasNeed);
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
      <Direction value="in" onChange={(dir) => set({ dir })} />
      {note && <Callout level="amber">{note}</Callout>}
      {routes.error && <Callout level="amber">{routes.error}</Callout>}
      {(pending.value ?? []).map((p) => (
        <PendingIn key={p.hash} item={p} network={network} onFinish={() => onFinish(p.chain, p.hash)} onArrived={() => void pending.reload()} />
      ))}
      {(rent.value ?? []).map((x) => (
        <div className="surface" key={x.hash} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ChainTile name="Solana" small />
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
                  if (rv) onReview(rv, { id: "", dir: "in" });
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
          <button type="button" className="token-chip" onClick={() => setPicking(true)} aria-label="Choose where it comes from" disabled={!r}>
            {chain && <ChainTile name={chain.name} small />}
            {chain ? chain.name : "Pick a chain"}
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
            value={draft.inMax ? "Max" : draft.inAmount}
            disabled={draft.inMax}
            onChange={(e) => set({ inAmount: e.target.value })}
          />
          <button type="button" className={draft.inMax ? "pill pill-gold" : "pill"} onClick={() => set({ inMax: !draft.inMax })} disabled={!balance}>
            {draft.inMax ? "Clear" : "Max"}
          </button>
        </div>
        <div className="meta num" style={{ marginTop: 6 }}>
          {!chain ? "" : balances.value === null ? "Checking your balance there…" : b?.usdc === null || b === undefined ? `Couldn't read your balance on ${chain.name}.` : `Balance ${formatUnits(b.usdc, USDC_DECIMALS)} USDC`}
        </div>
        <div className="convert-arrow" aria-hidden="true">
          <ArrowDownIcon size={18} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="eyebrow">To Injective</span>
          <span className="meta mono">{shortAddress(r?.address ?? "")}</span>
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
      {chain && <p className="meta">From your address on {chain.name}: the same as here.</p>}
      {r?.gasDrop && (
        <>
          <Switch label="Also get INJ for gas" checked={gasDrop} onChange={(v) => set({ gasDrop: v })} />
          <p className="meta">{q && BigInt(q.gasDropFee) > 0n ? `About ${formatShort(q.gasDropInj, 18, 4)} INJ, for at most ${usdc(q.gasDropFee)}.` : "Pays for your first transactions on Injective."}</p>
        </>
      )}
      {problem && <p className="error">{problem}</p>}
      {quoteError && <Callout level="amber">{quoteError}</Callout>}
      {q && short && chain && (
        <Callout level="amber">
          You need about {coin(q.gasNeed)} on {chain.name} for its fee.
        </Callout>
      )}
      {q && chain && (
        <div className="well rows">
          <div className="row">
            <span>Arrives</span>
            <span className="num">At least {usdc(q.minReceived)}</span>
          </div>
          <div className="row">
            <span>Circle&apos;s fee</span>
            <span className="num">{BigInt(q.maxFee) > 0n ? `Up to ${usdc(q.maxFee)}` : "None"}</span>
          </div>
          <div className="row">
            <span>Time</span>
            <span>About {about(q.etaMs)}</span>
          </div>
          <div className="row">
            <span>Fee on {chain.name}</span>
            <span className="num">About {coin(q.gasNeed)}</span>
          </div>
          {q.steps.length > 1 && (
            <div className="row">
              <span>First</span>
              <span>One approval, for this amount only</span>
            </div>
          )}
        </div>
      )}
      <p className="footnote">Native USDC over Circle&apos;s CCTP. Choice&apos;s bridge service completes it on Injective.</p>
    </Screen>
  );
}

function SourcePicker({ chains, held, onPick, onBack }: { chains: BridgeSource[]; held: Map<string, BridgeInBalance>; onPick: (c: BridgeSource) => void; onBack: () => void }) {
  const usdcOf = (c: BridgeSource) => {
    const v = held.get(c.key)?.usdc;
    return v ? BigInt(v) : -1n;
  };
  // Where the USDC is first; then the registry's order.
  const sorted = [...chains].sort((a, b) => (usdcOf(b) > usdcOf(a) ? 1 : usdcOf(b) < usdcOf(a) ? -1 : 0));
  return (
    <Screen top={<BackBar title="Bridge from" onBack={onBack} />}>
      <div className="token-list">
        {sorted.map((c) => {
          const h = held.get(c.key);
          return (
            <button key={c.key} className="token" onClick={() => onPick(c)}>
              <ChainTile name={c.name} />
              <span className="name">
                <span className="symbol">{c.name}</span>
                <span className="sub">{h?.usdc ? `${formatShort(h.usdc, USDC_DECIMALS, 2)} USDC · ${formatShort(h.native ?? "0", c.decimals ?? 18, 4)} ${c.symbol}` : h ? "Balance unknown" : "Checking…"}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Screen>
  );
}

/** A transfer in that hasn't arrived: where it is, and a way to finish it from here once
 *  Choice's bridge service had its chance. */
function PendingIn({ item, network, onFinish, onArrived }: { item: BridgeInPending; network: NetworkId; onFinish: () => void; onArrived: () => void }) {
  const backend = useBackend();
  const [st, setSt] = useState<BridgeInStatus | null>(null);
  useEffect(() => {
    let live = true;
    async function tick() {
      if (!live) return;
      const r = await backend.send({ type: "bridge_in_status", chain: item.chain, hash: item.hash }).catch(() => null);
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
  const canFinish = st?.phase === "ready" && st.selfMint && (network === "testnet" || Date.now() - item.at > RELAY_GRACE_MS);
  const what = { pending: "Circle is picking it up", attesting: "Circle is confirming it", ready: canFinish ? "Not minted yet" : "Being minted on Injective", delivered: "Arrived" }[st?.phase ?? "pending"];
  return (
    <div className="surface" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <ChainTile name={item.chainName} small />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="num">
          {formatShort(item.amount, USDC_DECIMALS, 6)} USDC from {item.chainName}
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

/** The review's card for a transfer in, from the vault's reading; `info` is what the quote
 *  said (the INJ the top-up buys). */
export function BridgeInCard({ line, tokens, info }: { line: BridgeInLine; tokens: Record<string, TokenInfo>; info?: BridgeInStepInfo }) {
  const t = tokens[line.coin.denom];
  const fee = (c: Coin) => (t ? `${formatShort(c.amount, t.decimals, 6)} ${t.symbol}` : c.amount);
  return (
    <div className="surface-hero">
      <div className="eyebrow">You bridge from {line.chain}</div>
      <Figure coin={line.coin} t={t} />
      <hr className="divider" style={{ margin: "14px 0 12px" }} />
      <div className="eyebrow">To Injective</div>
      <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: "21px" }}>
        {line.recipient}
      </code>
      <div className="meta" style={{ marginTop: 4 }}>This account.</div>
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
          <span>Minted by</span>
          <span>{line.delivery === "gas_drop" ? "Choice's bridge contract" : "Choice's bridge service"}</span>
        </div>
      </div>
    </div>
  );
}

/** The review's card for minting a transfer in on Injective. */
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
