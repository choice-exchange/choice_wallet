// The chains' marks (./assets/chains/, sources in its SOURCES.md), shipped with the wallet:
// nothing is loaded at runtime. Chosen by chain key, never by anything a token says about
// itself.

import { chainByCaip2 } from "@choice-wallet/chain";

import arbitrum from "./assets/chains/arbitrum.png";
import arc from "./assets/chains/arc.png";
import avalanche from "./assets/chains/avalanche.png";
import base from "./assets/chains/base.png";
import ethereum from "./assets/chains/ethereum.png";
import hyperevm from "./assets/chains/hyperevm.png";
import ink from "./assets/chains/ink.png";
import linea from "./assets/chains/linea.png";
import monad from "./assets/chains/monad.png";
import optimism from "./assets/chains/optimism.png";
import plasma from "./assets/chains/plasma.png";
import polygon from "./assets/chains/polygon.png";
import sei from "./assets/chains/sei.png";
import sonic from "./assets/chains/sonic.png";
import unichain from "./assets/chains/unichain.png";
import worldchain from "./assets/chains/worldchain.png";

/** Each EVM chain's mark by its key (the same on mainnet and the test networks). */
export const CHAIN_LOGOS: Readonly<Record<string, string>> = { arbitrum, arc, avalanche, base, ethereum, hyperevm, ink, linea, monad, optimism, plasma, polygon, sei, sonic, unichain, worldchain };

/** The mark of an EVM chain's coin, by the chain's CAIP-2 ID: Ethereum's for every chain whose
 *  gas is ETH, the chain's own for the rest (an added chain's, the logo kept with it). */
export function coinLogo(caip2: string): string | undefined {
  const c = chainByCaip2("mainnet", caip2) ?? chainByCaip2("testnet", caip2);
  if (!c || c.kind !== "evm") return undefined;
  if (c.native.symbol === "ETH") return ethereum;
  return c.added ? c.logo : CHAIN_LOGOS[c.key];
}
