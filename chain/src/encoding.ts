// Hex ⇄ bytes ⇄ base64, and the Cosmos transaction hash. Web APIs only, so the same code
// runs in a service worker, a web view and Node.

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new RangeError("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBase64(hex: string): string {
  let bin = "";
  for (const b of hexToBytes(hex)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A Cosmos transaction's hash, as explorers and `/txs/{hash}` show it: SHA-256 of the
 *  broadcast bytes, uppercase hex. Known before broadcasting. */
export async function cosmosTxHash(txRawHex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", hexToBytes(txRawHex) as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest)).toUpperCase();
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin's alphabet), as Solana writes addresses, signatures and instruction data. */
export function base58ToBytes(s: string): Uint8Array {
  const zeros = s.length - s.replace(/^1+/, "").length;
  const bytes: number[] = [];
  for (const c of s.slice(zeros)) {
    let carry = BASE58.indexOf(c);
    if (carry < 0) throw new RangeError("not base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function bytesToBase58(bytes: Uint8Array): string {
  const zeros = bytes.findIndex((b) => b !== 0);
  const lead = zeros < 0 ? bytes.length : zeros;
  const digits: number[] = [];
  for (const b of bytes.slice(lead)) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(lead) + digits.reverse().map((d) => BASE58[d]).join("");
}

/** A 32-byte Solana address in base58. */
export function isSolanaAddress(s: string): boolean {
  try {
    return base58ToBytes(s).length === 32;
  } catch {
    return false;
  }
}
