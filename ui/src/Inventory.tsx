// Trading and Liquidity, two of the Wallet tab's panes: what the account holds beyond its
// balance. INJ orderbook trading accounts with their positions (their free coins move back to
// the balance from here), and Choice XYK shares and CLMM positions, each read from the chain.
// Liquidity is shown, not managed: adding and removing it happens on Choice.

import { formatShort, shortDenom } from "@choice-wallet/chain";

import { Callout, shortAddress } from "./kit";
import { useKept } from "./kept";
import type { SendReview, TokenInfo } from "./protocol";
import { useRequest } from "./request";

function amount(tokens: Record<string, TokenInfo>, denom: string, base: string): string {
  const t = tokens[denom];
  return t ? `${formatShort(base, t.decimals, 6)} ${t.symbol}` : `${base} ${shortDenom(denom)}`;
}

const skeleton = [0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 64 }} />);

/** The account's INJ orderbook trading accounts: what each holds, what backs open orders, and
 *  its positions. */
export function TradingPane({ canSign, onReview }: { canSign: boolean; onReview: (r: SendReview) => void }) {
  const { run, error, busy } = useRequest();
  const { value: inv, error: problem } = useKept({ type: "inventory" });

  async function withdraw(nonce: number) {
    const r = await run({ type: "prepare_subaccount_withdraw", nonce });
    if (r) onReview(r);
  }

  const t = inv?.tokens ?? {};
  return (
    <>
      {problem && <Callout level="amber">{problem}</Callout>}
      {error && <Callout level="red">{error}</Callout>}
      {!inv && !problem && skeleton}
      {inv && inv.subaccounts.length === 0 && <p className="empty">Nothing in INJ orderbook trading accounts.</p>}
      {inv?.subaccounts.map((s) => {
        const free = s.deposits.some((d) => BigInt(d.available) > 0n);
        return (
          <div key={s.id} className="well rows">
            <div className="row">
              <span className="symbol">{s.nonce === 0 ? "Default trading account" : `Trading account ${s.nonce}`}</span>
              <span className="meta mono" title={s.id}>
                {shortAddress(s.id)}
              </span>
            </div>
            {s.deposits.map((d) => (
              <div className="row" key={d.denom}>
                <span>{amount(t, d.denom, d.total)}</span>
                <span className="meta">{d.available === d.total ? "free" : `${amount(t, d.denom, d.available)} free`}</span>
              </div>
            ))}
            {s.positions.map((p) => (
              <div className="row" key={p.marketId}>
                <span title={p.marketId}>
                  {p.long ? "Long" : "Short"} {p.quantity.replace(/\.?0+$/, "")} <span className="meta">· {shortAddress(p.marketId)}</span>
                </span>
                <span className="meta" style={{ whiteSpace: "nowrap" }}>
                  Margin {p.margin.replace(/\.?0+$/, "")}
                </span>
              </div>
            ))}
            {canSign && free && (
              <button type="button" className="btn" disabled={busy} onClick={() => void withdraw(s.nonce)}>
                Move to wallet
              </button>
            )}
          </div>
        );
      })}
      <p className="footnote">Read from the chain. What backs open orders stays until they close.</p>
    </>
  );
}

/** The account's liquidity on Choice: XYK pool shares and CLMM positions. */
export function LiquidityPane() {
  const { value: inv, error: problem } = useKept({ type: "inventory" });
  const t = inv?.tokens ?? {};
  return (
    <>
      {problem && <Callout level="amber">{problem}</Callout>}
      {!inv && !problem && skeleton}
      {inv && inv.xyk.length === 0 && inv.clmm.length === 0 && <p className="empty">No liquidity in Choice pools.</p>}
      {inv?.xyk.map((x) => (
        <div key={x.pool} className="well rows">
          <div className="row">
            <span className="symbol">{x.assets.map((a) => t[a.denom]?.symbol ?? shortDenom(a.denom)).join(" / ")}</span>
            <span className="meta mono" title={x.pool}>
              XYK · {shortAddress(x.pool)}
            </span>
          </div>
          {x.assets.map((a) => (
            <div className="row" key={a.denom}>
              <span>{amount(t, a.denom, a.amount)}</span>
            </div>
          ))}
          <span className="meta">Your share: {((Number(x.amount) / Number(x.totalShare)) * 100).toPrecision(3)}% of the pool</span>
        </div>
      ))}
      {inv?.clmm.map((c) => (
        <div key={c.id} className="well rows">
          <div className="row">
            <span className="symbol">
              {t[c.token0]?.symbol ?? shortDenom(c.token0)} / {t[c.token1]?.symbol ?? shortDenom(c.token1)}
            </span>
            <span className={c.inRange ? "meta" : "meta warn"}>{c.inRange ? "In range" : "Out of range"}</span>
          </div>
          <div className="row">
            <span>{amount(t, c.token0, c.amount0)}</span>
            <span>{amount(t, c.token1, c.amount1)}</span>
          </div>
          {(BigInt(c.owed0) > 0n || BigInt(c.owed1) > 0n) && (
            <div className="row">
              <span className="meta">Fees to collect</span>
              <span className="meta">
                {amount(t, c.token0, c.owed0)} · {amount(t, c.token1, c.owed1)}
              </span>
            </div>
          )}
          <span className="meta mono" title={c.pool}>
            CLMM #{c.id} · ticks {c.tickLower} to {c.tickUpper} · {shortAddress(c.pool)}
          </span>
        </div>
      ))}
      <p className="footnote">Amounts are estimates from each pool&apos;s price. Add or remove liquidity on Choice.</p>
    </>
  );
}
