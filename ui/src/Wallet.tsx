// The unlocked wallet: balances, receive, send (form → review → sent) and settings.

import { formatShort, formatUnits, parseUnits, shortDenom } from "@choice-wallet/chain";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useBackend } from "./backend";
import type {
  Balance,
  Coin,
  DecodedMsg,
  NetworkId,
  Reply,
  Result,
  SendReview,
  Sent,
  Settings,
  Status,
  TxState,
  UiRequest,
} from "./protocol";

const UNREACHABLE = "The wallet didn't answer. Try again.";

type View =
  | { name: "home" }
  | { name: "receive" }
  | { name: "send" }
  | { name: "review"; review: SendReview; entered: string }
  | { name: "sent"; sent: Sent }
  | { name: "settings" };

/** Send a request; on failure show its message and resolve to null. */
function useRequest() {
  const backend = useBackend();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<R extends UiRequest>(req: R): Promise<Reply<R> | null> {
    setError(null);
    setBusy(true);
    let r: Result<Reply<R>>;
    try {
      r = await backend.send(req);
    } catch {
      r = { ok: false, error: { code: "unreachable", message: UNREACHABLE } };
    } finally {
      setBusy(false);
    }
    if (r.ok) return r.result;
    setError(r.error.message);
    return null;
  }
  return { run, error, setError, busy };
}

export function Wallet({ status, onLock, onStatus }: { status: Status; onLock: () => void; onStatus: () => void }) {
  const [view, setView] = useState<View>({ name: "home" });
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const { run, error } = useRequest();

  useEffect(() => {
    if (view.name !== "home") return;
    let live = true;
    void run({ type: "balances" }).then((r) => {
      if (live && r) setBalances(r.balances);
    });
    return () => {
      live = false;
    };
  }, [view.name, refresh, status.network]);

  const home = () => {
    setRefresh((n) => n + 1);
    setView({ name: "home" });
  };
  const account = status.accounts[0];

  switch (view.name) {
    case "receive":
      return (
        <Page title="Receive" lead="Both addresses are the same account.">
          {account &&
            SIDES.map(([id, label]) => <Address key={id} label={label} address={account.addresses[id] ?? ""} />)}
          <button onClick={home}>Back</button>
        </Page>
      );
    case "send":
      return (
        <SendForm
          balances={balances ?? []}
          onReview={(review, entered) => setView({ name: "review", review, entered })}
          onBack={home}
        />
      );
    case "review":
      return (
        <Review
          review={view.review}
          entered={view.entered}
          onSent={(sent) => setView({ name: "sent", sent })}
          onCancel={() => setView({ name: "send" })}
        />
      );
    case "sent":
      return <SentView sent={view.sent} onDone={home} />;
    case "settings":
      return (
        <SettingsView
          onDone={() => {
            onStatus();
            home();
          }}
        />
      );
    case "home":
      return (
        <section>
          <header className="row">
            <h1>Account 1</h1>
            <div className="buttons">
              <button className="small" onClick={() => setView({ name: "settings" })}>
                Settings
              </button>
              <button className="small" onClick={onLock}>
                Lock
              </button>
            </div>
          </header>
          {status.network === "testnet" && <p className="badge">Testnet</p>}
          {balances === null ? (
            <p className="muted">{error ?? "Loading balances…"}</p>
          ) : balances.length === 0 ? (
            <p className="muted">No tokens yet. Use Receive to get your address.</p>
          ) : (
            <ul className="list">
              {balances.map((b) => (
                <li key={b.denom} title={b.denom}>
                  <div>
                    <strong>{b.symbol}</strong>
                    {!b.known && <div className="denom">{shortDenom(b.denom)}</div>}
                  </div>
                  <span className="amount">{formatShort(b.amount, b.decimals)}</span>
                </li>
              ))}
            </ul>
          )}
          {balances !== null && error && <p className="error">{error}</p>}
          <div className="pair">
            <button className="primary" disabled={!balances?.length} onClick={() => setView({ name: "send" })}>
              Send
            </button>
            <button onClick={() => setView({ name: "receive" })}>Receive</button>
          </div>
        </section>
      );
  }
}

function SendForm({
  balances,
  onReview,
  onBack,
}: {
  balances: Balance[];
  onReview: (review: SendReview, entered: string) => void;
  onBack: () => void;
}) {
  const [denom, setDenom] = useState(balances[0]?.denom ?? "");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const { run, error, busy } = useRequest();
  const token = balances.find((b) => b.denom === denom);
  if (!token) return <Page title="Send" lead="Nothing to send yet."><button onClick={onBack}>Back</button></Page>;

  let parsed: string | null = null;
  let problem: string | null = null;
  if (max) parsed = "max";
  else if (amount.trim()) {
    try {
      const v = parseUnits(amount, token.decimals);
      if (v === 0n) problem = "Enter an amount above zero.";
      else if (v > BigInt(token.amount)) problem = `That's more ${token.symbol} than you have.`;
      else parsed = v.toString();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed) return;
    const entered = to.trim();
    const review = await run({ type: "prepare_send", denom, to: entered, amount: parsed });
    if (review) onReview(review, entered);
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Page title="Send">
        <label>
          Token
          <select value={denom} onChange={(e) => setDenom(e.target.value)}>
            {balances.map((b) => (
              <option key={b.denom} value={b.denom}>
                {b.known ? b.symbol : `${b.symbol} (${shortDenom(b.denom)})`}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Balance {formatUnits(token.amount, token.decimals)} {token.symbol}
        </p>
        <label>
          To
          <input
            placeholder="inj1… or 0x…"
            autoComplete="off"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Amount
          <span className="inline">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={max ? "Max" : amount}
              disabled={max}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className="small" onClick={() => setMax(!max)}>
              {max ? "Clear" : "Max"}
            </button>
          </span>
        </label>
        {problem && <p className="error">{problem}</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={!parsed || !to.trim() || busy}>
          {busy ? "Checking…" : "Review"}
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </Page>
    </form>
  );
}

type BankSend = { type: "bank_send"; from: string; to: string; amount: Coin[] };

function isBankSend(m: DecodedMsg): m is BankSend {
  return m.type === "bank_send" && typeof m["to"] === "string" && Array.isArray(m["amount"]);
}

/** The approval screen. Everything on it comes from the vault's decode of the transaction
 *  that will be signed, not from what the form asked for. */
function Review({
  review,
  entered,
  onSent,
  onCancel,
}: {
  review: SendReview;
  entered: string;
  onSent: (sent: Sent) => void;
  onCancel: () => void;
}) {
  const { display, risk, tokens } = review;
  const [typed, setTyped] = useState("");
  const { run, error, busy } = useRequest();
  const coin = (c: Coin) => {
    const t = tokens[c.denom];
    return t ? `${formatUnits(c.amount, t.decimals)} ${t.symbol}` : `${c.amount} ${c.denom}`;
  };
  const blocked = risk.level === "blocked";
  const needsWord = risk.confirm !== undefined && typed.trim() !== risk.confirm;

  async function confirm() {
    const sent = await run({ type: "confirm_send", digest: review.digest, ...(risk.confirm ? { confirm: typed.trim() } : {}) });
    if (sent) onSent(sent);
  }

  return (
    <Page title="Review send">
      {display.messages.map((m, i) =>
        isBankSend(m) ? (
          <div className="card" key={i}>
            <div className="label">Send</div>
            <div className="big">{m.amount.map(coin).join(" + ")}</div>
            <div className="label">To</div>
            <code>{m.to}</code>
            {entered.toLowerCase() !== m.to && <div className="hint">You entered {entered}</div>}
          </div>
        ) : (
          <div className="card" key={i}>
            <div className="label">Other message</div>
            <code>{m.type}</code>
          </div>
        ),
      )}
      <div className="line">
        <span className="muted">Network fee</span>
        <span>{display.fee.amount.map(coin).join(" + ") || "None"}</span>
      </div>
      <p className="hint">Simulated on {review.checkedBy}</p>
      {display.memo && (
        <div className="line">
          <span className="muted">Memo</span>
          <span>{display.memo}</span>
        </div>
      )}
      {risk.findings.map((f, i) => (
        <p key={i} className={`finding ${f.level}`}>
          {f.message}
        </p>
      ))}
      {risk.confirm && (
        <label>
          Type {risk.confirm} to continue
          <input autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button
        className={risk.level === "red" ? "danger" : "primary"}
        disabled={busy || blocked || needsWord}
        onClick={() => void confirm()}
      >
        {busy ? "Sending…" : "Confirm and send"}
      </button>
      <button onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </Page>
  );
}

const POLL_MS = 1500;
const POLL_TRIES = 40;

function SentView({ sent, onDone }: { sent: Sent; onDone: () => void }) {
  const backend = useBackend();
  const [state, setState] = useState<TxState | { state: "slow" }>({ state: "pending" });

  useEffect(() => {
    let live = true;
    let tries = 0;
    async function tick() {
      if (!live) return;
      try {
        const r = await backend.send({ type: "tx_status", hash: sent.hash });
        if (!live) return;
        if (r.ok && r.result.state !== "pending") {
          setState(r.result);
          return;
        }
      } catch {
        // Keep polling; the next try may get through.
      }
      if (++tries < POLL_TRIES) setTimeout(() => void tick(), POLL_MS);
      else setState({ state: "slow" });
    }
    void tick();
    return () => {
      live = false;
    };
  }, [sent.hash]);

  const title = { pending: "Sending", slow: "Not confirmed yet", success: "Sent", failed: "Failed" }[state.state];
  return (
    <Page title={title}>
      {state.state === "pending" && <p className="muted">Waiting for the next block.</p>}
      {state.state === "slow" && <p className="muted">Check the explorer for its status.</p>}
      {state.state === "failed" && <p className="error">{("log" in state && state.log) || "The chain rejected it."}</p>}
      <code title={sent.hash}>{shortDenom(sent.hash)}</code>
      <button onClick={() => backend.openLink(sent.explorer)}>View on explorer</button>
      <button className="primary" onClick={onDone}>
        Done
      </button>
    </Page>
  );
}

function SettingsView({ onDone }: { onDone: () => void }) {
  const { run, error, busy } = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [net, setNet] = useState<NetworkId>("mainnet");
  const [text, setText] = useState("");

  useEffect(() => {
    void run({ type: "settings" }).then((s) => {
      if (!s) return;
      setSettings(s);
      setNet(s.network);
      setText(s.lcd[s.network].join("\n"));
    });
  }, []);

  if (!settings) return <Page title="Settings">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</Page>;

  const pick = (n: NetworkId) => {
    setNet(n);
    setText(settings.lcd[n].join("\n"));
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const isDefault = lines.join("\n") === settings!.lcdDefault[net].join("\n");
    if (await run({ type: "save_settings", network: net, lcd: isDefault ? null : lines })) onDone();
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <Page title="Settings">
        <div className="pair">
          {(["mainnet", "testnet"] as const).map((n) => (
            <button type="button" key={n} className={net === n ? "selected" : ""} onClick={() => pick(n)}>
              {n === "mainnet" ? "Mainnet" : "Testnet"}
            </button>
          ))}
        </div>
        <label>
          Endpoints, tried in order
          <textarea rows={4} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" className="small" onClick={() => setText(settings.lcdDefault[net].join("\n"))}>
          Use the defaults
        </button>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onDone}>
          Back
        </button>
      </Page>
    </form>
  );
}

const SIDES: [string, string][] = [
  ["cosmos:injective-1", "Injective"],
  ["eip155:1776", "Injective EVM"],
];

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

export function Page({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section>
      <h1>{title}</h1>
      {lead && <p className="muted">{lead}</p>}
      <div className="stack">{children}</div>
    </section>
  );
}
