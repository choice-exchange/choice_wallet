# Choice Wallet extension

Chrome extension (Manifest V3). The service worker hosts the vault, Rust compiled to WASM
(`crates/wasm`), and answers only the extension's own pages. Pre-alpha: not for real funds.

Licensed GPL-3.0 ([LICENSE](LICENSE)); the Rust crates it uses are Apache-2.0.

## Build

Needs Node 24, Rust (the pinned toolchain) and `wasm-bindgen` exactly 0.2.130:

```sh
npm ci              # scripts off, versions pinned (see .npmrc)
npm run check       # TypeScript
npm test            # builds dist/ and dist-test/, runs the tests against the real vault
npm run build       # dist/ only: load it unpacked from chrome://extensions
```

Set `WASM_BINDGEN=/path/to/wasm-bindgen` if it isn't on PATH.

Browser check (Chromium or Chrome for Testing, not branded Chrome):

```sh
npm run e2e -- /path/to/chromium dist /tmp/shots
```

## Dependencies

What ships: `react`, `react-dom` (and its `scheduler`). Build only: `esbuild`, `typescript`,
and type definitions. Twelve packages in all, installed with scripts disabled. No
minification, so what ships can be read.
