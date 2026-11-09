use thiserror::Error;

/// Everything that can go wrong decoding, checking, building or signing a Cosmos
/// transaction. No variant carries secret material.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Error {
    /// The bytes aren't a valid encoding of the named message.
    #[error("could not decode {0}")]
    Decode(&'static str),
    /// The bytes decode, but don't re-encode to the same bytes: unknown fields, duplicate
    /// fields, fields out of order or non-minimal encodings. Such requests are refused,
    /// because what we would show might not be what the chain reads.
    #[error("{0} is not canonically encoded")]
    NonCanonical(&'static str),
    /// The request is for a different chain than the connected one.
    #[error("wrong chain: expected {expected}, got {got}")]
    WrongChain {
        /// The connected chain.
        expected: String,
        /// The chain the request names.
        got: String,
    },
    /// An ADR-036 message the wallet won't sign.
    #[error("{0}")]
    Arbitrary(String),
    /// The transaction has no messages.
    #[error("transaction has no messages")]
    NoMessages,
    /// Only single-signer transactions are supported.
    #[error("exactly one signer is supported")]
    SignerCount,
    /// The signer public key in the request isn't this account's.
    #[error("the signer key is not this account's key")]
    WrongSigner,
    /// The signer public key isn't the chain's key type.
    #[error("unsupported public key type {0}")]
    PubKeyType(String),
    /// The sign mode doesn't match this sign path.
    #[error("unsupported sign mode")]
    SignMode,
    /// Extension options aren't allowed on this sign path.
    #[error("extension options are not allowed on this sign path")]
    ExtensionOptions,
    /// The deprecated tip field is set.
    #[error("tips are not supported")]
    Tip,
    /// The transaction has no fee.
    #[error("fee is missing")]
    MissingFee,
    /// Someone other than the signer pays the fee, which would need a second signature.
    #[error("the fee payer must be the signer")]
    FeePayer,
    /// A message names a different account as its signer.
    #[error("message signer {0} is not this account")]
    ForeignSigner(String),
    /// Not a canonical, positive integer amount.
    #[error("invalid amount {0:?}")]
    Amount(String),
    /// Not a valid Cosmos SDK denom.
    #[error("invalid denom {0:?}")]
    Denom(String),
    /// Not a valid address on this chain.
    #[error("invalid address {0:?}")]
    Address(String),
    /// A CosmWasm message that isn't UTF-8 JSON.
    #[error("contract message is not valid JSON")]
    ContractJson,
    /// The key doesn't belong to the request's signer.
    #[error("this key does not match the request's signer")]
    KeyMismatch,
    /// An amino JSON sign doc that isn't shaped as the chain would render it.
    #[error("invalid amino JSON: {0}")]
    Amino(String),
    /// A message in a JSON sign path that isn't shaped like one.
    #[error("invalid message JSON: {0}")]
    Json(String),
    /// Typed data claims to be a Cosmos transaction but isn't shaped like one.
    #[error("not a valid EIP-712 Cosmos transaction: {0}")]
    Eip712(String),
}
