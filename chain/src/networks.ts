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
  /** EVM transaction page (by its 0x hash), `{hash}` replaced. */
  evmExplorerTx: string;
  /** Default LCD (Cosmos REST) endpoints, tried in order. */
  lcd: readonly string[];
  /** Default EVM JSON-RPC endpoints, tried in order. */
  evmRpc: readonly string[];
  /** Injective's CW20 adapter: it wraps a CW20 into the bank denom `factory/{adapter}/{cw20}`
   *  and back. The vault holds the same address and builds conversions with its own copy. */
  cw20Adapter: string;
}

// Checked 2026-11-08: each answers with CORS for an extension origin, and serves the right
// chain ID. LCDs: Injective's sentry, Allnodes' publicnode, cosmos.directory's proxy.
// CW20 adapters checked 2026-11-09: mainnet's is labelled "Injective CW20 Adapter" and has
// no admin; testnet's is Injective's "Cw20Adapter" (it has an admin, as testnet contracts do).
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
    evmExplorerTx: "https://blockscout.injective.network/tx/{hash}",
    lcd: [
      "https://sentry.lcd.injective.network",
      "https://injective-rest.publicnode.com",
      "https://rest.cosmos.directory/injective",
    ],
    evmRpc: ["https://sentry.evm-rpc.injective.network", "https://injective-evm-rpc.publicnode.com"],
    cw20Adapter: "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk",
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
    evmExplorerTx: "https://testnet.blockscout.injective.network/tx/{hash}",
    lcd: ["https://testnet.sentry.lcd.injective.network", "https://injective-testnet-rest.publicnode.com"],
    evmRpc: ["https://k8s.testnet.json-rpc.injective.network", "https://injective-testnet-evm-rpc.publicnode.com"],
    cw20Adapter: "inj1hdvy6tl89llqy3ze8lv6mz5qh66sx9enn0jxg6",
  },
};

export function isNetworkId(v: unknown): v is NetworkId {
  return v === "mainnet" || v === "testnet";
}

/** The explorer page for a transaction: a Cosmos hash on injscan, an EVM (0x) hash on
 *  Blockscout. */
export function explorerTxUrl(network: Network, hash: string): string {
  return (hash.startsWith("0x") ? network.evmExplorerTx : network.explorerTx).replace("{hash}", hash);
}

/** Injective's minimum gas price (txfees `min_gas_price`), used if the chain can't say. */
export const MIN_GAS_PRICE = 160_000_000n;
