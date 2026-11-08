# Choice Wallet

An open-source, self-custody wallet. Injective first (Cosmos side and Injective EVM), then other major chains. Browser extension first, mobile later.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Security model, audit process, dependency budget: [docs/SECURITY.md](docs/SECURITY.md)

## Layout

| Path | What |
| --- | --- |
| `crates/core` | Mnemonic, HD derivation, secp256k1 keys, addresses, encrypted keystore |

## Build and test

The toolchain is pinned in `rust-toolchain.toml`; rustup installs it on first use.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p choice-wallet-core --release --target wasm32-unknown-unknown
```

## Status

Phase 0, pre-alpha. Not for real funds.

## Security

Please report vulnerabilities privately through a GitHub security advisory on this repo, not a public issue. See [docs/SECURITY.md](docs/SECURITY.md).

## License

The Rust crates are Apache-2.0 ([LICENSE](LICENSE)). The extension and mobile apps will be GPL-3.0. "Choice Wallet" and its logo are trademarks, so forks must rebrand.
