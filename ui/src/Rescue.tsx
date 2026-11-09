// The rescue address: where this account's funds go if its key is ever lost or stolen, set
// ahead of time, with gas from it so a rescue works even after a thief takes the INJ.
// "Rescue now" moves what one transaction can: rewards and every stake (at once, no
// unbonding wait), permissions this account gave, CW20s and bank tokens.

import { formatShort } from "@choice-wallet/chain";
import { useEffect, useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { BackBar, Callout, Screen, shortAddress } from "./kit";
import type { AccountInfo, RescueSummary, SendReview, Status } from "./protocol";
import { useRequest } from "./request";

const COSMOS = "cosmos:injective-1";

export function RescueView({ status, onReview, onBack }: { status: Status; onReview: (review: SendReview) => void; onBack: () => void }) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [summary, setSummary] = useState<RescueSummary | null>(null);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState("");
  const me = status.accounts[status.active];
  const watch = me?.account.derivation === "watch";

  useEffect(() => {
    void backend.send({ type: "rescue" }).then((r) => r.ok && setSummary(r.result));
  }, []);

  async function choose(address: string | null) {
    const r = await run({ type: "set_rescue", address });
    if (r) {
      setPicking(false);
      setTyped("");
      const fresh = await backend.send({ type: "rescue" });
      setSummary(fresh.ok ? fresh.result : r);
    }
  }

  async function grant() {
    const r = await run({ type: "prepare_rescue_grant" });
    if (r) onReview(r);
  }

  async function rescue() {
    const r = await run({ type: "prepare_rescue" });
    if (r) onReview(r);
  }

  if (picking || (summary && !summary.address)) {
    // Ledger accounts first: the best place to rescue to.
    const others = status.accounts
      .filter((a) => a !== me && a.account.derivation !== "watch")
      .sort((a, b) => Number(b.account.derivation === "ledger") - Number(a.account.derivation === "ledger"));
    const submit = (e: FormEvent) => {
      e.preventDefault();
      void choose(typed.trim());
    };
    return (
      <Screen top={<BackBar title="Rescue address" onBack={summary?.address ? () => setPicking(false) : onBack} />}>
        <p className="lead">If this account&apos;s key is ever lost or stolen, its funds go here in one transaction.</p>
        <Callout level="info">Pick an account whose key lives somewhere else, ideally a Ledger.</Callout>
        {others.length > 0 && (
          <div className="token-list">
            {others.map((a) => (
              <AccountRow key={a.addresses[COSMOS]} a={a} wallet={status.wallets.find((w) => w.id === a.wallet)?.name ?? ""} busy={busy} onPick={() => void choose(a.addresses[COSMOS] ?? "")} />
            ))}
          </div>
        )}
        <form className="well add-token" onSubmit={submit}>
          <input className="input mono" placeholder="Or an address: inj1… or 0x…" aria-label="Rescue address" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {error && <p className="error">{error}</p>}
          <button className="btn btn-gold" disabled={busy || !typed.trim()}>
            Use this address
          </button>
        </form>
      </Screen>
    );
  }

  const gas = summary?.gas;
  return (
    <Screen
      top={<BackBar title="Rescue" onBack={onBack} />}
      foot={
        summary?.address && !watch ? (
          <>
            {error && <Callout level="red">{error}</Callout>}
            <button className="btn btn-danger" disabled={busy} onClick={() => void rescue()}>
              {busy ? "Checking…" : "Rescue now"}
            </button>
          </>
        ) : undefined
      }
    >
      {!summary && <p className="meta">Loading…</p>}
      {summary?.address && (
        <>
          <div className="surface-hero">
            <div className="eyebrow">Rescue address</div>
            <div className="symbol" style={{ marginTop: 6 }}>
              {summary.name ?? "An address outside this wallet"}
            </div>
            <code className="mono" style={{ display: "block", marginTop: 6, wordBreak: "break-all" }}>
              {summary.address}
            </code>
            <button type="button" className="pill" style={{ marginTop: 10 }} onClick={() => setPicking(true)}>
              Change
            </button>
          </div>
          <div className="well rows">
            <div className="row">
              <span>Gas for a rescue</span>
              <span className="num">{gas ? `Up to ${gas.limit.map((c) => `${formatShort(c.amount, 18, 4)} INJ`).join(" + ")}` : "None"}</span>
            </div>
          </div>
          {gas && !gas.current && summary.canGrant ? (
            <>
              <span className="meta">This gas doesn&apos;t cover every rescue message (unstaking). Renew it from {summary.name}.</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void grant()}>
                Renew gas from {summary.name}
              </button>
            </>
          ) : gas ? (
            <span className="meta">The rescue address pays a rescue&apos;s fee if this account has no INJ left. It pays for rescue messages only.</span>
          ) : summary.canGrant ? (
            <>
              <span className="meta">A thief usually takes the INJ first. Gas from the rescue address keeps a rescue possible: up to 0.1 INJ, for rescue messages only.</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void grant()}>
                Give gas from {summary.name}
              </button>
            </>
          ) : (
            <span className="meta">To give gas for a rescue, add the rescue address&apos;s wallet here, or grant it from that wallet.</span>
          )}
          <Callout level="amber">
            {summary.stakesMove
              ? "Rescue now moves stakes at once, rewards, CW20s and bank tokens, and takes back permissions this account gave."
              : "Rescue now sends CW20s and bank tokens, sends rewards there from now on, starts unstaking everything (it returns here in 21 days: move it then), and takes back permissions this account gave."}{" "}
            NFTs and EVM-only tokens stay.
          </Callout>
        </>
      )}
    </Screen>
  );
}

function AccountRow({ a, wallet, busy, onPick }: { a: AccountInfo; wallet: string; busy: boolean; onPick: () => void }) {
  return (
    <button className="token" disabled={busy} onClick={onPick}>
      <span className="nft-tile small" aria-hidden="true">
        {a.account.derivation === "ledger" ? "LG" : a.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="name">
        <span className="symbol">{a.name}</span>
        <span className="sub denom">
          {wallet} · {shortAddress(a.addresses[COSMOS] ?? "")}
        </span>
      </span>
    </button>
  );
}
