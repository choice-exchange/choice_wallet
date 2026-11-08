//! `personal_sign`: EIP-191 version `0x45` signed messages.
//!
//! The signed hash is keccak256 of `"\x19Ethereum Signed Message:\n" || len(message) ||
//! message`, the length in decimal. The prefix keeps a signed message from ever being a
//! valid transaction, but a dapp can still pass a 32-byte hash as the "message"; the risk
//! rules flag that.

use choice_wallet_core::PrivateKey;
use choice_wallet_core::secp256k1::keccak256;

/// The hash `personal_sign` signs.
pub fn hash(message: &[u8]) -> [u8; 32] {
    let mut buf = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    buf.extend_from_slice(message);
    keccak256(&buf)
}

/// Sign as `personal_sign` does: 65 bytes `r || s || v`, with v = 27 or 28.
pub fn sign(message: &[u8], key: &PrivateKey) -> [u8; 65] {
    let (sig, recid) = key.sign_prehash(&hash(message));
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig);
    out[64] = 27 + (recid & 1);
    out
}
