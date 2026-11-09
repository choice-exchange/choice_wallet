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
| Malicious RPC lies about balances, history or simulation | Partly | Several RPCs, user-settable; each must serve the expected chain ID; responses checked against the request (account, tx hash, integer amounts); gas price kept within the chain's own bounds and gas estimates capped; the review names the endpoint that simulated; dapp-suggested RPCs never used for checks. Light-client proofs in phase 3 |
| Blockscout (EVM history) lies or poisons history | Yes | A finder only: each transaction it names is fetched from the user's LCD by its EVM hash and read from the chain's own result, so it can hide a transfer but not invent one. Transactions that changed nothing for the account (zero-value "transfers" from look-alike addresses) are dropped, and rows the account didn't sign that moved only hidden tokens, in or out, sit behind the hidden row. It sees the account's 0x address; the user can point it elsewhere or turn it off |
| Permissions given long ago (authz grants, fee allowances, token allowances, a redirected rewards address) used later to drain the account | Yes | Approvals and grants lists them all, from the chain and from each token (ERC20 allowances found through Blockscout, checked on the user's EVM endpoint), and revokes them; anything that can move funds is red |
| Address poisoning: a look-alike address planted in history and copied by mistake | Yes | Zero-value transfers are dropped from Activity; a recipient whose start and end match a saved contact or one of the user's accounts, but isn't it, is amber in the review; recipients picked from the address book aren't typed |
| A deposit to an exchange without its memo, so no account is credited | Yes | A memo saved with a contact must be on the send (red without it); otherwise the recipient's latest deposits are read from the user's LCD, and an address whose deposits mostly carry memos from many senders is treated as an exchange (red without a memo). EVM sends can't carry one, so they are red there too. A user can still send without one after the red review |
| Choice's routing API (or someone in its place) answers with a swap that pays someone else, has no minimum, charges a hidden fee or runs unknown code | Yes | The API only describes; the vault reads the calldata itself (a strict ABI decoder that refuses non-canonical encodings) for Choice's two pinned executors and builds the wallet's swap only if it pays the signer, has a minimum no lower than the user's slippage allows, sends any fee to Choice's treasury and runs only adapters Choice trusts. The worst a wrong API can do is a bad price within the user's slippage. Approvals for a swap are for its exact amount, through Permit2 for 30 minutes, never unlimited |
| A site has the user stake with its validator, or give a stake away | Yes | Staking messages are decoded and shown with the validator's full address; staking keeps the coins the user's (Info). `MsgTransferDelegation` to another account is red. The wallet's own staking uses only active, unjailed validators and names them as they name themselves |
| A Ledger signs something other than what the review showed, or a tampered page or device answers with another signature | Yes | The device gets only the bytes the vault decoded for the approved digest (`device_request`) and shows them. Its signature counts only if the vault verifies it against the account's public key, kept since pairing, over exactly those bytes (`device_sign`); anything else is refused and nothing is broadcast. A swapped public key in storage only makes every signature fail. Contract calls on the Ethereum app are blind-signed (Injective EVM has no clear-signing data), so for those the wallet's review is the one to read |
| A stolen key: the thief takes the INJ first, so the owner can't pay a rescue's fee, and stakes race back to the account after unbonding | Partly | A rescue address set ahead of time gives the account a capped fee allowance (0.1 INJ, rescue messages only), so "Rescue now" works with no INJ left: tokens, rewards and permissions go in one transaction. Stakes move at once only to addresses on Injective's governance list; otherwise they start unbonding and it is still a race at completion. In-wallet rescue is fast, not safe |
| Someone with the device's disk reads what the wallet holds | Partly | Local storage keeps, in the clear, what the chain shows anyone with the address: the account list (already), and now each account's last balances, staking and first screen of activity, the watcher's last balances, and public token data. Nothing secret. Removing an account or the wallet removes its saved views |
| The endpoint learns which accounts are one person's, or when the user is online | Partly | With notifications on, the user's LCD endpoint is asked about the account in use once a minute, also while locked. "All accounts" asks about up to 10 together, which links them; it is a choice in Settings, not the default, and Settings says so. Off stops it. The endpoints are the user's own choice; nothing goes to Choice |
| Notifications show amounts on a locked screen, or a sender's lure | Partly | They show amounts and the account's name, also while the wallet is locked; Settings turns them off. What others sent shows only in tokens the token filter shows (sanitised symbols); names come from the user's own accounts and address book, never from the chain |
| A sealed secret swapped between wallets, or moved to another device's vault | Yes | Each wallet's secret is sealed under the vault key with the wallet's ID as associated data: under another ID, or another vault's key, it doesn't open |
| Someone at an unlocked wallet takes the recovery phrase or a key | Yes | Showing a phrase, exporting a key, changing the password, removing a wallet and resetting each take the password again; the vault's `reveal` and `change_password` refuse the unlock key, so holding the unlocked session isn't enough. Auto-lock after 5 minutes to 4 hours of no use |
| Price source (Choice) learns what the user holds, or shows wrong prices | Yes / Partly | The whole price list is fetched, never per token, and it can be turned off. Prices are display only: they never reach a transaction or the risk rules. A token Choice prices passes the token filter, so at worst a wrong list shows a junk token, still marked by its denom |
| A contract posing as the CW20 adapter, or a call made to look like a conversion | Yes | The adapter is pinned per network in the vault and the chain client (mainnet's has no admin). The review shows a conversion only for the adapter's exact message shapes sent to the pinned address; anything else is a contract call, shown as one |
| Junk tokens sent to the user, named to lure ("claim at …") | Yes | Hidden by default unless listed, priced by Choice, or shown by the user; symbols and names sanitised and capped; an unlisted token always shows its denom and never a listed token's logo |
| A site floods the user with approval windows, or opens one under a click | Yes | At most 10 requests wait, 3 per site, one connect or switch per site at a time; approval buttons wake 800 ms after the window is in front and focused; closing it rejects |
| A site learns which other sites the user connected, or what the wallet holds | Yes | Grants are per origin and the origin is the browser's; pages are told only "something changed" and ask for their own view; a site that isn't connected (and every site while locked) sees no account |
| A site has the wallet sign something that fails, or overpay gas | Yes | The wallet sets EVM nonce, gas and fees itself; a failing estimate stops the request before signing; Cosmos requests are simulated and a failure is shown in red |
| Stolen keystore file | Yes | Argon2id 64 MiB + XChaCha20-Poly1305; header authenticated; uniform decrypt error |
| Malicious update pushed through the store | Partly | Verified uploads, group publisher account with hardware keys, reproducible builds, a public watchdog. See Releases for what remains |
| Malicious dependency (Rust) | Yes | Dependency budget, pinned lockfile, review of every lockfile diff |
| Third party signs with the user's key | Yes | No third party ever holds key material or shares of it |
| Malware on the user's machine with full control | No | No software wallet can defend this. Use a hardware wallet for large balances |

## Rules for vault code

The vault is `choice-wallet-core`, `choice-wallet-cosmos`, `choice-wallet-injective`, `choice-wallet-evm`, `choice-wallet-policy`, `choice-wallet-vault` and `choice-wallet-wasm`.

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
- Choice's swap contracts are read, not vendored: the aggregator's `RouteParams`, the Permit2 `PermitSingle` and the router's `INFI_SWAP` plan are schemas in `crates/injective/src/choice.rs`, decoded by `crates/evm/src/abi.rs`, which re-encodes what it read and refuses anything that isn't byte for byte the input. Tests run on Choice's real calldata (mainnet aggregator and testnet router, recorded 2026-11-09), and the selectors were checked against the deployed bytecode.
- The staking messages (`MsgDelegate`, `MsgUndelegate`, `MsgBeginRedelegate`, `MsgCancelUnbondingDelegation`, Injective's `MsgTransferDelegation`) are written in `crates/cosmos/src/staking.rs` from cosmos-sdk v0.50.14-inj.11's `tx.proto`, rather than vendored, because that file's imports pull in cometbft's types and ABCI protos. A test checks their bytes against protobufjs (`@keplr-wallet/proto-types`), and the decoder still requires every message to round-trip byte for byte.
- `tools/protogen` (its own workspace and lockfile, pure Rust, no `protoc`) generates the prost code, which is committed. Wallet builds never run it or fetch anything.

### JavaScript in extension pages

- Each shipped bundle (service worker, popup, approval window, content scripts) has its own list of allowed packages, reviewed like the Rust budget.
- npm with a committed lockfile, install scripts disabled, exact versions, and `before` set two weeks back (`.npmrc` at the repo root, which also covers the `ui` and `extension` workspaces), bumped deliberately. The build is esbuild (two packages) rather than a framework, because build tools can change what they produce.
- What ships: `react`, `react-dom` and `scheduler` in the popup bundle, and, for Ledger (2026-11-09), Ledger's Device Management Kit 1.11.0, its WebHID transport 1.2.4 and Cosmos signer kit 1.0.1, with `rxjs` and the kit's own dependencies (xstate, inversify, purify-ts, semver, uuid, reflect-metadata, `@sentry/minimal`, which reports nothing without a client): 26 packages, about 590 KB, in a file of their own (`chunks/ledger-*.js`) that the pages load the first time a Ledger is asked for. The service worker, which runs the vault, loads none of it. The kit's files are published minified, so that part of the bundle reads less easily than the rest. Ledger's Ethereum signer kit is left out (it adds ethers and sends each transaction to Ledger's servers); the Ethereum app's two signing commands are written in `extension/src/ledger.ts` instead. Nothing the device returns is trusted: the vault checks each signature against the account's key over the exact bytes it decoded.
- No minification, so the shipped code can be read and compared with the source.
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
  - authz grants (generic and send), execs, revokes, fee grants and revokes, reward withdrawals, the withdraw address, tokenfactory and contract admin changes, each decoded byte-exactly, and their amino JSON and EIP-712 v2 forms decoding to the same messages (three forms sdk-ts doesn't produce are written from the x/tx rules and marked as such in the tests);
  - Injective EIP-712 v2 typed data (built by injective-ts, hashed and signed by viem);
  - generic EIP-712 hashing and `eth_signTypedData_v4` signatures (nested structs, arrays, signed integers, bytesN);
  - EIP-1559 native and ERC20 transfers;
  - `personal_sign` (EIP-191) hashes and signatures, for text, raw bytes and a 32-byte hash.
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
