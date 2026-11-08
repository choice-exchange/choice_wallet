use std::fmt;

use crate::Error;

/// An unsigned 256-bit integer, stored big-endian.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct U256([u8; 32]);

impl U256 {
    /// Zero.
    pub const ZERO: Self = Self([0; 32]);
    /// 2^256 - 1.
    pub const MAX: Self = Self([0xff; 32]);

    /// From big-endian bytes.
    pub const fn from_be_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }

    /// Big-endian bytes.
    pub const fn to_be_bytes(&self) -> [u8; 32] {
        self.0
    }

    /// From a `u128`.
    pub fn from_u128(v: u128) -> Self {
        let mut b = [0; 32];
        b[16..].copy_from_slice(&v.to_be_bytes());
        Self(b)
    }

    /// Whether this is zero.
    pub fn is_zero(&self) -> bool {
        self.0 == [0; 32]
    }

    /// Parse a canonical decimal string: digits only, no sign, no leading zeros.
    pub fn from_dec_str(s: &str) -> Result<Self, Error> {
        let bad = || Error::Amount(s.into());
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
            return Err(bad());
        }
        let mut out = [0u8; 32];
        for d in s.bytes() {
            // out = out * 10 + d, refusing overflow
            let mut carry = u16::from(d - b'0');
            for byte in out.iter_mut().rev() {
                let v = u16::from(*byte) * 10 + carry;
                *byte = v as u8;
                carry = v >> 8;
            }
            if carry != 0 {
                return Err(bad());
            }
        }
        Ok(Self(out))
    }
}

impl fmt::Display for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Repeated division by 10 on the big-endian bytes.
        let mut n = self.0;
        let mut digits = Vec::new();
        loop {
            let mut rem = 0u16;
            for byte in n.iter_mut() {
                let v = (rem << 8) | u16::from(*byte);
                *byte = (v / 10) as u8;
                rem = v % 10;
            }
            digits.push(b'0' + rem as u8);
            if n == [0; 32] {
                break;
            }
        }
        digits.reverse();
        f.write_str(std::str::from_utf8(&digits).expect("ascii digits"))
    }
}

impl fmt::Debug for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "U256({self})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: &str = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    #[test]
    fn parses_and_prints() {
        for s in ["0", "1", "255", "256", "1500000000000000000", MAX] {
            assert_eq!(U256::from_dec_str(s).unwrap().to_string(), s);
        }
        assert_eq!(U256::from_dec_str(MAX).unwrap(), U256::MAX);
        assert_eq!(
            U256::from_dec_str("340282366920938463463374607431768211455").unwrap(),
            U256::from_u128(u128::MAX)
        );
    }

    #[test]
    fn refuses_overflow_and_non_canonical() {
        let over = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
        for bad in ["", "01", "+1", "-1", "1.0", "1e3", " 1", over] {
            assert_eq!(
                U256::from_dec_str(bad).unwrap_err(),
                Error::Amount(bad.into()),
                "{bad:?}"
            );
        }
    }
}
