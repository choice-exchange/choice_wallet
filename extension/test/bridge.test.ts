// Bridging USDC out over Circle's CCTP, through the service: fees from a fake Iris, each step
// built from injective-usdc-bridge's calldata and read by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BASE_USDC, BRIDGE_RECEIVER, chain, code, INJ, MESSAGE_TRANSMITTER, ME_EVM, ok, THEM, THEM_EVM, TOKEN_MESSENGER, USDC, USDC_ERC20, wallet } from "./fake";

type Quote = { id: string; chain: string; chainName: string; recipient: string; amount: string; maxFee: string; minReceived: string; recipientSetup: boolean; steps: string[] };
type Review = {
  digest: string;
  display: { to: string; value: string; call: Record<string, unknown> };
  risk: { level: string; findings: { rule: string; message: string }[] };
  bridge?: { step: string; left: number; chain: string; recipient: string; amount: string; maxFee: string; minReceived: string; usdc: string };
};

const rules = (r: Review) => r.risk.findings.map((f) => f.rule);
/** RFC 8032's first Ed25519 test key, as a Solana wallet address. */
const SOL_WALLET = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";

test("routes: the chains Circle delivers to, and the USDC held", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  const { service } = await wallet(net);
  const r = ok<{ chains: { key: string; name: string; kind: string }[]; usdc: string; balance: string; address: string }>(await service.handle({ type: "bridge_routes" }));
  assert.equal(r.usdc, USDC);
  assert.equal(r.balance, "30000000");
  assert.equal(r.address, ME_EVM);
  const keys = r.chains.map((c) => c.key);
  assert.ok(keys.includes("base") && keys.includes("solana") && keys.includes("arc"), keys.join());
  // Plasma has no forwarding: the wallet never leaves a transfer to be claimed.
  assert.ok(!keys.includes("plasma") && !keys.includes("injective"));
  assert.equal(r.chains.find((c) => c.key === "solana")?.kind, "solana");
});

test("to this account's own address on Base: approve exactly, then the burn Circle delivers", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", to: "base", amount: "25000000", recipient: ME_EVM.toLowerCase() }));
  assert.deepEqual(q.steps, ["approve", "burn"]);
  assert.equal(q.chainName, "Base");
  assert.equal(q.recipient, ME_EVM);
  // Standard from Injective is free; Circle's forwarding fee (the "med" tier) is the most.
  assert.equal(q.maxFee, "54000");
  assert.equal(q.minReceived, "24946000");
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/29/6?forward=true"));
  // No user-agent reaches Circle: from a service worker it would be a CORS preflight.
  assert.ok(net.state.irisAsks.every((a) => !("user-agent" in a.headers)));

  const approve = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(approve.bridge?.step, "approve");
  assert.equal(approve.bridge?.left, 1);
  assert.equal(approve.bridge?.usdc, USDC);
  assert.equal(approve.display.to.toLowerCase(), USDC_ERC20);
  assert.deepEqual(approve.display.call, { type: "approve", spender: TOKEN_MESSENGER, amount: "25000000" });
  assert.match(approve.risk.findings[0]!.message, /^Circle's bridge \(CCTP\) could spend this token/);
  ok(await service.handle({ type: "confirm_send", digest: approve.digest }));
  net.state.erc20Allowance[`${USDC_ERC20} ${TOKEN_MESSENGER.toLowerCase()}`] = 25_000_000n;

  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(burn.bridge?.step, "burn");
  assert.equal(burn.bridge?.left, 0);
  assert.equal(burn.display.to, TOKEN_MESSENGER);
  assert.equal(burn.display.value, "0");
  assert.equal(burn.display.call["type"], "bridge");
  assert.equal(burn.display.call["chain"], "Base");
  assert.equal(burn.display.call["recipient"], ME_EVM);
  assert.equal(burn.display.call["amount"], "25000000");
  assert.equal(burn.display.call["max_fee"], "54000");
  assert.equal(burn.display.call["delivery"], "circle");
  assert.equal(burn.risk.level, "info");
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_forward"]);
  ok(await service.handle({ type: "confirm_send", digest: burn.digest }));
  assert.equal(net.state.evmSent.length, 2);
});

test("someone else's address: amber; a checksum typo or a non-address: refused", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  net.state.erc20Allowance[`${USDC_ERC20} ${TOKEN_MESSENGER.toLowerCase()}`] = 100_000_000n;
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", to: "arbitrum", amount: "max", recipient: THEM_EVM }));
  assert.deepEqual(q.steps, ["burn"]);
  assert.equal(q.amount, "30000000");
  const burn = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q.id }));
  assert.equal(burn.risk.level, "amber");
  assert.ok(rules(burn).includes("bridge_recipient"));
  assert.equal(burn.display.call["recipient"], THEM_EVM);

  const typo = THEM_EVM.slice(0, -1) + (THEM_EVM.endsWith("F") ? "f" : "F");
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "arbitrum", amount: "1000000", recipient: typo })), "bad_recipient");
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "arbitrum", amount: "1000000", recipient: "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz" })), "bad_recipient");
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "plasma", amount: "1000000", recipient: ME_EVM })), "bad_request");
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "base", amount: "40000000", recipient: ME_EVM })), "insufficient");
  // Not enough to cover Circle's fee.
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "base", amount: "54000", recipient: ME_EVM })), "bridge_amount");
  net.state.irisDown = true;
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "base", amount: "1000000", recipient: ME_EVM })), "unreachable");
});

test("Solana: a wallet with no USDC account gets one opened by Circle; a token account is refused", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  net.state.erc20Allowance[`${USDC_ERC20} ${TOKEN_MESSENGER.toLowerCase()}`] = 100_000_000n;
  const { service } = await wallet(net);
  const q = ok<Quote>(await service.handle({ type: "bridge_quote", to: "solana", amount: "5000000", recipient: SOL_WALLET }));
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
  const q2 = ok<Quote>(await service.handle({ type: "bridge_quote", to: "solana", amount: "5000000", recipient: SOL_WALLET }));
  assert.equal(q2.recipientSetup, false);
  assert.equal(q2.maxFee, "130000");
  const burn2 = ok<Review>(await service.handle({ type: "prepare_bridge", quote: q2.id }));
  assert.equal(burn2.display.call["recipient"], ata);
  assert.equal(burn2.display.call["account_owner"], null);
  // That USDC account itself, typed as the recipient.
  assert.equal(code(await service.handle({ type: "bridge_quote", to: "solana", amount: "5000000", recipient: ata })), "bad_recipient");
});

test("status: Iris has nothing, attests, then Circle's mint lands", async () => {
  const net = chain({ balances: { inj: INJ } });
  const { service } = await wallet(net);
  const hash = `0x${"5a".repeat(32)}`;
  type Status = { phase: string; track: string; mintTx?: string; mintUrl?: string };
  let s = ok<Status>(await service.handle({ type: "bridge_status", hash }));
  assert.equal(s.phase, "pending");
  assert.equal(s.track, `https://bridge.choice.exchange/tx/29/${hash}`);
  net.state.iris[hash] = [{ status: "pending_confirmations", message: "0x", attestation: "PENDING", eventNonce: "0x", cctpVersion: 2, delayReason: null }];
  s = ok<Status>(await service.handle({ type: "bridge_status", hash }));
  assert.equal(s.phase, "attesting");
  const mint = `0x${"6b".repeat(32)}`;
  net.state.iris[hash] = [{ status: "complete", message: "0x01", attestation: "0x02", eventNonce: "0x03", cctpVersion: 2, delayReason: null, decodedMessage: { sourceDomain: "29", destinationDomain: "6", destinationCaller: `0x${"0".repeat(64)}` }, forwardState: "CONFIRMED", forwardTxHash: mint }];
  s = ok<Status>(await service.handle({ type: "bridge_status", hash }));
  assert.equal(s.phase, "delivered");
  assert.equal(s.mintTx, mint);
  assert.equal(s.mintUrl, `https://basescan.org/tx/${mint}`);
  assert.equal(code(await service.handle({ type: "bridge_status", hash: "0x12" })), "bad_request");
});

test("a watched account can quote but not bridge", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 30_000_000n } });
  const { service } = await wallet(net);
  ok(await service.handle({ type: "add_watch", address: "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v" }));
  assert.equal(code(await service.handle({ type: "prepare_bridge", quote: "x" })), "watch_only");
});

// ---- In: USDC from Base into this account on Injective ----

type InQuote = { id: string; chain: string; chainName: string; symbol: string; amount: string; maxFee: string; gasDropFee: string; gasDropInj: string; minReceived: string; fast: boolean; etaMs: number; steps: string[]; gasNeed: string; gasHeld: string };
type InReview = Review & {
  display: Review["display"] & { chain: string; source?: { name: string; symbol: string; decimals: number } };
  tokens: Record<string, { symbol: string; decimals: number }>;
  bridgeIn?: { step: string; left: number; chain: string; chainKey: string; amount: string; minReceived: string; gasDropFee: string };
};
type InStatus = { phase: string; selfMint: boolean; track: string };

/** A message as Iris returns it, attested: `amount` burned on Base for `recipient`. */
function attestedMessage(recipient: string, amount: bigint, nonce: string, caller = "0".repeat(64)) {
  const w = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const n = (v: bigint | number, bytes: number) => BigInt(v).toString(16).padStart(bytes * 2, "0");
  const tm = w(TOKEN_MESSENGER);
  const header = n(1, 4) + n(6, 4) + n(29, 4) + nonce.slice(2) + tm + tm + caller + n(1000, 4) + n(1000, 4);
  const body = n(1, 4) + w(BASE_USDC) + w(recipient) + n(amount, 32) + w(recipient) + n(2500, 32) + n(2500, 32) + n(0, 32);
  return { status: "complete", message: `0x${header}${body}`, attestation: `0x${"07".repeat(65)}`, eventNonce: nonce, cctpVersion: 2, delayReason: null, decodedMessage: { sourceDomain: "6", destinationDomain: "29", destinationCaller: `0x${caller}` } };
}

test("in: the chains USDC comes from, and this account's USDC and gas on them", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.usdc = 12_000_000n;
  const { service } = await wallet(net);
  const r = ok<{ chains: { key: string; name: string; symbol: string; fast: boolean }[]; address: string; usdc: string; gasDrop: boolean }>(await service.handle({ type: "bridge_in_routes" }));
  assert.equal(r.address, ME_EVM);
  assert.equal(r.gasDrop, true);
  assert.deepEqual(r.chains.find((c) => c.key === "base"), { key: "base", name: "Base", symbol: "ETH", fast: true, decimals: 18 });
  assert.ok(!r.chains.some((c) => c.key === "injective"));
  // Solana, signed with the account's Solana key.
  assert.deepEqual(r.chains.find((c) => c.key === "solana"), { key: "solana", name: "Solana", symbol: "SOL", fast: true, decimals: 9 });
  const held = ok<{ chain: string; usdc: string | null; native: string | null }[]>(await service.handle({ type: "bridge_in_balances" }));
  assert.deepEqual(held.find((h) => h.chain === "base"), { chain: "base", usdc: "12000000", native: (10n ** 16n).toString() });
  // The fake answers only Base: every other chain comes back unknown, not as zero.
  assert.deepEqual(held.find((h) => h.chain === "arbitrum"), { chain: "arbitrum", usdc: null, native: null });
  assert.deepEqual(held.find((h) => h.chain === "solana"), { chain: "solana", usdc: "5000000", native: "2000000000" });
});

test("in from Base: an exact approval, then a burn into this account; then minted here", async () => {
  const net = chain({ balances: { inj: INJ, [USDC]: 1_000_000n } });
  net.state.base.usdc = 30_000_000n;
  const { service, local } = await wallet(net);
  const q = ok<InQuote>(await service.handle({ type: "bridge_in_quote", from: "base", amount: "25000000", gasDrop: false }));
  assert.deepEqual(q.steps, ["approve", "burn"]);
  assert.equal(q.fast, true);
  // Fast from Base: 1 bp of 25 USDC (2,500), and 20% on top for headroom.
  assert.equal(q.maxFee, "3000");
  assert.equal(q.minReceived, "24997000");
  assert.equal(q.gasDropFee, "0");
  assert.ok(BigInt(q.gasNeed) > 0n && BigInt(q.gasHeld) === 10n ** 16n);
  assert.ok(net.state.irisAsks.some((a) => a.path === "/v2/burn/USDC/fees/6/29"));

  const approve = ok<InReview>(await service.handle({ type: "prepare_bridge_in", quote: q.id }));
  assert.equal(approve.bridgeIn?.step, "approve");
  assert.equal(approve.bridgeIn?.left, 1);
  assert.equal(approve.display.chain, "eip155:8453");
  assert.deepEqual(approve.display.network, { name: "Base", symbol: "ETH", decimals: 18 });
  assert.equal(approve.display.to.toLowerCase(), BASE_USDC.toLowerCase());
  assert.deepEqual(approve.display.call, { type: "approve", spender: TOKEN_MESSENGER, amount: "25000000" });
  assert.equal(approve.tokens["usdc:eip155:8453"]?.symbol, "USDC");
  assert.equal(approve.tokens["native:eip155:8453"]?.symbol, "ETH");
  // Base is OP Stack: its Ethereum data fee is bounded by its GasPriceOracle and counted.
  assert.equal((approve as InReview & { dataFee?: string }).dataFee, "4660000000");
  const sent = ok<{ hash: string; explorer: string; chain?: string }>(await service.handle({ type: "confirm_send", digest: approve.digest }));
  assert.equal(sent.chain, "base");
  assert.equal(sent.explorer, `https://basescan.org/tx/${sent.hash}`);
  assert.equal(net.state.base.sent.length, 1);
  assert.equal(net.state.evmSent.length, 0);
  assert.deepEqual(ok(await service.handle({ type: "tx_status", hash: sent.hash, chain: "base" })), { state: "success" });
  net.state.base.allowance = 25_000_000n;

  const burn = ok<InReview>(await service.handle({ type: "prepare_bridge_in", quote: q.id }));
  assert.equal(burn.bridgeIn?.step, "burn");
  assert.equal(burn.display.to, TOKEN_MESSENGER);
  const call = burn.display.call;
  assert.equal(call["type"], "bridge");
  assert.equal(call["chain"], "Injective");
  assert.equal(call["recipient"], ME_EVM);
  assert.equal(call["amount"], "25000000");
  assert.equal(call["max_fee"], "3000");
  assert.equal(call["delivery"], "claim");
  assert.equal(burn.risk.level, "info");
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_in_delivery"]);
  const burned = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: burn.digest }));
  assert.equal(net.state.base.sent.length, 2);
  type Pending = { chain: string; chainName: string; hash: string; amount: string }[];
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_in_pending" })).map((p) => [p.chain, p.chainName, p.hash, p.amount]), [["base", "Base", burned.hash, "25000000"]]);
  assert.ok(Array.isArray(local.data.get("bridge_in_pending")));

  // Circle hasn't seen it, then confirms it; nobody mints it, so this account can.
  let s = ok<InStatus>(await service.handle({ type: "bridge_in_status", chain: "base", hash: burned.hash }));
  assert.equal(s.phase, "pending");
  assert.equal(s.track, `https://bridge.choice.exchange/tx/6/${burned.hash}`);
  net.state.iris[burned.hash] = [{ status: "pending_confirmations", message: "0x", attestation: "PENDING", eventNonce: "0x", cctpVersion: 2, delayReason: null }];
  assert.equal(ok<InStatus>(await service.handle({ type: "bridge_in_status", chain: "base", hash: burned.hash })).phase, "attesting");
  const nonce = `0x${"3c".repeat(32)}`;
  net.state.iris[burned.hash] = [attestedMessage(ME_EVM, 25_000_000n, nonce)];
  s = ok<InStatus>(await service.handle({ type: "bridge_in_status", chain: "base", hash: burned.hash }));
  assert.deepEqual([s.phase, s.selfMint], ["ready", true]);

  const mint = ok<InReview>(await service.handle({ type: "prepare_bridge_receive", chain: "base", hash: burned.hash }));
  assert.equal(mint.display.chain, "eip155:1776");
  assert.equal(mint.display.to, MESSAGE_TRANSMITTER);
  assert.equal(mint.display.call["type"], "bridge_receive");
  assert.equal(mint.display.call["chain"], "Base");
  assert.equal(mint.display.call["recipient"], ME_EVM);
  assert.equal(mint.display.call["minted"], "24997500");
  assert.deepEqual(rules(mint), ["bridge_receive"]);
  assert.equal(mint.bridgeIn?.step, "receive");
  ok(await service.handle({ type: "confirm_send", digest: mint.digest }));
  assert.equal(net.state.evmSent.length, 1);
  net.state.usedNonces.add(nonce);
  assert.equal(ok<InStatus>(await service.handle({ type: "bridge_in_status", chain: "base", hash: burned.hash })).phase, "delivered");
  assert.deepEqual(ok<Pending>(await service.handle({ type: "bridge_in_pending" })), []);
});

test("in with the INJ top-up: Choice's BridgeReceiver mints it, and only it can", async () => {
  const net = chain({ balances: { inj: 0n } });
  net.state.base.usdc = 30_000_000n;
  net.state.base.allowance = 30_000_000n;
  const { service } = await wallet(net);
  const q = ok<InQuote>(await service.handle({ type: "bridge_in_quote", from: "base", amount: "max", gasDrop: true }));
  assert.equal(q.amount, "30000000");
  assert.deepEqual(q.steps, ["burn"]);
  assert.equal(q.gasDropFee, "500000");
  assert.equal(q.gasDropInj, (2n * 10n ** 16n).toString());
  assert.equal(BigInt(q.minReceived), 30_000_000n - BigInt(q.maxFee) - 500_000n);
  const burn = ok<InReview>(await service.handle({ type: "prepare_bridge_in", quote: q.id }));
  assert.equal(burn.display.call["delivery"], "gas_drop");
  assert.equal(burn.display.call["max_drop_fee"], "500000");
  assert.deepEqual(rules(burn), ["bridge", "bridge_to_self", "bridge_gas_drop"]);
  const burned = ok<{ hash: string }>(await service.handle({ type: "confirm_send", digest: burn.digest }));
  // Pinned to BridgeReceiver: this account can't mint it (and needn't: it has no INJ).
  const nonce = `0x${"4d".repeat(32)}`;
  net.state.iris[burned.hash] = [attestedMessage(BRIDGE_RECEIVER, 30_000_000n, nonce, BRIDGE_RECEIVER.slice(2).toLowerCase().padStart(64, "0"))];
  const s = ok<InStatus>(await service.handle({ type: "bridge_in_status", chain: "base", hash: burned.hash }));
  assert.deepEqual([s.phase, s.selfMint], ["ready", false]);
  assert.equal(code(await service.handle({ type: "prepare_bridge_receive", chain: "base", hash: burned.hash })), "not_yours");

  net.state.gasDrop.paused = true;
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "base", amount: "1000000", gasDrop: true })), "gas_drop");
});

test("in: refused without the USDC, the gas, or a chain it comes from", async () => {
  const net = chain({ balances: { inj: INJ } });
  net.state.base.usdc = 5_000_000n;
  const { service } = await wallet(net);
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "base", amount: "6000000", gasDrop: false })), "insufficient");
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "nowhere", amount: "1000000", gasDrop: false })), "bad_request");
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "solana", amount: "6000000", gasDrop: false })), "insufficient");
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "base", amount: "2", gasDrop: false })), "bridge_amount");
  net.state.base.eth = 0n;
  const q = ok<InQuote>(await service.handle({ type: "bridge_in_quote", from: "base", amount: "1000000", gasDrop: false }));
  assert.equal(q.gasHeld, "0");
  assert.equal(code(await service.handle({ type: "prepare_bridge_in", quote: q.id })), "gas");
  net.state.base.down = true;
  assert.equal(code(await service.handle({ type: "bridge_in_quote", from: "base", amount: "1000000", gasDrop: false })), "unreachable");
  assert.equal(code(await service.handle({ type: "tx_status", hash: `0x${"11".repeat(32)}`, chain: "nowhere" })), "bad_request");
  ok(await service.handle({ type: "add_watch", address: THEM }));
  assert.equal(code(await service.handle({ type: "prepare_bridge_in", quote: "x" })), "watch_only");
  assert.equal(code(await service.handle({ type: "prepare_bridge_receive", chain: "base", hash: `0x${"11".repeat(32)}` })), "watch_only");
});
