# Choice Wallet extension

Chrome extension (Manifest V3). The service worker hosts the vault, Rust compiled to WASM
(`crates/wasm`), and answers only the extension's own pages. The popup is the shared UI
([../ui](../ui)) with a `chrome.runtime` backend (`src/popup.ts`). Pre-alpha: not for real
funds.

Licensed GPL-3.0 ([LICENSE](LICENSE)); the Rust crates it uses are Apache-2.0.

## Build

Needs Node 24, Rust (the pinned toolchain) and `wasm-bindgen` exactly 0.2.130. Install and
check from the repo root (npm workspaces):

```sh
npm ci              # at the repo root: scripts off, versions pinned (see ../.npmrc)
npm run check       # TypeScript, ui and extension
npm test            # builds dist/ and dist-test/, runs the tests against the real vault
npm run build       # dist/ only: load it unpacked from chrome://extensions
```

Set `WASM_BINDGEN=/path/to/wasm-bindgen` if it isn't on PATH.

Browser check (Chromium or Chrome for Testing, not branded Chrome):

```sh
npm run e2e -- /path/to/chromium "$PWD/extension/dist" /tmp/shots   # absolute paths
```

## Dependencies

What ships: `react`, `react-dom` (and its `scheduler`). Build only: `esbuild`, `typescript`,
and type definitions. Twelve packages in all, installed with scripts disabled. No
minification, so what ships can be read.
