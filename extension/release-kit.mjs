// The release package, written and checked the same way everywhere (release.mjs, crx-compare.mjs).
//
// A release zip is deterministic: the files of dist/ sorted by path, stored (not compressed, so
// no zlib version can change a byte), with a fixed date, 0644 modes and no extra fields. Two
// builds of the same tag give the same zip, and SHA256SUMS names every file in it.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest a zip can say
const UTF8 = 0x0800;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, as sorted `[path, bytes]` with `/` separators. Refuses links and odd files. */
export function filesOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push([path, readFileSync(join(dir, path))]);
      else throw new Error(`not a file: ${path}`);
    }
  };
  walk("");
  return sortFiles(out);
}

const sortFiles = (files) => [...files].sort(([a], [b]) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));

/** The deterministic zip of `files` (`[path, bytes]`). */
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();
  for (const [path, bytes] of sortFiles(files)) {
    checkPath(path);
    if (seen.has(path)) throw new Error(`duplicate path: ${path}`);
    seen.add(path);
    const name = Buffer.from(path, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is read
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(UTF8, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(bytes.length, 20);
    dir.writeUInt32LE(bytes.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, bytes);
    central.push(dir, name);
    offset += local.length + name.length + bytes.length;
    if (offset > 0xffffffff) throw new Error("release too large for a plain zip");
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Printable ASCII only (run-5): every reader names such a path the same way. Chrome cuts a name
// at NUL and reads a name without the UTF-8 flag as CP437, so anything else could name one file
// for Chrome and another for this check.
function checkPath(path) {
  if (
    !path ||
    !/^[\x20-\x7e]+$/.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => p === "" || p === "." || p === "..")
  ) {
    throw new Error(`bad path in package: ${JSON.stringify(path)}`);
  }
}

/** `sha256  path` lines, sorted, the format `sha256sum -c` reads. */
export function sums(files) {
  return sortFiles(files)
    .map(([path, bytes]) => `${sha256(bytes)}  ${path}\n`)
    .join("");
}

/** SHA256SUMS back into a Map of path -> hex digest. */
export function parseSums(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`bad SHA256SUMS line: ${JSON.stringify(line)}`);
    if (out.has(m[2])) throw new Error(`SHA256SUMS names ${m[2]} twice`);
    out.set(m[2], m[1]);
  }
  return out;
}

/** The zip inside a CRX3 package; a plain zip passes through. */
export function unwrapCrx(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "Cr24") return buf;
  if (buf.length < 12) throw new Error("truncated CRX header");
  const version = buf.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version}, expected 3`);
  const start = 12 + buf.readUInt32LE(8);
  if (start > buf.length) throw new Error("truncated CRX header");
  return buf.subarray(start);
}

/** The files of a zip as sorted `[path, bytes]`. Stored and deflated entries only; no zip64. */
export function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip: no end record");
  // Read only an archive every reader reads the same way (run-4): Chrome's unpacker relocates
  // a directory that doesn't sit where the end record says, so an archive with a gap, bytes
  // before or after it, a second directory, more than one disk or zip64 parts could hold other
  // files for Chrome than for this check. Each of those is refused.
  if (end + 22 + buf.readUInt16LE(end + 20) !== buf.length) throw new Error("zip: bytes after the end record");
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0) throw new Error("zip: more than one disk");
  const count = buf.readUInt16LE(end + 10);
  if (buf.readUInt16LE(end + 8) !== count) throw new Error("zip: more than one disk");
  const cdSize = buf.readUInt32LE(end + 12);
  const cdStart = buf.readUInt32LE(end + 16);
  if (cdStart + cdSize !== end) throw new Error("zip central directory isn't where the end record says");
  // No zip64 record or locator anywhere from the directory on, nor where Chrome looks for one
  // (20 bytes before the end record), which may be in the last entry's data.
  for (let i = Math.max(0, Math.min(cdStart, end - 20)); i + 4 <= buf.length; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x07064b50 || sig === 0x06064b50) throw new Error("zip64 archive");
  }
  const files = [];
  const seen = new Set();
  const spans = [];
  let p = cdStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen);
    const path = name.toString("latin1");
    if (p + 46 + nameLen + extraLen + commentLen > end) throw new Error(`bad zip central directory entry: ${JSON.stringify(path)}`);
    checkExtra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), path);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error(`encrypted entry: ${path}`);
    if (csize === 0xffffffff || size === 0xffffffff || at === 0xffffffff) throw new Error(`zip64 entry: ${path}`);
    // A directory is checked like a file (run-5): Chrome reads "evil.js\0/" as the file evil.js.
    const directory = path.endsWith("/");
    checkPath(directory ? path.slice(0, -1) : path);
    if (directory && (csize !== 0 || size !== 0)) throw new Error(`directory entry with data: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate path in zip: ${path}`);
    seen.add(path);
    if (at + 30 > cdStart || buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`bad local header: ${path}`);
    // The local header says what the directory says: same name bytes, method and (unless a data
    // descriptor follows) CRC and sizes, and its extra fields are as plain.
    const localNameLen = buf.readUInt16LE(at + 26);
    const localExtraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + localNameLen + localExtraLen;
    if (start > cdStart) throw new Error(`truncated entry: ${path}`);
    if (!buf.subarray(at + 30, at + 30 + localNameLen).equals(name) || buf.readUInt16LE(at + 8) !== method) {
      throw new Error(`local header disagrees with the directory: ${path}`);
    }
    checkExtra(buf.subarray(at + 30 + localNameLen, start), path);
    if (!(flags & 8) && (buf.readUInt32LE(at + 14) !== crc || buf.readUInt32LE(at + 18) !== csize || buf.readUInt32LE(at + 22) !== size)) {
      throw new Error(`local header disagrees with the directory: ${path}`);
    }
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize || start + csize > cdStart) throw new Error(`truncated entry: ${path}`);
    let stop = start + csize;
    if (flags & 8) {
      // A data descriptor: an optional signature, then the CRC and sizes the directory gives.
      if (stop + 4 <= cdStart && buf.readUInt32LE(stop) === 0x08074b50) stop += 4;
      if (stop + 12 > cdStart || buf.readUInt32LE(stop) !== crc || buf.readUInt32LE(stop + 4) !== csize || buf.readUInt32LE(stop + 8) !== size) {
        throw new Error(`data descriptor disagrees with the directory: ${path}`);
      }
      stop += 12;
    }
    spans.push([at, stop]);
    if (directory) continue;
    const bytes = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!bytes) throw new Error(`unsupported compression ${method}: ${path}`);
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`entry does not match its size or CRC: ${path}`);
    files.push([path, bytes]);
  }
  if (p !== end) throw new Error("zip central directory has more than its entries");
  // The entries fill the archive from its first byte to the directory, one after another, so no
  // bytes are left where another reader could find other entries.
  let next = 0;
  for (const [a, b] of spans.sort(([a], [b]) => a - b)) {
    if (a !== next) throw new Error(a < next ? "overlapping zip entries" : "zip: bytes between entries");
    next = b;
  }
  if (next !== cdStart) throw new Error("zip: bytes between the entries and the directory");
  return sortFiles(files);
}

/** Extra fields as TLV records; the ones that rename an entry (Chrome reads them) or make it zip64 are refused. */
function checkExtra(extra, path) {
  let i = 0;
  while (i < extra.length) {
    if (i + 4 > extra.length) throw new Error(`bad extra field: ${path}`);
    const id = extra.readUInt16LE(i);
    const len = extra.readUInt16LE(i + 2);
    if (i + 4 + len > extra.length) throw new Error(`bad extra field: ${path}`);
    if (id === 0x7075 || id === 0x6375 || id === 0x0001) throw new Error(`extra field 0x${id.toString(16)} in zip entry: ${path}`);
    i += 4 + len;
  }
}

// The Chrome Web Store adds `_metadata/verified_contents.json` (its signed hashes) and the Web
// Store's own `update_url` in manifest.json. Nothing else may differ from the release: any other
// file under `_metadata/` is compared like the rest (run-5), and so is any other update URL.
const STORE_FILE = "_metadata/verified_contents.json";
const STORE_MANIFEST_KEYS = new Map([["update_url", "https://clients2.google.com/service/update2/crx"]]);

/**
 * Compare a store package's files with a release's files. Returns a list of differences (empty
 * when they match).
 */
export function compare(store, release) {
  const problems = [];
  const theirs = new Map(store.filter(([path]) => path !== STORE_FILE));
  const ours = new Map(release);
  for (const [path, bytes] of ours) {
    const other = theirs.get(path);
    if (!other) problems.push(`missing from the store package: ${path}`);
    else if (path === "manifest.json") {
      if (!sameManifest(other, bytes)) problems.push("manifest.json differs beyond the store's update_url");
    } else if (!other.equals(bytes)) problems.push(`differs: ${path}`);
  }
  for (const path of theirs.keys()) if (!ours.has(path)) problems.push(`not in the release: ${path}`);
  return problems;
}

function sameManifest(store, release) {
  let a, b;
  try {
    a = JSON.parse(store.toString("utf8"));
    b = JSON.parse(release.toString("utf8"));
  } catch {
    return false;
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  for (const [key, value] of STORE_MANIFEST_KEYS) {
    if (key in b) continue;
    if (key in a && a[key] !== value) return false;
    delete a[key];
  }
  return canonical(a) === canonical(b);
}

const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** Check a release zip against its SHA256SUMS: the same files, each with its digest. */
export function checkSums(files, text) {
  const want = parseSums(text);
  const problems = [];
  for (const [path, bytes] of files) {
    const digest = want.get(path);
    if (!digest) problems.push(`not in SHA256SUMS: ${path}`);
    else if (digest !== sha256(bytes)) problems.push(`digest differs: ${path}`);
    want.delete(path);
  }
  for (const path of want.keys()) problems.push(`in SHA256SUMS but not in the zip: ${path}`);
  return problems;
}
