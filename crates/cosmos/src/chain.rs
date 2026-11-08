//! What the Cosmos code needs to know about a chain.

use choice_wallet_core::address::decode_bech32;
use choice_wallet_core::{EthAddress, PrivateKey, PublicKey};

use crate::Error;

/// How a chain's accounts sign and derive their addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum KeyKind {
    /// Ethermint-style `ethsecp256k1` (Injective and other EVM-compatible Cosmos chains):
    /// ECDSA over keccak256 of the sign bytes, and the account address is the key's EVM
    /// address.
    EthSecp256k1 {
        /// The chain's type URL for the public key, e.g.
        /// `/injective.crypto.v1beta1.ethsecp256k1.PubKey`. Every ethsecp256k1 `PubKey` has
        /// the same wire format as cosmos-sdk's `secp256k1.PubKey` (`bytes key = 1`, the
        /// compressed key).
        pub_key_type_url: &'static str,
    },
}

/// A Cosmos SDK chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    /// Chain ID, signed into every sign doc.
    pub chain_id: &'static str,
    /// Bech32 prefix of account addresses, e.g. `inj`.
    pub bech32_prefix: &'static str,
    /// How accounts sign.
    pub key: KeyKind,
    /// Protobuf package of the chain's tokenfactory module, e.g.
    /// `injective.tokenfactory.v1beta1`, if it has one.
    pub tokenfactory: Option<&'static str>,
}

impl Chain {
    /// The CAIP-2 chain ID, e.g. `cosmos:injective-1`.
    pub fn caip2(&self) -> String {
        format!("cosmos:{}", self.chain_id)
    }

    /// The account address of `key` on this chain.
    pub fn address(&self, key: &PublicKey) -> String {
        match self.key {
            KeyKind::EthSecp256k1 { .. } => self.address_of(&key.eth_address()),
        }
    }

    /// A 20-byte account in this chain's bech32 form.
    pub fn address_of(&self, account: &EthAddress) -> String {
        account
            .to_bech32(self.bech32_prefix)
            .expect("chain profiles carry a valid prefix")
    }

    /// Check that `s` is an address on this chain as the chain writes it: bech32 with this
    /// prefix, lowercase, 20 or 32 bytes.
    pub fn check_address(&self, s: &str) -> Result<(), Error> {
        let ok = s.bytes().all(|b| !b.is_ascii_uppercase())
            && decode_bech32(s, self.bech32_prefix).is_ok_and(|b| b.len() == 20 || b.len() == 32);
        if ok { Ok(()) } else { Err(Error::Address(s.into())) }
    }

    pub(crate) fn pub_key_type_url(&self) -> &'static str {
        match self.key {
            KeyKind::EthSecp256k1 { pub_key_type_url } => pub_key_type_url,
        }
    }

    pub(crate) fn sign(&self, key: &PrivateKey, bytes: &[u8]) -> [u8; 64] {
        match self.key {
            KeyKind::EthSecp256k1 { .. } => key.sign_keccak256(bytes),
        }
    }

    pub(crate) fn verify(&self, key: &PublicKey, bytes: &[u8], signature: &[u8; 64]) -> bool {
        match self.key {
            KeyKind::EthSecp256k1 { .. } => key.verify_keccak256(bytes, signature),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST: Chain = Chain {
        chain_id: "test-1",
        bech32_prefix: "inj",
        key: KeyKind::EthSecp256k1 {
            pub_key_type_url: "/test.PubKey",
        },
        tokenfactory: None,
    };

    #[test]
    fn addresses_must_be_canonical_and_on_this_chain() {
        let a = TEST.address_of(&EthAddress::from_bytes([7; 20]));
        assert!(TEST.check_address(&a).is_ok());
        for bad in [a.to_uppercase(), a.replace("inj", "osmo"), String::new(), "inj1".into()] {
            assert_eq!(TEST.check_address(&bad), Err(Error::Address(bad.clone())), "{bad}");
        }
        assert_eq!(TEST.caip2(), "cosmos:test-1");
    }
}
