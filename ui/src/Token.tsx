// One token: what it is, and what to do with it (send it, or convert it to its other form).

import { cw20Address, evmAddress, formatUnits } from "@choice-wallet/chain";
import { useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { CheckIcon, CopyIcon, SendIcon, SwapIcon } from "./icons";
import { BackBar, Callout, formatUsd, Screen } from "./kit";
import type { Balance, SendReview } from "./protocol";
import { useRequest } from "./request";
import { parseEntered } from "./Send";
import { TokenMark } from "./TokenMark";

/** What kind of token this is, in a word or two. */
function kindOf(t: Balance, feeDenom: string): string {
  if (t.denom === feeDenom) return "Native";
  if (evmAddress(t.denom)) return "ERC20 (EVM only)";
  if (cw20Address(t.denom)) return "CW20";
  return "Bank token";
}

/** The other form's name, for the convert button. */
export const otherFormName = (t: Balance) => (cw20Address(t.denom) ? "bank token" : "CW20");

export function TokenView({
  token,
  feeDenom,
  onSend,
  onConvert,
  onBack,
}: {
  token: Balance;
  feeDenom: string;
  onSend: () => void;
  onConvert: () => void;
  onBack: () => void;
}) {
  const backend = useBackend();
  const [copied, setCopied] = useState(false);
  const id = evmAddress(token.denom) ?? cw20Address(token.denom) ?? token.denom;
  const isContract = id !== token.denom;
  return (
    <Screen
      top={<BackBar title={token.symbol} onBack={onBack} />}
      foot={
        <>
          <button className="btn btn-gold" onClick={onSend}>
            <SendIcon /> Send
          </button>
          {token.convertsTo && (
            <button className="btn" onClick={onConvert}>
              <SwapIcon /> Convert to {otherFormName(token)}
            </button>
          )}
        </>
      }
    >
      <div className="surface-hero token-hero">
        <TokenMark denom={token.denom} symbol={token.symbol} known={token.known} />
        <div className="hero" style={{ wordBreak: "break-all" }}>
          {formatUnits(token.amount, token.decimals)} <span className="unit">{token.symbol}</span>
        </div>
        {token.usd !== undefined && <div className="meta num">{formatUsd(token.usd)}</div>}
      </div>
      <div className="well rows">
        <div className="row">
          <span>Name</span>
          <span>{token.name || "None given"}</span>
        </div>
        <div className="row">
          <span>Kind</span>
          <span>{kindOf(token, feeDenom)}</span>
        </div>
        <div className="row">
          <span>On the wallet&apos;s list</span>
          <span>{token.known ? "Yes" : "No"}</span>
        </div>
      </div>
      {token.denom !== feeDenom && (
        <div className="well">
          <div className="eyebrow">{isContract ? "Contract" : "Denom"}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 6 }}>
            <code className="mono address" style={{ flex: 1, wordBreak: "break-all" }}>
              {id}
            </code>
            <button
              className="icon-btn"
              aria-label={isContract ? "Copy contract" : "Copy denom"}
              onClick={() =>
                void backend.copy(id).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>
          </div>
        </div>
      )}
      {token.convertsTo && (
        <p className="lead">{cw20Address(token.denom) ? "Most apps on Injective use the bank form of this token." : "Some older CosmWasm apps take only the CW20 form."}</p>
      )}
    </Screen>
  );
}

export function ConvertForm({ token, onReview, onBack }: { token: Balance; onReview: (review: SendReview) => void; onBack: () => void }) {
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const { run, error, busy } = useRequest();
  const { parsed, problem } = parseEntered(amount, max, token);
  const fromCw20 = cw20Address(token.denom) !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed) return;
    const review = await run({ type: "prepare_convert", denom: token.denom, amount: parsed });
    if (review) onReview(review);
  }

  return (
    <form onSubmit={(e) => void submit(e)} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title={`Convert ${token.symbol}`} onBack={onBack} />}
        foot={
          <>
            {error && <Callout level="amber">{error}</Callout>}
            <button className="btn btn-gold" type="submit" disabled={!parsed || busy}>
              {busy ? "Checking…" : "Review"}
            </button>
          </>
        }
      >
        <div className="surface-hero">
          <div className="eyebrow">{fromCw20 ? "From CW20 to bank token" : "From bank token to CW20"}</div>
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
        </div>
        {problem && <p className="error">{problem}</p>}
        <p className="lead">You get the same amount of {token.symbol} in its other form. The fee is in INJ.</p>
      </Screen>
    </form>
  );
}
