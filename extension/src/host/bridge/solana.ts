// The rent of a burn's record on Solana: each burn there makes a record (an event account,
// ~0.004 SOL of rent paid by the account), which Circle lets go after its delay
// (EVENT_ACCOUNT_REFUND_DELAY_SEC, 5 days). The burns themselves are ./transfer.ts's.

import { NETWORKS, type NetworkId } from "@choice-wallet/chain";
import type { AccountInfo, Result, SendReview } from "@choice-wallet/ui/protocol";
import { EVENT_ACCOUNT_REFUND_DELAY_SEC, reclaimEventAccountInstruction, type IrisMessage } from "injective-usdc-bridge";

import { fail } from "../util";
import type { BridgeContext } from "./shared";

/** Solana's CCTP domain. */
const SOLANA_DOMAIN = 5;

export function createRentReclaims(c: BridgeContext) {
  const { local, now, solana, rentRecords } = c;

  /** Burns on Solana whose record's rent this account can take back (Circle's delay past),
   *  and those still waiting. A record already closed is forgotten. */
  async function reclaims(network: NetworkId, account: AccountInfo): Promise<Result<{ hash: string; event: string; ready: boolean; at: number }[]>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return { ok: true, result: [] };
    const mine = (await rentRecords()).filter((r) => r.network === network && r.owner === owner);
    if (mine.length === 0) return { ok: true, result: [] };
    let open: (Record<string, unknown> | null)[];
    try {
      open = await (await solana.rpc(network)).accounts(mine.map((r) => r.event));
    } catch {
      return fail("unreachable", `Couldn't reach ${NETWORKS[network].solana.name}.`);
    }
    const closed = new Set(mine.filter((_, i) => open[i] === null && now() - mine[i]!.at > 120_000).map((r) => r.event));
    if (closed.size > 0) await local.set({ solana_rent: (await rentRecords()).filter((r) => !closed.has(r.event)) });
    return {
      ok: true,
      result: mine.filter((r) => !closed.has(r.event)).map((r) => ({ hash: r.hash, event: r.event, at: r.at, ready: now() - r.at > EVENT_ACCOUNT_REFUND_DELAY_SEC * 1000 + 60_000 })),
    };
  }

  /** Take a burn record's rent back, once Circle's delay has passed: its message and
   *  attestation, from Iris, prove Circle read it. */
  async function prepareReclaim(network: NetworkId, account: AccountInfo, hash: unknown): Promise<Result<SendReview>> {
    const owner = solana?.address(network, account);
    if (!solana || !owner) return fail("bad_request", "This account has no Solana address.");
    const r = (await rentRecords()).find((x) => x.network === network && x.owner === owner && x.hash === hash);
    if (!r) return fail("not_found", "Nothing to take back for that transfer.");
    if (now() - r.at < EVENT_ACCOUNT_REFUND_DELAY_SEC * 1000) return fail("not_ready", "Circle lets it go 5 days after the transfer.");
    let m: IrisMessage | undefined;
    try {
      m = (await c.iris(network).getMessages(SOLANA_DOMAIN, r.hash as `0x${string}`))[0];
    } catch {
      return fail("unreachable", "Couldn't reach Circle. Try again.");
    }
    if (!m || m.status !== "complete" || m.attestation === "PENDING") return fail("not_ready", "Circle hasn't confirmed that transfer.");
    const net = NETWORKS[network].solana;
    return solana.prepareInstructions(network, account, {
      instructions: [reclaimEventAccountInstruction({ payee: owner, eventAccount: r.event, message: m.message, attestation: m.attestation })],
      priorityAccounts: [r.event],
      recipient: null,
      balances: {},
      tokens: { sol: { denom: "sol", symbol: "SOL", name: "Solana", decimals: 9, known: true, chain: net.caip2 } },
      expect: (d) => {
        const steps = Array.isArray(d["instructions"]) ? (d["instructions"] as Record<string, unknown>[]) : [];
        const back = steps.filter((x) => x["type"] === "bridge_reclaim");
        return back.length === 1 && back[0]!["event_account"] === r.event && back[0]!["payee"] === owner ? null : "That isn't the rent this account paid.";
      },
    });
  }

  return { reclaims, prepareReclaim };
}
