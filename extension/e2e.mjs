// End-to-end check in a real browser: loads dist/ into Chromium and drives the popup over
// the DevTools protocol (Node built-ins only, no browser-automation packages).
//
//   node e2e.mjs <chromium binary> <dist dir> <screenshot dir> [--live]
//
// Needs a Chromium or Chrome for Testing build: branded Chrome no longer loads unpacked
// extensions from the command line. The extension is loaded with Extensions.loadUnpacked
// over --remote-debugging-pipe. It creates a throwaway wallet in a temporary profile,
// which is deleted afterwards. Sends go to a local fake LCD (below), never a real chain.
// With --live, it also checks that the default mainnet endpoints answer from the browser.
//
// Set E2E_QR_DECODER to a program that prints the text of the QR code in the PNG it is
// given (any independent reader) and the Receive screenshots are decoded and checked
// against the addresses on screen.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvalLog, ethMessage, rawTx, resultData, transferLog } from "../chain/test/evm-fixture.ts";

const [chrome, ext, out, flag] = process.argv.slice(2);
const live = flag === "--live";

// A fake mainnet LCD for any address: 5 INJ, 2.5 USDT, and a token that calls itself USDT
// (unlisted and unpriced, so the token filter hides it).
const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SCAM = "factory/inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49/usdt";
// SHROOM's CW20 (a published mainnet contract), held: 3, added by its contract below.
const CW20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const broadcasts = [];
// EVM transactions the mock JSON-RPC received (raw hex), for the swap step.
const evmRaw = [];
const PERMIT2_APPROVED = "095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3";
// Circle's CCTP on Injective: native USDC's bank denom, and TokenMessengerV2's approval.
const USDC = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const CCTP_APPROVED = "095ea7b300000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d";
const sha = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").toUpperCase();
// Indexed transactions for Activity, shaped like mainnet's (bank events and the fee payer).
const FRIEND = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
const SENT_TO = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v"; // the EIP-155 example key's address, the e2e's recipient
const FEE_COLLECTOR = "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9";
// Exchanges, at test addresses of one repeated byte: one saved with its memo (0x77…77), and
// one the wallet reads from its deposits, which carry memos from many senders (0x88…88).
const EXCHANGE = "inj1wamhwamhwamhwamhwamhwamhwamhwamhx9lynt";
const FOUND_EXCHANGE = "inj13zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg257t5p";
const attrs = (o) => Object.entries(o).map(([key, value]) => ({ key, value, index: true }));
const moved = (from, to, amount) => [
  { type: "coin_spent", attributes: attrs({ spender: from, amount }) },
  { type: "coin_received", attributes: attrs({ receiver: to, amount }) },
  { type: "transfer", attributes: attrs({ recipient: to, sender: from, amount }) },
];
const indexed = (hash, height, time, from, to, amount) => ({
  txhash: hash,
  height: String(height),
  timestamp: time.toISOString(),
  code: 0,
  tx: {
    body: { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: from, to_address: to, amount: [] }] },
    auth_info: { fee: { amount: [{ denom: "inj", amount: "17216480000000" }], gas_limit: "107603" } },
  },
  events: [...moved(from, FEE_COLLECTOR, "17216480000000inj"), { type: "tx", attributes: attrs({ fee: "17216480000000inj", fee_payer: from }) }, ...moved(from, to, amount)],
});
// EVM transactions for Activity, as the LCD indexes them: an approval this wallet signed
// (USDT's ERC20, bank-backed, for a router), and from someone else (the EIP-155 example
// key) 2 LUMA, an ERC20 with no bank form, that only Blockscout finds; plus a zero-value
// USDT "transfer" out of the wallet to a look-alike (address poisoning), which must not show.
let me0x = ""; // the wallet's 0x address, once the e2e has read it
const ROUTER = "0x4444444444444444444444444444444444444444";
const VAL_A = "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q";
const VAL_B = "injvaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz7c964k";
const LUMA = "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4";
const USDT_ERC20 = "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13";
const SENDER_EVM = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const evmHash = (height) => `0x${height.toString(16).padStart(64, "e")}`;
const evmIndexed = (height, time, o) => ({
  txhash: height.toString(16).padStart(64, "C"),
  height: String(height),
  timestamp: time.toISOString(),
  code: 0,
  raw_log: "",
  data: resultData(evmHash(height), o.logs),
  tx: { body: { messages: [ethMessage(o.from, rawTx({ to: o.to }))] }, auth_info: { fee: { amount: [{ denom: "inj", amount: "4032160000000" }], gas_limit: "25201" } } },
  events: [
    ...moved(o.fromInj, FEE_COLLECTOR, "4032160000000inj"),
    { type: "tx", attributes: attrs({ fee: "4032160000000inj" }) },
    { type: "message", attributes: attrs({ action: "/injective.evm.v1.MsgEthereumTx", sender: o.fromInj }) },
    { type: "ethereum_tx", attributes: attrs({ ethereumTxHash: evmHash(height), recipient: o.to }) },
  ],
});
const evmTxs = (me, now) => ({
  approval: evmIndexed(850, new Date(now - 1_200_000), { from: me0x.toLowerCase(), fromInj: me, to: USDT_ERC20, logs: [approvalLog(USDT_ERC20, me0x, ROUTER, 2n ** 256n - 1n)] }),
  [evmHash(860)]: evmIndexed(860, new Date(now - 600_000), { from: SENDER_EVM, fromInj: FRIEND, to: LUMA, logs: [transferLog(LUMA, SENDER_EVM, me0x, 2n * 10n ** 18n)] }),
  [evmHash(855)]: evmIndexed(855, new Date(now - 900_000), { from: SENDER_EVM, fromInj: FRIEND, to: USDT_ERC20, logs: [transferLog(USDT_ERC20, me0x, SENDER_EVM, 0n)] }),
});
let meInj = "";
// Step 4e: balances that can't be read (the saved ones show), and 1 INJ more coming in
// from FRIEND (the watcher notifies it).
let balancesDown = false;
let incoming = false;
/** Step 7f: 3 USDC held, to bridge. */
let usdcHeld = false;
/** Tx index searches asked (Activity's), to see a tab revisit ask nothing. */
let txSearches = 0;
const txSearchLog = [];
const lcd = createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return reply(204, {});
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/favicon.ico") return reply(204, {});
    if (p === "/dapp.html") {
      // A test site: finds wallets through EIP-6963, as dapps do.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Test dapp</title><p>Test dapp</p><script>
        window.__wallets = [];
        addEventListener("eip6963:announceProvider", (e) => window.__wallets.push(e.detail));
        dispatchEvent(new Event("eip6963:requestProvider"));
        // Solana wallets, through the Wallet Standard (the app says it's ready).
        window.__std = [];
        const api = { register: (w) => { window.__std.push(w); return () => {}; } };
        addEventListener("wallet-standard:register-wallet", (e) => e.detail(api));
        dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
        window.__ask = (method, params) => { const w = window.__wallets.find((d) => d.info.rdns === "exchange.choice.wallet"); window.__r = w.provider.request({ method, params }).then((r) => ({ ok: r }), (e) => ({ code: e.code, message: e.message })); };
      </script>`);
    }
    if (req.method === "POST" && p === "/") {
      // EVM JSON-RPC, for the swap step: 5 INJ, no allowances until the wallet sends them.
      const rpc = (r) => {
        const ok = (result) => ({ jsonrpc: "2.0", id: r.id, result });
        const w = (n) => BigInt(n).toString(16).padStart(64, "0");
        const sent = evmRaw.join(" ").toLowerCase();
        switch (r.method) {
          case "eth_chainId":
            return ok("0x6f0");
          case "eth_blockNumber":
            return ok("0x1");
          case "eth_getTransactionCount":
            return ok(`0x${(5 + evmRaw.length).toString(16)}`);
          case "eth_getBlockByNumber":
            return ok({ number: "0x1", baseFeePerGas: "0x9896800" });
          case "eth_maxPriorityFeePerGas":
            return ok("0x0");
          case "eth_getBalance":
            return ok("0x4563918244f40000");
          case "eth_estimateGas":
            return ok("0x3d090");
          case "eth_sendRawTransaction":
            evmRaw.push(r.params[0]);
            return ok(`0x${sha(Buffer.from(r.params[0].slice(2), "hex").toString("base64")).toLowerCase()}`);
          case "eth_getTransactionReceipt":
            return ok({ status: "0x1" });
          case "eth_call": {
            const data = String(r.params[0].data);
            if (data.startsWith("0xdd62ed3e") && data.toLowerCase().includes("28b5a0e9c621a5badaa536219b3a228c8168cf5d")) return ok(`0x${w(sent.includes(CCTP_APPROVED) ? 10n ** 30n : 0n)}`);
            if (data.startsWith("0xdd62ed3e")) return ok(`0x${w(sent.includes(PERMIT2_APPROVED) ? 10n ** 30n : 0n)}`);
            if (data.startsWith("0x927da105")) return ok(sent.includes("87517c45") ? `0x${w(10n ** 30n)}${w(Math.floor(Date.now() / 1000) + 1800)}${w(0)}` : `0x${w(0)}${w(0)}${w(0)}`);
            return ok(`0x${w(0)}`);
          }
          default:
            return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "not here" } };
        }
      };
      const calls = JSON.parse(body);
      return reply(200, Array.isArray(calls) ? calls.map(rpc) : rpc(calls));
    }
    const tail = p.split("/").pop();
    if (p.endsWith("/node_info")) return reply(200, { default_node_info: { network: "injective-1" } });
    if (p.startsWith("/cosmos/auth/v1beta1/accounts/")) {
      return reply(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: tail, pub_key: null, account_number: "1234", sequence: "0" } } });
    }
    if (p.startsWith("/cosmos/bank/v1beta1/spendable_balances/")) {
      if (balancesDown) return reply(503, "down");
      return reply(200, { balances: [{ denom: SCAM, amount: "7000000" }, { denom: "inj", amount: incoming ? "6000000000000000000" : "5000000000000000000" }, { denom: USDT, amount: "2500000" }, ...(usdcHeld ? [{ denom: USDC, amount: "3000000" }] : [])], pagination: { next_key: null } });
    }
    if (p === "/injective/txfees/v1beta1/cur_eip_base_fee") return reply(200, { base_fee: { base_fee: "160000000.000000000000000000" } });
    if (p === "/injective/erc20/v1beta1/all_token_pairs") {
      return reply(200, { token_pairs: [{ bank_denom: USDT, erc20_address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13" }], pagination: null });
    }
    // The account's default trading account (nonce 0): 10 USDT, 4 of it free, and a long.
    if (p === "/injective/exchange/v2/exchange/subaccountDeposits") {
      const mine = (url.searchParams.get("subaccount_id") ?? "").endsWith("0".repeat(24));
      return reply(200, { deposits: mine ? { [USDT]: { available_balance: "4000000", total_balance: "10000000" } } : {} });
    }
    if (p.startsWith("/injective/exchange/v2/subaccount_positions/")) {
      const mine = p.endsWith("0".repeat(24));
      return reply(200, { state: mine ? [{ market_id: `0x${"ab".repeat(32)}`, position: { isLong: true, quantity: "2.5", entry_price: "25.1", margin: "30.5" } }] : [] });
    }
    const smart = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/]+)$/.exec(p);
    if (smart) {
      // CW20 queries as wasmd answers them; Choice's CLMM position manager has none for this
      // account; any other contract refuses.
      const q = JSON.parse(Buffer.from(decodeURIComponent(smart[2]), "base64").toString());
      if (q.tokens && q.tokens.owner) return reply(200, { data: { tokens: [] } });
      if (smart[1] !== CW20) return reply(500, { code: 2, message: "query wasm contract failed: Error parsing into type" });
      if (q.token_info) return reply(200, { data: { name: "shroomin", symbol: "SHROOM", decimals: 18, total_supply: "1000000000000000000000000000" } });
      if (q.all_allowances) return reply(200, { data: { allowances: [{ spender: FRIEND, allowance: "2000000000000000000", expires: { never: {} } }] } });
      return reply(200, { data: { balance: "3000000000000000000" } });
    }
    if (p === "/cosmos/bank/v1beta1/denoms_metadata_by_query_string") {
      if (url.searchParams.get("denom") === SCAM) return reply(200, { metadata: { base: SCAM, display: "USDT", symbol: "USDT", name: "Tether USD", decimals: 6, denom_units: [] } });
      return reply(404, { code: 5, message: "client metadata for denom", details: [] });
    }
    // Staking: two test validators (addresses of fixed bytes), 2 INJ staked with the first,
    // rewards waiting, and 1 INJ unstaking.
    const val = (address, moniker, tokens) => ({ operator_address: address, jailed: false, status: "BOND_STATUS_BONDED", tokens, description: { moniker, website: "" }, commission: { commission_rates: { rate: "0.050000000000000000" } } });
    if (p === "/cosmos/staking/v1beta1/validators") {
      return reply(200, { validators: [val(VAL_B, "Bravo Validator", "900000000000000000000000"), val(VAL_A, "Alpha Validator", "100000000000000000000000")], pagination: { next_key: null } });
    }
    if (p === "/cosmos/staking/v1beta1/params") return reply(200, { params: { unbonding_time: "1814400s", bond_denom: "inj" } });
    if (p.startsWith("/cosmos/staking/v1beta1/delegations/")) {
      return reply(200, { delegation_responses: [{ delegation: { delegator_address: tail, validator_address: VAL_A, shares: "2.0" }, balance: { denom: "inj", amount: "2000000000000000000" } }] });
    }
    if (p.endsWith("/unbonding_delegations")) {
      const who = p.split("/")[5];
      return reply(200, { unbonding_responses: [{ delegator_address: who, validator_address: VAL_B, entries: [{ creation_height: "190000000", completion_time: "2026-11-30T08:00:00Z", initial_balance: "1000000000000000000", balance: "1000000000000000000" }] }] });
    }
    if (p.endsWith("/rewards")) return reply(200, { rewards: [{ validator_address: VAL_A, reward: [{ denom: "inj", amount: "50000000000000000.25" }] }], total: [] });
    // Approvals: a grant to send everything, a fee allowance, rewards redirected, and a CW20
    // allowance; each made to FRIEND.
    if (p.startsWith("/cosmos/authz/v1beta1/grants/granter/")) {
      return reply(200, { grants: [{ granter: tail, grantee: FRIEND, authorization: { "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "/cosmos.bank.v1beta1.MsgSend" }, expiration: null }], pagination: { next_key: null } });
    }
    if (p.startsWith("/cosmos/feegrant/v1beta1/issued/")) {
      return reply(200, { allowances: [{ granter: tail, grantee: FRIEND, allowance: { "@type": "/cosmos.feegrant.v1beta1.BasicAllowance", spend_limit: [], expiration: null } }], pagination: { next_key: null } });
    }
    if (p.endsWith("/withdraw_address")) return reply(200, { withdraw_address: FRIEND });
    if (p === "/api" && url.searchParams.get("action") === "getLogs") return reply(200, { message: "No logs found", result: [], status: "0" });
    if (p === "/cosmos/tx/v1beta1/simulate") return reply(200, { gas_info: { gas_wanted: "150000000", gas_used: "82771" } });
    if (p === "/cosmos/tx/v1beta1/txs" && req.method === "POST") {
      const { tx_bytes } = JSON.parse(body);
      broadcasts.push(tx_bytes);
      return reply(200, { tx_response: { txhash: sha(tx_bytes), code: 0, raw_log: "" } });
    }
    if (p === "/api" && url.searchParams.get("action") === "tokentx") {
      // Blockscout: the wallet's ERC20 transfers, newest first.
      if (url.searchParams.get("address")?.toLowerCase() !== me0x.toLowerCase() || url.searchParams.get("page") !== "1") return reply(200, { message: "No token transfers found", result: [], status: "0" });
      return reply(200, { message: "OK", status: "1", result: [860, 855].map((h) => ({ blockNumber: String(h), hash: evmHash(h), value: "1" })) });
    }
    if (p === "/cosmos/tx/v1beta1/txs" && req.method === "GET") {
      txSearches++;
      txSearchLog.push(`${new Date().toISOString().slice(11, 23)} ${url.searchParams.get("query")}`);
      // The tx index: a receive and a junk airdrop, an EVM approval, and the send once it's
      // broadcast; by EVM hash, what Blockscout named.
      const q = url.searchParams.get("query") ?? "";
      if (url.searchParams.get("page") !== "1") return reply(500, { code: 13, message: "failed to search for txs: page should be within [1, 1] range, given 2" });
      const now = Date.now();
      const byHash = /^ethereum_tx\.ethereumTxHash='(0x[0-9a-f]{64})'$/.exec(q);
      if (byHash) {
        const t = evmTxs(meInj, now)[byHash[1]];
        return reply(200, { tx_responses: t ? [t] : [], total: t ? "1" : "0" });
      }
      const me = /'([a-z0-9]+)'$/.exec(q)?.[1] ?? "";
      if (q.startsWith("coin_received.receiver=") && [SENT_TO, EXCHANGE, FOUND_EXCHANGE].includes(me)) {
        // A recipient, asked about before a send: what it received.
        const list =
          me === FOUND_EXCHANGE
            ? Array.from({ length: 12 }, (_, i) => {
                const t = indexed(`${(i + 1).toString(16)}`.padStart(64, "C"), 600 - i, new Date(now - i * 60_000), `inj1sender${i}`, me, "1000000000000000000inj");
                return { ...t, tx: { ...t.tx, body: { ...t.tx.body, memo: `10${i}234567` } } };
              })
            : [];
        return reply(200, { tx_responses: list, total: String(list.length) });
      }
      meInj = me;
      const list =
        q.startsWith("message.sender=") || q.startsWith("coin_spent.spender=")
          ? [...broadcasts.map((b) => indexed(sha(b), 900, new Date(now - 60_000), me, SENT_TO, "1500000000000000000inj")), ...(me0x ? [evmTxs(me, now).approval] : [])]
          : [
              ...(incoming ? [indexed("D".repeat(64), 990, new Date(now), FRIEND, me, "1000000000000000000inj")] : []),
              indexed("A".repeat(64), 800, new Date(now - 3_600_000), FRIEND, me, `2500000${USDT}`),
              indexed("B".repeat(64), 700, new Date(now - 26 * 3_600_000), FRIEND, me, `7000000${SCAM}`),
            ];
      return reply(200, { tx_responses: list, total: String(list.length) });
    }
    if (p.startsWith("/cosmos/tx/v1beta1/txs/")) {
      return broadcasts.some((b) => sha(b) === tail)
        ? reply(200, { tx_response: { txhash: tail, height: "190861703", code: 0, raw_log: "" } })
        : reply(404, { code: 5, message: `tx not found: ${tail}`, details: [] });
    }
    reply(501, { code: 12, message: "Not Implemented", details: [] });
  });
});
await new Promise((r) => lcd.listen(0, "127.0.0.1", r));
const lcdUrl = `http://127.0.0.1:${lcd.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "cw-e2e-"));
const proc = spawn(chrome, [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Out of any screen opened over the tabs (Settings, a picker), onto the Wallet tab's Tokens
 *  pane. */
async function toWallet(pg) {
  for (let i = 0; i < 4; i++) {
    const backed = await pg.eval(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Back" && !b.disabled); if (b) b.click(); return !!b; })()`);
    if (!backed) break;
    await sleep(150);
  }
  await pg.click("Wallet");
  await pg.click("Tokens");
}
/** Settings: the gear on the Wallet tab's top bar. */
async function settings(pg) {
  await toWallet(pg);
  await pg.click("Settings");
}

const problems = [];
let nextId = 1;
const pending = new Map();
const [toChrome, fromChrome] = [proc.stdio[3], proc.stdio[4]];
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
/** A page's call to a DevTools binding (the fake Ledger's reports). */
let onBinding = null;
let buf = "";
fromChrome.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
    if (m.method === "Runtime.bindingCalled") onBinding?.(m);
    if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push("log: " + m.params.entry.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console: " + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)));
  }
});

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: ext });
  console.log("loaded extension", extId);

  /** The extension's service worker, to evaluate in. */
  async function serviceWorker() {
    let target;
    for (let t = 0; t < 5000 && !target; t += 100) {
      const { targetInfos } = await send("Target.getTargets");
      target = targetInfos.find((x) => x.type === "service_worker" && x.url === `chrome-extension://${extId}/background.js`);
      if (!target) await sleep(100);
    }
    if (!target) throw new Error("no service worker");
    const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    return {
      async eval(expr) {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }

  async function openPopup() {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    return pageFor(targetId);
  }
  async function pageFor(targetId) {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Log.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 600, deviceScaleFactor: 2, mobile: false }, sessionId);
    const page = {
      async eval(expr) {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async waitText(text, ms = 8000) {
        for (let t = 0; t < ms; t += 100) {
          if (await page.eval(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
          await sleep(100);
        }
        throw new Error(`timed out waiting for "${text}"; page: ${await page.eval("document.body.innerText")}${problems.length ? `\nproblems so far:\n${problems.join("\n")}` : ""}`);
      },
      async click(text) {
        // By its text, or by its accessible name for an icon button. A button still disabled
        // while its screen loads (Settings' Save) gets up to 5 s.
        let ok = false;
        for (let t = 0; t < 5000 && !ok; t += 100) {
          ok = await page.eval(`(() => { const t = ${JSON.stringify(text)}; const b = [...document.querySelectorAll("button")].find((b) => (b.textContent.trim() === t || b.getAttribute("aria-label") === t) && !b.disabled); if (b) b.click(); return !!b; })()`);
          if (!ok) await sleep(100);
        }
        if (!ok) throw new Error(`no enabled button "${text}"; page: ${await page.eval("document.body.innerText")}`);
      },
      async fill(selector, index, value) {
        await page.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      },
      async shot(name) {
        await sleep(250); // let the screen's entrance animation finish
        // Headless Chrome stops drawing a tab another window covered (a site's approval
        // window), and a screenshot then waits for a frame forever: bring it forward first,
        // and give up after 15 s rather than hang the run.
        await send("Page.bringToFront", {}, sessionId);
        const got = await Promise.race([send("Page.captureScreenshot", { format: "png" }, sessionId), sleep(15000).then(() => null)]);
        if (!got) throw new Error(`screenshot ${name}: no frame in 15 s`);
        writeFileSync(join(out, `${name}.png`), Buffer.from(got.data, "base64"));
        return join(out, `${name}.png`);
      },
      close: () => send("Target.closeTarget", { targetId }),
      sessionId,
    };
    return page;
  }

  // 1. Create a new wallet, through the backup check.
  let p = await openPopup();
  await p.waitText("Create a new wallet");
  await p.shot("01-welcome");
  await p.click("Create a new wallet");
  await p.waitText("Your recovery phrase");
  const words = await p.eval(`[...document.querySelectorAll(".words li")].map((li) => li.textContent)`);
  console.log("generated phrase has", words.length, "words");
  await p.shot("02-backup");
  await p.click("I wrote them down");
  await p.waitText("Check your backup");
  const asked = await p.eval(`[...document.querySelectorAll("label")].map((l) => parseInt(l.textContent.slice(5), 10))`);
  for (const [i, n] of asked.entries()) await p.fill("label input", i, words[n - 1]);
  await p.shot("03-confirm");
  await p.click("Continue");
  await p.waitText("Set a password");
  await p.fill("input[type=password]", 0, "correct horse battery staple");
  await p.fill("input[type=password]", 1, "correct horse battery staple");
  await p.shot("04-password");
  await p.click("Create wallet");
  await p.waitText("Account 1");
  if (live) {
    // The default mainnet endpoints, from the browser: a fresh account has no tokens.
    await p.waitText("No tokens yet.", 20000);
    console.log("live: mainnet endpoints answered (no tokens yet)");
    await p.shot("05-home-empty");
  }
  /** The QR code on screen must read back as the address beside it. */
  async function checkQr(png, address) {
    if (!(await p.eval(`!!document.querySelector("svg.qr")`))) throw new Error("no QR code on Receive");
    if (!process.env.E2E_QR_DECODER) return;
    const read = execFileSync(process.env.E2E_QR_DECODER, [png]).toString().trim();
    if (read !== address) throw new Error(`QR reads "${read}", the screen says "${address}"`);
    console.log("QR decodes to", read);
  }
  async function addresses() {
    await p.click("Receive");
    await p.waitText("Both addresses are the same account.");
    const a = [await p.eval(`document.querySelector(".address").textContent`)];
    await checkQr(await p.shot("06-receive"), a[0]);
    await p.click("EVM (0x)");
    a.push(await p.eval(`document.querySelector(".address").textContent`));
    await checkQr(await p.shot("06b-receive-evm"), a[1]);
    await p.click("Back");
    await p.waitText("Account 1");
    return a;
  }
  const addrs = await addresses();
  console.log("addresses", addrs);
  me0x = addrs[1];

  // 2. Lock, wrong password, unlock.
  await settings(p);
  await p.click("Lock now");
  await p.waitText("Unlock");
  await p.fill("input[type=password]", 0, "wrong password!");
  await p.click("Unlock");
  await p.waitText("Wrong password.");
  await p.shot("07-wrong-password");
  await p.fill("input[type=password]", 0, "correct horse battery staple");
  await p.click("Unlock");
  await p.waitText("Account 1");

  // 3. A fresh page while unlocked goes straight home (the unlock key is in session storage).
  await p.close();
  p = await openPopup();
  await p.waitText("Account 1");
  const again = await addresses();
  if (JSON.stringify(again) !== JSON.stringify(addrs)) throw new Error("addresses changed after reopening");
  console.log("reopened: still unlocked, same addresses");

  // 4. Point the wallet at the fake LCD.
  await settings(p);
  await p.waitText("Tried in order, one per line.");
  await p.fill("textarea", 0, lcdUrl);
  await p.fill("textarea", 2, lcdUrl); // Blockscout too
  await p.shot("08-settings");
  await p.click("Save");
  await p.waitText("USDT");
  // The look-alike USDT is unlisted and unpriced: hidden, behind a row that says so.
  await p.waitText("1 hidden token");
  const homeTokens = () => p.eval(`[...document.querySelectorAll(".token-list .token")].map((li) => li.innerText.replace(/\\s+/g, " "))`);
  const list = await homeTokens();
  console.log("balances", list);
  if (list.length !== 2 || !list[0].startsWith("INJ") || !list[1].startsWith("USDT") || list.join(" ").includes("factory/inj1")) {
    throw new Error("unexpected balance list");
  }
  if (live) {
    // Prices come from Choice for real: the total is in dollars.
    let hero = "";
    for (let t = 0; t < 15000 && !hero.startsWith("$"); t += 200) {
      hero = await p.eval(`document.querySelector(".hero")?.textContent ?? ""`);
      await sleep(200);
    }
    if (!hero.startsWith("$")) throw new Error(`no USD total; hero shows "${hero}"`);
    console.log("live: Choice prices, total", hero);
  }
  await p.shot("09-home");

  // 4b. The token filter: show the hidden token, which sticks across a reopen; hide it again.
  await p.click("1 hidden token");
  await p.waitText("Unlisted");
  await p.shot("09b-tokens");
  await p.click("Show USDT"); // only the hidden one offers "Show"
  await p.waitText("Hidden tokens stay in your account.");
  if (await p.eval(`document.body.innerText.includes("Unlisted")`)) throw new Error("the token is still hidden");
  await p.click("Back");
  await p.waitText("factory/inj1");
  await p.close();
  p = await openPopup();
  await p.waitText("factory/inj1");
  if ((await homeTokens()).length !== 3) throw new Error("the shown token didn't stay shown");
  await p.click("Manage");
  await p.waitText("Hidden tokens stay in your account.");
  // Hiding it again drops the choice: it is back to hidden by the rules.
  await p.eval(`document.querySelector('.token[title="${SCAM}"] button').click()`);
  await p.waitText("Unlisted");
  await p.click("Hide under $1");
  if ((await p.eval(`document.querySelector("[role=switch]").getAttribute("aria-checked")`)) !== "true") throw new Error("the switch didn't switch");
  await p.click("Hide USDT"); // the real one: now hidden by hand
  await p.waitText("Hidden by you");
  await p.shot("09c-tokens-hidden-by-you");
  await p.click("Show USDT"); // the first "Show" is the real USDT's, listed first
  await p.click("Hide under $1");
  await p.click("Back");
  await p.waitText("1 hidden token");
  if ((await homeTokens()).length !== 2) throw new Error("hiding didn't hide");
  console.log("token filter: hidden by default, shown and hidden by hand, kept across a reopen");

  // 4c. Add a token by contract, read from the real EVM side (the default JSON-RPC): an
  // address that isn't a token is refused; LUMA, an ERC20 with no bank denom, joins the list.
  await p.click("Manage");
  await p.waitText("Hidden tokens stay in your account.");
  await p.click("Add a token by contract");
  await p.fill('input[aria-label="Token contract"]', 0, "0x2222222222222222222222222222222222222222");
  await p.click("Add");
  await p.waitText("That address isn't an ERC20 token.", 20000);
  await p.fill('input[aria-label="Token contract"]', 0, "0xb0d94f200998997cf8175ae7ddf039927a8b3ef4");
  await p.click("Add");
  await p.waitText("EVM · 0xb0d9…3ef4", 20000);
  await p.shot("09d-token-added");
  await p.click("Back");
  await p.waitText("LUMA");
  if (await p.eval(`document.body.innerText.includes("EVM tokens may be missing")`)) throw new Error("the EVM endpoints didn't answer from the browser");
  console.log("add token: a non-token refused, LUMA (EVM-only) added from the live EVM side");

  // 4d. A CW20, added by its contract: its own screen, and the review of a conversion into
  // its bank form (cancelled here; the live testnet run converts for real).
  await p.click("Manage");
  await p.waitText("Hidden tokens stay in your account.");
  await p.click("Add a token by contract");
  await p.fill('input[aria-label="Token contract"]', 0, CW20);
  await p.click("Add");
  await p.waitText("CW20 · inj1300x…7xm8", 20000);
  await p.click("Back");
  await p.waitText("SHROOM");
  await p.eval(`document.querySelector('.token[title="cw20:${CW20}"]').click()`);
  await p.waitText("Convert to bank token");
  await p.waitText(CW20);
  await p.shot("09e-token-cw20");
  await p.click("Convert to bank token");
  await p.waitText("You get the same amount of SHROOM");
  await p.click("Max");
  await p.click("Review");
  await p.waitText("Review conversion", 15000);
  await p.waitText("Same token, other form, one for one.");
  const eyebrows = await p.eval(`[...document.querySelectorAll(".eyebrow")].map((e) => e.textContent).join(" | ")`);
  if (!eyebrows.includes("You convert · CW20") || !eyebrows.includes("You get · Bank token")) throw new Error(`conversion review: ${eyebrows}`);
  await p.waitText("3 SHROOM");
  if (await p.eval(`document.body.innerText.includes("runs its own code")`)) throw new Error("the adapter shouldn't get a contract note");
  await p.shot("09f-review-conversion");
  await p.click("Cancel");
  await p.waitText("You get the same amount of SHROOM");
  await p.click("Back");
  await p.click("Back");
  await p.waitText("Account 1");
  if (broadcasts.length !== 0) throw new Error("a cancelled conversion was broadcast");
  console.log("CW20: added by contract, its screen, a conversion reviewed and cancelled");

  // 4e. Opening fast: what the account showed last is drawn from disk before the chain
  // answers. With the endpoint down, the saved balances stay, with their age.
  // The list once it has settled (a fresh open, read again until it stops changing).
  await p.close();
  p = await openPopup();
  await p.waitText("USDT");
  let shownBefore = [];
  for (let t = 0, last = ""; t < 10000; t += 500) {
    await sleep(500);
    shownBefore = await homeTokens();
    if (shownBefore.join("|") === last) break;
    last = shownBefore.join("|");
  }
  await p.close();
  balancesDown = true;
  p = await openPopup();
  await p.waitText("Couldn't update. Showing balances from");
  // Tokens and amounts; USD values move with Choice's live prices between two reads.
  const noUsd = (list) => list.map((x) => x.replace(/ \$[0-9.,<]+/g, "")).join("|");
  if (noUsd(await homeTokens()) !== noUsd(shownBefore)) throw new Error(`saved balances differ: ${await homeTokens()} vs ${shownBefore}`);
  await p.shot("09g-saved-balances");
  balancesDown = false;
  await p.close();
  p = await openPopup();
  await p.waitText("USDT");
  console.log("saved balances: shown from disk while the endpoint is down");

  // 4f. Notifications: on for the account in use by default. The watcher's alarm is fired
  // by hand (an unpacked extension's alarms may fire at once): the first check only keeps
  // what's there; 1 INJ from FRIEND then notifies, and counts on the toolbar icon until the
  // wallet opens.
  await settings(p);
  await p.waitText("All accounts");
  const mode = await p.eval(`document.querySelector('[aria-label="Notifications"] [aria-pressed="true"]')?.textContent`);
  if (mode !== "This account") throw new Error(`notifications default: ${mode}`);
  await toWallet(p);
  const sw = await serviceWorker();
  if (!(await sw.eval(`chrome.alarms.get("watch").then((a) => a?.periodInMinutes)`))) throw new Error("no watcher alarm");
  // Start clean: the minute alarm may already have run (on mainnet, before step 4).
  await sw.eval(`Promise.all([chrome.storage.local.remove("watch"), chrome.action.setBadgeText({ text: "" }), chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id))))])`);
  // Fire the alarm, and wait until the check has written what it saw.
  const fire = async () => {
    const seenBefore = await sw.eval(`chrome.storage.local.get("watch").then((r) => JSON.stringify(r.watch?.accounts ?? null))`);
    await sw.eval(`chrome.alarms.create("watch", { when: Date.now() })`);
    for (let t = 0; t < 10000; t += 100) {
      await sleep(100);
      if ((await sw.eval(`chrome.storage.local.get("watch").then((r) => JSON.stringify(r.watch?.accounts ?? null))`)) !== seenBefore) return;
    }
    throw new Error("the watcher didn't run");
  };
  await fire();
  incoming = true;
  await fire();
  let ids = [];
  for (let t = 0; t < 8000 && ids.length === 0; t += 250) {
    ids = Object.keys(await sw.eval(`chrome.notifications.getAll()`));
    if (ids.length === 0) await sleep(250);
  }
  const notified = ids.find((id) => id.startsWith(`mainnet|${"D".repeat(64)}|inj1`));
  if (!notified || ids.length !== 1) throw new Error(`notifications: ${JSON.stringify(ids)}`);
  const badge = await sw.eval(`chrome.action.getBadgeText({})`);
  if (badge !== "1") throw new Error(`badge: "${badge}"`);
  await p.close();
  p = await openPopup();
  await p.waitText("USDT");
  for (let t = 0; t < 3000 && (await sw.eval(`chrome.action.getBadgeText({})`)) !== ""; t += 100) await sleep(100);
  if ((await sw.eval(`chrome.action.getBadgeText({})`)) !== "") throw new Error("the count stayed after the wallet opened");
  await sw.eval(`chrome.notifications.clear(${JSON.stringify(notified)})`);
  // Back as it was. Notifications go off for the rest: the watcher would see the 1 INJ go
  // again and have the wallet read everything again, in the middle of later checks.
  incoming = false;
  await settings(p);
  await p.waitText("All accounts");
  await p.click("Off");
  await p.click("Save");
  await p.waitText("1 hidden token");
  if (await sw.eval(`chrome.alarms.get("watch").then((a) => !!a)`)) throw new Error("the watcher's alarm stayed after notifications went off");
  console.log("notifications: 1 INJ in notified once, counted, cleared on open");

  // 5. Send 1.5 INJ to an EVM address; the review shows the vault's decode.
  const THEM_EVM = "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F";
  await p.click("Send");
  await p.waitText("Balance 5 INJ");
  await p.fill('input[placeholder^="inj1"]', 0, THEM_EVM);
  await p.click("Choose a token");
  await p.waitText("Choose a token");
  await p.shot("10-token-picker");
  await p.eval(`document.querySelector(".token-list .token").click()`);
  await p.waitText("Balance 5 INJ");
  await p.fill("input[inputmode=decimal]", 0, "1.5");
  await p.shot("11-send");
  await p.click("Review");
  await p.waitText("Review send");
  await p.waitText("1.5 INJ");
  await p.waitText(`You entered ${THEM_EVM}`);
  await p.waitText(`127.0.0.1:${lcd.address().port}`);
  // 82,771 gas simulated × 1.3 = 107,603 gas, at 160000000 inj per gas.
  await p.waitText("0.00001721648 INJ");
  const review = await p.eval("document.body.innerText");
  const to = (await p.eval(`document.querySelector(".recipient").textContent`)).trim();
  console.log("review to", to);
  await p.shot("12-review");
  await p.click("Confirm and send");
  await p.waitText("Sent", 15000);
  await p.shot("13-sent");
  if (broadcasts.length !== 1) throw new Error(`expected one broadcast, got ${broadcasts.length}`);
  const tx = Buffer.from(broadcasts[0], "base64");
  if (!tx.includes(Buffer.from(to))) throw new Error("the broadcast tx doesn't carry the reviewed recipient");
  const shown = await p.eval(`document.querySelector("[data-hash]").dataset.hash`);
  if (shown !== sha(broadcasts[0])) throw new Error("the shown hash isn't the broadcast tx's");
  console.log("sent", shown, "fee line:", review.split("\n").find((l) => l.includes("INJ") && !l.includes("1.5")));
  await p.click("Done");
  await p.waitText("Account 1");

  // 6. Max: the review shows the risk rules' amber finding. Cancel sends nothing.
  await p.click("Send");
  await p.waitText("Balance 5 INJ");
  await p.fill('input[placeholder^="inj1"]', 0, THEM_EVM);
  await p.click("Max");
  await p.click("Review");
  await p.waitText("Sends more than half of this account's INJ.");
  await p.shot("14-review-max");
  await p.click("Cancel");
  await p.waitText("Balance 5 INJ");
  if (broadcasts.length !== 1) throw new Error("cancel broadcast something");

  // 6b. The tabs: Activity shows the send, the receive, the EVM approval and the LUMA that
  // Blockscout found; the junk airdrop is hidden and the zero-value "transfer" isn't there.
  await p.click("Back");
  await p.waitText("Account 1");
  await p.click("Activity");
  await p.waitText("1 from hidden tokens", 15000);
  const rows = () => p.eval(`[...document.querySelectorAll(".activity")].map((r) => r.innerText.replace(/\\s+/g, " "))`);
  const shownRows = await rows();
  console.log("activity", shownRows);
  const [sent, luma, approved, usdt] = shownRows;
  if (
    shownRows.length !== 4 ||
    !sent.startsWith("Sent") ||
    !sent.includes("-1.5 INJ") ||
    !luma.startsWith("Received") ||
    !luma.includes("from 0x9d8a62f6…855a4f") ||
    !luma.includes("+2 LUMA") ||
    !approved.startsWith("Approved") ||
    !approved.includes("for 0x44444444…444444") ||
    !approved.includes("Unlimited USDT") ||
    !usdt.startsWith("Received") ||
    !usdt.includes("+2.5 USDT")
  ) {
    throw new Error("unexpected activity");
  }
  const titles = await p.eval(`[...document.querySelectorAll(".activity")].map((r) => r.title)`);
  if (titles[0] !== sha(broadcasts[0])) throw new Error("the sent row isn't the broadcast tx");
  if (titles[1] !== evmHash(860)) throw new Error("the LUMA row isn't named by its EVM hash");
  await p.shot("15-activity");
  await p.click("1 from hidden tokens");
  if ((await rows()).length !== 5) throw new Error("the hidden row didn't open");
  await settings(p);
  await p.waitText("Tried in order, one per line.");
  await p.shot("16-settings-tab");
  await toWallet(p);
  await p.waitText("1 hidden token");
  // Back to Activity within the minute: drawn at once from what the tab had, nothing asked.
  const searched = txSearches;
  await p.click("Activity");
  let shownAgain = [];
  for (let t = 0; t < 300 && shownAgain.length === 0; t += 20) {
    await sleep(20);
    shownAgain = await rows();
  }
  if (shownAgain.length !== 4 || shownAgain[0] !== shownRows[0]) throw new Error(`activity on a revisit: ${JSON.stringify(shownAgain)}`);
  await sleep(1000);
  if (txSearches !== searched) throw new Error(`a revisit asked the index again: ${JSON.stringify(txSearchLog.slice(searched))}`);
  await toWallet(p);
  await p.waitText("1 hidden token");
  console.log("tabs: Activity (send, receive, EVM approval, LUMA found through Blockscout; junk hidden, poisoning dropped; a revisit drawn at once, nothing asked), Settings, back to Wallet");

  // 7b. Staking: the home row counts staked, unstaking and unclaimed INJ (2 + 1 + 0.05); the
  // Staking screen; staking with a validator from the picker, reviewed as staking (the
  // validator's name, the unbonding note, no "most of your balance"), signed and broadcast.
  const stakingAnswer = await p.eval(`chrome.runtime.sendMessage({ type: "staking" }).then((r) => JSON.stringify(r).slice(0, 600))`);
  if (!stakingAnswer.startsWith('{"ok":true')) throw new Error(`staking summary: ${stakingAnswer}`);
  await p.waitText("Staked INJ", 15000);
  const stakingRow = () => p.eval(`[...document.querySelectorAll(".token")].find((b) => b.innerText.includes("Staked INJ"))?.innerText.replace(/\\s+/g, " ")`);
  if (!(await stakingRow()).includes("3.05")) throw new Error(`staking row: ${await stakingRow()}`);
  await p.shot("16b-home-staking");
  await p.eval(`[...document.querySelectorAll(".token")].find((b) => b.innerText.includes("Staked INJ")).click()`);
  await p.waitText("YOUR VALIDATORS");
  await p.waitText("Alpha Validator");
  await p.waitText("Unstaking takes 21 days.");
  await p.waitText("Bravo Validator · back");
  await p.shot("16c-staking");
  await p.click("Stake");
  await p.waitText("Pick a validator");
  const picked = await p.eval(`[...document.querySelectorAll(".token .symbol")].map((e) => e.textContent).join(",")`);
  if (picked !== "Bravo Validator,Alpha Validator") throw new Error(`picker: ${picked}`);
  await p.fill('input[aria-label="Search validators"]', 0, "brav");
  await p.waitText("5% commission · 90% of stake");
  await p.shot("16d-validator-picker");
  await p.eval(`document.querySelector(".token").click()`);
  await p.waitText("With Bravo Validator");
  await p.click("Max");
  await p.waitText("Keeps 0.01 INJ for fees.");
  await p.click("Review");
  await p.waitText("Review staking", 15000);
  await p.waitText("YOU STAKE");
  await p.waitText("Bravo Validator");
  await p.waitText("Unstaking it later takes the unbonding period.");
  if (await p.eval(`document.body.innerText.includes("more than half")`)) throw new Error("staking all you have shouldn't warn about your balance");
  await p.shot("16e-review-stake");
  await p.click("Confirm");
  await p.waitText("Confirmed", 15000);
  if (broadcasts.length !== 2) throw new Error(`expected the stake broadcast, got ${broadcasts.length}`);
  if (!Buffer.from(broadcasts[1], "base64").includes(Buffer.from("/cosmos.staking.v1beta1.MsgDelegate"))) throw new Error("the broadcast isn't a delegation");
  if (!Buffer.from(broadcasts[1], "base64").includes(Buffer.from(VAL_B))) throw new Error("the delegation isn't to the reviewed validator");
  await p.shot("16f-staked");
  await p.click("Done");
  // Done goes back to the tab the flow started on: Stake.
  await p.waitText("YOUR VALIDATORS");
  // Claim all: the review shows what is waiting (0.05 INJ with Alpha); cancelled here.
  await p.click("Claim all");
  await p.waitText("Review staking", 15000);
  await p.waitText("YOU CLAIM");
  await p.waitText("0.05 INJ");
  await p.waitText("At least this much");
  await p.shot("16g-review-claim");
  await p.click("Cancel");
  await p.waitText("YOUR VALIDATORS");
  await toWallet(p);
  await p.waitText("Account 1");
  if (broadcasts.length !== 2) throw new Error("a cancelled claim was broadcast");
  console.log("staking: home row 3.05 INJ, screen, picker search, stake max with Bravo reviewed and broadcast, claim reviewed and cancelled");

  // 7b2. Trading and Liquidity, the Wallet tab's other panes: the default trading account's
  // USDT (part of it backing orders) and its long; no Choice liquidity.
  await p.click("Trading");
  await p.waitText("Default trading account", 15000);
  await p.waitText("4 USDT free");
  await p.waitText("Long 2.5");
  await p.shot("16g2-trading");
  await p.click("Liquidity");
  await p.waitText("No liquidity in Choice pools.");
  await p.click("Tokens");
  await p.waitText("Manage");
  console.log("panes: Trading (a trading account, what's free, its long), Liquidity (none), back to Tokens");

  // 7c. Approvals and grants, from Settings: rewards redirected (red), a grant that can send
  // everything (red), a fee allowance and a SHROOM allowance; "Revoke all" takes all four back
  // in one transaction.
  await settings(p);
  await p.click("Approvals and grants");
  await p.waitText("PERMISSIONS", 20000);
  await p.waitText("Your staking rewards go to");
  await p.waitText("Send your tokens");
  await p.waitText("Pays fees from your INJ");
  await p.waitText("may take 2 SHROOM");
  if (!(await p.eval(`document.querySelector(".danger-text")?.textContent === "Send your tokens"`))) throw new Error("the send grant isn't marked");
  await p.shot("16h-approvals");
  await p.click("Revoke all 4");
  await p.waitText("Review revoke", 15000);
  await p.waitText("YOU TAKE BACK");
  for (const line of ["Send your tokens", "Fee allowance", "Staking rewards come to this account again", "SHROOM allowance"]) await p.waitText(line);
  await p.waitText("Removes");
  await p.shot("16i-review-revoke");
  await p.click("Confirm");
  await p.waitText("Confirmed", 15000);
  const revoked = Buffer.from(broadcasts[broadcasts.length - 1], "base64");
  for (const t of ["/cosmos.authz.v1beta1.MsgRevoke", "/cosmos.feegrant.v1beta1.MsgRevokeAllowance", "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress", "decrease_allowance"]) {
    if (!revoked.includes(Buffer.from(t))) throw new Error(`the revoke tx has no ${t}`);
  }
  await p.click("Done");
  await p.waitText("Account 1");
  console.log("approvals: rewards address, send grant, fee allowance and CW20 allowance listed, all revoked in one tx");

  // 7d. The address book and exchange memos. A contact saved with its memo: picked in Send,
  // the memo comes with it and the review names the contact; without the memo, red. An
  // exchange the wallet finds from its deposits: amber until a memo is typed; sent with it,
  // and saved from the sent screen.
  await settings(p);
  await p.click("Address book");
  await p.waitText("No contacts yet.");
  await p.click("Add contact");
  await p.fill('input[aria-label="Contact name"]', 0, "My exchange");
  await p.fill('input[aria-label="Contact address"]', 0, EXCHANGE);
  await p.fill('input[aria-label="Contact memo"]', 0, "101234567");
  await p.shot("16j-contact-new");
  await p.click("Save");
  await p.waitText("memo 101234567");
  await p.shot("16k-address-book");
  await p.click("Back");
  await toWallet(p);
  await p.waitText("Manage", 15000);
  await p.click("Send");
  await p.waitText("Balance");
  await p.click("Contacts");
  await p.waitText("ADDRESS BOOK");
  await p.shot("16l-send-to");
  await p.eval(`[...document.querySelectorAll(".token")].find((b) => b.textContent.includes("My exchange")).click()`);
  await p.waitText("My exchange, from your address book");
  if ((await p.eval(`document.querySelector('input[aria-label="Memo"]').value`)) !== "101234567") throw new Error("the contact's memo didn't come with it");
  await p.fill("input[inputmode=decimal]", 0, "0.5");
  await p.click("Review");
  await p.waitText("To My exchange from your address book.", 15000);
  await p.waitText("101234567");
  await p.shot("16m-review-contact");
  await p.click("Cancel");
  await p.waitText("Balance");
  // Pasting a contact's address brings its memo too; clear it.
  await p.fill('input[placeholder^="inj1"]', 0, EXCHANGE);
  await p.waitText("My exchange, from your address book");
  for (let t = 0; t < 3000 && (await p.eval(`document.querySelector('input[aria-label="Memo"]').value`)) !== "101234567"; t += 100) await sleep(100);
  await p.fill('input[aria-label="Memo"]', 0, "");
  await p.fill("input[inputmode=decimal]", 0, "0.5");
  await p.click("Review");
  await p.waitText("My exchange needs memo 101234567. This send has none.", 15000);
  if (!(await p.eval(`!!document.querySelector(".btn-danger")`))) throw new Error("a send missing its memo isn't red");
  await p.shot("16n-review-no-memo");
  await p.click("Cancel");
  await p.waitText("Balance");
  await p.fill('input[placeholder^="inj1"]', 0, FOUND_EXCHANGE);
  await p.fill('input[aria-label="Memo"]', 0, "");
  await p.waitText("This looks like an exchange: its deposits carry a memo. Add yours below.");
  await p.shot("16o-send-found-exchange");
  await p.fill('input[aria-label="Memo"]', 0, "555");
  await p.fill("input[inputmode=decimal]", 0, "0.5");
  if (await p.eval(`document.body.innerText.includes("This looks like an exchange")`)) throw new Error("the memo note stayed after a memo was typed");
  await p.click("Review");
  await p.waitText("Review send", 15000);
  await p.waitText("555");
  if (await p.eval(`document.querySelectorAll(".callout").length`)) throw new Error("a send with a memo to the exchange still has findings");
  const before = broadcasts.length;
  await p.click("Confirm and send");
  await p.waitText("Save address", 15000);
  if (broadcasts.length !== before + 1 || !Buffer.from(broadcasts[before], "base64").includes(Buffer.from("555"))) throw new Error("the send didn't carry its memo");
  await p.click("Save address");
  await p.waitText("New contact");
  if ((await p.eval(`document.querySelector('input[aria-label="Contact address"]').value`)) !== FOUND_EXCHANGE) throw new Error("the sent-to address wasn't filled in");
  if ((await p.eval(`document.querySelector('input[aria-label="Contact memo"]').value`)) !== "555") throw new Error("the memo wasn't filled in");
  await p.fill('input[aria-label="Contact name"]', 0, "Other exchange");
  await p.click("Save");
  await p.waitText("Manage", 15000);
  await settings(p);
  await p.click("Address book");
  await p.waitText("Other exchange");
  await p.waitText("memo 555");
  await p.click("Back");
  await toWallet(p);
  await p.waitText("Manage", 15000);
  console.log("address book: a contact with its memo picked in Send and named in the review, red without the memo; an exchange found from its deposits, sent with a memo and saved");

  // 7e. Swaps, quoted by Choice's real routing API (its calldata pays this wallet), sent to
  // the mock EVM endpoint. INJ in is one step; USDT in needs two exact approvals first.
  // Settings fill in once loaded (the LCD field shows the mock); only then edit them.
  const settingsLoaded = async () => {
    for (let t = 0; t < 10000 && !(await p.eval(`document.querySelector("#lcd-endpoints")?.value.includes(${JSON.stringify(lcdUrl)}) ?? false`)); t += 100) await sleep(100);
  };
  await settings(p);
  await settingsLoaded();
  await p.fill("textarea", 1, lcdUrl);
  await p.click("Save");
  await p.waitText("Manage", 15000);
  /** Pick a token in the swap picker once its row is there (the list loads with the screen). */
  const pickToken = async (denom) => {
    const sel = JSON.stringify(`.token[title="${denom}"]`);
    for (let t = 0; t < 15000 && !(await p.eval(`!!document.querySelector(${sel})`)); t += 100) await sleep(100);
    await p.eval(`document.querySelector(${sel}).click()`);
  };
  await p.click("Swap");
  await p.waitText("YOU PAY");
  await p.click("Choose the token to get");
  await p.waitText("Swap to");
  await pickToken(USDT);
  await p.fill('input[aria-label="Amount to pay"]', 0, "0.5");
  await p.waitText("At least", 30000);
  await p.waitText("Choice fee");
  await p.shot("16p-swap-quote");
  await p.click("Review swap");
  await p.waitText("Review swap", 30000);
  for (const t of ["YOU SWAP", "YOU GET AT LEAST", "Choice expects", "0.5 INJ", "A swap through Choice's aggregator"]) await p.waitText(t);
  await p.shot("16q-review-swap");
  await p.click("Confirm swap");
  await p.waitText("Swapped", 15000);
  if (evmRaw.length !== 1 || !evmRaw[0].toLowerCase().includes("a705d0d5f549af25024038dc575e3074b9bd37c9")) throw new Error("the swap wasn't sent to Choice's aggregator");
  await p.click("Done");
  await toWallet(p);
  await p.waitText("Manage", 15000);

  await p.click("Swap");
  await p.waitText("YOU PAY");
  await p.click("Choose the token to pay");
  await p.waitText("Swap from");
  await pickToken(USDT);
  await p.click("Choose the token to get");
  await pickToken("inj");
  await p.fill('input[aria-label="Amount to pay"]', 0, "1");
  await p.waitText("Two approvals, for this amount only", 30000);
  await p.shot("16r-swap-usdt-quote");
  await p.click("Review (3 steps)");
  await p.waitText("Review approval", 30000);
  for (const t of ["YOU ALLOW", "Permit2", "Exactly this swap's amount.", "Two more steps after this."]) await p.waitText(t);
  await p.shot("16s-review-approve");
  await p.click("Approve");
  await p.waitText("Next step", 15000);
  await p.click("Next step");
  await p.waitText("TO TAKE THROUGH PERMIT2", 30000);
  await p.waitText("Choice's aggregator");
  await p.shot("16t-review-permit2");
  await p.click("Approve");
  await p.waitText("Next step", 15000);
  await p.click("Next step");
  await p.waitText("YOU GET AT LEAST", 30000);
  await p.shot("16u-review-swap-usdt");
  await p.click("Confirm swap");
  await p.waitText("Swapped", 15000);
  const swapTxs = evmRaw.map((r) => r.toLowerCase());
  if (swapTxs.length !== 4 || !swapTxs[1].includes(PERMIT2_APPROVED) || !swapTxs[2].includes("87517c45") || !swapTxs[3].includes("a705d0d5f549af25024038dc575e3074b9bd37c9")) {
    throw new Error("the USDT swap's three transactions aren't approve, Permit2, swap");
  }
  await p.click("Done");
  await toWallet(p);
  await p.waitText("Manage", 15000);
  console.log("swaps: INJ to USDT in one step; USDT to INJ through approve, Permit2 and the swap, each exact; all quoted live by Choice");

  // 7f. Bridging USDC out over Circle's CCTP: Circle's real fee API answers the extension
  // (no CORS preflight), the approval is exact, and the burn the vault reads goes to this
  // account's own address on Base, delivered by Circle. Both go to the mock EVM endpoint.
  usdcHeld = true;
  await toWallet(p);
  await p.click("Bridge");
  await p.waitText("Bridge USDC");
  await p.waitText("Balance 3 USDC", 15000);
  await p.click("Choose the chain");
  await p.waitText("Bridge to");
  await p.eval(`[...document.querySelectorAll(".token")].find((b) => b.querySelector(".symbol")?.textContent === "Base").click()`);
  await p.fill('input[aria-label="Amount of USDC"]', 0, "1");
  await p.waitText("Circle's fee", 30000);
  await p.waitText("One approval, for this amount only");
  await p.shot("16v-bridge-quote");
  await p.click("Review (2 steps)");
  await p.waitText("Review approval", 30000);
  for (const t of ["YOU ALLOW", "Circle's bridge (CCTP)", "Exactly this transfer's amount.", "Then the transfer itself."]) await p.waitText(t);
  await p.shot("16w-review-bridge-approve");
  await p.click("Approve");
  await p.waitText("Next step", 15000);
  await p.click("Next step");
  await p.waitText("Review bridge", 30000);
  for (const t of ["YOU BRIDGE", "TO BASE", "Your own address there.", "Bridges USDC to Base over Circle's CCTP.", "Delivered by"]) await p.waitText(t);
  await p.shot("16x-review-bridge");
  await p.click("Confirm and bridge");
  await p.waitText("Bridging to Base", 20000);
  await p.shot("16y-bridging");
  const bridgeTxs = evmRaw.slice(-2).map((r) => r.toLowerCase());
  if (!bridgeTxs[0].includes(CCTP_APPROVED) || !bridgeTxs[1].includes("28b5a0e9c621a5badaa536219b3a228c8168cf5d") || !bridgeTxs[1].includes("779b432d")) {
    throw new Error("the bridge's two transactions aren't the exact approval and the burn");
  }
  await p.click("Done");
  await toWallet(p);
  await p.waitText("Manage", 15000);
  usdcHeld = false;
  console.log("bridge: 1 USDC to this account's address on Base; Circle's fee quoted live from the extension; approve exact, then the burn the vault read");

  // 7g. From another chain: each chain's USDC for this (public test) address, read live from
  // its public endpoints by the service worker; picking Base turns the transfer toward
  // Injective, with Choice's INJ top-up offered.
  await p.click("Bridge");
  await p.waitText("Balance 3 USDC", 15000);
  await p.click("Choose where it comes from");
  await p.waitText("Bridge from");
  for (const t of ["Base", "Arbitrum", "Ethereum", "Solana"]) await p.waitText(t);
  await p.shot("16z-bridge-in-from");
  await p.eval(`[...document.querySelectorAll(".token")].find((b) => b.querySelector(".symbol")?.textContent === "Base").click()`);
  await p.waitText("Also get INJ for gas");
  if (!(await p.eval(`document.querySelector("[aria-label='Choose the chain']")?.innerText ?? ""`)).includes("Injective")) throw new Error("from Base, the transfer doesn't go to Injective");
  await p.shot("16z2-bridge-from-base");
  await toWallet(p);
  await p.waitText("Manage", 15000);
  console.log("bridge from another chain: every chain's USDC read live from its public endpoint; from Base it goes to Injective");

  // 7h. Another EVM chain: Base, picked in the chain sheet (each chain's total read live from
  // its public endpoints), its own Home, and Settings showing only Base's endpoints.
  await p.click("Chain: Injective. Change chain");
  await p.waitText("Arbitrum");
  for (let t = 0; t < 150 && (await p.eval(`document.querySelectorAll(".chain-row .skeleton").length`)) > 0; t++) await sleep(100);
  await p.shot("16za-chains");
  await p.eval(`[...document.querySelectorAll(".chain-row")].find((b) => b.querySelector(".symbol")?.textContent === "Base").click()`);
  await p.waitText("Gas on Base");
  await p.shot("16zb-home-base");
  if (!(await p.eval(`document.querySelector("[aria-label='Copy address']")?.title ?? ""`)).startsWith("0x")) throw new Error("Base's Home doesn't show the 0x address");
  await p.click("Activity");
  await p.waitText("Only what this wallet sent on Base");
  await p.shot("16zd-activity-base");
  await settings(p);
  await p.waitText("Base (JSON-RPC)");
  const areas = await p.eval(`[...document.querySelectorAll("textarea")].map((t) => t.getAttribute("aria-label")).join(",")`);
  if (areas !== "Base endpoints,Base history") throw new Error(`Settings on Base shows: ${areas}`);
  await p.shot("16zc-settings-base");
  await toWallet(p);
  await p.click("Chain: Base. Change chain");
  await p.eval(`[...document.querySelectorAll(".chain-row")].find((b) => b.querySelector(".symbol")?.textContent === "Injective").click()`);
  await p.waitText("Manage", 15000);
  console.log("chains: Base from the sheet, its coin and USDC, its Activity, and Settings with only Base's endpoints");

  // 7i. A chain added from chainlist.org, live: found by name, its endpoints checked by the
  // service worker, its logo fetched once from DefiLlama and kept; its Home; then removed.
  await p.click("Chain: Injective. Change chain");
  await p.eval(`document.querySelector(".add-chain").click()`);
  await p.waitText("From chainlist.org");
  await p.fill("input", 0, "BNB Smart");
  await p.waitText("Chain ID 56 · BNB", 45000);
  await p.shot("16zf-add-chain-search");
  await p.eval(`[...document.querySelectorAll(".chain-row")].find((b) => b.querySelector(".sub")?.textContent.startsWith("Chain ID 56 ")).click()`);
  await p.waitText("It must answer as this chain");
  await p.shot("16zg-add-chain-form");
  await p.click("Add chain");
  await p.waitText("Added by you. Chain ID 56.", 60000);
  const bnbName = await p.eval(`document.querySelector(".chain-pill")?.textContent ?? ""`);
  if (!/BNB/.test(bnbName)) throw new Error(`the added chain isn't picked: ${bnbName}`);
  const bnbLogo = await p.eval(`document.querySelector(".chain-pill img")?.getAttribute("src") ?? ""`);
  if (!bnbLogo.startsWith("data:image/png;base64,")) throw new Error(`the added chain has no kept logo: ${bnbLogo.slice(0, 40)}`);
  for (let t = 0; t < 150 && (await p.eval(`document.querySelectorAll(".skeleton").length`)) > 0; t++) await sleep(100);
  await p.shot("16zh-home-added-chain");
  if (await p.eval(`[...document.querySelectorAll(".quick-action")].some((b) => b.textContent.includes("Bridge"))`)) throw new Error("an added chain offers the bridge");
  await settings(p);
  await p.waitText("history (Blockscout or Etherscan-style)");
  const removeLabel = await p.eval(`[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((t) => t.startsWith("Remove ")) ?? ""`);
  if (!removeLabel) throw new Error("Settings on an added chain has no Remove");
  await p.shot("16zi-settings-added-chain");
  await p.click(removeLabel);
  await p.click(`${removeLabel}? Tap again`);
  await toWallet(p);
  await p.waitText("Manage", 15000);
  await p.click("Chain: Injective. Change chain");
  await p.waitText("Add a chain");
  if (await p.eval(`[...document.querySelectorAll(".chain-row .symbol")].some((s) => s.textContent.includes("BNB"))`)) throw new Error("the removed chain is still listed");
  await p.eval(`[...document.querySelectorAll(".chain-row")].find((b) => b.querySelector(".symbol")?.textContent === "Injective").click()`);
  console.log("added chain: BNB Smart Chain found on chainlist.org, its endpoints checked, DefiLlama's logo kept, its Home, removed in Settings");

  await settings(p);
  await settingsLoaded();
  await p.fill("textarea", 1, "https://sentry.evm-rpc.injective.network\nhttps://injective-evm-rpc.publicnode.com");
  await p.click("Save");
  await p.waitText("Manage", 15000);

  // 8. A site: finds the wallet through EIP-6963 (window.ethereum untouched), connects
  // through an approval window (rejected once, then approved), gets a message signed, and
  // shows up in Settings until disconnected.
  const site = await pageFor((await send("Target.createTarget", { url: `${lcdUrl}/dapp.html` })).targetId);
  await site.waitText("Test dapp");
  const found = await site.eval(`window.__wallets.map((d) => d.info.rdns + "|" + d.info.name + "|" + d.info.icon.slice(0, 18)).join(",") + " " + typeof window.ethereum + " " + typeof window.choice`);
  if (found !== "exchange.choice.wallet|Choice Wallet|data:image/svg+xml undefined object") throw new Error(`the site sees: ${found}`);
  const ask = async (method, params) => {
    await site.eval(`window.__ask(${JSON.stringify(method)}, ${JSON.stringify(params ?? [])})`);
  };
  const answer = () => site.eval("window.__r");
  /** The approval window that opens next. Its buttons wait for focus, which headless
   *  windows don't get, so focus is emulated. */
  const approval = async () => {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = await send("Target.getTargets");
      const t = targetInfos.find((x) => x.url.includes("popup.html?approve=") && !seenApprovals.has(x.targetId));
      if (t) {
        seenApprovals.add(t.targetId);
        const w = await pageFor(t.targetId);
        await w.eval("1");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true }, w.sessionId);
        return w;
      }
      await sleep(100);
    }
    throw new Error("no approval window opened");
  };
  const seenApprovals = new Set();
  await ask("eth_chainId");
  if ((await answer()).ok !== "0x6f0") throw new Error("eth_chainId");
  await ask("eth_requestAccounts");
  let a = await approval();
  await a.waitText("wants to connect");
  await a.click("Reject");
  const rejected = await answer();
  if (rejected.code !== 4001) throw new Error(`a rejected connect: ${JSON.stringify(rejected)}`);
  await ask("eth_requestAccounts");
  a = await approval();
  await a.waitText("wants to connect");
  await a.waitText(addrs[0]);
  await a.shot("17-site-connect");
  await sleep(900); // the buttons wake after 800 ms in front
  await a.click("Connect");
  const accounts = (await answer()).ok;
  if (JSON.stringify(accounts) !== JSON.stringify([addrs[1].toLowerCase()])) throw new Error(`connected accounts: ${JSON.stringify(accounts)}`);
  const message = `0x${Buffer.from("Sign in to the test dapp").toString("hex")}`;
  await ask("personal_sign", [message, addrs[1]]);
  a = await approval();
  await a.waitText("Sign in to the test dapp", 15000);
  await a.shot("18-site-sign");
  await sleep(900);
  await a.click("Sign");
  const signature = (await answer()).ok;
  // The same signature from the vault itself, in Node, for the same phrase and message.
  const glue = await import(new URL("./build/vault/choice_wallet_wasm.js", import.meta.url).href);
  glue.initSync({ module: readFileSync(new URL("./build/vault/choice_wallet_wasm_bg.wasm", import.meta.url)) });
  const v = (method, params) => {
    const r = JSON.parse(glue.handle(JSON.stringify({ method, params })));
    if (!r.ok) throw new Error(`vault ${method}: ${r.error.message}`);
    return r.result;
  };
  const { unlock_key } = v("create_vault", { password: "correct horse battery staple" });
  const { secret } = v("seal_secret", { unlock_key, wallet: "w", secret: { mnemonic: words.join(" ") } });
  const request = { evm_personal_sign: { chain: "eip155:1776", signer: addrs[1], message } };
  const expected = v("sign", { secret, wallet: "w", unlock_key, account: { derivation: "default", index: 0 }, request, digest: v("decode", { request }).digest }).signature;
  if (signature !== expected) throw new Error(`personal_sign: got ${signature}, the vault signs ${expected}`);
  // ADR-036 through window.choice: the window shows the text; the page gets the vault's
  // signature, which verifyArbitrary accepts.
  const arbitraryText = "Sign in to the test dapp";
  // (Assigned in a statement, so the evaluation doesn't wait for the answer.)
  await site.eval(`void (window.__r = window.choice.signArbitrary("injective-1", ${JSON.stringify(addrs[0])}, ${JSON.stringify(arbitraryText)}).then((r) => ({ ok: r }), (e) => ({ code: e.code, message: e.message })))`);
  const arb = await approval();
  await arb.waitText(arbitraryText, 15000);
  await arb.shot("18b-site-sign-arbitrary");
  await sleep(900);
  await arb.click("Sign");
  const stdSig = (await answer()).ok;
  if (!stdSig?.signature) throw new Error(`signArbitrary: ${JSON.stringify(await answer())}`);
  const arbRequest = { cosmos_arbitrary: { chain: "cosmos:injective-1", signer: v("accounts", { secret, wallet: "w", unlock_key, accounts: [{ derivation: "default", index: 0 }] }).accounts[0].public_key, data: Buffer.from(arbitraryText).toString("hex") } };
  const arbExpected = v("sign", { secret, wallet: "w", unlock_key, account: { derivation: "default", index: 0 }, request: arbRequest, digest: v("decode", { request: arbRequest }).digest }).signature;
  if (Buffer.from(stdSig.signature, "base64").toString("hex") !== arbExpected) throw new Error("signArbitrary: the page's signature isn't the vault's");
  await site.eval(`void (window.__r = window.choice.verifyArbitrary("injective-1", ${JSON.stringify(addrs[0])}, ${JSON.stringify(arbitraryText)}, ${JSON.stringify(stdSig)}).then((r) => ({ ok: r }), (e) => ({ code: e.code, message: e.message })))`);
  if ((await answer()).ok !== true) throw new Error("verifyArbitrary didn't accept the wallet's own signature");
  // Solana through the Wallet Standard: the site, connected already, sees the account's
  // Solana address, and a message it signs is the vault's ed25519 signature of its bytes.
  const std = await site.eval(`window.__std.map((w) => w.name + "|" + w.chains.join(",") + "|" + Object.keys(w.features).sort().join(",")).join(" ")`);
  const wantStd = "Choice Wallet|solana:mainnet,solana:devnet|solana:signAndSendTransaction,solana:signMessage,solana:signTransaction,standard:connect,standard:disconnect,standard:events";
  if (std !== wantStd) throw new Error(`Wallet Standard: the site sees ${std}`);
  const solAddr = v("accounts", { secret, wallet: "w", unlock_key, accounts: [{ derivation: "default", index: 0 }] }).accounts[0].addresses["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
  await site.eval(`void (window.__r = window.__std[0].features["standard:connect"].connect().then((r) => ({ ok: r.accounts.map((a) => a.address + ":" + a.publicKey.length + ":" + a.chains.join()) }), (e) => ({ code: e.code, message: e.message })))`);
  const solAccounts = (await answer()).ok;
  if (JSON.stringify(solAccounts) !== JSON.stringify([`${solAddr}:32:solana:mainnet`])) throw new Error(`standard:connect: ${JSON.stringify(await answer())}`);
  const solText = "Sign in with Solana to the test dapp";
  await site.eval(`void (window.__r = (() => { const w = window.__std[0]; return w.features["solana:signMessage"].signMessage({ account: w.accounts[0], message: new TextEncoder().encode(${JSON.stringify(solText)}) }).then((r) => ({ ok: Array.from(r[0].signature, (b) => b.toString(16).padStart(2, "0")).join("") + "|" + new TextDecoder().decode(r[0].signedMessage) }), (e) => ({ code: e.code, message: e.message })); })())`);
  const solSign = await approval();
  await solSign.waitText(solText, 15000);
  await solSign.waitText("Solana");
  await solSign.shot("18c-site-solana-sign-message");
  await sleep(900);
  await solSign.click("Sign");
  const solRequest = { solana_message: { chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", signer: solAddr, message: Buffer.from(solText).toString("hex") } };
  const solExpected = v("sign", { secret, wallet: "w", unlock_key, account: { derivation: "default", index: 0 }, request: solRequest, digest: v("decode", { request: solRequest }).digest }).signature;
  for (let t = 0; t < 50 && !(await answer()); t++) await sleep(100);
  if ((await answer()).ok !== `${solExpected}|${solText}`) throw new Error(`solana:signMessage: ${JSON.stringify(await answer())}, the vault signs ${solExpected}`);
  await settings(p);
  await p.waitText(lcdUrl);
  await p.eval(`document.querySelector(".site-row")?.scrollIntoView()`);
  await p.shot("19-connected-sites");
  await p.click(`Disconnect ${lcdUrl}`);
  await p.waitText("None. A site asks first, in its own window.");
  await ask("eth_accounts");
  if (JSON.stringify((await answer()).ok) !== "[]") throw new Error("a disconnected site still sees the account");
  console.log("site: found by EIP-6963, connect rejected then approved, personal_sign and signArbitrary = the vault's signatures (verifyArbitrary agrees); Solana found by the Wallet Standard, signMessage = the vault's ed25519 signature; disconnected");

  // 9. Accounts: a second one from the phrase (the same address the vault derives in Node),
  // renamed; an address to watch, which can't send; then back to the first.
  const pill = () => p.eval(`document.querySelector("[aria-label='Copy address']").title`);
  await toWallet(p);
  await p.waitText("Manage", 15000);
  await p.click("Account: Account 1. Switch accounts");
  await p.waitText("Every wallet here opens with the same password.");
  await p.click("Add an account to Recovery phrase 1");
  await p.waitText("Account 2");
  const second = v("accounts", { secret, wallet: "w", unlock_key, accounts: [{ derivation: "default", index: 1 }] }).accounts[0].addresses["cosmos:injective-1"];
  for (let t = 0; t < 5000 && (await pill()) !== second; t += 100) await sleep(100);
  if ((await pill()) !== second) throw new Error(`account 2 shows ${await pill()}, the vault derives ${second}`);
  await p.click("Account: Account 2. Switch accounts");
  // Names save when the field loses focus; headless Chrome only sends focus events to a
  // page that emulates having it.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, p.sessionId);
  await p.click("Edit");
  await p.eval(`document.querySelector('input[aria-label="Name of Account 2"]').focus()`);
  await p.fill('input[aria-label="Name of Account 2"]', 0, "Trading");
  await p.eval(`document.querySelector('input[aria-label="Name of Account 2"]').blur()`);
  await sleep(300);
  await p.click("Done");
  await p.waitText("Trading");
  await p.click("Add a wallet");
  await p.click("Watch an address");
  await p.fill('input[aria-label="Address to watch"]', 0, SENT_TO);
  await p.click("Watch");
  await p.waitText("Watch-only");
  if ((await pill()) !== SENT_TO) throw new Error("the watched address isn't the one in use");
  if (!(await p.eval(`[...document.querySelectorAll("button.quick-action")].find((b) => b.textContent.trim() === "Send").disabled`))) throw new Error("a watch-only account can send");
  await p.shot("20-watch-only");
  await p.click("Account: Watching 1. Switch accounts");
  await p.waitText("Trading");
  await p.shot("21-accounts");
  await p.eval(`document.querySelectorAll(".account-row")[0].click()`);
  await p.waitText("Manage", 15000);
  for (let t = 0; t < 5000 && (await pill()) !== addrs[0]; t += 100) await sleep(100);
  if ((await pill()) !== addrs[0]) throw new Error("switching back didn't show account 1");
  console.log("accounts: a second from the phrase (= the vault's derivation), renamed, an address watched (can't send), back to the first");

  // 9b. A Ledger, in software behind a fake WebHID device (fake-ledger.mjs), so Ledger's
  // kit, its WebHID transport and the vault's signature checks all run for real: accounts
  // added in the Ledger tab, a send signed in the Cosmos app (amino JSON) and a swap in the
  // Ethereum app. The device signs with the BIP-39 test phrase, whose S may come back high.
  let fakeLedger = null;
  try {
    fakeLedger = await import("./fake-ledger.mjs");
  } catch (e) {
    console.log("ledger: skipped, run npm install in tools/vectors first:", e.message);
  }
  if (fakeLedger) {
    const device = fakeLedger.createFakeLedger({ log: (m) => console.log(m) });
    onBinding = (m) => {
      if (m.params.name !== "__ledger") return;
      const { id, hex } = JSON.parse(m.params.payload);
      const frames = device.report(hex);
      // A signature waits while "the user" reads the device, so the screen shows that step.
      // (A page closed meanwhile has nobody to answer.)
      setTimeout(() => send("Runtime.evaluate", { expression: `window.__ledgerReply(${id}, ${JSON.stringify(frames)})` }, m.sessionId).catch(() => {}), device.confirming() ? 1500 : 0);
    };
    /** An extension page with the fake device in its navigator.hid. */
    const ledgerPage = async (path) => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const pg = await pageFor(targetId);
      await send("Page.enable", {}, pg.sessionId);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: fakeLedger.PAGE_SCRIPT }, pg.sessionId);
      await send("Runtime.addBinding", { name: "__ledger" }, pg.sessionId);
      await send("Page.navigate", { url: `chrome-extension://${extId}/${path}` }, pg.sessionId);
      return pg;
    };
    const first = device.account("m/44'/60'/0'/0/0");
    const tab = await ledgerPage("popup.html?ledger=add");
    await tab.waitText("Add a Ledger");
    await tab.shot("21b-ledger-intro");
    await tab.click("Connect");
    await tab.waitText("Pick accounts", 15000);
    await tab.waitText(first.address.slice(-4), 15000);
    await tab.click("Show on Ledger");
    await tab.eval(`document.querySelector('input[aria-label="Account 1"]').click()`);
    await tab.shot("21c-ledger-pick");
    await tab.click("Add 1 account");
    // Then its Solana key, from the Solana app: Ledger Live's Solana account of the same number.
    const firstSol = device.solanaAddress("m/44'/501'/0'");
    await tab.waitText("Solana on your Ledger");
    await tab.shot("21d-ledger-solana");
    await tab.click("Add Solana");
    await tab.waitText(firstSol.slice(-4), 15000);
    await tab.click("Show on Ledger");
    await tab.shot("21d1-ledger-solana-added");
    await tab.click("Done");
    await tab.waitText("One account added, with Solana.");
    await tab.shot("21d-ledger-added");
    await tab.close();

    const lp = await ledgerPage("popup.html");
    await lp.waitText("Manage", 15000);
    const inUse = await lp.eval(`document.querySelector("[aria-label='Copy address']")?.title ?? ""`);
    if (inUse !== first.address) throw new Error(`the Ledger account isn't in use: ${inUse}`);
    // Its Solana address, in the chain sheet.
    await lp.click("Chain: Injective. Change chain");
    await lp.waitText(firstSol.slice(-4));
    await lp.shot("21d3-ledger-chains");
    await lp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    // A send, signed in the Cosmos app.
    const before = broadcasts.length;
    await lp.click("Send");
    await lp.waitText("Balance 5 INJ");
    await lp.fill('input[placeholder^="inj1"]', 0, SENT_TO);
    await lp.click("Choose a token");
    await lp.waitText("Choose a token");
    await lp.eval(`document.querySelector(".token-list .token").click()`);
    await lp.waitText("Balance 5 INJ");
    await lp.fill("input[inputmode=decimal]", 0, "0.25");
    await lp.click("Review");
    await lp.waitText("Review send", 15000);
    await lp.click("Confirm and send");
    await lp.waitText("Check it on your Ledger, then approve it there.", 10000);
    await lp.shot("21d2-ledger-confirm");
    await lp.waitText("Sent", 20000);
    await lp.shot("21e-ledger-sent");
    if (broadcasts.length !== before + 1) throw new Error("the Ledger send wasn't broadcast");
    const amino = device.signed.at(-1);
    if (amino?.app !== "cosmos" || !amino.payload.includes(`"to_address":"${SENT_TO}"`) || !amino.payload.includes(`"amount":"250000000000000000"`)) throw new Error(`the Cosmos app signed: ${JSON.stringify(amino)}`);
    if (!Buffer.from(broadcasts.at(-1), "base64").includes(Buffer.from(first.public_key, "hex"))) throw new Error("the broadcast tx isn't signed by the Ledger's key");
    await lp.click("Done");
    await toWallet(lp);
    await lp.waitText("Manage", 15000);
    // A swap, signed in the Ethereum app, sent to the mock EVM endpoint.
    const evmEndpoints = async (urls) => {
      await settings(lp);
      for (let t = 0; t < 10000 && !(await lp.eval(`document.querySelector("#lcd-endpoints")?.value.includes(${JSON.stringify(lcdUrl)}) ?? false`)); t += 100) await sleep(100);
      await lp.fill("textarea", 1, urls);
      await lp.click("Save");
      await lp.waitText("Manage", 15000);
    };
    await evmEndpoints(lcdUrl);
    const evmBefore = evmRaw.length;
    await lp.click("Swap");
    await lp.waitText("YOU PAY");
    await lp.click("Choose the token to get");
    await lp.waitText("Swap to");
    for (let t = 0; t < 15000 && !(await lp.eval(`!!document.querySelector('.token[title="${USDT}"]')`)); t += 100) await sleep(100);
    await lp.eval(`document.querySelector('.token[title="${USDT}"]').click()`);
    await lp.fill('input[aria-label="Amount to pay"]', 0, "0.1");
    await lp.waitText("At least", 30000);
    await lp.click("Review swap");
    await lp.waitText("YOU SWAP", 30000);
    await lp.click("Confirm swap");
    await lp.waitText("Ethereum app", 10000);
    await lp.shot("21e2-ledger-confirm-evm");
    await lp.waitText("Swapped", 20000);
    await lp.shot("21f-ledger-swapped");
    if (evmRaw.length !== evmBefore + 1) throw new Error("the Ledger swap wasn't sent");
    const evmSigned = device.signed.at(-1);
    // The signed transaction is the device's unsigned one with v, r and s appended.
    const fields = evmSigned?.payload.slice(4 + 2 * ((parseInt(evmSigned.payload.slice(2, 4), 16) - 0xf7) > 0 ? parseInt(evmSigned.payload.slice(2, 4), 16) - 0xf7 : 0));
    if (evmSigned?.app !== "ethereum" || evmSigned.kind !== "transaction" || !evmRaw.at(-1).toLowerCase().includes(fields)) throw new Error("the sent transaction isn't the one the Ethereum app signed");
    await lp.click("Done");
    await toWallet(lp);
    await lp.waitText("Manage", 15000);
    await evmEndpoints("https://sentry.evm-rpc.injective.network\nhttps://injective-evm-rpc.publicnode.com");
    await lp.close();
    console.log(`ledger: account added from the device (${first.address}, Solana ${firstSol} from its Solana app), a send signed in its Cosmos app and a swap in its Ethereum app, each checked by the vault`);
    // Back to the phrase's first account for the rest.
    await p.close();
    p = await openPopup();
    await p.waitText("Manage", 15000);
    await p.eval(`document.querySelector(".account-switch").click()`);
    await p.waitText("Accounts");
    await p.eval(`document.querySelectorAll(".account-row")[0].click()`);
    await p.waitText("Manage", 15000);
  }

  // 10. Security: the phrase behind the password; a new password (the old one stops
  // working); then the wallet removed, back to the welcome screen.
  await settings(p);
  await p.waitText("Tried in order, one per line.");
  await p.click("Show Recovery phrase 1");
  await p.fill('input[aria-label="Password"]', 0, "wrong password!");
  await p.click("Show");
  await p.waitText("Wrong password.");
  await p.fill('input[aria-label="Password"]', 0, "correct horse battery staple");
  await p.click("Show");
  await p.waitText(words[11]);
  const revealed = await p.eval(`[...document.querySelectorAll(".words li")].map((li) => li.textContent).join(" ")`);
  if (revealed !== words.join(" ")) throw new Error(`the phrase shown isn't the wallet's: ${revealed.split(" ").length} words shown, ${revealed.split(" ").filter((w, i) => w !== words[i]).length} differ`);
  await p.click("Done");
  await p.click("Change password");
  await p.fill('input[aria-label="Password"]', 0, "correct horse battery staple");
  await p.fill('input[aria-label="New password"]', 0, "a brand new passphrase");
  await p.fill('input[aria-label="Repeat the new password"]', 0, "a brand new passphrase");
  await p.shot("22-change-password");
  await p.click("Change password");
  await p.waitText("Tried in order, one per line.");
  await p.click("Lock now");
  await p.waitText("Unlock");
  await p.fill("input[type=password]", 0, "correct horse battery staple");
  await p.click("Unlock");
  await p.waitText("Wrong password.");
  await p.fill("input[type=password]", 0, "a brand new passphrase");
  await p.click("Unlock");
  await p.waitText("Manage", 15000);
  await settings(p);
  await p.click("Reset Choice Wallet");
  await p.fill('input[aria-label="Password"]', 0, "a brand new passphrase");
  await p.shot("23-reset");
  await p.click("Reset");
  await p.waitText("Create a new wallet");
  console.log("security: phrase shown after the password, password changed (old refused), everything reset");

  // 7. A web page can't talk to the service worker: there is no externally_connectable, so
  // chrome.runtime isn't even exposed to it.
  const { targetId: webId } = await send("Target.createTarget", { url: "data:text/html,<p>web page</p>" });
  const { sessionId: web } = await send("Target.attachToTarget", { targetId: webId, flatten: true });
  // A fresh tab may not have its page context yet: ask again briefly.
  let exposed;
  for (let tries = 0; ; tries++) {
    try {
      exposed = await send("Runtime.evaluate", { expression: `typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage`, returnByValue: true }, web);
      break;
    } catch (e) {
      if (tries >= 20 || !String(e).includes("execution context")) throw e;
      await sleep(100);
    }
  }
  console.log("web page sees chrome.runtime.sendMessage:", exposed.result.value);
} finally {
  lcd.close();
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors, exceptions or CSP violations");
process.exit(problems.length ? 1 : 0);
