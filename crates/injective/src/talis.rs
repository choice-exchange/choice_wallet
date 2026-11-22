//! Talis, Injective's NFT marketplace, on the EVM side: its contracts pinned per network, so
//! the review can name them.
//!
//! A Talis listing is a Seaport 1.6 order (OpenSea's protocol, at its canonical address), made
//! FULL_RESTRICTED to the Talis zone, which checks the protocol fee and the creator's royalty
//! when it is filled. NFTs are approved to Seaport itself, with no conduit. Auctions escrow
//! the NFT and the bids in Talis's auction contract; drops mint through its drop minter, with
//! the operator's signed permit; the restore contract re-mints NFTs from the CosmWasm era.
//!
//! Read off chain 2026-11-23. Mainnet's contracts were deployed 2026-11-06 (the restore
//! contract again 2026-11-16). Each one's code matches the verified testnet contract of the
//! same name, function for function, and the Talis721 template and the restore contract byte
//! for byte. They point at each other: the zone's `registry()` and `seaport()`, the drop
//! minter's `collectionFactory()`, the factory's `implementation721()`. One account owns them
//! all. Live listings name the zone, and the restore contract re-mints Talis NFTs to holders.

use choice_wallet_core::EthAddress;

/// Seaport 1.6 at its canonical address (deployed through the keyless CREATE2 factory, so the
/// same code at this address on every chain). It has no owner and no upgrade: it moves an NFT
/// approved to it only for an order the NFT's owner signed or sent.
pub const SEAPORT: &str = "0x0000000000000068F116a894984e2DB1123eB395";

/// Talis's contracts on one network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Talis {
    /// The Seaport zone every Talis listing names.
    pub zone: &'static str,
    /// Each contract, by the name the review gives it.
    pub contracts: &'static [(&'static str, &'static str)],
}

/// Talis on Injective mainnet (chain 1776).
pub const MAINNET: Talis = Talis {
    zone: "0x4669c6ebB602a1f7E8F0E7a0862ad45d813e9029",
    contracts: &[
        ("the Talis listing zone", "0x4669c6ebB602a1f7E8F0E7a0862ad45d813e9029"),
        ("the Talis auction", "0xa4174A3aA35a04Fc6fA53817E74416B61CcC2C5F"),
        ("the Talis drop minter", "0xcF29d983D2b96dfAcC1be8546D8F60bB74d6BC4F"),
        (
            "the Talis collection factory",
            "0xf7025e41677037D82f090Bd944704B8fE3f08B2f",
        ),
        (
            "the Talis editions factory",
            "0xD0602659535d430105Dc82f92336066EFab38D18",
        ),
        (
            "the Talis royalty registry",
            "0x73e57544c006c665C4B86A226891AbbD9ee978d4",
        ),
        (
            "the Talis restore contract",
            "0x0E728ab3CdeB98C6a9cAb810E93De465D8f43cC0",
        ),
        (
            "the Talis restore contract",
            "0xb909F629793916ad377507EA1386B1053d43071f",
        ),
    ],
};

/// Talis on Injective testnet (chain 1439), where its contracts are verified.
pub const TESTNET: Talis = Talis {
    zone: "0xA2939D38f463304BbffB479d08C8d263C81e02E8",
    contracts: &[
        ("the Talis listing zone", "0xA2939D38f463304BbffB479d08C8d263C81e02E8"),
        ("the Talis auction", "0xE081a2a5521e7eC96A0DB8f94a1910eA4f127595"),
        ("the Talis drop minter", "0x286B5baA1663cDa19ebe80E25aE06B3ACE1E5eA3"),
        (
            "the Talis collection factory",
            "0x51d9fee048FD0d52c98c9A273a8690E0D3C99606",
        ),
        (
            "the Talis editions factory",
            "0x49fe97e6Ce491C59270c8b77508DcB761F248AbF",
        ),
        (
            "the Talis royalty registry",
            "0x1F263E28399cA8DFF8aEFA86050349D3554a3AcB",
        ),
        (
            "the Talis restore contract",
            "0x06D54D49b1812Cd39Ef0Ff24E8d0EBF15e5B0F25",
        ),
        (
            "the Talis restore contract",
            "0x640d2D843d7a5AC16AA1834c94b2b9c4B534c66F",
        ),
    ],
};

fn pinned(s: &str) -> EthAddress {
    EthAddress::parse_hex(s).expect("pinned addresses are valid")
}

/// Seaport 1.6.
pub fn seaport() -> EthAddress {
    pinned(SEAPORT)
}

impl Talis {
    /// The name of the Talis contract at `a`, if it is one.
    pub fn name(&self, a: &EthAddress) -> Option<&'static str> {
        self.contracts.iter().find(|(_, x)| pinned(x) == *a).map(|(n, _)| *n)
    }

    /// The zone Talis listings name.
    pub fn zone(&self) -> EthAddress {
        pinned(self.zone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_addresses_parse_and_name_their_contracts() {
        for t in [MAINNET, TESTNET] {
            assert_eq!(t.name(&t.zone()), Some("the Talis listing zone"));
            for (n, a) in t.contracts {
                assert_eq!(t.name(&pinned(a)), Some(*n));
            }
        }
        assert_eq!(MAINNET.name(&seaport()), None, "Seaport is everyone's, not Talis's");
        assert_eq!(MAINNET.name(&TESTNET.zone()), None, "each network names only its own");
    }
}
