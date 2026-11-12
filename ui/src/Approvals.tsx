// Approvals and grants: what this account lets others do (spend its tokens, act for it, pay
// fees from it, take its staking rewards), and taking it back. Cosmos-side revokes can go in
// one transaction; each ERC20 allowance is its own.

import { formatShort } from "@choice-wallet/chain";

import { useKept } from "./kept";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import { canMoveFunds, permissionName } from "./permissions";
import type { Coin, RevokeItem, SendReview } from "./protocol";
import { useRequest } from "./request";

/** Allowances from 2^128 up read as unlimited, as in Activity. */
const UNLIMITED = 2n ** 128n;

const until = (iso: string | null) => (iso ? `until ${new Date(iso).toLocaleDateString()}` : "no end date");

export function ApprovalsView({ canSign, onReview, onBack }: { canSign: boolean; onReview: (review: SendReview) => void; onBack: () => void }) {
  const { run, error: actError, busy } = useRequest();
  const { value: s, error: loadError } = useKept({ type: "approvals" });
  const error = actError ?? (s ? null : loadError);

  const revoke = async (items: RevokeItem[]) => {
    const r = await run({ type: "prepare_revoke", items });
    if (r) onReview(r);
  };
  const revokeErc20 = async (token: string, spender: string) => {
    const r = await run({ type: "prepare_revoke_erc20", token, spender });
    if (r) onReview(r);
  };

  if (!s) {
    return (
      <Screen top={<BackBar title="Approvals" onBack={onBack} />}>
        {error ? <Callout level="amber">{error}</Callout> : [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}
      </Screen>
    );
  }

  const symbol = (key: string) => s.tokens[key]?.symbol ?? shortAddress(key.replace(/^(cw20|evm):/, ""));
  const amount = (key: string, a: string) => {
    if (BigInt(a) >= UNLIMITED) return "Unlimited";
    const t = s.tokens[key];
    return t ? `${formatShort(a, t.decimals, 4)} ${t.symbol}` : a;
  };
  const coins = (cs: Coin[]) => cs.map((c) => (c.denom === "inj" ? `${formatShort(c.amount, 18, 4)} INJ` : `${c.amount} ${c.denom}`)).join(", ");

  // Everything on the Cosmos side, for "Revoke all".
  const all: RevokeItem[] = [
    ...(s.rewardsTo ? [{ type: "rewards" as const }] : []),
    ...s.grants.filter((g) => g.msgTypeUrl).map((g) => ({ type: "authz" as const, grantee: g.grantee, msg_type_url: g.msgTypeUrl! })),
    ...s.feeGrants.map((g) => ({ type: "fee" as const, grantee: g.grantee })),
    ...s.cw20.map((a) => ({ type: "cw20" as const, contract: a.token.slice(5), spender: a.spender })),
  ].slice(0, 30);
  const nothing = !s.rewardsTo && s.grants.length === 0 && s.feeGrants.length === 0 && s.cw20.length === 0 && s.erc20.length === 0;
  const pill = (label: string, onClick: () => void) =>
    canSign && (
      <button type="button" className="pill" disabled={busy} aria-label={label} onClick={onClick}>
        Revoke
      </button>
    );

  return (
    <Screen
      top={<BackBar title="Approvals" onBack={onBack} />}
      foot={
        canSign &&
        all.length > 1 && (
          <button className="btn btn-danger" disabled={busy} onClick={() => void revoke(all)}>
            {busy ? "Checking…" : `Revoke all ${all.length}`}
          </button>
        )
      }
    >
      {error && <Callout level="red">{error}</Callout>}
      {nothing && <p className="empty">Nothing here. No one can spend from or act for this account.</p>}

      {s.rewardsTo && (
        <Callout level="red">
          <div>Your staking rewards go to {shortAddress(s.rewardsTo)}.</div>
          {canSign && (
            <button type="button" className="pill" disabled={busy} style={{ marginTop: 8 }} onClick={() => void revoke([{ type: "rewards" }])}>
              Send them here again
            </button>
          )}
        </Callout>
      )}

      {s.grants.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Permissions</span>
          </div>
          <div className="token-list">
            {s.grants.map((g, i) => (
              <div key={`g${i}`} className="token approval-row">
                <span className="name">
                  <span className={canMoveFunds(g.msgTypeUrl) ? "symbol danger-text" : "symbol"}>{g.msgTypeUrl ? permissionName(g.msgTypeUrl) : "A permission the wallet can't read"}</span>
                  <span className="sub">
                    {shortAddress(g.grantee)} · {g.spendLimit?.length ? `up to ${coins(g.spendLimit)}, ` : ""}
                    {until(g.expiration)}
                  </span>
                </span>
                {g.msgTypeUrl ? pill(`Revoke ${permissionName(g.msgTypeUrl)} for ${g.grantee}`, () => void revoke([{ type: "authz", grantee: g.grantee, msg_type_url: g.msgTypeUrl! }])) : null}
              </div>
            ))}
          </div>
        </>
      )}

      {s.feeGrants.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Fee allowances</span>
          </div>
          <div className="token-list">
            {s.feeGrants.map((g, i) => (
              <div key={`f${i}`} className="token approval-row">
                <span className="name">
                  <span className="symbol">Pays fees from your INJ</span>
                  <span className="sub">
                    {shortAddress(g.grantee)} · {g.spendLimit.length ? `up to ${coins(g.spendLimit)}` : "no limit"}, {until(g.expiration)}
                  </span>
                </span>
                {pill(`Revoke fee allowance for ${g.grantee}`, () => void revoke([{ type: "fee", grantee: g.grantee }]))}
              </div>
            ))}
          </div>
        </>
      )}

      {(s.cw20.length > 0 || s.erc20.length > 0) && (
        <>
          <div className="section-head">
            <span className="eyebrow">Token allowances</span>
          </div>
          <div className="token-list">
            {s.cw20.map((a, i) => (
              <div key={`c${i}`} className="token approval-row" title={a.token}>
                <span className="name">
                  <span className="symbol">{symbol(a.token)}</span>
                  <span className="sub">
                    {shortAddress(a.spender)} may take {amount(a.token, a.amount)}
                  </span>
                </span>
                {pill(`Revoke ${symbol(a.token)} allowance for ${a.spender}`, () => void revoke([{ type: "cw20", contract: a.token.slice(5), spender: a.spender }]))}
              </div>
            ))}
            {s.erc20.map((a, i) => (
              <div key={`e${i}`} className="token approval-row" title={a.token}>
                <span className="name">
                  <span className={BigInt(a.amount) >= UNLIMITED ? "symbol danger-text" : "symbol"}>{symbol(a.token)}</span>
                  <span className="sub">
                    {shortAddress(a.spender)} may take {amount(a.token, a.amount)}
                  </span>
                </span>
                {pill(`Revoke ${symbol(a.token)} allowance for ${a.spender}`, () => void revokeErc20(a.token, a.spender))}
              </div>
            ))}
          </div>
        </>
      )}

      {s.evmIndexDown && <p className="meta warn">Blockscout didn&apos;t answer, so ERC20 allowances may be missing.</p>}
      {s.evmDown && <p className="meta warn">No EVM endpoint answered, so ERC20 allowances weren&apos;t checked.</p>}
      <p className="footnote">ERC20 allowances are found through Blockscout and checked on your EVM endpoint. Each is its own transaction.</p>
    </Screen>
  );
}
