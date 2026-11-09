//! EVM transactions for Choice Wallet.
//!
//! - [`Eip1559Tx`]: type-2 transactions, the wallet's own sends. Encoded with a small RLP
//!   writer ([`rlp`]) and signed with the core secp256k1 key.
//! - [`erc20`]: `transfer(address,uint256)` calldata, built and recognised.
//! - [`abi`]: a strict ABI decoder that refuses all but the canonical encoding.
//! - [`request`]: `eth_sendTransaction` requests, parsed strictly into an [`Eip1559Tx`].
//! - [`eip712`]: typed data for `eth_signTypedData_v4`, parsed strictly, hashed and signed.
//! - [`personal`]: `personal_sign` (EIP-191) messages.
//! - [`U256`]: 256-bit amounts, from canonical decimal strings or JSON-RPC quantities.
//!
//! On Injective EVM (chain ID 1776, testnet 1439) the native coin is INJ, the same balance
//! as the bank `inj` denom. Pure ERC20 tokens, which keep balances in their own storage,
//! move only through these transactions.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod abi;
pub mod eip712;
pub mod erc20;
mod error;
pub mod personal;
pub mod request;
pub mod rlp;
mod tx;
mod u256;

pub use error::Error;
pub use tx::{Eip1559Tx, SignedTx};
pub use u256::U256;
