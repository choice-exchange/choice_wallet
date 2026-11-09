//! Program-derived addresses: accounts a program controls, found from seeds. An associated
//! token account (a wallet's account for one token) is one.

use choice_wallet_core::ed25519::on_curve;
use sha2::{Digest, Sha256};

use crate::message::Pubkey;
use crate::program::{ASSOCIATED_TOKEN, TOKEN};

/// `create_program_address`: `None` when the hash is on the curve (a key could sign for it),
/// or the seeds break the runtime's limits (16 seeds, 32 bytes each).
pub fn create_program_address(seeds: &[&[u8]], program: &Pubkey) -> Option<Pubkey> {
    if seeds.len() > 16 || seeds.iter().any(|s| s.len() > 32) {
        return None;
    }
    let mut h = Sha256::new();
    for s in seeds {
        h.update(s);
    }
    h.update(program);
    h.update(b"ProgramDerivedAddress");
    let out: Pubkey = h.finalize().into();
    (!on_curve(&out)).then_some(out)
}

/// `find_program_address`: the highest bump seed that gives an address off the curve.
pub fn find_program_address(seeds: &[&[u8]], program: &Pubkey) -> Option<(Pubkey, u8)> {
    (0..=255u8).rev().find_map(|bump| {
        let mut with = seeds.to_vec();
        let b = [bump];
        with.push(&b);
        create_program_address(&with, program).map(|a| (a, bump))
    })
}

/// `owner`'s associated token account for `mint`, under `token_program` (SPL Token or
/// Token-2022).
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    find_program_address(&[owner, token_program, mint], &ASSOCIATED_TOKEN.key())
        .expect("some bump is always off the curve")
        .0
}

/// Whether `account` is `owner`'s associated token account for `mint` under either token
/// program; the program it is under.
pub fn token_account_of(account: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Option<Pubkey> {
    [TOKEN.key(), crate::program::TOKEN_2022.key()]
        .into_iter()
        .find(|p| associated_token_address(owner, mint, p) == *account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors::*;

    #[test]
    fn associated_token_accounts_match_web3() {
        assert_eq!(associated_token_address(&key(OWNER), &key(USDC), &TOKEN.key()), key(ATA_OWNER_USDC));
        assert_eq!(associated_token_address(&key(OTHER), &key(USDC), &TOKEN.key()), key(ATA_OTHER_USDC));
        assert_eq!(token_account_of(&key(ATA_OTHER_USDC), &key(OTHER), &key(USDC)), Some(TOKEN.key()));
        assert_eq!(token_account_of(&key(ATA_OTHER_USDC), &key(OWNER), &key(USDC)), None);
        assert!(!on_curve(&key(ATA_OWNER_USDC)));
        // web3.js found the owner's at bump 254.
        let (_, bump) = find_program_address(&[&key(OWNER), &TOKEN.key(), &key(USDC)], &ASSOCIATED_TOKEN.key()).unwrap();
        assert_eq!(bump, 254);
    }

    #[test]
    fn cctp_addresses_match_the_bridge_package() {
        let tmm = key(TOKEN_MESSENGER_MINTER);
        let mt = key(MESSAGE_TRANSMITTER);
        assert_eq!(find_program_address(&[b"sender_authority"], &tmm).unwrap().0, key(PDA_SENDER_AUTHORITY));
        assert_eq!(
            find_program_address(&[b"remote_token_messenger", b"29"], &tmm).unwrap().0,
            key(PDA_REMOTE_TOKEN_MESSENGER_29)
        );
        assert_eq!(find_program_address(&[b"message_transmitter"], &mt).unwrap().0, key(PDA_MESSAGE_TRANSMITTER));
    }

    #[test]
    fn seed_limits() {
        let p = key(OWNER);
        assert!(create_program_address(&[&[0u8; 33]], &p).is_none());
        let many: Vec<&[u8]> = vec![b"x"; 17];
        assert!(create_program_address(&many, &p).is_none());
    }
}
