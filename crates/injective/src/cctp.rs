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
//!
//! USDC comes the other way from the EVM chains in [`Cctp::sources`]: there the wallet signs
//! only what [`source_call`] reads as a deposit into the signer's own account on Injective.
//! Circle doesn't deliver on Injective, so a deposit is minted by whoever submits it there
//! (`receiveMessage`, read by [`receive`]): Choice's bridge service does, and the wallet can
//! itself. A deposit through Choice's `BridgeReceiver` also buys INJ for gas
//! ([`Hook::GasDrop`]); only that contract can mint it.

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

/// An EVM chain USDC can come from into Injective, as `injective-usdc-bridge` lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    /// Circle's domain number.
    pub domain: u32,
    /// The chain's name.
    pub name: &'static str,
    /// EIP-155 chain ID.
    pub chain_id: u64,
    /// Native USDC there.
    pub usdc: &'static str,
    /// The coin its gas is paid in, and its decimals (Arc's is USDC, at 18).
    pub native: (&'static str, u8),
}

impl Source {
    /// Native USDC there.
    pub fn usdc(&self) -> EthAddress {
        pinned(self.usdc)
    }
}

/// CCTP on one Injective network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cctp {
    /// `TokenMessengerV2`, at this address on every EVM chain of the network.
    pub token_messenger: &'static str,
    /// `MessageTransmitterV2`, likewise: `receiveMessage` mints on Injective.
    pub message_transmitter: &'static str,
    /// Native USDC on Injective EVM (bank denom `erc20:` + this address).
    pub usdc: &'static str,
    /// Choice's `BridgeReceiver` on Injective: it mints deposits that also buy INJ for gas.
    pub bridge_receiver: Option<&'static str>,
    /// The chains a burn may go to, as `injective-usdc-bridge` lists them.
    pub domains: &'static [Domain],
    /// The EVM chains USDC may come from.
    pub sources: &'static [Source],
    /// Solana on this network: USDC comes from there too, signed with the account's Solana
    /// key. Circle's programs have the same IDs on mainnet and devnet
    /// (`choice_wallet_solana::program`).
    pub solana: SolanaSide,
}

/// Solana, as one Injective network bridges with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolanaSide {
    /// The chain's name.
    pub name: &'static str,
    /// CAIP-2 ID (`solana:` and the genesis hash's first 32 characters).
    pub caip2: &'static str,
    /// Native USDC's mint there, base58.
    pub usdc_mint: &'static str,
    /// Circle's TokenMessengerMinterV2 program there, base58: the sender of every transfer
    /// from Solana.
    pub token_messenger_minter: &'static str,
}

impl SolanaSide {
    /// Native USDC's mint.
    pub fn usdc_mint(&self) -> [u8; 32] {
        choice_wallet_core::base58::decode32(self.usdc_mint).expect("pinned mints are valid")
    }
}

/// Solana's CCTP domain.
pub const SOLANA_DOMAIN: u32 = 5;

/// A chain USDC comes into Injective from, as its messages name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inbound {
    /// The chain's name.
    pub name: &'static str,
    /// The message sender every transfer from there carries.
    pub sender: [u8; 32],
    /// The USDC burned there.
    pub burn_token: [u8; 32],
}

/// Injective as a destination, for burns that start elsewhere (Solana).
pub const INJECTIVE: Domain = Domain {
    id: INJECTIVE_DOMAIN,
    name: "Injective",
    kind: AddressKind::Evm,
    forwarding: false,
};

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

const fn source(domain: u32, name: &'static str, chain_id: u64, usdc: &'static str, native: &'static str) -> Source {
    Source {
        domain,
        name,
        chain_id,
        usdc,
        native: (native, 18),
    }
}

/// CCTP on Injective mainnet.
pub const MAINNET: Cctp = Cctp {
    token_messenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    message_transmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    // Owned by Choice's Safe; deployed and verified on Blockscout 2026-10-16.
    bridge_receiver: Some("0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A"),
    sources: &[
        source(
            19,
            "HyperEVM",
            999,
            "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
            "HYPE",
        ),
        source(0, "Ethereum", 1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "ETH"),
        source(6, "Base", 8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "ETH"),
        source(
            3,
            "Arbitrum",
            42161,
            "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "ETH",
        ),
        source(2, "OP Mainnet", 10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "ETH"),
        source(26, "Arc", 5042, "0x3600000000000000000000000000000000000000", "USDC"),
        source(7, "Polygon", 137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "POL"),
        source(
            1,
            "Avalanche",
            43114,
            "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
            "AVAX",
        ),
        source(11, "Linea", 59144, "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "ETH"),
        source(10, "Unichain", 130, "0x078D782b760474a361dDA0AF3839290b0EF57AD6", "ETH"),
        source(13, "Sonic", 146, "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", "S"),
        source(
            14,
            "World Chain",
            480,
            "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
            "ETH",
        ),
        source(15, "Monad", 143, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "MON"),
        source(16, "Sei", 1329, "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", "SEI"),
        source(33, "Plasma", 9745, "0x2d661C89D812261039AF9764eceaAee884f5F67F", "XPL"),
        source(21, "Ink", 57073, "0x2D270e6886d130D724215A266106e6832161EAEd", "ETH"),
    ],
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
    solana: SolanaSide {
        name: "Solana",
        caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        usdc_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        token_messenger_minter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    },
};

/// CCTP on Injective testnet (Circle's sandbox).
pub const TESTNET: Cctp = Cctp {
    token_messenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    message_transmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    usdc: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
    bridge_receiver: None,
    sources: &[
        source(
            0,
            "Sepolia",
            11155111,
            "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            "ETH",
        ),
        source(
            6,
            "Base Sepolia",
            84532,
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "ETH",
        ),
        source(
            3,
            "Arbitrum Sepolia",
            421614,
            "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
            "ETH",
        ),
    ],
    domains: &[
        evm(0, "Sepolia", true),
        evm(6, "Base Sepolia", true),
        evm(3, "Arbitrum Sepolia", true),
        // Circle's sandbox forwards there (Iris quoted a forwarding fee, 2026-11-10).
        Domain {
            id: SOLANA_DOMAIN,
            name: "Solana Devnet",
            kind: AddressKind::Solana,
            forwarding: true,
        },
    ],
    solana: SolanaSide {
        name: "Solana Devnet",
        caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        usdc_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        token_messenger_minter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    },
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

    /// `MessageTransmitterV2`.
    pub fn message_transmitter(&self) -> EthAddress {
        pinned(self.message_transmitter)
    }

    /// Choice's `BridgeReceiver`, where there is one.
    pub fn bridge_receiver(&self) -> Option<EthAddress> {
        self.bridge_receiver.map(pinned)
    }

    /// The source chain with this EIP-155 chain ID.
    pub fn source(&self, chain_id: u64) -> Option<&'static Source> {
        self.sources.iter().find(|s| s.chain_id == chain_id)
    }

    /// A destination for a burn that starts on Solana: Injective, or a chain Injective sends
    /// to (CCTP domains are the same everywhere), but not Solana itself.
    pub fn from_solana(&self, id: u32) -> Option<&'static Domain> {
        match id {
            INJECTIVE_DOMAIN => Some(&INJECTIVE),
            SOLANA_DOMAIN => None,
            _ => self.domain(id),
        }
    }

    /// Where a transfer into Injective from `domain` comes from, as the wallet names it: the
    /// chain, the sender its message must carry (TokenMessengerV2 on an EVM chain, Circle's
    /// program on Solana), and the USDC it burned there.
    pub fn inbound(&self, domain: u32) -> Option<Inbound> {
        if domain == SOLANA_DOMAIN {
            let program = choice_wallet_core::base58::decode32(self.solana.token_messenger_minter)
                .expect("pinned programs are valid");
            return Some(Inbound {
                name: self.solana.name,
                sender: program,
                burn_token: self.solana.usdc_mint(),
            });
        }
        let s = self.source_domain(domain)?;
        Some(Inbound {
            name: s.name,
            sender: word(&self.token_messenger()),
            burn_token: word(&s.usdc()),
        })
    }

    /// The source chain with this CCTP domain.
    pub fn source_domain(&self, domain: u32) -> Option<&'static Source> {
        self.sources.iter().find(|s| s.domain == domain)
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
    /// Choice's `BridgeReceiver` on Injective mints it (it must be both `mintRecipient` and
    /// `destinationCaller`), pays `recipient`, and buys INJ for its gas with at most
    /// `max_drop_fee` of the USDC: `abi.encode(bytes4 "IUB1", address, uint256)`.
    GasDrop {
        /// Who receives the USDC and the INJ.
        recipient: EthAddress,
        /// The most USDC the INJ may cost.
        max_drop_fee: U256,
    },
    /// Anything else: data for some integrator's contract on the destination.
    Other(Vec<u8>),
}

/// `BridgeReceiver`'s hook magic.
pub const GAS_DROP_MAGIC: [u8; 4] = *b"IUB1";

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

/// Read hook data (any chain's burn: Solana's carries the same bytes).
pub fn read_hook(h: &[u8]) -> Hook {
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
    // abi.encode(bytes4, address, uint256): the magic left-aligned, the address right-aligned.
    if h.len() == 96 && h[..4] == GAS_DROP_MAGIC && h[4..44].iter().all(|&b| b == 0) {
        return Hook::GasDrop {
            recipient: EthAddress::from_bytes(h[44..64].try_into().expect("20 bytes")),
            max_drop_fee: U256::from_be_bytes(h[64..].try_into().expect("32 bytes")),
        };
    }
    Hook::Other(h.to_vec())
}

/// The hook data a burn carries for `hook` (`None` for a plain `depositForBurn`).
pub fn hook_bytes(hook: &Hook) -> Option<Vec<u8>> {
    match hook {
        Hook::None => None,
        Hook::Forward => Some(FORWARD_HOOK.to_vec()),
        Hook::ForwardWithAccount { owner } => {
            let mut h = FORWARD_HOOK[..28].to_vec();
            h.extend_from_slice(&33u32.to_be_bytes());
            h.push(1);
            h.extend_from_slice(owner);
            Some(h)
        }
        Hook::GasDrop {
            recipient,
            max_drop_fee,
        } => {
            let mut h = vec![0u8; 96];
            h[..4].copy_from_slice(&GAS_DROP_MAGIC);
            h[44..64].copy_from_slice(recipient.as_bytes());
            h[64..].copy_from_slice(&max_drop_fee.to_be_bytes());
            Some(h)
        }
        Hook::Other(h) => Some(h.clone()),
    }
}

/// `bytes32` of an EVM address, as CCTP names recipients and callers.
pub fn word(a: &EthAddress) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_bytes());
    w
}

/// An EVM address held in a `bytes32`, if its high 12 bytes are zero.
fn address_in(w: &[u8; 32]) -> Option<EthAddress> {
    w[..12]
        .iter()
        .all(|&b| b == 0)
        .then(|| EthAddress::from_bytes(w[12..].try_into().expect("20 bytes")))
}

/// What the wallet signs on a [`Source`] chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceCall {
    /// `approve(TokenMessengerV2, amount)` on its USDC.
    Approve {
        /// The allowance, in USDC base units.
        amount: U256,
    },
    /// A burn that pays the signer on Injective.
    Deposit(Box<Deposit>),
}

/// A burn on a source chain into the signer's own account on Injective.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deposit {
    /// The burn as its calldata says.
    pub burn: Burn,
    /// Who mints it on Injective.
    pub delivery: Delivery,
}

/// Who mints a deposit on Injective.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Anyone: Choice's bridge service does, or the wallet itself.
    Anyone,
    /// Choice's `BridgeReceiver`, which also buys INJ for gas with at most this much USDC.
    GasDrop {
        /// The most the INJ may cost, in USDC base units.
        max_drop_fee: U256,
    },
}

impl Deposit {
    /// The least that arrives: the amount less Circle's most and the gas drop's.
    pub fn least(&self) -> U256 {
        let drop = match self.delivery {
            Delivery::Anyone => U256::ZERO,
            Delivery::GasDrop { max_drop_fee } => max_drop_fee,
        };
        self.burn
            .amount
            .checked_sub(&self.burn.max_fee)
            .and_then(|v| v.checked_sub(&drop))
            .unwrap_or(U256::ZERO)
    }
}

/// The most an approval on a source chain may give: under the risk rules' "unlimited" (2^100).
fn unlimited() -> U256 {
    let mut b = [0u8; 32];
    b[19] = 0x10; // 2^100
    U256::from_be_bytes(b)
}

/// Read a transaction `from` sends to `to` on `source`: an exact USDC approval for
/// `TokenMessengerV2`, or a burn of USDC that pays `from` on Injective (minted by anyone, or by
/// `BridgeReceiver` with a gas drop for `from`), with Circle's most and any drop fee below
/// the amount. Anything else is refused, with why.
pub fn source_call(
    cctp: &Cctp,
    source: &Source,
    from: &EthAddress,
    to: &EthAddress,
    value: U256,
    data: &[u8],
) -> Result<SourceCall, CctpError> {
    if !value.is_zero() {
        return Err(CctpError("a bridge transfer sends no coin"));
    }
    if *to == source.usdc() {
        let (selector, args) = data.split_at_checked(4).ok_or(CctpError("not an approval"))?;
        if selector != choice_wallet_evm::erc20::APPROVE_SELECTOR {
            return Err(CctpError("on USDC the wallet only approves Circle's bridge"));
        }
        let v = abi::decode(&[Ty::Word, Ty::Word], args)
            .map_err(|_| CctpError("the approval isn't canonically encoded"))?;
        let (spender, amount) = (v[0].address(), v[1].uint());
        let (Ok(spender), Ok(amount)) = (spender, amount) else {
            return Err(CctpError("the approval isn't canonically encoded"));
        };
        if spender != cctp.token_messenger() {
            return Err(CctpError("on USDC the wallet only approves Circle's bridge"));
        }
        if amount.is_zero() || amount >= unlimited() {
            return Err(CctpError("an approval for a bridge transfer is for the exact amount"));
        }
        return Ok(SourceCall::Approve { amount });
    }
    if *to != cctp.token_messenger() {
        return Err(CctpError("there the wallet signs only USDC transfers to Injective"));
    }
    let burn = read_burn(value, data)?;
    if burn.domain != INJECTIVE_DOMAIN {
        return Err(CctpError("the transfer goes somewhere other than Injective"));
    }
    if burn.burn_token != source.usdc() {
        return Err(CctpError("it burns a token other than USDC"));
    }
    if burn.min_finality != FAST && burn.min_finality != STANDARD {
        return Err(CctpError("an unknown finality threshold"));
    }
    let me = word(from);
    let delivery = match (&burn.hook, cctp.bridge_receiver()) {
        (Hook::None, _) if burn.permissionless() && burn.mint_recipient == me => Delivery::Anyone,
        (
            Hook::GasDrop {
                recipient,
                max_drop_fee,
            },
            Some(receiver),
        ) if recipient == from
            && burn.mint_recipient == word(&receiver)
            && burn.destination_caller == word(&receiver) =>
        {
            Delivery::GasDrop {
                max_drop_fee: *max_drop_fee,
            }
        }
        _ => return Err(CctpError("the transfer doesn't pay this account on Injective")),
    };
    let fees = match delivery {
        Delivery::Anyone => Some(burn.max_fee),
        Delivery::GasDrop { max_drop_fee } => burn.max_fee.checked_add(&max_drop_fee),
    };
    if fees.is_none_or(|f| f >= burn.amount) {
        return Err(CctpError("its fees could take all of it"));
    }
    Ok(SourceCall::Deposit(Box::new(Deposit { burn, delivery })))
}

/// `receiveMessage(bytes,bytes)`: mints an attested transfer on its destination.
pub const RECEIVE_MESSAGE: [u8; 4] = 0x57ecfd28u32.to_be_bytes();

/// A transfer being minted on Injective, as its attested message says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receive {
    /// Where it was burned.
    pub source_domain: u32,
    /// Where it is minted: Injective's for a message Injective accepts.
    pub destination_domain: u32,
    /// Circle's nonce: each is minted once.
    pub nonce: [u8; 32],
    /// The message's sender on the source, and recipient here: `TokenMessengerV2` for a USDC
    /// transfer.
    pub sender: [u8; 32],
    /// See `sender`.
    pub recipient: [u8; 32],
    /// Who may submit it; all zero for anyone.
    pub destination_caller: [u8; 32],
    /// The token burned on the source.
    pub burn_token: [u8; 32],
    /// Who is paid here.
    pub mint_recipient: [u8; 32],
    /// What was burned.
    pub amount: U256,
    /// The most Circle may keep.
    pub max_fee: U256,
    /// What Circle keeps: the amount less this is minted.
    pub fee_executed: U256,
    /// The burn's hook data.
    pub hook: Hook,
}

impl Receive {
    /// Who is paid, as an EVM address (`None` if the `bytes32` can't be one).
    pub fn paid(&self) -> Option<EthAddress> {
        address_in(&self.mint_recipient)
    }

    /// What is minted: the amount less Circle's fee.
    pub fn minted(&self) -> U256 {
        self.amount.checked_sub(&self.fee_executed).unwrap_or(U256::ZERO)
    }

    /// Anyone may submit it.
    pub fn permissionless(&self) -> bool {
        self.destination_caller.iter().all(|&b| b == 0)
    }
}

/// CCTP V2's message header and burn body: offsets as `MessageV2` and `BurnMessageV2` lay
/// them out.
const HEADER: usize = 148;
const BURN_BODY: usize = 228;

/// Read calldata sent to `to` as `receiveMessage`: `None` if `to` isn't this network's
/// `MessageTransmitterV2`.
pub fn receive(cctp: &Cctp, to: &EthAddress, value: U256, data: &[u8]) -> Option<Result<Receive, CctpError>> {
    (*to == cctp.message_transmitter()).then(|| read_receive(value, data))
}

fn read_receive(value: U256, data: &[u8]) -> Result<Receive, CctpError> {
    if !value.is_zero() {
        return Err(CctpError("a mint sends no INJ"));
    }
    let (selector, args) = data
        .split_at_checked(4)
        .ok_or(CctpError("too short to name a function"))?;
    if selector != RECEIVE_MESSAGE {
        return Err(CctpError("not receiveMessage"));
    }
    let bad = |_| CctpError("the mint isn't canonically encoded");
    let v = abi::decode(&[Ty::Bytes, Ty::Bytes], args).map_err(bad)?;
    let m = v[0].bytes().map_err(bad)?;
    if v[1].bytes().map_err(bad)?.is_empty() {
        return Err(CctpError("the mint has no attestation"));
    }
    if m.len() < HEADER + BURN_BODY {
        return Err(CctpError("the message isn't a USDC transfer"));
    }
    let u32_at = |i: usize| u32::from_be_bytes(m[i..i + 4].try_into().expect("4 bytes"));
    let w = |i: usize| -> [u8; 32] { m[i..i + 32].try_into().expect("32 bytes") };
    let b = HEADER;
    Ok(Receive {
        source_domain: u32_at(4),
        destination_domain: u32_at(8),
        nonce: w(12),
        sender: w(44),
        recipient: w(76),
        destination_caller: w(108),
        burn_token: w(b + 4),
        mint_recipient: w(b + 36),
        amount: U256::from_be_bytes(w(b + 68)),
        max_fee: U256::from_be_bytes(w(b + 132)),
        fee_executed: U256::from_be_bytes(w(b + 164)),
        hook: read_hook(&m[b + BURN_BODY..]),
    })
}

/// Calldata for `receiveMessage(message, attestation)`.
pub fn receive_calldata(message: &[u8], attestation: &[u8]) -> Vec<u8> {
    let mut out = RECEIVE_MESSAGE.to_vec();
    out.extend_from_slice(&abi::encode(&[
        Val::Bytes(message.to_vec()),
        Val::Bytes(attestation.to_vec()),
    ]));
    out
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
    let selector = if let Some(h) = hook_bytes(&b.hook) {
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
    choice_wallet_core::base58::encode(bytes)
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

    /// Built by `injective-usdc-bridge` 0.2.0 (`buildBurn`): 25 USDC from Base to
    /// 0x1111…1111 on Injective, fast, max fee 0.003; and the same through `BridgeReceiver`
    /// with a gas drop of at most 0.5.
    const APPROVE_ON_BASE: &str = "0x095ea7b300000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d00000000000000000000000000000000000000000000000000000000017d7840";
    const FROM_BASE: &str = "0x8e0250ee00000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000001d0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bb800000000000000000000000000000000000000000000000000000000000003e8";
    const FROM_BASE_WITH_DROP: &str = "0x779b432d00000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000001d000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb218cd4a000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb218cd4a0000000000000000000000000000000000000000000000000000000000000bb800000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000006049554231000000000000000000000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000007a120";

    fn me() -> EthAddress {
        EthAddress::parse_hex("0x1111111111111111111111111111111111111111").unwrap()
    }

    #[test]
    fn sources_are_named_once_and_parse() {
        for c in [MAINNET, TESTNET] {
            let _ = (c.message_transmitter(), c.bridge_receiver());
            for s in c.sources {
                let _ = s.usdc();
                assert_ne!(s.domain, INJECTIVE_DOMAIN);
                assert_eq!(c.source(s.chain_id), Some(s));
                assert_eq!(c.source_domain(s.domain), Some(s));
            }
        }
        assert_eq!(MAINNET.source(8453).unwrap().name, "Base");
        assert_eq!(MAINNET.source(5042).unwrap().native, ("USDC", 18));
        assert!(MAINNET.source(1776).is_none());
    }

    #[test]
    fn reads_deposits_into_the_signers_own_account() {
        let base = MAINNET.source(8453).unwrap();
        let (tm, usdc) = (MAINNET.token_messenger(), base.usdc());
        assert_eq!(
            source_call(&MAINNET, base, &me(), &usdc, U256::ZERO, &h(APPROVE_ON_BASE)),
            Ok(SourceCall::Approve {
                amount: U256::from_u128(25_000_000)
            })
        );
        let Ok(SourceCall::Deposit(d)) = source_call(&MAINNET, base, &me(), &tm, U256::ZERO, &h(FROM_BASE)) else {
            panic!("a deposit")
        };
        assert_eq!(d.delivery, Delivery::Anyone);
        assert_eq!(d.burn.min_finality, FAST);
        assert_eq!(d.least(), U256::from_u128(24_997_000));
        assert_eq!(burn_calldata(&d.burn), h(FROM_BASE));

        let Ok(SourceCall::Deposit(d)) = source_call(&MAINNET, base, &me(), &tm, U256::ZERO, &h(FROM_BASE_WITH_DROP))
        else {
            panic!("a deposit")
        };
        assert_eq!(
            d.delivery,
            Delivery::GasDrop {
                max_drop_fee: U256::from_u128(500_000)
            }
        );
        assert_eq!(d.least(), U256::from_u128(24_497_000));
        assert_eq!(burn_calldata(&d.burn), h(FROM_BASE_WITH_DROP));
    }

    #[test]
    fn refuses_anything_else_on_a_source_chain() {
        let base = MAINNET.source(8453).unwrap();
        let (tm, usdc) = (MAINNET.token_messenger(), base.usdc());
        let them = EthAddress::parse_hex("0x2222222222222222222222222222222222222222").unwrap();
        let refused = |from: &EthAddress, to: &EthAddress, value: U256, data: &[u8]| {
            source_call(&MAINNET, base, from, to, value, data).unwrap_err()
        };
        // Someone else's deposit: it pays 0x1111…, not the signer.
        assert_eq!(
            refused(&them, &tm, U256::ZERO, &h(FROM_BASE)).0,
            "the transfer doesn't pay this account on Injective"
        );
        assert_eq!(
            refused(&them, &tm, U256::ZERO, &h(FROM_BASE_WITH_DROP)).0,
            "the transfer doesn't pay this account on Injective"
        );
        // Coin attached; the wrong chain's USDC; a contract that isn't Circle's or USDC.
        assert!(source_call(&MAINNET, base, &me(), &tm, U256::from_u128(1), &h(FROM_BASE)).is_err());
        let arbitrum = MAINNET.source(42161).unwrap();
        assert_eq!(
            source_call(&MAINNET, arbitrum, &me(), &tm, U256::ZERO, &h(FROM_BASE))
                .unwrap_err()
                .0,
            "it burns a token other than USDC"
        );
        assert!(
            refused(&me(), &them, U256::ZERO, &h(FROM_BASE))
                .0
                .contains("only USDC transfers to Injective")
        );
        // A transfer of USDC, or an approval for anyone but Circle, or an unlimited one.
        let transfer = choice_wallet_evm::erc20::transfer_calldata(&them, &U256::from_u128(1));
        assert!(
            refused(&me(), &usdc, U256::ZERO, &transfer)
                .0
                .contains("only approves Circle's bridge")
        );
        let approve_them = choice_wallet_evm::erc20::approve_calldata(&them, &U256::from_u128(1));
        assert!(
            refused(&me(), &usdc, U256::ZERO, &approve_them)
                .0
                .contains("only approves Circle's bridge")
        );
        let unlimited = choice_wallet_evm::erc20::approve_calldata(&tm, &U256::MAX);
        assert!(refused(&me(), &usdc, U256::ZERO, &unlimited).0.contains("exact amount"));
        let zero = choice_wallet_evm::erc20::approve_calldata(&tm, &U256::ZERO);
        assert!(refused(&me(), &usdc, U256::ZERO, &zero).0.contains("exact amount"));
        // A burn to another chain, or forwarded, or pinned to a caller, or eaten by fees.
        let plain = burn(&MAINNET, &tm, U256::ZERO, &h(FROM_BASE)).unwrap().unwrap();
        let try_burn = |b: &Burn| source_call(&MAINNET, base, &me(), &tm, U256::ZERO, &burn_calldata(b));
        let mut b = plain.clone();
        b.domain = 6;
        assert!(try_burn(&b).is_err());
        let mut b = plain.clone();
        b.hook = Hook::Forward;
        assert!(try_burn(&b).is_err());
        let mut b = plain.clone();
        b.destination_caller = word(&them);
        assert!(try_burn(&b).is_err());
        let mut b = plain.clone();
        b.max_fee = b.amount;
        assert_eq!(try_burn(&b).unwrap_err().0, "its fees could take all of it");
        let mut b = plain.clone();
        b.min_finality = 500;
        assert!(try_burn(&b).is_err());
        // A gas drop through some other contract, or whose fees together take it all.
        let receiver = MAINNET.bridge_receiver().unwrap();
        let mut b = plain.clone();
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(1),
        };
        b.mint_recipient = word(&them);
        b.destination_caller = word(&them);
        assert!(try_burn(&b).is_err());
        b.mint_recipient = word(&receiver);
        b.destination_caller = word(&receiver);
        assert!(try_burn(&b).is_ok());
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(25_000_000 - 3_000),
        };
        assert!(try_burn(&b).is_err());
        // Testnet has no BridgeReceiver.
        let sepolia = TESTNET.source(84532).unwrap();
        let mut b = plain;
        b.burn_token = sepolia.usdc();
        assert!(
            source_call(
                &TESTNET,
                sepolia,
                &me(),
                &TESTNET.token_messenger(),
                U256::ZERO,
                &burn_calldata(&b)
            )
            .is_ok()
        );
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(1),
        };
        assert!(
            source_call(
                &TESTNET,
                sepolia,
                &me(),
                &TESTNET.token_messenger(),
                U256::ZERO,
                &burn_calldata(&b)
            )
            .is_err()
        );
    }

    /// A message as MessageTransmitterV2 lays it out: 25 USDC burned on Base for 0x1111…1111,
    /// with 0.0025 kept by Circle.
    fn message() -> Vec<u8> {
        let base = MAINNET.source(8453).unwrap();
        let tm = word(&MAINNET.token_messenger());
        let mut m = Vec::new();
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&6u32.to_be_bytes());
        m.extend_from_slice(&29u32.to_be_bytes());
        m.extend_from_slice(&[3; 32]);
        m.extend_from_slice(&tm);
        m.extend_from_slice(&tm);
        m.extend_from_slice(&[0; 32]);
        m.extend_from_slice(&FAST.to_be_bytes());
        m.extend_from_slice(&FAST.to_be_bytes());
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&word(&base.usdc()));
        m.extend_from_slice(&word(&me()));
        m.extend_from_slice(&U256::from_u128(25_000_000).to_be_bytes());
        m.extend_from_slice(&word(&me()));
        m.extend_from_slice(&U256::from_u128(3_000).to_be_bytes());
        m.extend_from_slice(&U256::from_u128(2_500).to_be_bytes());
        m.extend_from_slice(&[0; 32]);
        m
    }

    #[test]
    fn reads_a_mint_on_injective() {
        assert_eq!(RECEIVE_MESSAGE, abi::selector("receiveMessage(bytes,bytes)"));
        let mt = MAINNET.message_transmitter();
        let data = receive_calldata(&message(), &[7; 65]);
        let r = receive(&MAINNET, &mt, U256::ZERO, &data).unwrap().unwrap();
        assert_eq!((r.source_domain, r.destination_domain), (6, 29));
        assert_eq!(r.nonce, [3; 32]);
        assert_eq!(r.sender, word(&MAINNET.token_messenger()));
        assert_eq!(r.burn_token, word(&MAINNET.source(8453).unwrap().usdc()));
        assert_eq!(r.paid(), Some(me()));
        assert_eq!(r.minted(), U256::from_u128(24_997_500));
        assert!(r.permissionless());
        assert_eq!(r.hook, Hook::None);

        assert!(receive(&MAINNET, &MAINNET.token_messenger(), U256::ZERO, &data).is_none());
        assert!(matches!(
            receive(&MAINNET, &mt, U256::from_u128(1), &data),
            Some(Err(_))
        ));
        assert!(matches!(
            receive(&MAINNET, &mt, U256::ZERO, &receive_calldata(&message(), &[])),
            Some(Err(_))
        ));
        assert!(matches!(
            receive(
                &MAINNET,
                &mt,
                U256::ZERO,
                &receive_calldata(&message()[..300], &[7; 65])
            ),
            Some(Err(_))
        ));
        let mut longer = data.clone();
        longer.push(0);
        assert!(matches!(receive(&MAINNET, &mt, U256::ZERO, &longer), Some(Err(_))));
    }

    #[test]
    fn gas_drop_hooks_read_and_write() {
        let hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(500_000),
        };
        let bytes = hook_bytes(&hook).unwrap();
        assert_eq!(bytes.len(), 96);
        assert_eq!(read_hook(&bytes), hook);
        // Anything in the padding makes it someone else's hook.
        let mut odd = bytes.clone();
        odd[10] = 1;
        assert!(matches!(read_hook(&odd), Hook::Other(_)));
        let mut odd = bytes;
        odd[33] = 1;
        assert!(matches!(read_hook(&odd), Hook::Other(_)));
        assert_eq!(U256::from_u128(5).checked_sub(&U256::from_u128(7)), None);
        assert_eq!(
            U256::from_u128(1 << 70).checked_sub(&U256::from_u128(1)),
            Some(U256::from_u128((1 << 70) - 1))
        );
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
