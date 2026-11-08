// Getting in: create or import a wallet, set its password, unlock it. The unlocked wallet
// is `Wallet`.

import { useEffect, useState, type FormEvent } from "react";

import mark from "./assets/choice-mark.svg";
import { useBackend } from "./backend";
import { BackBar, Callout, Screen } from "./kit";
import type { NewSecret, Reply, Result, Status, UiRequest } from "./protocol";
import { Wallet } from "./Wallet";

const UNREACHABLE = "The wallet didn't answer. Try again.";
const FOOTNOTE = "Pre-alpha. Not for real funds.";

type View =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "backup"; phrase: string }
  | { name: "confirm"; phrase: string }
  | { name: "import"; what: "mnemonic" | "private_key" }
  | { name: "password"; secret: NewSecret; created: boolean }
  | { name: "unlock" }
  | { name: "home"; status: Status };

const MIN_PASSWORD = 8;

export function App() {
  const backend = useBackend();
  const [view, setView] = useState<View>({ name: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function show(s: Status) {
    setError(null);
    setView(s.unlocked ? { name: "home", status: s } : s.hasWallet ? { name: "unlock" } : { name: "welcome" });
  }
  function go(v: View) {
    setError(null);
    setView(v);
  }

  async function run<R extends UiRequest>(req: R, then: (reply: Reply<R>) => void) {
    setError(null);
    setBusy(true);
    let r: Result<Reply<R>>;
    try {
      r = await backend.send(req);
    } catch {
      setError(UNREACHABLE);
      return;
    } finally {
      setBusy(false);
    }
    if (r.ok) then(r.result);
    else setError(r.error.code === "wrong_password" ? "Wrong password." : r.error.message);
  }

  useEffect(() => {
    void run({ type: "status" }, show);
  }, []);

  const err = error && <p className="error">{error}</p>;

  switch (view.name) {
    case "loading":
      return <Screen>{null}</Screen>;
    case "welcome":
      return (
        <Screen
          foot={
            <>
              {err}
              <button
                className="btn btn-gold"
                disabled={busy}
                onClick={() => void run({ type: "generate", words: 12 }, (r) => go({ name: "backup", phrase: r.phrase }))}
              >
                Create a new wallet
              </button>
              <button className="btn" onClick={() => go({ name: "import", what: "mnemonic" })}>
                I have a recovery phrase
              </button>
              <button className="btn btn-quiet" onClick={() => go({ name: "import", what: "private_key" })}>
                Import a private key
              </button>
              <p className="footnote">{FOOTNOTE}</p>
            </>
          }
        >
          <div className="welcome">
            <span className="logo-glow">
              <img className="logo" src={mark} alt="" />
            </span>
            <h1 className="page-title">Choice Wallet</h1>
            <p className="lead">Self-custody for Injective.</p>
          </div>
        </Screen>
      );
    case "backup":
      return (
        <Screen
          top={<BackBar title="New wallet" onBack={() => go({ name: "welcome" })} />}
          foot={
            <button className="btn btn-gold" onClick={() => go({ name: "confirm", phrase: view.phrase })}>
              I wrote them down
            </button>
          }
        >
          <div className="eyebrow">Step 1 of 3</div>
          <h1 className="page-title">Your recovery phrase</h1>
          <p className="lead">Write these words down in order.</p>
          <div className="surface">
            <ol className="words">
              {view.phrase.split(" ").map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ol>
          </div>
          <Callout level="amber">Anyone with these words can take your funds.</Callout>
        </Screen>
      );
    case "confirm":
      return (
        <Confirm
          phrase={view.phrase}
          onDone={() => go({ name: "password", secret: { mnemonic: view.phrase }, created: true })}
          onBack={() => go({ name: "backup", phrase: view.phrase })}
        />
      );
    case "import":
      return <Import what={view.what} onNext={(secret) => go({ name: "password", secret, created: false })} onBack={() => go({ name: "welcome" })} />;
    case "password":
      return (
        <SetPassword
          step={view.created}
          busy={busy}
          error={error}
          onBack={() => go({ name: "welcome" })}
          onSubmit={(password) => void run({ type: "create", secret: view.secret, password }, show)}
        />
      );
    case "unlock":
      return <Unlock busy={busy} error={error} onSubmit={(password) => void run({ type: "unlock", password }, show)} />;
    case "home":
      return (
        <Wallet
          status={view.status}
          onLock={() => void run({ type: "lock" }, show)}
          onStatus={() => void run({ type: "status" }, show)}
        />
      );
  }
}

/** Ask for three of the words back, so a phrase that wasn't written down can't get here. */
function Confirm({ phrase, onDone, onBack }: { phrase: string; onDone: () => void; onBack: () => void }) {
  const words = phrase.split(" ");
  const [picks] = useState(() => {
    const idx = new Set<number>();
    const rnd = new Uint32Array(1);
    while (idx.size < 3) {
      crypto.getRandomValues(rnd);
      idx.add((rnd[0] ?? 0) % words.length);
    }
    return [...idx].sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const ok = picks.every((i) => (answers[i] ?? "").trim().toLowerCase() === words[i]);
  return (
    <Screen
      top={<BackBar title="New wallet" onBack={onBack} />}
      foot={
        <>
          <button className="btn btn-gold" disabled={!ok} onClick={onDone}>
            Continue
          </button>
          <button className="btn btn-quiet" onClick={onBack}>
            Show the words again
          </button>
        </>
      }
    >
      <div className="eyebrow">Step 2 of 3</div>
      <h1 className="page-title">Check your backup</h1>
      <p className="lead">Enter these words from your phrase.</p>
      {picks.map((i) => (
        <label key={i} className="field">
          <span className="eyebrow">Word {i + 1}</span>
          <input
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={answers[i] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
          />
        </label>
      ))}
    </Screen>
  );
}

function Import({ what, onNext, onBack }: { what: "mnemonic" | "private_key"; onNext: (s: NewSecret) => void; onBack: () => void }) {
  const [value, setValue] = useState("");
  const phrase = what === "mnemonic";
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = phrase ? value.trim().toLowerCase().split(/\s+/).join(" ") : value.trim();
    onNext(phrase ? { mnemonic: v } : { private_key: v });
  }
  return (
    <form onSubmit={submit} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title="Import" onBack={onBack} />}
        foot={
          <button className="btn btn-gold" type="submit" disabled={!value.trim()}>
            Continue
          </button>
        }
      >
        <h1 className="page-title">{phrase ? "Import a recovery phrase" : "Import a private key"}</h1>
        <p className="lead">It stays on this device, encrypted.</p>
        {phrase ? (
          <textarea
            className="textarea"
            rows={5}
            autoComplete="off"
            spellCheck={false}
            placeholder="Words separated by spaces"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input className="input mono" type="password" autoComplete="off" placeholder="Hex private key" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
      </Screen>
    </form>
  );
}

function SetPassword({
  step,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  step: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (password: string) => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const ok = a.length >= MIN_PASSWORD && a === b;
  const mismatch = b.length > 0 && a !== b && b.length >= a.length;
  return (
    <form
      style={{ height: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(a.normalize("NFC"));
      }}
    >
      <Screen
        top={<BackBar title="New wallet" onBack={onBack} />}
        foot={
          <>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-gold" type="submit" disabled={!ok || busy}>
              {busy ? "Encrypting…" : "Create wallet"}
            </button>
          </>
        }
      >
        {step && <div className="eyebrow">Step 3 of 3</div>}
        <h1 className="page-title">Set a password</h1>
        <p className="lead">It unlocks this wallet on this device.</p>
        <input className="input" type="password" placeholder={`At least ${MIN_PASSWORD} characters`} value={a} onChange={(e) => setA(e.target.value)} />
        <input className="input" type="password" placeholder="Repeat it" value={b} onChange={(e) => setB(e.target.value)} />
        {mismatch && <p className="error">The passwords don't match.</p>}
      </Screen>
    </form>
  );
}

function Unlock({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (password: string) => void }) {
  const [p, setP] = useState("");
  return (
    <form
      style={{ height: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(p.normalize("NFC"));
      }}
    >
      <Screen
        foot={
          <>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-gold" type="submit" disabled={!p || busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </button>
            <p className="footnote">{FOOTNOTE}</p>
          </>
        }
      >
        <div className="welcome">
          <span className="logo-glow">
              <img className="logo" src={mark} alt="" />
            </span>
          <h1 className="page-title">Welcome back</h1>
          <input
            className="input"
            type="password"
            autoFocus
            placeholder="Password"
            aria-label="Password"
            value={p}
            onChange={(e) => setP(e.target.value)}
          />
        </div>
      </Screen>
    </form>
  );
}
