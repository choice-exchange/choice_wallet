//! The chains the vault knows, by CAIP-2 ID (`cosmos:injective-1`, `eip155:8453`).
//!
//! Injective's Cosmos side, and every EVM chain on CCTP beside each Injective network
//! (`choice_wallet_injective::cctp::Cctp::evm`, Injective EVM among them): the same 0x key
//! signs on each, under the same EVM rules. Adding a chain means adding an entry there (and,
//! for a Cosmos chain, its profile). The protocol stays the same: every request names its
//! chain by CAIP-2 ID.
//!
//! Any other EVM chain is one the user added in the wallet: [`find`] gives it an entry with
//! no Injective or CCTP rules and its coin at 18 decimals. Its chain ID is all the vault
//! knows of it, and what it signs for; the name and symbol the wallet shows are the user's.

use std::sync::{LazyLock, Mutex, PoisonError};

use choice_wallet_core::{EthAddress, PublicKey};
use choice_wallet_cosmos::chain::Chain as CosmosChain;
use choice_wallet_injective::cctp::EvmChain;
use choice_wallet_injective::chain::{MAINNET, Network, TESTNET};
use choice_wallet_policy::EvmSide;
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
    /// The Injective network it belongs to, if it is one of Injective's two sides (they share
    /// accounts).
    pub injective: Option<&'static Network>,
    /// For an EVM chain on CCTP: the Injective network whose CCTP table names it, and the
    /// chain as that table names it.
    pub bridge: Option<(&'static Network, &'static EvmChain)>,
    /// Native coin symbol and decimals.
    pub native: (&'static str, u8),
    /// A chain the user added: known by its ID alone (no name or symbol here).
    pub added: bool,
}

/// Every chain, in display order: each network's Cosmos side, then its EVM chains.
pub static CHAINS: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    let mut out = Vec::new();
    for n in [&MAINNET, &TESTNET] {
        let testnet = std::ptr::eq(n, &TESTNET);
        out.push(Entry {
            id: if testnet {
                "cosmos:injective-888"
            } else {
                "cosmos:injective-1"
            },
            name: if testnet { "Injective Testnet" } else { "Injective" },
            kind: Kind::Cosmos(&n.cosmos),
            injective: Some(n),
            bridge: None,
            native: ("INJ", 18),
            added: false,
        });
        for c in n.cctp.evm {
            let own = c.chain_id == n.evm_chain_id;
            out.push(Entry {
                id: c.caip2,
                name: match (own, testnet) {
                    (true, false) => "Injective EVM",
                    (true, true) => "Injective EVM Testnet",
                    (false, _) => c.name,
                },
                kind: Kind::Evm(c.chain_id),
                injective: own.then_some(n),
                bridge: Some((n, c)),
                native: c.native,
                added: false,
            });
        }
    }
    out
});

/// A Solana cluster the vault signs on, with each account's ed25519 key (SLIP-0010, the path
/// Phantom uses). Not in [`CHAINS`]: its keys and requests are of their own kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolanaChain {
    /// CAIP-2 ID (`solana:` and the genesis hash's first 32 characters).
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// The Injective network it bridges with (its USDC, and Circle's tables).
    pub network: &'static Network,
}

/// Solana mainnet, and devnet beside Injective's testnet.
pub const SOLANA: [SolanaChain; 2] = [
    SolanaChain {
        id: MAINNET.cctp.solana.caip2,
        name: MAINNET.cctp.solana.name,
        network: &MAINNET,
    },
    SolanaChain {
        id: TESTNET.cctp.solana.caip2,
        name: TESTNET.cctp.solana.name,
        network: &TESTNET,
    },
];

/// A Solana cluster by CAIP-2 ID.
pub fn solana(id: &str) -> Option<&'static SolanaChain> {
    SOLANA.iter().find(|c| c.id == id)
}

/// The highest chain ID an added chain may have (MetaMask's: an EIP-155 `v` fits 53 bits).
pub const MAX_ADDED_CHAIN_ID: u64 = 4_503_599_627_370_476;
/// Added chains one vault keeps entries for (the wallet adds at most 32).
const MAX_ADDED: usize = 64;

/// Entries for added chains, each made once and kept as long as the vault, like the built-in
/// ones.
static ADDED: Mutex<Vec<&'static Entry>> = Mutex::new(Vec::new());

/// Find a chain by CAIP-2 ID: a built-in one, or any other EVM chain (`eip155:` and its ID in
/// plain decimal) as one the user added.
pub fn find(id: &str) -> Result<&'static Entry, VaultError> {
    if let Some(c) = CHAINS.iter().find(|c| c.id == id) {
        return Ok(c);
    }
    let unknown = || VaultError::new(UNKNOWN_CHAIN, format!("unknown chain {id:?}"));
    let n = id
        .strip_prefix("eip155:")
        .filter(|d| !d.starts_with('0') && (1..=16).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|d| d.parse::<u64>().ok())
        .filter(|n| (1..=MAX_ADDED_CHAIN_ID).contains(n))
        .ok_or_else(unknown)?;
    let mut added = ADDED.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(e) = added.iter().find(|e| e.kind == Kind::Evm(n)) {
        return Ok(e);
    }
    if added.len() >= MAX_ADDED {
        return Err(VaultError::bad("too many added chains"));
    }
    let e: &'static Entry = Box::leak(Box::new(Entry {
        id: Box::leak(id.to_owned().into_boxed_str()),
        name: "",
        kind: Kind::Evm(n),
        injective: None,
        bridge: None,
        native: ("", 18),
        added: true,
    }));
    added.push(e);
    Ok(e)
}

impl Entry {
    /// The chain as the EVM rules see it.
    pub fn evm_side(&self) -> EvmSide<'static> {
        EvmSide {
            injective: self.injective,
            cctp: self.bridge.map(|(n, c)| (&n.cctp, c)),
        }
    }

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
        for c in CHAINS.iter() {
            let id = match c.kind {
                Kind::Cosmos(p) => p.caip2(),
                Kind::Evm(n) => format!("eip155:{n}"),
            };
            assert_eq!(c.id, id);
            assert_eq!(find(c.id).unwrap(), c);
        }
        // Any other EVM chain is one the user added; other forms are no chain.
        let bnb = find("eip155:56").unwrap();
        assert!(bnb.added && bnb.bridge.is_none() && bnb.injective.is_none());
        assert_eq!((bnb.evm().unwrap(), bnb.native.1), (56, 18));
        assert!(std::ptr::eq(bnb, find("eip155:56").unwrap()));
        assert!(CHAINS.iter().all(|c| !c.added));
        for id in [
            "eip155:08453",
            "eip155:8453 ",
            "cosmos:8453",
            "eip155:",
            "cosmos:injective-2",
        ] {
            assert!(find(id).is_err(), "{id}");
        }
    }

    #[test]
    fn every_chain_on_cctp_is_an_evm_chain() {
        for n in [MAINNET, TESTNET] {
            for c in n.cctp.evm {
                let e = find(c.caip2).unwrap();
                assert_eq!(e.evm().unwrap(), c.chain_id);
                assert_eq!(e.bridge.unwrap().1, c);
                assert_eq!(e.native, c.native);
                // Only Injective's own EVM side gets Injective's rules (Choice, precompiles).
                assert_eq!(e.injective.is_some(), c.chain_id == n.evm_chain_id);
            }
        }
        let base = find("eip155:8453").unwrap();
        assert_eq!((base.name, base.native.0), ("Base", "ETH"));
        assert_eq!(find("eip155:1776").unwrap().name, "Injective EVM");
        assert_eq!(find("eip155:84532").unwrap().bridge.unwrap().0, &TESTNET);
    }

    #[test]
    fn solana_clusters() {
        assert_eq!(
            solana("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").unwrap().network,
            &MAINNET
        );
        assert_eq!(
            solana("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1").unwrap().name,
            "Solana Devnet"
        );
        assert!(solana("solana:mainnet").is_none());
        for c in SOLANA {
            assert!(find(c.id).is_err());
        }
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
