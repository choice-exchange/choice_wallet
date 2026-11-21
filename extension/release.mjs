// Builds the release package from a clean checkout of a release tag.
//
//   node release.mjs             HEAD must be the annotated tag v<version>, and the tree clean
//   node release.mjs --snapshot  any checkout; the package says "snapshot" and is never for the store
//
// Writes release/choice-wallet-<version>.zip, release/SHA256SUMS (every file in the zip) and
// release/choice-wallet-<version>.zip.sha256. The zip is deterministic (release-kit.mjs), so
// anyone who builds the same tag gets the same bytes. The release workflow runs this for a
// signed tag; the store gets the zip packed into a CRX with the verified-upload key, and
// crx-compare.mjs checks the live store package against it. See docs/SECURITY.md, Releases.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSums, filesOf, sha256, sums, unzip, zip } from "./release-kit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const snapshot = process.argv.includes("--snapshot");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trimEnd();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const manifestText = readFileSync(join(here, "public/manifest.json"), "utf8");
const version = JSON.parse(manifestText).version;
const packageVersion = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`manifest version "${version}" is not a Chrome version`);
if (packageVersion !== version) fail(`extension/package.json says ${packageVersion}, the manifest ${version}`);

const commit = git("rev-parse", "HEAD");
// Tracked changes, untracked files, and ignored files under public/ (the build copies all of
// public/ into the package, ignored or not).
const changes = git("status", "--porcelain=v1", "--untracked-files=all");
const ignoredPublic = git("status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "--", "extension/public")
  .split("\n")
  .filter((l) => l.startsWith("!! "));
const dirty = Boolean(changes) || ignoredPublic.length > 0;
const tag = `v${version}`;

if (!snapshot) {
  if (dirty) fail(`the tree is not clean:\n${[changes, ...ignoredPublic].filter(Boolean).join("\n")}`);
  const tags = git("tag", "--points-at", "HEAD").split("\n");
  if (!tags.includes(tag)) fail(`HEAD ${commit.slice(0, 12)} is not tagged ${tag}`);
  if (git("cat-file", "-t", tag) !== "tag") fail(`${tag} is a lightweight tag; release tags are annotated and signed`);
}

execFileSync(process.execPath, [join(here, "build.mjs")], { cwd: here, stdio: "inherit" });

// The commit goes into the manifest's version_name, which chrome://extensions shows.
const dist = join(here, "dist");
const manifest = JSON.parse(manifestText);
manifest.version_name = snapshot ? `${version} snapshot ${commit.slice(0, 12)}${dirty ? " dirty" : ""}` : `${version} (${commit.slice(0, 12)})`;
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const files = filesOf(dist);
const pkg = zip(files);
const list = sums(files);
const back = unzip(pkg);
if (back.length !== files.length || checkSums(back, list).length) fail("the package does not read back as written");

const out = join(here, "release");
const name = snapshot ? `choice-wallet-${version}-snapshot-${commit.slice(0, 12)}.zip` : `choice-wallet-${version}.zip`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
writeFileSync(join(out, name), pkg);
writeFileSync(join(out, "SHA256SUMS"), list);
writeFileSync(join(out, `${name}.sha256`), `${sha256(pkg)}  ${name}\n`);
console.log(`${snapshot ? "snapshot (not for the store)" : tag}: ${files.length} files`);
console.log(`${sha256(pkg)}  release/${name}`);
