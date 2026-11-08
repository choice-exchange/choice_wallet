//! ERC20 `transfer(address,uint256)` calldata.

use choice_wallet_core::EthAddress;

use crate::U256;

/// `bytes4(keccak256("transfer(address,uint256)"))`.
pub const TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// Calldata for `transfer(to, amount)`.
pub fn transfer_calldata(to: &EthAddress, amount: &U256) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&TRANSFER_SELECTOR);
    data.extend_from_slice(&[0; 12]);
    data.extend_from_slice(to.as_bytes());
    data.extend_from_slice(&amount.to_be_bytes());
    data
}

/// Recognise `transfer(to, amount)` calldata. Only the exact 68-byte form with a clean
/// address word counts; anything else is shown as a raw contract call.
pub fn parse_transfer(data: &[u8]) -> Option<(EthAddress, U256)> {
    let (selector, args) = data.split_first_chunk::<4>()?;
    if *selector != TRANSFER_SELECTOR || args.len() != 64 || args[..12] != [0; 12] {
        return None;
    }
    let to = EthAddress::from_bytes(args[12..32].try_into().ok()?);
    let amount = U256::from_be_bytes(args[32..64].try_into().ok()?);
    Some((to, amount))
}

#[cfg(test)]
mod tests {
    use super::*;
    use choice_wallet_core::secp256k1::keccak256;

    #[test]
    fn selector_is_the_keccak_prefix() {
        assert_eq!(keccak256(b"transfer(address,uint256)")[..4], TRANSFER_SELECTOR);
    }

    #[test]
    fn round_trip_and_strictness() {
        let to = EthAddress::from_bytes([0x11; 20]);
        let data = transfer_calldata(&to, &U256::from_u128(5));
        assert_eq!(parse_transfer(&data), Some((to, U256::from_u128(5))));

        let mut dirty = data.clone();
        dirty[4] = 1; // high bytes of the address word set
        assert_eq!(parse_transfer(&dirty), None);
        let mut long = data.clone();
        long.push(0);
        assert_eq!(parse_transfer(&long), None);
        assert_eq!(parse_transfer(&data[..67]), None);
        let mut other = data;
        other[0] = 0x09; // approve is 0x095ea7b3
        assert_eq!(parse_transfer(&other), None);
    }
}
