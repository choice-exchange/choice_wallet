use thiserror::Error;

/// Errors from building or signing EVM transactions. No variant carries secret material.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Error {
    /// Not a canonical decimal integer below 2^256.
    #[error("invalid amount {0:?}")]
    Amount(String),
    /// A zero amount where something must move.
    #[error("amount must be more than zero")]
    ZeroAmount,
    /// Contract creation (no `to`) isn't supported.
    #[error("contract creation is not supported")]
    NoRecipient,
    /// `max_priority_fee_per_gas` is above `max_fee_per_gas`.
    #[error("priority fee is above the max fee")]
    PriorityFee,
    /// The signature's recovery ID can't be expressed as an EIP-1559 y-parity.
    #[error("unexpected signature recovery id")]
    RecoveryId,
    /// Not a JSON-RPC quantity (`0x` + hex, no leading zeros), or out of range.
    #[error("invalid quantity {0:?}")]
    Quantity(String),
    /// The request names a different chain than the connected one.
    #[error("wrong chain: expected {expected}, got {got}")]
    WrongChain {
        /// The connected chain.
        expected: u64,
        /// The chain the request names.
        got: u64,
    },
    /// A transaction request the wallet won't sign, and why.
    #[error("transaction request refused: {0}")]
    Request(String),
}
