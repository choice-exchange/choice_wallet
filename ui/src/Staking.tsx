// Staking: what is staked with which validator, rewards waiting to be claimed, what is
// unstaking and when it returns. Actions (stake, unstake, move, claim, cancel an unstaking)
// go to the same review screen as a send.

import { formatShort, parseUnits } from "@choice-wallet/chain";
import { useMemo, useState, type FormEvent } from "react";

import { BackBar, Callout, Screen, shortAddress } from "./kit";
import type { SendReview, StakeRequest, StakingSummary, ValidatorInfo } from "./protocol";
import { useRequest } from "./request";

const DECIMALS = 18;
const inj = (a: string | bigint) => `${formatShort(a, DECIMALS, 4)} INJ`;
const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;

type Sub =
  | { name: "main" }
  | { name: "stake"; validator: string }
  | { name: "pick"; purpose: "stake" | "move"; from?: string }
  | { name: "amount"; action: "stake" | "unstake" | "move"; validator: string; to?: string };

export function StakingView({
  summary,
  canSign,
  onReview,
  onBack,
}: {
  summary: StakingSummary;
  canSign: boolean;
  onReview: (review: SendReview, names: Record<string, string>) => void;
  onBack: () => void;
}) {
  const [sub, setSub] = useState<Sub>({ name: "main" });
  const { run, error, busy } = useRequest();
  const byAddress = useMemo(() => new Map(summary.validators.map((v) => [v.address, v])), [summary]);
  const names = useMemo(() => Object.fromEntries(summary.validators.map((v) => [v.address, v.moniker])), [summary]);
  const name = (a: string) => byAddress.get(a)?.moniker || shortAddress(a);
  const prepare = async (req: StakeRequest) => {
    const r = await run({ type: "prepare_stake", ...req });
    if (r) onReview(r, names);
  };

  if (sub.name === "pick") {
    return (
      <ValidatorPicker
        validators={summary.validators.filter((v) => v.active && !v.jailed && v.address !== sub.from)}
        title={sub.purpose === "move" ? "Move to" : "Pick a validator"}
        onPick={(v) => setSub(sub.purpose === "move" ? { name: "amount", action: "move", validator: sub.from!, to: v } : { name: "amount", action: "stake", validator: v })}
        onBack={() => setSub(sub.from ? { name: "stake", validator: sub.from } : { name: "main" })}
      />
    );
  }
  if (sub.name === "amount") {
    const staked = summary.stakes.find((s) => s.validator === sub.validator)?.amount ?? "0";
    return (
      <AmountForm
        action={sub.action}
        validator={name(sub.action === "move" ? sub.to! : sub.validator)}
        from={sub.action === "move" ? name(sub.validator) : undefined}
        available={sub.action === "stake" ? null : staked}
        busy={busy}
        error={error}
        onSubmit={(amount) =>
          void prepare(sub.action === "move" ? { action: "move", validator: sub.validator, to: sub.to!, amount } : { action: sub.action, validator: sub.validator, amount })
        }
        onBack={() => setSub(sub.action === "stake" && !summary.stakes.some((s) => s.validator === sub.validator) ? { name: "pick", purpose: "stake" } : { name: "stake", validator: sub.validator })}
      />
    );
  }
  if (sub.name === "stake") {
    const s = summary.stakes.find((x) => x.validator === sub.validator);
    const v = byAddress.get(sub.validator);
    return (
      <Screen top={<BackBar title={name(sub.validator)} onBack={() => setSub({ name: "main" })} />}>
        {error && <Callout level="red">{error}</Callout>}
        <div className="surface-hero">
          <div className="eyebrow">Staked</div>
          <div className="hero">{inj(s?.amount ?? "0")}</div>
          <div className="meta">Rewards {inj(s?.rewards ?? "0")}</div>
        </div>
        {v && <ValidatorFacts v={v} />}
        {canSign && (
          <div className="well rows">
            {v?.active && !v.jailed && (
              <button className="row link-row" onClick={() => setSub({ name: "amount", action: "stake", validator: sub.validator })}>
                Stake more
              </button>
            )}
            <button className="row link-row" disabled={!s} onClick={() => setSub({ name: "amount", action: "unstake", validator: sub.validator })}>
              Unstake
            </button>
            <button className="row link-row" disabled={!s} onClick={() => setSub({ name: "pick", purpose: "move", from: sub.validator })}>
              Move to another validator
            </button>
            <button className="row link-row" disabled={busy || !s || s.rewards === "0"} onClick={() => void prepare({ action: "claim", validator: sub.validator })}>
              Claim rewards
            </button>
          </div>
        )}
        <p className="footnote">Unstaking takes {summary.unbondingDays} days. Moving is instant.</p>
      </Screen>
    );
  }

  return (
    <Screen top={<BackBar title="Staking" onBack={onBack} />}>
      {error && <Callout level="red">{error}</Callout>}
      <div className="plate-warm">
        <div className="eyebrow">Staked</div>
        <div className="hero" style={{ margin: "4px 0 2px" }}>
          {formatShort(summary.staked, DECIMALS, 4)}
          <span className="unit">INJ</span>
        </div>
        <div className="meta num">Rewards {inj(summary.rewards)}</div>
        {canSign && (
          <div className="actions" style={{ marginTop: 14 }}>
            <button className="action" onClick={() => setSub({ name: "pick", purpose: "stake" })}>
              Stake
            </button>
            <button className="action plain" disabled={busy || summary.rewards === "0"} onClick={() => void prepare({ action: "claim" })}>
              {busy ? "Checking…" : "Claim all"}
            </button>
          </div>
        )}
      </div>
      {summary.stakes.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Your validators</span>
          </div>
          <div className="token-list">
            {summary.stakes.map((s) => {
              const v = byAddress.get(s.validator);
              return (
                <button key={s.validator} className="token" title={s.validator} onClick={() => setSub({ name: "stake", validator: s.validator })}>
                  <span className="name">
                    <span className="symbol">{name(s.validator)}</span>
                    <span className="sub">{v && !v.active ? (v.jailed ? "Jailed, earns nothing" : "Inactive, earns nothing") : `Rewards ${inj(s.rewards)}`}</span>
                  </span>
                  <span className="value">
                    <span className="amount">{inj(s.amount)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {summary.unbonding.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Unstaking</span>
          </div>
          <div className="token-list">
            {summary.unbonding.map((u) => (
              <div key={`${u.validator}-${u.height}`} className="token">
                <span className="name">
                  <span className="symbol">{inj(u.amount)}</span>
                  <span className="sub">
                    {name(u.validator)} · back {new Date(u.completes).toLocaleDateString()}
                  </span>
                </span>
                {canSign && (
                  <button className="pill" disabled={busy} onClick={() => void prepare({ action: "cancel", validator: u.validator, height: u.height })}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {summary.stakes.length === 0 && summary.unbonding.length === 0 && <p className="empty">Nothing staked yet. Staked INJ earns rewards.</p>}
      <p className="footnote">Unstaking takes {summary.unbondingDays} days.</p>
    </Screen>
  );
}

function ValidatorFacts({ v }: { v: ValidatorInfo }) {
  return (
    <div className="well rows">
      <div className="row">
        <span>Commission</span>
        <span className="num">{pct(v.commission)}</span>
      </div>
      <div className="row">
        <span>Status</span>
        <span>{v.jailed ? "Jailed" : v.active ? `Active, #${v.rank}` : "Inactive"}</span>
      </div>
      {v.website && (
        <div className="row">
          <span>Website</span>
          <span className="mono">{v.website}</span>
        </div>
      )}
      <div className="row">
        <span>Address</span>
        <span className="mono" title={v.address}>
          {shortAddress(v.address)}
        </span>
      </div>
    </div>
  );
}

function ValidatorPicker({ validators, title, onPick, onBack }: { validators: ValidatorInfo[]; title: string; onPick: (address: string) => void; onBack: () => void }) {
  const [q, setQ] = useState("");
  const total = validators.reduce((a, v) => a + BigInt(v.tokens), 0n);
  const share = (v: ValidatorInfo) => (total > 0n ? Number((BigInt(v.tokens) * 10_000n) / total) / 10_000 : 0);
  const query = q.trim().toLowerCase();
  const list = validators.filter((v) => !query || v.moniker.toLowerCase().includes(query) || v.address === query);
  return (
    <Screen top={<BackBar title={title} onBack={onBack} />}>
      <input className="input" placeholder="Search validators" aria-label="Search validators" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="token-list">
        {list.map((v) => (
          <button key={v.address} className="token" title={v.address} onClick={() => onPick(v.address)}>
            <span className="name">
              <span className="symbol">{v.moniker || shortAddress(v.address)}</span>
              <span className="sub">
                {pct(v.commission)} commission · {pct(share(v))} of stake
              </span>
            </span>
            <span className="value">
              <span className="meta">#{v.rank}</span>
            </span>
          </button>
        ))}
        {list.length === 0 && <p className="empty">No validator by that name.</p>}
      </div>
      <p className="footnote">Validators name themselves. Spreading stake helps the network.</p>
    </Screen>
  );
}

const ACTION_TITLE = { stake: "Stake", unstake: "Unstake", move: "Move stake" } as const;

function AmountForm({
  action,
  validator,
  from,
  available,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  action: "stake" | "unstake" | "move";
  validator: string;
  from: string | undefined;
  /** What can be unstaked or moved; null for staking from the balance. */
  available: string | null;
  busy: boolean;
  error: string | null;
  onSubmit: (amount: string) => void;
  onBack: () => void;
}) {
  const [text, setText] = useState("");
  const [max, setMax] = useState(false);
  let problem: string | null = null;
  let parsed: string | null = null;
  if (max) parsed = "max";
  else if (text.trim()) {
    try {
      const n = parseUnits(text.trim(), DECIMALS);
      if (n <= 0n) problem = "Enter an amount above zero.";
      else if (available !== null && n > BigInt(available)) problem = "That's more than is staked.";
      else parsed = n.toString();
    } catch {
      problem = "Enter a number.";
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed) onSubmit(parsed);
  }
  return (
    <Screen top={<BackBar title={ACTION_TITLE[action]} onBack={onBack} />}>
      <form className="well add-token" onSubmit={submit}>
        <div className="meta">{from ? `From ${from} to ${validator}` : `${action === "stake" ? "With" : "From"} ${validator}`}</div>
        <div className="amount-row">
          <input
            className="input num"
            inputMode="decimal"
            placeholder="0.0"
            aria-label="Amount in INJ"
            value={max ? "" : text}
            onChange={(e) => {
              setMax(false);
              setText(e.target.value);
            }}
          />
          <button type="button" className={max ? "pill active" : "pill"} onClick={() => setMax((m) => !m)}>
            Max
          </button>
        </div>
        {available !== null && <span className="meta">Staked {inj(available)}</span>}
        {max && action === "stake" && <span className="meta">Keeps 0.01 INJ for fees.</span>}
        {(problem || error) && <p className="error">{problem ?? error}</p>}
        <button className="btn btn-gold" disabled={busy || !parsed}>
          {busy ? "Checking…" : "Review"}
        </button>
      </form>
      {action === "unstake" && <p className="footnote">It earns nothing while it unstakes.</p>}
    </Screen>
  );
}
