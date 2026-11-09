//! Injective for Choice Wallet. The Cosmos side runs on `choice-wallet-cosmos` with the
//! profiles in [`chain`]; this crate adds what only Injective has.
//!
//! - [`chain`]: mainnet and testnet, their Cosmos profiles and EVM chain IDs.
//! - [`adapter`]: CW20 ⇄ bank conversions through the CW20 adapter.
//! - [`eip712`]: Cosmos transactions signed as EIP-712 v2 typed data by EVM wallets.
//! - [`choice`]: swaps through Choice's aggregator and router on the EVM side, read from
//!   their calldata, and the contracts pinned per network.
//!
//! How each kind of token moves:
//!
//! | Token | Send with |
//! | --- | --- |
//! | Bank denom (`inj`, `peggy…`, `ibc/…`, `factory/…`, bank-backed `erc20:0x…`) | `choice_wallet_cosmos::builder::bank_send` |
//! | CW20 | `choice_wallet_cosmos::builder::cw20_transfer` |
//! | CW20 → its adapter bank denom | [`adapter::cw20_to_bank`] |
//! | Adapter bank denom → CW20 | [`adapter::bank_to_cw20`] |
//! | Pure ERC20 (balance in contract storage), native INJ on EVM | `choice_wallet_evm` |
//!
//! A bank denom with an ERC20 token pair is the same balance as that ERC20, so converting
//! a CW20 to bank also makes it usable as an ERC20 wherever its adapter denom has a pair.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod adapter;
pub mod chain;
pub mod choice;
pub mod eip712;

pub use choice_wallet_cosmos::Error;
