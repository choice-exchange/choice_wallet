//! secp256k1 keys as Injective (ethsecp256k1) and EVM use them.

use core::fmt;

use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::ecdsa::{Signature, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::{Error, EthAddress, hexutil};

/// keccak256, as used for EVM addresses, EVM txs and Injective signatures.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// A secp256k1 private key. Wiped on drop; `Debug` prints `<redacted>`.
pub struct PrivateKey(SigningKey);

impl PrivateKey {
    /// From 32 raw bytes. Rejects zero and values at or above the curve order.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        SigningKey::from_slice(bytes)
            .map(Self)
            .map_err(|_| Error::InvalidPrivateKey)
    }

    /// From 64 hex characters, with or without a `0x` prefix (the format
    /// MetaMask and Keplr export).
    pub fn from_hex(s: &str) -> Result<Self, Error> {
        let s = s.trim();
        let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
        let mut bytes = Zeroizing::new([0u8; 32]);
        hexutil::decode_into(s, &mut bytes[..]).map_err(|_| Error::InvalidPrivateKey)?;
        Self::from_bytes(&bytes[..])
    }

    pub(crate) fn from_signing_key(key: SigningKey) -> Self {
        Self(key)
    }

    /// Raw bytes, for the keystore only.
    pub(crate) fn to_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.0.to_bytes().into())
    }

    /// The key as 64 hex characters, the form other wallets import. Only for showing the
    /// user, when they ask to export it after entering their password.
    pub fn export_hex(&self) -> Zeroizing<String> {
        Zeroizing::new(hexutil::encode(&self.to_bytes()[..]))
    }

    /// The matching public key.
    pub fn public_key(&self) -> PublicKey {
        PublicKey(*self.0.verifying_key())
    }

    /// Injective / Ethermint `ethsecp256k1` signature over a Cosmos sign doc:
    /// ECDSA over keccak256(`msg`), returned as 64 bytes `r || s` with low S.
    /// Deterministic (RFC 6979), so it matches other implementations byte
    /// for byte.
    pub fn sign_keccak256(&self, msg: &[u8]) -> [u8; 64] {
        self.sign_prehash(&keccak256(msg)).0
    }

    /// Sign a 32-byte hash. Returns `r || s` (low S) and the recovery id
    /// (0 or 1), as EVM transactions and EIP-712 signatures need.
    pub fn sign_prehash(&self, hash: &[u8; 32]) -> ([u8; 64], u8) {
        let (sig, recid) = self.0.sign_prehash_recoverable(hash);
        (sig.to_bytes().into(), recid.to_byte())
    }
}

impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivateKey(<redacted>)")
    }
}

/// A secp256k1 public key.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct PublicKey(VerifyingKey);

impl PublicKey {
    /// From SEC1 bytes, compressed (33) or uncompressed (65).
    pub fn from_sec1_bytes(bytes: &[u8]) -> Result<Self, Error> {
        VerifyingKey::from_sec1_bytes(bytes)
            .map(Self)
            .map_err(|_| Error::InvalidPublicKey)
    }

    /// 33-byte compressed form, as Injective puts in a tx's signer info.
    pub fn compressed(&self) -> [u8; 33] {
        let point = self.0.to_sec1_point(true);
        let mut out = [0u8; 33];
        out.copy_from_slice(point.as_bytes());
        out
    }

    /// 65-byte uncompressed form (`0x04 || x || y`).
    pub fn uncompressed(&self) -> [u8; 65] {
        let point = self.0.to_sec1_point(false);
        let mut out = [0u8; 65];
        out.copy_from_slice(point.as_bytes());
        out
    }

    /// The EVM address: the last 20 bytes of keccak256(x || y). On Injective
    /// the inj1 address is these same 20 bytes in bech32.
    pub fn eth_address(&self) -> EthAddress {
        EthAddress::from_pubkey_hash(&keccak256(&self.uncompressed()[1..]))
    }

    /// Check an `ethsecp256k1` signature made by [`PrivateKey::sign_keccak256`].
    /// High-S signatures are refused, as Cosmos chains refuse them.
    pub fn verify_keccak256(&self, msg: &[u8], sig: &[u8; 64]) -> bool {
        let Ok(sig) = Signature::from_slice(sig) else {
            return false;
        };
        if sig.normalize_s() != sig {
            return false;
        }
        self.0.verify_prehash(&keccak256(msg), &sig).is_ok()
    }
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicKey({})", hexutil::encode(&self.compressed()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway test key. Never fund it.
    const TEST_KEY: &str = "4646464646464646464646464646464646464646464646464646464646464646";

    #[test]
    fn eip155_spec_key_address() {
        // EIP-155's worked example key 0x4646…46 has address 0x9d8A62f6…855A4F.
        let key = PrivateKey::from_hex(TEST_KEY).unwrap();
        assert_eq!(
            key.public_key().eth_address().to_checksum_hex(),
            "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F"
        );
    }

    #[test]
    fn from_hex_accepts_prefix_and_rejects_junk() {
        let a = PrivateKey::from_hex(TEST_KEY).unwrap();
        let b = PrivateKey::from_hex(&format!("0x{TEST_KEY}")).unwrap();
        assert_eq!(a.public_key(), b.public_key());
        for bad in [
            "",
            "00",
            &"00".repeat(32),
            &"ff".repeat(32),
            &format!("{TEST_KEY}00"),
            &"zz".repeat(32),
        ] {
            assert_eq!(
                PrivateKey::from_hex(bad).unwrap_err(),
                Error::InvalidPrivateKey,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn signatures_are_low_s_deterministic_and_verify() {
        let key = PrivateKey::from_hex(TEST_KEY).unwrap();
        let pk = key.public_key();
        for i in 0u8..32 {
            let msg = [i; 40];
            let sig = key.sign_keccak256(&msg);
            assert_eq!(sig, key.sign_keccak256(&msg), "RFC 6979 must be deterministic");
            let parsed = Signature::from_slice(&sig).unwrap();
            assert_eq!(parsed.normalize_s(), parsed, "high S");
            assert!(pk.verify_keccak256(&msg, &sig));
            assert!(!pk.verify_keccak256(&[i ^ 1; 40], &sig));
        }
    }

    #[test]
    fn verify_refuses_high_s() {
        let key = PrivateKey::from_hex(TEST_KEY).unwrap();
        let sig = Signature::from_slice(&key.sign_keccak256(b"msg")).unwrap();
        // Flip to the high-S twin: (r, n - s). Valid ECDSA, refused by Cosmos.
        let (r, s) = sig.split_scalars();
        let high = Signature::from_scalars(r.to_bytes(), (-*s).to_bytes()).unwrap();
        let high: [u8; 64] = high.to_bytes().into();
        assert!(!key.public_key().verify_keccak256(b"msg", &high));
    }

    #[test]
    fn compressed_and_uncompressed_round_trip() {
        let pk = PrivateKey::from_hex(TEST_KEY).unwrap().public_key();
        assert_eq!(PublicKey::from_sec1_bytes(&pk.compressed()).unwrap(), pk);
        assert_eq!(PublicKey::from_sec1_bytes(&pk.uncompressed()).unwrap(), pk);
        assert_eq!(
            PublicKey::from_sec1_bytes(&[0u8; 33]).unwrap_err(),
            Error::InvalidPublicKey
        );
        assert_eq!(
            PublicKey::from_sec1_bytes(&pk.compressed()[..32]).unwrap_err(),
            Error::InvalidPublicKey
        );
    }

    #[test]
    fn debug_is_redacted() {
        let key = PrivateKey::from_hex(TEST_KEY).unwrap();
        assert_eq!(format!("{key:?}"), "PrivateKey(<redacted>)");
    }

    #[test]
    fn keccak_empty_vector() {
        assert_eq!(
            hexutil::encode(&keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }
}
