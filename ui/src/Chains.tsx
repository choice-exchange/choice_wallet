// The chain picker: a pill on Home's top bar, and the sheet it opens. The sheet lists each
// chain with what the account holds there (those holding something first), so nothing is out
// of sight while Home shows one chain, and holds the switch between mainnet and the test
// networks.

import { chainByKey, type NetworkId } from "@choice-wallet/chain";
import { useEffect, useRef } from "react";

import { CHAIN_LOGOS } from "./chainLogos";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { Switch } from "./kit";
import type { ChainView } from "./protocol";
import { TokenMark } from "./TokenMark";

/** One chain in the sheet. No address: the account has no key there (an imported key, a
 *  watched address, a Ledger account). `total` is null while it loads. */
/** `add`: the account has no address there yet, but can get one (a Ledger, from its app). */
export type ChainRow = { chain: ChainView; address?: string; total: string | null; holds?: string; add?: { label: string; run: () => void } };

/** A chain's name on a network: "Injective Testnet", "Solana Devnet", "Base Sepolia". */
export function chainName(chain: ChainView, network: NetworkId): string {
  return chainByKey(network, chain)?.name ?? chain;
}

/** An address short enough to sit beside what's held: "inj1npvw…90dz", "HAgk…Kpqk". */
function compact(a: string): string {
  const head = a.startsWith("inj1") ? 8 : a.startsWith("0x") ? 6 : 4;
  return a.length > head + 6 ? `${a.slice(0, head)}…${a.slice(-4)}` : a;
}

/** A chain's mark: its logo (./chainLogos.ts), or a monogram on its colour for one the wallet
 *  ships none for. */
export function ChainMark({ chain, small, network = "mainnet" }: { chain: ChainView; small?: boolean; network?: NetworkId }) {
  if (chain === "injective" || chain === "solana") {
    return <TokenMark denom={chain === "solana" ? "sol" : "inj"} symbol={chain === "solana" ? "SOL" : "INJ"} known small={small === true} />;
  }
  const logo = CHAIN_LOGOS[chain];
  if (logo) {
    return (
      <span className={small ? "mark sm" : "mark"} style={{ borderColor: "transparent" }} aria-hidden="true">
        <img src={logo} alt="" />
      </span>
    );
  }
  const mark = chainByKey(network, chain)?.mark ?? { letters: chain.slice(0, 2).toUpperCase(), color: "#555" };
  return (
    <span className={small ? "mark sm chain-mark" : "mark chain-mark"} aria-hidden="true" style={{ background: mark.color, borderColor: "transparent" }}>
      {mark.letters}
    </span>
  );
}

export function ChainPill({ chain, network, onClick }: { chain: ChainView; network: NetworkId; onClick: () => void }) {
  return (
    <button className="pill chain-pill" aria-haspopup="dialog" aria-label={`Chain: ${chainName(chain, network)}. Change chain`} onClick={onClick}>
      <span className="chain-pill-mark">
        <ChainMark chain={chain} network={network} small />
        {network === "testnet" && <span className="dot testnet" />}
      </span>
      {chainByKey("mainnet", chain)?.name ?? chainName(chain, network)}
      <ChevronDownIcon size={14} />
    </button>
  );
}

export function ChainSheet({
  chain,
  network,
  rows,
  all,
  onPick,
  onTestnet,
  onClose,
}: {
  chain: ChainView;
  network: NetworkId;
  rows: ChainRow[];
  /** Every chain's total together, when each is in USD. */
  all?: string;
  onPick: (c: ChainView) => void;
  onTestnet: (on: boolean) => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Without scrolling: the sheet starts below its place, and a scroll to it would stay.
    sheet.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-label="Chains" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="title">Chains</span>
          {all && (
            <span className="meta">
              All <span className="sheet-all">{all}</span>
            </span>
          )}
        </div>
        <div className="token-list">
          {rows.map((r) => (
            <button
              key={r.chain}
              className="token chain-row"
              aria-current={r.chain === chain ? "true" : undefined}
              disabled={!r.address && !r.add}
              onClick={() => (r.address ? onPick(r.chain) : r.add?.run())}
            >
              <ChainMark chain={r.chain} network={network} />
              <span className="name">
                <span className="symbol">{chainName(r.chain, network)}</span>
                <span className="sub">{r.address ? [compact(r.address), r.holds].filter(Boolean).join(" · ") : (r.add?.label ?? "Not on this account")}</span>
              </span>
              <span className="value">
                {r.address && (r.total === null ? <span className="skeleton" style={{ width: 56, height: 16 }} /> : <span className="amount">{r.total}</span>)}
              </span>
              <span className="chain-check">{r.chain === chain && <CheckIcon size={16} />}</span>
            </button>
          ))}
        </div>
        <Switch label="Test networks" checked={network === "testnet"} onChange={onTestnet} />
        <p className="meta">{network === "testnet" ? "Each chain's test network. Test tokens only." : "Turn on for each chain's test network."}</p>
      </div>
    </div>
  );
}
