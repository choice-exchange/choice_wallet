//! Cosmos SDK transactions for Choice Wallet, for any chain described by a [`chain::Chain`]
//! profile. Chain crates (`choice-wallet-injective`, later others) supply the profile and
//! whatever is specific to them.
//!
//! - [`proto`]: protobuf types generated from vendored `.proto` files (see `proto/SOURCES.md`).
//!   They are the Cosmos SDK v0.50 set; chains on v0.53 will get their own set.
//! - [`direct`]: the SIGN_MODE_DIRECT path. A request is decoded and checked first; only a
//!   decoded request can be signed.
//! - [`amino`]: the LEGACY_AMINO_JSON path, for Ledger's Cosmos app and dapps' `signAmino`.
//! - [`msg`]: the messages the wallet understands, decoded from a transaction.
//! - [`cosmwasm`]: CW20 and CW20 adapter contract messages.
//! - [`builder`]: the wallet's own transactions: bank sends and CW20 transfers.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod amino;
pub mod builder;
mod canonical;
pub mod chain;
pub mod cosmwasm;
pub mod direct;
mod error;
mod json;
pub mod msg;
#[allow(missing_docs, clippy::all, clippy::pedantic, rustdoc::all)]
#[rustfmt::skip]
pub mod proto;
pub mod staking;
pub mod wkt;

pub use error::Error;
