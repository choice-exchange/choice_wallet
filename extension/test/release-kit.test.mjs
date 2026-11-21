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
