//! Choice Wallet's vault API: one entry point, [`handle`], the same on every platform.
//!
//! A host sends `{"method": …, "params": {…}}` as JSON and gets back
//! `{"ok": true, "result": …}` or `{"ok": false, "error": {"code": …, "message": …}}`.
//! The extension calls it through WASM (`choice-wallet-wasm`) from its service worker; a
//! desktop (Tauri) or mobile (uniffi) host calls it natively. The UI talks the same
//! protocol to every host, so its code is shared.
//!
//! The vault keeps no state between calls. A host stores the encrypted vault (one password
//! wraps a random vault key; see `choice_wallet_core::envelope`) and each wallet's secret,
//! sealed under that key and bound to the wallet's ID: a recovery phrase or an imported
//! key. While the wallet is unlocked the host keeps the unlock key (the vault key: the
//! extension in `chrome.storage.session`, a native host in its own memory). Calls that need
//! a key take the wallet's sealed secret, its ID and the unlock key. UI pages never see
//! any of them: the host adds them, so on desktop and mobile they never reach the web view.
//!
//! | Method | Params | Result |
//! | --- | --- | --- |
//! | `version` | | `protocol`, `vault` |
//! | `chains` | | the chains the vault knows, by CAIP-2 ID |
//! | `generate_mnemonic` | `words` (12 or 24) | `phrase` |
//! | `create_vault` | `password` | `vault`, `unlock_key` |
//! | `unlock` | `vault`, `password` | `unlock_key` |
//! | `seal_secret` | `unlock_key`, `wallet` (its ID), `secret` (`{"mnemonic": …}` or `{"private_key": …}`) | `secret` (sealed), `kind` |
//! | `migrate` | `keystore` (from before vaults), `password`, `wallet` | `vault`, `unlock_key`, `secret`, `kind` |
//! | `accounts` | `secret`, `wallet`, `unlock_key`, `accounts` | each account's public key and addresses |
//! | `addresses` | `address` (an account's `inj1…` or `0x…`) | the same account's address on every chain, e.g. to watch it |
//! | `reveal` | `vault`, `password`, `secret`, `wallet`, `account` (optional) | `phrase`, or `private_key` (the wallet's own, or the account's) |
//! | `change_password` | `vault`, `password`, `new_password`, `secrets` (wallet ID → sealed secret) | a new `vault` and `unlock_key` (a new vault key), and every secret sealed again under it |
//! | `build_cosmos` | chain, signer, messages, fee, … | a sign request, and `simulate_tx` for a gas estimate |
//! | `build_evm` | chain, from, to, amount, token, fees | a sign request |
//! | `decode` | `request`, `context` (optional) | `display`, `risk`, `digest` |
//! | `sign` | `secret`, `wallet`, `unlock_key`, `account`, `request`, `digest` | signature and signed tx |
//! | `key_addresses` | `public_key` (a hardware wallet's account, from the device), `solana_public_key` (optional, from its Solana app) | its addresses on every chain |
//! | `device_request` | `request`, `digest` | what a hardware wallet signs: `app` (`cosmos`, `ethereum`, `solana`), `kind`, `payload` |
//! | `device_sign` | `request`, `digest`, `public_key`, `signature`, `format` (`der`, `rs`; Solana's 64 bytes are `rs`) | as `sign`, from the device's signature |
//! | `verify_arbitrary` | `chain`, `address`, `data`, `public_key`, `signature` (`r \|\| s`) | `valid`: an ADR-036 signature of `data` by `address` |
//!
//! A hardware wallet's account has no secret here. The host keeps its public key (read from
//! the device when it was added); `device_request` gives the bytes the device signs (and
//! shows), and `device_sign` takes the signature only if it verifies against that key over
//! exactly those bytes, for the request that was approved.
//!
//! A sign request is one of `cosmos_direct`, `cosmos_amino_tx`, `cosmos_amino`,
//! `cosmos_arbitrary` (ADR-036), `evm_transaction`, `evm_typed_data`, `evm_personal_sign`,
//! `solana_transaction`, `solana_message`. Solana requests are signed with the account's
//! ed25519 key (SLIP-0010, Phantom's path; its address joins `accounts`' under each Solana
//! cluster's ID), a Ledger's through its Solana app (`device_sign` takes the 32-byte key).
//! `decode` grades it with the
//! risk rules (`choice-wallet-policy`) against the host's `context`. `sign` decodes it again
//! and signs only if its digest is the one `decode` returned and the user approved.
//!
//! Integers that can exceed 2^53 are decimal strings in results; params accept numbers or
//! strings. Bytes are hex without a prefix, except EVM values, which use `0x`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod build;
pub mod chains;
pub mod error;
mod keys;
mod request;
mod util;

use choice_wallet_core::{Mnemonic, hexutil};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::error::{UNKNOWN_METHOD, VaultError};
use crate::keys::{Account, NewSecret};
use crate::request::SignRequest;

/// Protocol version. Bumped on any incompatible change.
pub const PROTOCOL: u32 = 2;

/// Handle one JSON request and return the JSON response. Never panics on bad input.
pub fn handle(request: &str) -> String {
    let response = match call(request) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    response.to_string()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<'a> {
    method: String,
    #[serde(borrow, default)]
    params: Option<&'a RawValue>,
}

fn params<T: DeserializeOwned>(raw: Option<&RawValue>) -> Result<T, VaultError> {
    serde_json::from_str(raw.map_or("{}", RawValue::get)).map_err(|e| VaultError::bad(e.to_string()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reveal {
    vault: String,
    password: Zeroizing<String>,
    secret: String,
    wallet: String,
    #[serde(default)]
    account: Option<Account>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangePassword {
    vault: String,
    password: Zeroizing<String>,
    new_password: Zeroizing<String>,
    /// Every wallet's sealed secret, by wallet ID: sealed again under the new vault key.
    #[serde(default)]
    secrets: std::collections::BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Addresses {
    address: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyAddresses {
    public_key: String,
    /// The account's key from the device's Solana app (32 bytes, hex), if it was read.
    #[serde(default)]
    solana_public_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRequest<'a> {
    #[serde(borrow)]
    request: SignRequest<'a>,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceSign<'a> {
    #[serde(borrow)]
    request: SignRequest<'a>,
    digest: String,
    public_key: String,
    signature: String,
    format: request::SignatureFormat,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyArbitrary {
    chain: String,
    address: String,
    data: String,
    public_key: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerateMnemonic {
    words: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateVault {
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unlock {
    vault: String,
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SealSecret {
    unlock_key: Zeroizing<String>,
    wallet: String,
    secret: NewSecret,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Migrate {
    keystore: String,
    password: Zeroizing<String>,
    wallet: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Accounts {
    secret: String,
    wallet: String,
    unlock_key: Zeroizing<String>,
    accounts: Vec<Account>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decode<'a> {
    #[serde(borrow)]
    request: SignRequest<'a>,
    /// What the host knows about the site, balances and address book, for the risk rules.
    #[serde(default)]
    context: choice_wallet_policy::Context,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sign<'a> {
    secret: String,
    wallet: String,
    unlock_key: Zeroizing<String>,
    account: Account,
    #[serde(borrow)]
    request: SignRequest<'a>,
    digest: String,
}

/// A public key a device returned, compressed (33 bytes) or not (65), hex.
fn device_key(s: &str) -> Result<choice_wallet_core::PublicKey, VaultError> {
    choice_wallet_core::PublicKey::from_sec1_bytes(&util::hex(s, "public_key")?)
        .map_err(|_| VaultError::bad("public_key is not a secp256k1 public key"))
}

/// Parameters that borrow from the request text (embedded JSON kept exactly as sent).
fn borrowed<'a, T: Deserialize<'a>>(raw: Option<&'a RawValue>) -> Result<T, VaultError> {
    serde_json::from_str(raw.map_or("{}", RawValue::get)).map_err(|e| VaultError::bad(e.to_string()))
}

fn call(request: &str) -> Result<Value, VaultError> {
    let env: Envelope = serde_json::from_str(request).map_err(|e| VaultError::bad(e.to_string()))?;
    let p = env.params;
    match env.method.as_str() {
        "version" => Ok(json!({ "protocol": PROTOCOL, "vault": env!("CARGO_PKG_VERSION") })),
        "chains" => Ok(serde_json::to_value(chains::list()).expect("plain data")),
        "generate_mnemonic" => {
            let GenerateMnemonic { words } = params(p)?;
            let m = Mnemonic::generate(words)?;
            Ok(json!({ "phrase": m.phrase().as_str() }))
        }
        "create_vault" => {
            let CreateVault { password } = params(p)?;
            let (vault, key) = keys::create_vault(&password)?;
            Ok(json!({ "vault": hexutil::encode(&vault), "unlock_key": hexutil::encode(key.as_bytes()) }))
        }
        "unlock" => {
            let Unlock { vault, password } = params(p)?;
            let key = keys::unlock(&vault, &password)?;
            Ok(json!({ "unlock_key": hexutil::encode(key.as_bytes()) }))
        }
        "seal_secret" => {
            let SealSecret {
                unlock_key,
                wallet,
                secret,
            } = params(p)?;
            let (sealed, kind) = keys::seal_secret(&unlock_key, &wallet, secret)?;
            Ok(json!({ "secret": hexutil::encode(&sealed), "kind": kind }))
        }
        "migrate" => {
            let Migrate {
                keystore,
                password,
                wallet,
            } = params(p)?;
            let (m, kind) = keys::migrate(&keystore, &password, &wallet)?;
            Ok(json!({
                "vault": hexutil::encode(&m.vault),
                "unlock_key": hexutil::encode(m.key.as_bytes()),
                "secret": hexutil::encode(&m.sealed),
                "kind": kind,
            }))
        }
        "accounts" => {
            let Accounts {
                secret,
                wallet,
                unlock_key,
                accounts,
            } = params(p)?;
            let list = accounts
                .into_iter()
                .map(|a| {
                    let (key, solana) = keys::keys(&secret, &wallet, &unlock_key, a)?;
                    Ok(keys::info(a, &key.public_key(), solana.as_ref()))
                })
                .collect::<Result<Vec<_>, VaultError>>()?;
            Ok(json!({ "accounts": list }))
        }
        "addresses" => {
            // One account on every chain: an address that some chain can't read (a 32-byte
            // contract, another chain's prefix) isn't an account the wallet can follow.
            let Addresses { address } = params(p)?;
            // An `inj1…` names the same 20 bytes as its 0x, which is the account on every EVM
            // chain; only Injective's own sides read the `inj1` form.
            let hex = chains::find("eip155:1776")?.parse_address(&address);
            let list = chains::CHAINS
                .iter()
                .map(|c| {
                    let a = match (c.kind, c.injective, &hex) {
                        (chains::Kind::Evm(_), None, Ok(h)) => h.clone(),
                        _ => c.parse_address(&address)?,
                    };
                    Ok((c.id.to_owned(), Value::String(a)))
                })
                .collect::<Result<serde_json::Map<String, Value>, VaultError>>()
                .map_err(|_| VaultError::bad(format!("{:?} isn't an Injective account address", address.trim())))?;
            Ok(json!({ "addresses": list }))
        }
        "reveal" => {
            let Reveal {
                vault,
                password,
                secret,
                wallet,
                account,
            } = params(p)?;
            keys::reveal(&vault, &password, &secret, &wallet, account)
        }
        "change_password" => {
            let ChangePassword {
                vault,
                password,
                new_password,
                secrets,
            } = params(p)?;
            let r = keys::change_password(&vault, &password, &new_password, &secrets)?;
            let sealed: serde_json::Map<String, Value> = secrets
                .keys()
                .zip(&r.secrets)
                .map(|(wallet, s)| (wallet.clone(), Value::String(hexutil::encode(s))))
                .collect();
            Ok(
                json!({ "vault": hexutil::encode(&r.vault), "unlock_key": hexutil::encode(r.key.as_bytes()), "secrets": sealed }),
            )
        }
        "build_cosmos" => build::cosmos(params(p)?),
        "build_evm" => Ok(json!({ "request": build::evm(params(p)?)? })),
        "decode" => {
            let Decode { request, context } = borrowed(p)?;
            let checked = request::decode(request)?;
            Ok(json!({
                "display": checked.display,
                "risk": checked.assess(&context),
                "digest": hexutil::encode(&checked.digest),
            }))
        }
        "sign" => {
            let Sign {
                secret,
                wallet,
                unlock_key,
                account,
                request,
                digest,
            } = borrowed(p)?;
            let checked = request::decode(request)?;
            if checked.solana() {
                let key = keys::solana_key(&secret, &wallet, &unlock_key, account)?;
                return request::sign_solana(checked, &digest, &key);
            }
            let key = keys::key(&secret, &wallet, &unlock_key, account)?;
            request::sign(checked, &digest, &key)
        }
        "key_addresses" => {
            let KeyAddresses {
                public_key,
                solana_public_key,
            } = params(p)?;
            let pk = device_key(&public_key)?;
            let mut addresses = chains::CHAINS
                .iter()
                .map(|c| (c.id.to_owned(), Value::String(c.address(&pk))))
                .collect::<serde_json::Map<String, Value>>();
            if let Some(k) = solana_public_key {
                let k: [u8; 32] = util::hex(&k, "solana_public_key")?
                    .try_into()
                    .ok()
                    .filter(choice_wallet_core::ed25519::on_curve)
                    .ok_or_else(|| VaultError::bad("solana_public_key is not an ed25519 public key"))?;
                for c in chains::SOLANA {
                    addresses.insert(c.id.to_owned(), Value::String(choice_wallet_core::base58::encode(&k)));
                }
            }
            Ok(json!({ "public_key": hexutil::encode(&pk.compressed()), "addresses": addresses }))
        }
        "verify_arbitrary" => {
            let VerifyArbitrary {
                chain,
                address,
                data,
                public_key,
                signature,
            } = params(p)?;
            let valid = request::verify_arbitrary(
                &chain,
                &address,
                util::hex(&data, "data")?,
                &device_key(&public_key)?,
                &util::hex(&signature, "signature")?,
            )?;
            Ok(json!({ "valid": valid }))
        }
        "device_request" => {
            let DeviceRequest { request, digest } = borrowed(p)?;
            request::device_request(&request::decode(request)?, &digest)
        }
        "device_sign" => {
            let DeviceSign {
                request,
                digest,
                public_key,
                signature,
                format,
            } = borrowed(p)?;
            let checked = request::decode(request)?;
            if checked.solana() {
                // A Solana device key: 32 bytes, hex.
                let pk: [u8; 32] = util::hex(&public_key, "public_key")?
                    .try_into()
                    .map_err(|_| VaultError::bad("public_key is not an ed25519 public key"))?;
                return request::device_sign_solana(checked, &digest, &pk, &util::hex(&signature, "signature")?);
            }
            let pk = device_key(&public_key)?;
            request::device_sign(checked, &digest, &pk, &util::hex(&signature, "signature")?, format)
        }
        other => Err(VaultError::new(UNKNOWN_METHOD, format!("unknown method {other:?}"))),
    }
}

#[cfg(test)]
mod tests;
