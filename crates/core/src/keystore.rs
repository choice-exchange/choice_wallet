//! Encrypted keystore: Argon2id key derivation + XChaCha20-Poly1305.
//!
//! Format v1, integers big-endian:
//!
//! | bytes  | field                                     |
//! |--------|-------------------------------------------|
//! | 0..4   | magic `CWKS`                              |
//! | 4      | format version, `1`                       |
//! | 5      | KDF id, `1` = Argon2id v1.3               |
//! | 6..10  | memory cost, KiB                          |
//! | 10..14 | time cost (passes)                        |
//! | 14..18 | parallelism                               |
//! | 18..34 | salt, 16 random bytes                     |
//! | 34..58 | nonce, 24 random bytes                    |
//! | 58..   | ciphertext and 16-byte Poly1305 tag       |
//!
//! Bytes `0..58` are the AEAD associated data, so no header field can be
//! changed without decryption failing. The plaintext is
//! `kind (1 byte) || secret`, where kind 1 is mnemonic entropy and kind 2 is
//! a raw secp256k1 private key. The phrase text itself is never stored.
//!
//! Passwords are bytes. The UI must normalise text passwords to Unicode NFC
//! first, so the same password typed on another keyboard still opens it.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::{Error, Mnemonic, PrivateKey, random};

const MAGIC: &[u8; 4] = b"CWKS";
const VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const HEADER_LEN: usize = 58;
const TAG_LEN: usize = 16;

const KIND_MNEMONIC: u8 = 1;
const KIND_PRIVATE_KEY: u8 = 2;
/// A wallet's random vault key (see [`crate::envelope`]), never a secret of its own.
pub(crate) const KIND_VAULT_KEY: u8 = 3;

/// Shortest password the core accepts. The UI should ask for more.
pub const MIN_PASSWORD_LEN: usize = 8;

/// Argon2id cost parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory in KiB.
    pub m_cost_kib: u32,
    /// Passes over memory.
    pub t_cost: u32,
    /// Lanes. Keep at 1: WASM in the browser runs single threaded.
    pub p_cost: u32,
}

impl KdfParams {
    /// Default for new keystores: 64 MiB, 3 passes, 1 lane.
    pub const DEFAULT: Self = Self {
        m_cost_kib: 64 * 1024,
        t_cost: 3,
        p_cost: 1,
    };

    /// Weakest parameters accepted when sealing or opening (OWASP's Argon2id
    /// floor: 19 MiB, 2 passes). A keystore below this is refused.
    pub const MINIMUM: Self = Self {
        m_cost_kib: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
    };

    /// Upper bounds, so a crafted keystore can't make unlocking hang or
    /// exhaust memory.
    const MAX_M_COST_KIB: u32 = 1024 * 1024;
    const MAX_T_COST: u32 = 16;
    const MAX_P_COST: u32 = 4;

    fn check(&self) -> Result<(), Error> {
        let min = Self::MINIMUM;
        if self.m_cost_kib < min.m_cost_kib || self.t_cost < min.t_cost || self.p_cost < min.p_cost {
            return Err(Error::Keystore("key derivation parameters too weak"));
        }
        if self.m_cost_kib > Self::MAX_M_COST_KIB || self.t_cost > Self::MAX_T_COST || self.p_cost > Self::MAX_P_COST {
            return Err(Error::Keystore("key derivation parameters out of range"));
        }
        Ok(())
    }
}

/// What a keystore holds.
pub enum Secret {
    /// A recovery phrase (stored as its entropy).
    Mnemonic(Mnemonic),
    /// An imported private key.
    PrivateKey(PrivateKey),
}

impl core::fmt::Debug for Secret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Mnemonic(m) => write!(f, "Secret::{m:?}"),
            Self::PrivateKey(k) => write!(f, "Secret::{k:?}"),
        }
    }
}

fn derive_key(password: &[u8], salt: &[u8], params: KdfParams) -> Result<Zeroizing<[u8; 32]>, Error> {
    let argon_params = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|_| Error::Keystore("key derivation parameters out of range"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params)
        .hash_password_into(password, salt, &mut key[..])
        .map_err(|_| Error::Keystore("key derivation failed"))?;
    Ok(key)
}

/// Encrypt `secret` under `password`.
pub fn seal(secret: &Secret, password: &[u8], params: KdfParams) -> Result<Vec<u8>, Error> {
    seal_keyed(secret, password, params).map(|(blob, _)| blob)
}

/// [`seal`], also returning the [`UnlockKey`] it derived, so a host that seals (a new
/// password, say) needn't run the key derivation again to unlock.
pub fn seal_keyed(secret: &Secret, password: &[u8], params: KdfParams) -> Result<(Vec<u8>, UnlockKey), Error> {
    seal_bytes(&encode_secret(secret), password, params)
}

/// `kind || secret`, the plaintext a keystore (or an envelope's secret) holds.
pub(crate) fn encode_secret(secret: &Secret) -> Zeroizing<Vec<u8>> {
    let mut plaintext = Zeroizing::new(Vec::with_capacity(33));
    match secret {
        Secret::Mnemonic(m) => {
            plaintext.push(KIND_MNEMONIC);
            plaintext.extend_from_slice(&m.entropy());
        }
        Secret::PrivateKey(k) => {
            plaintext.push(KIND_PRIVATE_KEY);
            plaintext.extend_from_slice(&k.to_bytes()[..]);
        }
    }
    plaintext
}

/// The secret in a decrypted plaintext; anything else (a vault key, say) is refused.
pub(crate) fn decode_secret(plaintext: &[u8]) -> Result<Secret, Error> {
    match (plaintext.first(), plaintext.get(1..)) {
        (Some(&KIND_MNEMONIC), Some(entropy)) => Mnemonic::from_entropy(entropy).map(Secret::Mnemonic),
        (Some(&KIND_PRIVATE_KEY), Some(key)) if key.len() == 32 => PrivateKey::from_bytes(key).map(Secret::PrivateKey),
        _ => Err(Error::Keystore("unknown secret kind")),
    }
    .map_err(|_| Error::Keystore("damaged secret"))
}

/// Seal any plaintext under `password`, returning the key it derived.
pub(crate) fn seal_bytes(plaintext: &[u8], password: &[u8], params: KdfParams) -> Result<(Vec<u8>, UnlockKey), Error> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(Error::Keystore("password too short"));
    }
    params.check()?;

    let mut header = [0u8; HEADER_LEN];
    header[0..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    header[5] = KDF_ARGON2ID;
    header[6..10].copy_from_slice(&params.m_cost_kib.to_be_bytes());
    header[10..14].copy_from_slice(&params.t_cost.to_be_bytes());
    header[14..18].copy_from_slice(&params.p_cost.to_be_bytes());
    random::fill(&mut header[18..58])?;

    let key = derive_key(password, &header[18..34], params)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| Error::Keystore("cipher init"))?;
    let nonce = XNonce::try_from(&header[34..58]).map_err(|_| Error::Keystore("nonce"))?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|_| Error::Keystore("encryption failed"))?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ciphertext);
    Ok((out, UnlockKey(key)))
}

/// A key that opens sealed data without the password: the key a keystore is encrypted under
/// (derived from its password), or a vault's random vault key, which the vault's password
/// opens ([`crate::envelope`]). Holding it opens what it seals without running Argon2, so a
/// host keeps it while the wallet is unlocked (the extension in `chrome.storage.session`) and
/// drops it on lock. A vault key opens every wallet sealed in that vault, and a password
/// change keeps it.
pub struct UnlockKey(Zeroizing<[u8; 32]>);

impl UnlockKey {
    /// From the 32 bytes a host stored.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let mut key = Zeroizing::new([0u8; 32]);
        if bytes.len() != 32 {
            return Err(Error::Keystore("unlock key must be 32 bytes"));
        }
        key.copy_from_slice(bytes);
        Ok(Self(key))
    }

    /// The raw bytes, for the host to store while unlocked.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl core::fmt::Debug for UnlockKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("UnlockKey(<redacted>)")
    }
}

/// Decrypt a keystore. A wrong password and a damaged keystore give the same
/// error, [`Error::Decrypt`].
pub fn open(blob: &[u8], password: &[u8]) -> Result<Secret, Error> {
    let key = unlock(blob, password)?;
    open_with_key(blob, &key)
}

/// Check `password` against a keystore and return its [`UnlockKey`].
pub fn unlock(blob: &[u8], password: &[u8]) -> Result<UnlockKey, Error> {
    let (params, header, ciphertext) = parse(blob)?;
    let key = UnlockKey(derive_key(password, &header[18..34], params)?);
    decrypt(header, ciphertext, &key)?;
    Ok(key)
}

/// Decrypt a keystore with the key [`unlock`] returned.
pub fn open_with_key(blob: &[u8], key: &UnlockKey) -> Result<Secret, Error> {
    decode_secret(&open_bytes(blob, key)?)
}

/// A keystore's plaintext, whatever its kind.
pub(crate) fn open_bytes(blob: &[u8], key: &UnlockKey) -> Result<Zeroizing<Vec<u8>>, Error> {
    let (_, header, ciphertext) = parse(blob)?;
    decrypt(header, ciphertext, key)
}

fn parse(blob: &[u8]) -> Result<(KdfParams, &[u8], &[u8]), Error> {
    if blob.len() < HEADER_LEN + TAG_LEN + 1 || &blob[0..4] != MAGIC {
        return Err(Error::Keystore("not a Choice Wallet keystore"));
    }
    if blob[4] != VERSION {
        return Err(Error::Keystore("unsupported keystore version"));
    }
    if blob[5] != KDF_ARGON2ID {
        return Err(Error::Keystore("unsupported key derivation"));
    }
    let be = |r: core::ops::Range<usize>| u32::from_be_bytes(blob[r].try_into().expect("4 bytes"));
    let params = KdfParams {
        m_cost_kib: be(6..10),
        t_cost: be(10..14),
        p_cost: be(14..18),
    };
    params.check()?;
    let (header, ciphertext) = blob.split_at(HEADER_LEN);
    Ok((params, header, ciphertext))
}

fn decrypt(header: &[u8], ciphertext: &[u8], key: &UnlockKey) -> Result<Zeroizing<Vec<u8>>, Error> {
    let cipher = XChaCha20Poly1305::new_from_slice(&key.0[..]).map_err(|_| Error::Decrypt)?;
    let nonce = XNonce::try_from(&header[34..58]).map_err(|_| Error::Decrypt)?;
    Ok(Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad: header,
                },
            )
            .map_err(|_| Error::Decrypt)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const PASSWORD: &[u8] = b"correct horse battery staple";
    // Tests use the floor so they run quickly; production uses DEFAULT.
    const FAST: KdfParams = KdfParams::MINIMUM;

    fn sealed_mnemonic() -> Vec<u8> {
        seal(&Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap()), PASSWORD, FAST).unwrap()
    }

    #[test]
    fn mnemonic_round_trip() {
        let blob = sealed_mnemonic();
        let Secret::Mnemonic(m) = open(&blob, PASSWORD).unwrap() else {
            panic!("wrong kind")
        };
        assert_eq!(m.phrase().as_str(), ABANDON);
    }

    #[test]
    fn private_key_round_trip() {
        let key = PrivateKey::from_hex(&"46".repeat(32)).unwrap();
        let blob = seal(
            &Secret::PrivateKey(PrivateKey::from_hex(&"46".repeat(32)).unwrap()),
            PASSWORD,
            FAST,
        )
        .unwrap();
        let Secret::PrivateKey(back) = open(&blob, PASSWORD).unwrap() else {
            panic!("wrong kind")
        };
        assert_eq!(back.public_key(), key.public_key());
    }

    #[test]
    fn seal_keyed_returns_the_key_that_opens_it() {
        let (blob, key) = seal_keyed(&Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap()), PASSWORD, FAST).unwrap();
        assert_eq!(key.as_bytes(), unlock(&blob, PASSWORD).unwrap().as_bytes());
        assert!(matches!(open_with_key(&blob, &key).unwrap(), Secret::Mnemonic(_)));
    }

    #[test]
    fn wrong_password_fails() {
        assert_eq!(
            open(&sealed_mnemonic(), b"correct horse battery stapler").unwrap_err(),
            Error::Decrypt
        );
    }

    #[test]
    fn any_flipped_byte_fails() {
        let blob = sealed_mnemonic();
        // Flipping any byte of salt, nonce, ciphertext or tag must fail
        // decryption. (Header bytes before the salt are checked first and
        // give a format error instead, also a failure.)
        for i in 0..blob.len() {
            let mut bad = blob.clone();
            bad[i] ^= 0x01;
            assert!(open(&bad, PASSWORD).is_err(), "byte {i} flip was accepted");
        }
    }

    #[test]
    fn raising_params_in_header_fails() {
        // Even a "stronger" header is caught: the header is associated data.
        let mut bad = sealed_mnemonic();
        bad[13] += 1; // t_cost 2 -> 3
        assert_eq!(open(&bad, PASSWORD).unwrap_err(), Error::Decrypt);
    }

    #[test]
    fn weak_or_huge_params_refused() {
        let secret = Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap());
        let weak = KdfParams {
            m_cost_kib: 1024,
            ..FAST
        };
        assert!(seal(&secret, PASSWORD, weak).is_err());
        let mut blob = sealed_mnemonic();
        blob[6..10].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            open(&blob, PASSWORD).unwrap_err(),
            Error::Keystore("key derivation parameters out of range")
        );
    }

    #[test]
    fn short_password_refused() {
        let secret = Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap());
        assert!(seal(&secret, b"short", FAST).is_err());
    }

    #[test]
    fn fresh_salt_and_nonce_each_time() {
        assert_ne!(sealed_mnemonic()[18..58], sealed_mnemonic()[18..58]);
    }

    #[test]
    fn debug_is_redacted() {
        let s = format!("{:?}", Secret::Mnemonic(Mnemonic::parse(ABANDON).unwrap()));
        assert!(!s.contains("abandon"), "{s}");
    }

    #[test]
    fn unlock_key_opens_only_its_keystore() {
        let blob = sealed_mnemonic();
        let key = unlock(&blob, PASSWORD).unwrap();
        assert!(matches!(open_with_key(&blob, &key).unwrap(), Secret::Mnemonic(_)));
        // Stored and restored by a host.
        let restored = UnlockKey::from_bytes(key.as_bytes()).unwrap();
        assert!(open_with_key(&blob, &restored).is_ok());
        // Another keystore with the same password has its own salt, so its own key.
        assert_eq!(open_with_key(&sealed_mnemonic(), &key).unwrap_err(), Error::Decrypt);
        assert_eq!(unlock(&blob, b"wrong password").unwrap_err(), Error::Decrypt);
        assert!(UnlockKey::from_bytes(&[0; 31]).is_err());
        assert_eq!(format!("{key:?}"), "UnlockKey(<redacted>)");
    }
}
