// USDC over Circle's CCTP, with injective-usdc-bridge: out from Injective to other chains
// (./out.ts), in from other EVM chains (./in.ts) and from Solana (./solana.ts). Each step is
// reviewed and signed like a send; the vault reads every one and holds it to its quote.

import type { Fetch, NetworkId } from "@choice-wallet/chain";

import type { Store } from "../service";
import { createBridgeIn } from "./in";
import { createBridgeOut } from "./out";
import { createContext, sourceByKey, type Sender, type Solana } from "./shared";
import { createBridgeInSolana } from "./solana";

export { bridgeLabel } from "./shared";

export function createBridge(sender: Sender, session: Store, local: Store, fetch: Fetch, now: () => number = Date.now, solana?: Solana) {
  const c = createContext(sender, session, local, fetch, now, solana);
  const fromSolana = createBridgeInSolana(c);
  return {
    ...createBridgeOut(c),
    ...createBridgeIn(c, fromSolana),
    track: c.track,
    reclaims: fromSolana.reclaims,
    prepareReclaim: fromSolana.prepareReclaim,
    source: (network: NetworkId, key: unknown) => sourceByKey(network, key),
  };
}
