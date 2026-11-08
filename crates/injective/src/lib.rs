//! Injective transactions for Choice Wallet.
//!
//! - [`proto`]: protobuf types generated from vendored `.proto` files (see `proto/SOURCES.md`).
//! - [`direct`]: the SIGN_MODE_DIRECT path. A request is decoded and checked first; only a
//!   decoded request can be signed.
//! - [`msg`]: the messages the wallet understands, decoded from a transaction.
//! - [`builder`]: the wallet's own transactions: bank sends, CW20 transfers, and CW20 ⇄ bank
//!   conversions through the CW20 adapter.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod builder;
mod canonical;
pub mod chain;
pub mod cosmwasm;
pub mod direct;
mod error;
pub mod msg;
#[allow(missing_docs, clippy::all, clippy::pedantic, rustdoc::all)]
#[rustfmt::skip]
pub mod proto;
pub mod wkt;

pub use error::Error;
