/// Errors from the core crate.
///
/// No variant carries secret material, and decrypt failures are deliberately
/// one variant so callers can't tell a wrong password from corrupted data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The phrase is not a valid English BIP-39 mnemonic.
    #[error("invalid recovery phrase")]
    InvalidMnemonic,
    /// Only 12 and 24 word phrases are generated.
    #[error("unsupported word count {0}: use 12 or 24")]
    WordCount(usize),
    /// The derivation path string could not be parsed.
    #[error("invalid derivation path")]
    InvalidPath,
    /// BIP-32 derivation failed (astronomically unlikely invalid child key).
    #[error("key derivation failed")]
    Derivation,
    /// The bytes are not a valid secp256k1 private key.
    #[error("invalid private key")]
    InvalidPrivateKey,
    /// The bytes are not a valid secp256k1 public key.
    #[error("invalid public key")]
    InvalidPublicKey,
    /// Not valid hex of the expected length.
    #[error("invalid hex")]
    InvalidHex,
    /// The address string is malformed, has a bad checksum or a wrong prefix.
    #[error("invalid address")]
    InvalidAddress,
    /// Signing failed.
    #[error("signing failed")]
    Signing,
    /// The keystore blob is malformed or uses unsupported parameters.
    #[error("keystore: {0}")]
    Keystore(&'static str),
    /// Wrong password, or the keystore was changed or corrupted.
    #[error("wrong password or damaged keystore")]
    Decrypt,
    /// The operating system's random number generator failed.
    #[error("system randomness unavailable")]
    Randomness,
}
