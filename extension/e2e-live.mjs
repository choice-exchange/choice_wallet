// A real send on Injective testnet, through the extension in a real browser: import a
// funded throwaway wallet, switch to testnet, send to `recipient`, approve the review, and
// wait for the block. Then check the result on chain, apart from the extension.
//
//   node e2e-live.mjs <chromium binary> <dist dir> <screenshot dir> <phrase file> <recipient> <amount> [token contract]
//
// With a token contract, the wallet adds it by contract. An ERC20 with no bank denom (0x…):
// it sends `amount` of it on the EVM side. A CW20 (inj1…): it sends `amount` of it, converts
// `amount` into the bank form through the CW20 adapter, and converts all of that back.
// With `site` in its place, a local test site does it instead, through the wallet's
// provider: connect, eth_sendTransaction of `amount` INJ, then window.choice signDirect of a
// bank send of `amount` INJ, broadcast with sendTx. With `activity`, it sends nothing: it
// opens Activity and prints what testnet's endpoints and Blockscout say the account did,
// which must include an EVM transaction. Otherwise it sends `amount` INJ.
//
// The phrase is read from the file and typed into the import screen. It is never printed
// and that screen is never captured. The browser profile, with the encrypted keystore in
// it, is deleted at the end. Testnet only: the script switches the wallet to testnet and
// refuses to go on if the review isn't for Injective testnet.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [chrome, ext, out, phraseFile, recipient, amount, tokenContract] = process.argv.slice(2);
if (!amount) throw new Error("usage: node e2e-live.mjs <chromium> <dist> <shots> <phrase file> <recipient> <amount> [token contract]");
/** The test site. It builds its Cosmos tx by hand (protobuf), as a dapp's library would. */
const SITE_PAGE = `<!doctype html><title>Live test site</title><p>Live test site</p><script>
window.__wallets = [];
addEventListener("eip6963:announceProvider", (e) => { if (e.detail.info.rdns === "exchange.choice.wallet") window.__wallets.push(e.detail); });
dispatchEvent(new Event("eip6963:requestProvider"));
window.__ask = (method, params) => { window.__r = window.__wallets[0].provider.request({ method, params }).then((r) => ({ ok: r }), (e) => ({ code: e.code, message: e.message })); };
const enc = new TextEncoder();
const varint = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const cat = (...p) => Uint8Array.from(p.flatMap((x) => [...x]));
const bytes = (no, b) => cat(varint((no << 3) | 2), varint(b.length), b);
const str = (no, s) => bytes(no, enc.encode(s));
const uint = (no, n) => cat(varint(no << 3), varint(n));
const any = (t, v) => cat(str(1, t), bytes(2, v));
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
window.__signAndSend = async ({ from, to, amount, pubKey, accountNumber, sequence }) => {
  try {
    const coin = cat(str(1, "inj"), str(2, amount));
    const body = bytes(1, any("/cosmos.bank.v1beta1.MsgSend", cat(str(1, from), str(2, to), bytes(3, coin))));
    const pub = any("/injective.crypto.v1beta1.ethsecp256k1.PubKey", bytes(1, hex(pubKey)));
    const gas = 150000n;
    const fee = cat(bytes(1, cat(str(1, "inj"), str(2, (gas * 160000000n).toString()))), uint(2, gas));
    const authInfo = cat(bytes(1, cat(bytes(1, pub), bytes(2, bytes(1, uint(1, 1))), uint(3, sequence))), bytes(2, fee));
    const signer = window.choice.getOfflineSigner("injective-888");
    const { signature } = await signer.signDirect(from, { bodyBytes: body, authInfoBytes: authInfo, chainId: "injective-888", accountNumber: BigInt(accountNumber) });
    const sig = Uint8Array.from(atob(signature.signature), (c) => c.charCodeAt(0));
    const raw = cat(bytes(1, body), bytes(2, authInfo), bytes(3, sig));
    const h = await window.choice.sendTx("injective-888", raw, "sync");
    window.__sent = { hash: Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase() };
  } catch (e) {
    window.__sent = { error: String(e && e.message || e) };
  }
};
</script>`;

const LCD = "https://testnet.sentry.lcd.injective.network";
const EVM_RPC = "https://k8s.testnet.json-rpc.injective.network";
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
async function evmRpc(method, params) {
  const r = await (await fetch(EVM_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
/** Testnet's CW20 adapter (as in chain/src/networks.ts). */
const ADAPTER = "inj1hdvy6tl89llqy3ze8lv6mz5qh66sx9enn0jxg6";
const smart = async (contract, q) => (await lcd(`/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(Buffer.from(JSON.stringify(q)).toString("base64"))}`)).data;
const denomOf = async (addr, denom) => BigInt((await lcd(`/cosmos/bank/v1beta1/spendable_balances/${addr}`)).balances.find((c) => c.denom === denom)?.amount ?? "0");
const tokenOf = async (addr0x) => BigInt(await evmRpc("eth_call", [{ to: tokenContract, data: `0x70a08231${addr0x.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]));

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
  /** Wait for the sent screen to say the tx is in a block; its hash. */
  const landed = async () => {
    for (let n = 0; ; n += 500) {
      const t = await text();
      if (t.includes("It's in a block.")) break;
      if (t.includes("Failed") || t.includes("Not confirmed yet")) throw new Error(`did not land: ${t}`);
      if (n > 90000) throw new Error("timed out waiting for the block");
      await sleep(500);
    }
    return evalIn(`document.querySelector("[data-hash]").dataset.hash`);
  };
  /** A Cosmos tx from the chain, and the INJ fee it charged. */
  const cosmosTx = async (hash) => {
    const tx = (await lcd(`/cosmos/tx/v1beta1/txs/${hash}`)).tx_response;
    if (tx.code !== 0) throw new Error(`tx failed: ${tx.raw_log}`);
    return { tx, fee: BigInt(tx.tx.auth_info.fee.amount.find((c) => c.denom === "inj").amount) };
  };
  const openToken = (denom) => evalIn(`[...document.querySelectorAll(".token")].find((t) => t.title === ${JSON.stringify(denom)}).click()`);
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
  await waitText("Manage", 20000); // home with balances loaded
  const from = await evalIn(`document.querySelector("[aria-label='Copy address']").title`);
  const before = { from: await injOf(from), to: null };
  console.log("sender", from, "holds", before.from.toString(), "inj");
  await shot("live-1-home");

  if (tokenContract === "activity") {
    // 3a. Activity, read back from testnet's own endpoints and Blockscout.
    await click("Activity");
    let rows = [];
    for (let t = 0; t < 30000 && rows.length === 0; t += 500) {
      rows = await evalIn(`[...document.querySelectorAll(".activity")].map((r) => [r.title, r.innerText.replace(/\\s+/g, " ")])`);
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    for (const [hash, text] of rows) console.log(" ", hash.startsWith("0x") ? "EVM   " : "Cosmos", text);
    if (!rows.some(([hash]) => hash.startsWith("0x"))) throw new Error("no EVM transaction in Activity");
    if (await evalIn(`document.body.innerText.includes("Blockscout didn't answer")`)) throw new Error("Blockscout didn't answer");
    await shot("live-activity");
    console.log("LIVE ACTIVITY OK");
  } else if (tokenContract === "site") {
    // 3s. A site, served here on 127.0.0.1, through the provider and approval windows.
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/" ? 200 : 204, { "content-type": "text/html" });
      res.end(req.url === "/" ? SITE_PAGE : "");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { targetId: siteId } = await send("Target.createTarget", { url: `http://127.0.0.1:${server.address().port}/` });
      const site = (await send("Target.attachToTarget", { targetId: siteId, flatten: true })).sessionId;
      await send("Runtime.enable", {}, site);
      const onSite = async (expr) => {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, site);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      for (let n = 0; !(await onSite("typeof window.__ask === 'function' && window.__wallets.length > 0")); n += 200) {
        if (n > 10000) throw new Error("the site didn't find the wallet");
        await sleep(200);
      }
      const seen = new Set();
      /** Answer the next approval window: wait for `expect`, capture it, press `button`. */
      const approve = async (expect, button, name) => {
        let t;
        for (let n = 0; !t; n += 200) {
          if (n > 30000) throw new Error(`no approval window for "${expect}"`);
          t = (await send("Target.getTargets")).targetInfos.find((x) => x.url.includes("popup.html?approve=") && !seen.has(x.targetId));
          if (!t) await sleep(200);
        }
        seen.add(t.targetId);
        const w = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
        await send("Runtime.enable", {}, w);
        await send("Emulation.setFocusEmulationEnabled", { enabled: true }, w);
        await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 600, deviceScaleFactor: 2, mobile: false }, w);
        const inW = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, w)).result.value;
        for (let n = 0; !(await inW(`document.body.innerText.includes(${JSON.stringify(expect)})`)); n += 200) {
          if (n > 30000) throw new Error(`approval window never said "${expect}": ${await inW("document.body.innerText")}`);
          await sleep(200);
        }
        const body = await inW("document.body.innerText");
        await sleep(900); // the buttons wake after 800 ms in front
        const { data } = await send("Page.captureScreenshot", { format: "png" }, w);
        writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
        for (let n = 0; !(await inW(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(button)} && !b.disabled); if (b) b.click(); return !!b; })()`)); n += 200) {
          if (n > 10000) throw new Error(`no enabled "${button}" in the approval window: ${await inW("document.body.innerText")}`);
          await sleep(200);
        }
        return body;
      };
      const ask = (method, params) => onSite(`window.__ask(${JSON.stringify(method)}, ${JSON.stringify(params ?? [])})`);
      const reply = async () => {
        const r = await onSite("window.__r");
        if (r.code !== undefined) throw new Error(`the site got an error: ${r.code} ${r.message}`);
        return r.ok;
      };

      // Connect.
      await ask("eth_requestAccounts");
      await approve("wants to connect", "Connect", "live-s1-connect");
      const [me] = await reply();
      if ((await onSite("window.__wallets[0].provider.request({ method: 'eth_chainId' })")) !== "0x59f") throw new Error("not on testnet");

      // eth_sendTransaction: `amount` INJ to the recipient's 0x form.
      const to = `0x${bech32Bytes(recipient)}`;
      const wei = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n;
      const before = { me: BigInt(await evmRpc("eth_getBalance", [me, "latest"])), to: BigInt(await evmRpc("eth_getBalance", [to, "latest"])) };
      await ask("eth_sendTransaction", [{ from: me, to, value: `0x${wei.toString(16)}` }]);
      const evmReview = await approve("Estimated on", "Confirm", "live-s2-evm-tx");
      if (!evmReview.includes("Injective testnet (EVM)")) throw new Error("the review isn't for testnet's EVM side");
      const hash = await reply();
      let receipt = null;
      for (let n = 0; !receipt; n += 1000) {
        if (n > 60000) throw new Error("no receipt");
        receipt = await evmRpc("eth_getTransactionReceipt", [hash]);
        if (!receipt) await sleep(1000);
      }
      const tx = await evmRpc("eth_getTransactionByHash", [hash]);
      const after = { me: BigInt(await evmRpc("eth_getBalance", [me, "latest"])), to: BigInt(await evmRpc("eth_getBalance", [to, "latest"])) };
      const fee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
      console.log(`site eth_sendTransaction ${hash}: status ${receipt.status}, gas ${BigInt(receipt.gasUsed)}/${BigInt(tx.gas)}; recipient +${after.to - before.to}, sender -${before.me - after.me} (= ${wei} + fee ${fee}?)`);
      if (receipt.status !== "0x1" || after.to - before.to !== wei) throw new Error("the site's EVM send didn't land as asked");
      if (before.me - after.me !== wei + fee && before.me - after.me !== wei + BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) throw new Error("the sender paid an unexpected amount");

      // window.choice: a bank send the site builds, signs through the wallet and broadcasts.
      await onSite(`window.choice.enable("injective-888")`);
      const key = await onSite(`window.choice.getKey("injective-888").then((k) => ({ address: k.bech32Address, pubKey: Array.from(k.pubKey, (b) => b.toString(16).padStart(2, "0")).join("") }))`);
      const acct = (await lcd(`/cosmos/auth/v1beta1/accounts/${key.address}`)).account;
      const base = acct.base_account ?? acct;
      const bankBefore = { me: await injOf(key.address), to: await injOf(recipient) };
      // Started, not awaited: it waits for the approval below.
      await onSite(`(window.__signAndSend(${JSON.stringify({ from: key.address, to: recipient, amount: wei.toString(), pubKey: key.pubKey, accountNumber: base.account_number, sequence: base.sequence ?? "0" })}), true)`);
      const cosmosReview = await approve("Simulated on", "Sign", "live-s3-sign-direct");
      if (!cosmosReview.includes("Simulated")) throw new Error("the Cosmos review has no simulation");
      let sent;
      for (let n = 0; !(sent = await onSite("window.__sent")); n += 300) {
        if (n > 30000) throw new Error("signDirect and sendTx never finished");
        await sleep(300);
      }
      if (sent.error) throw new Error(`the site's Cosmos send failed: ${sent.error}`);
      let ctx = null;
      for (let n = 0; !ctx; n += 1000) {
        if (n > 60000) throw new Error("the Cosmos tx never landed");
        const r = await fetch(`${LCD}/cosmos/tx/v1beta1/txs/${sent.hash}`);
        if (r.status === 200) ctx = (await r.json()).tx_response;
        else await sleep(1000);
      }
      const bankAfter = { me: await injOf(key.address), to: await injOf(recipient) };
      const cfee = BigInt(ctx.tx.auth_info.fee.amount.find((c) => c.denom === "inj").amount);
      console.log(`site signDirect + sendTx ${sent.hash}: code ${ctx.code}, gas ${ctx.gas_used}/${ctx.gas_wanted}; recipient +${bankAfter.to - bankBefore.to}, sender -${bankBefore.me - bankAfter.me} (= ${wei} + fee ${cfee}?)`);
      if (ctx.code !== 0 || bankAfter.to - bankBefore.to !== wei || bankBefore.me - bankAfter.me !== wei + cfee) throw new Error("the site's Cosmos send didn't land as asked");
      console.log("LIVE SITE OK");
    } finally {
      server.close();
    }
  } else if (tokenContract?.startsWith("inj1")) {
    // 3c. A CW20: add it by contract, send some from its screen, convert some into its bank
    // form and all of that back. The chain's own numbers after each step.
    const cw = tokenContract;
    const bank = `factory/${ADAPTER}/${cw}`;
    const { decimals, symbol } = await smart(cw, { token_info: {} });
    const cwOf = async (a) => BigInt((await smart(cw, { balance: { address: a } })).balance);
    const [whole, frac = ""] = amount.split(".");
    const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
    await click("Manage");
    await waitText("Hidden tokens stay in your account.");
    await click("Add a token by contract");
    await fill('input[aria-label="Token contract"]', 0, cw);
    await click("Add");
    await waitText(`CW20 · ${cw.slice(0, 8)}…${cw.slice(-4)}`, 20000);
    await click("Back");
    await waitText(symbol);
    await openToken(`cw20:${cw}`);
    await waitText("Convert to bank token");
    await shot("live-c1-token");

    // Send.
    await click("Send");
    await waitText("Balance");
    await fill('input[placeholder^="inj1"]', 0, recipient);
    await fill("input[inputmode=decimal]", 0, amount);
    await click("Review");
    await waitText("Review send", 30000);
    let review = await text();
    if (!review.includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    if (!review.includes(`CW20 ${cw}`)) throw new Error("the review doesn't name the CW20 contract");
    const to = (await evalIn(`document.querySelector(".recipient").textContent`)).trim();
    let before = { from: await cwOf(from), to: await cwOf(to), inj: await injOf(from) };
    await shot("live-c2-review-send");
    await click("Confirm and send");
    let hash = await landed();
    await shot("live-c3-sent");
    let { tx, fee } = await cosmosTx(hash);
    let after = { from: await cwOf(from), to: await cwOf(to), inj: await injOf(from) };
    console.log(`send ${hash}: height ${tx.height}, gas ${tx.gas_used}/${tx.gas_wanted}, fee ${fee} inj; recipient +${after.to - before.to}, sender -${before.from - after.from} (expected ${units})`);
    if (after.to - before.to !== units || before.from - after.from !== units) throw new Error("CW20 balances moved by the wrong amount");
    if (before.inj - after.inj !== fee) throw new Error("the sender paid more INJ than the fee");
    await click("Done");
    await waitText("Account 1");

    // Convert `amount` into the bank form.
    await openToken(`cw20:${cw}`);
    await click("Convert to bank token");
    await waitText(`You get the same amount of ${symbol}`);
    await fill("input[inputmode=decimal]", 0, amount);
    await click("Review");
    await waitText("Review conversion", 30000);
    review = await text();
    if (!review.includes("Same token, other form, one for one.")) throw new Error("not a conversion review");
    await shot("live-c4-review-convert");
    before = { cw: await cwOf(from), bank: await denomOf(from, bank), inj: await injOf(from) };
    await click("Confirm and convert");
    hash = await landed();
    await shot("live-c5-converted");
    ({ tx, fee } = await cosmosTx(hash));
    after = { cw: await cwOf(from), bank: await denomOf(from, bank), inj: await injOf(from) };
    console.log(`to bank ${hash}: height ${tx.height}, gas ${tx.gas_used}/${tx.gas_wanted}, fee ${fee} inj; CW20 -${before.cw - after.cw}, bank form +${after.bank - before.bank} (expected ${units})`);
    if (before.cw - after.cw !== units || after.bank - before.bank !== units) throw new Error("the conversion moved the wrong amounts");
    if (before.inj - after.inj !== fee) throw new Error("the conversion cost more INJ than the fee");
    await click("Done");
    await waitText("Account 1");

    // And all of the bank form back: it's on the home list (the wallet shows what it made).
    for (let n = 0; !(await evalIn(`[...document.querySelectorAll(".token")].some((t) => t.title === ${JSON.stringify(bank)})`)); n += 300) {
      if (n > 20000) throw new Error("the bank form isn't on the home list after converting");
      await sleep(300);
    }
    await shot("live-c5b-home-both-forms");
    await openToken(bank);
    await click("Convert to CW20");
    await click("Max");
    await click("Review");
    await waitText("Review conversion", 30000);
    before = { cw: await cwOf(from), bank: await denomOf(from, bank), inj: await injOf(from) };
    await shot("live-c6-review-back");
    await click("Confirm and convert");
    hash = await landed();
    ({ tx, fee } = await cosmosTx(hash));
    after = { cw: await cwOf(from), bank: await denomOf(from, bank), inj: await injOf(from) };
    console.log(`to CW20 ${hash}: height ${tx.height}, gas ${tx.gas_used}/${tx.gas_wanted}, fee ${fee} inj; bank form -${before.bank - after.bank}, CW20 +${after.cw - before.cw}`);
    if (after.bank !== 0n || after.cw - before.cw !== before.bank) throw new Error("converting back moved the wrong amounts");
    if (before.inj - after.inj !== fee) throw new Error("converting back cost more INJ than the fee");
    console.log("LIVE CW20 SEND AND CONVERSIONS OK");
  } else if (tokenContract) {
    // 3t. Add the token by contract, send it from its row, and check the chain.
    await click("Manage");
    await waitText("Hidden tokens stay in your account.");
    await click("Add a token by contract");
    await fill('input[aria-label="Token contract"]', 0, tokenContract);
    await click("Add");
    await waitText(`EVM · ${tokenContract.slice(0, 6).toLowerCase()}…${tokenContract.slice(-4).toLowerCase()}`, 20000);
    await click("Back");
    const symbol = await evalIn(`[...document.querySelectorAll(".token")].find((t) => t.title === "evm:${tokenContract.toLowerCase()}")?.querySelector(".symbol")?.textContent`);
    if (!symbol) throw new Error("the added token isn't on the home list");
    // The sender's 0x address, from Receive, before the send starts.
    await click("Receive");
    await waitText("Both addresses are the same account.");
    await click("EVM (0x)");
    const sender = (await evalIn(`document.querySelector(".address").textContent`)).trim();
    await click("Back");
    await waitText("Account 1");
    await evalIn(`[...document.querySelectorAll(".token")].find((t) => t.title === "evm:${tokenContract.toLowerCase()}").click()`);
    await waitText("Balance");
    await fill('input[placeholder^="inj1"]', 0, recipient);
    await fill("input[inputmode=decimal]", 0, amount);
    await click("Review");
    await waitText("Review send", 30000);
    const review = await text();
    if (!review.includes("Injective testnet (EVM)")) throw new Error("the review is not for Injective testnet's EVM side; stopping");
    const to = (await evalIn(`document.querySelector(".recipient").textContent`)).trim();
    const before = { from: await tokenOf(sender), to: await tokenOf(to), inj: BigInt(await evmRpc("eth_getBalance", [sender, "latest"])) };
    console.log("review: to", to, "| from", sender, "| fee", review.split("\n")[review.split("\n").indexOf("Network fee") + 1], "| estimated on", review.split("\n")[review.split("\n").indexOf("Estimated on") + 1]);
    await shot("live-t2-review");
    await click("Confirm and send");
    for (let n = 0; ; n += 500) {
      const t = await text();
      if (t.includes("It's in a block.")) break;
      if (t.includes("Failed") || t.includes("Not confirmed yet")) throw new Error(`send did not land: ${t}`);
      if (n > 90000) throw new Error("timed out waiting for the block");
      await sleep(500);
    }
    const hash = await evalIn(`document.querySelector("[data-hash]").dataset.hash`);
    await shot("live-t3-sent");
    const receipt = await evmRpc("eth_getTransactionReceipt", [hash]);
    const sent = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n;
    const after = { from: await tokenOf(sender), to: await tokenOf(to), inj: BigInt(await evmRpc("eth_getBalance", [sender, "latest"])) };
    const tx = await evmRpc("eth_getTransactionByHash", [hash]);
    // Injective EVM charges gas limit × max fee per gas (what the review showed); a chain
    // that refunds charges gas used × effective price.
    const shownFee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
    const usedFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    const fee = before.inj - after.inj;
    console.log(`tx ${hash}: status ${receipt.status}, block ${BigInt(receipt.blockNumber)}, gas ${BigInt(receipt.gasUsed)}, fee ${fee} inj`);
    console.log(`recipient +${after.to - before.to} ${symbol} (expected ${sent}); sender -${before.from - after.from} ${symbol}; sender INJ -${before.inj - after.inj} (fee ${fee})`);
    if (receipt.status !== "0x1") throw new Error("the transaction reverted");
    if (after.to - before.to !== sent || before.from - after.from !== sent) throw new Error("token balances moved by the wrong amount");
    if (fee !== shownFee && fee !== usedFee) throw new Error(`the sender paid ${fee} INJ base units, neither the shown fee ${shownFee} nor gas used × price ${usedFee}`);
    console.log(fee === shownFee ? "fee charged = the fee the review showed (gas limit × max fee)" : "fee charged = gas used × price (below the fee shown)");
    console.log("LIVE TOKEN SEND OK");
  } else {
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
  }
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
if (problems.length) {
  console.log("PROBLEMS:\n" + problems.join("\n"));
  process.exit(1);
}

/** The bytes behind a bech32 address, hex (the checksum is the chain's to check). */
function bech32Bytes(addr) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = addr.slice(addr.lastIndexOf("1") + 1, -6).split("").map((c) => CHARSET.indexOf(c));
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out.map((b) => b.toString(16).padStart(2, "0")).join("");
}
