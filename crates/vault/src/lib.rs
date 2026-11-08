//! Choice Wallet's vault API: one entry point, [`handle`], the same on every platform.
//!
//! A host sends `{"method": …, "params": {…}}` as JSON and gets back
//! `{"ok": true, "result": …}` or `{"ok": false, "error": {"code": …, "message": …}}`.
//! The extension calls it through WASM (`choice-wallet-wasm`) from its service worker; a
//! desktop (Tauri) or mobile (uniffi) host calls it natively. The UI talks the same
//! protocol to every host, so its code is shared.
//!
//! The vault keeps no state between calls. A host stores the encrypted keystore, and while
//! the wallet is unlocked, the unlock key (the extension in `chrome.storage.session`, a
//! native host in its own memory). Calls that need a key take both. UI pages never need
//! either: the host adds them, so on desktop and mobile they never reach the web view.
//!
//! | Method | Params | Result |
//! | --- | --- | --- |
//! | `version` | | `protocol`, `vault` |
//! | `chains` | | the chains the vault knows, by CAIP-2 ID |
//! | `generate_mnemonic` | `words` (12 or 24) | `phrase` |
//! | `create_keystore` | `secret` (`{"mnemonic": …}` or `{"private_key": …}`), `password` | `keystore`, `kind` |
//! | `unlock` | `keystore`, `password` | `unlock_key` |
//! | `accounts` | `keystore`, `unlock_key`, `accounts` | each account's public key and addresses |
//! | `build_cosmos` | chain, signer, messages, fee, … | a sign request, and `simulate_tx` for a gas estimate |
//! | `build_evm` | chain, from, to, amount, token, fees | a sign request |
//! | `decode` | `request`, `context` (optional) | `display`, `risk`, `digest` |
//! | `sign` | `keystore`, `unlock_key`, `account`, `request`, `digest` | signature and signed tx |
//!
//! A sign request is one of `cosmos_direct`, `cosmos_amino_tx`, `cosmos_amino`,
//! `evm_transaction`, `evm_typed_data`, `evm_personal_sign`. `decode` grades it with the
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
pub const PROTOCOL: u32 = 1;

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
struct GenerateMnemonic {
    words: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateKeystore {
    secret: NewSecret,
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unlock {
    keystore: String,
    password: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Accounts {
    keystore: String,
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
    keystore: String,
    unlock_key: Zeroizing<String>,
    account: Account,
    #[serde(borrow)]
    request: SignRequest<'a>,
    digest: String,
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
        "create_keystore" => {
            let CreateKeystore { secret, password } = params(p)?;
            let (blob, kind) = keys::create(secret, &password)?;
            Ok(json!({ "keystore": hexutil::encode(&blob), "kind": kind }))
        }
        "unlock" => {
            let Unlock { keystore, password } = params(p)?;
            let key = keys::unlock(&keystore, &password)?;
            Ok(json!({ "unlock_key": hexutil::encode(key.as_bytes()) }))
        }
        "accounts" => {
            let Accounts {
                keystore,
                unlock_key,
                accounts,
            } = params(p)?;
            let list = accounts
                .into_iter()
                .map(|a| Ok(keys::info(a, &keys::key(&keystore, &unlock_key, a)?.public_key())))
                .collect::<Result<Vec<_>, VaultError>>()?;
            Ok(json!({ "accounts": list }))
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
                keystore,
                unlock_key,
                account,
                request,
                digest,
            } = borrowed(p)?;
            let checked = request::decode(request)?;
            let key = keys::key(&keystore, &unlock_key, account)?;
            request::sign(checked, &digest, &key)
        }
        other => Err(VaultError::new(UNKNOWN_METHOD, format!("unknown method {other:?}"))),
    }
}

#[cfg(test)]
mod tests;
