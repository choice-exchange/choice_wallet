use std::fmt;

use choice_wallet_core::hexutil;

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

    /// Parse a JSON-RPC quantity: `0x` and hex digits without leading zeros (`0x0` is zero).
    pub fn from_quantity(s: &str) -> Result<Self, Error> {
        let bad = || Error::Quantity(s.into());
        let digits = s.strip_prefix("0x").ok_or_else(bad)?;
        if digits.is_empty() || digits.len() > 64 || (digits.len() > 1 && digits.starts_with('0')) {
            return Err(bad());
        }
        let padded = format!("{digits:0>64}");
        let mut out = [0u8; 32];
        hexutil::decode_into(&padded, &mut out).map_err(|_| bad())?;
        Ok(Self(out))
    }

    /// As a JSON-RPC quantity, e.g. `0x0`, `0x1a`.
    pub fn to_quantity(&self) -> String {
        let hex = hexutil::encode(&self.0);
        let trimmed = hex.trim_start_matches('0');
        format!("0x{}", if trimmed.is_empty() { "0" } else { trimmed })
    }

    /// `a * b`. Two 128-bit numbers always multiply within 256 bits.
    pub fn product(a: u128, b: u128) -> Self {
        let limbs = |v: u128| [v as u64, (v >> 64) as u64]; // little-endian
        let (a, b) = (limbs(a), limbs(b));
        let mut r = [0u64; 4];
        for i in 0..2 {
            let mut carry = 0u128;
            for j in 0..2 {
                let t = u128::from(r[i + j]) + u128::from(a[i]) * u128::from(b[j]) + carry;
                r[i + j] = t as u64;
                carry = t >> 64;
            }
            r[i + 2] = carry as u64;
        }
        let mut out = [0u8; 32];
        for (k, limb) in r.iter().rev().enumerate() {
            out[k * 8..k * 8 + 8].copy_from_slice(&limb.to_be_bytes());
        }
        Self(out)
    }

    /// The value as a `u64`, if it fits.
    pub fn to_u64(&self) -> Option<u64> {
        self.0[..24]
            .iter()
            .all(|&b| b == 0)
            .then(|| u64::from_be_bytes(self.0[24..].try_into().expect("8 bytes")))
    }

    /// The value as a `u128`, if it fits.
    pub fn to_u128(&self) -> Option<u128> {
        self.0[..16]
            .iter()
            .all(|&b| b == 0)
            .then(|| u128::from_be_bytes(self.0[16..].try_into().expect("16 bytes")))
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
    fn products() {
        assert_eq!(U256::product(0, u128::MAX), U256::ZERO);
        assert_eq!(U256::product(21000, 500_000_000).to_string(), "10500000000000");
        assert_eq!(
            U256::product(21000, u128::MAX).to_string(),
            "7145929705339707732730866756067132440555000"
        );
        assert_eq!(
            U256::product(u128::MAX, u128::MAX).to_string(),
            "115792089237316195423570985008687907852589419931798687112530834793049593217025"
        );
    }

    #[test]
    fn quantities() {
        for (q, n) in [
            ("0x0", 0u128),
            ("0x1", 1),
            ("0x1a", 26),
            ("0xDE0B6B3A7640000", 1_000_000_000_000_000_000),
        ] {
            let v = U256::from_quantity(q).unwrap();
            assert_eq!(v.to_u128(), Some(n), "{q}");
            assert_eq!(v.to_quantity(), q.to_lowercase(), "{q}");
        }
        let max = format!("0x{}", "f".repeat(64));
        assert_eq!(U256::from_quantity(&max).unwrap(), U256::MAX);
        assert_eq!(U256::MAX.to_u128(), None);
        assert_eq!(U256::from_u128(u128::from(u64::MAX) + 1).to_u64(), None);
        let too_long = format!("0x1{}", "0".repeat(64));
        for bad in ["", "0x", "0x00", "0x01", "1a", "0X1", "0xg", "-0x1", too_long.as_str()] {
            assert_eq!(
                U256::from_quantity(bad).unwrap_err(),
                Error::Quantity(bad.into()),
                "{bad:?}"
            );
        }
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
