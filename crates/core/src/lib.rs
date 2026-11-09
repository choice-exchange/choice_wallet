//! Choice Wallet core: mnemonics, HD derivation, secp256k1 and ed25519 (Solana) keys,
//! addresses and the encrypted keystore.
//!
//! Rules for this crate are in `docs/SECURITY.md`. In short: no unsafe code,
//! secrets are wiped on drop, and secrets never reach logs, errors or `Debug`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod address;
pub mod base58;
pub mod ed25519;
pub mod envelope;
mod error;
pub mod hd;
pub mod hexutil;
pub mod keystore;
pub mod mnemonic;
mod random;
pub mod secp256k1;

pub use address::EthAddress;
pub use error::Error;
pub use mnemonic::Mnemonic;
pub use secp256k1::{PrivateKey, PublicKey};
