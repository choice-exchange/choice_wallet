// Reading mainnet transactions for the corpus: protobuf fields, bech32, RLP, and every
// address a transaction names (in its bytes, in CosmWasm JSON, in base64 JSON inside that,
// and in EVM calldata).
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// ---- protobuf ----

function varint(b, i) {
  let v = 0n;
  let s = 0n;
  for (;;) {
    if (i >= b.length) throw new Error("varint past end");
    const x = b[i++];
    v |= BigInt(x & 0x7f) << s;
    if (!(x & 0x80)) return [v, i];
    s += 7n;
  }
}

/** Fields of one protobuf message: { no, wt, val, start, end } (val: Buffer or BigInt). */
export function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let k;
    [k, i] = varint(b, i);
    const no = Number(k >> 3n);
    const wt = Number(k & 7n);
    let val;
    if (wt === 0) [val, i] = varint(b, i);
    else if (wt === 2) {
      let n;
      [n, i] = varint(b, i);
      val = b.subarray(i, i + Number(n));
      if (val.length !== Number(n)) throw new Error("bytes past end");
      i += Number(n);
    } else if (wt === 1) (val = b.subarray(i, i + 8)), (i += 8);
    else if (wt === 5) (val = b.subarray(i, i + 4)), (i += 4);
    else throw new Error(`wire type ${wt}`);
    out.push({ no, wt, val, start, end: i });
  }
  return out;
}

const one = (fs, no) => fs.find((f) => f.no === no)?.val;
const all = (fs, no) => fs.filter((f) => f.no === no).map((f) => f.val);

export function parseAny(b) {
  const f = fields(b);
  return { type_url: one(f, 1)?.toString("utf8") ?? "", value: one(f, 2) ?? Buffer.alloc(0) };
}

/** A TxRaw, with its body and auth info read as far as the corpus needs. */
export function parseTx(raw) {
  const t = fields(raw);
  const body_bytes = one(t, 1) ?? Buffer.alloc(0);
  const auth_info_bytes = one(t, 2) ?? Buffer.alloc(0);
  const body = fields(body_bytes);
  const auth = fields(auth_info_bytes);
  const signers = all(auth, 1).map((s) => {
    const f = fields(s);
    const pk = one(f, 1) ? parseAny(one(f, 1)) : null;
    const mi = one(f, 2) ? fields(one(f, 2)) : [];
    const single = one(mi, 1);
    return {
      public_key: pk && { type_url: pk.type_url, key: one(fields(pk.value), 1) },
      mode: single ? Number(one(fields(single), 1) ?? 0n) : null,
      multi: !single,
      sequence: one(f, 3) ?? 0n,
    };
  });
  const fee = one(auth, 2) ? fields(one(auth, 2)) : [];
  return {
    raw,
    body_bytes,
    auth_info_bytes,
    messages: all(body, 1).map(parseAny),
    memo: one(body, 2)?.toString("utf8") ?? "",
    timeout_height: one(body, 3) ?? 0n,
    extension_options: all(body, 1023).map(parseAny),
    non_critical_extension_options: all(body, 2047).map(parseAny),
    signers,
    fee: {
      gas_limit: one(fee, 2) ?? 0n,
      payer: one(fee, 3)?.toString("utf8") ?? "",
      granter: one(fee, 4)?.toString("utf8") ?? "",
    },
    signatures: all(t, 3),
  };
}

// ---- bech32 ----

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const expand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));

function convert(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) out.push((acc >> (bits -= to)) & ((1 << to) - 1));
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  else if (!pad && (bits >= from || (acc << (to - bits)) & ((1 << to) - 1))) return null;
  return out;
}

/** { hrp, bytes } for a valid lowercase bech32 string, else null. */
export function bech32Decode(s) {
  const p = s.lastIndexOf("1");
  if (p < 1 || s.length - p < 7) return null;
  const hrp = s.slice(0, p);
  const data = [...s.slice(p + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return null;
  if (polymod(expand(hrp).concat(data)) !== 1) return null;
  const bytes = convert(data.slice(0, -6), 5, 8, false);
  return bytes && { hrp, bytes: Buffer.from(bytes) };
}

export function bech32Encode(hrp, bytes) {
  const data = convert([...bytes], 8, 5, true);
  const mod = polymod(expand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const chk = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + "1" + data.concat(chk).map((d) => CHARSET[d]).join("");
}

// ---- RLP (typed and legacy EVM transactions) ----

function rlpItem(b, i) {
  const x = b[i];
  if (x < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (x < 0xb8) return [b.subarray(i + 1, i + 1 + x - 0x80), i + 1 + x - 0x80];
  if (x < 0xc0) {
    const ll = x - 0xb7;
    const n = Number(BigInt("0x" + b.subarray(i + 1, i + 1 + ll).toString("hex")));
    return [b.subarray(i + 1 + ll, i + 1 + ll + n), i + 1 + ll + n];
  }
  let n;
  let s;
  if (x < 0xf8) (n = x - 0xc0), (s = i + 1);
  else {
    const ll = x - 0xf7;
    n = Number(BigInt("0x" + b.subarray(i + 1, i + 1 + ll).toString("hex")));
    s = i + 1 + ll;
  }
  const items = [];
  let j = s;
  while (j < s + n) {
    let it;
    [it, j] = rlpItem(b, j);
    items.push(it);
  }
  return [items, s + n];
}

const big = (b) => (b.length ? BigInt("0x" + b.toString("hex")) : 0n);

/** to, value, data, chain ID and type of a signed EVM transaction. */
export function parseEvmTx(raw) {
  const type = raw[0] < 0x7f ? raw[0] : 0;
  const [items] = rlpItem(raw, type ? 1 : 0);
  if (type === 2) {
    const [chainId, nonce, tip, maxFee, gas, to, value, data] = items;
    return { type, chain_id: big(chainId), nonce: big(nonce), tip: big(tip), max_fee: big(maxFee), gas: big(gas), to, value: big(value), data };
  }
  if (type === 1) {
    const [chainId, nonce, gasPrice, gas, to, value, data] = items;
    return { type, chain_id: big(chainId), nonce: big(nonce), gas_price: big(gasPrice), gas: big(gas), to, value: big(value), data };
  }
  if (type === 0) {
    const [nonce, gasPrice, gas, to, value, data, v] = items;
    const vv = big(v);
    return { type, chain_id: vv >= 35n ? (vv - 35n) / 2n : null, nonce: big(nonce), gas_price: big(gasPrice), gas: big(gas), to, value: big(value), data };
  }
  throw new Error(`EVM tx type ${type}`);
}

/** The signed EVM transaction and the sender's 20 bytes in a MsgEthereumTx, if it has them. */
export function ethereumTxOf(msgValue) {
  const f = fields(msgValue);
  let raw = null;
  let from = null;
  for (const x of f) {
    if (x.wt !== 2) continue;
    if (x.val.length === 20) from = x.val;
    else if (x.val.length > 20 && (x.val[0] === 0x02 || x.val[0] === 0x01 || x.val[0] >= 0xc0)) raw = x.val;
  }
  return raw && { evm: parseEvmTx(raw), from };
}

export const EVM_TX = "/injective.evm.v1.MsgEthereumTx";

// ---- addresses ----

export const BECH32_RE = /\b([a-z]{2,20})1([02-9ac-hj-np-z]{38,90})\b/g;
export const HEX_RE = /0x([0-9a-fA-F]{40})(?![0-9a-fA-F])/g;
export const SUBACCOUNT_RE = /0x([0-9a-fA-F]{40})([0-9a-fA-F]{24})(?![0-9a-fA-F])/g;
const B64_RE = /"([A-Za-z0-9+/]{20,}={0,2})"/g;

/** JSON texts hidden as base64 strings in `text` (CW20 send hooks and the like). */
export function base64Json(text) {
  const out = [];
  for (const m of text.matchAll(B64_RE)) {
    const s = m[1];
    if (s.length % 4) continue;
    const d = Buffer.from(s, "base64");
    if (d.toString("base64") !== s) continue;
    const t = d.toString("utf8");
    if (!/^\s*[{["]/.test(t) || Buffer.from(t, "utf8").compare(d) !== 0) continue;
    try {
      JSON.parse(t);
    } catch {
      continue;
    }
    out.push({ at: m.index + 1, b64: s, text: t });
  }
  return out;
}

function textAddresses(text, set) {
  for (const m of text.matchAll(BECH32_RE)) if (bech32Decode(m[0])) set.add(m[0]);
  for (const m of text.matchAll(HEX_RE)) set.add("0x" + m[1].toLowerCase());
  for (const m of text.matchAll(SUBACCOUNT_RE)) set.add("0x" + m[1].toLowerCase());
  for (const j of base64Json(text)) textAddresses(j.text, set);
}

/**
 * Calldata values that look like addresses: 20 bytes after 12 zero bytes, at any offset (ABI
 * words, words of calls nested in `bytes` such as multicall, and packed messages such as
 * CCTP's, which pad addresses to 32 bytes). Aligned words also count when the address itself
 * starts with zero bytes.
 */
export function calldataAddresses(data) {
  return walkCall(data).slots;
}

/**
 * A small ABI walk over a call: its words, the words of dynamic arguments (arrays, and
 * `bytes` that hold another call, as in multicall), and in each the words that look like
 * addresses. `packed` is set when a `bytes` argument holds something else (a bridge message,
 * a signature): addresses there can sit anywhere, so the corpus leaves such calls out.
 */
export function walkCall(data) {
  const slots = new Map();
  let packed = false;
  const seen = new Set();
  function words(start, end, depth) {
    for (let i = start; i + 32 <= end; i += 32) {
      const w = data.subarray(i, i + 32);
      const zero12 = w.subarray(0, 12).every((x) => x === 0);
      if (zero12 && w.subarray(12, 16).some((x) => x !== 0) && !w.subarray(12).every((x) => x === 0xff)) {
        slots.set(i + 12, { at: i + 12, hex: "0x" + w.subarray(12).toString("hex") });
      }
      // An offset to a dynamic argument, relative to this call's argument area.
      const v = zero12 && w.subarray(12, 24).every((x) => x === 0) ? Number(BigInt("0x" + w.subarray(24).toString("hex"))) : -1;
      if (v >= 32 && v % 32 === 0 && start + v + 32 <= end && depth < 4 && !seen.has(start + v)) {
        seen.add(start + v);
        const at = start + v;
        const len = Number(BigInt("0x" + data.subarray(at, at + 32).toString("hex")));
        const body = at + 32;
        if (len > 0 && len % 32 === 4 && body + len <= end) words(body + 4, body + len, depth + 1);
        else if (len > 0 && body + len * 32 <= end) words(body, body + len * 32, depth + 1);
        else if (len > 0 && len % 32 === 0 && body + len <= end) words(body, body + len, depth + 1);
        else if (len > 0 && body + len <= end) packed = true;
      }
    }
  }
  words(4, data.length, 0);
  return { slots: [...slots.values()], packed };
}

/** Every address a transaction names, lowercase (inj1…, other bech32, 0x…). */
export function addressesIn(tx) {
  const set = new Set();
  textAddresses(tx.body_bytes.toString("latin1"), set);
  textAddresses(tx.auth_info_bytes.toString("latin1"), set);
  for (const m of tx.messages) {
    if (m.type_url !== EVM_TX) continue;
    const e = ethereumTxOf(m.value);
    if (!e) continue;
    if (e.evm.to.length === 20) set.add("0x" + e.evm.to.toString("hex"));
    for (const a of calldataAddresses(e.evm.data)) set.add(a.hex);
  }
  for (const a of [...set]) {
    const d = bech32Decode(a);
    if (d && d.hrp === "inj" && d.bytes.length === 20) set.add("0x" + d.bytes.toString("hex"));
  }
  return set;
}

/** The 20-byte address of a compressed secp256k1 key, as Injective and Ethereum derive it. */
export function ethAddressOfKey(compressed) {
  const full = secp256k1.ProjectivePoint.fromHex(Buffer.from(compressed).toString("hex")).toRawBytes(false);
  return Buffer.from(keccak_256(full.subarray(1)).slice(-20));
}
