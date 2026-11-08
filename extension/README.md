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
npm run check       # TypeScript: chain, ui and extension
npm test            # builds dist/ and dist-test/, runs the tests against the real vault
npm run build       # dist/ only: load it unpacked from chrome://extensions
```

Set `WASM_BINDGEN=/path/to/wasm-bindgen` if it isn't on PATH.

## Watching changes

```sh
npm run dev         # at the repo root: builds dist-dev/ and rebuilds on every change
```

Load `extension/dist-dev` unpacked (chrome://extensions, Developer mode, Load unpacked).
It shows as "Choice Wallet (dev)" with a DEV badge. Open the popup, or
`chrome-extension://<its id>/popup.html` in a tab for the same wallet centred on the page.
An open wallet page reloads itself when the UI changes; when the service worker, the vault
or the manifest changes, the whole extension reloads (which locks it, like any update) and
a wallet tab reopens. Dev code lives in `src/dev/` and is only in dev builds. Use a
throwaway wallet on testnet.

Browser check (Chromium or Chrome for Testing, not branded Chrome):

```sh
npm run e2e -- /path/to/chromium "$PWD/extension/dist" /tmp/shots   # absolute paths
npm run e2e -- /path/to/chromium "$PWD/extension/dist" /tmp/shots --live   # also reads mainnet and Choice prices
```

With `E2E_QR_DECODER=/path/to/reader` (any program that prints the text of the QR code in
the PNG it is given), the Receive screenshots are decoded and must match the addresses on
screen.

A real send on testnet, from a funded throwaway wallet (the phrase file is read, never
printed, and the import screen is never captured):

```sh
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> <recipient> 0.5
# or send an ERC20 with no bank denom, added by its contract:
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> <recipient> 250 <token contract>
```

## Dependencies

What ships: `react`, `react-dom` (and its `scheduler`). Build only: `esbuild`, `typescript`,
and type definitions. Twelve packages in all, installed with scripts disabled. No
minification, so what ships can be read.
