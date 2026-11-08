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
| `crates/evm` | EIP-1559 transactions (native INJ and ERC20 transfers), EIP-712 typed data |
| `tools/protogen` | Dev only: vendors `.proto` files and regenerates the committed prost code |
| `tools/vectors` | Dev only: generates test vectors with injective-ts and viem |

## Build and test

The toolchain is pinned in `rust-toolchain.toml`; rustup installs it on first use.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace --release --target wasm32-unknown-unknown
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

The Rust crates are Apache-2.0 ([LICENSE](LICENSE)). The extension and mobile apps will be GPL-3.0. "Choice Wallet" and its logo are trademarks, so forks must rebrand.
