// Tokens: the filter that keeps junk off the lists, and a show/hide switch per token.
// Changes apply at once.

import { formatShort, NETWORKS } from "@choice-wallet/chain";
import { useState, type FormEvent } from "react";

import { EyeIcon, EyeOffIcon, PlusIcon } from "./icons";
import { BackBar, formatUsd, Screen, Segmented, Switch, tokenSub } from "./kit";
import type { Balance, NetworkId, TokenFilter } from "./protocol";
import { applyFilter, flip, type HiddenWhy } from "./tokenFilter";
import { TokenMark } from "./TokenMark";

const WHY: Record<HiddenWhy, string> = { unlisted: "Unlisted", small: "Under $1", yours: "Hidden by you" };

export function TokensView({
  balances,
  filter,
  network,
  prices,
  onChange,
  onAdd,
  onBack,
}: {
  balances: Balance[];
  filter: TokenFilter;
  network: NetworkId;
  prices: boolean;
  onChange: (f: TokenFilter) => void;
  /** Add a token by contract: null when it worked, else what went wrong. */
  onAdd: (contract: string) => Promise<string | null>;
  onBack: () => void;
}) {
  const fee = NETWORKS[network].feeDenom;
  const { shown, hidden } = applyFilter(balances, filter, fee);
  const note =
    network === "testnet"
      ? "No prices on testnet: only listed tokens pass."
      : prices
        ? "Priced means Choice has a price for it."
        : "USD values are off, so priced tokens may hide.";
  const row = (b: Balance, why: HiddenWhy | null) => (
    <div key={b.denom} className={why ? "token manage is-hidden" : "token manage"} title={b.denom}>
      <TokenMark denom={b.denom} symbol={b.symbol} known={b.known} />
      <span className="name">
        <span className="symbol">
          {b.symbol}
          {why && <span className={why === "unlisted" ? "flag" : "flag quiet"}>{WHY[why]}</span>}
        </span>
        <span className={b.known ? "sub" : "sub denom"}>{tokenSub(b)}</span>
      </span>
      <span className="value">
        <span className="amount">{formatShort(b.amount, b.decimals)}</span>
        {b.usd !== undefined && <span className="usd">{formatUsd(b.usd)}</span>}
      </span>
      {b.denom === fee ? (
        <span className="icon-btn" aria-hidden="true" />
      ) : (
        <button className="icon-btn" aria-label={`${why ? "Show" : "Hide"} ${b.symbol}`} onClick={() => onChange(flip(filter, b, fee))}>
          {why ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </div>
  );

  return (
    <Screen top={<BackBar title="Tokens" onBack={onBack} />}>
      <Segmented
        label="Show"
        options={[
          ["filtered", "Listed and priced"],
          ["all", "All tokens"],
        ]}
        value={filter.all ? "all" : "filtered"}
        onChange={(v) => onChange({ ...filter, all: v === "all" })}
      />
      <Switch label="Hide under $1" checked={filter.hideSmall} onChange={(v) => onChange({ ...filter, hideSmall: v })} />
      <span className="meta">{note}</span>

      <div className="eyebrow" style={{ marginTop: 8 }}>
        Shown · {shown.length}
      </div>
      <div className="token-list">{shown.map((b) => row(b, null))}</div>
      {hidden.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 8 }}>
            Hidden · {hidden.length}
          </div>
          <div className="token-list">{hidden.map((h) => row(h.balance, h.why))}</div>
        </>
      )}
      <AddToken onAdd={onAdd} />
      <p className="footnote">Hidden tokens stay in your account.</p>
    </Screen>
  );
}

/** Add a token by its contract address: for an ERC20 the wallet doesn't find by itself. */
function AddToken({ onAdd }: { onAdd: (contract: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [contract, setContract] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button className="hidden-row" onClick={() => setOpen(true)}>
        <PlusIcon size={16} />
        Add a token by contract
      </button>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await onAdd(contract.trim());
    setBusy(false);
    if (problem) {
      setError(problem);
    } else {
      setContract("");
      setOpen(false);
    }
  }
  return (
    <form className="well add-token" onSubmit={(e) => void submit(e)}>
      <div className="eyebrow">Add a token</div>
      <input
        className="input mono"
        placeholder="0x… token contract"
        aria-label="Token contract"
        spellCheck={false}
        autoFocus
        value={contract}
        onChange={(e) => setContract(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <div className="add-token-actions">
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn btn-gold" disabled={busy || !contract.trim()}>
          {busy ? "Checking…" : "Add"}
        </button>
      </div>
    </form>
  );
}
