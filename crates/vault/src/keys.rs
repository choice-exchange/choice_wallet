//! Keystores, unlocking and accounts.

use choice_wallet_core::hd::{derive, injective_path, ledger_live_path};
use choice_wallet_core::keystore::{self, KdfParams, Secret, UnlockKey};
use choice_wallet_core::{Mnemonic, PrivateKey, PublicKey, hexutil};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::chains::CHAINS;
use crate::error::{KEYSTORE, VaultError};
use crate::util::hex;

/// The secret a new keystore holds.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum NewSecret {
    /// A BIP-39 phrase (English).
    Mnemonic(Zeroizing<String>),
    /// A raw secp256k1 private key, hex with or without `0x`.
    PrivateKey(Zeroizing<String>),
}

/// Which key of a keystore to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "derivation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Account {
    /// `m/44'/60'/0'/0/{index}`: Keplr, MetaMask, injective-ts.
    Default {
        /// Account index.
        index: u32,
    },
    /// `m/44'/60'/{index}'/0/0`: Ledger Live.
    LedgerLive {
        /// Account index.
        index: u32,
    },
    /// The keystore's imported private key.
    Imported,
}

/// Hardened and non-hardened BIP-32 indices both stay below 2^31.
const MAX_INDEX: u32 = (1 << 31) - 1;

pub(crate) fn create(secret: NewSecret, password: &str) -> Result<(Vec<u8>, &'static str), VaultError> {
    let (secret, kind) = match secret {
        NewSecret::Mnemonic(p) => (Secret::Mnemonic(Mnemonic::parse(&p)?), "mnemonic"),
        NewSecret::PrivateKey(k) => (Secret::PrivateKey(PrivateKey::from_hex(&k)?), "private_key"),
    };
    Ok((keystore::seal(&secret, password.as_bytes(), KdfParams::DEFAULT)?, kind))
}

pub(crate) fn unlock(keystore_hex: &str, password: &str) -> Result<UnlockKey, VaultError> {
    Ok(keystore::unlock(&hex(keystore_hex, "keystore")?, password.as_bytes())?)
}

/// The private key for `account`, from a keystore and the key that unlocks it.
pub(crate) fn key(keystore_hex: &str, unlock_key_hex: &str, account: Account) -> Result<PrivateKey, VaultError> {
    let blob = hex(keystore_hex, "keystore")?;
    let unlock_bytes = Zeroizing::new(hex(unlock_key_hex, "unlock_key")?);
    let secret = keystore::open_with_key(&blob, &UnlockKey::from_bytes(&unlock_bytes)?)?;
    account_key(secret, account)
}

/// What the user asked to see, after their password: the keystore's recovery phrase (or its
/// one imported key), or one account's private key. Never with the unlock key alone, so a
/// host that holds it while unlocked can't show the secret without asking.
pub(crate) fn reveal(keystore_hex: &str, password: &str, account: Option<Account>) -> Result<Value, VaultError> {
    let secret = keystore::open(&hex(keystore_hex, "keystore")?, password.as_bytes())?;
    Ok(match (secret, account) {
        (Secret::Mnemonic(m), None) => serde_json::json!({ "phrase": m.phrase().as_str() }),
        (Secret::PrivateKey(k), None) => serde_json::json!({ "private_key": k.export_hex().as_str() }),
        (secret, Some(a)) => serde_json::json!({ "private_key": account_key(secret, a)?.export_hex().as_str() }),
    })
}

/// The keystore's secret sealed under a new password (fresh salt and nonce, default
/// parameters), and the key that now unlocks it.
pub(crate) fn change_password(keystore_hex: &str, password: &str, new_password: &str) -> Result<(Vec<u8>, UnlockKey), VaultError> {
    let secret = keystore::open(&hex(keystore_hex, "keystore")?, password.as_bytes())?;
    Ok(keystore::seal_keyed(&secret, new_password.as_bytes(), KdfParams::DEFAULT)?)
}

fn account_key(secret: Secret, account: Account) -> Result<PrivateKey, VaultError> {
    let index_ok = |i: u32| {
        if i <= MAX_INDEX {
            Ok(i)
        } else {
            Err(VaultError::new(KEYSTORE, format!("account index {i} out of range")))
        }
    };
    match (secret, account) {
        (Secret::Mnemonic(m), Account::Default { index }) => Ok(derive(&m, &injective_path(index_ok(index)?))?),
        (Secret::Mnemonic(m), Account::LedgerLive { index }) => Ok(derive(&m, &ledger_live_path(index_ok(index)?))?),
        (Secret::PrivateKey(k), Account::Imported) => Ok(k),
        (Secret::Mnemonic(_), Account::Imported) => Err(VaultError::new(
            KEYSTORE,
            "this keystore holds a recovery phrase: pick a derivation and index",
        )),
        (Secret::PrivateKey(_), _) => Err(VaultError::new(
            KEYSTORE,
            "this keystore holds one imported key: use derivation \"imported\"",
        )),
    }
}

/// An account as the `accounts` method lists it: its public key and its address on every
/// chain the vault knows.
#[derive(Serialize)]
pub(crate) struct AccountInfo {
    account: Account,
    public_key: String,
    addresses: Map<String, Value>,
}

pub(crate) fn info(account: Account, key: &PublicKey) -> AccountInfo {
    AccountInfo {
        account,
        public_key: hexutil::encode(&key.compressed()),
        addresses: CHAINS
            .iter()
            .map(|c| (c.id.to_owned(), Value::String(c.address(key))))
            .collect(),
    }
}
