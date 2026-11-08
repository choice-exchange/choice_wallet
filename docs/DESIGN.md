# Choice Wallet design

Status: draft, revised after the 2026-11-08 design review. Owner: Choice.

Choice Wallet is an open-source, self-custody wallet. It starts as a browser extension for Injective (Cosmos side and Injective EVM), then adds mobile and other major chains.

## Decisions

| Topic | Decision |
| --- | --- |
| Core language | Rust 1.99.1. Compiled to WASM for the extension, to native code through uniffi for iOS and Android |
| First platform | Chrome extension, listed on the Chrome Web Store only (Brave and Edge users install from there). Mobile in phase 2 |
| v1 accounts | Seed phrase, private key import, Ledger, watch-only. Trezor and Keystone in phase 2. No social login, no MPC, no key shares held by anyone but the user |
| Ledger | Ledger Device Management Kit only. Injective Cosmos txs go through Ledger's Cosmos app; EVM txs through its Ethereum app |
| Audits | Built and audited in house, in the open. Process in [SECURITY.md](SECURITY.md) |
| Business model | Free, no fees, for now (decided 2026-11-08). Fees may come later, under the rules in [Fees](#fees) |
| Wallet ID | EIP-6963 `rdns` = `exchange.choice.wallet`, name "Choice Wallet". Official site wallet.choice.exchange (downloads, docs, release hashes). Permanent: never change it (decided 2026-11-08) |
| Repository | github.com/choice-exchange/choice_wallet, public from the first commit (decided 2026-11-08) |
| Open | Rescue Mode timing |

## Why

| What happened | Rule it gives us |
| --- | --- |
| November 2026: Keplr reported unauthorized transactions on accounts created with Google or Apple login, which run on Web3Auth. Seed-phrase and hardware-wallet accounts were not affected. A social-login key covers the user's addresses on every chain at once. | Only the user ever holds key material, whole or in parts. |
| After a key is stolen, unbonding stakes still return to the compromised address weeks later, which turns into a race. On chains with liquid staking tokenization (the Cosmos Hub), a thief can take staked ATOM at once instead of waiting out unbonding. | Staked funds are the weak spot. Rescue is a product feature, not a script written afterwards. |
| Rescuing an account by hand means finding everything it owns or controls: every bank denom, CW20 balances a bank-only sweep misses, NFTs across many collections (queries with a default page size silently drop the rest), CLMM positions, farms, tokenfactory and contract admins, the rewards withdraw address, and gas when only dust is left. | Rescue Mode: one flow that finds everything an account owns or controls and moves it. |
| Trust Wallet extension v2.68 (Dec 2025): a leaked Chrome Web Store API key let an attacker publish a build that drained about $7M. | The release pipeline is part of the security model. A leaked store key must not be able to ship code. |

Limit we state openly: in-wallet warnings stop phishing and blind signing. They do nothing once a thief has the key, because the thief signs outside our wallet. Against key theft we rely on keys that never leave the device, first-class hardware wallets, and (later) vault accounts with a time lock.

## Principles

1. **Self-custody only.** Seeds are made on the device with standard paths, so they also restore in Keplr, MetaMask and Leap.
2. **The vault decodes what it signs.** The vault never trusts a dapp's or the UI's description of a request. It decodes the exact bytes it will sign and shows that. In code, a signature can only come from a request object that was decoded first.
3. **Indexer suggests, chain confirms.** Choice indexers can list candidate tokens, NFTs and positions. Every balance shown is confirmed by a direct chain query.
4. **No backend required.** If Choice servers vanish, the wallet still works. RPCs are user-settable with several defaults, never Choice-only. Exception, disclosed: mobile dapp connections (phase 2) go through WalletConnect's relay, run by Reown. It sees only encrypted traffic.
5. **Small, auditable code with access to keys.** That includes the Rust vault and every JavaScript bundle that runs in an extension page. Both have a dependency budget (see SECURITY.md).
6. **Reproducible, multi-signed releases.** Anyone can check that a store build matches a git tag.
7. **No telemetry.** No accounts, no email, no analytics.

## Architecture

```text
dapp page ── provider (content script, world: MAIN) ──▶ isolated content script (relay only)
                                                             │ chrome.runtime messages
popup / side panel ◀── privileged messages ──▶ service worker
approval window          (own pages only)       ├─ origin permissions, approvals
                                                ├─ policy + risk rules
                                                ├─ RPC pool (user-settable)
                                                └─ vault: Rust core → WASM
                                                     seed · derivation · signing · decoders
Ledger (WebHID, paired in a tab) ◀──────────────┘
mobile app (phase 2) ── uniffi ──▶ same Rust core
```

### Crates

| Crate | Job | Status |
| --- | --- | --- |
| `choice-wallet-core` | Mnemonic, HD derivation, secp256k1 keys, addresses, encrypted keystore | Built, 29 tests |
| `choice-wallet-injective` | Injective protobuf (vendored .proto, prost 0.14), Direct / Amino JSON / EIP-712 sign paths, tx building, precompile decoding | Next |
| `choice-wallet-evm` | EVM tx types 0-2, EIP-712, ABI decoding. alloy 2.5 for types only; signing stays on our k256 0.14 | Planned |
| `choice-wallet-policy` | Risk rules over decoded requests | Planned |
| `choice-wallet-wasm` | wasm-bindgen surface for the extension | Planned |

Not used: `injective-std` and `cosmos-sdk-proto` (both still on prost 0.13; `injective-std` also pulls in cosmwasm-std), and the C `secp256k1` crate (needs a C toolchain for WASM).

### Keys at rest

- The secret is sealed with Argon2id (64 MiB, 3 passes) and XChaCha20-Poly1305. The header (format version, KDF parameters, salt, nonce) is authenticated as associated data, so it can't be changed undetected.
- The keystore stores mnemonic entropy or a raw private key, never the phrase text.
- While unlocked, the derived key sits in `chrome.storage.session`. Chrome doesn't write it to disk (the OS can still swap or hibernate memory), and content scripts can't read it. Every extension page can, which is why extension-page JavaScript is inside the security boundary.
- `storage.session` is cleared when the extension is disabled, reloaded or updated, and when the browser restarts. Users unlock again after every update.
- Auto-lock runs on `chrome.alarms` (30 s minimum), because the service worker is stopped after 30 s idle and timers die with it.
- Zeroize is best-effort once a secret crosses the WASM/JS boundary (a typed password or pasted phrase is a JS string).
- Passkey unlock (WebAuthn PRF), later: it needs a page, not the service worker. The passkey is tied to the extension's ID. On desktop Chrome, PRF works only with some authenticators (Google Password Manager, iCloud Keychain, recent Windows Hello, hmac-secret security keys). The password stays the root secret.
- Mobile (phase 2): the keystore key is wrapped by a Secure Enclave or StrongBox key behind biometrics.

### Injective accounts

- inj1 and 0x are the same ethsecp256k1 key (coin type 60). The wallet shows one account with an address-format toggle.
- Two derivation layouts, both supported: `m/44'/60'/0'/0/n` (Keplr, MetaMask, injective-ts) and `m/44'/60'/n'/0/0` (Ledger Live, and injective-ts's Ledger Cosmos strategy).
- Bank tokens appear once. The MultiVM token standard also exposes them as ERC20s. CW20s get their own label.
- Mainnet runs cosmos-sdk v0.50.14-inj.11 (checked in the injective-core v1.20.3 source). Its TxBody has no `unordered` or `timeout_timestamp`, so the decoder refuses them on Injective. Chains on v0.53 (phase 3) have both; each chain gets its own proto set.

### Sign paths

| Path | Used by | Canonical check |
| --- | --- | --- |
| SIGN_MODE_DIRECT (protobuf) | Our own txs; `signDirect` from Cosmos dapps | Decode and re-encode, recursing into every `Any` (MsgExec, grant authorizations, feegrant allowances, the signer pubkey). Byte-identical or refused |
| LEGACY_AMINO_JSON | Ledger Cosmos app; `signAmino` | Strict JSON: sorted keys, duplicate keys refused, unknown fields refused. Re-serialise and compare |
| Injective EIP-712 (v1 and v2) | Ledger Ethereum app; EVM wallets on Cosmos dapps | Rebuild the typed data from the decoded tx and compare. Only the `ExtensionOptionsWeb3Tx` extension is allowed, and its `typedDataChainID` and the inner `chain_id` are checked |
| EVM txs, types 0, 1, 2 | Injective EVM and other EVM chains | Decode with alloy. Type 4 / `authorizationList` (EIP-7702) is refused: Injective EVM doesn't support it |

Other rules in every path: one signer only; the signer key must be ours; the chain ID must match the connected chain; the tip field is refused. A CosmWasm `msg` is JSON inside protobuf: parse it strictly (duplicate keys refused) and show it raw next to any friendly rendering.

Before beta, the decoders are tested against a corpus of real transactions from Helix, Injective Hub, Mito, Choice and the DEXes. Without that, an encoder that writes default-valued fields would get legitimate txs refused.

### Ledger

- Device Management Kit (`@ledgerhq/device-management-kit`, signer kits for Cosmos and Ethereum, WebHID transport). LedgerJS (`hw-app-*`, `hw-transport-*`) is deprecated and stopped working with the Ethereum app in September 2026.
- Injective Cosmos txs: Ledger's Cosmos app, amino JSON, `inj` prefix, Ledger Live path layout. The Ethereum app's EIP-712 path shows only hashes for Injective txs without clear-signing metadata, which is blind signing.
- EVM txs: the Ethereum app.
- First pairing runs in a normal tab: `navigator.hid.requestDevice()` can't run in a service worker. Later connections use `getDevices()` (Chrome 117+).
- The vault checks every signature the device returns against the expected public key and the bytes it decoded.

## Extension security model

This is designed before the UI is built, because retrofitting it is expensive.

- **Origins.** Per-origin grants: which accounts, which chains, expiry, revoke. The origin comes from the browser (`sender.origin`, `sender.frameId`), never from the page. Cross-origin iframes get nothing by default.
- **Privileged messages.** The service worker accepts unlock, approve, export, add-account and settings changes only from its own extension pages: `sender.id` must equal the extension's ID, `sender.url` must be an extension URL, and nothing from a web page's `sender.tab` is accepted.
- **Approvals.** Each approval is single-use and tied to the request ID plus a hash of the decoded request. Approving one request can't sign another.
- **Approval windows.** Buttons stay disabled for about 800 ms after the window is focused and visible, so a dapp can't open it under the user's double-click. The approval window never asks for a password. Unlock happens only in the toolbar popup or side panel, which shows a per-install anti-phishing phrase. Approvals must be windows, because `sidePanel.open()` needs a user gesture.
- **Provider injection.** The dapp-facing provider is injected with a `"world": "MAIN"` content script. No extension page is listed in `web_accessible_resources`.
- **CSP.** Extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; require-trusted-types-for 'script'`.
- **Service-worker startup.** The wasm-bindgen glue is imported statically (dynamic `import()` is blocked in service workers). Listeners are registered synchronously, and requests are queued until WASM is ready.

## Connecting to dapps

- **EVM:** an EIP-1193 provider announced through EIP-6963 with `rdns` `exchange.choice.wallet`, so no fight over `window.ethereum`.
- **Injective dapps need a PR first.** injective-ts finds EIP-6963 wallets by a fixed list of `rdns` values tied to its `Wallet` enum, so until we're added, Helix and Hub won't see us. The PR to `wallet-base`, `wallet-evm` and `wallet-cosmos` is phase 0 work.
- **Cosmos provider:** `window.choice`, Keplr-compatible:
  - Methods: `enable`, `getKey` (with `algo: "ethsecp256k1"`, `isNanoLedger`, `ethereumHexAddress`), `signDirect`, `signAmino`, `getOfflineSigner`, `getOfflineSignerOnlyAmino`, `getOfflineSignerAuto`, `signArbitrary` / `verifyArbitrary` (ADR-036, with its own risk rule), `signEthereum`, `sendTx`.
  - A keystore-change event.
  - A policy for when a dapp lets the wallet change the fee.
- **Later adapters:** Interchain Kit (Cosmos Kit's successor) and graz. EIP-5792 `wallet_sendCalls` with `atomicRequired: false`.
- **Choice apps first:** choice.exchange and the Choice bridge integrate first.
- **Mobile (phase 2):** Reown WalletKit and an in-app browser.

## Signing pipeline

1. **Decode** through the sign path's decoder (above). Unknown message types show raw, in red, with extra friction.
2. **Simulate.**
   - Cosmos `simulate` returns events; coin_spent/coin_received give the balance change.
   - Orderbook orders settle at the end of the block, so simulation shows no fills. The screen says so.
   - EVM: a `debug_traceCall` call trace where the RPC supports it, plus logs, plus a Cosmos bank balance check.
   - The screen names the RPC that ran it. RPCs a dapp suggests (`experimentalSuggestChain`, `wallet_addEthereumChain`) are never used to simulate or confirm balances.
3. **Check** against the risk rules. Calls to Injective precompiles are decoded too, including inside call traces: the exchange precompile's `approve` creates authz grants, and the bank and staking precompiles change Cosmos state that an EVM state diff doesn't show.
4. **Show** and confirm, with more friction the riskier the request.

### Risk rules (v1)

| Rule | Level |
| --- | --- |
| authz `MsgGrant` (especially generic grants for MsgSend or MsgExec), feegrant `MsgGrantAllowance`, exchange precompile `approve` | Red, type to confirm |
| `MsgSetWithdrawAddress`, tokenfactory `MsgChangeAdmin`, wasm `MsgUpdateAdmin` to a new address | Red |
| Unlimited ERC20 `approve`, `setApprovalForAll`, Permit or Permit2 typed data | Red, names the spender |
| EIP-7702 authorization | Refused on Injective. Elsewhere (phase 3) red, and never with chain_id 0, which is valid on every chain |
| `eth_sign` | Disabled |
| `personal_sign` of 32-byte hex; `signArbitrary` of data that parses as a tx | Red |
| Sending more than 50% of a balance, or to an address that looks like an address-book entry (address poisoning) | Amber |
| Chain ID mismatch, site not used before, blocklisted domain | Amber, or blocked |
| First interaction with a contract | Info |

### Approval screen

```text
┌ choice.exchange wants a signature ───────────┐
│ Injective · Main · inj1np…90dz               │
│                                              │
│ Swap 100 INJ for at least 2,412 USDC         │
│ ChoiceAggregator 0x1671…5A33 · known         │
│                                              │
│ Simulated on sentry.tm.injective.network     │
│   -100.00 INJ  +2,431.18 USDC  fee 0.002 INJ │
│ ✓ no approvals  ✓ no grants  ✓ used 14 times │
│                                              │
│ [ Reject ]                        [ Sign ]   │
│ ▸ raw message                                │
└──────────────────────────────────────────────┘
```

Example addresses here are the BIP-39 test phrase's accounts 0 and 1, which belong to no one.

A red request reads like: "inj1d7…z8h8 could send ALL your tokens, with no end date. Type GRANT to continue."

## Features

- **Rescue address (phase 1) and Rescue Mode (phase 2).**
  - Set a rescue address ahead of time, ideally a hardware wallet.
  - At setup, the rescue wallet grants this account a fee allowance limited to the sweep message types and capped in amount. A thief who has the key then can't use up the grant.
  - Rescue Mode lists everything the account owns or controls (bank, CW20, CW721, ERC20, ERC721, orderbook subaccount deposits, stakes and rewards, CLMM and LP positions, farms, tokenfactory and contract admins, authz grants, fee grants). It then builds batched sweep txs, sets the rewards withdraw address, revokes grants, starts unbonding, and reminds at each unbond completion.
  - It makes you fast, not safe. With a stolen key it is still a race.
- **Approvals and grants.** One screen for ERC20 allowances, NFT approvals, authz grants (including precompile-created ones), fee grants and CW20 allowances. Revoke in one batched tx.
- **Full inventory.** The same engine as Rescue Mode drives the normal balance view: CW20s, NFTs (paginated), CLMM positions, farms, subaccount deposits.
- **Vault accounts (phase 3, research).** Long-term funds held in a contract. Withdrawals over a limit wait 24 to 48 hours, and a guardian key can cancel them. On Injective this is a CosmWasm or EVM contract (Injective EVM has no EIP-7702); on other EVM chains Safe or 7702 delegation.
- **Swap** through the Choice aggregator, with the fee shown before signing. INJ orderbook trading later.
- **Address book** and CEX memo warnings.
- **Light-client checks (phase 3).** Verify balances with proofs against a CometBFT light client (`tendermint-light-client-verifier`), so an RPC can't lie about them.

## Fees

The wallet is free. If fees are added later, these rules hold:

- **Always free:** sending, receiving, staking, claiming rewards, revoking approvals, Rescue Mode, and signing for other dapps.
- **Never:** ads, selling data, a wallet token, or security features behind a paywall.
- **Only on in-wallet swaps and bridges.** One fee, charged once, shown as its own line on the approval screen before signing.
- **No hidden fees, now or later.** Before in-wallet swap ships, check that the Choice aggregator takes nothing the quote doesn't show.
- **Built so a fee can be added later without a redesign.** The swap flow treats a fee as a separate decoded line. On Injective's Cosmos side, the fee can be a `MsgSend` to the treasury in the same tx, which is atomic with the swap and needs no contract change. (Mainnet CosmWasm code upload is allowlisted since prop 697.)

## JavaScript stack

| Need | Choice | Version surveyed 2026-11-08 |
| --- | --- | --- |
| Extension framework | WXT (Plasmo hasn't shipped since May 2025) | 0.21.5 |
| Build / UI | Vite, React, TypeScript | 8.3, 19.3, 7.0 |
| Package manager | pnpm, pinned through `packageManager`, `minimumReleaseAge` set, install scripts off | 12.18 |
| WASM glue | `wasm-bindgen-cli` pinned to the crate's exact version (0.2.130), plus a pinned binaryen | |
| Ledger | Device Management Kit + Cosmos and Ethereum signer kits + WebHID transport | DMK 1.11 |
| Mobile dapp connections (phase 2) | Reown WalletKit | 1.6 |
| Trezor (phase 2) | `@trezor/connect-webextension`. Its signing runs in a popup hosted on connect.trezor.io, a third-party site; Injective works only over EIP-712 | |
| Keystone (phase 2) | `@keystonehq/keystone-sdk`. Injective support not yet confirmed; the QR camera needs a tab | 0.13 |

injective-ts (1.20.x), ethers and viem are used only to generate test vectors. They never ship in an extension bundle.

## Roadmap

| Phase | Scope |
| --- | --- |
| 0. Core and trust model | Rust core (done). Injective crate: vendored protos, all four sign paths with recursive canonical checks, precompile decoding. EVM crate. Risk rules. Extension security model as a written spec with tests. EIP-6963 `rdns` fixed and the injective-ts wallet PR opened. Test vectors from injective-ts 1.20.x and alloy. Real-dapp tx corpus. uniffi targets built in CI |
| 1. Extension beta (Injective) | Create or import a seed, Ledger (DMK), send and receive, one balance list (bank + ERC20 + CW20), dapp signing, simulation, approvals screen, inventory engine, rescue address with a scoped fee grant, Choice apps integrated. In-house audit, Chrome Web Store public beta |
| 2. Depth and mobile | Rescue Mode, Trezor and Keystone, NFTs, staking, swap. iOS and Android with Reown WalletKit |
| 3. Multichain | Ethereum, Base, Arbitrum, BSC; Cosmos Hub, Osmosis, Noble (per-chain proto sets); then Solana and Bitcoin. Vault accounts, light client |

## Licensing

- Rust crates: Apache-2.0, so other wallets can reuse the decoders and rules.
- Extension and mobile apps: GPL-3.0.
- "Choice Wallet" name and logo: trademark, so forks must rebrand. Copycat wallets are a common scam.
