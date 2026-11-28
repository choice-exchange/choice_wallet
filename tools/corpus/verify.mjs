// Rebuilds, for each EIP-712 v2 transaction fetch.mjs saved, the typed data its signer's
// wallet signed, exactly as the chain rebuilds it (injective-core
// app/ante/eip712_cosmos.go WrapTxToEIP712V2), and keeps it only if the transaction's own
// signature recovers to the signer: then it is byte for byte what a dapp sent to
// eth_signTypedData_v4. Also reads the account numbers that amino transactions signed, for
// the vault's check of its amino JSON against the chain's signatures. PRIVATE output.
//
//   node tools/corpus/verify.mjs <private-dir>
import fs from "node:fs";
import path from "node:path";
import { hashTypedData, recoverAddress } from "../vectors/node_modules/viem/_esm/index.js";
import { EVM_TX, bech32Encode, ethAddressOfKey, parseTx } from "./tx.mjs";

const LCD = "https://sentry.lcd.injective.network";
const dir = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status >= 502) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

const cacheFile = path.join(dir, "lcd-cache.json");
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
async function cached(url) {
  if (!(url in cache)) {
    cache[url] = await get(url);
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    await sleep(150);
  }
  return cache[url];
}

/** Go's encoding/json string escaping on top of JSON.stringify's: <, >, &, U+2028, U+2029. */
const goJson = (v) =>
  JSON.stringify(v)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");

const TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "string" },
  ],
  Tx: [
    { name: "context", type: "string" },
    { name: "msgs", type: "string" },
  ],
};

async function accountNumber(addr) {
  const a = await cached(`${LCD}/cosmos/auth/v1beta1/accounts/${addr}`);
  const n = a.account?.base_account?.account_number ?? a.account?.account_number;
  return n === undefined ? null : BigInt(n);
}

const out = { eip712_v2: {}, amino: {} };
let ok = 0;
let bad = 0;
for (const f of fs.readdirSync(path.join(dir, "raw")).sort()) {
  for (const t of JSON.parse(fs.readFileSync(path.join(dir, "raw", f), "utf8"))) {
    if (t.code !== 0 || t.hash in out.eip712_v2 || t.hash in out.amino) continue;
    const tx = parseTx(Buffer.from(t.tx, "base64"));
    if (tx.signers.length !== 1 || tx.messages.some((m) => m.type_url === EVM_TX)) continue;
    const s = tx.signers[0];
    if (!s.public_key?.key || s.public_key.key.length !== 33) continue;
    const web3 = tx.extension_options.find((o) => o.type_url.includes("ExtensionOptionsWeb3Tx"));
    const signer = bech32Encode("inj", ethAddressOfKey(s.public_key.key));
    if (s.mode === 127 && !web3) {
      const n = await accountNumber(signer);
      if (n !== null) out.amino[t.hash] = { account_number: n.toString() };
      continue;
    }
    if (s.mode !== 128 || !web3) continue;
    const j = await cached(`${LCD}/cosmos/tx/v1beta1/txs/${t.hash}`);
    const body = j.tx?.body;
    const ext = body?.extension_options?.find((o) => o["@type"].includes("ExtensionOptionsWeb3Tx"));
    const n = await accountNumber(signer);
    if (!body || !ext || n === null) continue;
    const fee = j.tx.auth_info.fee;
    const feeJson = { amount: fee.amount.length ? fee.amount : null, gas: Number(fee.gas_limit) };
    if (ext.feePayer) feeJson.payer = ext.feePayer;
    const context =
      `{"account_number":${n},"chain_id":"injective-1","fee":${goJson(feeJson)},"memo":${goJson(body.memo)},` +
      `"sequence":${s.sequence},"timeout_height":${BigInt(body.timeout_height)}}`;
    const msgs = "[" + body.messages.map(goJson).join(",") + "]";
    const typed = {
      types: TYPES,
      primaryType: "Tx",
      domain: {
        name: "Injective Web3",
        version: "1.0.0",
        chainId: Number(ext.typedDataChainID),
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
        salt: "0",
      },
      message: { context, msgs },
    };
    const hash = hashTypedData(typed);
    let who = null;
    try {
      who = await recoverAddress({ hash, signature: "0x" + Buffer.from(tx.signatures[0]).toString("hex") });
    } catch {
      // not a 65-byte signature
    }
    const expect = "0x" + ethAddressOfKey(s.public_key.key).toString("hex");
    if (who && who.toLowerCase() === expect) {
      out.eip712_v2[t.hash] = { typed_data: typed };
      ok++;
    } else bad++;
  }
}
fs.writeFileSync(path.join(dir, "verified.json"), JSON.stringify(out));
console.log("eip712 v2 verified", ok, "not verified", bad, "amino accounts", Object.keys(out.amino).length);
