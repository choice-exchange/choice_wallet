//! Native USDC to other chains over Circle's CCTP V2, read from the calldata a wallet
//! signs on Injective EVM.
//!
//! A transfer burns USDC on Injective with `TokenMessengerV2.depositForBurn` (or
//! `depositForBurnWithHook`); Circle attests the burn and USDC is minted on the destination
//! to `mintRecipient`. Who submits that mint is the hook's business: Circle's Forwarding
//! Service does it for a fee when the hook data asks (the `cctp-forward` request), and
//! otherwise anyone may, once attested, unless `destinationCaller` pins one address.
//!
//! What a burn can't hide, and the rules hold it to: the amount, the destination domain, the
//! recipient there, the most Circle may keep (`maxFee`), who may mint (`destinationCaller`)
//! and the hook. `TokenMessengerV2` and USDC are pinned per network ([`Cctp`]), as Circle
//! publishes them (the same `TokenMessengerV2` address on every EVM chain of a network), and
//! checked on chain 2026-10-16 by `injective-usdc-bridge`'s `verify-chains`.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::abi::{self, Ty, Val};

/// How a chain spells the `bytes32` recipient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressKind {
    /// The low 20 bytes are a 0x address; the high 12 are zero.
    Evm,
    /// A 32-byte Solana account, shown in base58. For USDC it is a token account, not a
    /// wallet.
    Solana,
}

/// A CCTP domain the wallet names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Domain {
    /// Circle's domain number.
    pub id: u32,
    /// The chain's name.
    pub name: &'static str,
    /// How its recipients are spelled.
    pub kind: AddressKind,
    /// Circle's Forwarding Service delivers there (it mints for a fee).
    pub forwarding: bool,
}

/// CCTP on one Injective network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cctp {
    /// `TokenMessengerV2`.
    pub token_messenger: &'static str,
    /// Native USDC on Injective EVM (bank denom `erc20:` + this address).
    pub usdc: &'static str,
    /// The chains a burn may go to, as `injective-usdc-bridge` lists them.
    pub domains: &'static [Domain],
}

/// Injective's own domain: a burn can't go there from Injective.
pub const INJECTIVE_DOMAIN: u32 = 29;
/// `minFinalityThreshold` for Fast Transfer (Circle attests before hard finality).
pub const FAST: u32 = 1000;
/// `minFinalityThreshold` for Standard Transfer.
pub const STANDARD: u32 = 2000;

const fn evm(id: u32, name: &'static str, forwarding: bool) -> Domain {
    Domain {
        id,
        name,
        kind: AddressKind::Evm,
        forwarding,
    }
}

/// CCTP on Injective mainnet.
pub const MAINNET: Cctp = Cctp {
    token_messenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    domains: &[
        Domain {
            id: 5,
            name: "Solana",
            kind: AddressKind::Solana,
            forwarding: true,
        },
        evm(19, "HyperEVM", true),
        evm(0, "Ethereum", true),
        evm(6, "Base", true),
        evm(3, "Arbitrum", true),
        evm(2, "OP Mainnet", true),
        evm(26, "Arc", true),
        evm(7, "Polygon", true),
        evm(1, "Avalanche", true),
        evm(11, "Linea", true),
        evm(10, "Unichain", true),
        evm(13, "Sonic", true),
        evm(14, "World Chain", true),
        evm(15, "Monad", true),
        evm(16, "Sei", true),
        evm(33, "Plasma", false),
        evm(21, "Ink", true),
    ],
};

/// CCTP on Injective testnet (Circle's sandbox).
pub const TESTNET: Cctp = Cctp {
    token_messenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    usdc: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
    domains: &[
        evm(0, "Sepolia", true),
        evm(6, "Base Sepolia", true),
        evm(3, "Arbitrum Sepolia", true),
    ],
};

fn pinned(s: &str) -> EthAddress {
    EthAddress::parse_hex(s).expect("pinned addresses are valid")
}

impl Cctp {
    /// `TokenMessengerV2`.
    pub fn token_messenger(&self) -> EthAddress {
        pinned(self.token_messenger)
    }

    /// Native USDC.
    pub fn usdc(&self) -> EthAddress {
        pinned(self.usdc)
    }

    /// A domain the wallet names.
    pub fn domain(&self, id: u32) -> Option<&'static Domain> {
        self.domains.iter().find(|d| d.id == id)
    }
}

/// `depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)`.
pub const DEPOSIT_FOR_BURN: [u8; 4] = 0x8e0250eeu32.to_be_bytes();
/// `depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)`.
pub const DEPOSIT_FOR_BURN_WITH_HOOK: [u8; 4] = 0x779b432du32.to_be_bytes();

/// Circle's Forwarding Service request: "cctp-forward" in 24 bytes, then a 4-byte version
/// (0) and a 4-byte length of what follows (0 here).
pub const FORWARD_HOOK: [u8; 32] = *b"cctp-forward\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

/// What the hook data asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hook {
    /// None (`depositForBurn`, or empty hook data): someone must submit the mint on the
    /// destination (anyone, unless `destinationCaller` is set).
    None,
    /// Circle mints on the destination, for a fee within `maxFee`.
    Forward,
    /// Circle mints on Solana and first creates `owner`'s USDC account (the recipient), for
    /// a fee within `maxFee`.
    ForwardWithAccount {
        /// The Solana wallet that owns the recipient USDC account.
        owner: [u8; 32],
    },
    /// Anything else: data for some integrator's contract on the destination.
    Other(Vec<u8>),
}

/// A burn, as its calldata says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Burn {
    /// USDC base units (6 decimals).
    pub amount: U256,
    /// The destination's CCTP domain.
    pub domain: u32,
    /// Who receives on the destination, as 32 bytes.
    pub mint_recipient: [u8; 32],
    /// The token burned.
    pub burn_token: EthAddress,
    /// Who may submit the mint; all zero for anyone.
    pub destination_caller: [u8; 32],
    /// The most Circle keeps (fast-transfer and forwarding fees).
    pub max_fee: U256,
    /// `minFinalityThreshold`: [`FAST`] or [`STANDARD`] (other values are read as given).
    pub min_finality: u32,
    /// `depositForBurnWithHook`'s hook data, read.
    pub hook: Hook,
}

/// A recipient, spelled for its chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipient {
    /// A 0x address.
    Evm(EthAddress),
    /// A Solana account.
    Solana([u8; 32]),
}

impl Recipient {
    /// The 0x address (checksummed) or the base58 account.
    pub fn display(&self) -> String {
        match self {
            Recipient::Evm(a) => a.to_checksum_hex(),
            Recipient::Solana(b) => base58(b),
        }
    }
}

impl Burn {
    /// The recipient spelled as the destination spells it; `None` for an unnamed domain or
    /// an EVM recipient whose high 12 bytes aren't zero (no EVM address can receive it).
    pub fn recipient(&self, cctp: &Cctp) -> Option<Recipient> {
        match cctp.domain(self.domain)?.kind {
            AddressKind::Solana => Some(Recipient::Solana(self.mint_recipient)),
            AddressKind::Evm => self.mint_recipient[..12].iter().all(|&b| b == 0).then(|| {
                Recipient::Evm(EthAddress::from_bytes(
                    self.mint_recipient[12..].try_into().expect("20 bytes"),
                ))
            }),
        }
    }

    /// Anyone may submit the mint.
    pub fn permissionless(&self) -> bool {
        self.destination_caller.iter().all(|&b| b == 0)
    }
}

/// Why calldata to `TokenMessengerV2` isn't a burn the wallet can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CctpError(pub &'static str);

impl std::fmt::Display for CctpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for CctpError {}

const BURN_ARGS: [Ty; 7] = [Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Word];
const BURN_WITH_HOOK_ARGS: [Ty; 8] = [
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Bytes,
];

/// Read calldata sent to `to` (with `value` attached) as a CCTP burn: `None` if `to` isn't
/// this network's `TokenMessengerV2`.
pub fn burn(cctp: &Cctp, to: &EthAddress, value: U256, data: &[u8]) -> Option<Result<Burn, CctpError>> {
    (*to == cctp.token_messenger()).then(|| read_burn(value, data))
}

fn read_burn(value: U256, data: &[u8]) -> Result<Burn, CctpError> {
    let bad = |_| CctpError("the burn isn't canonically encoded");
    if !value.is_zero() {
        return Err(CctpError("a burn sends no INJ"));
    }
    let (selector, args) = data
        .split_at_checked(4)
        .ok_or(CctpError("too short to name a function"))?;
    let (vals, hook) = match <[u8; 4]>::try_from(selector).expect("4 bytes") {
        DEPOSIT_FOR_BURN => (abi::decode(&BURN_ARGS, args).map_err(bad)?, Hook::None),
        DEPOSIT_FOR_BURN_WITH_HOOK => {
            let v = abi::decode(&BURN_WITH_HOOK_ARGS, args).map_err(bad)?;
            let hook = read_hook(v[7].bytes().map_err(bad)?);
            (v, hook)
        }
        _ => return Err(CctpError("not a TokenMessengerV2 burn")),
    };
    let word = |v: &Val| -> Result<[u8; 32], CctpError> { Ok(*v.word().map_err(bad)?) };
    Ok(Burn {
        amount: vals[0].uint().map_err(bad)?,
        domain: u32::try_from(vals[1].small(32).map_err(bad)?).expect("32 bits"),
        mint_recipient: word(&vals[2])?,
        burn_token: vals[3].address().map_err(bad)?,
        destination_caller: word(&vals[4])?,
        max_fee: vals[5].uint().map_err(bad)?,
        min_finality: u32::try_from(vals[6].small(32).map_err(bad)?).expect("32 bits"),
        hook,
    })
}

fn read_hook(h: &[u8]) -> Hook {
    if h.is_empty() {
        return Hook::None;
    }
    if h == FORWARD_HOOK {
        return Hook::Forward;
    }
    // Version 0, 33 bytes of Circle data: 0x01 (create the account), then its owner.
    if h.len() == 65 && h[..28] == FORWARD_HOOK[..28] && h[28..32] == 33u32.to_be_bytes() && h[32] == 1 {
        return Hook::ForwardWithAccount {
            owner: h[33..].try_into().expect("32 bytes"),
        };
    }
    Hook::Other(h.to_vec())
}

/// Calldata for a burn (`depositForBurnWithHook` when the hook is anything but [`Hook::None`]).
pub fn burn_calldata(b: &Burn) -> Vec<u8> {
    let word_u32 = |n: u32| {
        let mut w = [0u8; 32];
        w[28..].copy_from_slice(&n.to_be_bytes());
        Val::Word(w)
    };
    let mut token = [0u8; 32];
    token[12..].copy_from_slice(b.burn_token.as_bytes());
    let mut vals = vec![
        Val::Word(b.amount.to_be_bytes()),
        word_u32(b.domain),
        Val::Word(b.mint_recipient),
        Val::Word(token),
        Val::Word(b.destination_caller),
        Val::Word(b.max_fee.to_be_bytes()),
        word_u32(b.min_finality),
    ];
    let hook = match &b.hook {
        Hook::None => None,
        Hook::Forward => Some(FORWARD_HOOK.to_vec()),
        Hook::ForwardWithAccount { owner } => {
            let mut h = FORWARD_HOOK[..28].to_vec();
            h.extend_from_slice(&33u32.to_be_bytes());
            h.push(1);
            h.extend_from_slice(owner);
            Some(h)
        }
        Hook::Other(h) => Some(h.clone()),
    };
    let selector = if let Some(h) = hook {
        vals.push(Val::Bytes(h));
        DEPOSIT_FOR_BURN_WITH_HOOK
    } else {
        DEPOSIT_FOR_BURN
    };
    let mut out = selector.to_vec();
    out.extend_from_slice(&abi::encode(&vals));
    out
}

/// Bitcoin's base58 alphabet, as Solana spells accounts.
pub fn base58(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    // Base-58 digits, least significant first.
    let mut digits: Vec<u8> = Vec::new();
    for &b in &bytes[zeros..] {
        let mut carry = u32::from(b);
        for d in &mut digits {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat_n('1', zeros));
    out.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize] as char));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap()
    }

    #[test]
    fn selectors_and_forward_hook_match_their_definitions() {
        assert_eq!(
            DEPOSIT_FOR_BURN,
            abi::selector("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)")
        );
        assert_eq!(
            DEPOSIT_FOR_BURN_WITH_HOOK,
            abi::selector("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)")
        );
        // Circle's documented static value.
        assert_eq!(
            FORWARD_HOOK.to_vec(),
            h("636374702d666f72776172640000000000000000000000000000000000000000")
        );
    }

    #[test]
    fn pinned_addresses_parse() {
        for c in [MAINNET, TESTNET] {
            let _ = (c.token_messenger(), c.usdc());
            assert!(c.domain(INJECTIVE_DOMAIN).is_none());
        }
    }

    /// Built by `injective-usdc-bridge` 0.2.0 (`burnCall`, checked against viem there): 25 USDC
    /// to 0x1111…1111 on Base, forwarded, max fee 0.2.
    const TO_BASE: &str = "0x779b432d00000000000000000000000000000000000000000000000000000000017d784000000000000000000000000000000000000000000000000000000000000000060000000000000000000000001111111111111111111111111111111111111111000000000000000000000000a00c59ff5a080d2b954d0c75e46e22a0c371235a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000007d000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000020636374702d666f72776172640000000000000000000000000000000000000000";

    #[test]
    fn reads_a_forwarded_burn_and_builds_the_same_bytes() {
        let data = h(TO_BASE);
        let b = burn(&MAINNET, &MAINNET.token_messenger(), U256::ZERO, &data)
            .unwrap()
            .unwrap();
        assert_eq!(b.amount, U256::from_u128(25_000_000));
        assert_eq!(b.domain, 6);
        assert_eq!(b.burn_token, MAINNET.usdc());
        assert_eq!(b.max_fee, U256::from_u128(200_000));
        assert_eq!(b.min_finality, STANDARD);
        assert_eq!(b.hook, Hook::Forward);
        assert!(b.permissionless());
        assert_eq!(
            b.recipient(&MAINNET),
            Some(Recipient::Evm(
                EthAddress::parse_hex("0x1111111111111111111111111111111111111111").unwrap()
            ))
        );
        assert_eq!(burn_calldata(&b), data);
    }

    #[test]
    fn plain_and_solana_burns() {
        let mut b = burn(&MAINNET, &MAINNET.token_messenger(), U256::ZERO, &h(TO_BASE))
            .unwrap()
            .unwrap();
        b.hook = Hook::None;
        let plain = burn_calldata(&b);
        assert_eq!(plain[..4], DEPOSIT_FOR_BURN);
        assert_eq!(read_burn(U256::ZERO, &plain).unwrap(), b);

        b.domain = 5;
        b.mint_recipient = [7; 32];
        b.hook = Hook::ForwardWithAccount { owner: [9; 32] };
        let data = burn_calldata(&b);
        assert_eq!(read_burn(U256::ZERO, &data).unwrap(), b);
        assert_eq!(b.recipient(&MAINNET), Some(Recipient::Solana([7; 32])));
        // An EVM chain can't receive at a bytes32 with its high bytes set.
        b.domain = 6;
        assert_eq!(b.recipient(&MAINNET), None);
        b.domain = 12345;
        assert_eq!(b.recipient(&MAINNET), None);
    }

    #[test]
    fn refuses_what_isnt_a_burn() {
        let tm = MAINNET.token_messenger();
        let data = h(TO_BASE);
        assert!(burn(&MAINNET, &MAINNET.usdc(), U256::ZERO, &data).is_none());
        assert_eq!(
            burn(&MAINNET, &tm, U256::from_u128(1), &data),
            Some(Err(CctpError("a burn sends no INJ")))
        );
        assert!(matches!(burn(&MAINNET, &tm, U256::ZERO, &data[..3]), Some(Err(_))));
        assert!(matches!(burn(&MAINNET, &tm, U256::ZERO, &data[..100]), Some(Err(_))));
        let mut longer = data.clone();
        longer.push(0);
        assert!(matches!(burn(&MAINNET, &tm, U256::ZERO, &longer), Some(Err(_))));
        let mut other = data.clone();
        other[..4].copy_from_slice(&[1, 2, 3, 4]);
        assert!(matches!(burn(&MAINNET, &tm, U256::ZERO, &other), Some(Err(_))));
        // A domain past 32 bits.
        let mut wide = data;
        wide[4 + 32 + 27] = 1;
        assert!(matches!(burn(&MAINNET, &tm, U256::ZERO, &wide), Some(Err(_))));
    }

    #[test]
    fn hooks() {
        assert_eq!(read_hook(&[]), Hook::None);
        let mut setup = FORWARD_HOOK[..28].to_vec();
        setup.extend_from_slice(&33u32.to_be_bytes());
        setup.push(1);
        setup.extend_from_slice(&[5; 32]);
        assert_eq!(read_hook(&setup), Hook::ForwardWithAccount { owner: [5; 32] });
        setup[32] = 0;
        assert!(matches!(read_hook(&setup), Hook::Other(_)));
        assert!(matches!(read_hook(b"cctp-forward"), Hook::Other(_)));
    }

    #[test]
    fn base58_matches_known_values() {
        assert_eq!(base58(&[]), "");
        assert_eq!(base58(&[0, 0, 1]), "112");
        assert_eq!(base58(b"hello world"), "StV1DL6CwTryKyV");
        // Solana's USDC mint.
        let usdc = h("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61");
        assert_eq!(base58(&usdc), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    }
}
