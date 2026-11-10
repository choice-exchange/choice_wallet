// Every chain the wallet keeps an account on, beside each Injective network: Injective, Solana,
// and the EVM chains Circle's CCTP joins to them, as injective-usdc-bridge lists them (the
// extension's tests check this copy against the package). The same 0x key signs on every EVM
// chain; the vault pins the same chains (`choice_wallet_injective::cctp::Cctp::evm`).
//
// Default endpoints are the bridge registry's public ones. Each answered `eth_chainId` with
// CORS for an extension origin (checked 2026-11-10); the user can replace them per chain.

import { NETWORKS, type NetworkId } from "./networks.ts";

/** Injective, Solana, or one of the EVM chains beside them. */
export type ChainKind = "injective" | "solana" | "evm";

export interface ChainInfo {
  /** The same on mainnet and the test networks: "injective", "solana", or the bridge
   *  registry's key ("base"). */
  key: string;
  kind: ChainKind;
  /** On this network: "Base", "Base Sepolia". */
  name: string;
  /** CAIP-2 ID the vault names it by. Injective's is its EVM side; its Cosmos side is
   *  `NETWORKS[network].cosmos`. */
  caip2: string;
  /** EIP-155 chain ID, on an EVM chain (Injective's EVM side too). */
  chainId?: number;
  /** Circle's CCTP domain. */
  domain: number;
  /** The coin gas is paid in. On Arc it is USDC, kept at 18 decimals beside the 6-decimal
   *  token, one balance. */
  native: { symbol: string; decimals: number };
  /** Native USDC there: a 0x address, or a Solana mint. */
  usdc: string;
  /** Default endpoints, tried in order. */
  rpc: readonly string[];
  /** Transaction page, `{hash}` replaced. */
  explorerTx: string;
  /** Circle's Forwarding Service mints there. */
  forwarding: boolean;
  /** Circle offers Fast Transfer for burns there. */
  fast: boolean;
  /** Gas is paid in USDC (Arc). */
  gasIsUsdc?: boolean;
  /** An OP Stack chain: each transaction also pays an Ethereum data fee. */
  opStack?: boolean;
  /** Its mark: one or two letters on its colour, for chains the wallet has no logo for. */
  mark: { letters: string; color: string };
  /** DefiLlama's name for it (`base`), where its coin and USDC are priced (mainnet). */
  llama?: string;
  /** Free Etherscan-style indexes (Blockscout, Routescan) that find its history: each
   *  answered an extension origin on 2026-11-10. Many chains have none without a key. */
  history?: readonly string[];
  /** Built in, not added (`AddedInfo`). */
  added?: false;
}

type Evm = Omit<ChainInfo, "kind" | "caip2" | "native"> & { chainId: number; symbol: string };
const evm = (c: Evm): ChainInfo => {
  const { symbol, ...rest } = c;
  return { ...rest, kind: "evm", caip2: `eip155:${c.chainId}`, native: { symbol, decimals: 18 } };
};

function injective(network: NetworkId): ChainInfo {
  const n = NETWORKS[network];
  return {
    key: "injective",
    kind: "injective",
    name: network === "testnet" ? "Injective Testnet" : "Injective",
    caip2: n.evm,
    chainId: n.evmChainId,
    domain: 29,
    native: { symbol: "INJ", decimals: 18 },
    usdc: n.cctp.usdc,
    rpc: n.evmRpc,
    explorerTx: n.evmExplorerTx,
    forwarding: false,
    fast: false,
    mark: { letters: "IN", color: "#0082FA" },
  };
}

function solana(network: NetworkId): ChainInfo {
  const s = NETWORKS[network].solana;
  return {
    key: "solana",
    kind: "solana",
    name: s.name,
    caip2: s.caip2,
    domain: 5,
    native: { symbol: "SOL", decimals: 9 },
    usdc: s.usdcMint,
    rpc: s.rpc,
    explorerTx: s.explorerTx,
    forwarding: true,
    fast: true,
    mark: { letters: "SO", color: "#9945FF" },
  };
}

const MAINNET_EVM: readonly ChainInfo[] = [
  evm({
    key: "ethereum",
    llama: "ethereum",
    name: "Ethereum",
    domain: 0,
    chainId: 1,
    symbol: "ETH",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://mainnet.gateway.tenderly.co"],
    explorerTx: "https://etherscan.io/tx/{hash}",
    history: ["https://eth.blockscout.com", "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan"],
    forwarding: true,
    fast: true,
    mark: { letters: "E", color: "#627EEA" },
  }),
  evm({
    key: "base",
    llama: "base",
    name: "Base",
    domain: 6,
    chainId: 8453,
    symbol: "ETH",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpc: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"],
    explorerTx: "https://basescan.org/tx/{hash}",
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "B", color: "#0052FF" },
  }),
  evm({
    key: "arbitrum",
    llama: "arbitrum",
    name: "Arbitrum",
    domain: 3,
    chainId: 42161,
    symbol: "ETH",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpc: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.gateway.tenderly.co"],
    explorerTx: "https://arbiscan.io/tx/{hash}",
    forwarding: true,
    fast: true,
    mark: { letters: "AR", color: "#28A0F0" },
  }),
  evm({
    key: "optimism",
    llama: "optimism",
    name: "OP Mainnet",
    domain: 2,
    chainId: 10,
    symbol: "ETH",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    rpc: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.gateway.tenderly.co"],
    explorerTx: "https://optimistic.etherscan.io/tx/{hash}",
    history: ["https://explorer.optimism.io"],
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "OP", color: "#FF0420" },
  }),
  evm({
    key: "polygon",
    llama: "polygon",
    name: "Polygon",
    domain: 7,
    chainId: 137,
    symbol: "POL",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpc: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon.gateway.tenderly.co"],
    explorerTx: "https://polygonscan.com/tx/{hash}",
    forwarding: true,
    fast: false,
    mark: { letters: "P", color: "#8247E5" },
  }),
  evm({
    key: "avalanche",
    llama: "avax",
    name: "Avalanche",
    domain: 1,
    chainId: 43114,
    symbol: "AVAX",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    rpc: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com", "https://avalanche.gateway.tenderly.co"],
    explorerTx: "https://snowtrace.io/tx/{hash}",
    history: ["https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan"],
    forwarding: true,
    fast: false,
    mark: { letters: "AV", color: "#E84142" },
  }),
  evm({
    key: "hyperevm",
    llama: "hyperliquid",
    name: "HyperEVM",
    domain: 19,
    chainId: 999,
    symbol: "HYPE",
    usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    rpc: ["https://rpc.hyperliquid.xyz/evm"],
    explorerTx: "https://hyperevmscan.io/tx/{hash}",
    forwarding: true,
    fast: false,
    mark: { letters: "H", color: "#3BB8A8" },
  }),
  evm({
    key: "arc",
    llama: "arc",
    name: "Arc",
    domain: 26,
    chainId: 5042,
    symbol: "USDC",
    usdc: "0x3600000000000000000000000000000000000000",
    rpc: ["https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io"],
    explorerTx: "https://explorer.arc.io/tx/{hash}",
    forwarding: true,
    fast: false,
    gasIsUsdc: true,
    mark: { letters: "A", color: "#2775CA" },
  }),
  evm({
    key: "linea",
    llama: "linea",
    name: "Linea",
    domain: 11,
    chainId: 59144,
    symbol: "ETH",
    usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    rpc: ["https://rpc.linea.build", "https://linea.gateway.tenderly.co"],
    explorerTx: "https://lineascan.build/tx/{hash}",
    forwarding: true,
    fast: true,
    mark: { letters: "L", color: "#4A4A4A" },
  }),
  evm({
    key: "unichain",
    llama: "unichain",
    name: "Unichain",
    domain: 10,
    chainId: 130,
    symbol: "ETH",
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    rpc: ["https://mainnet.unichain.org"],
    explorerTx: "https://uniscan.xyz/tx/{hash}",
    history: ["https://unichain.blockscout.com"],
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "U", color: "#F50DB4" },
  }),
  evm({
    key: "sonic",
    llama: "sonic",
    name: "Sonic",
    domain: 13,
    chainId: 146,
    symbol: "S",
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    rpc: ["https://rpc.soniclabs.com", "https://sonic.drpc.org"],
    explorerTx: "https://sonicscan.org/tx/{hash}",
    forwarding: true,
    fast: false,
    mark: { letters: "S", color: "#E2742C" },
  }),
  evm({
    key: "worldchain",
    llama: "wc",
    name: "World Chain",
    domain: 14,
    chainId: 480,
    symbol: "ETH",
    usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    rpc: ["https://worldchain-mainnet.g.alchemy.com/public"],
    explorerTx: "https://worldscan.org/tx/{hash}",
    history: ["https://worldchain-mainnet.explorer.alchemy.com"],
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "W", color: "#5A5A5A" },
  }),
  evm({
    key: "monad",
    llama: "monad",
    name: "Monad",
    domain: 15,
    chainId: 143,
    symbol: "MON",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    rpc: ["https://rpc.monad.xyz"],
    explorerTx: "https://monadscan.com/tx/{hash}",
    forwarding: true,
    fast: false,
    mark: { letters: "M", color: "#836EF9" },
  }),
  evm({
    key: "sei",
    llama: "sei",
    name: "Sei",
    domain: 16,
    chainId: 1329,
    symbol: "SEI",
    usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    rpc: ["https://evm-rpc.sei-apis.com"],
    explorerTx: "https://seiscan.io/tx/{hash}",
    forwarding: true,
    fast: false,
    mark: { letters: "SE", color: "#B5302A" },
  }),
  evm({
    key: "plasma",
    llama: "plasma",
    name: "Plasma",
    domain: 33,
    chainId: 9745,
    symbol: "XPL",
    usdc: "0x2d661C89D812261039AF9764eceaAee884f5F67F",
    rpc: ["https://rpc.plasma.to"],
    explorerTx: "https://plasmascan.to/tx/{hash}",
    forwarding: false,
    fast: false,
    mark: { letters: "PL", color: "#1B9E77" },
  }),
  evm({
    key: "ink",
    llama: "ink",
    name: "Ink",
    domain: 21,
    chainId: 57073,
    symbol: "ETH",
    usdc: "0x2D270e6886d130D724215A266106e6832161EAEd",
    rpc: ["https://rpc-gel.inkonchain.com"],
    explorerTx: "https://explorer.inkonchain.com/tx/{hash}",
    history: ["https://explorer.inkonchain.com"],
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "I", color: "#7132F5" },
  }),
];

const TESTNET_EVM: readonly ChainInfo[] = [
  evm({
    key: "ethereum",
    name: "Sepolia",
    domain: 0,
    chainId: 11155111,
    symbol: "ETH",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    rpc: ["https://ethereum-sepolia-rpc.publicnode.com"],
    explorerTx: "https://sepolia.etherscan.io/tx/{hash}",
    history: ["https://eth-sepolia.blockscout.com"],
    forwarding: true,
    fast: true,
    mark: { letters: "E", color: "#627EEA" },
  }),
  evm({
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chainId: 84532,
    symbol: "ETH",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpc: ["https://sepolia.base.org"],
    explorerTx: "https://sepolia.basescan.org/tx/{hash}",
    history: ["https://base-sepolia.blockscout.com"],
    forwarding: true,
    fast: true,
    opStack: true,
    mark: { letters: "B", color: "#0052FF" },
  }),
  evm({
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chainId: 421614,
    symbol: "ETH",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    rpc: ["https://sepolia-rollup.arbitrum.io/rpc"],
    explorerTx: "https://sepolia.arbiscan.io/tx/{hash}",
    forwarding: true,
    fast: true,
    mark: { letters: "AR", color: "#28A0F0" },
  }),
];

/** The chains built in, on a network, in the order the wallet lists them: Injective, Solana,
 *  then the EVM chains on CCTP. */
export const CHAINS: Readonly<Record<NetworkId, readonly ChainInfo[]>> = {
  mainnet: [injective("mainnet"), solana("mainnet"), ...MAINNET_EVM],
  testnet: [injective("testnet"), solana("testnet"), ...TESTNET_EVM],
};

/** A chain the user added (or a site asked for, and the user let it): any EVM chain whose
 *  coin has 18 decimals. The vault signs there by chain ID alone, and the review says the
 *  chain was added; its name, coin symbol and logo are the user's labels. Kept in local
 *  storage (`added_chains`), on mainnet's list or the test networks'. */
export interface AddedChain {
  chainId: number;
  name: string;
  symbol: string;
  /** Endpoints, tried in order. */
  rpc: string[];
  /** The explorer's address: a transaction's page is `{explorer}/tx/{hash}`. */
  explorer?: string;
  testnet: boolean;
  /** Its logo, a data URL, fetched once when it was added. */
  logo?: string;
  /** DefiLlama's name for it, where its coin is priced. */
  llama?: string;
}

/** An added chain as the wallet lists it: an EVM chain without CCTP (no domain, no USDC
 *  there), so the bridge never offers it. */
export type AddedInfo = Omit<ChainInfo, "kind" | "domain" | "usdc" | "forwarding" | "fast" | "added" | "chainId"> & {
  kind: "evm";
  chainId: number;
  added: true;
  logo?: string;
};

/** Any chain on the wallet's list: built in, or added. */
export type AnyChain = ChainInfo | AddedInfo;

/** The most chains one wallet adds. */
export const MAX_ADDED_CHAINS = 32;
/** The highest chain ID a chain may have (MetaMask's: an EIP-155 `v` still fits 53 bits). */
export const MAX_CHAIN_ID = 4503599627370476;

/** An added chain's key: `added-56`. */
export const addedKey = (chainId: number): string => `added-${chainId}`;

/** One or two letters and a colour from a chain's name and ID, for one without a logo. */
export function markOf(name: string, chainId: number): { letters: string; color: string } {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  const hue = (chainId * 137) % 360;
  return { letters, color: `hsl(${hue} 45% 38%)` };
}

function addedInfo(a: AddedChain): AddedInfo {
  return {
    key: addedKey(a.chainId),
    kind: "evm",
    added: true,
    name: a.name,
    caip2: `eip155:${a.chainId}`,
    chainId: a.chainId,
    native: { symbol: a.symbol, decimals: 18 },
    rpc: a.rpc,
    explorerTx: a.explorer ? `${a.explorer.replace(/\/+$/, "")}/tx/{hash}` : "",
    mark: markOf(a.name, a.chainId),
    ...(a.llama ? { llama: a.llama } : {}),
    ...(a.logo ? { logo: a.logo } : {}),
  };
}

/** The chains added, as last set: both the service worker and each extension page set them
 *  from local storage (through status) before reading the list. */
let added: { mainnet: readonly AddedInfo[]; testnet: readonly AddedInfo[]; list: readonly AddedChain[] } = { mainnet: [], testnet: [], list: [] };

/** Replace the added chains (each one's ID not built in, as `checkAddedChain` checks). */
export function setAddedChains(list: readonly AddedChain[]): void {
  const builtIn = new Set([...CHAINS.mainnet, ...CHAINS.testnet].map((c) => c.chainId));
  const ok = list.filter((a) => !builtIn.has(a.chainId));
  added = {
    mainnet: ok.filter((a) => !a.testnet).map(addedInfo),
    testnet: ok.filter((a) => a.testnet).map(addedInfo),
    list: ok,
  };
}

/** The chains added, as stored. */
export function addedChains(): readonly AddedChain[] {
  return added.list;
}

/** Every chain on a network: the ones built in, then the ones added. */
export function chainList(network: NetworkId): readonly AnyChain[] {
  return [...CHAINS[network], ...added[network]];
}

/** A chain by key on a network, built in or added. */
export function chainByKey(network: NetworkId, key: unknown): AnyChain | undefined {
  return typeof key === "string" ? chainList(network).find((c) => c.key === key) : undefined;
}

/** A chain by CAIP-2 ID (Injective's Cosmos side names Injective too). */
export function chainByCaip2(network: NetworkId, caip2: string): AnyChain | undefined {
  if (caip2 === NETWORKS[network].cosmos) return CHAINS[network][0];
  return chainList(network).find((c) => c.caip2 === caip2);
}

/** A built-in chain by key: the ones CCTP joins, which the bridge works between. */
export function cctpChain(network: NetworkId, key: unknown): ChainInfo | undefined {
  return typeof key === "string" ? CHAINS[network].find((c) => c.key === key) : undefined;
}

/** A built-in chain by CAIP-2 ID. */
export function cctpChainByCaip2(network: NetworkId, caip2: string): ChainInfo | undefined {
  if (caip2 === NETWORKS[network].cosmos) return CHAINS[network][0];
  return CHAINS[network].find((c) => c.caip2 === caip2);
}

/** Why a chain can't be added as given, or null. Endpoints and the explorer are checked
 *  where they're used (the RPC must answer with the chain's ID). */
export function checkAddedChain(a: { chainId: unknown; name: unknown; symbol: unknown }): string | null {
  if (typeof a.chainId !== "number" || !Number.isSafeInteger(a.chainId) || a.chainId < 1 || a.chainId > MAX_CHAIN_ID) return "That isn't a chain ID.";
  const builtIn = [...CHAINS.mainnet, ...CHAINS.testnet].find((c) => c.chainId === a.chainId);
  if (builtIn) return `${builtIn.name} is already on the list.`;
  if (typeof a.name !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} .()'_-]{0,31}$/u.test(a.name)) return "Give it a name: letters and numbers, up to 32.";
  if (typeof a.symbol !== "string" || !/^[A-Za-z0-9.]{1,8}$/.test(a.symbol)) return "Give its coin a symbol: up to 8 letters or numbers.";
  return null;
}

/** The wallet keys of an EVM chain's coin and of a token there. Injective's own keep their
 *  bank denoms (`inj`, `erc20:0x…`). */
export const chainCoin = (caip2: string): string => `native:${caip2}`;
export const chainUsdc = (caip2: string): string => `usdc:${caip2}`;

/** The chain a `native:`/`usdc:` key is on, and which it is. */
export function chainDenom(denom: string): { caip2: string; what: "native" | "usdc" } | null {
  const m = /^(native|usdc):(eip155:[0-9]+)$/.exec(denom);
  return m ? { caip2: m[2]!, what: m[1] as "native" | "usdc" } : null;
}
