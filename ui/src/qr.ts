// QR codes for the Receive screen (ISO/IEC 18004). Byte mode, error correction level M,
// versions 1 to 10: up to 213 bytes, which covers any address with room to spare. Written
// here rather than pulled in, like the rest of what ships.
//
// The layout follows the standard: function patterns, then the data and error correction
// codewords in the zigzag order, then the mask with the lowest penalty score.

export type QrMatrix = {
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
  version: number;
  mask: number;
};

const MAX_VERSION = 10;
/** Error correction codewords per block, and blocks, at level M (versions 1 to 10). */
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits for level M. */
const LEVEL_M = 0b00;

/** Encode `text` (as UTF-8) in the smallest version that holds it. `forceMask` is for
 *  tests; otherwise the standard's penalty picks it. */
export function encodeQr(text: string, forceMask?: number): QrMatrix {
  const data = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && capacity(version) < data.length) version++;
  if (version > MAX_VERSION) throw new RangeError(`too long for a QR code here (${data.length} bytes)`);
  const codewords = interleave(version, dataCodewords(version, data));

  const size = version * 4 + 17;
  const modules = grid(size);
  const reserved = grid(size);
  drawFunctionPatterns(version, modules, reserved);
  drawCodewords(codewords, modules, reserved);

  let best = forceMask ?? -1;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8 && forceMask === undefined; mask++) {
    applyMask(mask, modules, reserved);
    drawFormat(mask, modules, reserved);
    const score = penalty(modules);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask, modules, reserved); // XOR again: undone
  }
  applyMask(best, modules, reserved);
  drawFormat(best, modules, reserved);
  return { size, modules, version, mask: best };
}

/** Bytes a version holds at level M in byte mode. */
export function capacity(version: number): number {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits) / 8);
}

function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewordCount(version: number): number {
  return Math.floor(rawModules(version) / 8) - EC_PER_BLOCK[version]! * BLOCKS[version]!;
}

/** Mode, count, the bytes, terminator and padding: the data codewords. */
function dataCodewords(version: number, data: Uint8Array): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(data.length, version < 10 ? 8 : 16);
  for (const b of data) put(b, 8);
  const capacityBits = dataCodewordCount(version) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacityBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add each block's error correction, and interleave. */
function interleave(version: number, data: number[]): number[] {
  const blocks = BLOCKS[version]!;
  const ecLen = EC_PER_BLOCK[version]!;
  const total = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (total % blocks);
  const shortLen = Math.floor(total / blocks) - ecLen;
  const divisor = rsDivisor(ecLen);
  const split: { data: number[]; ec: number[] }[] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    split.push({ data: d, ec: rsRemainder(d, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen; i++) for (const b of split) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of split) out.push(b.ec[i]!);
  return out;
}

/** Multiply in GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed-Solomon generator polynomial of this degree (leading 1 left out). */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root) ^ (j + 1 < degree ? result[j + 1]! : 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Error correction codewords for `data`. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMul(coef, factor)));
  }
  return result;
}

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function drawFunctionPatterns(version: number, m: boolean[][], fn: boolean[][]): void {
  const size = m.length;
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(0, m, fn); // reserves the format areas; the real bits come with the mask
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let p = version * 4 + 10; out.length < count; p -= step) out.splice(1, 0, p);
  return out;
}

/** The 15 format bits (level M and the mask, BCH-protected), in both copies. */
function drawFormat(mask: number, m: boolean[][], fn: boolean[][]): void {
  const size = m.length;
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module
}

function drawCodewords(data: readonly number[], m: boolean[][], fn: boolean[][]): void {
  const size = m.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing pattern
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y]![x] || i >= data.length * 8) continue;
        m[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(mask: number, m: boolean[][], fn: boolean[][]): void {
  const f = MASKS[mask]!;
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (!fn[y]![x] && f(x, y)) m[y]![x] = !m[y]![x];
}

/** The standard's four penalty rules; the mask with the lowest score is used. */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    // Rule 1: runs of five or more of one colour.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    // Rule 3: 1:1:3:1:1 finder look-alikes with four light modules on either side
    // (outside the symbol counts as light: the quiet zone).
    const at = (i: number) => i >= 0 && i < size && get(i);
    for (let i = -4; i < size; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) continue;
      if (!at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4)) score += 40;
      if (!at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10)) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => m[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => m[y]![x]!);
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  // Rule 4: dark modules far from half.
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** An SVG path of the dark modules, one subpath per horizontal run, offset by `quiet`. */
export function qrPath(q: QrMatrix, quiet = 4): string {
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; ) {
      if (!q.modules[y]![x]) {
        x++;
        continue;
      }
      let len = 1;
      while (x + len < q.size && q.modules[y]![x + len]) len++;
      d += `M${x + quiet} ${y + quiet}h${len}v1h-${len}z`;
      x += len;
    }
  }
  return d;
}
