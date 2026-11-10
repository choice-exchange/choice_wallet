// Receive: the account's address on the chain Home shows, as text and a QR code.

import { NETWORKS } from "@choice-wallet/chain";
import { useState } from "react";

import { useBackend } from "./backend";
import { CheckIcon, CopyIcon } from "./icons";
import { BackBar, Screen, Segmented } from "./kit";
import type { ChainView, NetworkId } from "./protocol";
import { QrCode } from "./QrCode";

/** The account's address on the chain Home shows: Injective's in either form, or Solana's. */
export function Receive({
  addresses,
  network,
  chain,
  ledger,
  onBack,
  onBridgeIn,
}: {
  addresses: Record<string, string>;
  network: NetworkId;
  chain: ChainView;
  /** The account is on a Ledger: its Solana key comes from the device, not a phrase. */
  ledger: boolean;
  onBack: () => void;
  onBridgeIn: () => void;
}) {
  const backend = useBackend();
  const [form, setForm] = useState<"cosmos" | "evm">("cosmos");
  const [copied, setCopied] = useState(false);
  const cluster = NETWORKS[network].solana;
  const side = chain === "solana" ? "solana" : form;
  const net = NETWORKS[network];
  const address = (side === "cosmos" ? addresses[net.cosmos] : side === "evm" ? addresses[net.evm] : addresses[cluster.caip2]) ?? "";
  return (
    <Screen
      top={<BackBar title="Receive" onBack={onBack} />}
      foot={
        <button
          className="btn btn-gold"
          onClick={() =>
            void backend.copy(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy address"}
        </button>
      }
    >
      {chain === "injective" && (
        <Segmented
          label="Address format"
          options={[
            ["cosmos", "Injective"],
            ["evm", "EVM (0x)"],
          ]}
          value={form}
          onChange={(v) => {
            setForm(v);
            setCopied(false);
          }}
        />
      )}
      <div className="surface-hero">
        <div className="eyebrow">{side === "cosmos" ? "Injective address" : side === "evm" ? "EVM address" : `${cluster.name} address`}</div>
        {address && (
          <div className="qr-frame">
            <QrCode text={address} />
          </div>
        )}
        <div className="well">
          <code className="mono address" style={{ fontSize: 15, lineHeight: "22px" }}>
            {address}
          </code>
        </div>
      </div>
      <p className="lead">{side === "solana" ? `Only ${cluster.name} tokens here. Same ${ledger ? "Ledger" : "phrase"}, its own key.` : "Both addresses are the same account."}</p>
      {side !== "solana" && (
        <button type="button" className="btn btn-quiet" onClick={onBridgeIn}>
          USDC on another chain? Bring it in
        </button>
      )}
    </Screen>
  );
}
