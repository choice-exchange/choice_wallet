// Accounts: the ones from the recovery phrase, and addresses to watch. Tapping one makes it
// the account in use, for the wallet and for connected sites. Edit renames them, and drops
// any but the first (the keystore's own); a dropped phrase account comes back as the same
// address when added again.

import { useState, type FormEvent } from "react";

import { CheckIcon, CloseIcon, EyeIcon, PlusIcon } from "./icons";
import { BackBar, Screen, shortAddress } from "./kit";
import type { AccountInfo, Status } from "./protocol";
import { useRequest } from "./request";

const COSMOS = "cosmos:injective-1";

export const isWatch = (a: AccountInfo | undefined) => a?.account.derivation === "watch";

export function AccountsView({ status, onStatus, onBack }: { status: Status; onStatus: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  const [editing, setEditing] = useState(false);
  const [watching, setWatching] = useState(false);
  const phrase = status.kind === "mnemonic";

  const use = async (index: number) => {
    const s = await run({ type: "switch_account", index });
    if (s) {
      onStatus(s);
      onBack();
    }
  };

  return (
    <Screen
      top={
        <>
          <BackBar title="Accounts" onBack={onBack} />
          <button className="pill" onClick={() => setEditing((e) => !e)}>
            {editing ? "Done" : "Edit"}
          </button>
        </>
      }
    >
      {error && <p className="error">{error}</p>}
      <div className="token-list">
        {status.accounts.map((a, i) =>
          editing ? (
            <EditRow key={a.addresses[COSMOS]} a={a} index={i} onStatus={onStatus} />
          ) : (
            <button key={a.addresses[COSMOS]} className="token account-row" disabled={busy} onClick={() => void use(i)} aria-current={i === status.active ? "true" : undefined}>
              <AccountMark a={a} index={i} />
              <span className="name">
                <span className="symbol">
                  {a.name}
                  {isWatch(a) && <span className="flag quiet">Watch-only</span>}
                </span>
                <span className="sub denom">{shortAddress(a.addresses[COSMOS] ?? "")}</span>
              </span>
              <span className="value">{i === status.active && <CheckIcon size={18} />}</span>
            </button>
          ),
        )}
      </div>
      {!editing && (
        <>
          {phrase && (
            <button
              className="hidden-row"
              disabled={busy}
              onClick={() =>
                void run({ type: "add_account" }).then((s) => {
                  if (s) {
                    onStatus(s);
                    onBack();
                  }
                })
              }
            >
              <PlusIcon size={16} />
              Add an account
            </button>
          )}
          {watching ? (
            <WatchForm
              onDone={(s) => {
                onStatus(s);
                onBack();
              }}
              onCancel={() => setWatching(false)}
            />
          ) : (
            <button className="hidden-row" onClick={() => setWatching(true)}>
              <EyeIcon size={16} />
              Watch an address
            </button>
          )}
        </>
      )}
      <p className="footnote">{phrase ? "New accounts come from your recovery phrase." : "This wallet is one imported key."}</p>
    </Screen>
  );
}

/** A round mark with the account's first letter; an eye for a watched address. */
export function AccountMark({ a, index }: { a: AccountInfo; index: number }) {
  return (
    <span className={`mark account-mark tone-${index % 4}`} aria-hidden="true">
      {isWatch(a) ? <EyeIcon size={16} /> : (a.name.trim()[0] ?? "A").toUpperCase()}
    </span>
  );
}

function EditRow({ a, index, onStatus }: { a: AccountInfo; index: number; onStatus: (s: Status) => void }) {
  const { run, error, busy } = useRequest();
  const [name, setName] = useState(a.name);
  const save = async () => {
    if (name.trim() === a.name) return;
    const s = await run({ type: "rename_account", index, name });
    if (s) onStatus(s);
    else setName(a.name);
  };
  return (
    <div className="token manage account-row">
      <AccountMark a={a} index={index} />
      <span className="name">
        <input
          className="input"
          aria-label={`Name of ${a.name}`}
          maxLength={24}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {error && <span className="error">{error}</span>}
      </span>
      <span className="value" />
      {index === 0 ? (
        <span className="icon-btn" aria-hidden="true" />
      ) : (
        <button
          className="icon-btn"
          aria-label={`Remove ${a.name}`}
          disabled={busy}
          onClick={() => void run({ type: "remove_account", index }).then((s) => s && onStatus(s))}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

function WatchForm({ onDone, onCancel }: { onDone: (s: Status) => void; onCancel: () => void }) {
  const { run, error, busy } = useRequest();
  const [address, setAddress] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const s = await run({ type: "add_watch", address: address.trim() });
    if (s) onDone(s);
  }
  return (
    <form className="well add-token" onSubmit={(e) => void submit(e)}>
      <div className="eyebrow">Watch an address</div>
      <input
        className="input mono"
        placeholder="inj1… or 0x…"
        aria-label="Address to watch"
        spellCheck={false}
        autoFocus
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <span className="meta">See its balances and activity. It can't sign.</span>
      <div className="add-token-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-gold" disabled={busy || !address.trim()}>
          {busy ? "Checking…" : "Watch"}
        </button>
      </div>
    </form>
  );
}
