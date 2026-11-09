// Security, each step behind the password: show a wallet's recovery phrase (or its imported
// key) or an account's private key, set a new password, take one wallet off this device,
// or everything. What's shown lives only in this screen's state.

import { useState, type FormEvent, type ReactNode } from "react";

import { useBackend } from "./backend";
import { CheckIcon, CopyIcon } from "./icons";
import { BackBar, Callout, Screen } from "./kit";
import type { Status, WalletInfo } from "./protocol";
import { useRequest } from "./request";

const MIN_PASSWORD = 8;

export type SecurityView = "phrase" | "key" | "password" | "reset";

/** A screen with a password field that runs `onPassword` on submit. */
function PasswordStep({
  title,
  lead,
  warning,
  action,
  busy,
  error,
  danger,
  ready = true,
  children,
  onPassword,
  onBack,
}: {
  title: string;
  lead: string;
  warning?: ReactNode;
  action: string;
  busy: boolean;
  error: string | null;
  danger?: boolean;
  /** False while the rest of the form isn't filled in. */
  ready?: boolean;
  children?: ReactNode;
  onPassword: (password: string) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      style={{ height: "100%" }}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (password && ready) onPassword(password.normalize("NFC"));
      }}
    >
      <Screen
        top={<BackBar title={title} onBack={onBack} />}
        foot={
          <>
            {error && <p className="error">{error}</p>}
            <button className={danger ? "btn btn-danger" : "btn btn-gold"} type="submit" disabled={busy || !password || !ready}>
              {busy ? "Checking…" : action}
            </button>
          </>
        }
      >
        <p className="lead">{lead}</p>
        {warning}
        <input className="input" type="password" aria-label="Password" placeholder="Your password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {children}
      </Screen>
    </form>
  );
}

/** A wallet's recovery phrase (or its key), or the account in use's private key. */
export function RevealView({ what, wallet, status, onBack }: { what: "phrase" | "key"; wallet?: WalletInfo | undefined; status: Status; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  const backend = useBackend();
  const [shown, setShown] = useState<{ phrase?: string; private_key?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const account = status.accounts[status.active];
  const phrase = wallet?.type === "mnemonic";
  const title = what === "phrase" ? (phrase ? "Recovery phrase" : "Private key") : "Account key";

  if (!shown) {
    return (
      <PasswordStep
        title={title}
        lead={
          what === "phrase"
            ? phrase
              ? `The words that restore every account in ${wallet?.name ?? "this wallet"}.`
              : `The key that restores ${wallet?.name ?? "this wallet"}.`
            : `${account?.name ?? "This account"}'s private key, to use it in another wallet.`
        }
        warning={<Callout level="red">Anyone who sees it can take your funds. Never type it into a site.</Callout>}
        action="Show"
        busy={busy}
        error={error}
        onPassword={(password) =>
          void run({ type: "reveal_secret", password, ...(what === "key" ? { index: status.active } : wallet ? { wallet: wallet.id } : {}) }).then((r) => r && setShown(r))
        }
        onBack={onBack}
      />
    );
  }
  const key = shown.private_key;
  return (
    <Screen
      top={<BackBar title={title} onBack={onBack} />}
      foot={
        key ? (
          <button
            className="btn"
            onClick={() =>
              void backend.copy(key).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy key"}
          </button>
        ) : (
          <button className="btn" onClick={onBack}>
            Done
          </button>
        )
      }
    >
      <Callout level="red">Anyone who sees it can take your funds. Never type it into a site.</Callout>
      {shown.phrase ? (
        <div className="surface">
          <ol className="words">
            {shown.phrase.split(" ").map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="well">
          <code className="mono address" style={{ fontSize: 14, lineHeight: "21px", wordBreak: "break-all" }}>
            {key}
          </code>
        </div>
      )}
    </Screen>
  );
}

export function ChangePasswordView({ onDone, onBack }: { onDone: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const ok = [...next].length >= MIN_PASSWORD && next === again;
  const mismatch = again.length > 0 && next !== again && again.length >= next.length;
  return (
    <PasswordStep
      title="Change password"
      lead="Enter the password you use now, then the new one."
      action="Change password"
      busy={busy}
      ready={ok}
      error={error}
      onPassword={(password) => void run({ type: "change_password", password, new_password: next.normalize("NFC") }).then((s) => s && onDone(s))}
      onBack={onBack}
    >
      <input className="input" type="password" aria-label="New password" placeholder={`New password, at least ${MIN_PASSWORD} characters`} value={next} onChange={(e) => setNext(e.target.value)} />
      <input className="input" type="password" aria-label="Repeat the new password" placeholder="Repeat it" value={again} onChange={(e) => setAgain(e.target.value)} />
      {mismatch && <p className="error">The new passwords don&apos;t match.</p>}
    </PasswordStep>
  );
}

/** Everything off this device: every wallet and account. */
export function ResetView({ onRemoved, onBack }: { onRemoved: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  return (
    <PasswordStep
      title="Reset Choice Wallet"
      lead="This takes every wallet off this device. Your funds stay on chain."
      warning={<Callout level="red">Only your recovery phrases and keys bring them back. Check you have them first.</Callout>}
      action="Reset"
      danger
      busy={busy}
      error={error}
      onPassword={(password) => void run({ type: "reset", password }).then((s) => s && onRemoved(s))}
      onBack={onBack}
    />
  );
}

/** One wallet and its accounts off this device. */
export function RemoveWalletView({ wallet, onRemoved, onBack }: { wallet: WalletInfo; onRemoved: (s: Status) => void; onBack: () => void }) {
  const { run, error, busy } = useRequest();
  return (
    <PasswordStep
      title={`Remove ${wallet.name}`}
      lead="This takes the wallet and its accounts off this device. Their funds stay on chain."
      warning={
        wallet.type === "ledger" ? (
          <Callout level="amber">Its keys stay on the Ledger. Add it again from the Ledger any time.</Callout>
        ) : (
          <Callout level="red">{wallet.type === "mnemonic" ? "Only its recovery phrase brings it back. Check you have it first." : "Only its private key brings it back. Check you have it first."}</Callout>
        )
      }
      action="Remove"
      danger
      busy={busy}
      error={error}
      onPassword={(password) => void run({ type: "remove_wallet", wallet: wallet.id, password }).then((s) => s && onRemoved(s))}
      onBack={onBack}
    />
  );
}
