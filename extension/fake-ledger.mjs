// A Ledger in software, for the browser check (e2e.mjs). Dev only: it never ships.
//
// The page gets a fake `navigator.hid` (PAGE_SCRIPT, installed before the page loads) whose
// one device passes every 64-byte HID report to Node over a DevTools binding. Node plays the
// device: Ledger's HID framing, the dashboard, and the Cosmos and Ethereum apps' commands as
// Ledger's Device Management Kit sends them, signing with the BIP-39 test phrase's keys (the
// "abandon … about" phrase, which belongs to no one). So the real kit, its WebHID transport
// and the vault's signature checks all run; only the device is pretend.
//
// It needs @noble/curves, @noble/hashes and @scure/* from tools/vectors (npm install there).

import { secp256k1 } from "../tools/vectors/node_modules/@noble/curves/esm/secp256k1.js";
import { keccak_256 } from "../tools/vectors/node_modules/@noble/hashes/esm/sha3.js";
import { bech32 } from "../tools/vectors/node_modules/@scure/base/lib/esm/index.js";
import { HDKey } from "../tools/vectors/node_modules/@scure/bip32/lib/esm/index.js";
import { mnemonicToSeedSync } from "../tools/vectors/node_modules/@scure/bip39/esm/index.js";

export const TEST_PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Installed in the page before it loads: `navigator.hid` with one Ledger Nano X, whose
 *  reports go to Node through the `__ledger` binding (one JSON message per report) and come
 *  back through `__ledgerReply`. Pairing is remembered in localStorage, as Chrome remembers a
 *  granted device per origin. */
export const PAGE_SCRIPT = `(() => {
  const waiting = new Map();
  let next = 1;
  class FakeLedger extends EventTarget {
    constructor() { super(); this.vendorId = 0x2c97; this.productId = 0x4011; this.productName = "Nano X"; this.opened = false; this.collections = []; this.oninputreport = null; }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async forget() { localStorage.removeItem("fake-ledger"); }
    async sendReport(reportId, data) {
      const bytes = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const id = next++;
      const frames = await new Promise((resolve) => { waiting.set(id, resolve); window.__ledger(JSON.stringify({ id, hex })); });
      for (const f of frames) {
        const buf = new Uint8Array(f.match(/../g).map((h) => parseInt(h, 16)));
        const ev = new Event("inputreport");
        Object.defineProperty(ev, "data", { value: new DataView(buf.buffer) });
        Object.defineProperty(ev, "device", { value: this });
        Object.defineProperty(ev, "reportId", { value: 0 });
        setTimeout(() => { if (this.oninputreport) this.oninputreport(ev); this.dispatchEvent(ev); }, 0);
      }
    }
  }
  const device = new FakeLedger();
  const hid = new EventTarget();
  hid.getDevices = async () => (localStorage.getItem("fake-ledger") ? [device] : []);
  hid.requestDevice = async () => { localStorage.setItem("fake-ledger", "1"); return [device]; };
  window.__ledgerReply = (id, frames) => { const r = waiting.get(id); waiting.delete(id); if (r) r(frames); };
  Object.defineProperty(Navigator.prototype, "hid", { get: () => hid, configurable: true });
})();`;

const hex = (b) => Buffer.from(b).toString("hex");
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];

/** The device: give it `report(hex)` for each HID report; it answers with reports. */
export function createFakeLedger({ log = () => {} } = {}) {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_PHRASE));
  let app = "BOLOS";
  let rx = null; // { channel, length, data[] } while an APDU arrives
  const signed = []; // what each app was asked to sign: { app, kind, path, payload }
  let cosmosSign = null; // { path, hrp, chunks[] }
  let confirming = false; // the last APDU asked the user to approve something
  let ethSign = null; // { ins, path, data[] }

  const keyAt = (path) => root.derive(path);
  const pathFromLE = (b) => "m/" + Array.from({ length: 5 }, (_, i) => b.readUInt32LE(4 * i)).map((v) => (v & 0x80000000 ? `${v & 0x7fffffff}'` : `${v}`)).join("/");
  const pathFromBE = (b) => {
    const n = b[0];
    return { path: "m/" + Array.from({ length: n }, (_, i) => b.readUInt32BE(1 + 4 * i)).map((v) => (v & 0x80000000 ? `${v & 0x7fffffff}'` : `${v}`)).join("/"), rest: b.subarray(1 + 4 * n) };
  };
  const injAddress = (pub) => {
    const full = secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
    return bech32.encode("inj", bech32.toWords(keccak_256(full.subarray(1)).subarray(12)));
  };
  const ok = (data = []) => Buffer.from([...data, 0x90, 0x00]);
  const sw = (code) => Buffer.from(u16(code));

  function apdu(a) {
    const [cla, ins, p1, p2] = a;
    if (process.env.E2E_LEDGER_TRACE) log(`ledger <- ${hex(a.subarray(0, 4))} (${app})`);
    const data = a.subarray(5);
    // Dashboard and OS.
    if (cla === 0xb0 && ins === 0x01) {
      const name = Buffer.from(app);
      const version = Buffer.from(app === "BOLOS" ? "2.4.2" : app === "Cosmos" ? "2.38.0" : "1.15.0");
      return ok([0x01, name.length, ...name, version.length, ...version, 0x01, 0x00]);
    }
    if (cla === 0xe0 && ins === 0xd8) {
      const name = data.toString();
      if (name !== "Cosmos" && name !== "Ethereum") return sw(0x6807);
      app = name;
      return ok();
    }
    if (cla === 0xb0 && ins === 0xa7) {
      app = "BOLOS";
      return ok();
    }
    if (cla === 0xe0 && ins === 0x01 && app === "BOLOS") {
      // GET_OS_VERSION, as a Nano X on firmware 2.4.2 answers it: target ID, then
      // length-prefixed SE version, SE flags (PIN validated, onboarded, ready), MCU version,
      // bootloader version, hardware version, language and recovery state.
      const lv = (b) => [b.length, ...b];
      return ok([
        0x33, 0x00, 0x00, 0x04,
        ...lv(Buffer.from("2.4.2")),
        ...lv([0x84, 0x00, 0x00, 0x0b]),
        ...lv(Buffer.from("2.61")),
        ...lv(Buffer.from("1.16")),
        ...lv([0x00]),
        ...lv([0x00]),
        ...lv([0x00]),
      ]);
    }
    // The Cosmos app.
    if (app === "Cosmos" && cla === 0x55) {
      if (ins === 0x00) return ok([0x00, 2, 38, 0, 0x00]);
      if (ins === 0x04) {
        const hrpLen = data[0];
        const hrp = data.subarray(1, 1 + hrpLen).toString();
        const path = pathFromLE(data.subarray(1 + hrpLen));
        if (hrp !== "inj" || !path.startsWith("m/44'/60'/")) return sw(0x6984);
        const pub = keyAt(path).publicKey;
        return ok([...pub, ...Buffer.from(injAddress(pub))]);
      }
      if (ins === 0x02) {
        if (p1 === 0x00) {
          const path = pathFromLE(data.subarray(0, 20));
          const hrpLen = data[20];
          cosmosSign = { path, hrp: data.subarray(21, 21 + hrpLen).toString(), chunks: [] };
          return ok();
        }
        if (!cosmosSign) return sw(0x6985);
        cosmosSign.chunks.push(Buffer.from(data));
        if (p1 === 0x01) return ok();
        const payload = Buffer.concat(cosmosSign.chunks);
        const { path } = cosmosSign;
        cosmosSign = null;
        if (p2 !== 0x00) return sw(0x6984); // JSON mode only
        JSON.parse(payload.toString()); // the app parses it; junk is refused
        signed.push({ app: "cosmos", kind: "amino", path, payload: payload.toString() });
        confirming = true;
        log(`ledger: Cosmos app signs ${payload.length} bytes of amino JSON at ${path}`);
        const sig = secp256k1.sign(keccak_256(payload), keyAt(path).privateKey, { lowS: false });
        return ok([...sig.toDERRawBytes()]);
      }
      return sw(0x6e00);
    }
    // The Ethereum app.
    if (app === "Ethereum" && cla === 0xe0 && (ins === 0x04 || ins === 0x08)) {
      if (p1 === 0x00) {
        const { path, rest } = pathFromBE(data);
        ethSign = { ins, path, data: [] };
        if (ins === 0x08) ethSign.length = rest.readUInt32BE(0);
        ethSign.data.push(Buffer.from(ins === 0x08 ? rest.subarray(4) : rest));
      } else {
        if (!ethSign || ethSign.ins !== ins) return sw(0x6985);
        ethSign.data.push(Buffer.from(data));
      }
      const all = Buffer.concat(ethSign.data);
      let complete;
      if (ins === 0x08) complete = all.length >= ethSign.length;
      else {
        // `0x02 || rlp list`: its header says how long it is.
        if (all[0] !== 0x02) return sw(0x6a80);
        const h = all[1];
        const total = h < 0xf8 ? 2 + (h - 0xc0) : 2 + (h - 0xf7) + all.subarray(2, 2 + (h - 0xf7)).reduce((n, b) => n * 256 + b, 0);
        complete = all.length >= total;
      }
      if (!complete) return ok();
      const { path } = ethSign;
      ethSign = null;
      let hash;
      if (ins === 0x08) {
        hash = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${all.length}`), all]));
        signed.push({ app: "ethereum", kind: "message", path, payload: hex(all) });
      } else {
        hash = keccak_256(all);
        signed.push({ app: "ethereum", kind: "transaction", path, payload: hex(all) });
      }
      log(`ledger: Ethereum app signs a ${ins === 0x08 ? "message" : "transaction"} at ${path}`);
      confirming = true;
      const sig = secp256k1.sign(hash, keyAt(path).privateKey);
      const v = ins === 0x08 ? 27 + sig.recovery : sig.recovery;
      return ok([v, ...sig.toCompactRawBytes()]);
    }
    log(`ledger: no answer for APDU ${hex(a.subarray(0, 4))} in ${app}`);
    return sw(0x6d00);
  }

  /** One 64-byte report from the page. Returns the reports to send back. */
  function report(h) {
    const b = Buffer.from(h, "hex");
    const channel = b.readUInt16BE(0);
    if (b[2] !== 0x05) return [];
    const seq = b.readUInt16BE(3);
    if (seq === 0) rx = { channel, length: b.readUInt16BE(5), data: [b.subarray(7)] };
    else if (rx) rx.data.push(b.subarray(5));
    if (!rx) return [];
    const got = Buffer.concat(rx.data);
    if (got.length < rx.length) return [];
    const reply = apdu(got.subarray(0, rx.length));
    rx = null;
    // Frame the reply: channel, tag 0x05, sequence; the first frame also carries its length.
    const frames = [];
    let rest = Buffer.concat([Buffer.from(u16(reply.length)), reply]);
    for (let s = 0; rest.length > 0 || s === 0; s++) {
      const head = Buffer.from([...u16(channel), 0x05, ...u16(s)]);
      const body = rest.subarray(0, 64 - head.length);
      rest = rest.subarray(body.length);
      frames.push(hex(Buffer.concat([head, body, Buffer.alloc(64 - head.length - body.length)])));
    }
    return frames;
  }

  return {
    report,
    signed,
    /** Whether the last report finished a signing, which a person approves on the device:
     *  the caller can hold the answer back, as a person reading the screen would. */
    confirming() {
      const c = confirming;
      confirming = false;
      return c;
    },
    /** The phrase's public key at `path` (compressed, hex) and its inj1 address. */
    account(path) {
      const pub = keyAt(path).publicKey;
      return { public_key: hex(pub), address: injAddress(pub) };
    },
  };
}
