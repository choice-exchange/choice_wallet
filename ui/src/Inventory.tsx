// Trading and liquidity: what the account holds beyond its balance. INJ orderbook trading
// accounts (their free coins move back to the balance from here), Choice XYK shares and
// CLMM positions, each read from the chain. Liquidity is shown, not managed: adding and
// removing it happens on Choice.

import { formatShort, shortDenom } from "@choice-wallet/chain";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import { useKept } from "./kept";
import type { SendReview, TokenInfo } from "./protocol";
import { useRequest } from "./request";

function amount(tokens: Record<string, TokenInfo>, denom: string, base: string): string {
  const t = tokens[denom];
  return t ? `${formatShort(base, t.decimals, 6)} ${t.symbol}` : `${base} ${shortDenom(denom)}`;
}

export function InventoryScreen({ canSign, onReview, onBack }: { canSign: boolean; onReview: (r: SendReview) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  const { value: inv, error: problem } = useKept({ type: "inventory" });

  async function withdraw(nonce: number) {
    const r = await run({ type: "prepare_subaccount_withdraw", nonce });
    if (r) onReview(r);
  }

  const t = inv?.tokens ?? {};
  const empty = inv && inv.subaccounts.length === 0 && inv.xyk.length === 0 && inv.clmm.length === 0;
  return (
    <Screen top={<BackBar title="Trading and liquidity" onBack={onBack} />}>
      {problem && <Callout level="amber">{problem}</Callout>}
      {error && <Callout level="red">{error}</Callout>}
      {!inv && !problem && <p className="meta">Looking on chain…</p>}
      {empty && <p className="empty">Nothing in trading accounts or Choice liquidity.</p>}

      {inv && inv.subaccounts.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Trading accounts</span>
            <span className="meta">INJ orderbook</span>
          </div>
          {inv.subaccounts.map((s) => {
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
                    <span>
                      {p.long ? "Long" : "Short"} {p.quantity.replace(/\.?0+$/, "")} · market {shortAddress(p.marketId)}
                    </span>
                    <span className="meta">margin {p.margin.replace(/\.?0+$/, "")}</span>
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
        </>
      )}

      {inv && (inv.xyk.length > 0 || inv.clmm.length > 0) && (
        <div className="section-head">
          <span className="eyebrow">Liquidity on Choice</span>
        </div>
      )}
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
      <p className="footnote">Read from the chain. Liquidity amounts are estimates from the pool&apos;s price; add or remove it on Choice.</p>
    </Screen>
  );
}
