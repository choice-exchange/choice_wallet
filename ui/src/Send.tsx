// Send: the form (with its token picker), the review, and the sent screen.

import { cw20Address, evmAddress, formatShort, formatUnits, parseUnits, shortDenom, usdValue } from "@choice-wallet/chain";
import { useEffect, useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { RecipientPicker } from "./Contacts";
import { ArrowDownIcon, CheckIcon, ChevronDownIcon, ClockIcon, CloseIcon, ExternalIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen, shortAddress, tokenSub } from "./kit";
import { DeviceStep } from "./Ledger";
import type { AccountInfo, Balance, Coin, Contact, DeviceRequest, DeviceSignature, NetworkId, RecipientCheck, SendReview, Sent, SwapStepInfo, TokenInfo, TxState } from "./protocol";
import { useRequest } from "./request";
import { permissionName } from "./permissions";
import { shown, spenderName, type Shown, type StakeLine } from "./review";
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

/** An address worth asking the host about. */
const ADDRESS = /^(inj1[02-9ac-hj-np-z]{38}|0x[0-9a-fA-F]{40})$/;

export function SendForm({
  balances,
  accounts,
  denom: initial,
  onReview,
  onBack,
}: {
  balances: Balance[];
  /** The user's other accounts, to send to. */
  accounts: AccountInfo[];
  denom?: string | undefined;
  onReview: (review: SendReview, entered: string, denom: string) => void;
  onBack: () => void;
}) {
  const backend = useBackend();
  const [denom, setDenom] = useState(initial ?? balances[0]?.denom ?? "");
  const [picking, setPicking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [check, setCheck] = useState<RecipientCheck | null>(null);
  const { run, error, busy } = useRequest();
  const token = balances.find((b) => b.denom === denom);

  useEffect(() => {
    void backend.send({ type: "contacts" }).then((r) => setContacts(r.ok ? r.result : []));
  }, []);
  // What the wallet knows of the recipient, once it looks like an address: a contact (with
  // its memo), one of the user's accounts, or an exchange's deposit address.
  useEffect(() => {
    const entered = to.trim();
    setCheck(null);
    if (!ADDRESS.test(entered)) return;
    let live = true;
    const timer = setTimeout(() => {
      void backend.send({ type: "check_recipient", to: entered }).then((r) => {
        if (!live || !r.ok) return;
        setCheck(r.result);
        const saved = r.result.contact?.memo;
        if (saved) setMemo((m) => m || saved);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [to]);

  if (choosing) {
    return (
      <RecipientPicker
        accounts={accounts}
        contacts={contacts}
        onBack={() => setChoosing(false)}
        onPick={(address, m) => {
          setTo(address);
          setMemo(m);
          setChoosing(false);
        }}
      />
    );
  }

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
  // An EVM-only token moves in an EVM transaction, which has no memo.
  const evmOnly = evmAddress(token.denom) !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed || !token) return;
    const entered = to.trim();
    const review = await run({ type: "prepare_send", denom: token.denom, to: entered, amount: parsed, ...(evmOnly || !memo.trim() ? {} : { memo: memo.trim() }) });
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
        <div className="field">
          <div className="section-head" style={{ marginTop: 0 }}>
            <span className="eyebrow">To</span>
            <button type="button" className="link" onClick={() => setChoosing(true)}>
              Contacts
            </button>
          </div>
          <input
            className="input mono"
            placeholder="inj1… or 0x…"
            aria-label="To"
            autoComplete="off"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          {check?.mine && <span className="meta">Your account {check.mine}</span>}
          {check?.contact && <span className="meta">{check.contact.name}, from your address book</span>}
        </div>
        {check?.takesMemo && evmOnly && (
          <Callout level="red">This address needs a memo, which an EVM-only token&apos;s send can&apos;t carry.</Callout>
        )}
        {check?.takesMemo && !evmOnly && !check.contact?.memo && !memo.trim() && (
          <Callout level="amber">This looks like an exchange: its deposits carry a memo. Add yours below.</Callout>
        )}
        {!evmOnly && (
          <label className="field">
            <span className="eyebrow">Memo</span>
            <input
              className="input mono"
              placeholder="Optional"
              aria-label="Memo"
              autoComplete="off"
              spellCheck={false}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
            {check?.contact?.memo && memo.trim() === check.contact.memo && <span className="meta">The memo saved for {check.contact.name}.</span>}
          </label>
        )}
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
  validators = {},
  rewards = {},
}: {
  review: SendReview;
  entered: string;
  network: NetworkId;
  onSent: (sent: Sent) => void;
  onCancel: () => void;
  /** Validator names by address, for a staking review. */
  validators?: Record<string, string>;
  /** Unclaimed rewards by validator when the review was made, for a claim. */
  rewards?: Record<string, string>;
}) {
  const { risk, tokens } = review;
  const view = shown(review.display, network, review.swap);
  const swapping = view.swaps.length > 0;
  const approving = view.approvals.length > 0 && !swapping;
  const converting = view.converts.length > 0 && view.sends.length === 0;
  const staking = view.stakes.length > 0 && view.sends.length === 0 && view.converts.length === 0;
  const revoking = view.revokes.length > 0 && view.sends.length === 0 && view.converts.length === 0 && view.stakes.length === 0;
  const gasGrant = review.display.kind !== "evm_transaction" && ((review.display as { messages?: { type?: string }[] }).messages ?? []).some((m) => m.type === "fee_grant");
  const symbol = (key: string) => tokens[key]?.symbol ?? shortDenom(key);
  const named = (v: string) => validators[v] || shortAddress(v);
  const [typed, setTyped] = useState("");
  const { run, error, busy } = useRequest();
  const backend = useBackend();
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

  const [device, setDevice] = useState<DeviceRequest | null>(null);
  async function confirm() {
    const sent = await run({ type: "confirm_send", digest: review.digest, ...(risk.confirm ? { confirm: typed.trim() } : {}) });
    if (!sent) return;
    if ("device" in sent) setDevice(sent.device);
    else onSent(sent);
  }
  /** The Ledger's signature, checked by the vault, then broadcast. */
  async function signed(sig: DeviceSignature): Promise<string | null> {
    const r = await backend.send({ type: "ledger_signed", digest: review.digest, ...sig });
    if (!r.ok) return r.error.message;
    onSent(r.result);
    return null;
  }

  return (
    <Screen
      top={
        <BackBar
          title={review.rescue ? "Review rescue" : gasGrant ? "Review gas" : swapping ? "Review swap" : approving ? "Review approval" : revoking ? "Review revoke" : staking ? "Review staking" : converting ? "Review conversion" : "Review send"}
          onBack={onCancel}
        />
      }
      foot={
        device ? (
          <DeviceStep request={device} onSignature={signed} onCancel={() => setDevice(null)} />
        ) : (
        <>
          {error && <Callout level="red">{error}</Callout>}
          <button
            className={risk.level === "red" || blocked ? "btn btn-danger" : "btn btn-gold"}
            disabled={busy || blocked || needsWord}
            onClick={() => void confirm()}
          >
            {swapping
              ? busy
                ? "Swapping…"
                : "Confirm swap"
              : approving
                ? busy
                  ? "Sending…"
                  : "Approve"
                : staking || revoking
                  ? busy
                    ? "Sending…"
                    : "Confirm"
                  : converting
                    ? busy
                      ? "Converting…"
                      : "Confirm and convert"
                    : busy
                      ? "Sending…"
                      : "Confirm and send"}
          </button>
          <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
        )
      }
    >
      {review.rescue && (
        <Callout level="amber">
          Everything below goes to your rescue address.{review.rescue.rest > 0 ? ` ${review.rescue.rest} more ${review.rescue.rest === 1 ? "message didn't" : "messages didn't"} fit: rescue again after this one.` : ""}
        </Callout>
      )}
      {/* What the risk rules found comes first: it must never sit below the fold. */}
      {risk.findings.map((f, i) => (
        <Callout key={i} level={f.level}>
          {f.message}
        </Callout>
      ))}
      {review.swap && review.swap.left > 0 && <p className="meta">{review.swap.left === 1 ? "One more step after this." : "Two more steps after this."}</p>}
      <SwapCards view={view} tokens={tokens} network={network} from={(review.display as { from?: string }).from ?? ""} {...(review.swap ? { step: review.swap } : {})} usd={usd} />
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
      {view.nfts.map((n, i) => (
        <div className="surface-hero" key={`n${i}`}>
          <div className="eyebrow">You send an NFT</div>
          <div className="hero num" style={{ fontSize: 24, wordBreak: "break-all" }}>
            #{n.tokenId}
          </div>
          <div className="meta mono" style={{ marginTop: 4, wordBreak: "break-all" }}>
            Collection {n.collection}
          </div>
          <hr className="divider" style={{ margin: "14px 0 12px" }} />
          <div className="eyebrow">To</div>
          <code className="mono recipient" style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: "21px" }}>
            {n.to}
          </code>
          {entered && entered.toLowerCase() !== n.to.toLowerCase() && (
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
      {view.stakes.map((st, i) => (
        <div className="surface-hero" key={`s${i}`}>
          <div className="eyebrow">{STAKE_VERB[st.kind]}</div>
          {st.amount && <Figure coin={st.amount} t={tokens[st.amount.denom]} />}
          {st.kind === "claim" && rewards[st.validator] && rewards[st.validator] !== "0" && (
            <>
              <Figure coin={{ denom: "inj", amount: rewards[st.validator]! }} t={tokens["inj"]} />
              <div className="meta" style={{ marginTop: 4, marginLeft: 46 }}>
                At least this much: it grows each block.
              </div>
            </>
          )}
          {st.amount && usd([st.amount]) && <div className="meta num" style={{ marginTop: 4, marginLeft: 46 }}>{usd([st.amount])}</div>}
          <hr className="divider" style={{ margin: "14px 0 12px" }} />
          <div className="eyebrow">{st.to ? "From" : st.kind === "claim" ? "Rewards from" : "Validator"}</div>
          <div className="validator-name" title={st.validator}>
            {named(st.validator)}
          </div>
          {st.to && (
            <>
              <div className="eyebrow" style={{ marginTop: 10 }}>
                To
              </div>
              <div className="validator-name" title={st.to}>
                {named(st.to)}
              </div>
            </>
          )}
        </div>
      ))}
      {revoking && (
        <div className="surface-hero">
          <div className="eyebrow">You take back</div>
          <ul className="revoke-list">
            {view.revokes.map((r, i) => (
              <li key={i}>
                {r.kind === "grant" && (
                  <>
                    {permissionName(r.msgTypeUrl)} <span className="meta mono">· {shortAddress(r.grantee)}</span>
                  </>
                )}
                {r.kind === "fee" && (
                  <>
                    Fee allowance <span className="meta mono">· {shortAddress(r.grantee)}</span>
                  </>
                )}
                {r.kind === "rewards" && <>Staking rewards come to this account again</>}
                {r.kind === "allowance" && (
                  <>
                    {symbol(r.token)} allowance <span className="meta mono">· {shortAddress(r.spender)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
        {view.swaps.map((sw, i) => (
          <div className="row" key={`fee${i}`}>
            <span>Choice fee</span>
            <span>{sw.feeBps > 0 ? `${(sw.feeBps / 100).toFixed(2)}%` : "None"}</span>
          </div>
        ))}
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


/** How the vault's venue names read in a sentence. */
const VENUE_TEXT: Record<string, string> = { Solidly: "a Solidly pool", "INJ orderbook": "the INJ orderbook", Adapter: "an adapter contract", Infinity: "an Infinity pool" };

/** A swap and the approvals before it, as the vault read them. `step` is the wallet's own
 *  swap step (Choice's expected amount; approvals are this swap's amount). */
export function SwapCards({
  view,
  tokens,
  network,
  from,
  step,
  usd,
}: {
  view: Shown;
  tokens: Record<string, TokenInfo>;
  network: NetworkId;
  from: string;
  step?: SwapStepInfo;
  usd?: (cs: Coin[]) => string | null;
}) {
  const coin = (c: Coin) => {
    const t = tokens[c.denom];
    return t ? `${formatShort(c.amount, t.decimals, 6)} ${t.symbol}` : `${c.amount} ${shortDenom(c.denom)}`;
  };
  // A minimum shown to 6 decimals, rounded down: what arrives is never less than it says.
  const floored = (c: Coin): Coin => {
    const t = tokens[c.denom];
    if (!t || t.decimals <= 6) return c;
    const unit = 10n ** BigInt(t.decimals - 6);
    return { ...c, amount: (BigInt(c.amount) - (BigInt(c.amount) % unit)).toString() };
  };
  return (
    <>
      {view.swaps.map((sw, i) => {
        return (
          <div className="surface-hero" key={`w${i}`}>
            <div className="eyebrow">You swap</div>
            <Figure coin={sw.from} t={tokens[sw.from.denom]} />
            {usd?.([sw.from]) && <div className="meta num" style={{ marginTop: 4, marginLeft: 46 }}>{usd?.([sw.from])}</div>}
            {realName(sw.from.denom, tokens[sw.from.denom]) && (
              <div className="meta mono" style={{ marginTop: 4, marginLeft: 46, wordBreak: "break-all" }}>
                {realName(sw.from.denom, tokens[sw.from.denom])}
              </div>
            )}
            <div className="convert-arrow" aria-hidden="true">
              <ArrowDownIcon size={18} />
            </div>
            <div className="eyebrow">You get at least</div>
            <Figure coin={floored(sw.minimum)} t={tokens[sw.minimum.denom]} />
            {step && <div className="meta" style={{ marginTop: 4, marginLeft: 46 }}>Choice expects {coin({ denom: sw.minimum.denom, amount: step.expectedOut })}.</div>}
            {realName(sw.minimum.denom, tokens[sw.minimum.denom]) && (
              <div className="meta mono" style={{ marginTop: 4, marginLeft: 46, wordBreak: "break-all" }}>
                {realName(sw.minimum.denom, tokens[sw.minimum.denom])}
              </div>
            )}
            {sw.recipient.toLowerCase() !== from.toLowerCase() && (
              <div className="meta danger-text" style={{ marginTop: 8, wordBreak: "break-all" }}>
                Paid to {sw.recipient}
              </div>
            )}
            <p className="meta" style={{ marginTop: 10 }}>
              {sw.venues.length > 0 ? `Through ${sw.venues.map((v) => VENUE_TEXT[v] ?? v).join(", ")}. ` : ""}If less would arrive, the swap fails and only the network fee is spent.
            </p>
          </div>
        );
      })}
      {view.approvals.map((a, i) => (
        <div className="surface-hero" key={`a${i}`}>
          <div className="eyebrow">You allow</div>
          <div className="validator-name" title={a.spender}>
            {spenderName(network, a.spender) ?? shortAddress(a.spender)}
          </div>
          <div className="eyebrow" style={{ marginTop: 10 }}>
            {a.via === "permit2" ? "To take through Permit2" : "To move"}
          </div>
          <Figure coin={{ denom: a.token, amount: a.amount }} t={tokens[a.token]} />
          <p className="meta" style={{ marginTop: 10 }}>
            {a.until ? `Until ${new Date(a.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ` : ""}
            {step ? "Exactly this swap's amount." : ""}
          </p>
        </div>
      ))}
    </>
  );
}

const STAKE_VERB: Record<StakeLine["kind"], string> = {
  stake: "You stake",
  unstake: "You unstake",
  move: "You move",
  claim: "You claim",
  cancel: "You stake again",
  give: "You give stake",
};

const POLL_MS = 1500;
const POLL_TRIES = 40;

export function SentView({
  sent,
  onDone,
  onSave,
  onNext,
  converting = false,
  done,
}: {
  sent: Sent;
  onDone: () => void;
  /** Offered when the recipient isn't saved yet: save it to the address book. */
  onSave?: (() => void) | undefined;
  /** A swap's next step, offered once this one is in a block. */
  onNext?: (() => void) | undefined;
  converting?: boolean;
  done?: string;
}) {
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
  const title = { pending: converting ? "Converting" : "Sending", slow: "Not confirmed yet", success: done ?? (converting ? "Converted" : "Sent"), failed: "Failed" }[s];
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
          {onNext && s === "success" ? (
            <button className="btn btn-gold" onClick={onNext}>
              Next step
            </button>
          ) : (
            <button className={onNext ? "btn" : "btn btn-gold"} onClick={onDone}>
              Done
            </button>
          )}
          {onSave && s !== "failed" && (
            <button className="btn btn-quiet" onClick={onSave}>
              Save address
            </button>
          )}
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
