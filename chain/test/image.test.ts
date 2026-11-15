// Run-2 NV1: an added chain's logo is read by its own header, never drawn as an SVG, and only
// decoded when it declares a sane size.

import assert from "node:assert/strict";
import { test } from "node:test";

import { imageSize, isChainLogo } from "../src/image.ts";

// A 1x1 PNG, and the same header declaring another size (the CRC isn't checked here).
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const pngOf = (w: number, h: number) => {
  const b = PNG.slice();
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const url = (b: Uint8Array, type = "image/png") => `data:${type};base64,${Buffer.from(b).toString("base64")}`;

test("an image's format and size come from its header", () => {
  assert.deepEqual(imageSize(PNG), { type: "image/png", width: 1, height: 1 });
  assert.deepEqual(imageSize(pngOf(30_000, 20)), { type: "image/png", width: 30_000, height: 20 });
  // JPEG: an APP0 segment, then a baseline frame of 640 by 480.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { type: "image/jpeg", width: 640, height: 480 });
  // WebP, each kind of header.
  const riff = (chunk: string, body: number[]) => Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk), 0, 0, 0, 0, ...body, ...new Array(16).fill(0)]);
  assert.deepEqual(imageSize(riff("VP8X", [0, 0, 0, 0, 99, 0, 0, 49, 0, 0])), { type: "image/webp", width: 100, height: 50 });
  assert.deepEqual(imageSize(riff("VP8L", [0x2f, 63 | 0, (31 << 6) & 0xff, 31 >> 2, 0])), { type: "image/webp", width: 64, height: 32 });
  assert.deepEqual(imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 48, 0])), { type: "image/webp", width: 64, height: 48 });
  // An SVG, text, nothing, or a cut-off header: not an image the wallet decodes.
  for (const b of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from("not an image"), new Uint8Array(0), PNG.slice(0, 20), pngOf(0, 1)]) {
    assert.equal(imageSize(Uint8Array.from(b)), null);
  }
});

test("a chain logo is drawn only as a small PNG", () => {
  assert.ok(isChainLogo(url(PNG)));
  assert.ok(isChainLogo(url(pngOf(64, 64))));
  // A PNG declaring a huge picture, an SVG, a JPEG, or anything that isn't a data URL.
  for (const s of [url(pngOf(4096, 4096)), url(Buffer.from("<svg/>"), "image/svg+xml"), url(PNG, "image/jpeg"), "https://example.org/logo.png", `${url(PNG)}"`, 5]) {
    assert.ok(!isChainLogo(s), String(s).slice(0, 40));
  }
});
