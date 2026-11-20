// Who a site's request pays, read from the vault's decoded display: the addresses the
// exchange-memo rule needs facts about (contacts.ts `facts`). Injective only: that's where
// the wallet reads deposits, so an EVM request on another chain has none.

import { NETWORKS, type NetworkId } from "@choice-wallet/chain";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Recipients of the Cosmos messages: bank sends and CW20 transfers, inside `MsgExec` too. */
function cosmos(messages: unknown, out: Set<string>, depth = 0): void {
  if (!Array.isArray(messages) || depth > 4) return;
  for (const raw of messages) {
    const m = obj(raw);
    if (!m) continue;
    if (m["type"] === "bank_send" && text(m["to"])) out.add(text(m["to"])!);
    const call = obj(m["call"]);
    if (m["type"] === "execute_contract" && call?.["type"] === "cw20_transfer" && text(call["recipient"])) out.add(text(call["recipient"])!);
    if (m["type"] === "authz_exec") cosmos(m["msgs"], out, depth + 1);
  }
}

export function recipientsOf(network: NetworkId, display: unknown): string[] {
  const d = obj(display);
  const out = new Set<string>();
  if (!d) return [];
  switch (d["kind"]) {
    case "cosmos_direct":
    case "cosmos_amino":
      cosmos(d["messages"], out);
      break;
    case "evm_typed_data":
      cosmos(obj(d["injective_tx"])?.["messages"], out);
      break;
    case "evm_transaction": {
      if (d["chain"] !== NETWORKS[network].evm) break;
      const call = obj(d["call"]);
      if (call?.["type"] === "erc20_transfer" && text(call["to"])) out.add(text(call["to"])!);
      else if (call?.["type"] === "transfer" && text(d["to"])) out.add(text(d["to"])!);
      break;
    }
  }
  return [...out];
}
