//! Minimal hex helpers, so the vault doesn't need another dependency. Lowercase out; either
//! case in.

use crate::Error;

const DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Lowercase hex, no prefix.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn nibble(c: u8) -> Result<u8, Error> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(Error::InvalidHex),
    }
}

/// Decode exactly `out.len()` bytes of hex (either case) into `out`.
pub fn decode_into(s: &str, out: &mut [u8]) -> Result<(), Error> {
    let s = s.as_bytes();
    if s.len() != out.len() * 2 {
        return Err(Error::InvalidHex);
    }
    let (pairs, _) = s.as_chunks::<2>();
    for (o, [hi, lo]) in out.iter_mut().zip(pairs) {
        *o = (nibble(*hi)? << 4) | nibble(*lo)?;
    }
    Ok(())
}

/// Decode hex of any even length (either case, no prefix).
pub fn decode(s: &str) -> Result<Vec<u8>, Error> {
    if !s.len().is_multiple_of(2) {
        return Err(Error::InvalidHex);
    }
    let mut out = vec![0; s.len() / 2];
    decode_into(s, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let bytes = [0x00, 0x01, 0xab, 0xff];
        assert_eq!(encode(&bytes), "0001abff");
        let mut out = [0u8; 4];
        decode_into("0001ABff", &mut out).unwrap();
        assert_eq!(out, bytes);
        assert!(decode_into("0001abf", &mut out).is_err());
        assert!(decode_into("0001abfg", &mut out).is_err());
        assert_eq!(decode("0001abFF").unwrap(), bytes);
        assert_eq!(decode("").unwrap(), Vec::<u8>::new());
        assert!(decode("abc").is_err());
    }
}
