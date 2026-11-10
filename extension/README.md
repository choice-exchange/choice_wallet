# Choice Wallet extension

Chrome extension (Manifest V3). The service worker hosts the vault, Rust compiled to WASM
(`crates/wasm`), and answers the extension's own pages, and web pages only through its
content scripts, by the origin the browser reports. The popup is the shared UI
([../ui](../ui)) with a `chrome.runtime` backend (`src/popup.ts`); the same page, opened as
`popup.html?approve=<id>`, is a site's approval window. Sites reach the wallet through two
content scripts: `src/inpage.ts` (the EIP-6963 provider and `window.choice`, in the page's
world) and `src/relay.ts` (isolated world, carries messages). Pre-alpha: not for real
funds.

Licensed GPL-3.0 ([LICENSE](LICENSE)); the Rust crates it uses are Apache-2.0.

## Layout

`src/` holds one entry point per place the extension's code runs, each bundled on its own:

| File | Runs |
| --- | --- |
| `background.ts` | The service worker: the vault's WASM, `chrome.*`, and `host/` |
| `popup.ts` | The wallet's pages (the popup, approval windows, the Ledger tab): the shared UI |
| `ledger.ts` | Loaded by those pages the first time a Ledger is asked for |
| `inpage.ts` | Inside every web page, in the page's own world: what sites see |
| `relay.ts` | Inside every web page, in the isolated world: carries messages |
| `dev/` | Dev builds only |

`src/host/` is the service worker's logic, with no `chrome.*`, so the tests run all of it:
`service.ts` answers the UI and routes everything else; `wallets.ts` and `vault.ts` the keys;
then one file (or folder) per feature: `holdings.ts` and `send.ts`, `swap.ts`, `staking.ts`,
`bridge/` (out, in from EVM chains, in from Solana), `solana.ts`, `dapp/` (sites: EVM,
Cosmos and Solana requests, and the approval window's side), `approvals.ts`, `rescue.ts`,
`contacts.ts`, `nfts.ts`, `inventory.ts`, and `watch.ts` (the background watcher), with
`cache.ts` and `snapshots.ts` keeping chain data on disk.

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
# or send an ERC20 with no bank denom, added by its contract (0x…):
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> <recipient> 250 <token contract>
# or a CW20 (inj1…): send it, convert that much to its bank form, and all of that back:
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> <recipient> 125 <cw20 contract>
# or a test site on 127.0.0.1, through the provider: connect, eth_sendTransaction, and a
# bank send signed with window.choice signDirect and broadcast with sendTx:
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> <recipient> 0.001 site
# or no send: print Activity as testnet's endpoints and Blockscout give it (EVM rows included):
node extension/e2e-live.mjs /path/to/chromium "$PWD/extension/dist" /tmp/shots <phrase file> none 0 activity
```

The other modes (staking, approvals, NFTs, rescue, notifications, swaps, the bridge, Solana
and a Solana site) are described at the top of `e2e-live.mjs`.

## Dependencies

What ships, all installed with scripts disabled and none minified, so it can be read:

- `react`, `react-dom` (and its `scheduler`): the UI.
- `injective-usdc-bridge` with `@noble/curves`, `@noble/hashes` and `@scure/base`: Circle's
  CCTP and Solana transactions.
- Ledger's Device Management Kit, its WebHID transport and Cosmos signer (with `rxjs`,
  `xstate`, `inversify`, `purify-ts`, `uuid`, `semver` and helpers), in a chunk loaded only
  when a Ledger is used. It brings `@sentry/minimal`, which only hands errors to a Sentry
  client that nothing here sets up: no Sentry client or transport ships, so nothing is
  reported.

Build only: `esbuild`, `typescript`, and type definitions.
