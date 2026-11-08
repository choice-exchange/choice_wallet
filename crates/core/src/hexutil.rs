//! Minimal hex helpers, so the vault doesn't need another dependency.

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn nibble(c: u8) -> Result<u8, ()> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(()),
    }
}

/// Decode exactly `out.len()` bytes of hex (either case) into `out`.
pub(crate) fn decode_into(s: &str, out: &mut [u8]) -> Result<(), ()> {
    let s = s.as_bytes();
    if s.len() != out.len() * 2 {
        return Err(());
    }
    let (pairs, _) = s.as_chunks::<2>();
    for (o, [hi, lo]) in out.iter_mut().zip(pairs) {
        *o = (nibble(*hi)? << 4) | nibble(*lo)?;
    }
    Ok(())
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
    }
}
