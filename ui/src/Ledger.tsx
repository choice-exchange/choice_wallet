// Ledger screens. Adding accounts runs in a tab, since the browser's device chooser closes a
// popup. Signing is a step after the review: the device gets only the bytes the vault
// decoded, shows them, and its signature counts only once the vault has checked it against
// the account's key.

import { useEffect, useRef, useState } from "react";

import { useBackend, type LedgerStep } from "./backend";
import { BackBar, Callout, Screen, Segmented, shortAddress } from "./kit";
import type { AccountInfo, DeviceRequest, DeviceSignature, LedgerKey, Status } from "./protocol";
import { errorText, useRequest } from "./request";

/** Accounts read from the device per page of the list. */
const PAGE = 5;

type Layout = "ledger_live" | "default";
const LAYOUTS: readonly (readonly [Layout, string])[] = [
  ["ledger_live", "Ledger Live"],
  ["default", "Keplr, MetaMask"],
];
const pathOf = (layout: Layout, i: number) => (layout === "ledger_live" ? `m/44'/60'/${i}'/0/0` : `m/44'/60'/0'/0/${i}`);

/** A Ledger account's key in the Solana app: Ledger Live's Solana account of the same number
 *  (`m/44'/501'/n'`), in either layout. */
function solanaPathOf(a: AccountInfo): string | null {
  const m = a.account.derivation === "ledger" ? /^m\/44'\/60'\/(\d+)'\/0\/(\d+)$/.exec(a.account.path) : null;
  if (!m) return null;
  const [account, index] = [Number(m[1]), Number(m[2])];
  return account > 0 && index > 0 ? null : `m/44'/501'/${account || index}'`;
}
/** A Ledger account here that has no Solana key yet, and can get one. */
const needsSolana = (a: AccountInfo) => !a.ledger_solana && solanaPathOf(a) !== null;
const solanaAddress = (a: AccountInfo) => Object.entries(a.addresses).find(([k]) => k.startsWith("solana:"))?.[1];
const count = (n: number) => (n === 1 ? "One account" : `${n} accounts`);

const APP_NAME = { cosmos: "Cosmos", ethereum: "Ethereum", solana: "Solana" } as const;

function stepText(step: LedgerStep, req?: { app: DeviceRequest["app"]; kind?: DeviceRequest["kind"] }): string {
  const app = APP_NAME[req?.app ?? "cosmos"];
  switch (step) {
    case "connect":
      return "Looking for your Ledger…";
    case "unlock":
      return "Unlock your Ledger.";
    case "open_app":
      return `Allow the ${app} app to open on your Ledger.`;
    case "confirm":
      return req?.kind === "message" ? "Check the message on your Ledger, then sign it there." : "Check it on your Ledger, then approve it there.";
    case "working":
      return "Talking to your Ledger…";
  }
}

/** Sign `request` on the Ledger, then hand the signature on. A rejection, a locked device or
 *  a vault refusal shows here with "Try again"; nothing is sent until `onSignature` works. */
export function DeviceStep({
  request,
  onSignature,
  onCancel,
}: {
  request: DeviceRequest;
  /** Gives the signature to the host; resolves to an error message, or null when done. */
  onSignature: (sig: DeviceSignature) => Promise<string | null>;
  onCancel: () => void;
}) {
  const backend = useBackend();
  const [step, setStep] = useState<LedgerStep>("connect");
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    setProblem(null);
    setStep("connect");
    const ledger = backend.ledger;
    if (!ledger) {
      setProblem("This browser can't reach a Ledger.");
      return;
    }
    void ledger
      .sign(request, setStep)
      .then(async (sig) => {
        setStep("working");
        const bad = await onSignature(sig);
        if (bad) setProblem(bad);
      })
      .catch((e: unknown) => setProblem(errorText(e)));
  }, [attempt]);

  const hint =
    request.app === "cosmos"
      ? "Injective needs Expert mode on in the Cosmos app's settings."
      : request.app === "solana"
        ? "Swaps and bridging need Blind signing on in the Solana app's settings."
        : request.kind === "transaction"
          ? "A contract call needs Blind signing on in the Ethereum app's settings."
          : null;
  return (
    <div className="well device-step" role="status">
      <span className="eyebrow">Ledger · {APP_NAME[request.app]} app</span>
      {problem ? <Callout level="amber">{problem}</Callout> : <p className="device-text">{stepText(step, request)}</p>}
      {hint && <span className="meta">{hint}</span>}
      <div className="add-token-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        {problem && (
          <button type="button" className="btn btn-gold" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

type Row = { path: string; index: number; public_key: string; address: string };

/** The Ledger tab: connect the device, pick accounts from either layout, add them, then their
 *  Solana keys from the Solana app. `start` "solana": that last step alone, for the Ledger
 *  accounts already here. */
export function LedgerAddView({ start = "add" }: { start?: "add" | "solana" }) {
  const backend = useBackend();
  const { run, error, busy } = useRequest();
  const [status, setStatus] = useState<Status | null>(null);
  const [stage, setStage] = useState<"intro" | "pick" | "solana" | "done">(start === "solana" ? "solana" : "intro");
  /** The accounts the Solana step is for (by Cosmos app key); null until known. */
  const [forSolana, setForSolana] = useState<string[] | null>(null);
  const [solanaAdded, setSolanaAdded] = useState(0);
  const [layout, setLayout] = useState<Layout>("ledger_live");
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<LedgerStep | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    void backend.send({ type: "status" }).then((r) => {
      if (!r.ok) return;
      setStatus(r.result);
      if (start === "solana") setForSolana(r.result.accounts.filter(needsSolana).map((a) => a.public_key));
    });
  }, []);

  const have = new Set(status?.accounts.map((a) => a.public_key) ?? []);
  const ledger = backend.ledger;

  async function load(l: Layout, from: number) {
    if (!ledger) return;
    setProblem(null);
    try {
      const paths = Array.from({ length: PAGE }, (_, i) => pathOf(l, from + i));
      const keys = await ledger.publicKeys(paths, setStep);
      const next = keys.map((k, i) => ({ ...k, index: from + i }));
      setRows((r) => (from === 0 ? next : [...r, ...next]));
      setStage("pick");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setStep(null);
    }
  }

  async function connect() {
    if (!ledger) return;
    setProblem(null);
    try {
      await ledger.pair();
    } catch (e) {
      setProblem(errorText(e));
      return;
    }
    await load(layout, 0);
  }

  async function show(path: string) {
    if (!ledger) return;
    setProblem(null);
    try {
      await ledger.show(path, setStep);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setStep(null);
    }
  }

  async function add() {
    const accounts: LedgerKey[] = rows.filter((r) => picked.has(r.path)).map((r) => ({ path: r.path, public_key: r.public_key }));
    const s = await run({ type: "add_ledger", accounts });
    if (s) {
      setAdded(accounts.length);
      setStatus(s);
      const keys = new Set(accounts.map((a) => a.public_key));
      const next = s.accounts.filter((a) => keys.has(a.public_key) && needsSolana(a)).map((a) => a.public_key);
      setForSolana(next);
      setStage(next.length > 0 ? "solana" : "done");
    }
  }

  /** The Solana step's accounts, as they are now. */
  const solanaRows = (forSolana ?? []).flatMap((k) => status?.accounts.filter((a) => a.public_key === k) ?? []);

  async function addSolana() {
    if (!ledger) return;
    setProblem(null);
    const want = solanaRows.filter(needsSolana);
    let keys: { path: string; public_key: string }[];
    try {
      keys = await ledger.solanaKeys(
        want.map((a) => solanaPathOf(a)!),
        setStep,
      );
    } catch (e) {
      setProblem(errorText(e));
      return;
    } finally {
      setStep(null);
    }
    const s = await run({ type: "add_ledger_solana", accounts: want.map((a, i) => ({ public_key: a.public_key, solana: keys[i]! })) });
    if (s) {
      setStatus(s);
      setSolanaAdded(want.length);
    }
  }

  const close = () => window.close();
  if (status && (!status.hasWallet || !status.unlocked)) {
    return (
      <Screen top={<span className="title">Add a Ledger</span>} foot={<button className="btn" onClick={close}>Close</button>}>
        <Callout level="amber">{status.hasWallet ? "Unlock Choice Wallet from the toolbar first, then reload this tab." : "Set up Choice Wallet from the toolbar first, then come back."}</Callout>
      </Screen>
    );
  }
  if (!ledger) {
    return (
      <Screen top={<span className="title">Add a Ledger</span>} foot={<button className="btn" onClick={close}>Close</button>}>
        <Callout level="amber">This browser can&apos;t reach a Ledger (it has no WebHID).</Callout>
      </Screen>
    );
  }
  if (stage === "solana") {
    const done = solanaRows.length > 0 && solanaRows.every((a) => a.ledger_solana);
    return (
      <Screen
        top={<span className="title">Solana on your Ledger</span>}
        foot={
          <>
            {(problem || error) && <Callout level="amber">{problem ?? error}</Callout>}
            {done || (forSolana !== null && solanaRows.length === 0) ? (
              <button className="btn btn-gold" disabled={step !== null} onClick={() => setStage("done")}>
                {step ? stepText(step, { app: "solana" }) : "Done"}
              </button>
            ) : (
              <>
                <button className="btn btn-gold" disabled={forSolana === null || busy || step !== null} onClick={() => void addSolana()}>
                  {step ? stepText(step, { app: "solana" }) : busy ? "Adding…" : "Add Solana"}
                </button>
                <button className="btn btn-quiet" disabled={busy || step !== null} onClick={() => setStage("done")}>
                  {start === "solana" ? "Not now" : "Skip"}
                </button>
              </>
            )}
          </>
        }
      >
        {forSolana !== null && solanaRows.length === 0 ? (
          <p className="lead">Every Ledger account here has Solana already.</p>
        ) : done ? (
          <p className="lead">Before using Solana, compare each address with the one your Ledger shows.</p>
        ) : (
          <p className="lead">Open the Solana app on your Ledger to add {solanaRows.length === 1 ? "this account's" : "these accounts'"} Solana address.</p>
        )}
        <div className="token-list">
          {solanaRows.map((a) => {
            const address = solanaAddress(a);
            return (
              <div key={a.public_key} className="token ledger-row">
                <span className="name">
                  <span className="symbol">{a.name}</span>
                  <span className="sub denom" title={address}>
                    {address ? shortAddress(address) : "Not added yet"}
                  </span>
                </span>
                {a.ledger_solana && (
                  <button type="button" className="pill" disabled={step !== null} onClick={() => void show(a.ledger_solana!.path)}>
                    Show on Ledger
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="footnote">Each is Ledger Live&apos;s Solana account of the same number.</p>
      </Screen>
    );
  }
  if (stage === "done") {
    const what = added > 0 ? `${count(added)} added${solanaAdded > 0 ? ", with Solana" : ""}.` : solanaAdded > 0 ? `Solana added to ${count(solanaAdded).toLowerCase()}.` : "Nothing changed.";
    return (
      <Screen top={<span className="title">{added > 0 ? "Ledger added" : "Ledger"}</span>} foot={<button className="btn btn-gold" onClick={close}>Close this tab</button>}>
        <p className="lead">
          {what}
          {Math.max(added, solanaAdded) > 0 && ` Open Choice Wallet from the toolbar to use ${Math.max(added, solanaAdded) === 1 ? "it" : "them"}.`}
        </p>
        <p className="footnote">Every signature is made on the Ledger and checked by the wallet before it is sent.</p>
      </Screen>
    );
  }
  if (stage === "intro") {
    return (
      <Screen
        top={<span className="title">Add a Ledger</span>}
        foot={
          <>
            {problem && <Callout level="amber">{problem}</Callout>}
            <button className="btn btn-gold" disabled={step !== null} onClick={() => void connect()}>
              {step ? stepText(step) : "Connect"}
            </button>
          </>
        }
      >
        <ol className="steps">
          <li>Plug in your Ledger and unlock it.</li>
          <li>On the Ledger, open the Cosmos app. Injective needs Expert mode on in its settings.</li>
          <li>For EVM transactions, install the Ethereum app too. For Solana, the Solana app.</li>
        </ol>
        <p className="footnote">The keys stay on the Ledger. The wallet keeps only their public keys.</p>
      </Screen>
    );
  }
  const n = picked.size;
  return (
    <Screen
      top={<BackBar title="Pick accounts" onBack={() => setStage("intro")} />}
      foot={
        <>
          {(problem || error) && <Callout level="amber">{problem ?? error}</Callout>}
          <button className="btn btn-gold" disabled={n === 0 || busy || step !== null} onClick={() => void add()}>
            {busy ? "Adding…" : n === 0 ? "Pick an account" : `Add ${n === 1 ? "1 account" : `${n} accounts`}`}
          </button>
        </>
      }
    >
      <Segmented
        label="Account layout"
        options={LAYOUTS}
        value={layout}
        onChange={(l) => {
          setLayout(l);
          setPicked(new Set());
          setRows([]);
          void load(l, 0);
        }}
      />
      <span className="meta">{layout === "ledger_live" ? "As Ledger Live numbers accounts." : "As Keplr and MetaMask number a Ledger's accounts."}</span>
      {step && <p className="meta">{stepText(step)}</p>}
      <div className="token-list">
        {rows.map((r) => {
          const here = have.has(r.public_key);
          return (
            <div key={r.path} className="token ledger-row">
              <label className="ledger-pick">
                <input
                  type="checkbox"
                  disabled={here}
                  checked={here || picked.has(r.path)}
                  aria-label={`Account ${r.index + 1}`}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(r.path);
                    else next.delete(r.path);
                    setPicked(next);
                  }}
                />
                <span className="name">
                  <span className="symbol">Account {r.index + 1}</span>
                  <span className="sub denom" title={r.address}>
                    {here ? "Already added" : shortAddress(r.address)}
                  </span>
                </span>
              </label>
              <button type="button" className="pill" disabled={step !== null} onClick={() => void show(r.path)}>
                Show on Ledger
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn btn-quiet" disabled={step !== null} onClick={() => void load(layout, rows.length)}>
        More accounts
      </button>
      <p className="footnote">Before using an account, compare its address with the one your Ledger shows.</p>
    </Screen>
  );
}
