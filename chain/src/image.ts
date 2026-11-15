// What an image says about itself in its first bytes: its format and its size in pixels.
// A chain's logo comes from a list or a site, so it is checked by these before anything
// decodes it: a small file can declare a huge picture, and an SVG can be made to cost any
// amount of memory to draw (run-2 NV1).

import { base64ToBytes } from "./encoding.ts";

export type RasterType = "image/png" | "image/jpeg" | "image/webp";

/** A PNG, JPEG or WebP's format and declared size, from its header. Null for anything else
 *  (SVG included) or a header that can't be read. */
export function imageSize(b: Uint8Array): { type: RasterType; width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const is = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  // PNG: the signature, then IHDR first, its width and height big-endian.
  if (b.length >= 24 && b[0] === 0x89 && is(1, "PNG\r\n\x1a\n") && is(12, "IHDR")) {
    return sized("image/png", u32be(16), u32be(20));
  }
  // JPEG: markers up to the first start-of-frame, which holds the size.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      // Markers without a length: the restarts, and the image's start and end.
      if ((m >= 0xd0 && m <= 0xd9) || m === 0x01) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return sized("image/jpeg", u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  // WebP: a RIFF container, then a lossy, lossless or extended header.
  if (b.length >= 30 && is(0, "RIFF") && is(8, "WEBP")) {
    if (is(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized("image/webp", (b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff);
    if (is(12, "VP8L") && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (is(12, "VP8X")) return sized("image/webp", u24le(24) + 1, u24le(27) + 1);
  }
  return null;
}

function sized(type: RasterType, width: number, height: number) {
  return width > 0 && height > 0 ? { type, width, height } : null;
}

/** The side of the logo the wallet keeps for an added chain (a PNG it draws itself). */
export const LOGO_SIDE = 64;

/** A logo the wallet kept: a PNG data URL, no bigger than the wallet draws one. Anything else,
 *  whatever an older version or a stored record holds, is dropped rather than drawn. */
export function isChainLogo(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 128 * 1024) return false;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) return false;
  try {
    const head = imageSize(base64ToBytes(m[1]!.slice(0, 44)));
    return head !== null && head.type === "image/png" && head.width <= LOGO_SIDE * 4 && head.height <= LOGO_SIDE * 4;
  } catch {
    return false;
  }
}
