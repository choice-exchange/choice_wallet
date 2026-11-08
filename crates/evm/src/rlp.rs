//! A minimal RLP writer: byte strings, unsigned integers and lists. Enough for the
//! transaction types the wallet signs; checked against viem's encoder in the tests.

/// Encode a byte string.
pub fn bytes(out: &mut Vec<u8>, b: &[u8]) {
    if let [single] = b
        && *single < 0x80
    {
        out.push(*single);
        return;
    }
    header(out, 0x80, b.len());
    out.extend_from_slice(b);
}

/// Encode an unsigned integer given as big-endian bytes: leading zeros are stripped, and
/// zero is the empty string.
pub fn uint(out: &mut Vec<u8>, be: &[u8]) {
    let start = be.iter().position(|&b| b != 0).unwrap_or(be.len());
    bytes(out, &be[start..]);
}

/// Encode a `u64` or smaller integer.
pub fn u64(out: &mut Vec<u8>, v: u64) {
    uint(out, &v.to_be_bytes());
}

/// Encode a `u128` integer.
pub fn u128(out: &mut Vec<u8>, v: u128) {
    uint(out, &v.to_be_bytes());
}

/// Wrap already-encoded items as a list.
pub fn list(out: &mut Vec<u8>, payload: &[u8]) {
    header(out, 0xc0, payload.len());
    out.extend_from_slice(payload);
}

fn header(out: &mut Vec<u8>, base: u8, len: usize) {
    if len < 56 {
        out.push(base + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let start = be.iter().position(|&b| b != 0).expect("len >= 56");
        out.push(base + 55 + (be.len() - start) as u8);
        out.extend_from_slice(&be[start..]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let mut v = Vec::new();
        f(&mut v);
        v
    }

    // Examples from the Ethereum wiki's RLP page.
    #[test]
    fn spec_examples() {
        assert_eq!(enc(|o| bytes(o, b"dog")), [0x83, b'd', b'o', b'g']);
        assert_eq!(enc(|o| bytes(o, b"")), [0x80]);
        assert_eq!(enc(|o| u64(o, 0)), [0x80]);
        assert_eq!(enc(|o| bytes(o, &[0x00])), [0x00]);
        assert_eq!(enc(|o| bytes(o, &[0x0f])), [0x0f]);
        assert_eq!(enc(|o| u64(o, 1024)), [0x82, 0x04, 0x00]);
        assert_eq!(enc(|o| list(o, &[])), [0xc0]);
        let cat_dog = enc(|o| {
            bytes(o, b"cat");
            bytes(o, b"dog");
        });
        assert_eq!(
            enc(|o| list(o, &cat_dog)),
            [0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
        let lorem = b"Lorem ipsum dolor sit amet, consectetur adipisicing elit";
        let mut want = vec![0xb8, 0x38];
        want.extend_from_slice(lorem);
        assert_eq!(enc(|o| bytes(o, lorem)), want);
    }

    #[test]
    fn integers_drop_leading_zeros() {
        assert_eq!(enc(|o| uint(o, &[0, 0, 0x7f])), [0x7f]);
        assert_eq!(enc(|o| uint(o, &[0, 0x80])), [0x81, 0x80]);
        assert_eq!(enc(|o| u128(o, u128::MAX)), [&[0x90][..], &[0xff; 16]].concat());
    }
}
