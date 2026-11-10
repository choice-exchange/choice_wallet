// USDC over Circle's CCTP between any two chains the wallet holds an account on
// (./transfer.ts), and the rent of a burn's record on Solana, which comes back after
// Circle's delay (./solana.ts). Each step is reviewed and signed like a send; the vault reads
// every one and the host holds it to its quote.

import type { Fetch } from "@choice-wallet/chain";

import type { Store } from "../service";
import { createContext, type Sender, type Solana } from "./shared";
import { createRentReclaims } from "./solana";
import { createTransfers } from "./transfer";

export { bridgeLabel } from "./shared";

export function createBridge(sender: Sender, session: Store, local: Store, fetch: Fetch, now: () => number = Date.now, solana?: Solana) {
  const c = createContext(sender, session, local, fetch, now, solana);
  return { ...createTransfers(c), ...createRentReclaims(c) };
}
