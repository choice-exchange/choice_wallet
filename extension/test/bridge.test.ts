// USDC between any two chains over Circle's CCTP, through the service: fees from a fake Iris,
// each step's calldata (or Solana instruction) read by the real WASM vault and held to its
// quote, then followed until it lands.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE_USDC, BRIDGE_RECEIVER, chain, code, INJ, MESSAGE_TRANSMITTER, ME_EVM, ME_SOL, ok, THEM, THEM_EVM, TOKEN_MESSENGER, USDC, USDC_ERC20, wallet } from "./fake";

type Quote = {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  recipient: string;
  own: boolean;
  amount: string;
  maxFee: string;
  gasDropFee: string;
  gasDropInj: string;
  minReceived: string;
  recipientSetup: boolean;
  fast: boolean;
  steps: string[];
  delivery: string;
  gasNeed: string;
  gasHeld: string;
  gasSymbol: string;
};
type Review = {
  digest: string;
  display: { chain: string; to: string; value: string; call: Record<string, unknown>; network?: { name: string; symbol: string; decimals: number } };
  risk: { level: string; findings: { rule: string; message: string }[] };
  tokens: Record<string, { symbol: string; decimals: number }>;
  bridge?: { step: string; left: number; from: string; to: string; fromKey: string; toKey: string; recipient: string; amount: string; maxFee: string; minReceived: string; usdc: string; arriving: string; delivery: string };
};
type Status = { phase: string; selfMint: boolean; track: string; to: string; mintTx?: string; mintUrl?: string };
type Pending = { from: string; fromName: string; to: string; toName: string; hash: string; amount: string }[];

const rules = (r: Review) => r.risk.findings.map((f) => f.rule);
/** RFC 8032's first Ed25519 test key, as a Solana wallet address. */
const SOL_WALLET = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const allowance = (net: ReturnType<typeof chain>, amount: bigint) => (net.state.erc20Allowance[`${USDC_ERC20} ${TOKEN_MESSENGER.toLowerCase()}`] = amount);

/** A message as Iris returns it, attested: `amount` burned on `source` for `recipient` on
 *  `destination`. */
function attestedMessage(recipient: string, amount: bigint, nonce: string, o: { caller?: string; source?: number; destination?: number; token?: string } = {}) {
  const caller = o.caller ?? "0".repeat(64);
  const w = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const n = (v: bigint | number, bytes: number) => BigInt(v).toString(16).padStart(bytes * 2, "0");
  const tm = w(TOKEN_MESSENGER);
  const [source, destination] = [o.source ?? 6, o.destination ?? 29];
  const header = n(1, 4) + n(source, 4) + n(destination, 4) + nonce.slice(2) + tm + tm + caller + n(1000, 4) + n(1000, 4);
  const body = n(1, 4) + w(o.token ?? BASE_USDC) + w(recipient) + n(amount, 32) + w(recipient) + n(2500, 32) + n(2500, 32) + n(0, 32);
  return { status: "complete", message: `0x${header}${body}`, attestation: `0x${"07".repeat(65)}`, eventNonce: nonce, cctpVersion: 2, delayReason: null, decodedMessage: { sourceDomain: String(source), destinationDomain: String(destination), destinationCaller: `0x${caller}` } };
}

test("routes: every chain, this account's address and USDC on each, and Choice's top-up", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  net.state.base.usdc = 12_000_000n;
  const { service } = await wallet(net);
  type End = { key: string; name: string; kind: string; address: string; usdc: string | null; native: string | null; symbol: string; decimals: number };
  const r = ok<{ chains: End[]; gasDrop: boolean; inj: string }>(await service.handle({ type: "bridge_routes" }));
  assert.equal(r.gasDrop, true);
  assert.equal(r.inj, INJ.toString());
  const by = (k: string) => r.chains.find((c) => c.key === k)!;
  assert.deepEqual([by("injective").address, by("injective").usdc], [ME_EVM, "30000000"]);
  assert.deepEqual([by("base").name, by("base").address, by("base").usdc, by("base").native, by("base").symbol], ["Base", ME_EVM, "12000000", (10n ** 16n).toString(), "ETH"]);
  assert.deepEqual([by("solana").kind, by("solana").address, by("solana").usdc, by("solana").decimals], ["solana", ME_SOL, "5000000", 9]);
  // The fake answers only Base among the EVM chains: the others come back unknown, not zero.
  assert.equal(by("arbitrum").usdc, null);
  // Plasma too: Circle doesn't deliver there, so the wallet would mint it itself.
  assert.ok(by("plasma"));
});

test("Injective to its own address on Base: approve exactly, then the burn Circle delivers", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  const { service, local } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "injective", to: "base", amount: "25000000", recipient: ME_EVM.toLowerCase() }));
  assert.deepEqual([q.steps, q.toName, q.recipient, q.own, q.delivery, q.fast], [["approve", "burn"], "Base", ME_EVM, true, "circle", false]);
  // Standard from Injective is free; Circle's forwarding fee (the "med" tier) is the most.
  assert.equal(q.maxFee, "54000");
  assert.equal(q.minReceived, "24946000");
  assert.equal(q.gasSymbol, "INJ");
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/29/6?forward=true"));
  // No user-agent reaches Circle: from a service worker it would be a CORS preflight.
  assert.ok(net.state.irisAsks.every((a) => !("user-agent" in a.headers)));

  const approve = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([approve.bridge?.step, approve.bridge?.left, approve.bridge?.usdc, approve.bridge?.fromKey], ["approve", 1, USDC, "injective"]);
  assert.equal(approve.display.to.toLowerCase(), USDC_ERC20);
  assert.deepEqual(approve.display.call, { type: "approve", spender: TOKEN_MESSENGER, amount: "25000000" });
  assert.match(approve.risk.findings[0]!.message, /^Circle's bridge \(CCTP\) could spend this token/);
  ok(await service.handle({ type: "confirm_send", digest: approve.digest }));
  allowance(net, 25_000_000n);

  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([burn.bridge?.step, burn.bridge?.left, burn.bridge?.toKey, burn.bridge?.arriving], ["burn", 0, "base", "usdc:eip155:8453"]);
  assert.equal(burn.display.to, TOKEN_MESSENGER);
  assert.deepEqual(
    [burn.display.call["type"], burn.display.call["chain"], burn.display.call["recipient"], burn.display.call["amount"], burn.display.call["max_fee"], burn.display.call["delivery"]],
    ["bridge", "Base", ME_EVM, "25000000", "54000", "circle"],
  );
  assert.equal(burn.risk.level, "info");
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_forward"]);
  const sent = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: burn.digest }));
  assert.equal(net.state.evmSent.length, 2);
  // Followed until Circle delivers it.
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_pending" })).map((p) => [p.from, p.to, p.hash, p.amount]), [["injective", "base", sent.hash, "25000000"]]);
  let s = ok<Status>(await service.handle({ type: "bridge_status", from: "injective", hash: sent.hash }));
  assert.deepEqual([s.phase, s.track], ["pending", `https://bridge.choice.exchange/tx/29/${sent.hash}`]);
  const mint = `0x${"6b".repeat(32)}`;
  // Hardening: Circle's mint hash goes into the explorer link only in a hash's form.
  net.state.iris[sent.hash] = [{ ...attestedMessage(ME_EVM, 25_000_000n, `0x${"5c".repeat(32)}`, { source: 29, destination: 6, token: USDC_ERC20 }), forwardState: "CONFIRMED", forwardTxHash: `${mint}/../../address/x?y` }];
  s = ok<Status>(await service.handle({ type: "bridge_status", from: "injective", hash: sent.hash }));
  assert.deepEqual([s.phase, s.mintTx, s.mintUrl], ["delivered", undefined, undefined]);
  net.state.iris[sent.hash] = [{ ...attestedMessage(ME_EVM, 25_000_000n, `0x${"5c".repeat(32)}`, { source: 29, destination: 6, token: USDC_ERC20 }), forwardState: "CONFIRMED", forwardTxHash: mint }];
  s = ok<Status>(await service.handle({ type: "bridge_status", from: "injective", hash: sent.hash }));
  assert.deepEqual([s.phase, s.to, s.mintTx, s.mintUrl], ["delivered", "base", mint, `https://basescan.org/tx/${mint}`]);
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_pending" })), []);
  assert.ok(Array.isArray(local.data.get("bridge_transfers")));
});

test("someone else's address: amber; a checksum typo, a non-address or too little: refused", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  allowance(net, 100_000_000n);
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "injective", to: "arbitrum", amount: "max", recipient: THEM_EVM }));
  assert.deepEqual([q.steps, q.amount, q.own], [["burn"], "30000000", false]);
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(burn.risk.level, "amber");
  assert.ok(rules(burn).includes("bridge_recipient"));
  assert.equal(burn.display.call["recipient"], THEM_EVM);

  const typo = THEM_EVM.slice(0, -1) + (THEM_EVM.endsWith("F") ? "f" : "F");
  const quote = (to: string, amount: string, recipient: string) => service.handle({ type: "bridge_quote", from: "injective", to, amount, recipient });
  assert.equal(code(await quote("arbitrum", "1000000", typo)), "bad_recipient");
  assert.equal(code(await quote("arbitrum", "1000000", "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz")), "bad_recipient");
  assert.equal(code(await quote("injective", "1000000", ME_EVM)), "bad_request");
  assert.equal(code(await quote("dogechain", "1000000", ME_EVM)), "bad_request");
  assert.equal(code(await quote("base", "40000000", ME_EVM)), "insufficient");
  // Not enough to cover Circle's fee.
  assert.equal(code(await quote("base", "54000", ME_EVM)), "bridge_amount");
  net.state.irisDown = true;
  assert.equal(code(await quote("base", "1000000", ME_EVM)), "unreachable");
});

test("Plasma, where Circle doesn't deliver: a plain burn, minted there by whoever claims it", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  allowance(net, 100_000_000n);
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "injective", to: "plasma", amount: "5000000", recipient: ME_EVM }));
  assert.deepEqual([q.delivery, q.maxFee], ["anyone", "0"]);
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/29/33"));
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([burn.display.call["chain"], burn.display.call["delivery"]], ["Plasma", "claim"]);
  assert.ok(rules(burn).includes("bridge_claim"));
});

test("Injective to Solana: a wallet with no USDC account gets one opened by Circle; a token account is refused", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  allowance(net, 100_000_000n);
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "injective", to: "solana", amount: "5000000", recipient: SOL_WALLET }));
  assert.equal(q.recipientSetup, true);
  assert.equal(q.maxFee, "290000");
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/29/5?forward=true&includeRecipientSetup=true"));
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(burn.display.call["chain"], "Solana");
  assert.equal(burn.display.call["account_owner"], SOL_WALLET);
  // The burn names the wallet's USDC account; the rules name the wallet.
  assert.notEqual(burn.display.call["recipient"], SOL_WALLET);
  const named = burn.risk.findings.find((f) => f.rule === "bridge_recipient");
  assert.match(named!.message, /^Arrives at FVen3X/);

  // A wallet that has one: the plain request, cheaper.
  const ata = String(burn.display.call["recipient"]);
  net.state.solanaAccounts[ata] = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
  const q2 = ok<Quote>(await service.handle({ type: "bridge_quote", from: "injective", to: "solana", amount: "5000000", recipient: SOL_WALLET }));
  assert.equal(q2.recipientSetup, false);
  assert.equal(q2.maxFee, "130000");
  const burn2 = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q2.id }));
  assert.equal(burn2.display.call["recipient"], ata);
  assert.equal(burn2.display.call["account_owner"], null);
  // That USDC account itself, typed as the recipient.
  assert.equal(code(await service.handle({ type: "bridge_quote", from: "injective", to: "solana", amount: "5000000", recipient: ata })), "bad_recipient");
});

test("Base to Arbitrum, with Injective at neither end: approve and burn on Base, Circle delivers", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.usdc = 30_000_000n;
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "base", to: "arbitrum", amount: "25000000", recipient: ME_EVM }));
  // Fast from Base: 1 bp (2,500) and a fifth on top, plus Circle's delivery on Arbitrum.
  assert.deepEqual([q.steps, q.fast, q.delivery, q.maxFee, q.gasSymbol], [["approve", "burn"], true, "circle", "57000", "ETH"]);
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/6/3?forward=true"));
  const approve = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(approve.display.chain, "eip155:8453");
  assert.deepEqual(approve.display.network, { name: "Base", symbol: "ETH", decimals: 18, added: false });
  assert.deepEqual(approve.display.call, { type: "approve", spender: TOKEN_MESSENGER, amount: "25000000" });
  assert.equal(approve.tokens["usdc:eip155:8453"]?.symbol, "USDC");
  // Base is OP Stack: its Ethereum data fee is bounded by its GasPriceOracle and counted.
  assert.equal((approve as Review & { dataFee?: string }).dataFee, "4660000000");
  const sent = ok<{ hash: string; explorer: string; chain?: string }>(await service.handle({ type: "confirm_send", digest: approve.digest }));
  assert.equal(sent.chain, "base");
  assert.equal(sent.explorer, `https://basescan.org/tx/${sent.hash}`);
  assert.equal(net.state.evmSent.length, 0);
  net.state.base.allowance = 25_000_000n;
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([burn.display.call["chain"], burn.display.call["delivery"], burn.display.call["recipient"]], ["Arbitrum", "circle", ME_EVM]);
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_forward"]);
  ok(await service.handle({ type: "confirm_send", digest: burn.digest }));
  assert.equal(net.state.base.sent.length, 2);
  // And to Solana, from Base: the account's own Solana wallet.
  const sol = ok<Quote>(await service.handle({ type: "bridge_quote", from: "base", to: "solana", amount: "1000000", recipient: ME_SOL }));
  assert.equal(sol.own, true);
  const solBurn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: sol.id }));
  assert.equal(solBurn.display.call["chain"], "Solana");
});

test("Base into Injective: a burn anyone may mint; minted here when nobody has", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 1_000_000n } });
  net.state.base.usdc = 30_000_000n;
  net.state.base.allowance = 30_000_000n;
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "base", to: "injective", amount: "25000000", recipient: ME_EVM }));
  assert.deepEqual([q.steps, q.delivery, q.maxFee, q.minReceived], [["burn"], "anyone", "3000", "24997000"]);
  assert.ok(BigInt(q.gasNeed) > 0n && BigInt(q.gasHeld) === 10n ** 16n);
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([burn.display.call["chain"], burn.display.call["delivery"], burn.display.call["least"]], ["Injective", "claim", "24997000"]);
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_in_delivery"]);
  const burned = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: burn.digest }));
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_pending" })).map((p) => [p.from, p.fromName, p.to, p.hash]), [["base", "Base", "injective", burned.hash]]);

  // Circle hasn't seen it, then confirms it; nobody mints it, so this account can.
  let s = ok<Status>(await service.handle({ type: "bridge_status", from: "base", hash: burned.hash }));
  assert.deepEqual([s.phase, s.track], ["pending", `https://bridge.choice.exchange/tx/6/${burned.hash}`]);
  net.state.iris[burned.hash] = [{ status: "pending_confirmations", message: "0x", attestation: "PENDING", eventNonce: "0x", cctpVersion: 2, delayReason: null }];
  assert.equal(ok<Status>(await service.handle({ type: "bridge_status", from: "base", hash: burned.hash })).phase, "attesting");
  const nonce = `0x${"3c".repeat(32)}`;
  net.state.iris[burned.hash] = [attestedMessage(ME_EVM, 25_000_000n, nonce)];
  s = ok<Status>(await service.handle({ type: "bridge_status", from: "base", hash: burned.hash }));
  assert.deepEqual([s.phase, s.selfMint, s.to], ["ready", true, "injective"]);

  const mint = ok<Review>(await service.handle({ type: "prepare_bridge_receive", from: "base", hash: burned.hash }));
  assert.equal(mint.display.chain, "eip155:1776");
  assert.equal(mint.display.to, MESSAGE_TRANSMITTER);
  assert.deepEqual([mint.display.call["type"], mint.display.call["chain"], mint.display.call["recipient"], mint.display.call["minted"]], ["bridge_receive", "Base", ME_EVM, "24997500"]);
  assert.deepEqual(rules(mint), ["bridge_receive"]);
  assert.equal(mint.bridge?.step, "receive");
  ok(await service.handle({ type: "confirm_send", digest: mint.digest }));
  net.state.usedNonces.add(nonce);
  assert.equal(ok<Status>(await service.handle({ type: "bridge_status", from: "base", hash: burned.hash })).phase, "delivered");
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_pending" })), []);
});

test("into Injective with the INJ top-up: Choice's BridgeReceiver mints it, and only it can", async () => {
  const net = chain({ balances: { inj: 0n } });
  net.state.base.usdc = 30_000_000n;
  net.state.base.allowance = 30_000_000n;
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", from: "base", to: "injective", amount: "max", recipient: ME_EVM, gasDrop: true }));
  assert.deepEqual([q.amount, q.steps, q.delivery, q.gasDropFee, q.gasDropInj], ["30000000", ["burn"], "gas_drop", "500000", (2n * 10n ** 16n).toString()]);
  assert.equal(BigInt(q.minReceived), 30_000_000n - BigInt(q.maxFee) - 500_000n);
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.deepEqual([burn.display.call["delivery"], burn.display.call["max_drop_fee"]], ["gas_drop", "500000"]);
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_gas_drop"]);
  const burned = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: burn.digest }));
  // Pinned to BridgeReceiver: this account can't mint it (and needn't: it has no INJ).
  const nonce = `0x${"4d".repeat(32)}`;
  net.state.iris[burned.hash] = [attestedMessage(BRIDGE_RECEIVER, 30_000_000n, nonce, { caller: BRIDGE_RECEIVER.slice(2).toLowerCase().padStart(64, "0") })];
  const s = ok<Status>(await service.handle({ type: "bridge_status", from: "base", hash: burned.hash }));
  assert.deepEqual([s.phase, s.selfMint], ["ready", false]);
  assert.equal(code(await service.handle({ type: "prepare_bridge_receive", from: "base", hash: burned.hash })), "not_yours");
  // Elsewhere than Injective, there's no top-up to ask for.
  const plain = ok<Quote>(await service.handle({ type: "bridge_quote", from: "base", to: "arbitrum", amount: "1000000", recipient: ME_EVM, gasDrop: true }));
  assert.equal(plain.delivery, "circle");

  net.state.gasDrop.paused = true;
  assert.equal(code(await service.handle({ type: "bridge_quote", from: "base", to: "injective", amount: "1000000", recipient: ME_EVM, gasDrop: true })), "gas_drop");
});

test("refused without the USDC, the gas, a chain, or a key to sign with", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.usdc = 5_000_000n;
  const { service } = await wallet(net);
  const quote = (from: string, amount: string) => service.handle({ type: "bridge_quote", from, to: "injective", amount, recipient: ME_EVM });
  assert.equal(code(await quote("base", "6000000")), "insufficient");
  assert.equal(code(await quote("nowhere", "1000000")), "bad_request");
  assert.equal(code(await quote("solana", "6000000")), "insufficient");
  assert.equal(code(await quote("base", "2")), "bridge_amount");
  net.state.base.eth = 0n;
  net.state.base.allowance = 5_000_000n;
  const q = ok<Quote>(await quote("base", "1000000"));
  assert.equal(q.gasHeld, "0");
  assert.equal(code(await service.handle({ type: "prepare_bridge", quote: q.id })), "gas");
  net.state.base.down = true;
  assert.equal(code(await quote("base", "1000000")), "unreachable");
  assert.equal(code(await service.handle({ type: "bridge_status", from: "base", hash: "0x12" })), "bad_request");
  assert.equal(code(await service.handle({ type: "tx_status", hash: `0x${"11".repeat(32)}`, chain: "nowhere" })), "bad_request");
  ok(await service.handle({ type: "add_watch", address: THEM }));
  assert.equal(code(await service.handle({ type: "prepare_bridge", quote: "x" })), "watch_only");
  assert.equal(code(await service.handle({ type: "prepare_bridge_receive", from: "base", hash: `0x${"11".repeat(32)}` })), "watch_only");
});
