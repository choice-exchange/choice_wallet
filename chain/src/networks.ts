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
  /** Default Blockscout instances, to find ERC20 transfers someone else made to this
   *  account (see ./evmindex.ts). The user can clear them. */
  evmIndex: readonly string[];
  /** Injective's CW20 adapter: it wraps a CW20 into the bank denom `factory/{adapter}/{cw20}`
   *  and back. The vault holds the same address and builds conversions with its own copy. */
  cw20Adapter: string;
  /** Choice on the EVM side: its routing API, and the contracts a swap uses. The vault pins
   *  the same addresses (`choice_wallet_injective::choice`) and checks every swap against
   *  its own copy; these let the host read allowances and turn away a route early. */
  choice: {
    api: string;
    aggregator: string | null;
    universalRouter: string;
    permit2: string;
    wrappedInj: string;
    /** Choice's CLMM position manager (CosmWasm): each position is an NFT it issues. */
    clmmManager: string;
  };
  /** Circle's CCTP V2: native USDC (bank denom `erc20:` + `usdc`), TokenMessengerV2, which
   *  burns it to send it to another chain, and MessageTransmitterV2, which mints what comes
   *  in (or Choice's BridgeReceiver, for a transfer that also buys INJ for gas). The vault
   *  pins the same addresses (`choice_wallet_injective::cctp`), as does injective-usdc-bridge. */
  cctp: { usdc: string; tokenMessenger: string; messageTransmitter: string; bridgeReceiver: string | null };
}

// Checked 2026-11-08: each answers with CORS for an extension origin, and serves the right
// chain ID. LCDs: Injective's sentry, Allnodes' publicnode, cosmos.directory's proxy.
// CW20 adapters checked 2026-11-09: mainnet's is labelled "Injective CW20 Adapter" and has
// no admin; testnet's is Injective's "Cw20Adapter" (it has an admin, as testnet contracts do).
// Blockscout checked 2026-11-09: Injective's instances, CORS open, 300 requests per window.
// Choice checked 2026-11-09: code at each address on its chain, the aggregator's VERSION()
// is "1.1.0", and each routing API answered a quote.
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
    evmIndex: ["https://blockscout.injective.network"],
    cw20Adapter: "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk",
    choice: {
      api: "https://evm-api.choice.exchange",
      aggregator: "0xa705d0D5f549Af25024038dc575E3074B9Bd37c9",
      universalRouter: "0xDF242D1937Cfaf2F3f5245CFBd5A8F2012cda856",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      wrappedInj: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
      // "Choice CLMM Manager", code 2041 (checked 2026-11-09).
      clmmManager: "inj1eag2kjzs5ma5sflxvlhaacdxxpvdjg4ny7yg3g",
    },
    cctp: {
      usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      bridgeReceiver: "0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A",
    },
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
    evmIndex: ["https://testnet.blockscout.injective.network"],
    cw20Adapter: "inj1hdvy6tl89llqy3ze8lv6mz5qh66sx9enn0jxg6",
    // No aggregator on testnet: only routes on Choice's own pools, through the router.
    choice: {
      api: "https://testnet-api-v2.choice.exchange",
      aggregator: null,
      universalRouter: "0x6F82761E0103846E4F4588DB5B7A5505A2907B04",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      wrappedInj: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
      // "Choice CLMM Manager", code 39613, as Choice's testnet app uses it (2026-11-09).
      clmmManager: "inj1srtw4f8yzf4dvnmqr02n7qhpt2px0zf0v9lz5e",
    },
    cctp: {
      usdc: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
      tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      bridgeReceiver: null,
    },
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
