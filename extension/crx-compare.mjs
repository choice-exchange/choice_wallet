// Checks a Chrome Web Store package against a release.
//
//   node crx-compare.mjs <store.crx> <choice-wallet-X.zip> <SHA256SUMS>
//   node crx-compare.mjs --version <store.crx>     print the package's manifest version
//
// First checks the release zip against its SHA256SUMS, then unwraps the CRX3, leaves out the
// store's own _metadata/ folder and the update_url it adds to manifest.json, and compares every
// other file byte for byte. Exits 1 on any difference. The watchdog workflow runs it against
// the live store package.

import { readFileSync } from "node:fs";

import { checkSums, compare, unwrapCrx, unzip } from "./release-kit.mjs";

const args = process.argv.slice(2);
const fail = (lines) => {
  for (const l of [lines].flat()) console.error(`crx-compare: ${l}`);
  process.exit(1);
};

try {
  if (args[0] === "--version" && args.length === 2) {
    const files = new Map(unzip(unwrapCrx(readFileSync(args[1]))));
    const version = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "{}").version;
    if (typeof version !== "string" || !/^\d+(\.\d+){0,3}$/.test(version)) fail("the package has no valid manifest version");
    console.log(version);
  } else if (args.length === 3) {
    const [crx, release, list] = args;
    const ours = unzip(readFileSync(release));
    const bad = checkSums(ours, readFileSync(list, "utf8"));
    if (bad.length) fail(["the release zip does not match its SHA256SUMS:", ...bad]);
    const problems = compare(unzip(unwrapCrx(readFileSync(crx))), ours);
    if (problems.length) fail(["the store package differs from the release:", ...problems]);
    console.log(`match: ${ours.length} files`);
  } else {
    fail("usage: crx-compare.mjs <store.crx> <release.zip> <SHA256SUMS> | --version <store.crx>");
  }
} catch (e) {
  fail(e.message);
}
