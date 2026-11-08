# Choice Wallet

An open-source, self-custody wallet. Injective first (Cosmos side and Injective EVM), then other major chains. Browser extension first, mobile later.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Security model, audit process, dependency budget: [docs/SECURITY.md](docs/SECURITY.md)

## Layout

| Path | What |
| --- | --- |
| `crates/core` | Mnemonic, HD derivation, secp256k1 keys, addresses, encrypted keystore |
| `crates/cosmos` | Cosmos SDK sign paths (Direct, amino JSON), message decoding (sends, contract calls, grants, admin changes) and builders, for any chain given its profile |
| `crates/injective` | Injective networks, CW20 ⇄ bank conversions through the CW20 adapter, EIP-712 v2 decoding |
| `crates/evm` | EIP-1559 transactions (native INJ and ERC20 transfers), `eth_sendTransaction` requests, EIP-712 typed data |
| `crates/policy` | Risk rules: grades every decoded request (grants, allowances, permits, precompile calls, sign-in messages, balances, lookalike addresses) |
| `crates/vault` | The vault protocol: one JSON entry point (`handle`) for every host: keystores, accounts, building sends, decode → approve → sign |
| `crates/wasm` | The vault compiled to WASM for the extension |
| `chain` | The chain client (TypeScript, GPL-3.0): user-settable endpoints with failover, bank, CW20 and ERC20 balances, gas estimates, broadcasting, token names, activity (Cosmos and EVM transactions). No keys |
| `ui` | The wallet's screens (React, GPL-3.0), shared by every platform. Talks to its host only through a small `Backend` interface. See [ui/README.md](ui/README.md) |
| `extension` | The Chrome extension (GPL-3.0): the service worker hosts the vault and answers the UI; the popup is `ui` with a `chrome.runtime` backend. See [extension/README.md](extension/README.md) |
| `tools/protogen` | Dev only: vendors `.proto` files and regenerates the committed prost code |
| `tools/vectors` | Dev only: generates test vectors with injective-ts and viem |

## Build and test

The toolchain is pinned in `rust-toolchain.toml`; rustup installs it on first use.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --release --target wasm32-unknown-unknown
```

The chain client, the UI and the extension are npm workspaces, installed and checked from the repo root. The extension build needs the `wasm-bindgen` CLI at exactly 0.2.130, the crate's version (set `WASM_BINDGEN` if it isn't on PATH):

```sh
npm ci           # scripts off, exact versions (see .npmrc)
npm run check    # TypeScript: chain, ui and extension
npm test         # the chain client's tests, the UI's (QR encoder, token filter), then the extension's against the real vault
npm run dev      # a dev build that rebuilds and reloads itself in Chrome on every change (see extension/README.md)
```

Regenerating protobuf code or test vectors (not needed for a normal build):

```sh
(cd tools/protogen && cargo run --release -- gen)
(cd tools/vectors && npm ci && npm run gen)
```

## Status

Phase 0, pre-alpha. Not for real funds.

## Security

Please report vulnerabilities privately through a GitHub security advisory on this repo, not a public issue. See [docs/SECURITY.md](docs/SECURITY.md).

## License

The Rust crates are Apache-2.0 ([LICENSE](LICENSE)). The chain client, the UI and the extension are GPL-3.0, and so will the desktop and mobile apps be. "Choice Wallet" and its logo are trademarks, so forks must rebrand.
