//! The chains the vault knows, by CAIP-2 ID (`cosmos:injective-1`, `eip155:1776`).
//!
//! Adding a chain means adding an entry here (and, for a Cosmos chain, its profile). The
//! protocol stays the same: every request names its chain by CAIP-2 ID.

use choice_wallet_core::{EthAddress, PublicKey};
use choice_wallet_cosmos::chain::Chain as CosmosChain;
use choice_wallet_injective::chain::{MAINNET, Network, TESTNET};
use serde::Serialize;

use crate::error::{UNKNOWN_CHAIN, VaultError};

/// What kind of chain an entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A Cosmos SDK chain.
    Cosmos(&'static CosmosChain),
    /// An EVM chain, by EIP-155 chain ID.
    Evm(u64),
}

/// A chain the vault knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// CAIP-2 ID.
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Cosmos or EVM.
    pub kind: Kind,
    /// The Injective network it belongs to, if any. Injective's two sides share accounts.
    pub injective: Option<&'static Network>,
    /// Native coin symbol and decimals.
    pub native: (&'static str, u8),
}

/// Every chain, in display order.
pub const CHAINS: [Entry; 4] = [
    Entry {
        id: "cosmos:injective-1",
        name: "Injective",
        kind: Kind::Cosmos(&MAINNET.cosmos),
        injective: Some(&MAINNET),
        native: ("INJ", 18),
    },
    Entry {
        id: "eip155:1776",
        name: "Injective EVM",
        kind: Kind::Evm(MAINNET.evm_chain_id),
        injective: Some(&MAINNET),
        native: ("INJ", 18),
    },
    Entry {
        id: "cosmos:injective-888",
        name: "Injective Testnet",
        kind: Kind::Cosmos(&TESTNET.cosmos),
        injective: Some(&TESTNET),
        native: ("INJ", 18),
    },
    Entry {
        id: "eip155:1439",
        name: "Injective EVM Testnet",
        kind: Kind::Evm(TESTNET.evm_chain_id),
        injective: Some(&TESTNET),
        native: ("INJ", 18),
    },
];

/// Find a chain by CAIP-2 ID.
pub fn find(id: &str) -> Result<&'static Entry, VaultError> {
    CHAINS
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| VaultError::new(UNKNOWN_CHAIN, format!("unknown chain {id:?}")))
}

impl Entry {
    /// The Cosmos profile, or an error for an EVM chain.
    pub fn cosmos(&self) -> Result<&'static CosmosChain, VaultError> {
        match self.kind {
            Kind::Cosmos(c) => Ok(c),
            Kind::Evm(_) => Err(VaultError::bad(format!("{} is not a Cosmos chain", self.id))),
        }
    }

    /// The EIP-155 chain ID, or an error for a Cosmos chain.
    pub fn evm(&self) -> Result<u64, VaultError> {
        match self.kind {
            Kind::Evm(id) => Ok(id),
            Kind::Cosmos(_) => Err(VaultError::bad(format!("{} is not an EVM chain", self.id))),
        }
    }

    /// This account's address on the chain, in the form the chain writes it.
    pub fn address(&self, key: &PublicKey) -> String {
        match self.kind {
            Kind::Cosmos(c) => c.address(key),
            Kind::Evm(_) => key.eth_address().to_checksum_hex(),
        }
    }

    /// Read an address a user or dapp gave, and return it in the chain's own form. On
    /// Injective both `inj1…` and `0x…` name the same account, so either is accepted on
    /// both sides.
    pub fn parse_address(&self, s: &str) -> Result<String, VaultError> {
        let bad = || VaultError::bad(format!("invalid address {s:?} for {}", self.id));
        let s = s.trim();
        let injective_account = || {
            self.injective
                .and_then(|_| choice_wallet_core::address::parse_injective(s).ok())
        };
        match self.kind {
            Kind::Cosmos(c) => {
                if let Some(a) = injective_account() {
                    return Ok(c.address_of(&a));
                }
                c.check_address(s).map_err(|_| bad())?;
                Ok(s.to_owned())
            }
            Kind::Evm(_) => {
                let a = injective_account()
                    .or_else(|| EthAddress::parse_hex(s).ok())
                    .ok_or_else(bad)?;
                Ok(a.to_checksum_hex())
            }
        }
    }
}

/// A chain as the `chains` method lists it.
#[derive(Serialize)]
pub(crate) struct ChainInfo {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    /// The CAIP-2 ID of the other side of the same Injective network.
    pair: Option<&'static str>,
    symbol: &'static str,
    decimals: u8,
}

pub(crate) fn list() -> Vec<ChainInfo> {
    CHAINS
        .iter()
        .map(|c| ChainInfo {
            id: c.id,
            name: c.name,
            kind: match c.kind {
                Kind::Cosmos(_) => "cosmos",
                Kind::Evm(_) => "evm",
            },
            pair: CHAINS
                .iter()
                .find(|o| o.id != c.id && o.injective.is_some() && o.injective == c.injective)
                .map(|o| o.id),
            symbol: c.native.0,
            decimals: c.native.1,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_profiles() {
        for c in CHAINS {
            let id = match c.kind {
                Kind::Cosmos(p) => p.caip2(),
                Kind::Evm(n) => format!("eip155:{n}"),
            };
            assert_eq!(c.id, id);
            assert_eq!(find(c.id).unwrap(), &c);
        }
        assert_eq!(find("eip155:1").unwrap_err().code, UNKNOWN_CHAIN);
    }

    #[test]
    fn injective_accepts_both_address_forms_on_both_sides() {
        let a = EthAddress::from_bytes([0xab; 20]);
        let (inj, hex) = (a.to_inj(), a.to_checksum_hex());
        let cosmos = find("cosmos:injective-1").unwrap();
        let evm = find("eip155:1776").unwrap();
        for s in [&inj, &hex, &hex.to_lowercase()] {
            assert_eq!(cosmos.parse_address(s).unwrap(), inj);
            assert_eq!(evm.parse_address(s).unwrap(), hex);
        }
        assert!(cosmos.parse_address("cosmos1abc").is_err());
        assert!(evm.parse_address("0x1234").is_err());
    }
}
