import assert from "node:assert/strict";
import { test } from "node:test";

import { alignmentPositions, capacity, encodeQr, qrPath, rsDivisor, rsRemainder } from "../src/qr.ts";

test("capacities match the standard's byte-mode table at level M", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(capacity),
    [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  );
});

test("Reed-Solomon matches published vectors", () => {
  // "01234567" at 1-M (the standard's own example) and "HELLO WORLD" at 1-M.
  assert.deepEqual(
    rsRemainder([16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17], rsDivisor(10)),
    [165, 36, 212, 193, 237, 54, 199, 135, 44, 85],
  );
  assert.deepEqual(
    rsRemainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], rsDivisor(10)),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
  );
});

test("alignment pattern centres match the standard", () => {
  const want: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  for (const [v, pos] of Object.entries(want)) assert.deepEqual(alignmentPositions(Number(v)), pos, `version ${v}`);
});

// The BIP-39 test account's address. When this matrix was recorded it was rendered and
// decoded by an independent reader (OpenCV's QRCodeDetector), as was every version from 1
// to 10 and every mask: the matrix is the contract, so a change here must be re-checked.
const ADDRESS = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const GOLDEN = [
  "11111110001010101001101111111",
  "10000010001101011010101000001",
  "10111010110100011000001011101",
  "10111010111101111100101011101",
  "10111010101110000001101011101",
  "10000010111110111110001000001",
  "11111110101010101010101111111",
  "00000000101010111011000000000",
  "10111110001101011111001111100",
  "00100001010101100001101010001",
  "10111011110110011100111001010",
  "00000000000100100010000011011",
  "10110111010111000100000100111",
  "00001100101010101001111111111",
  "10110011010110011110000000100",
  "01010000110000010001010111011",
  "11111110000011110110100001101",
  "11000000000000001001101110011",
  "10001010000100110010110010000",
  "10111100000110000010100101000",
  "10110010100111111100111111111",
  "00000000111111100000100011011",
  "11111110001101011101101010100",
  "10000010101010000011100011011",
  "10111010111100000100111111111",
  "10111010100010001100000001011",
  "10111010110010010010101111110",
  "10000010000000001011110011010",
  "11111110101101100100011100100",
];

test("an address encodes to the recorded matrix", () => {
  const q = encodeQr(ADDRESS);
  assert.equal(q.version, 3);
  assert.equal(q.size, 29);
  assert.deepEqual(
    q.modules.map((r) => r.map((c) => (c ? "1" : "0")).join("")),
    GOLDEN,
  );
});

/** Read the format bits back (first copy) and check them. */
function readFormat(m: boolean[][]): { level: number; mask: number } {
  const b = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  const bits = [
    b(8, 0), b(8, 1), b(8, 2), b(8, 3), b(8, 4), b(8, 5), b(8, 7), b(8, 8), b(7, 8),
    b(5, 8), b(4, 8), b(3, 8), b(2, 8), b(1, 8), b(0, 8),
  ];
  const word = bits.reduce((a, bit, i) => a | (bit << i), 0) ^ 0x5412;
  let rem = word >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(rem & 0x3ff, word & 0x3ff, "format BCH");
  return { level: word >>> 13, mask: (word >>> 10) & 7 };
}

test("finder, timing and format patterns are where readers look", () => {
  for (const text of ["a", ADDRESS, "x".repeat(150), "x".repeat(213)]) {
    for (let mask = 0; mask < 8; mask++) {
      const q = encodeQr(text, mask);
      const m = q.modules;
      const s = q.size;
      for (const [x0, y0] of [[0, 0], [s - 7, 0], [0, s - 7]] as const) {
        for (let dy = 0; dy < 7; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            assert.equal(m[y0 + dy]![x0 + dx], ring !== 2, `finder at ${x0},${y0}`);
          }
        }
      }
      for (let i = 8; i < s - 8; i++) {
        assert.equal(m[6]![i], i % 2 === 0, "timing row");
        assert.equal(m[i]![6], i % 2 === 0, "timing column");
      }
      assert.equal(m[s - 8]![8], true, "dark module");
      assert.deepEqual(readFormat(m), { level: 0, mask });
    }
  }
});

test("versions grow with the text, and too long is refused", () => {
  assert.equal(encodeQr("x".repeat(42)).version, 3);
  assert.equal(encodeQr("x".repeat(43)).version, 4);
  assert.equal(encodeQr("x".repeat(213)).version, 10);
  assert.throws(() => encodeQr("x".repeat(214)), RangeError);
  // UTF-8, not UTF-16: "✓" is three bytes.
  assert.equal(encodeQr("✓".repeat(14)).version, 3);
});

test("the SVG path draws each dark run once, inside the quiet zone", () => {
  const q = encodeQr(ADDRESS);
  const d = qrPath(q);
  let dark = 0;
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    dark += Number(m[3]);
    assert.ok(Number(m[1]) >= 4 && Number(m[2]) >= 4);
  }
  assert.equal(dark, q.modules.flat().filter(Boolean).length);
});
