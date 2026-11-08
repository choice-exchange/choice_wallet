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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, ext, out, flag] = process.argv.slice(2);
const live = flag === "--live";

// A fake mainnet LCD for any address: 5 INJ, 2.5 USDT, and a token that calls itself USDT.
const USDT = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SCAM = "factory/inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49/usdt";
const broadcasts = [];
const sha = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").toUpperCase();
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
    const tail = p.split("/").pop();
    if (p.endsWith("/node_info")) return reply(200, { default_node_info: { network: "injective-1" } });
    if (p.startsWith("/cosmos/auth/v1beta1/accounts/")) {
      return reply(200, { account: { "@type": "/injective.types.v1beta1.EthAccount", base_account: { address: tail, pub_key: null, account_number: "1234", sequence: "0" } } });
    }
    if (p.startsWith("/cosmos/bank/v1beta1/spendable_balances/")) {
      return reply(200, { balances: [{ denom: SCAM, amount: "7000000" }, { denom: "inj", amount: "5000000000000000000" }, { denom: USDT, amount: "2500000" }], pagination: { next_key: null } });
    }
    if (p === "/injective/txfees/v1beta1/cur_eip_base_fee") return reply(200, { base_fee: { base_fee: "160000000.000000000000000000" } });
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
      },
      close: () => send("Target.closeTarget", { targetId }),
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
  async function addresses() {
    await p.click("Receive");
    await p.waitText("Both addresses are the same account.");
    const a = [await p.eval(`document.querySelector(".address").textContent`)];
    await p.shot("06-receive");
    await p.click("EVM (0x)");
    a.push(await p.eval(`document.querySelector(".address").textContent`));
    await p.click("Back");
    await p.waitText("Account 1");
    return a;
  }
  const addrs = await addresses();
  console.log("addresses", addrs);

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
  await p.shot("08-settings");
  await p.click("Save");
  await p.waitText("USDT");
  await p.waitText("factory/inj1");
  const list = await p.eval(`[...document.querySelectorAll(".token-list .token")].map((li) => li.innerText.replace(/\\s+/g, " "))`);
  console.log("balances", list);
  if (list.length !== 3 || !list[0].startsWith("INJ") || !list[2].includes("factory/inj1")) throw new Error("unexpected balance list");
  await p.shot("09-home");

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
