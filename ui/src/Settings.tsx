// Settings (a tab): the network, its endpoints, USD values, and locking.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { LockIcon } from "./icons";
import { Screen, Segmented } from "./kit";
import type { NetworkId, Settings } from "./protocol";
import { useRequest } from "./request";

export function SettingsView({ onDone, onLock, tabs }: { onDone: () => void; onLock: () => void; tabs: ReactNode }) {
  const { run, error, busy } = useRequest();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [net, setNet] = useState<NetworkId>("mainnet");
  const [text, setText] = useState("");
  const [prices, setPrices] = useState(true);

  useEffect(() => {
    void run({ type: "settings" }).then((s) => {
      if (!s) return;
      setSettings(s);
      setNet(s.network);
      setText(s.lcd[s.network].join("\n"));
      setPrices(s.prices);
    });
  }, []);

  const pick = (n: NetworkId) => {
    setNet(n);
    if (settings) setText(settings.lcd[n].join("\n"));
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const isDefault = lines.join("\n") === settings.lcdDefault[net].join("\n");
    if (await run({ type: "save_settings", network: net, lcd: isDefault ? null : lines, prices })) onDone();
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
        <textarea
          className="textarea"
          rows={4}
          spellCheck={false}
          aria-label="Endpoints"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span className="meta">Tried in order, one per line.</span>
          <button type="button" className="pill" disabled={!settings} onClick={() => settings && setText(settings.lcdDefault[net].join("\n"))}>
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
