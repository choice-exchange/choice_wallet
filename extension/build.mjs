// Builds the extension: the vault (Rust → WASM → wasm-bindgen glue), the service worker and
// popup bundles (esbuild; the popup is the shared UI in ../ui), and the static files.
//
//   node build.mjs           build dist/ (load it unpacked in Chrome)
//   node build.mjs --test    also build dist-test/, which `node --test` runs
//   node build.mjs --dev     build dist-dev/ and keep rebuilding on every change (see below)
//
// Needs cargo and wasm-bindgen exactly 0.2.130, the crate's version. Set WASM_BINDGEN to
// its path if it isn't on PATH.
//
// Dev builds (`npm run dev`) are for watching changes land: "Choice Wallet (dev)" with a DEV
// badge, built into dist-dev/ so a release build never carries dev code. After each rebuild
// dist-dev/dev-build.json gets new hashes; an open wallet page polls it and reloads itself
// when the UI changed, or reloads the whole extension when the service worker, the vault or
// the manifest did (that locks the wallet, like any extension update).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, context } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const WASM_BINDGEN_VERSION = "0.2.130";
const wasmBindgen = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const withTests = process.argv.includes("--test");
const dev = process.argv.includes("--dev");
const glue = join(here, "build/vault");
const dist = join(here, dev ? "dist-dev" : "dist");

// 1. The vault.
function buildVault() {
  // --locked: exactly Cargo.lock's crates. The path remaps keep the builder's home directory
  // (and so their user name) out of the WASM, and make it the same wherever it is built.
  const home = homedir();
  const remap = [
    [process.env.CARGO_HOME ?? join(home, ".cargo"), "/cargo"],
    [process.env.RUSTUP_HOME ?? join(home, ".rustup"), "/rustup"],
    [repo, "/choice_wallet"],
  ].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  execFileSync("cargo", ["build", "--locked", "--release", "-p", "choice-wallet-wasm", "--target", "wasm32-unknown-unknown"], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, ...remap].filter(Boolean).join(" ") },
  });
  const version = execFileSync(wasmBindgen, ["--version"]).toString().trim();
  if (version !== `wasm-bindgen ${WASM_BINDGEN_VERSION}`) {
    throw new Error(`need wasm-bindgen ${WASM_BINDGEN_VERSION}, found "${version}"`);
  }
  rmSync(glue, { recursive: true, force: true });
  execFileSync(
    wasmBindgen,
    ["--target", "web", "--out-dir", glue, join(repo, "target/wasm32-unknown-unknown/release/choice_wallet_wasm.wasm")],
    { stdio: "inherit" },
  );
  // A trap (a Rust panic aborts) leaves the instance's memory and stack as they were, and the
  // glue keeps that instance for good. `resetVault` drops it, so the next init makes a fresh
  // one. It names the glue's own variables, so check they are still what this expects.
  const js = join(glue, "choice_wallet_wasm.js");
  const code = readFileSync(js, "utf8");
  for (const needed of ["let wasmModule, wasmInstance, wasm;", "let __wbg_init_promise;", "let cachedUint8ArrayMemory0 = null;"]) {
    if (!code.includes(needed)) throw new Error(`the vault glue changed: no "${needed}"`);
  }
  writeFileSync(
    js,
    `${code}\n/** Drop the instance (after a trap): the next init or initSync makes a fresh one. */\nexport function resetVault() {\n    wasm = undefined;\n    wasmInstance = undefined;\n    wasmModule = undefined;\n    __wbg_init_promise = undefined;\n    cachedUint8ArrayMemory0 = null;\n}\n`,
  );
}

/** The static files, and the vault's WASM. A dev build names itself and loads dev.js. */
function copyStatic() {
  cpSync(join(here, "public"), dist, { recursive: true });
  mkdirSync(join(dist, "vault"), { recursive: true });
  cpSync(join(glue, "choice_wallet_wasm_bg.wasm"), join(dist, "vault/choice_wallet_wasm_bg.wasm"));
  if (dev) {
    const manifest = JSON.parse(readFileSync(join(here, "public/manifest.json"), "utf8"));
    manifest.name = `${manifest.name} (dev)`;
    manifest.action.default_title = `${manifest.action.default_title} (dev)`;
    writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const page = readFileSync(join(here, "public/popup.html"), "utf8");
    writeFileSync(join(dist, "popup.html"), page.replace("</body>", '  <script type="module" src="dev.js"></script>\n  </body>'));
  }
}

// 2. Bundles. No minification, so a store reviewer (or anyone) can read what ships.
const common = {
  absWorkingDir: here,
  bundle: true,
  format: "esm",
  charset: "utf8",
  alias: { "choice-wallet-vault-glue": join(glue, "choice_wallet_wasm.js") },
  // The UI's font and images ship inside the extension; nothing is fetched at runtime.
  loader: { ".woff2": "file", ".png": "file", ".svg": "file" },
  assetNames: "assets/[name]-[hash]",
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  legalComments: "eof",
  logLevel: "warning",
};
const app = {
  ...common,
  platform: "browser",
  target: "chrome120",
  entryPoints: { background: dev ? "src/dev/background.ts" : "src/background.ts" },
  outdir: dist,
};
// The pages, split: what a Ledger needs (./src/ledger.ts and its packages, most of the
// code) is its own file under chunks/, loaded the first time a Ledger is asked for.
const pages = {
  ...app,
  entryPoints: dev ? { popup: "src/popup.ts", dev: "src/dev/page.ts" } : { popup: "src/popup.ts" },
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
};
// The content scripts: classic scripts, not modules. The provider's EIP-6963 icon is the
// mark as a data URL, as the standard asks.
const content = {
  ...common,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  loader: { ...common.loader, ".svg": "dataurl" },
  entryPoints: { inpage: "src/inpage.ts", relay: "src/relay.ts" },
  outdir: dist,
};

if (!dev) {
  buildVault();
  rmSync(dist, { recursive: true, force: true });
  await build(app);
  await build(pages);
  await build(content);
  copyStatic();
  console.log(`built ${dist}`);

  // 3. Tests, run against the same WASM vault.
  if (withTests) {
    const out = join(here, "dist-test");
    rmSync(out, { recursive: true, force: true });
    const entryPoints = readdirSync(join(here, "test"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => join("test", f));
    // react-dom/server (the approval window's render tests) requires Node's built-ins.
    const banner = { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' };
    await build({ ...common, platform: "node", target: "node22", entryPoints, outdir: out, banner });
    cpSync(join(glue, "choice_wallet_wasm_bg.wasm"), join(out, "choice_wallet_wasm_bg.wasm"));
  }
} else {
  // Watch mode: esbuild follows the UI, chain and extension sources itself; the Rust crates
  // and public/ are watched here.
  const digest = (files) => {
    const h = createHash("sha256");
    for (const f of files) h.update(existsSync(join(dist, f)) ? readFileSync(join(dist, f)) : "");
    return h.digest("hex").slice(0, 16);
  };
  const stamp = () => {
    const assets = existsSync(join(dist, "assets")) ? readdirSync(join(dist, "assets")).map((f) => `assets/${f}`).sort() : [];
    const chunks = existsSync(join(dist, "chunks")) ? readdirSync(join(dist, "chunks")).map((f) => `chunks/${f}`).sort() : [];
    const s = {
      page: digest(["popup.js", "popup.css", "popup.html", "shell.css", ...assets, ...chunks]),
      worker: digest(["background.js", "inpage.js", "relay.js", "manifest.json", "vault/choice_wallet_wasm_bg.wasm"]),
    };
    writeFileSync(join(dist, "dev-build.json"), JSON.stringify(s) + "\n");
    console.log(`[dev] ${new Date().toLocaleTimeString()} page ${s.page} worker ${s.worker}`);
  };
  const debounce = (fn, ms = 300) => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };

  buildVault();
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  copyStatic();
  const devStamp = {
    name: "dev-stamp",
    setup(b) {
      b.onEnd((r) => {
        if (r.errors.length === 0) stamp();
      });
    },
  };
  for (const options of [app, pages, content]) await (await context({ ...options, plugins: [devStamp] })).watch();

  watch(join(here, "public"), { recursive: true }, debounce(() => (copyStatic(), stamp())));
  const vault = debounce(() => {
    try {
      buildVault(); // a new glue file also wakes esbuild, which stamps
      copyStatic();
      stamp();
    } catch (e) {
      console.error(`[dev] vault build failed: ${e.message}`);
    }
  }, 500);
  watch(join(repo, "crates"), { recursive: true }, vault);
  console.log(`[dev] watching; load ${dist} unpacked in Chrome (chrome://extensions, Developer mode, Load unpacked)`);
}
