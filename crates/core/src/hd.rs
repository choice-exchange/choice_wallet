//! BIP-32 / BIP-44 derivation for secp256k1 accounts.

use bip32::{DerivationPath, XPrv};

use crate::{Error, Mnemonic, PrivateKey};

/// SLIP-44 coin type for Injective, the same as Ethereum. One key serves
/// both the inj1 and the 0x address.
pub const INJECTIVE_COIN_TYPE: u32 = 60;

/// BIP-44 path for Injective and EVM account `index`: `m/44'/60'/0'/0/{index}`.
/// This is the path Keplr, MetaMask and injective-ts use, so seeds restore
/// to the same addresses in those wallets.
pub fn injective_path(index: u32) -> String {
    format!("m/44'/{INJECTIVE_COIN_TYPE}'/0'/0/{index}")
}

/// Ledger Live layout for account `index`: `m/44'/60'/{index}'/0/0`. Ledger
/// Live and injective-ts's Ledger Cosmos strategy use it, so a Ledger shows
/// the same accounts here as there. Index 0 is the same key in both layouts.
pub fn ledger_live_path(index: u32) -> String {
    format!("m/44'/{INJECTIVE_COIN_TYPE}'/{index}'/0/0")
}

/// Derive the secp256k1 private key at `path` from a recovery phrase.
pub fn derive(mnemonic: &Mnemonic, path: &str) -> Result<PrivateKey, Error> {
    let path: DerivationPath = path.parse().map_err(|_| Error::InvalidPath)?;
    let seed = mnemonic.to_seed();
    let xprv = XPrv::derive_from_path(&seed[..], &path).map_err(|_| Error::Derivation)?;
    Ok(PrivateKey::from_signing_key(xprv.private_key().clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn injective_path_format() {
        assert_eq!(injective_path(0), "m/44'/60'/0'/0/0");
        assert_eq!(injective_path(7), "m/44'/60'/0'/0/7");
        assert_eq!(ledger_live_path(3), "m/44'/60'/3'/0/0");
    }

    #[test]
    fn layouts_agree_only_at_index_zero() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let addr = |path: String| derive(&m, &path).unwrap().public_key().eth_address();
        assert_eq!(addr(injective_path(0)), addr(ledger_live_path(0)));
        assert_ne!(addr(injective_path(1)), addr(ledger_live_path(1)));
    }

    #[test]
    fn known_ethereum_addresses() {
        // Widely published addresses for the BIP-39 "abandon … about" phrase
        // (MetaMask, ethers, Foundry all derive these).
        let m = Mnemonic::parse(ABANDON).unwrap();
        let expect = [
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0",
            "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A",
        ];
        for (i, want) in expect.iter().enumerate() {
            let key = derive(&m, &injective_path(i as u32)).unwrap();
            assert_eq!(key.public_key().eth_address().to_checksum_hex(), *want, "index {i}");
        }
    }

    #[test]
    fn rejects_bad_paths() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        for bad in ["", "44'/60'/0'/0/0", "m/44'/60'/0'/0/x", "m/44'/60'/0'/0/2147483648"] {
            assert_eq!(derive(&m, bad).unwrap_err(), Error::InvalidPath, "{bad:?}");
        }
    }
}
