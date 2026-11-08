// Tokens: the filter that keeps junk off the lists, and a show/hide switch per token.
// Changes apply at once.

import { formatShort, NETWORKS, shortDenom } from "@choice-wallet/chain";

import { EyeIcon, EyeOffIcon } from "./icons";
import { BackBar, formatUsd, Screen, Segmented, Switch } from "./kit";
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
  onBack,
}: {
  balances: Balance[];
  filter: TokenFilter;
  network: NetworkId;
  prices: boolean;
  onChange: (f: TokenFilter) => void;
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
        <span className={b.known ? "sub" : "sub denom"}>{b.known ? b.name : shortDenom(b.denom)}</span>
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
      <p className="footnote">Hidden tokens stay in your account.</p>
    </Screen>
  );
}
