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
const sha = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").toUpperCase();
// Indexed transactions for Activity, shaped like mainnet's (bank events and the fee payer).
const FRIEND = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v";
const SENT_TO = "inj1nk9x9ajk4rgkzhqjjn7hr6w0k0jg2kj0knl55v"; // the EIP-155 example key's address, the e2e's recipient
const FEE_COLLECTOR = "inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9";
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
        window.__ask = (method, params) => { const w = window.__wallets.find((d) => d.info.rdns === "exchange.choice.wallet"); window.__r = w.provider.request({ method, params }).then((r) => ({ ok: r }), (e) => ({ code: e.code, message: e.message })); };
      </script>`);
    }
    const tail = p.split("/").pop();
    if (p.endsWith("/node_info")) return reply(200, { default_node_info: { network: "injective-1" } });
    if (p.startsWith("/cosmos/auth/v1beta1/accounts/")) {
      return reply(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: tail, pub_key: null, account_number: "1234", sequence: "0" } } });
    }
    if (p.startsWith("/cosmos/bank/v1beta1/spendable_balances/")) {
      return reply(200, { balances: [{ denom: SCAM, amount: "7000000" }, { denom: "inj", amount: "5000000000000000000" }, { denom: USDT, amount: "2500000" }], pagination: { next_key: null } });
    }
    if (p === "/injective/txfees/v1beta1/cur_eip_base_fee") return reply(200, { base_fee: { base_fee: "160000000.000000000000000000" } });
    if (p === "/injective/erc20/v1beta1/all_token_pairs") {
      return reply(200, { token_pairs: [{ bank_denom: USDT, erc20_address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13" }], pagination: null });
    }
    const smart = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/]+)$/.exec(p);
    if (smart) {
      // CW20 queries as wasmd answers them; any other contract refuses.
      const q = JSON.parse(Buffer.from(decodeURIComponent(smart[2]), "base64").toString());
      if (smart[1] !== CW20) return reply(500, { code: 2, message: "query wasm contract failed: Error parsing into type" });
      if (q.token_info) return reply(200, { data: { name: "shroomin", symbol: "SHROOM", decimals: 18, total_supply: "1000000000000000000000000000" } });
      return reply(200, { data: { balance: "3000000000000000000" } });
    }
    if (p === "/cosmos/bank/v1beta1/denoms_metadata_by_query_string") {
      if (url.searchParams.get("denom") === SCAM) return reply(200, { metadata: { base: SCAM, display: "USDT", symbol: "USDT", name: "Tether USD", decimals: 6, denom_units: [] } });
      return reply(404, { code: 5, message: "client metadata for denom", details: [] });
    }
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
      meInj = me;
      const list =
        q.startsWith("message.sender=") || q.startsWith("coin_spent.spender=")
          ? [...broadcasts.map((b) => indexed(sha(b), 900, new Date(now - 60_000), me, SENT_TO, "1500000000000000000inj")), ...(me0x ? [evmTxs(me, now).approval] : [])]
          : [indexed("A".repeat(64), 800, new Date(now - 3_600_000), FRIEND, me, `2500000${USDT}`), indexed("B".repeat(64), 700, new Date(now - 26 * 3_600_000), FRIEND, me, `7000000${SCAM}`)];
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

const problems = [];
let nextId = 1;
const pending = new Map();
const [toChrome, fromChrome] = [proc.stdio[3], proc.stdio[4]];
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
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
    if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push("log: " + m.params.entry.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push("console: " + JSON.stringify(m.params.args.map((a) => a.value ?? a.description)));
  }
});

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: ext });
  console.log("loaded extension", extId);

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
        throw new Error(`timed out waiting for "${text}"; page: ${await page.eval("document.body.innerText")}`);
      },
      async click(text) {
        // By its text, or by its accessible name for an icon button.
        const ok = await page.eval(`(() => { const t = ${JSON.stringify(text)}; const b = [...document.querySelectorAll("button")].find((b) => (b.textContent.trim() === t || b.getAttribute("aria-label") === t) && !b.disabled); if (b) b.click(); return !!b; })()`);
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
        const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
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
  await p.click("Lock");
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
  await p.click("Settings");
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
  await p.click("Settings");
  await p.waitText("Tried in order, one per line.");
  await p.shot("16-settings-tab");
  await p.click("Wallet");
  await p.waitText("1 hidden token");
  console.log("tabs: Activity (send, receive, EVM approval, LUMA found through Blockscout; junk hidden, poisoning dropped), Settings, back to Wallet");

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
  const { keystore } = v("create_keystore", { secret: { mnemonic: words.join(" ") }, password: "correct horse battery staple" });
  const { unlock_key } = v("unlock", { keystore, password: "correct horse battery staple" });
  const request = { evm_personal_sign: { chain: "eip155:1776", signer: addrs[1], message } };
  const expected = v("sign", { keystore, unlock_key, account: { derivation: "default", index: 0 }, request, digest: v("decode", { request }).digest }).signature;
  if (signature !== expected) throw new Error(`personal_sign: got ${signature}, the vault signs ${expected}`);
  await p.click("Settings");
  await p.waitText(lcdUrl);
  await p.eval(`document.querySelector(".site-row")?.scrollIntoView()`);
  await p.shot("19-connected-sites");
  await p.click(`Disconnect ${lcdUrl}`);
  await p.waitText("None. A site asks first, in its own window.");
  await ask("eth_accounts");
  if (JSON.stringify((await answer()).ok) !== "[]") throw new Error("a disconnected site still sees the account");
  console.log("site: found by EIP-6963, connect rejected then approved, personal_sign = the vault's signature, disconnected");

  // 9. Accounts: a second one from the phrase (the same address the vault derives in Node),
  // renamed; an address to watch, which can't send; then back to the first.
  const pill = () => p.eval(`document.querySelector("[aria-label='Copy address']").title`);
  await p.click("Wallet");
  await p.waitText("Manage", 15000);
  await p.click("Account: Account 1. Switch accounts");
  await p.waitText("New accounts come from your recovery phrase.");
  await p.click("Add an account");
  await p.waitText("Account 2");
  const second = v("accounts", { keystore, unlock_key, accounts: [{ derivation: "default", index: 1 }] }).accounts[0].addresses["cosmos:injective-1"];
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
  await p.click("Watch an address");
  await p.fill('input[aria-label="Address to watch"]', 0, SENT_TO);
  await p.click("Watch");
  await p.waitText("Watch-only");
  if ((await pill()) !== SENT_TO) throw new Error("the watched address isn't the one in use");
  if (!(await p.eval(`[...document.querySelectorAll("button.action")].find((b) => b.textContent.includes("Send")).disabled`))) throw new Error("a watch-only account can send");
  await p.shot("20-watch-only");
  await p.click("Account: Watching 1. Switch accounts");
  await p.waitText("Trading");
  await p.shot("21-accounts");
  await p.eval(`document.querySelectorAll(".account-row")[0].click()`);
  await p.waitText("Manage", 15000);
  for (let t = 0; t < 5000 && (await pill()) !== addrs[0]; t += 100) await sleep(100);
  if ((await pill()) !== addrs[0]) throw new Error("switching back didn't show account 1");
  console.log("accounts: a second from the phrase (= the vault's derivation), renamed, an address watched (can't send), back to the first");

  // 10. Security: the phrase behind the password; a new password (the old one stops
  // working); then the wallet removed, back to the welcome screen.
  await p.click("Settings");
  await p.waitText("Tried in order, one per line.");
  await p.click("Show recovery phrase");
  await p.fill('input[aria-label="Password"]', 0, "wrong password!");
  await p.click("Show");
  await p.waitText("Wrong password.");
  await p.fill('input[aria-label="Password"]', 0, "correct horse battery staple");
  await p.click("Show");
  await p.waitText(words[11]);
  const revealed = await p.eval(`[...document.querySelectorAll(".words li")].map((li) => li.textContent).join(" ")`);
  if (revealed !== words.join(" ")) throw new Error("the phrase shown isn't the wallet's");
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
  await p.click("Settings");
  await p.click("Remove wallet");
  await p.fill('input[aria-label="Password"]', 0, "a brand new passphrase");
  await p.shot("23-remove-wallet");
  await p.click("Remove wallet");
  await p.waitText("Create a new wallet");
  console.log("security: phrase shown after the password, password changed (old refused), wallet removed");

  // 7. A web page can't talk to the service worker: there is no externally_connectable, so
  // chrome.runtime isn't even exposed to it.
  const { targetId: webId } = await send("Target.createTarget", { url: "data:text/html,<p>web page</p>" });
  const { sessionId: web } = await send("Target.attachToTarget", { targetId: webId, flatten: true });
  const exposed = await send("Runtime.evaluate", { expression: `typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage`, returnByValue: true }, web);
  console.log("web page sees chrome.runtime.sendMessage:", exposed.result.value);
} finally {
  lcd.close();
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors, exceptions or CSP violations");
process.exit(problems.length ? 1 : 0);
