// The networks the wallet talks to, with default endpoints. Users can replace the
// endpoints; the defaults are several independent public ones, never only Choice's.

export type NetworkId = "mainnet" | "testnet";

export interface Network {
  id: NetworkId;
  name: string;
  /** CAIP-2 ID of the Cosmos side, as the vault names it. */
  cosmos: string;
  /** Cosmos chain ID. */
  chainId: string;
  /** CAIP-2 ID of the EVM side. */
  evm: string;
  evmChainId: number;
  feeDenom: string;
  /** Transaction page, `{hash}` replaced. */
  explorerTx: string;
  /** Default LCD (Cosmos REST) endpoints, tried in order. */
  lcd: readonly string[];
  /** Default EVM JSON-RPC endpoints, tried in order. */
  evmRpc: readonly string[];
}

// Checked 2026-11-08: each answers with CORS for an extension origin, and serves the right
// chain ID. LCDs: Injective's sentry, Allnodes' publicnode, cosmos.directory's proxy.
export const NETWORKS: Readonly<Record<NetworkId, Network>> = {
  mainnet: {
    id: "mainnet",
    name: "Injective",
    cosmos: "cosmos:injective-1",
    chainId: "injective-1",
    evm: "eip155:1776",
    evmChainId: 1776,
    feeDenom: "inj",
    explorerTx: "https://injscan.com/transaction/{hash}",
    lcd: [
      "https://sentry.lcd.injective.network",
      "https://injective-rest.publicnode.com",
      "https://rest.cosmos.directory/injective",
    ],
    evmRpc: ["https://sentry.evm-rpc.injective.network", "https://injective-evm-rpc.publicnode.com"],
  },
  testnet: {
    id: "testnet",
    name: "Injective testnet",
    cosmos: "cosmos:injective-888",
    chainId: "injective-888",
    evm: "eip155:1439",
    evmChainId: 1439,
    feeDenom: "inj",
    explorerTx: "https://testnet.injscan.com/transaction/{hash}",
    lcd: ["https://testnet.sentry.lcd.injective.network", "https://injective-testnet-rest.publicnode.com"],
    evmRpc: ["https://k8s.testnet.json-rpc.injective.network", "https://injective-testnet-evm-rpc.publicnode.com"],
  },
};

export function isNetworkId(v: unknown): v is NetworkId {
  return v === "mainnet" || v === "testnet";
}

/** The explorer page for a transaction. */
export function explorerTxUrl(network: Network, hash: string): string {
  return network.explorerTx.replace("{hash}", hash);
}

/** Injective's minimum gas price (txfees `min_gas_price`), used if the chain can't say. */
export const MIN_GAS_PRICE = 160_000_000n;
