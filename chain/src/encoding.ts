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
