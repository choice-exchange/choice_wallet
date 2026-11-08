import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useBackend } from "./backend";
import type { NewSecret, Reply, Result, Status, UiRequest } from "./protocol";

const UNREACHABLE = "The wallet didn't answer. Try again.";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "backup"; phrase: string }
  | { name: "confirm"; phrase: string }
  | { name: "import"; what: "mnemonic" | "private_key" }
  | { name: "password"; secret: NewSecret }
  | { name: "unlock" }
  | { name: "home"; status: Status };

const MIN_PASSWORD = 8;

export function App() {
  const backend = useBackend();
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [error, setError] = useState<string | null>(null);

  function show(s: Status) {
    setError(null);
    setScreen(s.unlocked ? { name: "home", status: s } : s.hasWallet ? { name: "unlock" } : { name: "welcome" });
  }

  async function run<R extends UiRequest>(req: R, then: (reply: Reply<R>) => void) {
    setError(null);
    let r: Result<Reply<R>>;
    try {
      r = await backend.send(req);
    } catch {
      setError(UNREACHABLE);
      return;
    }
    if (r.ok) then(r.result);
    else setError(r.error.code === "wrong_password" ? "Wrong password." : r.error.message);
  }

  useEffect(() => {
    void run({ type: "status" }, show);
  }, []);

  const body = (() => {
    switch (screen.name) {
      case "loading":
        return <p className="muted">Loading…</p>;
      case "welcome":
        return (
          <Page title="Choice Wallet" lead="A self-custody wallet for Injective.">
            <button
              className="primary"
              onClick={() => void run({ type: "generate", words: 12 }, (r) => setScreen({ name: "backup", phrase: r.phrase }))}
            >
              Create a new wallet
            </button>
            <button onClick={() => setScreen({ name: "import", what: "mnemonic" })}>Import a recovery phrase</button>
            <button onClick={() => setScreen({ name: "import", what: "private_key" })}>Import a private key</button>
          </Page>
        );
      case "backup":
        return (
          <Page title="Your recovery phrase" lead="Write these words down in order. Anyone with them can take your funds.">
            <ol className="words">
              {screen.phrase.split(" ").map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ol>
            <button className="primary" onClick={() => setScreen({ name: "confirm", phrase: screen.phrase })}>
              I wrote them down
            </button>
          </Page>
        );
      case "confirm":
        return (
          <Confirm
            phrase={screen.phrase}
            onDone={() => setScreen({ name: "password", secret: { mnemonic: screen.phrase } })}
            onBack={() => setScreen({ name: "backup", phrase: screen.phrase })}
          />
        );
      case "import":
        return (
          <Import
            what={screen.what}
            onNext={(secret) => setScreen({ name: "password", secret })}
            onBack={() => setScreen({ name: "welcome" })}
          />
        );
      case "password":
        return <SetPassword onSubmit={(password) => void run({ type: "create", secret: screen.secret, password }, show)} />;
      case "unlock":
        return <Unlock onSubmit={(password) => void run({ type: "unlock", password }, show)} />;
      case "home":
        return <Home status={screen.status} onLock={() => void run({ type: "lock" }, show)} />;
    }
  })();

  return (
    <main>
      {body}
      {error && <p className="error">{error}</p>}
      <p className="footnote">Pre-alpha. Not for real funds.</p>
    </main>
  );
}

function Page({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section>
      <h1>{title}</h1>
      {lead && <p className="muted">{lead}</p>}
      <div className="stack">{children}</div>
    </section>
  );
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
    <Page title="Check your backup" lead="Enter these words from your phrase.">
      {picks.map((i) => (
        <label key={i}>
          Word {i + 1}
          <input
            autoComplete="off"
            spellCheck={false}
            value={answers[i] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
          />
        </label>
      ))}
      <button className="primary" disabled={!ok} onClick={onDone}>
        Continue
      </button>
      <button onClick={onBack}>Show the words again</button>
    </Page>
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
    <form onSubmit={submit}>
      <Page title={phrase ? "Import a recovery phrase" : "Import a private key"} lead="It stays on this device, encrypted.">
        {phrase ? (
          <textarea rows={4} autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <button className="primary" type="submit" disabled={!value.trim()}>
          Continue
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </Page>
    </form>
  );
}

function SetPassword({ onSubmit }: { onSubmit: (password: string) => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = a.length >= MIN_PASSWORD && a === b;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        onSubmit(a.normalize("NFC"));
      }}
    >
      <Page title="Set a password" lead="It unlocks this wallet on this device.">
        <input type="password" placeholder={`At least ${MIN_PASSWORD} characters`} value={a} onChange={(e) => setA(e.target.value)} />
        <input type="password" placeholder="Repeat it" value={b} onChange={(e) => setB(e.target.value)} />
        <button className="primary" type="submit" disabled={!ok || busy}>
          {busy ? "Encrypting…" : "Create wallet"}
        </button>
      </Page>
    </form>
  );
}

function Unlock({ onSubmit }: { onSubmit: (password: string) => void }) {
  const [p, setP] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(p.normalize("NFC"));
      }}
    >
      <Page title="Unlock">
        <input type="password" autoFocus placeholder="Password" value={p} onChange={(e) => setP(e.target.value)} />
        <button className="primary" type="submit" disabled={!p}>
          Unlock
        </button>
      </Page>
    </form>
  );
}

const SIDES: [string, string][] = [
  ["cosmos:injective-1", "Injective"],
  ["eip155:1776", "Injective EVM"],
];

function Home({ status, onLock }: { status: Status; onLock: () => void }) {
  const account = status.accounts[0];
  return (
    <section>
      <header className="row">
        <h1>Account 1</h1>
        <button className="small" onClick={onLock}>
          Lock
        </button>
      </header>
      <div className="stack">
        {account &&
          SIDES.map(([id, label]) => <Address key={id} label={label} address={account.addresses[id] ?? ""} />)}
      </div>
    </section>
  );
}

function Address({ label, address }: { label: string; address: string }) {
  const backend = useBackend();
  const [copied, setCopied] = useState(false);
  return (
    <div className="card">
      <div className="label">{label}</div>
      <code>{address}</code>
      <button
        className="small"
        onClick={() =>
          void backend.copy(address).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
