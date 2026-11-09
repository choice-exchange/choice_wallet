# Choice Wallet design

Status: draft, revised after the 2026-11-08 design review. Owner: Choice.

Choice Wallet is an open-source, self-custody wallet. It starts as a browser extension for Injective (Cosmos side and Injective EVM), then adds mobile and other major chains.

## Decisions

| Topic | Decision |
| --- | --- |
| Core language | Rust 1.99.1. Compiled to WASM for the extension, linked natively for desktop and mobile |
| First platform | Chrome extension, listed on the Chrome Web Store only (Brave and Edge users install from there). Mobile in phase 2 |
| Other platforms | One vault protocol and one React UI for every platform (2026-11-08). Desktop (Linux first) is a Tauri 2 app that links the vault natively, so keys never enter its web view. Mobile picks Tauri mobile or React Native with uniffi at phase 2. See [Platforms](#platforms) |
| v1 accounts | Seed phrase, private key import, Ledger (built 2026-11-09), watch-only. Trezor and Keystone in phase 2. No social login, no MPC, no key shares held by anyone but the user |
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
4. **No backend required.** If Choice servers vanish, the wallet still works. RPCs are user-settable with several defaults, never Choice-only. Exceptions, disclosed: USD values come from Choice's price index (display only, the whole list fetched so it learns nothing about holdings, and they can be turned off); mobile dapp connections (phase 2) go through WalletConnect's relay, run by Reown. It sees only encrypted traffic.
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
| `choice-wallet-cosmos` | Cosmos SDK protobuf (vendored .proto, prost 0.14), the Direct and amino JSON sign paths, message decoding, builders. Works for any chain described by a profile (chain ID, bech32 prefix, key type, tokenfactory package, the chain's own amino names) | Direct and amino JSON paths; bank and CW20 builders. On every path (protobuf, amino JSON, the protobuf JSON inside EIP-712 v2), also authz grants, execs (decoded recursively) and revokes, fee grants, staking (stake, unstake, move, cancel an unstaking, claim, and Injective's transfer of a stake), the rewards withdraw address, tokenfactory and contract admin changes, all decoding to the same messages. Periodic fee allowances in JSON show raw (the grant itself is still recognised). Only ethsecp256k1 keys so far; standard secp256k1 (SHA-256, RIPEMD-160 addresses) comes with the first such chain |
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
- **Approvals are bound to bytes.** `decode` returns what the approval screen shows and a digest over the request kind, chain, signer and the exact bytes (or EIP-712 hash) to be signed. `sign` decodes again and signs only if the digest matches the approved one, so an approval can't sign a different request or with a different account. A hardware wallet's signature goes through the same binding: `device_request` gives the device the approved request's exact bytes, and `device_sign` accepts a signature only if it verifies against the account's key over them.
- **The wallet's own sends get no shortcut.** `build_cosmos` and `build_evm` return a sign request in the same form a dapp's would take, which then goes through `decode` and `sign`. `build_cosmos` makes bank and CW20 sends, adapter conversions, staking (`delegate`, `undelegate`, `redelegate`, `cancel_unbonding`, `withdraw_rewards`) and revokes (`authz_revoke`, `fee_revoke`, `reset_withdraw_address` back to the signer only, `cw20_decrease_allowance`), in SIGN_MODE_DIRECT or amino JSON. `build_evm` makes native and ERC20 sends, and `approve(spender, 0)` as a revoke (to the token only, for 0 only).
- EVM transaction requests are `eth_sendTransaction` objects after the host fills in nonce, gas and fees. Only EIP-1559; legacy gas prices, access lists, EIP-7702 authorizations and contract creation are refused.

### Keys at rest

- **One password, several wallets (envelope encryption, `crates/core/src/envelope.rs`).** The password goes through Argon2id (64 MiB, 3 passes) once, to open the vault: a random 32-byte vault key sealed with XChaCha20-Poly1305, its header (format version, KDF parameters, salt, nonce) authenticated as associated data. Each wallet's secret, a recovery phrase's entropy or a raw private key (never the phrase text), is sealed under the vault key with XChaCha20-Poly1305 and a fresh 24-byte nonce, with the wallet's ID in the associated data, so a sealed secret opens only as its own wallet. Unlocking runs Argon2 once however many wallets there are; adding or removing a wallet touches only its own blob; a new password re-wraps the vault key and leaves every secret, and the unlocked session, as they are.
- A device from before vaults (one keystore, the secret sealed under the password itself) moves into a vault at its first unlock, as "Recovery phrase 1" (or "Imported key 1"), every account read again from the moved secret.
- While unlocked, the unlock key (the vault key, which opens only this vault's wallets) sits in `chrome.storage.session`. Chrome doesn't write it to disk (the OS can still swap or hibernate memory), and content scripts can't read it. Every extension page can, which is why extension-page JavaScript is inside the security boundary. The desktop app keeps it in the Rust process instead.
- `storage.session` is cleared when the extension is disabled, reloaded or updated, and when the browser restarts. Users unlock again after every update.
- Auto-lock runs on `chrome.alarms` (30 s minimum), because the service worker is stopped after 30 s idle and timers die with it. The user picks how long it waits: 5 or 15 minutes (the default), 1 or 4 hours.
- **Behind the password, even while unlocked.** Showing a wallet's recovery phrase (or its key), exporting an account's private key, changing the password, removing a wallet and resetting each take the password again: the vault's `reveal` and `change_password` take it and refuse the unlock key, so a host (or anything reading `storage.session`) can't show a secret without it. Reset clears the vault, the wallets, the account list, connected sites, added tokens and the token filter; endpoints and other settings stay.
- Zeroize is best-effort once a secret crosses the WASM/JS boundary (a typed password or pasted phrase is a JS string).
- Passkey unlock (WebAuthn PRF), later: it needs a page, not the service worker. The passkey is tied to the extension's ID. On desktop Chrome, PRF works only with some authenticators (Google Password Manager, iCloud Keychain, recent Windows Hello, hmac-secret security keys). The password stays the root secret.
- Mobile (phase 2): the keystore key is wrapped by a Secure Enclave or StrongBox key behind biometrics.

### Injective accounts

- inj1 and 0x are the same ethsecp256k1 key (coin type 60). The wallet shows one account with an address-format toggle.
- Two derivation layouts, both supported: `m/44'/60'/0'/0/n` (Keplr, MetaMask, injective-ts) and `m/44'/60'/n'/0/0` (Ledger Live, and injective-ts's Ledger Cosmos strategy).
- Bank tokens appear once. The MultiVM token standard also exposes them as ERC20s. CW20s get their own label.
- **Wallets and accounts.** A wallet is a source of keys: a recovery phrase (created or imported) or an imported private key, each behind the one password (above). Accounts belong to one wallet: a phrase's by index (`m/44'/60'/0'/0/n`; "Add an account" takes the next, so a removed one comes back as the same address), an imported key's is its one account. Importing a phrase looks at its indexes 1 to 9 on the current network and adds those with a balance or history (index 0 always). The same phrase or key twice is refused, and importing the key of a watched address turns that entry into the account. An address to watch (either form; the vault's `addresses` method gives the other) belongs to no wallet: its balances and activity show, the wallet refuses to prepare a send for it, and there is no key to sign with. Accounts and wallets have names (cleaned like token names, 24 characters); new accounts are numbered across the list. One account is in use at a time, for the wallet and for connected sites, and a send signs with the wallet that prepared it. A wallet's last account goes only with the wallet; a wallet goes after the password, but not the last one: "Reset Choice Wallet" takes everything.
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

- **CW20 to ERC20** goes through bank. The adapter denom is an ERC20 wherever it has a token pair. On 2026-11-09, 2 of mainnet's 1,112 token pairs were adapter denoms (SHROOM's and NONJA's CW20s; query `/injective/erc20/v1beta1/all_token_pairs`), and none of testnet's 451.
- **Who can create a pair:** anyone for peggy and IBC denoms (`MsgCreateTokenPair` deploys a fixed-supply ERC20). For tokenfactory denoms, only the denom admin or governance; for adapter denoms that admin is the adapter, which has no message for it. "Enable on EVM" for peggy and IBC denoms is a later feature.
- **The adapter registers a CW20 itself** the first time it receives that CW20, paying the denom creation fee from its own balance. If it can't pay, simulation shows the failure.
- **Two rows, one action.** A CW20 and its adapter denom show as two tokens, each with "Convert" on its screen. Showing them as one balance, with a send that redeems the shortfall in the same tx as Choice does, is later.
- **The adapters.** Mainnet's (`inj14ejq…euk`, labelled "Injective CW20 Adapter") has no admin, so its code can't change. Testnet's (`inj1hdvy…xg6`, Injective's "Cw20Adapter") has an admin, as testnet contracts do, and runs other code. Both are pinned in the vault (`crates/injective`) and the chain client. Testnet's was checked with a round trip through the extension on 2026-11-09: a test CW20 sent, converted to the bank denom (the adapter registered it on first use, 442k gas) and all of it converted back (968k gas), each amount exact on chain.

### Chain client

`chain/` (`@choice-wallet/chain`), TypeScript using only Web APIs, so the extension's service worker and a desktop or mobile web view run the same code. It holds no keys: it reads, simulates and broadcasts signed bytes.

- **Endpoints.** User-settable per network (Settings). Defaults: three independent public LCDs on mainnet (Injective's sentry, Allnodes' publicnode, cosmos.directory) and two on testnet, each checked on 2026-11-08 to answer an extension origin with CORS. Never Choice's alone. Tried in order, starting with the one that answered last. https only, except local http for development.
- **What counts as an answer.** A JSON `{code, message}` body is the chain's answer at any HTTP status and is not retried elsewhere. Network errors, timeouts (10 s), bodies that aren't JSON, and gRPC unavailable / exhausted / deadline codes move on to the next endpoint. Seen on mainnet: a failing simulation comes back as a 500 carrying the chain's error from the sentry and cosmos.directory, but as a bare 503 from publicnode. Over HTTP/1.1 the sentry also cuts that response short; browsers use HTTP/2.
- **Checks.** An endpoint must serve the expected chain ID (`node_info`) before it is used. An account response must be for the address asked, a tx lookup for the hash asked, and amounts must be integers.
- **Gas and fees.** The vault's `simulate_tx` (the transaction with an empty signature) is simulated, then the gas limit is 1.3 times the gas used, at least 50k. A simulation above 3M gas is not believed. The price is the txfees module's current base fee, kept between the chain's minimum (160000000 inj per gas) and 1000 times that (its `max_base_fee_multiplier`). A bank send uses 82,771 gas on mainnet, about 0.000017 INJ.
- **Broadcast.** The tx hash (SHA-256 of the bytes) is known before sending. A retry that finds the tx already relayed (code 19) succeeds; a sequence mismatch on a retry counts as "maybe sent" and the hash is watched.
- **USD values.** From Choice's price index (`evm-api.choice.exchange/prices`, oracle-anchored), mainnet only, cached for a minute. The whole list is fetched, never a question about particular tokens. It is keyed by EVM address, so a bank denom is mapped through the chain's erc20 token pairs, read from the user's own endpoints. Display only: no price reaches a transaction or the risk rules. If Choice is down or the user turns prices off in Settings, the wallet shows amounts alone. Requests carry `X-Client: choice-wallet/<version>` for Choice's API gate, which must allow it before the gate enforces.
- **Tokens.** A short list the wallet knows, checked by hand on mainnet: INJ, Circle's USDC (`erc20:0xa00C…235a`), Noble USDC, Peggy USDT, USDC and WETH, and ATOM. Any other token shows the symbol from its bank metadata, which its creator chose, so the UI shows the denom beside it and the risk rules name it by its denom. Control, bidi and zero-width characters are stripped from symbols and names.
- **EVM side.** A JSON-RPC client with the LCD client's rules: user-settable endpoints (Settings), each checked to serve the expected chain (`eth_chainId`) before use, a JSON-RPC error is the chain's answer and anything else moves on. Reads are batched (one round trip; Injective's defaults and publicnode answer batches and allow extension origins, checked 2026-11-09).
- **CW20s.** A CW20's balance lives in its contract, which no bank query sees, so the wallet asks each candidate with a smart query (`balance`, and `token_info` for its symbol, name and decimals): the CW20 behind every adapter bank denom that has an ERC20 pair (at most 50), behind every adapter denom the account holds, and any the user adds by contract (`inj1…`). The wallet keys them `cw20:inj1…`, never a bank denom. A CW20 is priced as its bank form, through that form's pair. An adapter denom with the token factory's empty metadata is described by its CW20.
- **EVM-only tokens.** Most ERC20s on Injective have a bank denom (an `erc20:0x…` denom or a token pair), and the bank list already shows those. The rest (on 2026-11-09, 2 of the 36 tokens Choice prices) are read on the EVM side: candidates are the tokens Choice priced this week and any the user adds by contract address; anything a bank denom covers is skipped so no token shows twice. The wallet keys them `evm:0x…`, never a bank denom, so they can't go out in a bank message. Names and symbols come from the contract and are cleaned like bank metadata. If no EVM endpoint answers, the bank list still shows, with a note.
- **Token filter.** Anyone can send any token to any address, and junk often carries a name meant to be read. By default the lists show the fee token, the wallet's listed tokens, and tokens Choice has priced within the past week (they trade somewhere real); the rest sit behind "N hidden tokens". The Tokens screen can show all tokens, can also hide priced tokens worth under $1, and shows or hides any one token. The user's choice wins, except that the fee token always shows. Kept per network; the total counts shown tokens only. When Choice last priced each token is remembered for a week (public data, in local storage), so a Choice outage doesn't make tokens vanish. With USD values off, Choice isn't asked and only what it said before counts.
- **Activity.** From the node's tx index, on the user's own endpoints: what the account signed (`message.sender`), spent (`coin_spent.spender`) and received (`coin_received.receiver`), merged by hash. Spent catches what the signer query can't: a reverted EVM transaction keeps only its fee events, with no signer event. Signed catches what the spent query can't: a transaction whose gas someone else paid. A row's amounts come from the bank module's own events, so a swap or contract call shows what actually moved; the fee shows apart when this account paid it. Nodes keep different windows of history (the sentry's index reaches below its pruned blocks, and then the query fails, so that node is skipped), and load-balanced endpoints can answer pages from different nodes, so rows are de-duplicated and shown only down to where every list is complete. A row that this account didn't sign and that moved only tokens the filter hides, in or out, is hidden like a junk balance: any contract can log a "transfer" out of an account, of a token it made up. CW20 movements count from the contracts' `wasm` events (transfer, send, mint, burn), and a CW20 and its bank form traded one for one read as a conversion. A CW20 someone else sends shows only if the node's index finds the tx by one of the queries, which a pure CW20 transfer doesn't match.
- **EVM transactions in Activity.** An EVM transaction is a Cosmos transaction holding one `MsgEthereumTx`, so it is in the same index. The row is read from what was signed (`raw`, the signed transaction, and `from`) and from the result (`data`, holding the EVM hash and the logs), with no extra requests: a send names its recipient (the ERC20 `transfer` recipient, from the log or, if it reverted, from the calldata), a receive names the 0x sender, an `Approval` reads as "Approved" with the spender and the allowance ("Unlimited" from 2^128 up), INJ into wINJ one for one is a conversion, and its explorer link is Blockscout. Most ERC20s on Injective are bank-backed (a token pair, or an `erc20:` denom), and their moves are already bank events, so a log counts only for a token with no bank form, under its `evm:` key. Which tokens have a bank form comes from the erc20 module's pairs; if the node can't list them, no log counts rather than one counting twice.
- **ERC20s someone else sent.** A pure ERC20 transfer names the receiver only inside its log, which no tx index query can match, and public EVM nodes cap log searches at a few hours of blocks (10,000 on Injective's own). So the wallet asks Blockscout (Injective's instance by default, settable and clearable in Settings) for the account's ERC20 transfers, page by page like the index, and treats the answer as a list of places to look: each transaction it names is fetched from the user's LCD by its EVM hash and read like the rest. Blockscout can leave a transfer out but can't put a false one in. A transaction that changed nothing for the account (a zero-value transfer, as address poisoning sends) is left out. If Blockscout doesn't answer, the page says so and shows the rest. Blockscout learns the account's 0x address.
- **Layout.** Three tabs: Wallet, Activity, Settings. Receive, a token's own screen (what it is, its contract or denom, Send, and Convert where it has another form), send and the token list open over them, full screen. Swap and connected apps join the bar when they exist.
- **Receive.** A QR code of the address, encoded in house (`ui/src/qr.ts`: byte mode, error correction M). Its tests pin published Reed-Solomon vectors and a matrix that an independent reader decoded; the browser check can decode the Receive screenshots with any QR reader (`E2E_QR_DECODER`).

### Staking

- **What shows.** Stakes, unclaimed rewards and unstaking entries come from the user's LCD (`staking` and `distribution` queries), checked like any answer: this account's records only, amounts integers, rewards (18-decimal) rounded down. Staked, unstaking and unclaimed INJ count in the total. The active set comes from the bonded validators by voting power, cached five minutes per endpoint list; a stake with a validator outside it is looked up on its own and marked as earning nothing. Validator names and websites are the validators' own, cleaned like token names, and shown as theirs.
- **Actions.** Stake (only with an active, unjailed validator; "max" keeps 0.01 INJ for later fees), unstake, move to another validator, claim (every validator at once, up to 30 per tx), and cancel an unstaking. Each goes through the same prepare, review and confirm as a send, so the vault decodes and grades it; unstaking and moving draw on the stake and the fee on the balance. Watched accounts can look, not act.
- **Messages.** cosmos-sdk's staking `tx.proto` imports validator records, which pull in cometbft's types and ABCI protos, so the five staking messages are written from the wire format in `crates/cosmos/src/staking.rs` (field numbers from v0.50.14-inj.11), and a test checks their encoding against protobufjs. Injective's `MsgTransferDelegation` gives a stake to another account; it is decoded so it can be graded red.
- **Checked live** on testnet on 2026-11-09 through the extension: stake, unstake, cancel an unstaking, move, claim and Activity, each message, validator and amount checked on chain (`e2e-live.mjs … staking`).

### Approvals and grants

Settings → Approvals and grants lists what the account lets others do, and takes it back:

- **Where staking rewards go**, when it isn't the account itself (red, with "Send them here again").
- **Permissions (authz grants) it gave**, named for what they allow ("Send your tokens", "Trade on the INJ orderbook"), with the grantee and end date. Those that can move funds out are red. A revoke names the message type a grant covers: a generic grant says it, typed ones imply it (a send grant covers MsgSend; Injective's orderbook `…Authz` types cover their `Msg…`, from injective-core v1.20's `MsgTypeURL` methods). A grant whose type the wallet can't tell is listed without a revoke.
- **Fee allowances it gave**, with their limit and end, unwrapped from periodic and message-limited allowances.
- **CW20 allowances** on every CW20 the wallet lists for the account (each contract's `all_allowances`).
- **ERC20 allowances.** Blockscout's `getLogs` finds every `Approval` the account ever made (over all blocks, which public EVM nodes won't search); what is left of each comes from the token's `allowance()` on the user's EVM endpoint, so spent and revoked ones drop out. Blockscout can leave one out but can't invent one.

"Revoke all" takes back everything on the Cosmos side in one transaction (up to 30 messages); each ERC20 allowance is its own EVM transaction. Revokes go through the same prepare, review and confirm as a send; the review reads them as "You take back". Checked live on testnet on 2026-11-09 (`e2e-live.mjs … approvals`): a site's grant, fee allowance and rewards redirect, and a real unlimited ERC20 allowance, each listed, revoked and checked on chain.

### Address book and exchange memos

- **Contacts.** Settings → Address book keeps saved recipients (name, address, and the memo an exchange needs, if any) in local storage with the rest of the wallet; removing the wallet clears them. The vault's `addresses` checks each address and gives both its forms, so a contact saved as `0x…` matches a send to its `inj1…` form. Send has a Contacts picker (the user's other accounts, then the book) and a memo field for Cosmos sends; after a send to an address the review didn't name, "Save address" opens a new contact with the address and memo filled in.
- **In the review.** The book and the user's own accounts (those the wallet signs for) go into every review's risk context, dapp requests included: a recipient from it is named ("To your account Savings", "To My exchange from your address book"), and one whose start and end match a saved address but isn't it is amber (address poisoning).
- **Exchange memos.** An exchange's shared deposit address credits each deposit to a customer by its memo; a deposit without one reaches the exchange but no account. A saved memo has to be on the send: none is red, another is amber. No list of such addresses is published, so before a send the wallet also reads the recipient's latest 20 incoming transactions from the user's LCD (`coin_received.receiver`, about a second, cached ten minutes, skipped after four seconds): if at least 5 and at least half carry a memo, from at least 3 senders, the address takes deposits with a memo, the form says so while the memo is empty, and a send without one is red. On mainnet on 2026-11-09, 13 of 1,342 bank sends over 4,000 blocks had a memo; the two addresses receiving most of them had memos on 19 and 20 of their last 20 deposits and are flagged, while ordinary accounts and the fee collector aren't. An EVM send can't carry a memo, so an EVM-only token's send to such an address is red, and the form says so before the review.
- **Checked live** on testnet on 2026-11-09 (`e2e-live.mjs … contacts`): a contact saved with a memo, picked in Send, red without the memo and named with it, sent, and the memo read back from the chain.

### NFTs

Wallet → Collectibles → NFTs lists the account's CW721 NFTs (Cosmos side) and ERC721s (Injective EVM) by collection (`chain/src/nfts.ts`).

- **Where to look.** No index of NFT owners exists on chain, so collections to ask come from: the node's tx index (CW721 `wasm` events naming the account, `recipient` for transfers and sends, `owner` for mints, on the user's own LCD), Blockscout's ERC721 transfers to the 0x address, and collections the user adds by contract (a CW721 that answers `contract_info`, an ERC721 that says so through ERC-165). The tx index covers only what the node keeps; an older collection is added by hand.
- **What is held** is asked of each contract: CW721 `tokens { owner }` at 100 a page until a short page (a default page size would drop the rest without saying), up to 500 per collection with "more are held" past that; ERC721 `ownerOf` for every token Blockscout named (it can name one, not prove it's still held), and `tokenOfOwnerByIndex` for an enumerable collection added by hand.
- **Nothing is loaded from metadata.** Fetching an NFT's image or JSON would tell its host what the account holds, and NFT metadata is a common phishing vector. Names come from on-chain metadata (cw721 `extension.name`), cleaned like token names; an https link can be opened on purpose, an ipfs one shows as text; tiles show letters.
- **Send.** One NFT at a time, after the host checks it is still the account's (`owner_of` / `ownerOf`). CW721: `transfer_nft` in a Cosmos transaction (amino JSON on a Ledger). ERC721: `safeTransferFrom(from, to, id)` on the EVM side. Both go through prepare, review and confirm like a send: the vault builds and decodes them (`nft_transfer`), the review says "You send an NFT" with the collection and recipient, and the recipient rules (address book, look-alikes) apply.
- **Rules for sites.** CW721 `approve_all` and ERC721 `setApprovalForAll(true)` are red (`nft_approval_all`); a CW721 `approve` of one NFT is amber (`nft_approval`); giving an NFT away is named with its recipient (`nft_send`), to a contract noted (`nft_send_contract`); ERC721 or ERC20 `transferFrom` out of another account is amber (`transfer_from_other`).
- **Checked live** on testnet on 2026-11-09 (`e2e-live.mjs … nfts`): a cw721-base 0.18.0 collection (release hash checked) and a bare ERC721, each with two NFTs minted to the test account; the wallet found the CW721 from its mint events and the ERC721 through Blockscout, and sent one of each to a keyless address, both owners then checked with the contracts.

### Swaps

The Swap tab trades through Choice on Injective's EVM side.

- **Quote.** Choice's routing API (`GET /route`, `evm-api.choice.exchange`; testnet `testnet-api-v2.choice.exchange`) answers with a route and its calldata, for EVM routes only (`vms=evm`). The host turns away an answer for another pair or amount, to a contract the wallet doesn't pin, or with a minimum below the user's slippage (default 0.5%). Quotes and leg names are Choice's description; nothing in them is trusted beyond that.
- **The vault reads the calldata** (`choice_wallet_injective::choice`), for any swap, the wallet's own or a site's. Two contracts execute one, pinned per network and checked on chain 2026-11-09: `ChoiceAggregator` 1.1.0 (`execute`, `executeWithPermit`) and the Infinity `UniversalRouter`, read only in the one shape Choice's API builds (one `INFI_SWAP` command: swap actions, then `SETTLE_ALL`, then `TAKE_ALL`, which pays the caller). A strict ABI decoder (`choice_wallet_evm::abi`) refuses calldata that isn't the canonical encoding of what it holds. The review shows the vault's reading: what goes in, the least that comes out (rounded down to 6 decimals), who receives it, the venues, and Choice's fee as its own line ("None" today).
- **Steps.** INJ in is one transaction, its value the input. Any other token is pulled through Permit2, so it takes up to two approvals first, each for this swap's amount only: `approve(Permit2, amount)` on the token, then `Permit2.approve(token, Choice's contract, amount, 30 minutes)`. The vault builds those only for Permit2 and Choice's executors, never unlimited. Each step is its own review; after one lands, "Next step". A quote that ages past two minutes while approvals land is asked for again (same pair, amount and slippage) before the swap is built, and its review shows the new minimum.
- **Gas.** The larger of `eth_estimateGas` and Choice's estimate, plus half: Injective EVM charges the whole limit, and estimates can come in low there.
- **The wallet builds a swap only if** it pays this account, has a minimum, pays any fee to Choice's treasury, runs no adapter Choice doesn't trust, and the INJ sent matches. A site's swap that breaks one of these is graded red instead.
- **Not used:** Choice's CosmWasm aggregator (v2.2.0). It keeps the price improvement on orderbook buy legs without the quote showing it, which the wallet's fee rules don't allow. Testnet has no aggregator, so only routes on Choice's own pools with an ERC20 at both ends quote there.
- **Checked live** on testnet on 2026-11-09 (`e2e-live.mjs … 0.005 swap`): a site wrapped INJ into wINJ through the wallet, then wINJ was swapped for testnet USDT through the router: both approvals and the swap, the input down by exactly the amount, at least the minimum shown arriving, and both allowances used up. The full browser test runs both flows against quotes from Choice's live API.

### Sending

1. **Prepare** (host): read the account, spendable balances and gas price, and check the amount and fee against the balances. Build with a provisional fee, simulate, build again with the real fee. Decode and grade it with the risk rules like any dapp request. The prepared request waits in session storage under its digest.
2. **Review** (UI): shows only the vault's decode: amounts, the recipient in the chain's own form (and what the user typed, if different), the fee, the findings, and the endpoint that simulated it.
3. **Confirm** (host): removes the prepared request from storage (so a double click can't send twice), signs it only if its digest is the one the review showed, then broadcasts. The UI watches the hash until it lands in a block.

**EVM-only tokens** go out as an ERC20 `transfer` on the EVM side, through the same three steps: the host reads the nonce, base fee, tip and balances (one batch), the vault builds an EIP-1559 transaction, `eth_estimateGas` sizes it, and the vault builds it again with the real gas, decodes and grades it. An `inj1` recipient is the same account as its 0x form, and the review shows the 0x form. The review shows the token's contract when the token isn't on the wallet's list. The signed transaction goes out with `eth_sendRawTransaction` and the UI watches its receipt; the explorer link is Blockscout.

**CW20s** go out as `MsgExecuteContract` `{"transfer":…}` through the Cosmos steps above, checked against the CW20's own balance; the review shows the contract beside the symbol. **Conversions** are the same steps with the adapter's messages: the review says "You convert" and "You get" only when the call is exactly the adapter's shape (a CW20 `send` with an empty message to this network's adapter, or `redeem_and_transfer` there with one adapter denom attached); anything else is a contract call. The adapter is passed to the risk rules as a known contract, and the converted token's balance is left out of their context, since a conversion gives it all back. Whatever a conversion makes is then shown by the token filter, like a token added by hand.

- **Fees.** Injective EVM charges gas limit × max fee per gas, with no refund of unused gas or of the gap to the base fee (measured on testnet 2026-11-09: a transfer that used 52,249 gas paid for its whole 67,924-gas limit at the full max fee). So the review's fee is what gets charged, the max fee is the base fee (at the chain minimum, 160000000) plus the node's tip (0), and the gas margin is 1.2× the estimate rather than Cosmos's 1.3×. A first real send through the extension: 250 of a test ERC20 on testnet, fee 0.0000067 INJ, exactly as shown.

### Sign paths

| Path | Used by | Canonical check | Status |
| --- | --- | --- | --- |
| SIGN_MODE_DIRECT (protobuf) | Our own txs; `signDirect` from Cosmos dapps | Decode and re-encode, recursing into every `Any` (MsgExec, grant authorizations, feegrant allowances, the signer pubkey). Byte-identical or refused | Built |
| LEGACY_AMINO_JSON | Ledger Cosmos app; `signAmino` | Our own txs: amino JSON derived from the protobuf tx exactly as the chain derives it. Dapp sign docs: strict shape, signed in canonical form | Built |
| ADR-036 (`signArbitrary`) | Sign-in and proofs on Cosmos dapps | The vault builds the sign doc from the data; the site can't give one | Built |
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

Built 2026-11-09 and checked in the browser against a software Ledger (below); not yet on a real device.

- **Kit.** Ledger's Device Management Kit 1.11 with its WebHID transport and Cosmos signer kit, in the wallet's pages only (popup, approval windows, the Ledger tab), never the service worker. LedgerJS (`hw-app-*`, `hw-transport-*`) is deprecated and broke with the Ethereum app's EIP-712 change in September 2026.
- **Cosmos transactions** go through Ledger's Cosmos app as amino JSON (`inj` prefix). Under coin type 60 the app derives Ethereum-style addresses and hashes with keccak256, as Injective does, and it signs there only in Expert mode (checked in its source, `cosmos/ledger-cosmos`). A Ledger account's own Cosmos transactions are built in amino JSON; a site's `signDirect` is refused at review ("the site must ask for an amino signature"), and `getKey` says `isNanoLedger: true` so Keplr-style sites ask for amino.
- **EVM transactions and `personal_sign`** go through the Ethereum app, with its two signing commands written in `extension/src/ledger.ts` (`SIGN_TX`, `SIGN_PERSONAL_MESSAGE`) and sent through the kit. Ledger's Ethereum signer kit isn't used: it brings ethers and a context module that sends each transaction to Ledger's servers for display data, and Injective EVM isn't in that data, so a contract call is blind-signed either way (the app's Blind signing setting must be on). Typed data (`eth_signTypedData_v4`) isn't offered on a Ledger account yet.
- **Accounts.** Added in a tab (`popup.html?ledger=add`), since `navigator.hid.requestDevice()` needs a click and its chooser closes a popup. Either layout: Ledger Live (`m/44'/60'/n'/0/0`, the default) or Keplr and MetaMask's (`m/44'/60'/0'/0/n`). The device gives public keys; the vault's `key_addresses` gives their addresses; "Show on Ledger" shows one on the device to compare. A Ledger wallet keeps public keys only: no phrase or key to show, no "next account" from the popup. Later connections use the paired device without asking (`getDevices()`).
- **Signing.** `confirm_send` (or a site's approval) asks the vault for `device_request`: the app and the exact bytes the device signs and shows, for the approved digest only. The device's signature comes back through `ledger_signed` (`dapp_ledger_signed`), and the vault's `device_sign` takes it only if it verifies against the account's public key over exactly those bytes, for that approved request: the same transaction a software key would make, S made low. A rejected or bad signature leaves the request waiting, so the user can try the device again; a good one is used once.
- **The browser check** (`e2e.mjs` step 9b) gives the page a fake `navigator.hid` whose one device is played by `extension/fake-ledger.mjs` in Node: Ledger's HID framing, the dashboard (`GET_OS_VERSION` as a Nano X answers it), and the Cosmos and Ethereum apps, signing with the BIP-39 test phrase and returning high-S signatures. The real kit and transport run: accounts are added in the tab, a send is signed in the Cosmos app and a Choice swap in the Ethereum app, each broadcast only after the vault's check.
- **Not built yet:** a Ledger-only start (the first wallet must be a phrase or key today), typed data, and a check on a real device.

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

Built (2026-11-09) and checked on testnet through the extension: a test site connected, sent INJ with `eth_sendTransaction`, and signed and broadcast a bank send through `window.choice`; each landed with the exact amount and the fee the approval showed.

- **How a page reaches the wallet.** `inpage.js` runs in the page's world (a `"world": "MAIN"` content script, top frame only, https pages and plain http on localhost / 127.0.0.1). It holds nothing and decides nothing: requests go through `relay.js` (isolated world) to the service worker, which takes the origin from the browser (`sender.origin`, top frame of a tab) and never from the page. Pages hear only "something changed" and ask again for their own view, so nothing about other sites leaks.
- **Grants.** Connecting is a grant per origin, kept until the user disconnects (Settings, Connected sites). A site that isn't connected, and every site while the wallet is locked, sees no account. A connected site sees the account in use; switching accounts tells it (`accountsChanged`), and while a watch-only account is in use it sees none. A request approved for one account can't be signed by another: the vault refuses a key that isn't the request's signer. Requests wait in the service worker's memory: at most 10 at once, 3 per site, one connect or switch per site at a time. Closing the approval window rejects the request (4001); if the worker stops, waiting requests fail and the site can ask again.
- **Approval windows.** A popup window per request, showing the vault's decode of exactly what will be signed (prepared when the window asks, so the nonce and fee are fresh) and the risk rules' findings, including "First request from this site" and the non-https note. Approving names that decode's digest. It never asks for a password: a locked wallet says so and waits until the user unlocks from the toolbar. Its buttons wake 800 ms after the window is in front, visible and focused.
- **EVM:** an EIP-1193 provider announced through EIP-6963 with `rdns` `exchange.choice.wallet`, so no fight over `window.ethereum`, which the wallet leaves alone.
  - `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `net_version`, `wallet_requestPermissions` / `getPermissions` / `revokePermissions`, `wallet_switchEthereumChain` and `wallet_addEthereumChain` (between Injective and Injective testnet only, with approval), `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`.
  - `eth_sendTransaction`: the wallet sets the nonce, gas and fees itself and ignores the page's (Injective charges gas limit × max fee), at the estimate × 1.2. An estimate that fails stops the request before anything is signed, since a failing tx on Injective still pays its whole gas limit. Contract creation is refused.
  - Refused: `eth_sign` (a raw hash can't be shown), `eth_signTransaction`, typed data before v4.
  - Read-only methods (`eth_call`, `eth_getBalance`, logs, receipts, …) go to the user's own EVM endpoints.
- **Injective dapps need a PR first.** injective-ts finds EIP-6963 wallets by a fixed list of `rdns` values tied to its `Wallet` enum, so until we're added, Helix and Hub won't see us. The PR to `wallet-base`, `wallet-evm` and `wallet-cosmos` is phase 0 work. It also puts Choice Wallet on the EIP-712 v2-only list (`isEip712V2OnlyWallet`), so Injective dapps send us v2 typed data, which we decode, rather than v1.
- **Cosmos provider:** `window.choice`, Keplr's shape:
  - Built: `enable`, `getKey` (with `algo: "ethsecp256k1"`, `isNanoLedger`, `ethereumHexAddress`), `signDirect`, `signAmino`, `signArbitrary` and `verifyArbitrary` (ADR-036), `getOfflineSigner`, `getOfflineSignerOnlyAmino`, `getOfflineSignerAuto` (amino only on a Ledger), `sendTx` (through the user's own endpoints), and a `choice_keystorechange` event. `window.choice.ethereum` is the EVM provider.
  - `signArbitrary` (ADR-036): the site gives the data, never the sign doc. The vault builds the standard doc around it (`sign/MsgSignData`, empty chain ID, account number and sequence 0, no fee or memo, keys sorted) and signs keccak256 of it, as Injective keys sign: byte for byte what injective-ts's `generateArbitrarySignDoc` and its key make (`crates/injective/tests/vectors/adr36.json`). The window shows the text, or the bytes. Data shaped like a transaction (amino or protobuf JSON, a Cosmos tx's protobuf, an EVM transaction) is red, a 32-byte hash is red, other binary amber. On a Ledger it goes through the Cosmos app. `verifyArbitrary` checks a signature of this account's against the same doc, in the vault.
  - `signDirect` is simulated first, unsigned, on the user's endpoints: the approval shows what this account would see (from the bank and CW20 events, the fee apart), or why it would fail.
  - The wallet signs exactly what the dapp sent and never changes its fee.
  - Later: `signEthereum`, `experimentalSuggestChain` (other chains come with phase 3).
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
| `MsgSetWithdrawAddress` to another address; `MsgTransferDelegation` to another account; tokenfactory `MsgChangeAdmin` to another address or to none; wasm `MsgUpdateAdmin` to another address; `MsgClearAdmin` | Red | `withdraw_address`, `transfer_stake`, `denom_admin`, `contract_admin` |
| ERC20 or CW20 allowance of 2^100 or more ("unlimited") or more than the balance; `setApprovalForAll(true)`; an unlimited Permit2 `approve`; Permit and Permit2 signatures; Seaport listings | Red, names the spender | `unlimited_allowance`, `allowance_over_balance`, `nft_approval_all`, `permit2_allowance`, `permit`, `unlimited_permit`, `permit2_signature`, `marketplace_listing` |
| A message or precompile call the wallet can't read | Red | `unknown_message`, `precompile_unknown` |
| `personal_sign` of a 32-byte hash; a sign-in (EIP-4361) message for another site or another account | Red | `hash_signature`, `sign_in_wrong_site`, `sign_in_wrong_account` |
| Blocklisted site | Blocked | `site_blocked` |
| Limited allowance (Permit2 and Choice's contracts named); a limited Permit2 `approve` or permit, with its end; orderbook orders or external transfers through the exchange precompile; acting for another account through its grant; binary `personal_sign` data; a system address off Injective | Amber | `allowance`, `permit2_limited`, `permit2_allowance`, `precompile_call`, `exchange_for_other`, `binary_message`, `system_address`, `bank_precompile` |
| A send without the memo an exchange needs (saved with the contact, or read from the recipient's deposits); an EVM send to such an address, which can't carry one | Red | `memo_missing`, `memo_unsupported` |
| A CW721 `approve_all` or ERC721 `setApprovalForAll(true)`; a CW721 `approve` of one NFT; moving tokens or an NFT out of another account with `transferFrom` | Red; amber; amber | `nft_approval_all`, `nft_approval`, `transfer_from_other` |
| A Choice swap that pays someone else, has no minimum, sends its fee anywhere but Choice's treasury, runs an adapter Choice doesn't trust, or sends INJ the router doesn't use; calldata to Choice's swap contracts the wallet can't read; a Permit2 permit signed into a swap for another spender, or unlimited | Red | `swap_recipient`, `swap_no_minimum`, `swap_fee_elsewhere`, `swap_adapter`, `swap_value`, `swap_unreadable`, `permit2_signature`, `unlimited_permit` |
| More than half of a balance leaving (fees included), more than the balance, the amount plus the maximum gas over the balance, a recipient that looks like an address-book entry (address poisoning), a memo other than the one saved for the contact, a site not used before | Amber | `most_of_balance`, `more_than_balance`, `gas_over_balance`, `lookalike_address`, `memo_differs`, `site_new` |
| First interaction with a contract; fee paid through a grant or by a payer; `MsgExec`; revokes; staking (stake and unstake note the unbonding period; staked coins aren't counted as leaving); a recipient from the address book or one of the user's accounts; sign-in for this site; a Choice swap (its input isn't counted as leaving when it pays this account); Choice's fee to its treasury | Info | `swap`, `swap_fee`, `new_contract`, `fee_grant_used`, `fee_payer`, `authz_exec`, `authz_revoke`, `fee_revoke`, `allowance_revoke`, `precompile_call`, `stake`, `unstake`, `address_book`, `sign_in` |
| EIP-7702 authorizations, chain ID mismatches | Refused by the decoders, never graded | |
| `eth_sign` | Disabled: never reaches the vault | |
| `signArbitrary` (ADR-036) of data shaped like a transaction (amino or protobuf JSON, a Cosmos tx's protobuf, an EVM transaction); a 32-byte hash; other binary data | Red; red; amber | `arbitrary_tx`, `hash_signature`, `binary_message` |

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
- **Swap** through Choice on the EVM side, with the fee shown before signing (built, see [Swaps](#swaps)). INJ orderbook trading later.
- **Address book** and exchange memo warnings (built, see [Address book and exchange memos](#address-book-and-exchange-memos)).
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
- **No hidden fees, now or later.** Checked 2026-11-09: Choice's EVM aggregator takes only the `feeBps` written into the calldata (at most 1%, none set today), which the vault reads and the review shows as its own line, and the router takes nothing. Its CosmWasm aggregator keeps orderbook price improvement the quote doesn't show, so in-wallet swaps never use it.
- **Built so a fee can be added later without a redesign.** The swap flow treats a fee as a separate decoded line. On Injective's Cosmos side, the fee can be a `MsgSend` to the treasury in the same tx, which is atomic with the swap and needs no contract change. (Mainnet CosmWasm code upload is allowlisted since prop 697.)

## JavaScript stack

| Need | Choice | Version surveyed 2026-11-08 |
| --- | --- | --- |
| Build | esbuild, with a 60-line build script (`extension/build.mjs`). WXT was the first pick, but it pulls 128 npm packages into the build, and build tools can tamper with what they produce; esbuild is 2. Decided 2026-11-08 | 0.28.2 |
| UI | React, TypeScript (type checks only). Choice's visual language and tokens; the font and the listed tokens' logos ship inside the extension, so no page loads anything remote | 19.3.1, 7.0.2 |
| Package manager | npm with a lockfile, install scripts off, exact versions, and `before` set two weeks back (`.npmrc`). npm workspaces: `chain`, `ui` and `extension`, one lockfile at the root. Twelve packages in all, three of them shipped | npm 11 |
| WASM glue | `wasm-bindgen-cli` pinned to the crate's exact version (0.2.130), plus a pinned binaryen | |
| Ledger | Device Management Kit + Cosmos and Ethereum signer kits + WebHID transport | DMK 1.11 |
| Mobile dapp connections (phase 2) | Reown WalletKit | 1.6 |
| Trezor (phase 2) | `@trezor/connect-webextension`. Its signing runs in a popup hosted on connect.trezor.io, a third-party site; Injective works only over EIP-712 | |
| Keystone (phase 2) | `@keystonehq/keystone-sdk`. Injective support not yet confirmed; the QR camera needs a tab | 0.13 |

injective-ts (1.20.x), ethers and viem are used only to generate test vectors. They never ship in an extension bundle.

## Roadmap

| Phase | Scope |
| --- | --- |
| 0. Core and trust model | Rust core, Cosmos and Injective crates, EVM crate, risk rules, vault protocol and WASM build (done). Extension skeleton: the service worker hosting the vault, create / import / unlock / lock in the popup, checked in Chromium (done). The UI as its own package behind a host interface, so desktop and mobile reuse it (done). Balances and bank sends in the extension through the chain client, with user-set endpoints (done). Extension security model as a written spec with tests. EIP-6963 `rdns` fixed and the injective-ts wallet PR opened. Test vectors from injective-ts 1.20.x and alloy. Real-dapp tx corpus. uniffi targets built in CI |
| 1. Extension beta (Injective) | Create or import a seed, Ledger (DMK), send and receive, one balance list (bank + ERC20 + CW20), dapp signing, simulation, approvals screen, inventory engine, rescue address with a scoped fee grant, Choice apps integrated. In-house audit, Chrome Web Store public beta |
| 2. Depth and mobile | Rescue Mode, Trezor and Keystone, NFTs, swap. iOS and Android with Reown WalletKit. (Staking, approvals, the address book, swaps, Ledger and NFTs landed early, 2026-11-09.) |
| 3. Multichain | Ethereum, Base, Arbitrum, BSC; Cosmos Hub, Osmosis, Noble (per-chain proto sets); then Solana and Bitcoin. Vault accounts, light client |

## Licensing

- Rust crates: Apache-2.0, so other wallets can reuse the decoders and rules.
- Extension and mobile apps: GPL-3.0.
- "Choice Wallet" name and logo: trademark, so forks must rebrand. Copycat wallets are a common scam.
