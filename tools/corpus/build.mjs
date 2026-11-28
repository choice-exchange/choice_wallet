// Builds the repository's real-dapp corpus from what fetch.mjs saved: picks varied
// transactions and replaces every account in them with a test account, so no real person's
// address, key or account number reaches the repository. Offline.
//
//   node tools/corpus/build.mjs <private-dir> <out.json>
//
// What is kept as it is: the bytes each dapp's encoder wrote (field order, default values,
// JSON spacing), contracts, validators, amounts. What is replaced, always by a string of the
// same length so the protobuf around it is unchanged: every account address (inj1 and other
// chains' bech32, 0x hex in any case, the address in a subaccount ID, base64 JSON inside
// CosmWasm messages, address words in EVM calldata), the signer's public key, and memos. A
// case where any form of a replaced account or key is still found is dropped.
import fs from "node:fs";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import {
  EVM_TX,
  HEX_RE,
  SUBACCOUNT_RE,
  BECH32_RE,
  addressesIn,
  base64Json,
  bech32Decode,
  bech32Encode,
  calldataAddresses,
  walkCall,
  ethAddressOfKey,
  ethereumTxOf,
  parseTx,
} from "./tx.mjs";

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) {
  console.error("usage: build.mjs <private-dir> <out.json>");
  process.exit(2);
}
const repo = path.resolve(import.meta.dirname, "../..");
const vectors = JSON.parse(fs.readFileSync(path.join(repo, "crates/injective/tests/vectors/direct.json"), "utf8"));
const kinds = JSON.parse(fs.readFileSync(path.join(dir, "kinds.json"), "utf8"));
const labels = fs.existsSync(path.join(dir, "labels.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8")) : {};

// The test phrase's accounts 0..2 (published BIP-39 vector), then addresses made for the
// test that nobody holds a key to.
const TEST = vectors.accounts.map((a) => Buffer.from(a.eth.slice(2), "hex"));
function testBytes(k, len) {
  if (len === 20 && k < TEST.length) return TEST[k];
  const h = Buffer.from(sha256(new TextEncoder().encode(`choice-wallet corpus account ${k}`)));
  return Buffer.concat([h, h]).subarray(0, len);
}
const SIGNER_KEY = Buffer.from(vectors.accounts[0].pubkey, "hex");

function isContract(hex20) {
  const h = "0x" + hex20.toString("hex");
  const inj = bech32Encode("inj", hex20);
  return [h, inj].some((a) => kinds[a] && kinds[a] !== "account");
}

function checksum(hex) {
  const lower = hex.toLowerCase();
  const h = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString("hex");
  return [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

function sameCase(orig, repl) {
  if (orig === orig.toLowerCase()) return repl.toLowerCase();
  if (orig === orig.toUpperCase()) return repl.toUpperCase();
  return checksum(repl);
}

/** One transaction's replacement map: account bytes (hex) to test bytes, signer first. */
class Map2 {
  constructor(signer) {
    this.m = new Map([[signer.toString("hex"), testBytes(0, 20)]]);
    this.originals = [signer];
  }
  of(bytes) {
    const k = bytes.toString("hex");
    if (!this.m.has(k)) {
      this.m.set(k, testBytes(this.m.size, bytes.length));
      this.originals.push(Buffer.from(bytes));
    }
    return this.m.get(k);
  }
}

function subText(text, map) {
  // base64 JSON first: decode, replace inside, encode again (same length, as the decoded
  // text keeps its length).
  let out = text;
  for (const j of base64Json(text)) {
    const inner = subText(j.text, map);
    const b64 = Buffer.from(inner, "utf8").toString("base64");
    if (b64.length !== j.b64.length) throw new Error("base64 length changed");
    out = out.slice(0, j.at) + b64 + out.slice(j.at + b64.length);
  }
  out = out.replace(BECH32_RE, (s) => {
    const d = bech32Decode(s);
    if (!d || d.hrp.includes("valoper") || d.hrp.includes("valcons")) return s;
    if (d.bytes.length === 20 && isContract(d.bytes)) return s;
    if (d.hrp === "inj" && d.bytes.length !== 20 && kinds[s] && kinds[s] !== "account") return s;
    const r = bech32Encode(d.hrp, map.of(d.bytes));
    if (r.length !== s.length) throw new Error("bech32 length changed");
    return r;
  });
  out = out.replace(SUBACCOUNT_RE, (s, a, nonce) => {
    const b = Buffer.from(a, "hex");
    if (isContract(b)) return s;
    return "0x" + sameCase(a, map.of(b).toString("hex")) + nonce;
  });
  out = out.replace(HEX_RE, (s, a) => {
    const b = Buffer.from(a, "hex");
    if (isContract(b)) return s;
    return "0x" + sameCase(a, map.of(b).toString("hex"));
  });
  return out;
}

function subBytes(buf, map) {
  const t = subText(buf.toString("latin1"), map);
  const b = Buffer.from(t, "latin1");
  if (b.length !== buf.length) throw new Error("length changed");
  return b;
}

/** Every form a replaced account or key could still be found in. */
function traces(originals, key) {
  const out = [];
  for (const b of [...originals, key]) {
    out.push(b, Buffer.from(b.toString("hex")), Buffer.from(b.toString("hex").toUpperCase()));
    for (let off = 0; off < 3; off++) {
      const s = Buffer.concat([Buffer.alloc(off), b]).toString("base64");
      out.push(Buffer.from(s.slice(4, -4)));
    }
    if (b.length === 20) {
      out.push(Buffer.from(checksum(b.toString("hex"))));
      for (const hrp of ["inj", "cosmos", "osmo", "noble", "axelar"]) out.push(Buffer.from(bech32Encode(hrp, b).slice(hrp.length + 1, -6)));
    }
  }
  return out;
}

const leaks = (bufs, ts) => bufs.some((b) => ts.some((t) => b.includes(t)));

// Memos wallets and apps write for themselves are kept; any other is replaced.
const APP_MEMOS = new Set(["Ledger Live", "Stake via Trust Wallet", "Delegated with Exodus", "OsmosisFE", "Choice Exchange", "DODEX IBC transfer"]);

function setMemo(bodyBytes, memo) {
  // Field 2 of TxBody. Replaced in place by "x"s of the same length.
  if (!memo || APP_MEMOS.has(memo)) return bodyBytes;
  const m = Buffer.from(memo, "utf8");
  const i = bodyBytes.indexOf(m);
  if (i < 0) throw new Error("memo not found");
  const b = Buffer.from(bodyBytes);
  b.fill("x", i, i + m.length);
  return b;
}

const MODES = { 1: "direct", 127: "amino" };
const verified = JSON.parse(fs.readFileSync(path.join(dir, "verified.json"), "utf8"));
const aminoChecked = fs.existsSync(path.join(dir, "amino_verified.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "amino_verified.json"), "utf8")) : {};

/** An Injective EIP-712 v2 request rebuilt from the chain and checked against its signature. */
function eip712Case(t, tx, signer) {
  const v = verified.eip712_v2[t.hash];
  if (!v) return null;
  const map = new Map2(signer);
  const td = structuredClone(v.typed_data);
  const ctx = JSON.parse(td.message.context);
  let context = td.message.context.replace(`"account_number":${ctx.account_number},`, '"account_number":12345,');
  if (ctx.memo && !APP_MEMOS.has(ctx.memo)) {
    const enc = JSON.stringify(ctx.memo);
    if (!context.includes(`"memo":${enc}`)) return null;
    context = context.replace(`"memo":${enc}`, `"memo":${JSON.stringify("x".repeat(ctx.memo.length))}`);
  }
  td.message.context = subText(context, map);
  td.message.msgs = subText(td.message.msgs, map);
  const text = Buffer.from(JSON.stringify(td));
  if (leaks([text], traces(map.originals, tx.signers[0].public_key.key))) return null;
  return { sign_mode: "eip712_v2", sequence: Number(tx.signers[0].sequence), typed_data: td };
}

function cosmosCase(t, tx) {
  if (tx.signers.length !== 1 || tx.signatures.length !== 1) return null;
  const s = tx.signers[0];
  if (s.multi || !s.public_key?.key || s.public_key.key.length !== 33) return null;
  // The wallet's accounts are Injective's eth_secp256k1 keys; Cosmos-type keys sign elsewhere.
  if (s.public_key.type_url !== "/injective.crypto.v1beta1.ethsecp256k1.PubKey") return null;
  const signer = ethAddressOfKey(s.public_key.key);
  const web3 = tx.extension_options.some((o) => o.type_url.includes("ExtensionOptionsWeb3Tx"));
  // EIP-712: what the dapp sent the wallet was typed data, rebuilt and checked above. v1
  // (amino-derived typed data) isn't read by the wallet; those are left out.
  if (web3) return s.mode === 128 ? eip712Case(t, tx, signer) : null;
  if (!(s.mode in MODES)) return null;
  const map = new Map2(signer);
  let body = subBytes(setMemo(tx.body_bytes, tx.memo), map);
  let auth = subBytes(tx.auth_info_bytes, map);
  const at = auth.indexOf(s.public_key.key);
  if (at < 0 || auth.indexOf(s.public_key.key, at + 1) >= 0) return null;
  auth = Buffer.from(auth);
  SIGNER_KEY.copy(auth, at);
  if (leaks([body, auth], traces(map.originals, s.public_key.key))) return null;
  const checked = aminoChecked[t.hash];
  return {
    sign_mode: MODES[s.mode],
    ...(s.mode === 127 ? { amino_check: checked === "verified" ? "matches the chain's signature" : checked ? "not checked: " + (checked.refused ?? "differs") : "not checked" } : {}),
    sequence: Number(s.sequence),
    body_bytes: body.toString("base64"),
    auth_info_bytes: auth.toString("base64"),
    account_number: "12345",
  };
}

const USER_SELECTORS = new Set([
  "095ea7b3", "a9059cbb", "23b872dd", "39509351", "d0e30db0", "2e1a7d4d", "a22cb465", "42842e0e", "b88d4fde", "f242432a",
  "38ed1739", "7ff36ab5", "18cbafe5", "8803dbee", "fb3bdb41", "5c11d795", "b6f9de95", "791ac947", "e8e33700", "f305d719",
  "baa2abde", "02751cec", "414bf389", "04e45aaf", "c04b8d59", "b858183f", "db3e2198", "5023b4df", "ac9650d8", "5ae401dc",
  "1f0464d1", "3593564c", "24856bc3", "87517c45", "fb0f3ee1", "b3a34c4c", "e7acab24", "87201b41", "fd9f1e10", "5b34b966",
]);

function evmCase(t, tx) {
  if (tx.messages.length !== 1) return null;
  const e = ethereumTxOf(tx.messages[0].value);
  if (!e || !e.from) return null;
  const map = new Map2(e.from);
  const v = e.evm;
  let to = v.to;
  if (to.length === 20 && !isContract(to)) to = map.of(to);
  if (walkCall(v.data).packed) return null;
  // Calls people make through dapps; a day of EVM blocks is mostly relayers and bots.
  if (v.data.length && !USER_SELECTORS.has(v.data.subarray(0, 4).toString("hex"))) return null;
  const data = Buffer.from(v.data);
  for (const a of calldataAddresses(v.data)) {
    const b = Buffer.from(a.hex.slice(2), "hex");
    if (!isContract(b)) map.of(b).copy(data, a.at);
  }
  if (leaks([data, to], traces(map.originals, Buffer.alloc(0)).filter((x) => x.length))) return null;
  return {
    sign_mode: "evm",
    sequence: Number(v.nonce),
    tx: {
      from: vectors.accounts[0].eth,
      to: to.length ? "0x" + to.toString("hex") : null,
      value: "0x" + v.value.toString(16),
      data: "0x" + data.toString("hex"),
      gas: "0x" + v.gas.toString(16),
    },
  };
}

function wasmKey(tx) {
  // contract + first key of each message, e.g. "inj1…:swap".
  return tx.messages
    .map((m) => {
      const txt = m.value.toString("latin1");
      const c = txt.match(/inj1[02-9ac-hj-np-z]{38,58}/g) ?? [];
      const contract = c.find((a) => kinds[a] && kinds[a] !== "account") ?? "?";
      const k = txt.match(/\{\s*"([a-z_0-9]+)"/)?.[1] ?? "?";
      return `${contract}:${k}`;
    })
    .join("+");
}

const cases = [];
const used = new Set();
const files = fs.readdirSync(path.join(dir, "raw")).sort();
for (const f of files) {
  const raws = JSON.parse(fs.readFileSync(path.join(dir, "raw", f), "utf8"));
  const action = "/" + f.replace(/\.json$/, "");
  const seen = new Map();
  for (const t of raws) {
    if (t.code !== 0) continue;
    let tx;
    try {
      tx = parseTx(Buffer.from(t.tx, "base64"));
    } catch {
      continue;
    }
    const types = tx.messages.map((m) => m.type_url);
    const evm = types.includes(EVM_TX);
    let c;
    try {
      c = evm ? evmCase(t, tx) : cosmosCase(t, tx);
    } catch (err) {
      console.error("skip", t.hash.slice(0, 8), err.message);
      continue;
    }
    if (!c) continue;
    // One case per kind of request: message types + sign mode (+ contract and method, or
    // EVM target and selector). Low-sequence signers first: people, not bots.
    let key = c.sign_mode + " " + [...new Set(types)].join(",");
    if (types.some((x) => x.includes("MsgExecuteContract"))) key += " " + wasmKey(tx);
    if (evm) key += " " + (c.tx.to ?? "create") + ":" + c.tx.data.slice(0, 10);
    const prev = seen.get(key);
    if (used.has(t.hash)) continue;
    if (!prev || c.sequence < prev.c.sequence) seen.set(key, { c, types, hash: t.hash });
  }
  const limit = f.startsWith("contract_") ? 6 : action.includes("MsgExecuteContract") || action.includes("MsgEthereumTx") ? 40 : 4;
  const picked = [...seen.entries()].sort((a, b) => a[1].c.sequence - b[1].c.sequence).slice(0, limit);
  for (const [key, { c, types, hash }] of picked) {
    used.add(hash);
    const { sequence, ...rest } = c;
    const contract = key.match(/(inj1[02-9ac-hj-np-z]{38,58}):/)?.[1];
    cases.push({
      name: `${types[0].split(".").pop()}_${c.sign_mode}_${cases.length}`,
      messages: types,
      ...(contract && labels[contract] && !/0x[0-9a-fA-F]{6}|[a-z]{2,20}1[02-9ac-hj-np-z]{20}/.test(labels[contract]) ? { contract_label: labels[contract] } : {}),
      ...rest,
    });
  }
}

fs.writeFileSync(outFile, JSON.stringify({ about: "Real mainnet transactions from dapps, with every account replaced by a test account; see tools/corpus/build.mjs.", cases }, null, 1) + "\n");
console.log("cases", cases.length);
