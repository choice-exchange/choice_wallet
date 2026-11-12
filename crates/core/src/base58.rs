//! Base58 in Bitcoin's alphabet, as Solana spells accounts, keys and signatures.

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Encode bytes. Each leading zero byte becomes a leading `1`.
pub fn encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    // Base-58 digits, least significant first.
    let mut digits: Vec<u8> = Vec::new();
    for &b in &bytes[zeros..] {
        let mut carry = u32::from(b);
        for d in &mut digits {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat_n('1', zeros));
    out.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize] as char));
    out
}

/// Decode a base58 string; `None` for any character outside the alphabet (no whitespace).
pub fn decode(s: &str) -> Option<Vec<u8>> {
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    // Bytes, least significant first.
    let mut bytes: Vec<u8> = Vec::new();
    for c in s.bytes().skip(zeros) {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for b in &mut bytes {
            carry += u32::from(*b) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

/// The longest base58 form of 32 bytes.
const MAX_32: usize = 44;

/// Decode exactly 32 bytes: a Solana account or public key. A longer string is refused before
/// decoding: [`decode`] costs the square of its input's length.
pub fn decode32(s: &str) -> Option<[u8; 32]> {
    if s.len() > MAX_32 {
        return None;
    }
    decode(s)?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values_round_trip() {
        for (bytes, text) in [
            (&b""[..], ""),
            (&[0, 0, 1][..], "112"),
            (&b"hello world"[..], "StV1DL6CwTryKyV"),
            (&[0u8; 32][..], "11111111111111111111111111111111"),
        ] {
            assert_eq!(encode(bytes), text);
            assert_eq!(decode(text).unwrap(), bytes);
        }
        // Solana's USDC mint.
        let usdc = decode32("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        assert_eq!(encode(&usdc), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    }

    #[test]
    fn rejects_outside_the_alphabet_and_wrong_lengths() {
        for bad in ["0", "O", "I", "l", " 1", "1 ", "abc+"] {
            assert!(decode(bad).is_none(), "{bad:?}");
        }
        assert!(decode32("112").is_none());
        // 33 characters: about 24 bytes.
        assert!(decode32("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wE").is_none());
        // 45: more than 32 bytes.
        assert!(decode32("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vz").is_none());
    }
}
