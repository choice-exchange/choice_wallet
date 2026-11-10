// Live Solana run, outside the browser: the real service, vault and endpoints (Injective
// testnet, Solana devnet, Circle's sandbox) on a throwaway testnet phrase. Bundled and run by
// `node live-solana.mjs <mnemonic file> [steps]`; never on mainnet.
//
// Steps: "sol" sends SOL to the phrase's Solana account 1 and back is not needed;
// "usdc" sends USDC there; "in" bridges USDC from Solana devnet into the account on Injective
// testnet and mints it from the wallet (nobody else does on testnet).

import { readFileSync } from "node:fs";

import { handle, initSync } from "choice-wallet-vault-glue";

import { createService, type Store } from "./src/host/service";
import { callVault } from "./src/host/vault";

initSync({ module: readFileSync(process.env["VAULT_WASM"] ?? "build/vault/choice_wallet_wasm_bg.wasm") });

function memory(): Store {
  const data = new Map<string, unknown>();
  return {
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys) => void keys.forEach((k) => data.delete(k)),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [file, steps = "sol,usdc,in"] = process.argv.slice(2);
  if (!file) throw new Error("usage: live-solana.mjs <mnemonic file> [steps]");
  const service = createService({
    vault: async (method, params) => callVault(handle, method, params),
    local: memory(),
    session: memory(),
    fetch: (u, i) => fetch(u, i),
    scheduleLock: () => {},
    cancelLock: () => {},
    openWindow: async () => 1,
    notify: () => {},
    refresh: () => {},
    showNotice: async () => false,
    badge: () => {},
    scheduleWatch: () => {},
  });
  const ok = <T>(r: { ok: boolean; result?: unknown; error?: unknown }, what: string): T => {
    if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.error)}`);
    return r.result as T;
  };
  ok(await service.handle({ type: "create", secret: { mnemonic: readFileSync(file, "utf8").trim() }, password: "live solana run" }), "create");
  ok(await service.handle({ type: "save_settings", network: "testnet", lcd: null }), "testnet");
  const added = ok<{ accounts: { addresses: Record<string, string> }[] }>(await service.handle({ type: "add_account" }), "account 1");
  const SOLANA = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const other = added.accounts[1]?.addresses[SOLANA];
  ok(await service.handle({ type: "switch_account", index: 0 }), "back to account 0");
  if (!other) throw new Error("no second Solana account");
  type Holdings = { address: string; balances: { denom: string; symbol: string; amount: string }[] };
  const holdings = async () => ok<{ solana?: Holdings }>(await service.handle({ type: "balances" }), "balances").solana!;
  const before = await holdings();
  console.log("Solana", before.address, before.balances.map((b) => `${b.symbol} ${b.amount}`).join(", "));

  const land = async (sent: { hash: string; chain?: string }) => {
    for (let i = 0; i < 60; i++) {
      const s = ok<{ state: string; log?: string }>(await service.handle({ type: "tx_status", hash: sent.hash, ...(sent.chain ? { chain: sent.chain } : {}) }), "status");
      if (s.state !== "pending") return s;
      await sleep(2000);
    }
    throw new Error(`${sent.hash} didn't land`);
  };
  type Review = { digest: string; risk: { level: string; findings: { rule: string }[] }; display: { fee?: { total: string } } };

  if (steps.includes("sol")) {
    const r = ok<Review>(await service.handle({ type: "prepare_send", denom: "sol", to: other, amount: "10000000" }), "prepare SOL");
    console.log("SOL review", r.risk.level, r.risk.findings.map((f) => f.rule).join(","), "fee", r.display.fee?.total);
    const sent = ok<{ hash: string; chain: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: r.digest }), "send SOL");
    console.log("SOL sent", sent.explorer, (await land(sent)).state);
  }
  if (steps.includes("usdc")) {
    const usdc = before.balances.find((b) => b.symbol === "USDC");
    if (!usdc) throw new Error("no USDC on devnet");
    const r = ok<Review>(await service.handle({ type: "prepare_send", denom: usdc.denom, to: other, amount: "1000000" }), "prepare USDC");
    console.log("USDC review", r.risk.level, r.risk.findings.map((f) => f.rule).join(","));
    const sent = ok<{ hash: string; chain: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: r.digest }), "send USDC");
    console.log("USDC sent", sent.explorer, (await land(sent)).state);
  }
  if (steps.includes("in")) {
    const routes = ok<{ chains: { key: string }[]; usdc: string }>(await service.handle({ type: "bridge_in_routes" }), "routes");
    if (!routes.chains.some((c) => c.key === "solana")) throw new Error("no Solana route");
    const q = ok<{ id: string; minReceived: string; maxFee: string; gasNeed: string; gasHeld: string; etaMs: number }>(
      await service.handle({ type: "bridge_in_quote", from: "solana", amount: "2000000", gasDrop: false }),
      "quote",
    );
    console.log("quote: at least", q.minReceived, "fee up to", q.maxFee, "SOL need", q.gasNeed, "held", q.gasHeld, "eta", q.etaMs);
    const r = ok<Review>(await service.handle({ type: "prepare_bridge_in", quote: q.id }), "prepare burn");
    console.log("burn review", r.risk.level, r.risk.findings.map((f) => f.rule).join(","));
    const injBefore = ok<{ balances: { denom: string; amount: string }[] }>(await service.handle({ type: "balances" }), "balances").balances.find((b) => b.denom === routes.usdc)?.amount ?? "0";
    const sent = ok<{ hash: string; chain: string; explorer: string }>(await service.handle({ type: "confirm_send", digest: r.digest }), "burn");
    console.log("burned", sent.explorer, (await land(sent)).state);
    const t0 = Date.now();
    let phase = "";
    for (let i = 0; i < 200 && phase !== "ready" && phase !== "delivered"; i++) {
      phase = ok<{ phase: string }>(await service.handle({ type: "bridge_in_status", chain: "solana", hash: sent.hash }), "status").phase;
      if (phase !== "ready" && phase !== "delivered") await sleep(3000);
    }
    console.log("Circle:", phase, `${Math.round((Date.now() - t0) / 1000)} s after the burn`);
    if (phase === "ready") {
      const m = ok<Review>(await service.handle({ type: "prepare_bridge_receive", chain: "solana", hash: sent.hash }), "prepare mint");
      console.log("mint review", m.risk.level, m.risk.findings.map((f) => f.rule).join(","));
      const minted = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: m.digest }), "mint");
      console.log("minted", minted.hash, (await land(minted)).state);
    }
    const injAfter = ok<{ balances: { denom: string; amount: string }[] }>(await service.handle({ type: "balances" }), "balances").balances.find((b) => b.denom === routes.usdc)?.amount ?? "0";
    console.log(`USDC on Injective +${BigInt(injAfter) - BigInt(injBefore)} (at least ${q.minReceived})`);
    if (BigInt(injAfter) - BigInt(injBefore) < BigInt(q.minReceived)) throw new Error("less arrived than the quote");
    const rent = ok<{ hash: string; ready: boolean }[]>(await service.handle({ type: "bridge_reclaims" }), "rent");
    console.log("rent records", rent.map((x) => `${x.hash.slice(0, 8)} ready=${x.ready}`).join(", "));
  }
  const after = await holdings();
  console.log("Solana after", after.balances.map((b) => `${b.symbol} ${b.amount}`).join(", "));
  console.log("LIVE SOLANA OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
