// Accounts, grouped by the wallet they come from (a recovery phrase or an imported key),
// then the addresses being watched. Tapping one makes it the account in use, for the wallet
// and for connected sites. Edit renames accounts and wallets, drops an account (not a
// wallet's last), shows a wallet's phrase or key, or removes a wallet. "Add a wallet" makes
// or imports another, behind the same password.

import { useState, type FormEvent } from "react";

import { Backup, Confirm, Import } from "./App";
import { CheckIcon, CloseIcon, EyeIcon, PlusIcon } from "./icons";
import { BackBar, Screen, shortAddress } from "./kit";
import type { AccountInfo, NewSecret, Status, WalletInfo } from "./protocol";
import { useBackend } from "./backend";
import { useRequest } from "./request";
import { RemoveWalletView, RevealView } from "./Security";

const COSMOS = "cosmos:injective-1";

export const isWatch = (a: AccountInfo | undefined) => a?.account.derivation === "watch";

type Sub =
  | { name: "list" }
  | { name: "add" }
  | { name: "reveal"; wallet: WalletInfo }
  | { name: "remove"; wallet: WalletInfo };

export function AccountsView({ status, onStatus, onBack }: { status: Status; onStatus: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  const [editing, setEditing] = useState(false);
  const [sub, setSub] = useState<Sub>({ name: "list" });
  const list = () => setSub({ name: "list" });

  if (sub.name === "add") {
    return (
      <AddWalletView
        onDone={(s) => {
          onStatus(s);
          onBack();
        }}
        onBack={list}
      />
    );
  }
  if (sub.name === "reveal") return <RevealView what="phrase" wallet={sub.wallet} status={status} onBack={list} />;
  if (sub.name === "remove") {
    return (
      <RemoveWalletView
        wallet={sub.wallet}
        onRemoved={(s) => {
          onStatus(s);
          list();
        }}
        onBack={list}
      />
    );
  }

  const use = async (index: number) => {
    const s = await run({ type: "switch_account", index });
    if (s) {
      onStatus(s);
      onBack();
    }
  };
  const row = (a: AccountInfo, i: number) =>
    editing ? (
      <EditRow key={a.addresses[COSMOS]} a={a} index={i} removable={isWatch(a) || status.accounts.filter((x) => x.wallet === a.wallet).length > 1} onStatus={onStatus} />
    ) : (
      <button key={a.addresses[COSMOS]} className="token account-row" disabled={busy} onClick={() => void use(i)} aria-current={i === status.active ? "true" : undefined}>
        <AccountMark a={a} index={i} />
        <span className="name">
          <span className="symbol">{a.name}</span>
          <span className="sub denom">{shortAddress(a.addresses[COSMOS] ?? "")}</span>
        </span>
        <span className="value">{i === status.active && <CheckIcon size={18} />}</span>
      </button>
    );
  const indexed = status.accounts.map((a, i) => [a, i] as const);
  const watched = indexed.filter(([a]) => isWatch(a));

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
      {status.wallets.map((w) => (
        <div key={w.id} className="wallet-group">
          {editing ? (
            <WalletEdit wallet={w} onStatus={onStatus} onReveal={() => setSub({ name: "reveal", wallet: w })} onRemove={() => setSub({ name: "remove", wallet: w })} />
          ) : (
            <div className="eyebrow wallet-head">{w.name}</div>
          )}
          <div className="token-list">{indexed.filter(([a]) => a.wallet === w.id).map(([a, i]) => row(a, i))}</div>
          {!editing && w.type === "mnemonic" && (
            <button
              className="hidden-row"
              disabled={busy}
              aria-label={`Add an account to ${w.name}`}
              onClick={() =>
                void run({ type: "add_account", wallet: w.id }).then((s) => {
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
        </div>
      ))}
      {watched.length > 0 && (
        <div className="wallet-group">
          <div className="eyebrow wallet-head">Watching</div>
          <div className="token-list">{watched.map(([a, i]) => row(a, i))}</div>
        </div>
      )}
      {!editing && (
        <button className="btn" onClick={() => setSub({ name: "add" })}>
          <PlusIcon /> Add a wallet
        </button>
      )}
      <p className="footnote">Every wallet here opens with the same password.</p>
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

/** A name field that saves when it loses focus (or on Enter). */
function NameInput({ value, label, onSave }: { value: string; label: string; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(value);
  return (
    <input
      className="input"
      aria-label={label}
      maxLength={24}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        if (name.trim() === value) return;
        void onSave(name).then((ok) => ok || setName(value));
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function WalletEdit({ wallet, onStatus, onReveal, onRemove }: { wallet: WalletInfo; onStatus: (s: Status) => void; onReveal: () => void; onRemove: () => void }) {
  const { run, error } = useRequest();
  return (
    <div className="well wallet-edit">
      <NameInput
        value={wallet.name}
        label={`Name of ${wallet.name}`}
        onSave={async (name) => {
          const s = await run({ type: "rename_wallet", wallet: wallet.id, name });
          if (s) onStatus(s);
          return s !== null;
        }}
      />
      {error && <span className="error">{error}</span>}
      <div className="add-token-actions">
        {wallet.type !== "ledger" && (
          <button type="button" className="pill" onClick={onReveal}>
            {wallet.type === "mnemonic" ? "Show phrase" : "Show key"}
          </button>
        )}
        <button type="button" className="pill danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function EditRow({ a, index, removable, onStatus }: { a: AccountInfo; index: number; removable: boolean; onStatus: (s: Status) => void }) {
  const { run, error, busy } = useRequest();
  return (
    <div className="token manage account-row">
      <AccountMark a={a} index={index} />
      <span className="name">
        <NameInput
          value={a.name}
          label={`Name of ${a.name}`}
          onSave={async (name) => {
            const s = await run({ type: "rename_account", index, name });
            if (s) onStatus(s);
            return s !== null;
          }}
        />
        {error && <span className="error">{error}</span>}
      </span>
      <span className="value" />
      {removable ? (
        <button className="icon-btn" aria-label={`Remove ${a.name}`} disabled={busy} onClick={() => void run({ type: "remove_account", index }).then((s) => s && onStatus(s))}>
          <CloseIcon />
        </button>
      ) : (
        <span className="icon-btn" aria-hidden="true" />
      )}
    </div>
  );
}

type AddStep = { name: "choose" } | { name: "backup"; phrase: string } | { name: "confirm"; phrase: string } | { name: "import"; what: "mnemonic" | "private_key" } | { name: "watch" };

/** Another wallet behind the same password: a new phrase (written down and checked), an
 *  imported phrase or key, or an address to watch. */
function AddWalletView({ onDone, onBack }: { onDone: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy, setError } = useRequest();
  const backend = useBackend();
  const [step, setStep] = useState<AddStep>({ name: "choose" });
  const go = (s: AddStep) => {
    setError(null);
    setStep(s);
  };
  const add = (secret: NewSecret, created: boolean) => void run({ type: "add_wallet", secret, created }).then((s) => s && onDone(s));

  switch (step.name) {
    case "backup":
      return <Backup phrase={step.phrase} title="Add a wallet" step="Step 1 of 2" onNext={() => go({ name: "confirm", phrase: step.phrase })} onBack={() => go({ name: "choose" })} />;
    case "confirm":
      return (
        <Confirm
          phrase={step.phrase}
          title="Add a wallet"
          step="Step 2 of 2"
          busy={busy}
          error={error}
          onDone={() => add({ mnemonic: step.phrase }, true)}
          onBack={() => go({ name: "backup", phrase: step.phrase })}
        />
      );
    case "import":
      return <Import what={step.what} title="Add a wallet" busy={busy} error={error} onNext={(secret) => add(secret, false)} onBack={() => go({ name: "choose" })} />;
    case "watch":
      return (
        <Screen top={<BackBar title="Watch an address" onBack={() => go({ name: "choose" })} />}>
          <WatchForm onDone={onDone} onCancel={() => go({ name: "choose" })} />
        </Screen>
      );
    case "choose":
      return (
        <Screen top={<BackBar title="Add a wallet" onBack={onBack} />}>
          {error && <p className="error">{error}</p>}
          <div className="well rows">
            <button
              type="button"
              className="row link-row"
              disabled={busy}
              onClick={() => void run({ type: "generate", words: 12 }).then((r) => r && go({ name: "backup", phrase: r.phrase }))}
            >
              Create a new recovery phrase
            </button>
            <button type="button" className="row link-row" onClick={() => go({ name: "import", what: "mnemonic" })}>
              Import a recovery phrase
            </button>
            <button type="button" className="row link-row" onClick={() => go({ name: "import", what: "private_key" })}>
              Import a private key
            </button>
            <button type="button" className="row link-row" onClick={() => go({ name: "watch" })}>
              Watch an address
            </button>
            {backend.ledger && backend.openLedgerPage && (
              <button type="button" className="row link-row" onClick={() => backend.openLedgerPage?.()}>
                Connect a Ledger
              </button>
            )}
          </div>
          <p className="footnote">It opens with the password you use now.</p>
        </Screen>
      );
  }
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
