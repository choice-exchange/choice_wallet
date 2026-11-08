# Choice Wallet design

Status: draft, revised after the 2026-11-08 design review. Owner: Choice.

Choice Wallet is an open-source, self-custody wallet. It starts as a browser extension for Injective (Cosmos side and Injective EVM), then adds mobile and other major chains.

## Decisions

| Topic | Decision |
| --- | --- |
| Core language | Rust 1.99.1. Compiled to WASM for the extension, linked natively for desktop and mobile |
| First platform | Chrome extension, listed on the Chrome Web Store only (Brave and Edge users install from there). Mobile in phase 2 |
| Other platforms | One vault protocol and one React UI for every platform (2026-11-08). Desktop (Linux first) is a Tauri 2 app that links the vault natively, so keys never enter its web view. Mobile picks Tauri mobile or React Native with uniffi at phase 2. See [Platforms](#platforms) |
| v1 accounts | Seed phrase, private key import, Ledger, watch-only. Trezor and Keystone in phase 2. No social login, no MPC, no key shares held by anyone but the user |
| Ledger | Ledger Device Management Kit only. Injective Cosmos txs go through Ledger's Cosmos app; EVM txs through its Ethereum app |
| Audits | Built and audited in house, in the open. Process in [SECURITY.md](SECURITY.md) |
| Business model | Free, no fees, for now (decided 2026-11-08). Fees may come later, under the rules in [Fees](#fees) |
| Wallet ID | EIP-6963 `rdns` = `exchange.choice.wallet`, name "Choice Wallet". Official site wallet.choice.exchange (downloads, docs, release hashes). Permanent: never change it (decided 2026-11-08) |
| Repository | github.com/choice-exchange/choice_wallet, public from the first commit (decided 2026-11-08) |
| Rescue | Beta (phase 1) ships the rescue address with a scoped fee grant. Full Rescue Mode waits for phase 2 (decided 2026-11-08) |

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
                                                └─ vault: Rust → WASM, handle(json) → json
                                                     seed · derivation · signing · decoders
Ledger (WebHID, paired in a tab) ◀──────────────┘
desktop app (Tauri) ── same React UI ── Rust host ──▶ same vault, linked natively
mobile app (phase 2) ──────────────────────────────▶ same vault
```

### Crates

| Crate | Job | Status |
| --- | --- | --- |
| `choice-wallet-core` | Mnemonic, HD derivation, secp256k1 keys, addresses, encrypted keystore | Built, 30 tests |
| `choice-wallet-cosmos` | Cosmos SDK protobuf (vendored .proto, prost 0.14), the Direct and amino JSON sign paths, message decoding, builders. Works for any chain described by a profile (chain ID, bech32 prefix, key type, tokenfactory package, the chain's own amino names) | Direct and amino JSON paths; bank and CW20 builders. On every path (protobuf, amino JSON, the protobuf JSON inside EIP-712 v2), also authz grants, execs (decoded recursively) and revokes, fee grants, the rewards withdraw address, tokenfactory and contract admin changes, all decoding to the same messages. Periodic fee allowances in JSON show raw (the grant itself is still recognised). Only ethsecp256k1 keys so far; standard secp256k1 (SHA-256, RIPEMD-160 addresses) comes with the first such chain |
| `choice-wallet-injective` | Injective's profiles, CW20 adapter conversions, EIP-712 v2 decoding | Mainnet and testnet profiles, adapter builders, EIP-712 v2. Together with the cosmos crate, byte-identical to injective-ts 1.20.62 (and viem for EIP-712) |
| `choice-wallet-evm` | EVM tx types 0-2, EIP-712, ABI decoding. Signing on our k256 0.14 | EIP-1559 encode and sign, native and ERC20 transfers, strict EIP-712 typed data. Byte-identical to viem 2.57.7. Dapp transaction requests next |
| `choice-wallet-vault` | The vault protocol: one JSON entry point for every host. Keystores, unlock keys, accounts by CAIP-2 chain, building the wallet's own sends, decode → approve → sign | Built. Signatures through the protocol match the injective-ts and viem vectors |
| `choice-wallet-wasm` | wasm-bindgen surface for the extension: `handle(json) → json` | Built (1.2 MB before wasm-opt). Smoke-tested in Node: Argon2id unlock about 130 ms, signing about 4 ms |
| `choice-wallet-policy` | Risk rules over decoded requests, including Injective precompile calls | Built: every rule in [Risk rules](#risk-rules-v1), with tests per rule. Precompile arguments beyond the first (the exchange `approve`'s authorization list) are not decoded yet |

Not used:
- `injective-std` and `cosmos-sdk-proto`: both still on prost 0.13, and `injective-std` also pulls in cosmwasm-std.
- The C `secp256k1` crate: it needs a C toolchain for WASM.
- `alloy-consensus`: even without default features it pulls about 120 crates, including second copies of sha2 and sha3. Dapps send EVM requests as JSON, so the wallet only ever encodes transactions. A 60-line RLP writer, checked byte for byte against viem, does that. `alloy-dyn-abi` may come in later for ABI decoding.
- injective-core's `.proto` files: injective-core is BUSL-1.1. Injective's ethsecp256k1 `PubKey` has the same wire format as cosmos-sdk's secp256k1 `PubKey`, and the tokenfactory `MsgChangeAdmin` is written for this repo from the wire format. The cross-implementation vectors confirm both.

### Vault protocol

Every host talks to the vault the same way: `handle('{"method": …, "params": {…}}')` returns `{"ok": true, "result": …}` or `{"ok": false, "error": {"code", "message"}}`. The method list is in `crates/vault/src/lib.rs`.

- **Stateless.** The host keeps the encrypted keystore and, while unlocked, the unlock key (the Argon2id output). Each signing call decrypts the keystore with it, derives the account key, signs and drops both. The extension's service worker survives being stopped because nothing lives in WASM memory between calls.
- **Hosts add the secrets.** UI pages send requests without the keystore or unlock key; the host fills them in. On desktop and mobile they never reach the web view.
- **Chains by CAIP-2 ID** (`cosmos:injective-1`, `eip155:1776`). Accounts list an address for every known chain, so adding a chain doesn't change the protocol.
- **Approvals are bound to bytes.** `decode` returns what the approval screen shows and a digest over the request kind, chain, signer and the exact bytes (or EIP-712 hash) to be signed. `sign` decodes again and signs only if the digest matches the approved one, so an approval can't sign a different request or with a different account.
- **The wallet's own sends get no shortcut.** `build_cosmos` and `build_evm` return a sign request in the same form a dapp's would take, which then goes through `decode` and `sign`.
- EVM transaction requests are `eth_sendTransaction` objects after the host fills in nonce, gas and fees. Only EIP-1559; legacy gas prices, access lists, EIP-7702 authorizations and contract creation are refused.

### Keys at rest

- The secret is sealed with Argon2id (64 MiB, 3 passes) and XChaCha20-Poly1305. The header (format version, KDF parameters, salt, nonce) is authenticated as associated data, so it can't be changed undetected.
- The keystore stores mnemonic entropy or a raw private key, never the phrase text.
- While unlocked, the unlock key (the Argon2id output, which opens only this keystore) sits in `chrome.storage.session`. Chrome doesn't write it to disk (the OS can still swap or hibernate memory), and content scripts can't read it. Every extension page can, which is why extension-page JavaScript is inside the security boundary. The desktop app keeps it in the Rust process instead.
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

### Sends and conversions

How each kind of Injective token is held and moved (checked against the injective-core v1.20.3 source and mainnet, 2026-11-08):

| Token | Where the balance lives | Send | Convert |
| --- | --- | --- | --- |
| INJ | Bank `inj`. The same balance is the native coin on Injective EVM | Bank `MsgSend`, or an EVM value transfer | Not needed |
| Bank denoms (`peggy…`, `ibc/…`, `factory/…`) | Bank | `MsgSend`. If the denom has an ERC20 token pair, the same balance is that ERC20, and an EVM `transfer` moves it too | Not needed: the pair is a second view of one balance |
| Bank-backed ERC20s (`erc20:0x…`) | Bank, through the bank precompile | `MsgSend` or EVM `transfer` | Not needed |
| Pure ERC20s | The contract's own storage | EVM `transfer` only (EIP-1559 tx) | None |
| CW20 | The CW20 contract | `MsgExecuteContract` `{"transfer":…}` | To bank: CW20 `send` to the CW20 adapter, which mints `factory/{adapter}/{cw20}`. Back: adapter `redeem_and_transfer` with those coins |

- **CW20 to ERC20** goes through bank. The adapter denom is an ERC20 wherever it has a token pair. At least 500 adapter denoms have one on mainnet (query `/injective/erc20/v1beta1/all_token_pairs`).
- **Who can create a pair:** anyone for peggy and IBC denoms (`MsgCreateTokenPair` deploys a fixed-supply ERC20). For tokenfactory denoms, only the denom admin or governance; for adapter denoms that admin is the adapter, which has no message for it. "Enable on EVM" for peggy and IBC denoms is a later feature.
- **The adapter registers a CW20 itself** the first time it receives that CW20, paying the denom creation fee from its own balance. If it can't pay, simulation shows the failure.
- **One balance per token.** A CW20 and its adapter denom show as one token. A send that needs more than the CW20 side holds redeems the shortfall in the same tx, as Choice already does.
- The CW20 adapter address is a builder parameter. Only mainnet's (`inj14ejq…euk`) is built in until testnet's is verified.

### Sign paths

| Path | Used by | Canonical check | Status |
| --- | --- | --- | --- |
| SIGN_MODE_DIRECT (protobuf) | Our own txs; `signDirect` from Cosmos dapps | Decode and re-encode, recursing into every `Any` (MsgExec, grant authorizations, feegrant allowances, the signer pubkey). Byte-identical or refused | Built |
| LEGACY_AMINO_JSON | Ledger Cosmos app; `signAmino` | Our own txs: amino JSON derived from the protobuf tx exactly as the chain derives it. Dapp sign docs: strict shape, signed in canonical form | Built |
| Injective EIP-712 v2 | EVM wallets on Cosmos dapps (`eth_signTypedData_v4`) | Strict typed data; the "Injective Web3" domain, its types, the `context` and the `msgs` must have exactly the v2 shape | Built (decode and sign). Building our own EIP-712 txs isn't needed |
| Injective EIP-712 v1 | injective-ts sends it to EVM wallets not on its v2 list | Typed data derived from amino JSON | Not recognised; shown as generic typed data. We ask to be on the v2 list instead |
| EVM txs, types 0, 1, 2 | Injective EVM and other EVM chains | Type 4 / `authorizationList` (EIP-7702) is refused: Injective EVM doesn't support it | EIP-1559 sends built; dapp requests next |

Other rules in every path: one signer only; the signer key must be ours; the chain ID must match the connected chain; the tip field is refused. A CosmWasm `msg` is JSON inside protobuf: parse it strictly (duplicate keys refused) and show it raw next to any friendly rendering.

What the chain checks, and so what we match (injective-core v1.20.3, cosmos-sdk `x/tx` v0.50.14-inj.11):

- **Amino JSON.** Keys are sorted at every level. Zero values are left out unless the proto marks them `dont_omitempty`, so `timeout_height` appears only when it isn't 0. Integers are strings, and strings get Go's escaping, including `<`, `>`, `&`, U+2028 and U+2029. CosmWasm messages are inlined and re-sorted, with their numbers read as float64. So a contract message with a number that isn't a safe integer is refused on this path. injective-ts writes `"timeout_height":"0"` and doesn't HTML-escape, so its amino signatures fail in those cases; ours follow the chain.
- **EIP-712 v2.** `Tx { context: string, msgs: string }` under the domain "Injective Web3", version "1.0.0", `verifyingContract` `0xCcCC…cccC`, salt "0". The domain chain ID may be the network's EVM chain ID or Ethereum's (1 or 1776 on mainnet, 11155111 or 1439 on testnet), so MetaMask needn't switch networks. The signature is 65 bytes, `r || s || v`. A fee payer in `context` means fee delegation (e.g. Injective's web3 gateway). It is shown, and the user signs it.
- **Generic EIP-712** (`eth_signTypedData_v4`): every declared field must be present and typed correctly, undeclared fields are refused, `bytesN` must be exactly N bytes, and integers must fit their width. That's stricter than most wallets, so what the screen shows is exactly what's hashed. The real-dapp corpus will show whether any dapp relies on looser parsing.

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
- **Injective dapps need a PR first.** injective-ts finds EIP-6963 wallets by a fixed list of `rdns` values tied to its `Wallet` enum, so until we're added, Helix and Hub won't see us. The PR to `wallet-base`, `wallet-evm` and `wallet-cosmos` is phase 0 work. It also puts Choice Wallet on the EIP-712 v2-only list (`isEip712V2OnlyWallet`), so Injective dapps send us v2 typed data, which we decode, rather than v1.
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
3. **Check** against the risk rules, with what the host knows (site, balances, address book). Calls to Injective precompiles are graded too, and later inside call traces: the exchange precompile's `approve` creates authz grants, and the bank and staking precompiles change Cosmos state that an EVM state diff doesn't show.
4. **Show** and confirm, with more friction the riskier the request.

### Risk rules (v1)

Implemented in `choice-wallet-policy`. `decode` returns them as `risk`: a level, an optional word to type, and findings, each with a rule ID, one sentence and its facts. The host passes what only it knows (the site, balances, address book, contracts used before); rules that need a missing fact don't fire. Anything a decoder couldn't read is red on its own.

| Rule | Level | Rule IDs |
| --- | --- | --- |
| authz `MsgGrant` (generic grants for `MsgSend` say "could send ALL your tokens"), feegrant `MsgGrantAllowance`, the exchange precompile's `approve` | Red, type GRANT | `authz_grant`, `fee_grant`, `exchange_grant` |
| `MsgSetWithdrawAddress` to another address; tokenfactory `MsgChangeAdmin` to another address or to none; wasm `MsgUpdateAdmin` to another address; `MsgClearAdmin` | Red | `withdraw_address`, `denom_admin`, `contract_admin` |
| ERC20 or CW20 allowance of 2^100 or more ("unlimited") or more than the balance; `setApprovalForAll(true)`; Permit2 `approve`; Permit and Permit2 signatures; Seaport listings | Red, names the spender | `unlimited_allowance`, `allowance_over_balance`, `nft_approval_all`, `permit2_allowance`, `permit`, `unlimited_permit`, `permit2_signature`, `marketplace_listing` |
| A message or precompile call the wallet can't read | Red | `unknown_message`, `precompile_unknown` |
| `personal_sign` of a 32-byte hash; a sign-in (EIP-4361) message for another site or another account | Red | `hash_signature`, `sign_in_wrong_site`, `sign_in_wrong_account` |
| Blocklisted site | Blocked | `site_blocked` |
| Limited allowance; orderbook orders or external transfers through the exchange precompile; acting for another account through its grant; binary `personal_sign` data; a system address off Injective | Amber | `allowance`, `precompile_call`, `exchange_for_other`, `binary_message`, `system_address`, `bank_precompile` |
| More than half of a balance leaving (fees included), more than the balance, the amount plus the maximum gas over the balance, a recipient that looks like an address-book entry (address poisoning), a site not used before | Amber | `most_of_balance`, `more_than_balance`, `gas_over_balance`, `lookalike_address`, `site_new` |
| First interaction with a contract; fee paid through a grant or by a payer; `MsgExec`; revokes; staking; address-book recipient; sign-in for this site | Info | `new_contract`, `fee_grant_used`, `fee_payer`, `authz_exec`, `authz_revoke`, `fee_revoke`, `allowance_revoke`, `precompile_call`, `address_book`, `sign_in` |
| EIP-7702 authorizations, chain ID mismatches | Refused by the decoders, never graded | |
| `eth_sign` | Disabled: never reaches the vault | |
| `signArbitrary` (ADR-036) of data that parses as a tx | Red, when ADR-036 lands | |

Injective precompiles are read from their function selectors: bank `0x…64`, exchange `0x…65`, staking `0x…66`, oracle `0x…67`. The signatures come from injective-core v1.20.3's generated bindings (read, not copied); viem computed the selectors, and a test checks each against keccak256 of its signature. Exchange methods name the account they act for first, so a call for anyone but the sender is flagged as using that account's grant.

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

## Platforms

| Platform | UI | Vault | Dapps connect through | Ledger |
| --- | --- | --- | --- | --- |
| Chrome extension (phase 1) | React in extension pages | WASM in the service worker | Injected EIP-1193 / EIP-6963 and Keplr-style providers | DMK over WebHID |
| Desktop, Linux first (after the beta) | The same React UI in a Tauri 2 web view (WebKitGTK on Linux) | Linked natively in the Rust host; keys never enter the web view | WalletConnect (Reown WalletKit). Later, the extension as a thin connector over Chrome native messaging | A Rust HID transport: WebKitGTK has no WebHID, so DMK can't run there |
| iOS, Android (phase 2) | Tauri mobile, or React Native with uniffi; decided at phase 2 | Linked natively | WalletConnect, in-app browser | Bluetooth (DMK or native) |

What keeps this one codebase:
- The vault protocol is the only interface between UI and keys, and it is the same JSON everywhere.
- The React UI (`ui/`, its own package) reaches the vault, storage and windows only through a small host interface (`Backend`), with one implementation per platform. Its tsconfig loads no platform types, so a `chrome.*` call in the UI fails the type check. Its stylesheet sets no window size; the extension's 360px popup width lives in the extension.

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
| Build | esbuild, with a 60-line build script (`extension/build.mjs`). WXT was the first pick, but it pulls 128 npm packages into the build, and build tools can tamper with what they produce; esbuild is 2. Decided 2026-11-08 | 0.28.2 |
| UI | React, TypeScript (type checks only) | 19.3.1, 7.0.2 |
| Package manager | npm with a lockfile, install scripts off, exact versions, and `before` set two weeks back (`.npmrc`). npm workspaces: `ui` and `extension`, one lockfile at the root. Twelve packages in all, three of them shipped | npm 11 |
| WASM glue | `wasm-bindgen-cli` pinned to the crate's exact version (0.2.130), plus a pinned binaryen | |
| Ledger | Device Management Kit + Cosmos and Ethereum signer kits + WebHID transport | DMK 1.11 |
| Mobile dapp connections (phase 2) | Reown WalletKit | 1.6 |
| Trezor (phase 2) | `@trezor/connect-webextension`. Its signing runs in a popup hosted on connect.trezor.io, a third-party site; Injective works only over EIP-712 | |
| Keystone (phase 2) | `@keystonehq/keystone-sdk`. Injective support not yet confirmed; the QR camera needs a tab | 0.13 |

injective-ts (1.20.x), ethers and viem are used only to generate test vectors. They never ship in an extension bundle.

## Roadmap

| Phase | Scope |
| --- | --- |
| 0. Core and trust model | Rust core, Cosmos and Injective crates, EVM crate, risk rules, vault protocol and WASM build (done). Extension skeleton: the service worker hosting the vault, create / import / unlock / lock in the popup, checked in Chromium (done). The UI as its own package behind a host interface, so desktop and mobile reuse it (done). Extension security model as a written spec with tests. EIP-6963 `rdns` fixed and the injective-ts wallet PR opened. Test vectors from injective-ts 1.20.x and alloy. Real-dapp tx corpus. uniffi targets built in CI |
| 1. Extension beta (Injective) | Create or import a seed, Ledger (DMK), send and receive, one balance list (bank + ERC20 + CW20), dapp signing, simulation, approvals screen, inventory engine, rescue address with a scoped fee grant, Choice apps integrated. In-house audit, Chrome Web Store public beta |
| 2. Depth and mobile | Rescue Mode, Trezor and Keystone, NFTs, staking, swap. iOS and Android with Reown WalletKit |
| 3. Multichain | Ethereum, Base, Arbitrum, BSC; Cosmos Hub, Osmosis, Noble (per-chain proto sets); then Solana and Bitcoin. Vault accounts, light client |

## Licensing

- Rust crates: Apache-2.0, so other wallets can reuse the decoders and rules.
- Extension and mobile apps: GPL-3.0.
- "Choice Wallet" name and logo: trademark, so forks must rebrand. Copycat wallets are a common scam.
