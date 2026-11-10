//! Native USDC between chains over Circle's CCTP V2, read from the calldata the wallet signs
//! on any EVM chain of [`Cctp::evm`] (Injective EVM among them).
//!
//! A transfer burns USDC with `TokenMessengerV2.depositForBurn` (or `depositForBurnWithHook`);
//! Circle attests the burn and USDC is minted on the destination to `mintRecipient`. Who
//! submits that mint is the hook's business: Circle's Forwarding Service does it for a fee
//! when the hook data asks (the `cctp-forward` request), and otherwise anyone may, once
//! attested, unless `destinationCaller` pins one address.
//!
//! What a burn can't hide, and the rules hold it to: the amount, the destination domain, the
//! recipient there, the most Circle may keep (`maxFee`), who may mint (`destinationCaller`)
//! and the hook. `TokenMessengerV2`, `MessageTransmitterV2` and each chain's USDC are pinned
//! per network ([`Cctp`]), as Circle publishes them (the same `TokenMessengerV2` address on
//! every EVM chain of a network), and checked on chain 2026-10-16 by
//! `injective-usdc-bridge`'s `verify-chains`.
//!
//! Circle doesn't deliver on Injective (nor on Plasma), so a transfer there is minted by
//! whoever submits it (`receiveMessage`, read by [`receive`]): on Injective, Choice's bridge
//! service does, and the wallet can itself. A deposit through Choice's `BridgeReceiver` also
//! buys INJ for gas ([`Hook::GasDrop`]); only that contract can mint it. [`transfer`] reads a
//! burn as one the wallet would make itself.

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

/// A chain on CCTP, as the wallet names it.
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

/// An EVM chain on CCTP, as `injective-usdc-bridge` lists it. The account's 0x key signs
/// there; Injective EVM is one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvmChain {
    /// Circle's domain number.
    pub domain: u32,
    /// The chain's name.
    pub name: &'static str,
    /// CAIP-2 ID: `eip155:` and the chain ID.
    pub caip2: &'static str,
    /// EIP-155 chain ID.
    pub chain_id: u64,
    /// Native USDC there.
    pub usdc: &'static str,
    /// The coin its gas is paid in, and its decimals (Arc's is USDC, at 18).
    pub native: (&'static str, u8),
}

impl EvmChain {
    /// Native USDC there.
    pub fn usdc(&self) -> EthAddress {
        pinned(self.usdc)
    }
}

/// CCTP on one network: Injective's, and every chain beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cctp {
    /// `TokenMessengerV2`, at this address on every EVM chain of the network.
    pub token_messenger: &'static str,
    /// `MessageTransmitterV2`, likewise: `receiveMessage` mints on its chain.
    pub message_transmitter: &'static str,
    /// Native USDC on Injective EVM (bank denom `erc20:` + this address).
    pub usdc: &'static str,
    /// Choice's `BridgeReceiver` on Injective: it mints deposits that also buy INJ for gas.
    pub bridge_receiver: Option<&'static str>,
    /// Every chain USDC may go to or come from, Injective and Solana among them, as
    /// `injective-usdc-bridge` lists them.
    pub domains: &'static [Domain],
    /// Every EVM chain among them, Injective EVM first.
    pub evm: &'static [EvmChain],
    /// Solana on this network, signed with the account's Solana key. Circle's programs have
    /// the same IDs on mainnet and devnet (`choice_wallet_solana::program`).
    pub solana: SolanaSide,
}

/// Solana, as one network bridges with it.
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

/// A chain USDC comes from, as its messages name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inbound {
    /// The chain's name.
    pub name: &'static str,
    /// The message sender every transfer from there carries.
    pub sender: [u8; 32],
    /// The USDC burned there.
    pub burn_token: [u8; 32],
}

/// Injective's own domain.
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

const fn chain(
    domain: u32,
    name: &'static str,
    caip2: &'static str,
    chain_id: u64,
    usdc: &'static str,
    native: &'static str,
) -> EvmChain {
    EvmChain {
        domain,
        name,
        caip2,
        chain_id,
        usdc,
        native: (native, 18),
    }
}

/// CCTP on Injective mainnet, and the mainnets beside it.
pub const MAINNET: Cctp = Cctp {
    token_messenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    message_transmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    // Owned by Choice's Safe; deployed and verified on Blockscout 2026-10-16.
    bridge_receiver: Some("0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A"),
    evm: &[
        chain(
            INJECTIVE_DOMAIN,
            "Injective",
            "eip155:1776",
            1776,
            "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
            "INJ",
        ),
        chain(
            0,
            "Ethereum",
            "eip155:1",
            1,
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "ETH",
        ),
        chain(
            6,
            "Base",
            "eip155:8453",
            8453,
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "ETH",
        ),
        chain(
            3,
            "Arbitrum",
            "eip155:42161",
            42161,
            "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "ETH",
        ),
        chain(
            2,
            "OP Mainnet",
            "eip155:10",
            10,
            "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            "ETH",
        ),
        chain(
            7,
            "Polygon",
            "eip155:137",
            137,
            "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            "POL",
        ),
        chain(
            1,
            "Avalanche",
            "eip155:43114",
            43114,
            "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
            "AVAX",
        ),
        chain(
            19,
            "HyperEVM",
            "eip155:999",
            999,
            "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
            "HYPE",
        ),
        chain(
            26,
            "Arc",
            "eip155:5042",
            5042,
            "0x3600000000000000000000000000000000000000",
            "USDC",
        ),
        chain(
            11,
            "Linea",
            "eip155:59144",
            59144,
            "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
            "ETH",
        ),
        chain(
            10,
            "Unichain",
            "eip155:130",
            130,
            "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
            "ETH",
        ),
        chain(
            13,
            "Sonic",
            "eip155:146",
            146,
            "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
            "S",
        ),
        chain(
            14,
            "World Chain",
            "eip155:480",
            480,
            "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
            "ETH",
        ),
        chain(
            15,
            "Monad",
            "eip155:143",
            143,
            "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
            "MON",
        ),
        chain(
            16,
            "Sei",
            "eip155:1329",
            1329,
            "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
            "SEI",
        ),
        chain(
            33,
            "Plasma",
            "eip155:9745",
            9745,
            "0x2d661C89D812261039AF9764eceaAee884f5F67F",
            "XPL",
        ),
        chain(
            21,
            "Ink",
            "eip155:57073",
            57073,
            "0x2D270e6886d130D724215A266106e6832161EAEd",
            "ETH",
        ),
    ],
    domains: &[
        evm(INJECTIVE_DOMAIN, "Injective", false),
        Domain {
            id: SOLANA_DOMAIN,
            name: "Solana",
            kind: AddressKind::Solana,
            forwarding: true,
        },
        evm(0, "Ethereum", true),
        evm(6, "Base", true),
        evm(3, "Arbitrum", true),
        evm(2, "OP Mainnet", true),
        evm(7, "Polygon", true),
        evm(1, "Avalanche", true),
        evm(19, "HyperEVM", true),
        evm(26, "Arc", true),
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

/// CCTP on Injective testnet and the test networks beside it (Circle's sandbox).
pub const TESTNET: Cctp = Cctp {
    token_messenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    message_transmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    usdc: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
    bridge_receiver: None,
    evm: &[
        chain(
            INJECTIVE_DOMAIN,
            "Injective Testnet",
            "eip155:1439",
            1439,
            "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
            "INJ",
        ),
        chain(
            0,
            "Sepolia",
            "eip155:11155111",
            11155111,
            "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            "ETH",
        ),
        chain(
            6,
            "Base Sepolia",
            "eip155:84532",
            84532,
            "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "ETH",
        ),
        chain(
            3,
            "Arbitrum Sepolia",
            "eip155:421614",
            421614,
            "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
            "ETH",
        ),
    ],
    domains: &[
        evm(INJECTIVE_DOMAIN, "Injective Testnet", false),
        // Circle's sandbox forwards there (Iris quoted a forwarding fee, 2026-11-10).
        Domain {
            id: SOLANA_DOMAIN,
            name: "Solana Devnet",
            kind: AddressKind::Solana,
            forwarding: true,
        },
        evm(0, "Sepolia", true),
        evm(6, "Base Sepolia", true),
        evm(3, "Arbitrum Sepolia", true),
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

    /// Native USDC on Injective.
    pub fn usdc(&self) -> EthAddress {
        pinned(self.usdc)
    }

    /// A chain the wallet names, by domain.
    pub fn domain(&self, id: u32) -> Option<&'static Domain> {
        self.domains.iter().find(|d| d.id == id)
    }

    /// Where a burn that starts on domain `from` may go: any chain the wallet names but that
    /// one.
    pub fn destination(&self, from: u32, id: u32) -> Option<&'static Domain> {
        (id != from).then(|| self.domain(id)).flatten()
    }

    /// `MessageTransmitterV2`.
    pub fn message_transmitter(&self) -> EthAddress {
        pinned(self.message_transmitter)
    }

    /// Choice's `BridgeReceiver`, where there is one.
    pub fn bridge_receiver(&self) -> Option<EthAddress> {
        self.bridge_receiver.map(pinned)
    }

    /// The EVM chain with this EIP-155 chain ID.
    pub fn evm_chain(&self, chain_id: u64) -> Option<&'static EvmChain> {
        self.evm.iter().find(|s| s.chain_id == chain_id)
    }

    /// The EVM chain with this CCTP domain.
    pub fn evm_domain(&self, domain: u32) -> Option<&'static EvmChain> {
        self.evm.iter().find(|s| s.domain == domain)
    }

    /// Where a transfer comes from, as the wallet names it: the chain, the sender its message
    /// must carry (TokenMessengerV2 on an EVM chain, Circle's program on Solana), and the USDC
    /// it burned there.
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
        let s = self.evm_domain(domain)?;
        Some(Inbound {
            name: s.name,
            sender: word(&self.token_messenger()),
            burn_token: word(&s.usdc()),
        })
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
/// the network's `TokenMessengerV2` (at one address on each of its EVM chains).
pub fn burn(cctp: &Cctp, to: &EthAddress, value: U256, data: &[u8]) -> Option<Result<Burn, CctpError>> {
    (*to == cctp.token_messenger()).then(|| read_burn(value, data))
}

fn read_burn(value: U256, data: &[u8]) -> Result<Burn, CctpError> {
    let bad = |_| CctpError("the burn isn't canonically encoded");
    if !value.is_zero() {
        return Err(CctpError("a burn sends no coin"));
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

/// Who completes a burn on its destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Circle's Forwarding Service mints it there, for a fee within `maxFee`.
    Circle,
    /// Anyone may mint it there, with gas there: on Injective mainnet Choice's bridge
    /// service does, and the wallet can.
    Anyone,
    /// Choice's `BridgeReceiver` on Injective mints it, and buys INJ for gas with at most
    /// this much USDC.
    GasDrop {
        /// The most the INJ may cost, in USDC base units.
        max_drop_fee: U256,
    },
}

/// A burn the wallet makes from an EVM chain, as [`transfer`] read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transfer {
    /// The burn as its calldata says.
    pub burn: Burn,
    /// Where it goes.
    pub destination: &'static Domain,
    /// Who ends up with it: the hook's recipient for a gas drop, otherwise the mint
    /// recipient.
    pub recipient: Recipient,
    /// Who mints it there.
    pub delivery: Delivery,
}

impl Transfer {
    /// The least that arrives: the amount less Circle's most and any gas drop's.
    pub fn least(&self) -> U256 {
        let drop = match self.delivery {
            Delivery::GasDrop { max_drop_fee } => max_drop_fee,
            Delivery::Circle | Delivery::Anyone => U256::ZERO,
        };
        self.burn
            .amount
            .checked_sub(&self.burn.max_fee)
            .and_then(|v| v.checked_sub(&drop))
            .unwrap_or(U256::ZERO)
    }
}

/// Read a burn made on `local` as a transfer the wallet would make: of that chain's USDC, to
/// another chain the wallet names, at an address that chain can use, that someone is set to
/// deliver (Circle where it forwards; anyone, with gas, on an EVM chain; Choice's
/// `BridgeReceiver` for a gas drop on Injective), with a known finality and every fee below
/// the amount. Anything else is refused, with why.
pub fn transfer(cctp: &Cctp, local: &EvmChain, b: Burn) -> Result<Transfer, CctpError> {
    if b.burn_token != local.usdc() {
        return Err(CctpError("it burns a token other than USDC"));
    }
    let destination = cctp
        .destination(local.domain, b.domain)
        .ok_or(CctpError("it goes to a chain the wallet doesn't name"))?;
    if b.min_finality != FAST && b.min_finality != STANDARD {
        return Err(CctpError("an unknown finality threshold"));
    }
    let (recipient, delivery) = match &b.hook {
        Hook::GasDrop {
            recipient,
            max_drop_fee,
        } => {
            let through_choice = cctp.bridge_receiver().is_some_and(|r| {
                destination.id == INJECTIVE_DOMAIN && b.mint_recipient == word(&r) && b.destination_caller == word(&r)
            });
            if !through_choice {
                return Err(CctpError(
                    "it asks for INJ for gas, but not through Choice's bridge contract",
                ));
            }
            (
                Some(Recipient::Evm(*recipient)),
                Delivery::GasDrop {
                    max_drop_fee: *max_drop_fee,
                },
            )
        }
        _ if !b.permissionless() => return Err(CctpError("only one address may deliver it")),
        Hook::Forward | Hook::ForwardWithAccount { .. } if !destination.forwarding => {
            return Err(CctpError("Circle doesn't deliver on that chain"));
        }
        Hook::ForwardWithAccount { .. } if destination.kind != AddressKind::Solana => {
            return Err(CctpError("it asks Circle to open a Solana account elsewhere"));
        }
        Hook::Forward | Hook::ForwardWithAccount { .. } => (b.recipient(cctp), Delivery::Circle),
        Hook::None if destination.kind == AddressKind::Evm => (b.recipient(cctp), Delivery::Anyone),
        Hook::None => return Err(CctpError("nobody would deliver it on Solana")),
        Hook::Other(_) => return Err(CctpError("it carries instructions for a contract there")),
    };
    let recipient = recipient.ok_or(CctpError("the recipient isn't an address on that chain"))?;
    let drop = match delivery {
        Delivery::GasDrop { max_drop_fee } => max_drop_fee,
        Delivery::Circle | Delivery::Anyone => U256::ZERO,
    };
    if b.max_fee.checked_add(&drop).is_none_or(|f| f >= b.amount) {
        return Err(CctpError("its fees could take all of it"));
    }
    Ok(Transfer {
        burn: b,
        destination,
        recipient,
        delivery,
    })
}
/// `receiveMessage(bytes,bytes)`: mints an attested transfer on its destination.
pub const RECEIVE_MESSAGE: [u8; 4] = 0x57ecfd28u32.to_be_bytes();

/// A transfer being minted on its destination, as its attested message says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receive {
    /// Where it was burned.
    pub source_domain: u32,
    /// Where it is minted: the chain's own domain for a message it accepts.
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

/// Read calldata sent to `to` as `receiveMessage`: `None` if `to` isn't the network's
/// `MessageTransmitterV2` (at one address on each of its EVM chains).
pub fn receive(cctp: &Cctp, to: &EthAddress, value: U256, data: &[u8]) -> Option<Result<Receive, CctpError>> {
    (*to == cctp.message_transmitter()).then(|| read_receive(value, data))
}

fn read_receive(value: U256, data: &[u8]) -> Result<Receive, CctpError> {
    if !value.is_zero() {
        return Err(CctpError("a mint sends no coin"));
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
            assert_eq!(c.domain(INJECTIVE_DOMAIN).unwrap().kind, AddressKind::Evm);
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
            Some(Err(CctpError("a burn sends no coin")))
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
    const FROM_BASE: &str = "0x8e0250ee00000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000001d0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bb800000000000000000000000000000000000000000000000000000000000003e8";
    const FROM_BASE_WITH_DROP: &str = "0x779b432d00000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000001d000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb218cd4a000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb218cd4a0000000000000000000000000000000000000000000000000000000000000bb800000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000006049554231000000000000000000000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000007a120";

    fn me() -> EthAddress {
        EthAddress::parse_hex("0x1111111111111111111111111111111111111111").unwrap()
    }

    #[test]
    fn every_evm_chain_is_named_once_and_parses() {
        for c in [MAINNET, TESTNET] {
            let _ = (c.message_transmitter(), c.bridge_receiver());
            assert_eq!(c.evm[0].domain, INJECTIVE_DOMAIN);
            assert_eq!(c.evm[0].usdc(), c.usdc());
            for s in c.evm {
                let _ = s.usdc();
                assert_eq!(s.caip2, format!("eip155:{}", s.chain_id));
                assert_eq!(c.evm_chain(s.chain_id), Some(s));
                assert_eq!(c.evm_domain(s.domain), Some(s));
                let d = c.domain(s.domain).expect("every EVM chain is a domain");
                assert_eq!((d.name, d.kind), (s.name, AddressKind::Evm));
                assert!(c.inbound(s.domain).is_some());
            }
            assert_eq!(c.domains.len(), c.evm.len() + 1, "the EVM chains and Solana");
            assert_eq!(c.domain(SOLANA_DOMAIN).unwrap().kind, AddressKind::Solana);
            assert!(c.destination(SOLANA_DOMAIN, SOLANA_DOMAIN).is_none());
            assert!(c.destination(6, INJECTIVE_DOMAIN).is_some());
        }
        assert_eq!(MAINNET.evm_chain(8453).unwrap().name, "Base");
        assert_eq!(MAINNET.evm_chain(5042).unwrap().native, ("USDC", 18));
        assert!(!MAINNET.domain(INJECTIVE_DOMAIN).unwrap().forwarding);
        assert!(!MAINNET.domain(33).unwrap().forwarding);
    }

    fn base() -> &'static EvmChain {
        MAINNET.evm_chain(8453).unwrap()
    }

    fn read(data: &str) -> Burn {
        burn(&MAINNET, &MAINNET.token_messenger(), U256::ZERO, &h(data))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn reads_transfers_the_wallet_makes_from_any_chain() {
        // Base → Injective, plain: anyone mints it there.
        let t = transfer(&MAINNET, base(), read(FROM_BASE)).unwrap();
        assert_eq!((t.destination.id, t.delivery), (INJECTIVE_DOMAIN, Delivery::Anyone));
        assert_eq!(t.recipient, Recipient::Evm(me()));
        assert_eq!(t.least(), U256::from_u128(24_997_000));
        // Through BridgeReceiver, with a gas drop for 0x1111…: it pays the hook's recipient.
        let t = transfer(&MAINNET, base(), read(FROM_BASE_WITH_DROP)).unwrap();
        assert_eq!(
            t.delivery,
            Delivery::GasDrop {
                max_drop_fee: U256::from_u128(500_000)
            }
        );
        assert_eq!(t.recipient, Recipient::Evm(me()));
        assert_eq!(t.least(), U256::from_u128(24_497_000));
        // Injective → Base, forwarded.
        let t = transfer(&MAINNET, &MAINNET.evm[0], read(TO_BASE)).unwrap();
        assert_eq!((t.destination.name, t.delivery), ("Base", Delivery::Circle));
        // Base → Arbitrum, forwarded; and to Solana, with the account opened.
        let mut b = read(TO_BASE);
        b.burn_token = base().usdc();
        b.domain = 3;
        assert_eq!(
            transfer(&MAINNET, base(), b.clone()).unwrap().delivery,
            Delivery::Circle
        );
        b.domain = SOLANA_DOMAIN;
        b.mint_recipient = [7; 32];
        b.hook = Hook::ForwardWithAccount { owner: [9; 32] };
        assert_eq!(
            transfer(&MAINNET, base(), b).unwrap().recipient,
            Recipient::Solana([7; 32])
        );
        // Circle doesn't deliver on Plasma: only a plain burn, which the wallet mints itself.
        let mut b = read(TO_BASE);
        b.burn_token = base().usdc();
        b.domain = 33;
        assert!(transfer(&MAINNET, base(), b.clone()).is_err());
        b.hook = Hook::None;
        assert_eq!(transfer(&MAINNET, base(), b).unwrap().delivery, Delivery::Anyone);
    }

    #[test]
    fn refuses_transfers_the_wallet_wouldnt_make() {
        let them = EthAddress::parse_hex("0x2222222222222222222222222222222222222222").unwrap();
        let plain = read(FROM_BASE);
        let refused = |local: &EvmChain, b: &Burn| transfer(&MAINNET, local, b.clone()).unwrap_err().0;
        // The wrong chain's USDC.
        assert_eq!(
            refused(MAINNET.evm_chain(42161).unwrap(), &plain),
            "it burns a token other than USDC"
        );
        // To its own chain, or to a chain nobody names.
        let mut b = plain.clone();
        b.domain = 6;
        assert!(refused(base(), &b).contains("doesn't name"));
        b.domain = 12345;
        assert!(refused(base(), &b).contains("doesn't name"));
        // Pinned to a caller; forwarded where Circle doesn't deliver; some contract's hook;
        // eaten by fees; an odd finality.
        let mut b = plain.clone();
        b.destination_caller = word(&them);
        assert_eq!(refused(base(), &b), "only one address may deliver it");
        let mut b = plain.clone();
        b.hook = Hook::Forward;
        assert_eq!(refused(base(), &b), "Circle doesn't deliver on that chain");
        let mut b = plain.clone();
        b.hook = Hook::Other(vec![1]);
        assert!(refused(base(), &b).contains("instructions"));
        let mut b = plain.clone();
        b.max_fee = b.amount;
        assert_eq!(refused(base(), &b), "its fees could take all of it");
        let mut b = plain.clone();
        b.min_finality = 500;
        assert_eq!(refused(base(), &b), "an unknown finality threshold");
        // Plain to Solana: nobody delivers it there. An account opened on an EVM chain.
        let mut b = plain.clone();
        b.domain = SOLANA_DOMAIN;
        assert!(refused(base(), &b).contains("Solana"));
        let mut b = plain.clone();
        b.domain = 3;
        b.hook = Hook::ForwardWithAccount { owner: [9; 32] };
        assert!(refused(base(), &b).contains("Solana account"));
        // A recipient no EVM chain can use.
        let mut b = plain.clone();
        b.mint_recipient = [7; 32];
        assert!(refused(base(), &b).contains("isn't an address"));
        // A gas drop through some other contract, or to another chain, or whose fees
        // together take it all.
        let receiver = MAINNET.bridge_receiver().unwrap();
        let mut b = plain.clone();
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(1),
        };
        b.mint_recipient = word(&them);
        b.destination_caller = word(&them);
        assert!(refused(base(), &b).contains("Choice's bridge contract"));
        b.mint_recipient = word(&receiver);
        b.destination_caller = word(&receiver);
        assert!(transfer(&MAINNET, base(), b.clone()).is_ok());
        let mut far = b.clone();
        far.domain = 3;
        assert!(refused(base(), &far).contains("Choice's bridge contract"));
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(25_000_000 - 3_000),
        };
        assert_eq!(refused(base(), &b), "its fees could take all of it");
        // Testnet has no BridgeReceiver.
        let sepolia = TESTNET.evm_chain(84532).unwrap();
        let mut b = plain;
        b.burn_token = sepolia.usdc();
        assert!(transfer(&TESTNET, sepolia, b.clone()).is_ok());
        b.hook = Hook::GasDrop {
            recipient: me(),
            max_drop_fee: U256::from_u128(1),
        };
        assert!(transfer(&TESTNET, sepolia, b).is_err());
    }

    /// A message as MessageTransmitterV2 lays it out: 25 USDC burned on Base for 0x1111…1111,
    /// with 0.0025 kept by Circle.
    fn message() -> Vec<u8> {
        let base = MAINNET.evm_chain(8453).unwrap();
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
        assert_eq!(r.burn_token, word(&MAINNET.evm_chain(8453).unwrap().usdc()));
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
