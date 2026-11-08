// Settings (a tab): the network, its endpoints, USD values, connected sites, and locking.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { useBackend } from "./backend";
import { GlobeIcon, LockIcon } from "./icons";
import { Screen, Segmented } from "./kit";
import type { Connection, NetworkId, Settings } from "./protocol";
import { useRequest } from "./request";

export function SettingsView({ onDone, onLock, tabs }: { onDone: () => void; onLock: () => void; tabs: ReactNode }) {
  const { run, error, busy } = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [net, setNet] = useState<NetworkId>("mainnet");
  const [text, setText] = useState("");
  const [evmText, setEvmText] = useState("");
  const [prices, setPrices] = useState(true);
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
      setPrices(s.prices);
    });
  }, []);

  const pick = (n: NetworkId) => {
    setNet(n);
    if (settings) {
      setText(settings.lcd[n].join("\n"));
      setEvmText(settings.evm[n].join("\n"));
    }
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
    const lcd = lines(text);
    const evm = lines(evmText);
    const same = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
    if (
      await run({
        type: "save_settings",
        network: net,
        lcd: same(lcd, settings.lcdDefault[net]) ? null : lcd,
        evm: same(evm, settings.evmDefault[net]) ? null : evm,
        prices,
      })
    ) {
      onDone();
    }
  }

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
          Security
        </div>
        <button type="button" className="btn" onClick={onLock}>
          <LockIcon /> Lock now
        </button>
        <p className="footnote">Choice Wallet 0.1.0. Pre-alpha. Not for real funds.</p>
      </Screen>
    </form>
  );
}
