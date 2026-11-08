// A real send on Injective testnet, through the extension in a real browser: import a
// funded throwaway wallet, switch to testnet, send to `recipient`, approve the review, and
// wait for the block. Then check the result on chain, apart from the extension.
//
//   node e2e-live.mjs <chromium binary> <dist dir> <screenshot dir> <phrase file> <recipient> <amount INJ>
//
// The phrase is read from the file and typed into the import screen. It is never printed
// and that screen is never captured. The browser profile, with the encrypted keystore in
// it, is deleted at the end. Testnet only: the script switches the wallet to testnet and
// refuses to go on if the review isn't for Injective testnet.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, ext, out, phraseFile, recipient, amount] = process.argv.slice(2);
if (!amount) throw new Error("usage: node e2e-live.mjs <chromium> <dist> <shots> <phrase file> <recipient> <amount>");
const LCD = "https://testnet.sentry.lcd.injective.network";
const PASSWORD = "throwaway testnet password";

const profile = mkdtempSync(join(tmpdir(), "cw-live-"));
const proc = spawn(chrome, [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
let nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
let buf = "";
proc.stdio[4].on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
    if (m.method === "Runtime.exceptionThrown") problems.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push("log: " + m.params.entry.text);
  }
});

async function lcd(path) {
  const r = await fetch(`${LCD}${path}`);
  return r.json();
}
const injOf = async (addr) =>
  BigInt((await lcd(`/cosmos/bank/v1beta1/spendable_balances/${addr}`)).balances.find((c) => c.denom === "inj")?.amount ?? "0");

try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: ext });
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 600, deviceScaleFactor: 2, mobile: false }, sessionId);
  const evalIn = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const text = () => evalIn("document.body.innerText");
  const waitText = async (t, ms = 15000) => {
    for (let n = 0; n < ms; n += 200) {
      if ((await text()).includes(t)) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  const click = async (t) => {
    const ok = await evalIn(`(() => { const t = ${JSON.stringify(t)}; const b = [...document.querySelectorAll("button")].find((b) => (b.textContent.trim() === t || b.getAttribute("aria-label") === t) && !b.disabled); if (b) b.click(); return !!b; })()`);
    if (!ok) throw new Error(`no enabled button "${t}"`);
  };
  const fill = (selector, index, value) =>
    evalIn(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const shot = async (name) => {
    await sleep(250);
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  };

  // 1. Import (no screenshot: the phrase is on screen).
  await waitText("I have a recovery phrase");
  await click("I have a recovery phrase");
  await waitText("Import a recovery phrase");
  await fill("textarea", 0, readFileSync(phraseFile, "utf8").trim());
  await click("Continue");
  await fill("input[type=password]", 0, PASSWORD);
  await fill("input[type=password]", 1, PASSWORD);
  await click("Create wallet");
  await waitText("Account 1");

  // 2. Testnet, with its default endpoints.
  await click("Settings");
  await waitText("Tried in order, one per line.");
  await click("Testnet");
  await click("Save");
  await waitText("Testnet");
  await waitText("Injective", 20000);
  const from = await evalIn(`document.querySelector("[aria-label='Copy address']").title`);
  const before = { from: await injOf(from), to: null };
  console.log("sender", from, "holds", before.from.toString(), "inj");
  await shot("live-1-home");

  // 3. Send.
  await click("Send");
  await waitText("Balance");
  await fill('input[placeholder^="inj1"]', 0, recipient);
  await fill("input[inputmode=decimal]", 0, amount);
  await click("Review");
  await waitText("Review send", 30000);
  const review = await text();
  if (!review.includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
  const to = (await evalIn(`document.querySelector(".recipient").textContent`)).trim();
  before.to = await injOf(to);
  console.log("review: to", to, "| fee", review.split("\n")[review.split("\n").indexOf("Network fee") + 1], "| simulated on", review.split("\n")[review.split("\n").indexOf("Simulated on") + 1]);
  await shot("live-2-review");
  await click("Confirm and send");
  for (let n = 0; ; n += 500) {
    const t = await text();
    if (t.includes("It's in a block.")) break;
    if (t.includes("Failed") || t.includes("Not confirmed yet")) throw new Error(`send did not land: ${t}`);
    if (n > 90000) throw new Error("timed out waiting for the block");
    await sleep(500);
  }
  const hash = await evalIn(`document.querySelector("[data-hash]").dataset.hash`);
  await shot("live-3-sent");

  // 4. The chain's own account of it.
  const tx = (await lcd(`/cosmos/tx/v1beta1/txs/${hash}`)).tx_response;
  const after = { from: await injOf(from), to: await injOf(to) };
  const sent = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n;
  const fee = BigInt(tx.tx.auth_info.fee.amount.find((c) => c.denom === "inj").amount);
  console.log(`tx ${hash}: code ${tx.code}, height ${tx.height}, gas ${tx.gas_used}/${tx.gas_wanted}, fee ${fee} inj`);
  console.log(`recipient +${after.to - before.to} inj (expected ${sent}); sender -${before.from - after.from} inj (expected ${sent + fee})`);
  if (tx.code !== 0) throw new Error(`tx failed: ${tx.raw_log}`);
  if (after.to - before.to !== sent) throw new Error("recipient balance moved by the wrong amount");
  if (before.from - after.from !== sent + fee) throw new Error("sender balance moved by the wrong amount");
  console.log("LIVE SEND OK");
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
if (problems.length) {
  console.log("PROBLEMS:\n" + problems.join("\n"));
  process.exit(1);
}
