// The release package: deterministic zip, SHA256SUMS, and the store-package comparison.
import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { checkSums, compare, parseSums, sums, unwrapCrx, unzip, zip } from "../release-kit.mjs";

const manifest = { manifest_version: 3, name: "Choice Wallet", version: "0.1.0", version_name: "0.1.0 (abc)" };
const files = () => [
  ["popup.html", Buffer.from("<!doctype html>")],
  ["background.js", Buffer.from("console.log(1)")],
  ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")],
  ["vault/choice_wallet_wasm_bg.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
  ["assets/inter-ABC.woff2", Buffer.alloc(3000, 7)],
];
const crx = (zipBytes, header = Buffer.from("signed header bytes")) => {
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, zipBytes]);
};
// A zip as other tools write it: deflated entries, a directory entry, an extra field.
const deflatedZip = (entries) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [path, bytes] of entries) {
    const name = Buffer.from(path);
    const data = path.endsWith("/") ? Buffer.alloc(0) : deflateRawSync(bytes);
    const crc = path.endsWith("/") ? 0 : crc32(bytes);
    const size = path.endsWith("/") ? 0 : bytes.length;
    const extra = Buffer.from([0x55, 0x54, 1, 0, 0]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, extra, data);
    central.push(dir, name, extra);
    offset += 30 + name.length + extra.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
};

test("the release zip is the same bytes whatever order the files come in", () => {
  const a = zip(files());
  const b = zip(files().reverse());
  assert.ok(a.equals(b));
  assert.deepEqual(
    unzip(a).map(([p]) => p),
    ["assets/inter-ABC.woff2", "background.js", "manifest.json", "popup.html", "vault/choice_wallet_wasm_bg.wasm"],
  );
  for (const [path, bytes] of files()) assert.ok(new Map(unzip(a)).get(path).equals(bytes), path);
});

test("the zip refuses paths that could escape or collide", () => {
  for (const bad of ["../x.js", "/abs.js", "a//b.js", "a/./b.js", "a\\b.js", ""]) {
    assert.throws(() => zip([[bad, Buffer.from("x")]]), /bad path/, bad);
  }
  assert.throws(() => zip([["a.js", Buffer.from("1")], ["a.js", Buffer.from("2")]]), /duplicate/);
});

test("SHA256SUMS names every file, and a changed byte or file is caught", () => {
  const list = sums(files());
  assert.equal(parseSums(list).size, 5);
  assert.match(list, /^[0-9a-f]{64} {2}assets\/inter-ABC\.woff2\n/);
  assert.deepEqual(checkSums(files(), list), []);
  const changed = files().map(([p, b]) => [p, p === "background.js" ? Buffer.from("console.log(2)") : b]);
  assert.deepEqual(checkSums(changed, list), ["digest differs: background.js"]);
  assert.deepEqual(checkSums([...files(), ["extra.js", Buffer.from("")]], list), ["not in SHA256SUMS: extra.js"]);
  assert.deepEqual(checkSums(files().slice(1), list), ["in SHA256SUMS but not in the zip: popup.html"]);
  assert.throws(() => parseSums("nothex  a.js\n"), /bad SHA256SUMS line/);
});

test("a store package matches its release after the store's own additions", () => {
  const storeManifest = Buffer.from(JSON.stringify({ update_url: "https://clients2.google.com/service/update2/crx", ...manifest }));
  const store = [
    ...files().filter(([p]) => p !== "manifest.json"),
    ["manifest.json", storeManifest],
    ["_metadata/verified_contents.json", Buffer.from("[]")],
  ];
  const pkg = crx(deflatedZip([["_metadata/", Buffer.alloc(0)], ...store]));
  assert.deepEqual(compare(unzip(unwrapCrx(pkg)), unzip(zip(files()))), []);
});

test("any other difference in the store package is reported", () => {
  const release = files();
  const swap = (path, bytes) => release.map(([p, b]) => [p, p === path ? bytes : b]);
  assert.deepEqual(compare(swap("background.js", Buffer.from("console.log(1);fetch('x')")), release), ["differs: background.js"]);
  assert.deepEqual(compare([...release, ["evil.js", Buffer.from("")]], release), ["not in the release: evil.js"]);
  assert.deepEqual(compare(release.slice(1), release), ["missing from the store package: popup.html"]);
  const perms = Buffer.from(JSON.stringify({ ...manifest, permissions: ["tabs"], update_url: "x" }));
  assert.deepEqual(compare(swap("manifest.json", perms), release), ["manifest.json differs beyond the store's update_url"]);
});

test("CRX3 unwrapping checks the header", () => {
  const z = zip(files());
  assert.ok(unwrapCrx(crx(z)).equals(z));
  assert.ok(unwrapCrx(z).equals(z));
  const v2 = crx(z);
  v2.writeUInt32LE(2, 4);
  assert.throws(() => unwrapCrx(v2), /CRX version 2/);
  const long = crx(z);
  long.writeUInt32LE(long.length, 8);
  assert.throws(() => unwrapCrx(long), /truncated/);
});

test("unzip refuses a corrupted entry", () => {
  const z = zip(files());
  const i = z.indexOf("console.log(1)");
  z[i] ^= 1;
  assert.throws(() => unzip(z), /CRC/);
  assert.throws(() => unzip(Buffer.from("not a zip at all, just some bytes")), /not a zip/);
});

// Run-4: Chrome relocates a directory that isn't where the end record says, so any archive it
// could read differently from this check is refused: bytes before (a gap) or after it, or a
// directory walk that doesn't end at the end record.
test("unzip refuses an archive another reader could read differently", () => {
  const z = zip(files());
  assert.ok(unzip(z).length > 0);
  assert.throws(() => unzip(Buffer.concat([Buffer.from("prefix"), z])), /isn't where the end record says/);
  assert.throws(() => unzip(Buffer.concat([z, Buffer.from("tail")])), /after the end record/);
  // A second directory entry claimed by the count but not in the bytes.
  const more = Buffer.from(z);
  const end = more.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  more.writeUInt16LE(more.readUInt16LE(end + 10) - 1, end + 10);
  more.writeUInt16LE(more.readUInt16LE(end + 8) - 1, end + 8);
  assert.throws(() => unzip(more), /more than its entries/);
});

// A zip built entry by entry, with whatever names, extra fields and layout a test needs.
const rawZip = (entries) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "latin1");
    const data = e.data ?? Buffer.alloc(0);
    const crc = crc32(data);
    const extra = e.extra ?? Buffer.alloc(0);
    const flags = e.descriptor ? 8 : 0;
    if (e.gap) {
      parts.push(Buffer.alloc(e.gap));
      offset += e.gap;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    if (!e.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, extra, data, descriptor);
    central.push(dir, name, extra);
    offset += 30 + name.length + extra.length + data.length + descriptor.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
};
// An Info-ZIP Unicode Path field (0x7075) naming the entry `to`, with the CRC of the header name
// `from`, which is when Chrome renames the entry.
const unicodePath = (from, to) => {
  const body = Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from(to)]);
  body.writeUInt32LE(crc32(Buffer.from(from)), 1);
  const head = Buffer.alloc(4);
  head.writeUInt16LE(0x7075, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
};

// Run-5: Chrome names an entry from a Unicode Path extra field and cuts a name at NUL, so a store
// package could install a substituted background.js or manifest.json while this check read the
// genuine bytes under another name. Every name a reader could read another way is refused.
test("unzip refuses an entry Chrome could name differently", () => {
  const genuine = Buffer.from("console.log(1)");
  const injected = Buffer.from("console.log(2)");
  const plain = [{ name: "manifest.json", data: Buffer.from("{}") }];
  assert.equal(unzip(rawZip([...plain, { name: "background.js", data: genuine }])).length, 2);
  // The swap: background.js renamed to _metadata/abc, _metadata/xyz renamed to background.js.
  const upath = rawZip([
    ...plain,
    { name: "background.js", data: genuine, extra: unicodePath("background.js", "_metadata/abc") },
    { name: "_metadata/xyz", data: injected, extra: unicodePath("_metadata/xyz", "background.js") },
  ]);
  assert.throws(() => unzip(upath), /extra field 0x7075/);
  // A Unicode Comment field, a zip64 field and a malformed field are refused the same way.
  for (const extra of [Buffer.from([0x75, 0x63, 1, 0, 0]), Buffer.from([1, 0, 0, 0]), Buffer.from([0x55, 0x54, 9, 0, 0])]) {
    assert.throws(() => unzip(rawZip([...plain, { name: "background.js", data: genuine, extra }])), /extra field/);
  }
  // NUL, control and non-ASCII bytes, in a file or a directory entry.
  for (const name of [Buffer.from("evil.js\0/", "latin1"), Buffer.from("background.js\0x", "latin1"), Buffer.from("a\nb.js"), Buffer.from("café.js")]) {
    assert.throws(() => unzip(rawZip([...plain, { name, data: name.at(-1) === 0x2f ? undefined : genuine }])), /bad path/, JSON.stringify(name.toString("latin1")));
  }
  assert.throws(() => zip([["café.js", genuine]]), /bad path/);
  // A directory entry is a real directory: a good path and no data.
  assert.throws(() => unzip(rawZip([...plain, { name: "js/", data: genuine }])), /directory entry with data/);
  assert.throws(() => unzip(rawZip([...plain, { name: "../" }])), /bad path/);
  assert.equal(unzip(rawZip([...plain, { name: "js/" }, { name: "js/a.js", data: genuine }])).length, 2);
});

// Review: Chrome looks for a zip64 locator anywhere in the archive's last 64 KiB, so one
// hidden in a local extra field, or in the store's signed hashes (left out of the comparison),
// is refused too; and those hashes must be JSON.
test("a zip64 locator anywhere Chrome looks for one is refused", () => {
  const locator = Buffer.from([0x50, 0x4b, 0x06, 0x07, 0, 0, 0, 0]);
  const plain = [{ name: "manifest.json", data: Buffer.from("{}") }];
  const inExtra = Buffer.concat([Buffer.from([0xfe, 0xca, locator.length, 0]), locator]);
  assert.throws(() => unzip(rawZip([...plain, { name: "background.js", data: Buffer.from("x"), extra: inExtra }])), /zip64/);
  assert.throws(() => unzip(rawZip([...plain, { name: "_metadata/verified_contents.json", data: Buffer.concat([Buffer.from("[]"), locator]) }])), /zip64/);
  const release = files();
  assert.deepEqual(compare([...release, ["_metadata/verified_contents.json", Buffer.from("not json")]], release), ["_metadata/verified_contents.json isn't JSON"]);
});

test("unzip refuses bytes between entries, and reads data descriptors", () => {
  const plain = { name: "manifest.json", data: Buffer.from("{}") };
  const second = { name: "background.js", data: Buffer.from("console.log(1)") };
  assert.throws(() => unzip(rawZip([{ ...plain, gap: 64 }, second])), /bytes between entries/);
  assert.throws(() => unzip(rawZip([plain, { ...second, gap: 1 }])), /bytes between entries/);
  assert.equal(unzip(rawZip([plain, { ...second, descriptor: true }])).length, 2);
  const bad = rawZip([plain, { ...second, descriptor: true }]);
  bad.writeUInt32LE(0, bad.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])) + 4);
  assert.throws(() => unzip(bad), /data descriptor disagrees/);
});

test("the store may add only its signed hashes and its own update URL", () => {
  const release = files();
  const withManifest = (m) => release.map(([p, b]) => [p, p === "manifest.json" ? Buffer.from(JSON.stringify(m)) : b]);
  assert.deepEqual(compare(withManifest({ ...manifest, update_url: "https://clients2.google.com/service/update2/crx" }), release), []);
  assert.deepEqual(compare(withManifest({ ...manifest, update_url: "https://updates.example/crx" }), release), [
    "manifest.json differs beyond the store's update_url",
  ]);
  assert.deepEqual(compare([...release, ["_metadata/verified_contents.json", Buffer.from("[]")]], release), []);
  assert.deepEqual(compare([...release, ["_metadata/abc", Buffer.from("console.log(2)")]], release), ["not in the release: _metadata/abc"]);
});
