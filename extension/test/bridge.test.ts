// Bridging USDC out over Circle's CCTP, through the service: fees from a fake Iris, each step
// built from injective-usdc-bridge's calldata and read by the real WASM vault.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chain, code, INJ, ME_EVM, ok, THEM_EVM, TOKEN_MESSENGER, USDC, USDC_ERC20, wallet } from "./fake";

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
