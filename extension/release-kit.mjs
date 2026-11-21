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

function checkPath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => p === "" || p === "." || p === "..")) {
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
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  let p = buf.readUInt32LE(end + 16);
  if (p + cdSize > end) throw new Error("zip central directory out of range");
  const files = [];
  const seen = new Set();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const path = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error(`encrypted entry: ${path}`);
    if (csize === 0xffffffff || size === 0xffffffff || at === 0xffffffff) throw new Error(`zip64 entry: ${path}`);
    if (path.endsWith("/")) continue; // a directory
    checkPath(path);
    if (seen.has(path)) throw new Error(`duplicate path in zip: ${path}`);
    seen.add(path);
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`bad local header: ${path}`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error(`truncated entry: ${path}`);
    const bytes = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!bytes) throw new Error(`unsupported compression ${method}: ${path}`);
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`entry does not match its size or CRC: ${path}`);
    files.push([path, bytes]);
  }
  return sortFiles(files);
}

// The Chrome Web Store adds `_metadata/` (its signed hashes) and an `update_url` in manifest.json.
// Nothing else may differ from the release.
const STORE_MANIFEST_KEYS = new Set(["update_url"]);

/**
 * Compare a store package's files with a release's files. Returns a list of differences (empty
 * when they match).
 */
export function compare(store, release) {
  const problems = [];
  const theirs = new Map(store.filter(([path]) => !path.startsWith("_metadata/")));
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
  for (const key of STORE_MANIFEST_KEYS) if (!(key in b)) delete a[key];
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
