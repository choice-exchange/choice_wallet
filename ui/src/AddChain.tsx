// Adding an EVM chain beside the built-in ones: found on chainlist.org's list by name or
// chain ID (its details fill the form, which the user may change), or entered by hand. The
// host keeps each endpoint only if it answers as the chain's ID, and fetches its logo once.

import { addedKey, markOf, type NetworkId } from "@choice-wallet/chain";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ChevronRightIcon } from "./icons";
import { BackBar, Callout, Screen, Switch } from "./kit";
import type { ListedChain, NewChain, Status } from "./protocol";
import { useRequest } from "./request";

export function AddChainView({ network, onAdded, onBack }: { network: NetworkId; onAdded: (s: Status, key: string, network: NetworkId) => void; onBack: () => void }) {
  const [form, setForm] = useState<{ chain: NewChain; listed?: ListedChain } | null>(null);
  if (form) return <AddChainForm initial={form.chain} {...(form.listed ? { listed: form.listed } : {})} onAdded={onAdded} onBack={() => setForm(null)} />;
  return (
    <ChainSearch
      network={network}
      onPick={(l) => setForm({ chain: { chainId: l.chainId, name: l.name, symbol: l.symbol, rpc: l.rpc, ...(l.explorer ? { explorer: l.explorer } : {}), testnet: l.testnet }, listed: l })}
      onManual={() => setForm({ chain: { chainId: 0, name: "", symbol: "", rpc: [], testnet: network === "testnet" } })}
      onBack={onBack}
    />
  );
}

/** A chain's letters on its colour, for one without a logo yet. */
function Monogram({ name, chainId }: { name: string; chainId: number }) {
  const m = markOf(name, chainId);
  return (
    <span className="mark chain-mark" aria-hidden="true" style={{ background: m.color, borderColor: "transparent" }}>
      {m.letters}
    </span>
  );
}

function ChainSearch({ network, onPick, onManual, onBack }: { network: NetworkId; onPick: (c: ListedChain) => void; onManual: () => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ListedChain[] | null>(null);
  const { run, error, setError } = useRequest();
  const asked = useRef(0);
  useEffect(() => {
    const q = query.trim();
    const n = ++asked.current;
    if (!q) {
      setFound(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => {
      void run({ type: "chain_search", query: q }).then((r) => {
        if (n === asked.current) setFound(r);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <Screen
      top={<BackBar title="Add a chain" onBack={onBack} />}
      foot={
        <button className="btn btn-quiet" onClick={onManual}>
          Enter it yourself
        </button>
      }
    >
      <label className="field">
        <span className="eyebrow">Find a chain</span>
        <input className="input" aria-label="Chain name or ID" placeholder="Name or chain ID" autoComplete="off" spellCheck={false} maxLength={40} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <span className="meta">From chainlist.org{network === "testnet" ? ", test networks first" : ""}.</span>
      </label>
      {error && <Callout level="amber">{error}</Callout>}
      {found && found.length === 0 && <p className="meta">No chain by that name or ID on the list.</p>}
      {found && found.length > 0 && (
        <div className="token-list">
          {found.map((c) => (
            <button key={c.chainId} className="token chain-row" onClick={() => onPick(c)}>
              <Monogram name={c.name} chainId={c.chainId} />
              <span className="name">
                <span className="symbol">{c.name}</span>
                <span className="sub">
                  Chain ID {c.chainId} · {c.symbol}
                  {c.testnet ? " · Test network" : ""}
                </span>
              </span>
              <ChevronRightIcon size={16} />
            </button>
          ))}
        </div>
      )}
    </Screen>
  );
}

function AddChainForm({ initial, listed, onAdded, onBack }: { initial: NewChain; listed?: ListedChain; onAdded: (s: Status, key: string, network: NetworkId) => void; onBack: () => void }) {
  const [name, setName] = useState(initial.name);
  const [chainId, setChainId] = useState(initial.chainId ? String(initial.chainId) : "");
  const [symbol, setSymbol] = useState(initial.symbol);
  const [rpc, setRpc] = useState(initial.rpc[0] ?? "");
  const [explorer, setExplorer] = useState(initial.explorer ?? "");
  const [testnet, setTestnet] = useState(initial.testnet);
  const { run, error, busy } = useRequest();
  // The list's other endpoints go along as backups to the one shown.
  const backups = listed ? listed.rpc.filter((u) => u !== rpc.trim()) : [];

  async function add(e: FormEvent) {
    e.preventDefault();
    const id = Number(chainId);
    const chain: NewChain = {
      chainId: id,
      name: name.trim(),
      symbol: symbol.trim(),
      rpc: [rpc.trim(), ...backups].slice(0, 6),
      ...(explorer.trim() ? { explorer: explorer.trim() } : {}),
      testnet,
    };
    const r = await run({ type: "add_chain", chain });
    if (r) onAdded(r, addedKey(id), testnet ? "testnet" : "mainnet");
  }

  return (
    <form onSubmit={(e) => void add(e)} style={{ height: "100%" }}>
      <Screen
        top={<BackBar title={listed ? listed.name : "Add a chain"} onBack={onBack} />}
        foot={
          <>
            {error && <Callout level="amber">{error}</Callout>}
            <button className="btn btn-gold" type="submit" disabled={busy || !name.trim() || !/^[0-9]{1,16}$/.test(chainId) || !symbol.trim() || !rpc.trim()}>
              {busy ? "Checking its endpoints…" : "Add chain"}
            </button>
          </>
        }
      >
        {listed?.flags.includes("reusedChainId") && <Callout level="amber">chainlist.org says another chain uses this chain ID too.</Callout>}
        <label className="field">
          <span className="eyebrow">Name</span>
          <input className="input" aria-label="Chain name" autoComplete="off" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!listed} />
        </label>
        <label className="field">
          <span className="eyebrow">Chain ID</span>
          <input
            className="input mono"
            aria-label="Chain ID"
            inputMode="numeric"
            autoComplete="off"
            readOnly={listed !== undefined}
            value={chainId}
            onChange={(e) => setChainId(e.target.value.replace(/[^0-9]/g, "").slice(0, 16))}
          />
        </label>
        <label className="field">
          <span className="eyebrow">Coin</span>
          <input className="input" aria-label="Coin symbol" placeholder="ETH" autoComplete="off" maxLength={8} value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </label>
        <label className="field">
          <span className="eyebrow">RPC address</span>
          <input className="input mono" aria-label="RPC address" placeholder="https://…" autoComplete="off" spellCheck={false} value={rpc} onChange={(e) => setRpc(e.target.value)} />
          <span className="meta">{backups.length > 0 ? `It must answer as this chain. ${backups.length} more from the list are kept as backups.` : "It must answer as this chain."}</span>
        </label>
        <label className="field">
          <span className="eyebrow">Explorer</span>
          <input className="input mono" aria-label="Explorer address" placeholder="Optional" autoComplete="off" spellCheck={false} value={explorer} onChange={(e) => setExplorer(e.target.value)} />
        </label>
        <Switch label="Test network" checked={testnet} onChange={setTestnet} />
        <p className="meta">The wallet signs there by chain ID. Its coin must have 18 decimals.</p>
      </Screen>
    </form>
  );
}
