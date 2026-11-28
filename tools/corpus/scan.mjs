// Independent check that a built corpus names no real account: every account address in
// the private capture (bech32 of any chain, 0x hex, base64 of its bytes) and every signer
// key must be absent from the output file.
//   node tools/corpus/scan.mjs <private-dir> <corpus.json>
import fs from "node:fs";
import path from "node:path";
import { addressesIn, bech32Decode, bech32Encode, ethAddressOfKey, parseTx, ethereumTxOf, EVM_TX } from "./tx.mjs";

const [dir, file] = process.argv.slice(2);
const out = fs.readFileSync(file, "utf8").toLowerCase();
const kinds = JSON.parse(fs.readFileSync(path.join(dir, "kinds.json"), "utf8"));
const repo = path.resolve(import.meta.dirname, "../..");
const test = new Set(JSON.parse(fs.readFileSync(path.join(repo, "crates/injective/tests/vectors/direct.json"), "utf8")).accounts.map((a) => a.eth.slice(2).toLowerCase()));
const accounts = new Map();
for (const f of fs.readdirSync(path.join(dir, "raw")))
  for (const t of JSON.parse(fs.readFileSync(path.join(dir, "raw", f), "utf8"))) {
    let tx;
    try {
      tx = parseTx(Buffer.from(t.tx, "base64"));
    } catch {
      continue;
    }
    for (const s of tx.signers) if (s.public_key?.key?.length === 33) accounts.set(ethAddressOfKey(s.public_key.key).toString("hex"), s.public_key.key);
    for (const m of tx.messages) if (m.type_url === EVM_TX) { const e = ethereumTxOf(m.value); if (e?.from) accounts.set(e.from.toString("hex"), null); }
    for (const a of addressesIn(tx)) {
      if (kinds[a] && kinds[a] !== "account") continue;
      const d = a.startsWith("0x") ? { bytes: Buffer.from(a.slice(2), "hex") } : bech32Decode(a);
      if (!d || a.includes("valoper")) continue;
      const hex = d.bytes.toString("hex");
      if (d.bytes.length === 20 && [("0x" + hex), bech32Encode("inj", d.bytes)].some((x) => kinds[x] && kinds[x] !== "account")) continue;
      accounts.set(hex, accounts.get(hex) ?? null);
    }
  }
let bad = 0;
for (const [hex, key] of accounts) {
  if (test.has(hex)) continue;
  const b = Buffer.from(hex, "hex");
  const forms = [hex, b.toString("base64").slice(2, -2).toLowerCase()];
  if (b.length === 20) forms.push(bech32Encode("inj", b).slice(4, -6));
  if (key) forms.push(Buffer.from(key).toString("hex"), Buffer.from(key).toString("base64").slice(2, -2).toLowerCase());
  const hit = forms.find((x) => x.length >= 20 && out.includes(x));
  if (hit) {
    bad++;
    const i = out.indexOf(hit);
    const before = out.lastIndexOf("\"name\"", i);
    console.log("found in", out.slice(before, before + 60).split(",")[0], "form", forms.indexOf(hit), "context", out.slice(Math.max(0, i - 40), i).replace(/[0-9a-z]{30,}/g, "…"));
  }
}
console.log(`accounts checked ${accounts.size}, found in output ${bad}`);
process.exit(bad ? 1 : 0);
