//! 20-byte account addresses in EVM (EIP-55 hex) and bech32 form.
//!
//! On Injective one key has one 20-byte address, written two ways:
//! `0x…` (EIP-55) and `inj1…` (bech32). Both parse to the same [`EthAddress`].

use core::fmt;

use bech32::primitives::decode::CheckedHrpstring;
use bech32::{Bech32, Hrp};

use crate::secp256k1::keccak256;
use crate::{Error, hexutil};

/// Bech32 prefix for Injective accounts.
pub const INJ_HRP: &str = "inj";

/// A 20-byte account address.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EthAddress([u8; 20]);

impl EthAddress {
    /// From raw bytes.
    pub const fn from_bytes(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    /// The raw bytes.
    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub(crate) fn from_pubkey_hash(hash: &[u8; 32]) -> Self {
        let mut out = [0u8; 20];
        out.copy_from_slice(&hash[12..]);
        Self(out)
    }

    /// EIP-55 mixed-case checksum hex, with `0x`.
    pub fn to_checksum_hex(&self) -> String {
        let lower = hexutil::encode(&self.0);
        let hash = keccak256(lower.as_bytes());
        let mut out = String::with_capacity(42);
        out.push_str("0x");
        for (i, c) in lower.chars().enumerate() {
            let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
            out.push(if c.is_ascii_alphabetic() && nibble >= 8 {
                c.to_ascii_uppercase()
            } else {
                c
            });
        }
        out
    }

    /// Parse `0x` + 40 hex characters. All-lowercase and all-uppercase are
    /// accepted; mixed case must carry a valid EIP-55 checksum, which catches
    /// most typos.
    pub fn parse_hex(s: &str) -> Result<Self, Error> {
        let body = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .ok_or(Error::InvalidAddress)?;
        let mut bytes = [0u8; 20];
        hexutil::decode_into(body, &mut bytes).map_err(|_| Error::InvalidAddress)?;
        let addr = Self(bytes);
        let has_lower = body.bytes().any(|c| c.is_ascii_lowercase());
        let has_upper = body.bytes().any(|c| c.is_ascii_uppercase());
        if has_lower && has_upper && addr.to_checksum_hex()[2..] != *body {
            return Err(Error::InvalidAddress);
        }
        Ok(addr)
    }

    /// Bech32 form with the given prefix, e.g. `inj1…`.
    pub fn to_bech32(&self, hrp: &str) -> Result<String, Error> {
        let hrp = Hrp::parse(hrp).map_err(|_| Error::InvalidAddress)?;
        bech32::encode::<Bech32>(hrp, &self.0).map_err(|_| Error::InvalidAddress)
    }

    /// Parse a bech32 address and require the given prefix. Only classic
    /// bech32 checksums are accepted (not bech32m), as Cosmos chains use.
    pub fn parse_bech32(s: &str, expected_hrp: &str) -> Result<Self, Error> {
        let checked = CheckedHrpstring::new::<Bech32>(s).map_err(|_| Error::InvalidAddress)?;
        if checked.hrp().to_lowercase() != expected_hrp {
            return Err(Error::InvalidAddress);
        }
        let mut bytes = [0u8; 20];
        let mut n = 0;
        for b in checked.byte_iter() {
            if n == 20 {
                return Err(Error::InvalidAddress);
            }
            bytes[n] = b;
            n += 1;
        }
        if n != 20 {
            return Err(Error::InvalidAddress);
        }
        Ok(Self(bytes))
    }

    /// The `inj1…` form.
    pub fn to_inj(&self) -> String {
        self.to_bech32(INJ_HRP)
            .expect("inj is a valid prefix and 20 bytes always encode")
    }
}

/// Parse an Injective address the user pasted, in either `0x…` or `inj1…`
/// form.
pub fn parse_injective(s: &str) -> Result<EthAddress, Error> {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        EthAddress::parse_hex(s)
    } else {
        EthAddress::parse_bech32(s, INJ_HRP)
    }
}

impl fmt::Display for EthAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_checksum_hex())
    }
}

impl fmt::Debug for EthAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EthAddress({})", self.to_checksum_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eip55_spec_vectors() {
        // From the EIP-55 specification.
        for s in [
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
        ] {
            let a = EthAddress::parse_hex(s).unwrap();
            assert_eq!(a.to_checksum_hex(), s);
            assert_eq!(EthAddress::parse_hex(&s.to_lowercase()).unwrap(), a);
            assert_eq!(
                EthAddress::parse_hex(&format!("0x{}", s[2..].to_uppercase())).unwrap(),
                a
            );
        }
    }

    #[test]
    fn bad_checksum_is_refused() {
        // One letter's case flipped.
        assert_eq!(
            EthAddress::parse_hex("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD").unwrap_err(),
            Error::InvalidAddress
        );
        assert!(EthAddress::parse_hex("5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").is_err());
        assert!(EthAddress::parse_hex("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA").is_err());
    }

    #[test]
    fn bech32_round_trip_and_prefix_check() {
        let a = EthAddress::parse_hex("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").unwrap();
        let inj = a.to_inj();
        assert!(inj.starts_with("inj1"));
        assert_eq!(parse_injective(&inj).unwrap(), a);
        assert_eq!(parse_injective(&inj.to_uppercase()).unwrap(), a);
        let cosmos = a.to_bech32("cosmos").unwrap();
        assert_eq!(parse_injective(&cosmos).unwrap_err(), Error::InvalidAddress);
        // A one-character typo fails the checksum.
        let mut typo = inj.clone().into_bytes();
        let last = typo.len() - 1;
        typo[last] = if typo[last] == b'q' { b'p' } else { b'q' };
        assert!(parse_injective(core::str::from_utf8(&typo).unwrap()).is_err());
    }
}
