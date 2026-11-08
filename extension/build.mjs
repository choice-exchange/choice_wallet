// Builds the extension into dist/: the vault (Rust → WASM → wasm-bindgen glue), the
// service worker and popup bundles (esbuild), and the static files.
//
//   node build.mjs           build dist/ (load it unpacked in Chrome)
//   node build.mjs --test    also build dist-test/, which `node --test` runs
//
// Needs cargo and wasm-bindgen exactly 0.2.130, the crate's version. Set WASM_BINDGEN to
// its path if it isn't on PATH.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const WASM_BINDGEN_VERSION = "0.2.130";
const wasmBindgen = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const withTests = process.argv.includes("--test");

// 1. The vault.
execFileSync("cargo", ["build", "--release", "-p", "choice-wallet-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: repo,
  stdio: "inherit",
});
const version = execFileSync(wasmBindgen, ["--version"]).toString().trim();
if (version !== `wasm-bindgen ${WASM_BINDGEN_VERSION}`) {
  throw new Error(`need wasm-bindgen ${WASM_BINDGEN_VERSION}, found "${version}"`);
}
const glue = join(here, "build/vault");
rmSync(glue, { recursive: true, force: true });
execFileSync(
  wasmBindgen,
  ["--target", "web", "--out-dir", glue, join(repo, "target/wasm32-unknown-unknown/release/choice_wallet_wasm.wasm")],
  { stdio: "inherit" },
);

// 2. Bundles. No minification, so a store reviewer (or anyone) can read what ships.
const common = {
  absWorkingDir: here,
  bundle: true,
  format: "esm",
  charset: "utf8",
  alias: { "choice-wallet-vault-glue": join(glue, "choice_wallet_wasm.js") },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  logLevel: "warning",
};
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
await build({
  ...common,
  platform: "browser",
  target: "chrome120",
  entryPoints: { background: "src/background.ts", popup: "src/popup/main.tsx" },
  outdir: dist,
});
cpSync(join(here, "public"), dist, { recursive: true });
mkdirSync(join(dist, "vault"), { recursive: true });
cpSync(join(glue, "choice_wallet_wasm_bg.wasm"), join(dist, "vault/choice_wallet_wasm_bg.wasm"));
console.log(`built ${dist}`);

// 3. Tests, run against the same WASM vault.
if (withTests) {
  const out = join(here, "dist-test");
  rmSync(out, { recursive: true, force: true });
  const entryPoints = readdirSync(join(here, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join("test", f));
  await build({ ...common, platform: "node", target: "node22", entryPoints, outdir: out });
  cpSync(join(glue, "choice_wallet_wasm_bg.wasm"), join(out, "choice_wallet_wasm_bg.wasm"));
}
