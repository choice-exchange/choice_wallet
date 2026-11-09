//! ADR-036 arbitrary messages (`signArbitrary`, `verifyArbitrary`): signing data that is not
//! a transaction.
//!
//! The signer signs a fixed amino sign doc that wraps the data in a `sign/MsgSignData`
//! message, with an empty chain ID, account number and sequence 0, no fee and no memo. Keys
//! are sorted, as every wallet writes it:
//!
//! ```text
//! {"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"",
//!  "msgs":[{"type":"sign/MsgSignData","value":{"data":"<base64>","signer":"<bech32>"}}],
//!  "sequence":"0"}
//! ```
//!
//! Its empty chain ID and zero fee make it useless as a transaction on any chain. The vault
//! builds the doc itself from the data, so a site can't pass off anything else as one.

use choice_wallet_core::{PrivateKey, PublicKey};

use crate::Error;
use crate::chain::Chain;

/// The largest message signed, in bytes.
pub const MAX_DATA: usize = 64 * 1024;

/// A checked ADR-036 request: the data, its signer and the sign doc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Arbitrary {
    data: Vec<u8>,
    signer: [u8; 33],
    address: String,
    chain: Chain,
    doc: Vec<u8>,
}

/// Standard base64 with padding, as amino JSON writes bytes.
fn base64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(A[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

impl Arbitrary {
    /// `data` to be signed by `signer` on `chain`.
    pub fn new(chain: &Chain, signer: &PublicKey, data: Vec<u8>) -> Result<Self, Error> {
        if data.len() > MAX_DATA {
            return Err(Error::Arbitrary(format!("the message is over {MAX_DATA} bytes")));
        }
        let address = chain.address(signer);
        // Every value here is base64 or bech32: nothing to escape.
        let doc = format!(
            r#"{{"account_number":"0","chain_id":"","fee":{{"amount":[],"gas":"0"}},"memo":"","msgs":[{{"type":"sign/MsgSignData","value":{{"data":"{}","signer":"{}"}}}}],"sequence":"0"}}"#,
            base64(&data),
            address
        );
        Ok(Self {
            data,
            signer: signer.compressed(),
            address,
            chain: *chain,
            doc: doc.into_bytes(),
        })
    }

    /// The data, as the site gave it.
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// The signer's address on the chain.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The signer's compressed public key.
    pub fn signer(&self) -> &[u8; 33] {
        &self.signer
    }

    /// The bytes that get signed: the sign doc.
    pub fn sign_bytes(&self) -> &[u8] {
        &self.doc
    }

    /// Sign with a software key, as the chain's key type signs: 64 bytes `r || s`.
    pub fn sign(&self, key: &PrivateKey) -> Result<[u8; 64], Error> {
        if key.public_key().compressed() != self.signer {
            return Err(Error::KeyMismatch);
        }
        Ok(self.chain.sign(key, &self.doc))
    }

    /// A signature made elsewhere (a hardware wallet, or the one a site asks the wallet to
    /// verify), made low-S; `None` unless the signer's key made it over this doc.
    pub fn check_signature(&self, signature: &[u8; 64]) -> Option<[u8; 64]> {
        let pk = PublicKey::from_sec1_bytes(&self.signer).ok()?;
        self.chain.check_device(&pk, &self.doc, signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        // RFC 4648's test vectors.
        for (raw, enc) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(raw.as_bytes()), enc);
        }
    }
}
