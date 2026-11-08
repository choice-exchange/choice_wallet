# Security model and audit process

We build and audit Choice Wallet in house, in the open. This file covers what we defend against, how every change gets reviewed, and how releases ship.

## Threat model

| Threat | In scope | Defence |
| --- | --- | --- |
| Phishing site asks for a harmful signature | Yes | Decode, simulate and risk rules; friction scaled to risk |
| Dapp or our own UI misdescribes a request | Yes | The vault decodes the exact bytes it signs. Non-canonical bytes are refused |
| Request for the wrong chain (testnet/mainnet replay) | Yes | Chain ID checked against the connected chain before signing |
| Web page sends privileged messages (unlock, approve, export) | Yes | The service worker accepts them only from its own extension pages (`sender.id`, `sender.url`) |
| Approval reused for a different request | Yes | Approvals are single-use and bound to the request ID. The vault re-decodes at signing and signs only if the digest of the kind, chain, signer and exact signed bytes matches the approved one |
| Clickjacking or a spoofed approval window | Yes | Buttons disabled ~800 ms after focus; no password entry in approval windows; anti-phishing phrase on the unlock screen |
| Compromised JavaScript dependency in an extension page | Yes | Every extension page can read the unlocked key, so shipped JS has its own dependency budget, Trusted Types and a strict CSP |
| Malicious RPC lies about balances or simulation | Partly | Several RPCs, user-settable; dapp-suggested RPCs never used for checks; simulation names its RPC. Light-client proofs in phase 3 |
| Stolen keystore file | Yes | Argon2id 64 MiB + XChaCha20-Poly1305; header authenticated; uniform decrypt error |
| Malicious update pushed through the store | Partly | Verified uploads, group publisher account with hardware keys, reproducible builds, a public watchdog. See Releases for what remains |
| Malicious dependency (Rust) | Yes | Dependency budget, pinned lockfile, review of every lockfile diff |
| Third party signs with the user's key | Yes | No third party ever holds key material or shares of it |
| Malware on the user's machine with full control | No | No software wallet can defend this. Use a hardware wallet for large balances |

## Rules for vault code

The vault is `choice-wallet-core`, `choice-wallet-cosmos`, `choice-wallet-injective`, `choice-wallet-evm`, `choice-wallet-vault`, `choice-wallet-wasm` and, next, the policy crate.

- `#![forbid(unsafe_code)]` in every vault crate, except `choice-wallet-wasm`: the glue `#[wasm_bindgen]` generates uses `unsafe`. That crate is one function and contains no `unsafe` of its own.
- Secrets are zeroized on drop (`Zeroizing`, `ZeroizeOnDrop`). `Debug` on secret types prints `<redacted>`.
- No logging of secrets, seeds, private keys, passwords or derived keys. Errors never include secret material.
- Decrypt failures return one error for wrong password and corrupted data.
- Decoders refuse anything they can't round-trip byte for byte, recursing into every nested `Any`.
- Signing functions take decoded request objects, not raw bytes, so nothing can be signed without being decoded first.

### Known limits

- `bip32` 0.6 wipes the private key on drop (through k256) but not the chain code. A chain code alone reveals no key.
- Zeroize is best-effort once a secret crosses into JavaScript: passwords and pasted phrases arrive as JS strings, which can't be wiped.
- Chrome doesn't write `chrome.storage.session` to disk, but the OS can swap or hibernate memory.

## Dependency budget

### Rust vault crates

| Need | Crate (version surveyed 2026-11-08) |
| --- | --- |
| Mnemonic | `bip39` 3.0 (rust-bitcoin) |
| HD derivation | `bip32` 0.6 (iqlusion) |
| secp256k1 | `k256` 0.14 (RustCrypto) |
| Hashes | `sha2` 0.11, `sha3` 0.12 (RustCrypto) |
| Keystore | `argon2` 0.6, `chacha20poly1305` 0.11 (RustCrypto) |
| Encoding | `bech32` 0.12, `prost` 0.14 |
| JSON inside transactions (CosmWasm messages, amino JSON, EIP-712) and the vault protocol | `serde` 1.0, `serde_json` 1.0 |
| Hygiene | `zeroize` 1.9 (with its `serde` feature, so passwords deserialize straight into wiped buffers), `getrandom` 0.4, `thiserror` 2 |
| WASM glue (WASM crate only) | `wasm-bindgen` 0.2.130, pinned exactly. Already in the lockfile through getrandom's browser backend |
| EVM (EVM crate) | Nothing extra: an in-house RLP writer, checked against viem. `alloy-dyn-abi` 1.7 later if ABI decoding needs it (`alloy-consensus` was measured at about 120 crates and left out) |

Adding a vault dependency needs a written reason in the PR and a second reviewer. Test-only crates (`hex`) are fine as dev-dependencies.

Protobuf types:

- The `.proto` files are vendored from the releases mainnet runs: InjectiveLabs/cosmos-sdk v0.50.14-inj.11 and InjectiveLabs/wasmd v0.53.3-inj.3, plus gogoproto and cosmos-proto. `crates/cosmos/proto/SOURCES.md` lists each file's source, license and SHA-256.
- injective-core is BUSL-1.1, so none of its files are vendored. Injective's ethsecp256k1 `PubKey` has the same wire format as cosmos-sdk's secp256k1 `PubKey` (`bytes key = 1`), so the vendored type is used under Injective's type URL. The tokenfactory `MsgChangeAdmin` (three string fields) is written in `crates/cosmos/src/msg.rs` from the wire format. The cross-implementation vectors confirm both.
- `tools/protogen` (its own workspace and lockfile, pure Rust, no `protoc`) generates the prost code, which is committed. Wallet builds never run it or fetch anything.

### JavaScript in extension pages

- Each shipped bundle (service worker, popup, approval window, content scripts) has its own list of allowed packages, reviewed like the Rust budget.
- pnpm pinned through `packageManager`, `minimumReleaseAge` set (a few days), install scripts disabled.
- injective-ts, ethers and viem are dev-only (test vector generation). They never ship.
- CSP on extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; require-trusted-types-for 'script'`.

## Review checklist (every PR touching vault code or extension pages)

1. Does any new path let bytes be signed without going through a decoder?
2. Can any secret reach a log, an error, a `Debug` print or a panic message?
3. Is every secret buffer zeroized, including temporaries (hex decode, KDF output)?
4. Are new decoders round-trip checked (including nested `Any`s), with tests for non-canonical input being refused?
5. Are new test vectors produced by an independent implementation (injective-ts, alloy, an EIP or BIP spec), not by our own code?
6. Can a web page reach the new message handler? Does it check `sender`?
7. Lockfile diff reviewed: what's new, who publishes it, is it in the budget?

## Testing

- Spec vectors: BIP-39, BIP-32, EIP-55, EIP-155.
- Tests, docs and examples use only published vectors (the BIP-39 "abandon … about" phrase, EIP-155's example key) or keys made for the test. Never a real person's address, key or balances.
- Cross-implementation vectors: `tools/vectors/` generates them with injective-ts (sdk-ts 1.20.62) and viem 2.57.7. The Rust tests must match byte for byte. Today that covers:
  - addresses;
  - Direct and amino JSON sign docs, signatures and TxRaw bytes for bank, CW20 and adapter messages;
  - authz grants (generic and send), execs, revokes, fee grants and revokes, reward withdrawals, the withdraw address, tokenfactory and contract admin changes, each decoded byte-exactly;
  - Injective EIP-712 v2 typed data (built by injective-ts, hashed and signed by viem);
  - generic EIP-712 hashing and `eth_signTypedData_v4` signatures (nested structs, arrays, signed integers, bytesN);
  - EIP-1559 native and ERC20 transfers.
- The same vectors also run end to end through the vault protocol (`crates/vault/src/tests.rs`): what a host gets back from `handle` must match too, and approvals must refuse a changed request, another account and a stale digest.
- Where injective-ts and the chain disagree (amino JSON zero `timeout_height`, HTML escaping), the tests follow the chain's source. The escaping cases were checked against Go's `encoding/json`.
  - The generator installs with scripts off and npm's `before` date set two weeks back, so every package in its lockfile had been public for at least two weeks.
  - injective-ts 1.20.21 was a compromised release. Pinned versions stay well clear of it.
- Real-dapp corpus: transactions captured from Helix, Injective Hub, Mito, Choice and the DEXes, each decoded and round-tripped.
- Negative tests: tampered keystores, wrong chain, wrong signer, non-canonical encodings, unknown fields, nested unknown `Any`s.
- Planned: `cargo fuzz` targets for every decoder; property tests for address parsing; `cargo deny` and `cargo audit` in CI.

## Releases

What protects the store listing, and what doesn't:

- **Chrome Web Store verified uploads.** The store accepts only packages signed with our RSA key. A leaked dashboard login or API key can't publish on its own.
  - Limit: if the key is lost, store support replaces it within about a week. The publisher Google account plus a support request is still a way in.
  - So the listing lives under a group publisher account. Every member uses hardware security keys.
- **Signing key on hardware.** Chrome's packer expects a PEM file. Keeping the key on a hardware token needs a PKCS#11 CRX3 signer; whether we can use an existing one is still open.
- **Chrome Web Store only in v1.** The Edge Add-ons publish API authenticates with an API key and checks no package signature, so a leaked Edge key could ship code. Edge and Brave users install from the Chrome Web Store.
- **Public watchdog.** A job polls the live store package and alerts when its hash doesn't match a signed tag.

Build and release process:

- Public repo from the first commit. Signed tags only.
- **Reproducible builds:**
  - pinned Rust toolchain (`rust-toolchain.toml`), `wasm-bindgen-cli` at exactly the crate's version, pinned binaryen;
  - `--remap-path-prefix`, a build container pinned by digest, pinned lockfiles, a deterministic zip;
  - a published hash per release, and a script that unwraps the store's CRX3 package, ignores the `_metadata/` folder the store adds, and compares the rest with the tag.
- Releases run from a protected GitHub environment with two required reviewers and Sigstore provenance. Every maintainer uses a hardware security key for GitHub.
- Public bug bounty from the first beta.

## Reporting a vulnerability

Until a security address is set up, open a private GitHub security advisory on this repo. Please don't file public issues for vulnerabilities.
