//! Small serde helpers for the protocol's encodings.

use choice_wallet_core::hexutil;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;

use crate::error::VaultError;

/// A `u64` given as a JSON number or a canonical decimal string. JavaScript loses
/// precision above 2^53, so hosts may send strings; outputs always use strings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct U64(pub u64);

impl<'de> Deserialize<'de> for U64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Num(u64),
            Str(String),
        }
        match Either::deserialize(d)? {
            Either::Num(n) => Ok(Self(n)),
            Either::Str(s) => parse_u64(&s).map(Self).map_err(serde::de::Error::custom),
        }
    }
}

/// A canonical decimal `u64`: digits only, no leading zeros.
pub(crate) fn parse_u64(s: &str) -> Result<u64, String> {
    let canonical = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    s.parse()
        .ok()
        .filter(|_| canonical)
        .ok_or_else(|| format!("not a canonical integer: {s:?}"))
}

/// Hex without a prefix, either case.
pub(crate) fn hex(s: &str, what: &str) -> Result<Vec<u8>, VaultError> {
    hexutil::decode(s).map_err(|_| VaultError::bad(format!("{what} is not hex")))
}

/// Embedded JSON given either as an object or as a string holding it (`eth_signTypedData_v4`
/// passes a string). Returns the JSON text.
pub(crate) fn json_text(raw: &RawValue) -> Result<String, VaultError> {
    let text = raw.get();
    if text.starts_with('"') {
        serde_json::from_str::<String>(text).map_err(|e| VaultError::bad(e.to_string()))
    } else {
        Ok(text.to_owned())
    }
}
