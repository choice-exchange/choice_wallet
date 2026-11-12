//! The envelope: one password, one random vault key, and each wallet's secret sealed
//! under that key, so a device can hold several recovery phrases and imported keys behind
//! one password.
//!
//! - **The vault** is a [`keystore`] (Argon2id + XChaCha20-Poly1305, its header
//!   authenticated) whose plaintext is kind 3 and a random 32-byte vault key. The password
//!   opens it; nothing else does.
//! - **A secret** (a recovery phrase's entropy or a private key, `kind || bytes` as in a
//!   keystore) is sealed with XChaCha20-Poly1305 under the vault key directly: the key is
//!   random, so there is nothing to stretch. Format v1:
//!
//!   | bytes | field                                   |
//!   |-------|-----------------------------------------|
//!   | 0..4  | magic `CWSE`                            |
//!   | 4     | format version, `1`                     |
//!   | 5..29 | nonce, 24 random bytes                  |
//!   | 29..  | ciphertext and 16-byte Poly1305 tag     |
//!
//!   The associated data is the header and the wallet's ID, so a sealed secret opens only
//!   as the wallet it was sealed for: blobs can't be swapped between wallets undetected.
//!
//! Unlocking runs Argon2 once, however many wallets there are. A new password makes a new
//! vault key and seals every secret again under it, so what was taken before opens nothing
//! afterwards. Adding or removing a wallet touches only its own blob.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::keystore::{self, KIND_VAULT_KEY, KdfParams, Secret, UnlockKey};
use crate::{Error, random};

const MAGIC: &[u8; 4] = b"CWSE";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 29;
const TAG_LEN: usize = 16;
/// Wallet IDs: what the host names its wallets by, 1 to 64 of `[a-z0-9-]`.
const MAX_ID: usize = 64;

fn check_id(wallet: &str) -> Result<&[u8], Error> {
    let ok = !wallet.is_empty()
        && wallet.len() <= MAX_ID
        && wallet
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(wallet.as_bytes())
    } else {
        Err(Error::Keystore("wallet id must be 1 to 64 of a-z, 0-9 and -"))
    }
}

/// A new vault under `password`: the sealed vault and its key.
pub fn create(password: &[u8], params: KdfParams) -> Result<(Vec<u8>, UnlockKey), Error> {
    let mut plaintext = Zeroizing::new([0u8; 33]);
    plaintext[0] = KIND_VAULT_KEY;
    random::fill(&mut plaintext[1..])?;
    let (vault, _) = keystore::seal_bytes(&plaintext[..], password, params)?;
    Ok((vault, UnlockKey::from_bytes(&plaintext[1..])?))
}

/// The vault key, if `password` is the vault's. A wrong password and a damaged vault give
/// the same error, [`Error::Decrypt`].
pub fn unlock(vault: &[u8], password: &[u8]) -> Result<UnlockKey, Error> {
    let kek = keystore::unlock(vault, password)?;
    let plaintext = keystore::open_bytes(vault, &kek)?;
    match (plaintext.first(), plaintext.get(1..)) {
        (Some(&KIND_VAULT_KEY), Some(key)) if key.len() == 32 => UnlockKey::from_bytes(key),
        _ => Err(Error::Keystore("not a vault")),
    }
}

/// A vault after a password change: a new vault key under the new password, and every
/// secret sealed again under it.
pub struct Rotated {
    /// The new vault.
    pub vault: Vec<u8>,
    /// Its vault key (the new unlock key).
    pub key: UnlockKey,
    /// The secrets, sealed under the new key, in the order given.
    pub secrets: Vec<Vec<u8>>,
}

/// A new password and a new vault key: each `(wallet, sealed secret)` is opened with the old
/// key and sealed again under a fresh random one, wrapped under `new_password`. A copy of the
/// old vault with the old password, or an unlock key taken before, opens nothing sealed after
/// this. Nothing is returned unless every secret opened.
pub fn change_password(
    vault: &[u8],
    password: &[u8],
    new_password: &[u8],
    params: KdfParams,
    secrets: &[(&str, &[u8])],
) -> Result<Rotated, Error> {
    let old = unlock(vault, password)?;
    let opened = secrets
        .iter()
        .map(|(wallet, blob)| open_secret(&old, wallet, blob))
        .collect::<Result<Vec<_>, _>>()?;
    let (vault, key) = create(new_password, params)?;
    let secrets = secrets
        .iter()
        .zip(&opened)
        .map(|((wallet, _), secret)| seal_secret(&key, wallet, secret))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Rotated { vault, key, secrets })
}

/// Seal `secret` for wallet `wallet` under the vault key.
pub fn seal_secret(key: &UnlockKey, wallet: &str, secret: &Secret) -> Result<Vec<u8>, Error> {
    let id = check_id(wallet)?;
    let mut header = [0u8; HEADER_LEN];
    header[0..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    random::fill(&mut header[5..29])?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| Error::Keystore("cipher init"))?;
    let nonce = XNonce::try_from(&header[5..29]).map_err(|_| Error::Keystore("nonce"))?;
    let aad = [&header[..], id].concat();
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &keystore::encode_secret(secret),
                aad: &aad,
            },
        )
        .map_err(|_| Error::Keystore("encryption failed"))?;
    Ok([&header[..], &ciphertext].concat())
}

/// Open wallet `wallet`'s sealed secret with the vault key. A wrong key, the wrong wallet
/// or a damaged blob give [`Error::Decrypt`].
pub fn open_secret(key: &UnlockKey, wallet: &str, blob: &[u8]) -> Result<Secret, Error> {
    let id = check_id(wallet)?;
    if blob.len() < HEADER_LEN + TAG_LEN + 1 || &blob[0..4] != MAGIC {
        return Err(Error::Keystore("not a sealed secret"));
    }
    if blob[4] != VERSION {
        return Err(Error::Keystore("unsupported secret version"));
    }
    let (header, ciphertext) = blob.split_at(HEADER_LEN);
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| Error::Decrypt)?;
    let nonce = XNonce::try_from(&header[5..29]).map_err(|_| Error::Decrypt)?;
    let aad = [header, id].concat();
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::Decrypt)?,
    );
    keystore::decode_secret(&plaintext)
}

/// A keystore from before the envelope, moved into a new vault.
pub struct Migrated {
    /// The new vault, under the same password.
    pub vault: Vec<u8>,
    /// Its vault key.
    pub key: UnlockKey,
    /// The keystore's secret, sealed as the wallet asked for.
    pub sealed: Vec<u8>,
    /// The secret itself, to tell its kind.
    pub secret: Secret,
}

/// A keystore from before the envelope (its secret sealed under the password itself),
/// moved into a new vault as wallet `wallet`. Argon2 runs twice: to open, then to seal.
pub fn migrate(old: &[u8], password: &[u8], wallet: &str, params: KdfParams) -> Result<Migrated, Error> {
    let secret = keystore::open(old, password)?;
    let (vault, key) = create(password, params)?;
    let sealed = seal_secret(&key, wallet, &secret)?;
    Ok(Migrated {
        vault,
        key,
        sealed,
        secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Mnemonic, PrivateKey};

    const PASSWORD: &[u8] = b"correct horse battery staple";
    const FAST: KdfParams = KdfParams::MINIMUM;
    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn phrase() -> Secret {
        Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap())
    }

    #[test]
    fn one_password_opens_every_wallet() {
        let (vault, key) = create(PASSWORD, FAST).unwrap();
        assert_eq!(unlock(&vault, PASSWORD).unwrap().as_bytes(), key.as_bytes());
        let a = seal_secret(&key, "w1", &phrase()).unwrap();
        let b = seal_secret(
            &key,
            "w2",
            &Secret::PrivateKey(PrivateKey::from_hex(&"46".repeat(32)).unwrap()),
        )
        .unwrap();
        let k = unlock(&vault, PASSWORD).unwrap();
        assert!(matches!(open_secret(&k, "w1", &a).unwrap(), Secret::Mnemonic(m) if m.phrase().as_str() == ABANDON));
        assert!(matches!(open_secret(&k, "w2", &b).unwrap(), Secret::PrivateKey(_)));
        assert_eq!(
            unlock(&vault, b"correct horse battery stapler").unwrap_err(),
            Error::Decrypt
        );
    }

    #[test]
    fn a_secret_opens_only_as_its_own_wallet_and_under_its_own_vault() {
        let (_, key) = create(PASSWORD, FAST).unwrap();
        let (_, other) = create(PASSWORD, FAST).unwrap();
        let a = seal_secret(&key, "w1", &phrase()).unwrap();
        assert_eq!(open_secret(&key, "w2", &a).unwrap_err(), Error::Decrypt);
        assert_eq!(open_secret(&other, "w1", &a).unwrap_err(), Error::Decrypt);
        let mut bent = a.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert_eq!(open_secret(&key, "w1", &bent).unwrap_err(), Error::Decrypt);
        let mut nonce = a.clone();
        nonce[10] ^= 1;
        assert_eq!(open_secret(&key, "w1", &nonce).unwrap_err(), Error::Decrypt);
        assert!(open_secret(&key, "W1", &a).is_err());
        assert!(seal_secret(&key, "", &phrase()).is_err());
        assert!(seal_secret(&key, &"a".repeat(65), &phrase()).is_err());
    }

    #[test]
    fn a_vault_is_not_a_keystore_and_a_keystore_is_not_a_vault() {
        let (vault, _) = create(PASSWORD, FAST).unwrap();
        let kek = keystore::unlock(&vault, PASSWORD).unwrap();
        assert!(keystore::open_with_key(&vault, &kek).is_err());
        let old = keystore::seal(&phrase(), PASSWORD, FAST).unwrap();
        assert_eq!(unlock(&old, PASSWORD).unwrap_err(), Error::Keystore("not a vault"));
    }

    /// F12: a new password makes a new vault key and seals every secret again, so the old
    /// vault (with the old password) and the old key open nothing from then on.
    #[test]
    fn a_new_password_rotates_the_vault_key() {
        let (vault, key) = create(PASSWORD, FAST).unwrap();
        let sealed = seal_secret(&key, "w1", &phrase()).unwrap();
        let r = change_password(&vault, PASSWORD, b"a whole new password", FAST, &[("w1", &sealed)]).unwrap();
        assert_eq!(unlock(&r.vault, PASSWORD).unwrap_err(), Error::Decrypt);
        let k = unlock(&r.vault, b"a whole new password").unwrap();
        assert_eq!(k.as_bytes(), r.key.as_bytes());
        assert_ne!(k.as_bytes(), key.as_bytes());
        assert!(open_secret(&k, "w1", &r.secrets[0]).is_ok());
        // The old key opens neither the re-sealed secret nor one sealed afterwards.
        assert_eq!(open_secret(&key, "w1", &r.secrets[0]).unwrap_err(), Error::Decrypt);
        let later = seal_secret(&k, "w2", &phrase()).unwrap();
        assert_eq!(open_secret(&key, "w2", &later).unwrap_err(), Error::Decrypt);
        assert_eq!(
            change_password(&vault, b"wrong password", b"a whole new password", FAST, &[])
                .err()
                .unwrap(),
            Error::Decrypt
        );
        assert!(change_password(&vault, PASSWORD, b"short", FAST, &[]).is_err());
        // A secret that doesn't open with the vault's key stops the change.
        assert_eq!(
            change_password(&vault, PASSWORD, b"a whole new password", FAST, &[("w2", &sealed)])
                .err()
                .unwrap(),
            Error::Decrypt
        );
    }

    #[test]
    fn an_old_keystore_moves_into_a_vault() {
        let old = keystore::seal(&phrase(), PASSWORD, FAST).unwrap();
        let Migrated {
            vault,
            key,
            sealed,
            secret,
        } = migrate(&old, PASSWORD, "w1", FAST).unwrap();
        assert!(matches!(secret, Secret::Mnemonic(_)));
        assert_eq!(unlock(&vault, PASSWORD).unwrap().as_bytes(), key.as_bytes());
        assert!(
            matches!(open_secret(&key, "w1", &sealed).unwrap(), Secret::Mnemonic(m) if m.phrase().as_str() == ABANDON)
        );
        assert_eq!(
            migrate(&old, b"wrong password!", "w1", FAST).err().unwrap(),
            Error::Decrypt
        );
    }
}
