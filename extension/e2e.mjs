// End-to-end check in a real browser: loads dist/ into Chromium and drives the popup over
// the DevTools protocol (Node built-ins only, no browser-automation packages).
//
//   node e2e.mjs <chromium binary> <dist dir> <screenshot dir>
//
// Needs a Chromium or Chrome for Testing build: branded Chrome no longer loads unpacked
// extensions from the command line. The extension is loaded with Extensions.loadUnpacked
// over --remote-debugging-pipe. It creates a throwaway wallet in a temporary profile,
// which is deleted afterwards.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, ext, out] = process.argv.slice(2);
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
        const ok = await page.eval(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (b) b.click(); return !!b; })()`);
        if (!ok) throw new Error(`no enabled button "${text}"; page: ${await page.eval("document.body.innerText")}`);
      },
      async fill(selector, index, value) {
        await page.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      },
      async shot(name) {
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
  await p.shot("1-welcome");
  await p.click("Create a new wallet");
  await p.waitText("Your recovery phrase");
  const words = await p.eval(`[...document.querySelectorAll(".words li")].map((li) => li.textContent)`);
  console.log("generated phrase has", words.length, "words");
  await p.shot("2-backup");
  await p.click("I wrote them down");
  await p.waitText("Check your backup");
  const asked = await p.eval(`[...document.querySelectorAll("label")].map((l) => parseInt(l.textContent.slice(5), 10))`);
  for (const [i, n] of asked.entries()) await p.fill("label input", i, words[n - 1]);
  await p.shot("3-confirm");
  await p.click("Continue");
  await p.waitText("Set a password");
  await p.fill("input[type=password]", 0, "correct horse battery staple");
  await p.fill("input[type=password]", 1, "correct horse battery staple");
  await p.click("Create wallet");
  await p.waitText("Account 1");
  await p.shot("4-home");
  const addrs = await p.eval(`[...document.querySelectorAll(".card code")].map((c) => c.textContent)`);
  console.log("addresses", addrs);

  // 2. Lock, wrong password, unlock.
  await p.click("Lock");
  await p.waitText("Unlock");
  await p.fill("input[type=password]", 0, "wrong password!");
  await p.click("Unlock");
  await p.waitText("Wrong password.");
  await p.shot("5-wrong-password");
  await p.fill("input[type=password]", 0, "correct horse battery staple");
  await p.click("Unlock");
  await p.waitText("Account 1");

  // 3. A fresh page while unlocked goes straight home (the unlock key is in session storage).
  await p.close();
  p = await openPopup();
  await p.waitText("Account 1");
  const again = await p.eval(`[...document.querySelectorAll(".card code")].map((c) => c.textContent)`);
  if (JSON.stringify(again) !== JSON.stringify(addrs)) throw new Error("addresses changed after reopening");
  console.log("reopened: still unlocked, same addresses");

  // 4. A web page can't talk to the service worker: there is no externally_connectable, so
  // chrome.runtime isn't even exposed to it.
  const { targetId: webId } = await send("Target.createTarget", { url: "data:text/html,<p>web page</p>" });
  const { sessionId: web } = await send("Target.attachToTarget", { targetId: webId, flatten: true });
  const exposed = await send("Runtime.evaluate", { expression: `typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage`, returnByValue: true }, web);
  console.log("web page sees chrome.runtime.sendMessage:", exposed.result.value);
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors, exceptions or CSP violations");
process.exit(problems.length ? 1 : 0);
