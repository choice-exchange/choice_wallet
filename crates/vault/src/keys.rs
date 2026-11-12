//! The vault (one password, one vault key), each wallet's sealed secret, and accounts.

use choice_wallet_core::ed25519::{self, Ed25519Key};
use choice_wallet_core::envelope;
use choice_wallet_core::hd::{derive, injective_path, ledger_live_path, solana_ledger_live_path, solana_path};
use choice_wallet_core::keystore::{KdfParams, Secret, UnlockKey};
use choice_wallet_core::{Mnemonic, PrivateKey, PublicKey, hexutil};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::chains::{CHAINS, SOLANA};
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

/// A new vault under `password`: the sealed vault and its key (the host's unlock key).
pub(crate) fn create_vault(password: &str) -> Result<(Vec<u8>, UnlockKey), VaultError> {
    Ok(envelope::create(password.as_bytes(), KdfParams::DEFAULT)?)
}

/// The vault key, if `password` is the vault's.
pub(crate) fn unlock(vault_hex: &str, password: &str) -> Result<UnlockKey, VaultError> {
    Ok(envelope::unlock(&hex(vault_hex, "vault")?, password.as_bytes())?)
}

fn unlock_key(unlock_key_hex: &str) -> Result<UnlockKey, VaultError> {
    let bytes = Zeroizing::new(hex(unlock_key_hex, "unlock_key")?);
    Ok(UnlockKey::from_bytes(&bytes)?)
}

fn parse_secret(secret: NewSecret) -> Result<(Secret, &'static str), VaultError> {
    Ok(match secret {
        NewSecret::Mnemonic(p) => (Secret::Mnemonic(Mnemonic::parse(&p)?), "mnemonic"),
        NewSecret::PrivateKey(k) => (Secret::PrivateKey(PrivateKey::from_hex(&k)?), "private_key"),
    })
}

/// A new wallet's secret, sealed under the vault key for wallet `wallet`.
pub(crate) fn seal_secret(
    unlock_key_hex: &str,
    wallet: &str,
    secret: NewSecret,
) -> Result<(Vec<u8>, &'static str), VaultError> {
    let (secret, kind) = parse_secret(secret)?;
    Ok((
        envelope::seal_secret(&unlock_key(unlock_key_hex)?, wallet, &secret)?,
        kind,
    ))
}

/// The private key for `account` of wallet `wallet`, from its sealed secret and the vault key.
pub(crate) fn key(
    secret_hex: &str,
    wallet: &str,
    unlock_key_hex: &str,
    account: Account,
) -> Result<PrivateKey, VaultError> {
    let secret = envelope::open_secret(&unlock_key(unlock_key_hex)?, wallet, &hex(secret_hex, "secret")?)?;
    account_key(secret, account)
}

/// The Solana key for `account` of wallet `wallet`: a recovery phrase's account has one at
/// the matching Solana path; one imported key has none.
pub(crate) fn solana_key(
    secret_hex: &str,
    wallet: &str,
    unlock_key_hex: &str,
    account: Account,
) -> Result<Ed25519Key, VaultError> {
    let secret = envelope::open_secret(&unlock_key(unlock_key_hex)?, wallet, &hex(secret_hex, "secret")?)?;
    account_solana_key(&secret, account)?.ok_or_else(|| {
        VaultError::new(
            KEYSTORE,
            "this account is one imported key, which has no Solana account",
        )
    })
}

/// Both keys of `account`, from one opening of the secret.
pub(crate) fn keys(
    secret_hex: &str,
    wallet: &str,
    unlock_key_hex: &str,
    account: Account,
) -> Result<(PrivateKey, Option<Ed25519Key>), VaultError> {
    let secret = envelope::open_secret(&unlock_key(unlock_key_hex)?, wallet, &hex(secret_hex, "secret")?)?;
    let solana = account_solana_key(&secret, account)?;
    Ok((account_key(secret, account)?, solana))
}

/// A recovery phrase's Solana key for `account`: Phantom's path for the default layout,
/// Ledger Live's for Ledger Live's. `None` for an imported key (secp256k1 can't sign there).
fn account_solana_key(secret: &Secret, account: Account) -> Result<Option<Ed25519Key>, VaultError> {
    match (secret, account) {
        (Secret::Mnemonic(m), Account::Default { index }) if index <= MAX_INDEX => {
            Ok(Some(ed25519::derive(m, &solana_path(index))?))
        }
        (Secret::Mnemonic(m), Account::LedgerLive { index }) if index <= MAX_INDEX => {
            Ok(Some(ed25519::derive(m, &solana_ledger_live_path(index))?))
        }
        (Secret::Mnemonic(_), Account::Default { index } | Account::LedgerLive { index }) => {
            Err(VaultError::new(KEYSTORE, format!("account index {index} out of range")))
        }
        _ => Ok(None),
    }
}

/// What the user asked to see, after their password: a wallet's recovery phrase (or its one
/// imported key), or one account's private key. Never with the vault key alone, so a host
/// that holds it while unlocked can't show a secret without asking.
pub(crate) fn reveal(
    vault_hex: &str,
    password: &str,
    secret_hex: &str,
    wallet: &str,
    account: Option<Account>,
) -> Result<Value, VaultError> {
    let key = unlock(vault_hex, password)?;
    let secret = envelope::open_secret(&key, wallet, &hex(secret_hex, "secret")?)?;
    Ok(match (secret, account) {
        (Secret::Mnemonic(m), None) => serde_json::json!({ "phrase": m.phrase().as_str() }),
        (Secret::PrivateKey(k), None) => serde_json::json!({ "private_key": k.export_hex().as_str() }),
        (secret, Some(a)) => {
            let solana = account_solana_key(&secret, a)?.map(|k| {
                let mut pair = Zeroizing::new([0u8; 64]);
                pair[..32].copy_from_slice(&k.export()[..]);
                pair[32..].copy_from_slice(&k.public_key());
                Zeroizing::new(choice_wallet_core::base58::encode(&pair[..]))
            });
            serde_json::json!({
                "private_key": account_key(secret, a)?.export_hex().as_str(),
                "solana_private_key": solana.as_ref().map(|s| s.as_str()),
            })
        }
    })
}

/// The vault under a new password. The vault key, and so every sealed secret and the host's
/// unlock key, stay as they are.
/// A new password and a new vault key, with `secrets` (wallet ID → sealed secret, hex)
/// sealed again under it.
pub(crate) fn change_password(
    vault_hex: &str,
    password: &str,
    new_password: &str,
    secrets: &std::collections::BTreeMap<String, String>,
) -> Result<envelope::Rotated, VaultError> {
    let blobs = secrets
        .iter()
        .map(|(wallet, blob)| Ok((wallet.as_str(), hex(blob, "secret")?)))
        .collect::<Result<Vec<_>, VaultError>>()?;
    let pairs: Vec<(&str, &[u8])> = blobs.iter().map(|(w, b)| (*w, b.as_slice())).collect();
    Ok(envelope::change_password(
        &hex(vault_hex, "vault")?,
        password.as_bytes(),
        new_password.as_bytes(),
        KdfParams::DEFAULT,
        &pairs,
    )?)
}

/// A keystore from before the envelope moved into a new vault as wallet `wallet`, and the
/// kind of secret it held.
pub(crate) fn migrate(
    keystore_hex: &str,
    password: &str,
    wallet: &str,
) -> Result<(envelope::Migrated, &'static str), VaultError> {
    let m = envelope::migrate(
        &hex(keystore_hex, "keystore")?,
        password.as_bytes(),
        wallet,
        KdfParams::DEFAULT,
    )?;
    let kind = match m.secret {
        Secret::Mnemonic(_) => "mnemonic",
        Secret::PrivateKey(_) => "private_key",
    };
    Ok((m, kind))
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
            "this wallet is a recovery phrase: pick a derivation and index",
        )),
        (Secret::PrivateKey(_), _) => Err(VaultError::new(
            KEYSTORE,
            "this wallet is one imported key: use derivation \"imported\"",
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

/// `solana` is the account's Solana key, if it has one: its address joins the others under
/// each Solana cluster's ID.
pub(crate) fn info(account: Account, key: &PublicKey, solana: Option<&Ed25519Key>) -> AccountInfo {
    let mut addresses: Map<String, Value> = CHAINS
        .iter()
        .map(|c| (c.id.to_owned(), Value::String(c.address(key))))
        .collect();
    if let Some(k) = solana {
        for c in SOLANA {
            addresses.insert(c.id.to_owned(), Value::String(k.address()));
        }
    }
    AccountInfo {
        account,
        public_key: hexutil::encode(&key.compressed()),
        addresses,
    }
}
