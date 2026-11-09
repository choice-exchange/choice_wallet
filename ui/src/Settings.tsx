// Settings (a tab): the network, its endpoints, USD values, connected sites, and locking.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useBackend } from "./backend";
import { GlobeIcon, LockIcon } from "./icons";
import { Screen, Segmented } from "./kit";
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
  tabs,
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
  tabs: ReactNode;
}) {
  const { run, error, busy } = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [net, setNet] = useState<NetworkId>("mainnet");
  const [text, setText] = useState("");
  const [evmText, setEvmText] = useState("");
  const [indexText, setIndexText] = useState("");
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
      setPrices(s.prices);
      setLockAfter(String(s.autoLock));
      setNotify(s.notify);
    });
  }, []);

  const pick = (n: NetworkId) => {
    setNet(n);
    if (settings) {
      setText(settings.lcd[n].join("\n"));
      setEvmText(settings.evm[n].join("\n"));
      setIndexText(settings.evmIndex[n].join("\n"));
    }
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
    const lcd = lines(text);
    const evm = lines(evmText);
    const evmIndex = lines(indexText);
    const same = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
    if (
      await run({
        type: "save_settings",
        network: net,
        lcd: same(lcd, settings.lcdDefault[net]) ? null : lcd,
        evm: same(evm, settings.evmDefault[net]) ? null : evm,
        evmIndex: same(evmIndex, settings.evmIndexDefault[net]) ? null : evmIndex,
        prices,
        autoLock: Number(lockAfter),
        notify,
      })
    ) {
      onDone();
    }
  }

  const account = status.accounts[status.active];
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
        top={<span className="title">Settings</span>}
        tabs={tabs}
        foot={
          <>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-gold" type="submit" disabled={busy || !settings}>
              Save
            </button>
          </>
        }
      >
        <div className="eyebrow">Network</div>
        <Segmented
          label="Network"
          options={[
            ["mainnet", "Mainnet"],
            ["testnet", "Testnet"],
          ]}
          value={net}
          onChange={pick}
        />
        <div className="eyebrow" style={{ marginTop: 8 }}>
          Endpoints
        </div>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span className="meta">Tried in order, one per line.</span>
          <button
            type="button"
            className="pill"
            disabled={!settings}
            onClick={() => {
              if (!settings) return;
              setText(settings.lcdDefault[net].join("\n"));
              setEvmText(settings.evmDefault[net].join("\n"));
              setIndexText(settings.evmIndexDefault[net].join("\n"));
            }}
          >
            Use the defaults
          </button>
        </div>
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
        <span className="meta">Mainnet prices from Choice. It sees no balances.</span>
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
        <Segmented label="Lock after" options={LOCK_AFTER} value={lockAfter as (typeof LOCK_AFTER)[number][0]} onChange={setLockAfter} />
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
