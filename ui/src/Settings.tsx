// Settings (a tab): the endpoints of the chain picked on Home (and only those), USD values,
// connected sites, and locking. The chain, and mainnet or the test networks, are picked in
// Home's chain sheet.

import { chainByKey } from "@choice-wallet/chain";
import { useEffect, useState, type FormEvent } from "react";

import { useBackend } from "./backend";
import { GlobeIcon, LockIcon } from "./icons";
import { BackBar, Callout, Screen, Segmented } from "./kit";
import type { Connection, NetworkId, NotifyMode, Settings, Status } from "./protocol";
import { useRequest } from "./request";
import { ChangePasswordView, ResetView, RevealView, type SecurityView } from "./Security";

const LOCK_AFTER: readonly (readonly ["5" | "15" | "60" | "240", string])[] = [
  ["5", "5 min"],
  ["15", "15 min"],
  ["60", "1 hour"],
  ["240", "4 hours"],
];

export function SettingsView({
  status,
  onStatus,
  onDone,
  onLock,
  onApprovals,
  onContacts,
  onRescue,
  onBack,
}: {
  status: Status;
  onStatus: (s: Status) => void;
  onDone: () => void;
  onLock: () => void;
  /** Open Approvals and grants. */
  onApprovals: () => void;
  /** Open the address book. */
  onContacts: () => void;
  /** Open the rescue address. */
  onRescue: () => void;
  /** Back to where Settings was opened from. */
  onBack: () => void;
}) {
  const { run, error, busy } = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [net, setNet] = useState<NetworkId>("mainnet");
  const [text, setText] = useState("");
  const [evmText, setEvmText] = useState("");
  const [indexText, setIndexText] = useState("");
  const [solanaText, setSolanaText] = useState("");
  /** The picked EVM chain's endpoints (not Injective's own EVM side), and its history indexes. */
  const [chainText, setChainText] = useState("");
  const [historyText, setHistoryText] = useState("");
  const [prices, setPrices] = useState(true);
  const [lockAfter, setLockAfter] = useState("15");
  const [notify, setNotify] = useState<NotifyMode>("active");
  const [security, setSecurity] = useState<SecurityView | null>(null);
  const backend = useBackend();
  const [sites, setSites] = useState<Connection[]>([]);

  useEffect(() => {
    void backend.send({ type: "connections" }).then((r) => r.ok && setSites(r.result));
  }, []);

  useEffect(() => {
    void run({ type: "settings" }).then((s) => {
      if (!s) return;
      setSettings(s);
      setNet(s.network);
      setText(s.lcd[s.network].join("\n"));
      setEvmText(s.evm[s.network].join("\n"));
      setIndexText(s.evmIndex[s.network].join("\n"));
      setSolanaText(s.solana[s.network].join("\n"));
      setChainText((s.chains[s.network][status.chain] ?? []).join("\n"));
      setHistoryText((s.chainHistory[s.network][status.chain] ?? []).join("\n"));
      setPrices(s.prices);
      setLockAfter(String(s.autoLock));
      setNotify(s.notify);
    });
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
    const same = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
    // Only the picked chain's endpoints are on screen, so only they are saved.
    const own = (t: string, defaults: string[]) => {
      const l = lines(t);
      return same(l, defaults) ? null : l;
    };
    const endpoints =
      kind === "solana"
        ? { solana: own(solanaText, settings.solanaDefault[net]) }
        : kind === "evm"
          ? { chain: { key: status.chain, rpc: own(chainText, settings.chainsDefault[net][status.chain] ?? []), index: own(historyText, settings.chainHistoryDefault[net][status.chain] ?? []) ?? null } }
          : { lcd: own(text, settings.lcdDefault[net]), evm: own(evmText, settings.evmDefault[net]), evmIndex: own(indexText, settings.evmIndexDefault[net]) };
    if (
      await run({
        type: "save_settings",
        network: net,
        ...endpoints,
        prices,
        autoLock: Number(lockAfter),
        notify,
      })
    ) {
      onDone();
    }
  }

  const account = status.accounts[status.active];
  /** The chain picked on Home, whose endpoints this shows. */
  const picked = chainByKey(status.network, status.chain) ?? chainByKey(status.network, "injective")!;
  const kind = picked.kind;
  // The wallet of the account in use (the first, for a watched address).
  const wallet = status.wallets.find((w) => w.id === account?.wallet) ?? status.wallets[0];
  if (security === "phrase" || security === "key") return <RevealView what={security} wallet={wallet} status={status} onBack={() => setSecurity(null)} />;
  if (security === "password") {
    return (
      <ChangePasswordView
        onDone={(s) => {
          onStatus(s);
          setSecurity(null);
        }}
        onBack={() => setSecurity(null)}
      />
    );
  }
  if (security === "reset") return <ResetView onRemoved={onStatus} onBack={() => setSecurity(null)} />;

  return (
    <form onSubmit={(e) => void save(e)} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title="Settings" onBack={onBack} />}
        foot={
          <>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-gold" type="submit" disabled={busy || !settings}>
              Save
            </button>
          </>
        }
      >
        {/* Shown once the saved settings are read, so nothing chosen before then is put back. */}
        {!settings ? (
          [0, 1, 2].map((k) => <div key={k} className="skeleton" style={{ height: 56 }} />)
        ) : (
          <>
        <div className="eyebrow">Endpoints · {picked.name}</div>
        {kind === "injective" && (
          <>
            <label className="meta" htmlFor="lcd-endpoints">
              Injective (LCD)
            </label>
            <textarea
              id="lcd-endpoints"
              className="textarea"
              rows={3}
              spellCheck={false}
              aria-label="Endpoints"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <label className="meta" htmlFor="evm-endpoints">
              EVM (JSON-RPC)
            </label>
            <textarea
              id="evm-endpoints"
              className="textarea"
              rows={2}
              spellCheck={false}
              aria-label="EVM endpoints"
              value={evmText}
              onChange={(e) => setEvmText(e.target.value)}
            />
            <label className="meta" htmlFor="evm-index">
              EVM history (Blockscout)
            </label>
            <textarea
              id="evm-index"
              className="textarea"
              rows={1}
              spellCheck={false}
              aria-label="Blockscout"
              value={indexText}
              onChange={(e) => setIndexText(e.target.value)}
            />
            <span className="meta">Finds tokens others send you. Empty turns it off.</span>
          </>
        )}
        {kind === "solana" && (
          <>
            <label className="meta" htmlFor="solana-endpoints">
              {picked.name} (JSON-RPC)
            </label>
            <textarea
              id="solana-endpoints"
              className="textarea"
              rows={2}
              spellCheck={false}
              aria-label="Solana endpoints"
              value={solanaText}
              onChange={(e) => setSolanaText(e.target.value)}
            />
          </>
        )}
        {kind === "evm" && (
          <>
            <label className="meta" htmlFor="chain-endpoints">
              {picked.name} (JSON-RPC)
            </label>
            <textarea
              id="chain-endpoints"
              className="textarea"
              rows={3}
              spellCheck={false}
              aria-label={`${picked.name} endpoints`}
              value={chainText}
              onChange={(e) => setChainText(e.target.value)}
            />
            <label className="meta" htmlFor="chain-history">
              {picked.name} history (Blockscout or Etherscan-style)
            </label>
            <textarea
              id="chain-history"
              className="textarea"
              rows={1}
              spellCheck={false}
              aria-label={`${picked.name} history`}
              value={historyText}
              onChange={(e) => setHistoryText(e.target.value)}
            />
            <span className="meta">Finds your history there. Empty: only what this wallet sent.</span>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span className="meta">Tried in order, one per line.</span>
          <button
            type="button"
            className="pill"
            disabled={!settings}
            onClick={() => {
              if (!settings) return;
              if (kind === "injective") {
                setText(settings.lcdDefault[net].join("\n"));
                setEvmText(settings.evmDefault[net].join("\n"));
                setIndexText(settings.evmIndexDefault[net].join("\n"));
              }
              if (kind === "solana") setSolanaText(settings.solanaDefault[net].join("\n"));
              if (kind === "evm") {
                setChainText((settings.chainsDefault[net][status.chain] ?? []).join("\n"));
                setHistoryText((settings.chainHistoryDefault[net][status.chain] ?? []).join("\n"));
              }
            }}
          >
            Use the defaults
          </button>
        </div>
        {picked.added && <RemoveChain chainId={picked.chainId} name={picked.name} onStatus={onStatus} />}
        <div className="eyebrow" style={{ marginTop: 8 }}>
          USD values
        </div>
        <Segmented
          label="USD values"
          options={[
            ["on", "Show"],
            ["off", "Hide"],
          ]}
          value={prices ? "on" : "off"}
          onChange={(v) => setPrices(v === "on")}
        />
        <span className="meta">Mainnet prices from Choice, Jupiter and DefiLlama. They see no balances.</span>
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Notifications
        </div>
        <Segmented
          label="Notifications"
          options={[
            ["off", "Off"],
            ["active", "This account"],
            ["all", "All accounts"],
          ]}
          value={notify}
          onChange={setNotify}
        />
        <span className="meta">
          {notify === "off"
            ? "No checks in the background."
            : notify === "all"
              ? "Every account, each minute. Your endpoint sees them together."
              : "Tokens in and out, checked each minute, even while locked."}
        </span>
          </>
        )}
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Connected sites
        </div>
        {sites.length === 0 ? (
          <span className="meta">None. A site asks first, in its own window.</span>
        ) : (
          <div className="well rows">
            {sites.map((c) => (
              <div className="row site-row" key={c.origin}>
                <span className="site-name">
                  <GlobeIcon size={16} />
                  {c.origin.replace(/^https:\/\//, "")}
                </span>
                <button
                  type="button"
                  className="pill"
                  aria-label={`Disconnect ${c.origin}`}
                  onClick={() => void backend.send({ type: "disconnect", origin: c.origin }).then((r) => r.ok && setSites(r.result))}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Recipients
        </div>
        <button type="button" className="btn" onClick={onContacts}>
          Address book
        </button>
        <span className="meta">Saved recipients, with the memo an exchange needs.</span>
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Approvals
        </div>
        <button type="button" className="btn" onClick={onApprovals}>
          Approvals and grants
        </button>
        <span className="meta">Who can spend your tokens or act for you. Revoke any of it.</span>
        <button type="button" className="btn" onClick={onRescue}>
          Rescue address
        </button>
        <span className="meta">Where this account&apos;s funds go if its key is lost or stolen.</span>
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Security
        </div>
        {settings && <Segmented label="Lock after" options={LOCK_AFTER} value={lockAfter as (typeof LOCK_AFTER)[number][0]} onChange={setLockAfter} />}
        <span className="meta">Locks after this long without use.</span>
        <button type="button" className="btn" onClick={onLock}>
          <LockIcon /> Lock now
        </button>
        <div className="well rows">
          {wallet && wallet.type !== "ledger" && (
            <button type="button" className="row link-row" onClick={() => setSecurity("phrase")}>
              {wallet.type === "mnemonic" ? `Show ${wallet.name}` : `Show ${wallet.name}'s key`}
            </button>
          )}
          {wallet?.type === "mnemonic" && account?.wallet === wallet.id && account.account.derivation === "default" && (
            <button type="button" className="row link-row" onClick={() => setSecurity("key")}>
              Export {account.name}&apos;s key
            </button>
          )}
          <button type="button" className="row link-row" onClick={() => setSecurity("password")}>
            Change password
          </button>
          <button type="button" className="row link-row danger" onClick={() => setSecurity("reset")}>
            Reset Choice Wallet
          </button>
        </div>
        <p className="footnote">Choice Wallet 0.1.0. Pre-alpha. Not for real funds.</p>
      </Screen>
    </form>
  );
}

/** Take an added chain off the list, with its endpoints. What the account holds there stays
 *  on the chain: adding it again shows it. */
function RemoveChain({ chainId, name, onStatus }: { chainId: number; name: string; onStatus: (s: Status) => void }) {
  const { run, error, busy } = useRequest();
  const [sure, setSure] = useState(false);
  return (
    <>
      {error && <Callout level="amber">{error}</Callout>}
      <button
        type="button"
        className="btn btn-quiet danger-text"
        disabled={busy}
        onClick={() => {
          if (!sure) return setSure(true);
          void run({ type: "remove_chain", chainId }).then((s) => s && onStatus(s));
        }}
      >
        {sure ? `Remove ${name}? Tap again` : `Remove ${name}`}
      </button>
    </>
  );
}
