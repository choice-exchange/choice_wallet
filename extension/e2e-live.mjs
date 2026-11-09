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
// which must include an EVM transaction. With `staking` (recipient ignored), it stakes
// `amount` INJ with the top validator, unstakes half, cancels that, moves the stake to
// another validator, claims rewards, and reads Activity back; each step checked on chain.
// With `approvals` (recipient ignored), a site grants a keyless address three permissions,
// and the Approvals screen takes them back along with the account's ERC20 allowances.
// With `nfts`, it lists the account's test NFT collections and sends one CW721 and one
// ERC721 to the recipient. With `rescue`, it sets a second account as the rescue address,
// empties this account's INJ into it, gives gas from it, rescues everything else to it
// (stakes unstaked) on that gas and checks the chain; the INJ goes back at the end. Otherwise it sends `amount` INJ.
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
// Canonical protobuf leaves an empty field out.
const any = (t, v) => (v.length ? cat(str(1, t), bytes(2, v)) : str(1, t));
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
window.__signAndSend = async ({ from, to, amount, pubKey, accountNumber, sequence, grants }) => {
  try {
    const coin = cat(str(1, "inj"), str(2, amount ?? "0"));
    // grants: a generic MsgSend grant, a fee allowance with no limit, and the rewards address,
    // all to \`to\`.
    const body = grants
      ? cat(
          bytes(1, any("/cosmos.authz.v1beta1.MsgGrant", cat(str(1, from), str(2, to), bytes(3, bytes(1, any("/cosmos.authz.v1beta1.GenericAuthorization", str(1, "/cosmos.bank.v1beta1.MsgSend"))))))),
          bytes(1, any("/cosmos.feegrant.v1beta1.MsgGrantAllowance", cat(str(1, from), str(2, to), bytes(3, any("/cosmos.feegrant.v1beta1.BasicAllowance", new Uint8Array(0)))))),
          bytes(1, any("/cosmos.distribution.v1beta1.MsgSetWithdrawAddress", cat(str(1, from), str(2, to)))),
        )
      : bytes(1, any("/cosmos.bank.v1beta1.MsgSend", cat(str(1, from), str(2, to), bytes(3, coin))));
    const pub = any("/injective.crypto.v1beta1.ethsecp256k1.PubKey", bytes(1, hex(pubKey)));
    const gas = grants ? 400000n : 150000n;
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

/** The 20 (or 32) bytes of a bech32 address. */
function bech32Words(addr) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = addr.slice(addr.lastIndexOf("1") + 1, -6).split("").map((c) => CHARSET.indexOf(c));
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

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
    throw new Error(`timed out waiting for "${t}"; page: ${(await text()).slice(-600)}`);
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

  /** The test site, served on 127.0.0.1 in a tab, and a way to answer the wallet's approval
   *  windows (`expect` to see, `button` to press, `typed` into the window's word field). */
  const startSite = async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/" ? 200 : 204, { "content-type": "text/html" });
      res.end(req.url === "/" ? SITE_PAGE : "");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
    const approve = async (expect, button, name, typed) => {
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
      if (typed) {
        await inW(`(() => { const el = document.querySelector("label.field input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(typed)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      }
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
    return { server, onSite, approve, ask, reply };
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

  if (tokenContract === "staking") {
    // 3k. Staking through the Staking screen; each step checked on chain.
    const sent = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n;
    const stakes = async () => new Map((await lcd(`/cosmos/staking/v1beta1/delegations/${from}`)).delegation_responses.map((d) => [d.delegation.validator_address, BigInt(d.balance.amount)]));
    const unbonding = async (v) => (await lcd(`/cosmos/staking/v1beta1/delegators/${from}/unbonding_delegations`)).unbonding_responses.filter((u) => u.validator_address === v).flatMap((u) => u.entries);
    const near = (a, b) => (a > b ? a - b : b - a) <= 1000n; // share rounding
    const openStaking = async () => {
      for (let n = 0; n < 30000; n += 300) {
        const ok = await evalIn(`(() => { const b = [...document.querySelectorAll(".token")].find((t) => /^Stake(d)? INJ$/.test(t.querySelector(".symbol")?.textContent ?? "")); if (b) b.click(); return !!b; })()`);
        if (ok) return waitText("Unstaking takes");
        await sleep(300);
      }
      throw new Error("no Staking row on the home screen");
    };
    /** Click the first element matching `selector` once it shows (the summary refreshes). */
    const clickWhen = async (selector) => {
      for (let n = 0; n < 30000; n += 300) {
        if (await evalIn(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e) e.click(); return !!e; })()`)) return;
        await sleep(300);
      }
      throw new Error(`nothing matches ${selector}`);
    };
    /** Review (testnet, the words expected), confirm, wait for the block; the chain's tx. */
    const confirmStaking = async (words, shotName) => {
      await waitText("Review staking", 30000);
      const t = await text();
      if (!t.includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
      for (const w of words) if (!t.includes(w)) throw new Error(`the review doesn't say "${w}": ${t}`);
      await shot(shotName);
      await click("Confirm");
      const hash = await landed();
      const { tx } = await cosmosTx(hash);
      await click("Done");
      await waitText("Manage", 20000);
      return { hash, msgs: tx.tx.body.messages };
    };

    await openStaking();
    await shot("live-k1-staking");
    await click("Stake");
    await waitText("Pick a validator");
    const [val, moniker] = await evalIn(`[document.querySelector(".token").title, document.querySelector(".token .symbol").textContent]`);
    console.log("staking with", moniker, val);
    await evalIn(`document.querySelector(".token").click()`);
    await fill("input[inputmode=decimal]", 0, amount);
    await click("Review");
    const before0 = (await stakes()).get(val) ?? 0n;
    const staked = await confirmStaking(["YOU STAKE", moniker, "Unstaking it later takes the unbonding period."], "live-k2-review-stake");
    const m0 = staked.msgs[0];
    if (m0["@type"] !== "/cosmos.staking.v1beta1.MsgDelegate" || m0.validator_address !== val || m0.amount.amount !== sent.toString()) throw new Error(`not the reviewed stake: ${JSON.stringify(m0)}`);
    const after0 = (await stakes()).get(val) ?? 0n;
    if (!near(after0 - before0, sent)) throw new Error(`stake moved by ${after0 - before0}, expected ${sent}`);
    console.log("staked", staked.hash, `+${after0 - before0}`);

    // Unstake half.
    const half = sent / 2n;
    await openStaking();
    await clickWhen(`.token[title="${val}"]`);
    await waitText("Move to another validator");
    await click("Unstake");
    await fill("input[inputmode=decimal]", 0, (Number(half) / 1e18).toString());
    await click("Review");
    const entriesBefore = (await unbonding(val)).length;
    const unstaked = await confirmStaking(["YOU UNSTAKE", moniker, "Starts unstaking"], "live-k3-review-unstake");
    if (unstaked.msgs[0]["@type"] !== "/cosmos.staking.v1beta1.MsgUndelegate") throw new Error("not an undelegation");
    const entries = await unbonding(val);
    if (entries.length !== entriesBefore + 1) throw new Error("no new unbonding entry");
    console.log("unstaked", unstaked.hash, "entry until", entries[entries.length - 1].completion_time);

    // Cancel that unstaking: it is staked again.
    await openStaking();
    await waitText("UNSTAKING", 30000);
    const height = entries[entries.length - 1].creation_height;
    await shot("live-k4-unstaking");
    await evalIn(`[...document.querySelectorAll(".token")].find((t) => t.innerText.includes("${moniker}") && t.querySelector(".pill")).querySelector(".pill").click()`);
    const cancelled = await confirmStaking(["YOU STAKE AGAIN", moniker], "live-k5-review-cancel");
    const c0 = cancelled.msgs[0];
    if (c0["@type"] !== "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation") throw new Error("not a cancellation");
    console.log("cancelled", cancelled.hash, "entry from height", c0.creation_height, "(newest was", height + ")");
    if ((await unbonding(val)).some((e) => e.creation_height === c0.creation_height)) throw new Error("the entry is still unbonding");

    // Move all of it to another validator.
    await openStaking();
    await clickWhen(`.token[title="${val}"]`);
    await waitText("Move to another validator");
    await click("Move to another validator");
    await waitText("Move to");
    const [dst, dstName] = await evalIn(`[document.querySelector(".token").title, document.querySelector(".token .symbol").textContent]`);
    await evalIn(`document.querySelector(".token").click()`);
    await click("Max");
    await click("Review");
    const moving = (await stakes()).get(val) ?? 0n;
    const dstBefore = (await stakes()).get(dst) ?? 0n;
    const moved = await confirmStaking(["YOU MOVE", moniker, dstName], "live-k6-review-move");
    const r0 = moved.msgs[0];
    if (r0["@type"] !== "/cosmos.staking.v1beta1.MsgBeginRedelegate" || r0.validator_dst_address !== dst || r0.amount.amount !== moving.toString()) throw new Error(`not the reviewed move: ${JSON.stringify(r0)}`);
    const now = await stakes();
    if (now.has(val) || !near((now.get(dst) ?? 0n) - dstBefore, moving)) throw new Error("the stake didn't move");
    console.log("moved", moved.hash, `${moving} to ${dstName}`);

    // Claim whatever has accrued.
    await openStaking();
    if (await evalIn(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Claim all" && !b.disabled)`)) {
      await click("Claim all");
      const claimed = await confirmStaking(["YOU CLAIM"], "live-k7-review-claim");
      if (!claimed.msgs.every((m) => m["@type"] === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward")) throw new Error("not reward claims");
      console.log("claimed", claimed.hash, `from ${claimed.msgs.length} validator(s)`);
    } else {
      console.log("no rewards to claim yet");
      await click("Back");
    }

    // Activity, from testnet's endpoints: the staking rows, by validator name.
    await click("Activity");
    let rows = [];
    for (let t = 0; t < 30000 && rows.length < 4; t += 500) {
      rows = await evalIn(`[...document.querySelectorAll(".activity")].map((r) => r.innerText.replace(/\\s+/g, " "))`);
      if (rows.length < 4) await sleep(500);
    }
    for (const r of rows.slice(0, 6)) console.log("  ", r);
    for (const want of ["Staked", "Unstaked", "Stake moved"]) if (!rows.some((r) => r.startsWith(want))) throw new Error(`no "${want}" row in Activity`);
    if (!rows.some((r) => r.includes(`with ${moniker}`))) throw new Error("Activity doesn't name the validator");
    await shot("live-k8-activity");
    console.log("LIVE STAKING OK");
  } else if (tokenContract === "approvals") {
    // 3a. Approvals: a site has the wallet grant a keyless address (20 bytes of 0x44, which
    // no one holds a key for) a MsgSend grant, a fee allowance and the rewards; the
    // Approvals screen lists those and the account's real ERC20 allowances; "Revoke all" takes
    // the Cosmos side back in one transaction and each ERC20 is revoked on its own. The chain
    // is asked after each step.
    const KEYLESS = "inj1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfc6zmu";
    const grantsOf = async () => (await lcd(`/cosmos/authz/v1beta1/grants/granter/${from}`)).grants;
    const feesOf = async () => (await lcd(`/cosmos/feegrant/v1beta1/issued/${from}`)).allowances;
    const rewardsTo = async () => (await lcd(`/cosmos/distribution/v1beta1/delegators/${from}/withdraw_address`)).withdraw_address;
    const { server, onSite, approve, ask, reply } = await startSite();
    try {
      await ask("eth_requestAccounts");
      await approve("wants to connect", "Connect", "live-a1-connect");
      const [me0x] = await reply();
      await onSite(`window.choice.enable("injective-888")`);
      const key = await onSite(`window.choice.getKey("injective-888").then((k) => ({ address: k.bech32Address, pubKey: Array.from(k.pubKey, (b) => b.toString(16).padStart(2, "0")).join("") }))`);
      const acct = (await lcd(`/cosmos/auth/v1beta1/accounts/${key.address}`)).account;
      const base = acct.base_account ?? acct;
      await onSite(`(window.__signAndSend(${JSON.stringify({ from: key.address, to: KEYLESS, grants: true, pubKey: key.pubKey, accountNumber: base.account_number, sequence: base.sequence ?? "0" })}), true)`);
      const grantReview = await approve("Simulated on", "Sign", "live-a2-grant", "GRANT");
      if (!grantReview.includes("could send ALL your tokens")) throw new Error(`the grant wasn't shown as red: ${grantReview}`);
      let sent;
      for (let n = 0; !(sent = await onSite("window.__sent")); n += 300) {
        if (n > 30000) throw new Error("the grants never went out");
        await sleep(300);
      }
      if (sent.error) throw new Error(`the grants failed: ${sent.error}`);
      for (let n = 0; (await grantsOf()).length === 0 || (await rewardsTo()) !== KEYLESS; n += 1000) {
        if (n > 60000) throw new Error("the grants never landed");
        await sleep(1000);
      }
      console.log("granted", sent.hash, "| grants", (await grantsOf()).length, "| fee allowances", (await feesOf()).length, "| rewards to", await rewardsTo());

      // The Approvals screen, in the popup.
      const openApprovals = async () => {
        await click("Settings");
        await waitText("Approvals and grants");
        await click("Approvals and grants");
        for (let n = 0; n < 60000; n += 300) {
          const t = await text();
          if (!t.includes("Approvals and grants") && (t.includes("PERMISSIONS") || t.includes("TOKEN ALLOWANCES") || t.includes("Nothing here"))) return t;
          await sleep(300);
        }
        throw new Error(`the Approvals screen didn't load: ${await text()}`);
      };
      let t = await openApprovals();
      for (const w of ["Your staking rewards go to", "Send your tokens", "Pays fees from your INJ"]) if (!t.includes(w)) throw new Error(`Approvals doesn't show "${w}": ${t}`);
      const erc20Rows = await evalIn(`[...document.querySelectorAll(".approval-row")].filter((r) => r.title.startsWith("evm:")).map((r) => [r.querySelector("button").getAttribute("aria-label"), r.title.slice(4)])`);
      console.log("approvals screen:", t.split("\n").filter((l) => l.trim()).slice(0, 14).join(" | "));
      await shot("live-a3-approvals");

      // Revoke all on the Cosmos side.
      const all = await evalIn(`[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((b) => /^Revoke all \\d+$/.test(b))`);
      await click(all);
      await waitText("Review revoke", 30000);
      const rv = await text();
      if (!rv.includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
      for (const w of ["YOU TAKE BACK", "Send your tokens", "Fee allowance", "Staking rewards come to this account again"]) if (!rv.includes(w)) throw new Error(`the revoke review doesn't say "${w}"`);
      await shot("live-a4-review-revoke");
      await click("Confirm");
      const revokeHash = await landed();
      const { tx: revokeTx } = await cosmosTx(revokeHash);
      console.log("revoked", revokeHash, revokeTx.tx.body.messages.map((m) => m["@type"].split(".").pop()).join(", "));
      if ((await grantsOf()).some((g) => g.grantee === KEYLESS)) throw new Error("a grant to the keyless address is still there");
      if ((await feesOf()).some((g) => g.grantee === KEYLESS)) throw new Error("the fee allowance is still there");
      if ((await rewardsTo()) !== from) throw new Error("rewards still go elsewhere");
      await click("Done");
      await waitText("Manage", 20000);

      // Each ERC20 allowance on its own.
      const allowanceOf = async (contract, spender) => BigInt(await evmRpc("eth_call", [{ to: contract, data: `0xdd62ed3e${me0x.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]));
      for (const [label, contract] of erc20Rows) {
        const [, token, spender] = /^Revoke (.+) allowance for (0x[0-9a-fA-F]{40})$/.exec(label);
        const before = await allowanceOf(contract, spender);
        await openApprovals();
        await evalIn(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
        await waitText("Review revoke", 30000);
        const er = await text();
        if (!er.includes("Injective testnet (EVM)") || !er.includes(`${token} allowance`)) throw new Error(`the ERC20 revoke review: ${er}`);
        await shot("live-a5-review-erc20");
        await click("Confirm");
        const h = await landed();
        await click("Done");
        await waitText("Manage", 20000);
        const after = await allowanceOf(contract, spender);
        console.log("revoked", token, contract, "allowance of", spender, `${before} -> ${after}`, h);
        if (after !== 0n) throw new Error("the allowance is still there on chain");
      }
      // Nothing left: the screen says so, and the chain agrees for every ERC20 it named.
      t = await openApprovals();
      await shot("live-a6-after");
      if (!t.includes("Nothing here")) throw new Error(`something is left: ${t}`);
      console.log("ERC20 rows revoked:", erc20Rows.length, "| owner", me0x);
      console.log("LIVE APPROVALS OK");
    } finally {
      server.close();
    }
  } else if (tokenContract === "contacts") {
    // 3a. The address book: a contact saved with a memo (the recipient given, or a keyless
    // address of 20 bytes of 0x44), picked in Send; the review names it and shows the memo;
    // without the memo it is red and nothing is sent; with it, the chain has the memo.
    const to = recipient !== "-" ? recipient : "inj1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfc6zmu";
    const MEMO = "choice-wallet-live-memo";
    await click("Settings");
    await click("Address book");
    await waitText("Add contact");
    await click("Add contact");
    await fill('input[aria-label="Contact name"]', 0, "Live contact");
    await fill('input[aria-label="Contact address"]', 0, to);
    await fill('input[aria-label="Contact memo"]', 0, MEMO);
    await click("Save");
    await waitText(`memo ${MEMO}`);
    await shot("live-c1-address-book");
    await click("Back");
    await click("Wallet");
    await waitText("Manage", 20000);
    const send = async (memo) => {
      await click("Send");
      await waitText("Balance");
      await click("Contacts");
      await waitText("Live contact");
      await evalIn(`[...document.querySelectorAll(".token")].find((b) => b.textContent.includes("Live contact")).click()`);
      await waitText("Live contact, from your address book");
      await fill('input[aria-label="Memo"]', 0, memo);
      await fill("input[inputmode=decimal]", 0, amount);
      await click("Review");
      await waitText("Review send", 30000);
      if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    };
    await send("");
    await waitText(`Live contact needs memo ${MEMO}. This send has none.`);
    await shot("live-c2-review-no-memo");
    await click("Cancel");
    await click("Back");
    await waitText("Manage", 20000);
    await send(MEMO);
    await waitText("To Live contact from your address book.");
    await waitText(MEMO);
    await shot("live-c3-review");
    const before = await injOf(to);
    await click("Confirm and send");
    for (let n = 0; !(await text()).includes("It's in a block."); n += 500) {
      if (n > 90000) throw new Error("timed out waiting for the block");
      await sleep(500);
    }
    if (await evalIn(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Save address")`)) throw new Error("offered to save a saved contact");
    const hash = await evalIn(`document.querySelector("[data-hash]").dataset.hash`);
    await shot("live-c4-sent");
    const tx = (await lcd(`/cosmos/tx/v1beta1/txs/${hash}`)).tx_response;
    const got = (await injOf(to)) - before;
    console.log(`tx ${hash}: code ${tx.code}, height ${tx.height}, memo ${JSON.stringify(tx.tx.body.memo)}, recipient +${got} inj`);
    if (tx.code !== 0) throw new Error(`tx failed: ${tx.raw_log}`);
    if (tx.tx.body.memo !== MEMO) throw new Error("the chain has another memo");
    if (got !== BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n) throw new Error("the recipient got the wrong amount");
    console.log("LIVE CONTACTS OK");
  } else if (tokenContract === "inventory") {
    // 3a. Trading accounts: whatever is free in the account's orderbook trading accounts is
    // listed and moved back to the balance, checked on chain. Put some in first (a dev
    // script's MsgDeposit to trading account 1). `recipient` and `amount` are ignored.
    const me = await evalIn(`document.querySelector("[aria-label='Copy address']").title`);
    await evalIn(`[...document.querySelectorAll("button.token")].find((b) => b.textContent.includes("Trading and liquidity")).click()`);
    await waitText("Trading account", 60000);
    await shot("live-i1-inventory");
    const sub = await evalIn(`[...document.querySelectorAll(".well .mono")].map((e) => e.title).find((t) => /^0x[0-9a-f]{64}$/.test(t)) ?? ""`);
    const deposits = async () => (await lcd(`/injective/exchange/v2/exchange/subaccountDeposits?subaccount_id=${sub}`)).deposits ?? {};
    const before = { deposits: await deposits(), inj: await injOf(me) };
    console.log(`trading account ${sub}: ${JSON.stringify(before.deposits)}`);
    await click("Move to wallet");
    await waitText("Review move", 30000);
    if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    await shot("live-i2-review-move");
    await evalIn(`[...document.querySelectorAll("button")].find((b) => /^Confirm/.test(b.textContent.trim()) && !b.disabled).click()`);
    const hash = await landed();
    const { tx, fee } = await cosmosTx(hash);
    const after = { deposits: await deposits(), inj: await injOf(me) };
    const freed = BigInt((before.deposits.inj?.available_balance ?? "0").split(".")[0]);
    console.log(`move tx ${hash}: ${tx.tx.body.messages.map((m) => m["@type"]).join(", ")}; trading account now ${JSON.stringify(after.deposits)}; balance ${after.inj - before.inj} inj (moved ${freed}, fee ${fee})`);
    if (Object.values(after.deposits).some((d) => BigInt(String(d.available_balance).split(".")[0]) > 0n)) throw new Error("free coins were left in the trading account");
    if (after.inj - before.inj !== freed - fee) throw new Error("the balance didn't get exactly what left the trading account");
    console.log("LIVE INVENTORY OK");
  } else if (tokenContract === "rescue") {
    // 3a. The rescue address. A second account of the same phrase is the rescue address; all
    // of this account's INJ goes there first, so a rescue has to run on gas the rescue
    // account gave ahead of time. Then "Rescue now": the stake (at once), rewards, every bank
    // token, all to the rescue address, the fee paid by its allowance; each checked on chain.
    // At the end the rescue account sends the INJ back. `recipient` and `amount` are ignored.
    const me = await evalIn(`document.querySelector("[aria-label='Copy address']").title`);
    const name = (await evalIn(`document.querySelector(".account-switch").getAttribute("aria-label")`)).match(/^Account: (.+)\. Switch accounts$/)[1];
    await evalIn(`document.querySelector(".account-switch").click()`);
    await waitText("Accounts");
    await evalIn(`[...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Add an account to")).click()`);
    await waitText("Manage", 20000);
    const rescuer = await evalIn(`document.querySelector("[aria-label='Copy address']").title`);
    const rescuerName = (await evalIn(`document.querySelector(".account-switch").getAttribute("aria-label")`)).match(/^Account: (.+)\. Switch accounts$/)[1];
    console.log(`rescue address: ${rescuerName} ${rescuer}`);
    const switchTo = async (n) => {
      await evalIn(`document.querySelector(".account-switch").click()`);
      await waitText("Accounts");
      await evalIn(`[...document.querySelectorAll(".account-row")].find((b) => b.textContent.includes(${JSON.stringify(n)})).click()`);
      await waitText("Manage", 20000);
    };
    await switchTo(name);
    // All of this account's INJ to the rescue account: a thief took it. (Already gone if a
    // run before this one stopped part way.)
    if ((await injOf(me)) > 0n) {
    await click("Send");
    await waitText("Balance");
    await fill('input[placeholder^="inj1"]', 0, rescuer);
    await click("Max");
    await click("Review");
    await waitText("Review send", 30000);
    if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    await click("Confirm and send");
    await landed();
    await click("Done");
    await waitText("Manage", 20000);
    }
    const injLeft = await injOf(me);
    console.log(`after "the theft": ${injLeft} inj left`);

    // The rescue address, and gas from it.
    await click("Settings");
    await click("Rescue address");
    await waitText("If this account's key is ever lost or stolen");
    await evalIn(`[...document.querySelectorAll("button.token")].find((b) => b.textContent.includes(${JSON.stringify(rescuerName)})).click()`);
    await waitText("Gas for a rescue", 20000);
    await shot("live-r1-rescue-address");
    // Gas from the rescue account: given, or renewed if gas given before doesn't cover
    // every rescue message.
    const gasButton = await evalIn(`[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).find((t) => t === ${JSON.stringify(`Give gas from ${rescuerName}`)} || t === ${JSON.stringify(`Renew gas from ${rescuerName}`)}) ?? ""`);
    if (gasButton) {
      await click(gasButton);
      await waitText("Review gas", 30000);
      await waitText(`Lets your account ${name} pay its fees from this account`);
      await shot("live-r2-review-gas");
      await evalIn(`[...document.querySelectorAll("button")].find((b) => /^Confirm/.test(b.textContent.trim()) && !b.disabled).click()`);
      await landed();
    } else {
      await click("Back");
    }
    const grant = (await lcd(`/cosmos/feegrant/v1beta1/allowance/${rescuer}/${me}`)).allowance;
    console.log(`gas: ${JSON.stringify(grant?.allowance?.allowance?.spend_limit)} for ${grant?.allowance?.allowed_messages?.length} message types`);
    if (!grant || grant.allowance["@type"] !== "/cosmos.feegrant.v1beta1.AllowedMsgAllowance") throw new Error("no rescue allowance on chain");
    if (await evalIn(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Done")`)) await click("Done");

    // Rescue now.
    const before = {
      stake: (await lcd(`/cosmos/staking/v1beta1/delegations/${me}`)).delegation_responses ?? [],
      bank: (await lcd(`/cosmos/bank/v1beta1/spendable_balances/${me}`)).balances,
      rescuerStake: (await lcd(`/cosmos/staking/v1beta1/delegations/${rescuer}`)).delegation_responses ?? [],
    };
    console.log(`to rescue: stakes ${JSON.stringify(before.stake.map((d) => d.balance.amount))}, bank ${JSON.stringify(before.bank.map((c) => `${c.amount} ${c.denom.slice(0, 20)}`))}`);
    await click("Settings");
    await click("Rescue address");
    await waitText("Rescue now", 20000);
    await click("Rescue now");
    try {
      await waitText("Review rescue", 30000);
    } catch (e) {
      throw new Error(`no rescue review; page: ${await text()}`);
    }
    await waitText("Everything below goes to your rescue address.");
    if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    await shot("live-r3-review-rescue");
    await click("Confirm and send");
    const hash = await landed();
    await shot("live-r4-rescued");
    const { tx } = await cosmosTx(hash);
    const types = tx.tx.body.messages.map((m) => m["@type"].split(".").pop());
    console.log(`rescue tx ${hash}: ${types.join(", ")}; fee paid by ${tx.tx.auth_info.fee.granter || "the account"}`);
    if (tx.tx.auth_info.fee.granter !== rescuer) throw new Error("the rescue's fee wasn't paid by the rescue allowance");
    const after = {
      stake: (await lcd(`/cosmos/staking/v1beta1/delegations/${me}`)).delegation_responses ?? [],
      bank: (await lcd(`/cosmos/bank/v1beta1/spendable_balances/${me}`)).balances,
      withdraw: (await lcd(`/cosmos/distribution/v1beta1/delegators/${me}/withdraw_address`)).withdraw_address,
      rescuerStake: (await lcd(`/cosmos/staking/v1beta1/delegations/${rescuer}`)).delegation_responses ?? [],
    };
    const total = (l) => l.reduce((n, d) => n + BigInt(d.balance.amount), 0n);
    // Injective gives a stake away at once only to addresses governance lists; otherwise the
    // rescue unstakes it, and it shows as unbonding here.
    const movable = ((await lcd("/cosmos/staking/v1beta1/allowed_delegation_transfer_receivers")).addresses ?? []).includes(rescuer);
    const unbonding = ((await lcd(`/cosmos/staking/v1beta1/delegators/${me}/unbonding_delegations`)).unbonding_responses ?? []).flatMap((u) => u.entries).reduce((n, e) => n + BigInt(e.balance), 0n);
    console.log(`after: stakes left ${after.stake.length}, unbonding ${unbonding}, bank left ${JSON.stringify(after.bank)}, rewards go to ${after.withdraw}, rescue stake +${total(after.rescuerStake) - total(before.rescuerStake)}`);
    if (after.stake.length !== 0 || after.bank.length !== 0) throw new Error("something was left behind");
    if (after.withdraw !== rescuer) throw new Error("rewards don't go to the rescue address");
    if (movable ? total(after.rescuerStake) - total(before.rescuerStake) !== total(before.stake) : unbonding < total(before.stake)) throw new Error("the stake wasn't moved or unstaked whole");

    // Clean up: the rescue account sends the INJ back.
    await click("Done");
    await switchTo(rescuerName);
    await click("Send");
    await waitText("Balance");
    await fill('input[placeholder^="inj1"]', 0, me);
    await click("Max");
    await click("Review");
    await waitText("Review send", 30000);
    await click("Confirm and send");
    await landed();
    console.log(`INJ back: ${await injOf(me)}`);
    console.log("LIVE RESCUE OK");
  } else if (tokenContract === "nfts") {
    // 3a. NFTs: the account's CW721 (found from the tx index) and ERC721 (found through
    // Blockscout) test collections listed; one of each sent to the recipient (or a keyless
    // address, 0x44…44), each checked on chain with its contract. `amount` is ignored.
    const to = recipient !== "-" ? recipient : "inj1g3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyfc6zmu";
    const to0x = `0x${Buffer.from(bech32Words(to)).toString("hex")}`;
    const openNfts = async () => {
      await click("Wallet");
      await waitText("Manage", 20000);
      await evalIn(`[...document.querySelectorAll("button.token")].find((b) => b.textContent.includes("CW721 and ERC721")).click()`);
      // Collection names sit in upper-cased labels: look in the text, not as rendered.
      for (const name of ["Choice Wallet Test NFTs ·", "Choice Wallet Test EVM NFTs ·"]) {
        for (let n = 0; !(await evalIn(`document.body.textContent.includes(${JSON.stringify(name)})`)); n += 500) {
          if (n > 90000) throw new Error(`no collection ${name}; page: ${await text()}`);
          await sleep(500);
        }
      }
    };
    /** Open the first NFT of the collection named exactly `name`: its contract and ID. */
    const openFirst = async (name) => {
      const title = await evalIn(`(() => { const g = [...document.querySelectorAll(".wallet-group")].find((x) => x.querySelector(".eyebrow")?.textContent.startsWith(${JSON.stringify(name + " ·")})); const b = g?.querySelector("button.token"); if (b) b.click(); return b?.title ?? ""; })()`);
      const [contract, id] = title.split(" #");
      if (!contract || !id) throw new Error(`no NFT in ${name}`);
      return { contract, id };
    };
    await openNfts();
    await shot("live-n1-nfts");
    const cw = await openFirst("Choice Wallet Test NFTs");
    console.log(`CW721 ${cw.contract} #${cw.id}`);
    await waitText("Token ID");
    await shot("live-n2-nft");
    await fill('input[aria-label="Recipient"]', 0, to);
    await click("Review");
    await waitText("YOU SEND AN NFT", 30000);
    if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    await shot("live-n3-review-cw721");
    await click("Confirm and send");
    for (let n = 0; !(await text()).includes("It's in a block."); n += 500) {
      if (n > 90000) throw new Error("timed out waiting for the block");
      await sleep(500);
    }
    const cwOwner = (await smart(cw.contract, { owner_of: { token_id: cw.id } })).owner;
    console.log(`CW721 #${cw.id} owner now ${cwOwner}`);
    if (cwOwner !== to) throw new Error("the CW721 didn't reach the recipient");
    await click("Done");

    await openNfts();
    const evm = await openFirst("Choice Wallet Test EVM NFTs");
    console.log(`ERC721 ${evm.contract} #${evm.id}`);
    await waitText("Token ID");
    await fill('input[aria-label="Recipient"]', 0, to);
    await click("Review");
    await waitText("YOU SEND AN NFT", 30000);
    if (!(await text()).includes("Injective testnet")) throw new Error("the review is not for Injective testnet; stopping");
    await shot("live-n4-review-erc721");
    await click("Confirm and send");
    for (let n = 0; !(await text()).includes("It's in a block."); n += 1000) {
      if (n > 240000) throw new Error("timed out waiting for the receipt");
      await sleep(1000);
    }
    await shot("live-n5-sent");
    const evmOwner = `0x${(await evmRpc("eth_call", [{ to: evm.contract, data: `0x6352211e${BigInt(evm.id).toString(16).padStart(64, "0")}` }, "latest"])).slice(-40)}`;
    console.log(`ERC721 #${evm.id} owner now ${evmOwner}`);
    if (evmOwner.toLowerCase() !== to0x.toLowerCase()) throw new Error("the ERC721 didn't reach the recipient");
    console.log("LIVE NFTS OK");
  } else if (tokenContract === "swap") {
    // 3a. A swap through Choice on testnet, where only its router runs (Choice's own pools,
    // an ERC20 at both ends): a site wraps 0.01 INJ into wINJ through the wallet; testnet
    // USDT is added by contract; `amount` wINJ is swapped for USDT through the exact
    // approvals and the swap. The chain is asked after: wINJ down by exactly the amount,
    // USDT up by at least the minimum shown, and both allowances used up.
    const WINJ = "0x0000000088827d2d103ee2d9A6b781773AE03FfB";
    const USDT_T = "0xaDC7bcB5d8fe053Ef19b4E0C861c262Af6e0db60";
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const ROUTER = "0x6F82761E0103846E4F4588DB5B7A5505A2907B04";
    const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
    const balanceOf = async (token, who) => BigInt(await evmRpc("eth_call", [{ to: token, data: `0x70a08231${pad(who)}` }, "latest"]));
    const { server, onSite, approve, ask, reply } = await startSite();
    let me;
    try {
      await ask("eth_requestAccounts");
      await approve("wants to connect", "Connect", "live-w1-connect");
      [me] = await reply();
      const wrapped = await balanceOf(WINJ, me);
      await ask("eth_sendTransaction", [{ from: me, to: WINJ, value: `0x${(10n ** 16n).toString(16)}`, data: "0xd0e30db0" }]);
      await approve("Estimated on", "Confirm", "live-w2-wrap");
      const wrapHash = await reply();
      for (let n = 0; (await balanceOf(WINJ, me)) === wrapped; n += 1000) {
        if (n > 60000) throw new Error(`the wrap ${wrapHash} didn't land`);
        await sleep(1000);
      }
      console.log("wrapped 0.01 INJ into wINJ:", wrapHash);
    } finally {
      server.close();
    }
    const amountIn = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 12n;
    const before = { winj: await balanceOf(WINJ, me), usdt: await balanceOf(USDT_T, me) };

    await click("Manage");
    await click("Add a token by contract");
    await fill('input[aria-label="Token contract"]', 0, USDT_T);
    await click("Add");
    // The form closes once the token is added.
    for (let n = 0; await evalIn(`!!document.querySelector('input[aria-label="Token contract"]')`); n += 300) {
      if (n > 30000) throw new Error(`adding testnet USDT didn't finish: ${await text()}`);
      await sleep(300);
    }
    await click("Back");
    await waitText("Manage", 20000);
    // A token row by any of its names (testnet USDT has two bank denoms paired with it).
    const pick = async (...names) => {
      const want = JSON.stringify(names.map((x) => x.toLowerCase()));
      for (let n = 0; n < 30000; n += 300) {
        const hit = await evalIn(`(() => { const e = [...document.querySelectorAll(".token")].find((b) => ${want}.some((w) => (b.title || "").toLowerCase().includes(w))); if (e) e.click(); return !!e; })()`);
        if (hit) return;
        await sleep(300);
      }
      throw new Error(`no token row for ${address}`);
    };
    await click("Swap");
    await waitText("YOU PAY");
    await click("Choose the token to pay");
    await pick(WINJ);
    await click("Choose the token to get");
    await pick(USDT_T, "peggy0x87aB3B4C8661e07D6372361211B96ed4Dc36B1B5");
    await fill('input[aria-label="Amount to pay"]', 0, amount);
    await waitText("At least", 30000);
    const shownMin = (await text()).split("\n")[(await text()).split("\n").indexOf("At least") + 1] ?? "";
    await shot("live-w3-quote");
    const minimum = BigInt(Math.round(Number(shownMin.split(" ")[0]) * 1e6));
    console.log("quote: at least", shownMin);
    await evalIn(`[...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Review"))?.click()`);
    for (let step = 1; ; step++) {
      // The review's own cards, not the swap screen's "Review swap" button.
      for (let n = 0; !/YOU ALLOW|YOU SWAP/.test(await text()); n += 300) {
        if (n > 30000) throw new Error(`no review for step ${step}: ${await text()}`);
        await sleep(300);
      }
      const t = await text();
      if (!t.includes("Injective (EVM)") && !t.includes("Injective testnet (EVM)")) throw new Error("the review isn't for the EVM side");
      await shot(`live-w4-step${step}`);
      const swapping = t.includes("Review swap");
      console.log(`step ${step}:`, swapping ? "swap" : t.includes("TO TAKE THROUGH PERMIT2") ? "Permit2 approval" : "token approval");
      await click(swapping ? "Confirm swap" : "Approve");
      for (let n = 0; !(await text()).includes("It's in a block."); n += 500) {
        if (n > 90000 || /Failed|Not confirmed yet/.test(await text())) throw new Error(`step ${step} didn't land: ${await text()}`);
        await sleep(500);
      }
      if (swapping) break;
      await click("Next step");
    }
    await shot("live-w5-swapped");
    const after = { winj: await balanceOf(WINJ, me), usdt: await balanceOf(USDT_T, me) };
    const left = BigInt(await evmRpc("eth_call", [{ to: WINJ, data: `0xdd62ed3e${pad(me)}${pad(PERMIT2)}` }, "latest"]));
    const p2 = await evmRpc("eth_call", [{ to: PERMIT2, data: `0x927da105${pad(me)}${pad(WINJ)}${pad(ROUTER)}` }, "latest"]);
    const p2left = BigInt(`0x${p2.slice(2, 66)}`);
    console.log(`wINJ -${before.winj - after.winj} (asked ${amountIn}); USDT +${after.usdt - before.usdt} (at least ${minimum} shown); allowance to Permit2 now ${left}; Permit2 allowance to the router now ${p2left}`);
    if (before.winj - after.winj !== amountIn) throw new Error("wINJ moved by another amount");
    if (after.usdt - before.usdt < minimum || after.usdt === before.usdt) throw new Error("less USDT arrived than the minimum shown");
    if (left !== 0n || p2left !== 0n) throw new Error("an allowance is left over");
    console.log("LIVE SWAP OK");
  } else if (tokenContract === "activity") {
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
    const { server, onSite, approve, ask, reply } = await startSite();
    try {
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
