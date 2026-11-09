// The extension's icons (extension/public/icons): the Choice mark on the wallet's dark ground,
// at 16, 32, 48 and 128 px, drawn by headless Chromium (no image tools needed).
//
//   node tools/icons/render.mjs <chromium> ui/src/assets/choice-mark.svg extension/public/icons "#08090b"
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [chrome, svgPath, outDir, ground] = process.argv.slice(2);
const svg = readFileSync(svgPath, "utf8");
const profile = mkdtempSync(join(tmpdir(), "icon-"));
const proc = spawn(chrome, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let id = 1; const pend = new Map(); let buf = "";
proc.stdio[4].on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\0")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); proc.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + "\0"); });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
for (const size of [16, 32, 48, 128]) {
  await send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  const pad = Math.round(size * 0.16);
  const radius = Math.round(size * 0.22);
  const html = `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${ground};display:flex;align-items:center;justify-content:center">${svg.replace("<svg ", `<svg style="width:${size - 2 * pad}px;height:${size - 2 * pad}px" `)}</div></body></html>`;
  await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html).toString("base64") }, sessionId);
  await new Promise((r) => setTimeout(r, 300));
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } }, sessionId);
  writeFileSync(join(outDir, `icon-${size}.png`), Buffer.from(data, "base64"));
}
proc.kill();
await new Promise((r) => setTimeout(r, 500));
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log("ok");
