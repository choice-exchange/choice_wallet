//! Errors: a stable code and a message.

use serde::Serialize;

/// A failed call: a stable `code` for the UI to branch on and a human `message`. Messages
/// come from the decoders' errors, which never carry secret material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultError {
    /// One of the `code` constants in this module.
    pub code: &'static str,
    /// What went wrong.
    pub message: String,
}

/// The request isn't valid JSON for the method, or a field is malformed.
pub const BAD_REQUEST: &str = "bad_request";
/// No such method.
pub const UNKNOWN_METHOD: &str = "unknown_method";
/// The chain ID isn't one the wallet knows.
pub const UNKNOWN_CHAIN: &str = "unknown_chain";
/// Wrong password, or the keystore or unlock key is damaged or belongs to another keystore.
pub const WRONG_PASSWORD: &str = "wrong_password";
/// The keystore is malformed or the account doesn't fit it.
pub const KEYSTORE: &str = "keystore";
/// The request failed its checks: wrong chain, wrong signer, non-canonical bytes, …
pub const INVALID: &str = "invalid";
/// The account's key isn't the request's signer.
pub const WRONG_ACCOUNT: &str = "wrong_account";
/// The request isn't the one that was approved.
pub const NOT_APPROVED: &str = "not_approved";

impl VaultError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn bad(message: impl Into<String>) -> Self {
        Self::new(BAD_REQUEST, message)
    }
}

impl From<choice_wallet_cosmos::Error> for VaultError {
    fn from(e: choice_wallet_cosmos::Error) -> Self {
        use choice_wallet_cosmos::Error as E;
        let code = match e {
            E::KeyMismatch | E::WrongSigner => WRONG_ACCOUNT,
            _ => INVALID,
        };
        Self::new(code, e.to_string())
    }
}

impl From<choice_wallet_evm::Error> for VaultError {
    fn from(e: choice_wallet_evm::Error) -> Self {
        Self::new(INVALID, e.to_string())
    }
}

impl From<choice_wallet_evm::eip712::TypedDataError> for VaultError {
    fn from(e: choice_wallet_evm::eip712::TypedDataError) -> Self {
        Self::new(INVALID, e.to_string())
    }
}

impl From<choice_wallet_core::Error> for VaultError {
    fn from(e: choice_wallet_core::Error) -> Self {
        use choice_wallet_core::Error as E;
        let code = match e {
            E::Decrypt => WRONG_PASSWORD,
            E::Keystore(_) | E::InvalidMnemonic | E::InvalidPrivateKey | E::WordCount(_) => KEYSTORE,
            _ => BAD_REQUEST,
        };
        Self::new(code, e.to_string())
    }
}
