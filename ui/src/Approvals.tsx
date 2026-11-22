// Approvals and grants: what this account lets others do (spend its tokens, act for it, pay
// fees from it, take its staking rewards, move its NFTs), and taking it back. Cosmos-side
// revokes can go in one transaction; each EVM permission is its own. Injective by default;
// another EVM chain when the user picks it (only then is its index asked about the account).

import { formatShort } from "@choice-wallet/chain";
import { useState } from "react";

import { useKept } from "./kept";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import { canMoveFunds, permissionName } from "./permissions";
import type { Coin, EvmRevokeKind, RevokeItem, SendReview } from "./protocol";
import { useRequest } from "./request";

/** Permit2: one address on every chain. */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Allowances from 2^128 up read as unlimited, as in Activity. */
const UNLIMITED = 2n ** 128n;

const until = (iso: string | null) => (iso ? `until ${new Date(iso).toLocaleDateString()}` : "no end date");

export function ApprovalsView({ canSign, onReview, onBack }: { canSign: boolean; onReview: (review: SendReview) => void; onBack: () => void }) {
  const { run, error: actError, busy } = useRequest();
  const [chain, setChain] = useState<string | undefined>(undefined);
  const { value: kept, error: loadError } = useKept(chain ? { type: "approvals", chain } : { type: "approvals" });
  // What another chain's answer said, until this chain's comes.
  const s = kept && kept.chain === chain ? kept : null;
  const error = actError ?? (s ? null : loadError);

  const revoke = async (items: RevokeItem[]) => {
    const r = await run({ type: "prepare_revoke", items });
    if (r) onReview(r);
  };
  const revokeErc20 = async (token: string, spender: string) => {
    const r = chain ? await run({ type: "prepare_revoke_evm", chain, kind: "erc20", contract: token.slice(4), spender }) : await run({ type: "prepare_revoke_erc20", token, spender });
    if (r) onReview(r);
  };
  const revokeEvm = async (kind: EvmRevokeKind, contract: string, more: { spender?: string; token?: string; token_id?: string }) => {
    const r = await run({ type: "prepare_revoke_evm", ...(chain ? { chain } : {}), kind, contract, ...more });
    if (r) onReview(r);
  };
  // The chains to look at: Injective, and each other EVM chain with a history index.
  const chainTabs = (list: { key: string; name: string }[]) =>
    list.length > 0 && (
      <div className="pill-tabs chain-tabs" role="tablist" aria-label="Chain">
        {[{ key: "", name: "Injective" }, ...list].map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={(chain ?? "") === c.key} className={(chain ?? "") === c.key ? "pill pill-gold" : "pill"} onClick={() => setChain(c.key || undefined)}>
            {c.name}
          </button>
        ))}
      </div>
    );

  if (!s) {
    return (
      <Screen top={<BackBar title="Approvals" onBack={onBack} />}>
        {kept && chainTabs(kept.chains)}
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
    ...s.cw721Operators.map((o) => ({ type: "cw721_all" as const, contract: o.collection, operator: o.operator })),
    ...s.cw721Approvals.map((a) => ({ type: "cw721_token" as const, contract: a.collection, spender: a.spender, token_id: a.tokenId })),
  ].slice(0, 30);
  const nothing =
    !s.rewardsTo &&
    s.grants.length === 0 &&
    s.feeGrants.length === 0 &&
    s.cw20.length === 0 &&
    s.erc20.length === 0 &&
    s.cw721Operators.length === 0 &&
    s.cw721Approvals.length === 0 &&
    s.nftOperators.length === 0 &&
    s.nftApprovals.length === 0 &&
    s.permit2.length === 0;
  const date = (t: number) => new Date(t * 1000).toLocaleDateString();
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
      {chainTabs(s.chains)}
      {error && <Callout level="red">{error}</Callout>}
      {nothing && <p className="empty">Nothing found.</p>}
      {s.unchecked.length > 0 && <p className="meta warn">Not checked here: {s.unchecked.join(", ")}.</p>}

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

      {(s.nftOperators.length > 0 || s.nftApprovals.length > 0 || s.cw721Operators.length > 0 || s.cw721Approvals.length > 0) && (
        <>
          <div className="section-head">
            <span className="eyebrow">NFT approvals</span>
          </div>
          <div className="token-list">
            {s.cw721Operators.map((o, i) => (
              <div key={`co${i}`} className="token approval-row" title={o.collection}>
                <span className="name">
                  <span className="symbol danger-text">All NFTs in {shortAddress(o.collection)}</span>
                  <span className="sub">{shortAddress(o.operator)} may move every one</span>
                </span>
                {pill(`Revoke ${o.operator}'s access to ${o.collection}`, () => void revoke([{ type: "cw721_all", contract: o.collection, operator: o.operator }]))}
              </div>
            ))}
            {s.cw721Approvals.map((a, i) => (
              <div key={`ca${i}`} className="token approval-row" title={a.collection}>
                <span className="name">
                  <span className="symbol">NFT #{a.tokenId.length > 12 ? `${a.tokenId.slice(0, 10)}…` : a.tokenId}</span>
                  <span className="sub">
                    {shortAddress(a.spender)} may move it · {shortAddress(a.collection)}
                  </span>
                </span>
                {pill(`Clear the approval on NFT ${a.tokenId} of ${a.collection}`, () => void revoke([{ type: "cw721_token", contract: a.collection, spender: a.spender, token_id: a.tokenId }]))}
              </div>
            ))}
            {s.nftOperators.map((o, i) => (
              <div key={`o${i}`} className="token approval-row" title={o.collection}>
                <span className="name">
                  <span className="symbol danger-text">All NFTs in {shortAddress(o.collection)}</span>
                  <span className="sub">{shortAddress(o.operator)} may move every one</span>
                </span>
                {pill(`Revoke ${o.operator}'s access to ${o.collection}`, () => void revokeEvm("nft_all", o.collection, { spender: o.operator }))}
              </div>
            ))}
            {s.nftApprovals.map((t, i) => (
              <div key={`n${i}`} className="token approval-row" title={t.collection}>
                <span className="name">
                  <span className="symbol">NFT #{t.tokenId.length > 12 ? `${t.tokenId.slice(0, 10)}…` : t.tokenId}</span>
                  <span className="sub">
                    {shortAddress(t.approved)} may move it · {shortAddress(t.collection)}
                  </span>
                </span>
                {pill(`Clear the approval on NFT ${t.tokenId} of ${t.collection}`, () => void revokeEvm("nft_token", t.collection, { token_id: t.tokenId }))}
              </div>
            ))}
          </div>
        </>
      )}

      {s.permit2.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Permit2 allowances</span>
          </div>
          <div className="token-list">
            {s.permit2.map((p, i) => (
              <div key={`p${i}`} className="token approval-row" title={p.token}>
                <span className="name">
                  <span className={BigInt(p.amount) >= UNLIMITED ? "symbol danger-text" : "symbol"}>{symbol(p.token)}</span>
                  <span className="sub">
                    {shortAddress(p.spender)} may take {amount(p.token, p.amount)} until {date(p.expiration)}
                  </span>
                </span>
                {pill(`Revoke ${symbol(p.token)} Permit2 allowance for ${p.spender}`, () => void revokeEvm("permit2", PERMIT2, { token: p.token.slice(4), spender: p.spender }))}
              </div>
            ))}
          </div>
        </>
      )}

      {s.evmIndexDown && <p className="meta warn">The EVM index didn&apos;t answer, so EVM permissions may be missing.</p>}
      {s.evmDown && <p className="meta warn">No EVM endpoint answered, so EVM permissions weren&apos;t checked.</p>}
      <p className="footnote">EVM permissions are found through the chain&apos;s history index and checked on your endpoint. Each is its own transaction.</p>
    </Screen>
  );
}
