//! ed25519 keys, as Solana uses them: derived from a recovery phrase by SLIP-0010, an address
//! that is the public key itself (base58), and signatures over a transaction's message bytes.
//!
//! SLIP-0010 for ed25519 derives hardened children only: `I = HMAC-SHA512(key, data)`, the
//! left half the child key and the right half its chain code. The master is
//! `HMAC-SHA512("ed25519 seed", seed)`; a child is `HMAC-SHA512(chain, 0x00 ‖ key ‖ index)`
//! with the index's high bit set.

use std::fmt;

use ed25519_dalek::ed25519::signature::Signer;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha512;
use zeroize::Zeroizing;

use crate::{Error, Mnemonic, base58};

/// An ed25519 private key. Wiped on drop; `Debug` never prints it.
pub struct Ed25519Key(SigningKey);

impl Ed25519Key {
    /// The key whose 32-byte secret (RFC 8032's seed) is `secret`.
    pub fn from_secret(secret: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(secret))
    }

    /// The public key: on Solana, the account address itself.
    pub fn public_key(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }

    /// The public key in base58, as Solana writes addresses.
    pub fn address(&self) -> String {
        base58::encode(&self.public_key())
    }

    /// Sign `message` (RFC 8032: deterministic, so it matches every other implementation).
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.0.sign(message).to_bytes()
    }

    /// The 32-byte secret, for an export the user asked for.
    pub fn export(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.0.to_bytes())
    }
}

impl fmt::Debug for Ed25519Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Ed25519Key({})", self.address())
    }
}

/// Whether `signature` is `public_key`'s over `message`. Strict (RFC 8032 with canonical
/// encodings and no small-order keys), as a hardware wallet's signature must be.
pub fn verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    VerifyingKey::from_bytes(public_key)
        .is_ok_and(|k| k.verify_strict(message, &Signature::from_bytes(signature)).is_ok())
}

/// Whether 32 bytes are a point on the curve: a key some keypair holds. Solana's
/// program-derived addresses are exactly the hashes that aren't.
pub fn on_curve(bytes: &[u8; 32]) -> bool {
    curve25519_dalek::edwards::CompressedEdwardsY(*bytes).decompress().is_some()
}

type HmacSha512 = Hmac<Sha512>;

fn hmac_halves(key: &[u8], data: &[&[u8]]) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>) {
    let mut mac = <HmacSha512 as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    for d in data {
        mac.update(d);
    }
    let out = Zeroizing::new(<[u8; 64]>::from(mac.finalize().into_bytes()));
    let (mut k, mut c) = (Zeroizing::new([0u8; 32]), Zeroizing::new([0u8; 32]));
    k.copy_from_slice(&out[..32]);
    c.copy_from_slice(&out[32..]);
    (k, c)
}

/// Read `m/a'/b'/…`: every index hardened (the only kind SLIP-0010 has for ed25519) and
/// below 2^31.
fn hardened_path(path: &str) -> Result<Vec<u32>, Error> {
    let rest = path.strip_prefix('m').ok_or(Error::InvalidPath)?;
    if rest.is_empty() {
        return Ok(Vec::new());
    }
    let rest = rest.strip_prefix('/').ok_or(Error::InvalidPath)?;
    rest.split('/')
        .map(|part| {
            let n = part.strip_suffix('\'').ok_or(Error::InvalidPath)?;
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || (n.len() > 1 && n.starts_with('0')) {
                return Err(Error::InvalidPath);
            }
            n.parse::<u32>().ok().filter(|&i| i < 1 << 31).ok_or(Error::InvalidPath)
        })
        .collect()
}

/// SLIP-0010: the ed25519 key at `path` (every index hardened) from a BIP-39 seed.
pub fn derive_from_seed(seed: &[u8], path: &str) -> Result<Ed25519Key, Error> {
    let indices = hardened_path(path)?;
    let (mut key, mut chain) = hmac_halves(b"ed25519 seed", &[seed]);
    for i in indices {
        (key, chain) = hmac_halves(&chain[..], &[&[0], &key[..], &(i | 1 << 31).to_be_bytes()]);
    }
    Ok(Ed25519Key::from_secret(&key))
}

/// SLIP-0010: the ed25519 key at `path` from a recovery phrase.
pub fn derive(mnemonic: &Mnemonic, path: &str) -> Result<Ed25519Key, Error> {
    derive_from_seed(&mnemonic.to_seed()[..], path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn slip10_test_vector_1() {
        // SLIP-0010, test vector 1 for ed25519 (seed 000102…0f).
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        for (path, secret, public) in [
            (
                "m",
                "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
                "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
            ),
            (
                "m/0'",
                "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
                "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c",
            ),
            (
                "m/0'/1'",
                "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
                "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187",
            ),
            (
                "m/0'/1'/2'",
                "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
                "ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1",
            ),
        ] {
            let k = derive_from_seed(&seed, path).unwrap();
            assert_eq!(hex::encode(*k.export()), secret, "{path}");
            assert_eq!(hex::encode(k.public_key()), public, "{path}");
        }
    }

    #[test]
    fn phantom_and_ledger_live_addresses() {
        // The "abandon … about" phrase in Phantom (m/44'/501'/i'/0') and Ledger Live
        // (m/44'/501'/i'), checked against an independent implementation (noble).
        let m = Mnemonic::parse(ABANDON).unwrap();
        for (path, address) in [
            ("m/44'/501'/0'/0'", "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
            ("m/44'/501'/1'/0'", "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb"),
            ("m/44'/501'/0'", "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL"),
            ("m/44'/501'/1'", "ANf3TEKFL6jPWjzkndo4CbnNdUNkBk4KHPggJs2nu8Xi"),
        ] {
            assert_eq!(derive(&m, path).unwrap().address(), address, "{path}");
        }
    }

    #[test]
    fn signs_deterministically_and_verifies_strictly() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let k = derive(&m, "m/44'/501'/0'/0'").unwrap();
        let sig = k.sign(b"choice");
        assert_eq!(
            hex::encode(sig),
            "cd71e31ee5bab44d3c28a403340baef4503ad80bc80a54727c8f3e6aa58820768d39ce9b647f8f87f12018e74ed7a2e036bc0c16173359f961a63ac091221203"
        );
        assert!(verify(&k.public_key(), b"choice", &sig));
        assert!(!verify(&k.public_key(), b"choicE", &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!verify(&k.public_key(), b"choice", &bad));
        assert!(!format!("{k:?}").contains(&hex::encode(*k.export())));
    }

    #[test]
    fn paths_must_be_hardened_and_canonical() {
        let seed = [7u8; 64];
        for bad in ["", "m/", "m/44", "m/44'/501", "44'/501'", "m/44'/x'", "m/2147483648'", "m/01'", "m//0'"] {
            assert_eq!(derive_from_seed(&seed, bad).unwrap_err(), Error::InvalidPath, "{bad:?}");
        }
        assert!(derive_from_seed(&seed, "m/2147483647'").is_ok());
    }

    #[test]
    fn keys_are_on_the_curve() {
        // Program-derived addresses (off the curve) are tested with the PDAs that use them.
        let m = Mnemonic::parse(ABANDON).unwrap();
        assert!(on_curve(&derive(&m, "m/44'/501'/0'/0'").unwrap().public_key()));
    }
}
