//! A strict Solidity ABI decoder, for the contract calls the wallet reads closely (a swap
//! through Choice's aggregator or router).
//!
//! The ABI lets one value be encoded many ways: offsets can point anywhere, padding can
//! hold anything, and bytes can trail the end. A contract reads such calldata happily,
//! and two readers can disagree about it. So [`decode`] reads by the schema and then
//! encodes what it read again: if that isn't byte for byte the input, the calldata is
//! refused. What the wallet shows is then the only reading there is.
//!
//! Words are kept as words; the typed accessors ([`Val::address`], [`Val::uint`],
//! [`Val::small`], [`Val::boolean`]) check that the word is in range for its type.

use choice_wallet_core::EthAddress;

use crate::U256;

/// A schema: the shape of a value, not its Solidity type name. Every static type (address,
/// uint, bool, bytesN) is one [`Ty::Word`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    /// One 32-byte word.
    Word,
    /// `bytes` or `string`.
    Bytes,
    /// `T[]`.
    Array(&'static Ty),
    /// A struct or tuple.
    Tuple(&'static [Ty]),
}

/// A decoded value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Val {
    /// One word.
    Word([u8; 32]),
    /// `bytes` or `string`.
    Bytes(Vec<u8>),
    /// `T[]`.
    Array(Vec<Val>),
    /// A struct or tuple.
    Tuple(Vec<Val>),
}

/// Why calldata was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AbiError(pub &'static str);

impl std::fmt::Display for AbiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for AbiError {}

/// Longest array read: well past any route, short of a memory problem.
const MAX_ITEMS: usize = 256;
/// Deepest nesting read.
const MAX_DEPTH: usize = 8;

impl Ty {
    fn is_dynamic(&self) -> bool {
        match self {
            Ty::Word => false,
            Ty::Bytes | Ty::Array(_) => true,
            Ty::Tuple(ts) => ts.iter().any(Ty::is_dynamic),
        }
    }

    /// Bytes this type takes in its parent's head.
    fn head_len(&self) -> usize {
        match self {
            Ty::Tuple(ts) if !self.is_dynamic() => ts.iter().map(Ty::head_len).sum(),
            _ => 32,
        }
    }
}

/// Decode `data` (no selector) as the tuple `tys`, and refuse it unless it is the one
/// canonical encoding of what it holds.
pub fn decode(tys: &[Ty], data: &[u8]) -> Result<Vec<Val>, AbiError> {
    let vals = tuple(tys, data, 0, 0)?;
    if encode(&vals) != data {
        return Err(AbiError("calldata is not canonically encoded"));
    }
    Ok(vals)
}

/// Encode values as a tuple, canonically.
pub fn encode(vals: &[Val]) -> Vec<u8> {
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let head_len: usize = vals.iter().map(Val::head_len).sum();
    for v in vals {
        if v.is_dynamic() {
            head.extend_from_slice(&usize_word(head_len + tail.len()));
            tail.extend_from_slice(&v.encode_alone());
        } else {
            head.extend_from_slice(&v.encode_alone());
        }
    }
    head.extend_from_slice(&tail);
    head
}

impl Val {
    fn is_dynamic(&self) -> bool {
        match self {
            Val::Word(_) => false,
            Val::Bytes(_) | Val::Array(_) => true,
            Val::Tuple(vs) => vs.iter().any(Val::is_dynamic),
        }
    }

    fn head_len(&self) -> usize {
        match self {
            Val::Tuple(vs) if !self.is_dynamic() => vs.iter().map(Val::head_len).sum(),
            _ => 32,
        }
    }

    /// This value's encoding, as it sits at its own offset.
    fn encode_alone(&self) -> Vec<u8> {
        match self {
            Val::Word(w) => w.to_vec(),
            Val::Bytes(b) => {
                let mut out = usize_word(b.len()).to_vec();
                out.extend_from_slice(b);
                out.resize(32 + b.len().div_ceil(32) * 32, 0);
                out
            }
            Val::Array(vs) => {
                let mut out = usize_word(vs.len()).to_vec();
                out.extend_from_slice(&encode(vs));
                out
            }
            Val::Tuple(vs) => encode(vs),
        }
    }

    /// The word, or an error if this isn't one.
    pub fn word(&self) -> Result<&[u8; 32], AbiError> {
        match self {
            Val::Word(w) => Ok(w),
            _ => Err(AbiError("expected a word")),
        }
    }

    /// An `address`: the top 12 bytes must be zero.
    pub fn address(&self) -> Result<EthAddress, AbiError> {
        let w = self.word()?;
        if w[..12].iter().any(|&b| b != 0) {
            return Err(AbiError("address out of range"));
        }
        Ok(EthAddress::from_bytes(w[12..].try_into().expect("20 bytes")))
    }

    /// A `uint256`.
    pub fn uint(&self) -> Result<U256, AbiError> {
        Ok(U256::from_be_bytes(*self.word()?))
    }

    /// A `uintN` with N ≤ 64.
    pub fn small(&self, bits: u32) -> Result<u64, AbiError> {
        let w = self.word()?;
        let v = U256::from_be_bytes(*w)
            .to_u64()
            .ok_or(AbiError("integer out of range"))?;
        if bits < 64 && v >> bits != 0 {
            return Err(AbiError("integer out of range"));
        }
        Ok(v)
    }

    /// A `uintN` with N ≤ 256, as a U256: the bits above N must be zero.
    pub fn uint_bits(&self, bits: u32) -> Result<U256, AbiError> {
        let w = self.word()?;
        let clear = 32 - (bits as usize).div_ceil(8);
        if w[..clear].iter().any(|&b| b != 0) || (!bits.is_multiple_of(8) && w[clear] >> (bits % 8) != 0) {
            return Err(AbiError("integer out of range"));
        }
        Ok(U256::from_be_bytes(*w))
    }

    /// A `bool`: 0 or 1.
    pub fn boolean(&self) -> Result<bool, AbiError> {
        match self.small(1)? {
            0 => Ok(false),
            _ => Ok(true),
        }
    }

    /// `bytes`.
    pub fn bytes(&self) -> Result<&[u8], AbiError> {
        match self {
            Val::Bytes(b) => Ok(b),
            _ => Err(AbiError("expected bytes")),
        }
    }

    /// An array's items.
    pub fn array(&self) -> Result<&[Val], AbiError> {
        match self {
            Val::Array(vs) => Ok(vs),
            _ => Err(AbiError("expected an array")),
        }
    }

    /// A tuple's fields.
    pub fn fields(&self) -> Result<&[Val], AbiError> {
        match self {
            Val::Tuple(vs) => Ok(vs),
            _ => Err(AbiError("expected a tuple")),
        }
    }
}

fn usize_word(n: usize) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&(n as u64).to_be_bytes());
    w
}

fn read_word(data: &[u8], at: usize) -> Result<[u8; 32], AbiError> {
    data.get(at..at.checked_add(32).ok_or(AbiError("offset out of range"))?)
        .map(|s| s.try_into().expect("32 bytes"))
        .ok_or(AbiError("calldata too short"))
}

fn read_usize(data: &[u8], at: usize) -> Result<usize, AbiError> {
    let w = read_word(data, at)?;
    if w[..24].iter().any(|&b| b != 0) {
        return Err(AbiError("offset out of range"));
    }
    usize::try_from(u64::from_be_bytes(w[24..].try_into().expect("8 bytes")))
        .map_err(|_| AbiError("offset out of range"))
}

/// The tuple `tys` whose encoding starts at `base`.
fn tuple(tys: &[Ty], data: &[u8], base: usize, depth: usize) -> Result<Vec<Val>, AbiError> {
    if depth > MAX_DEPTH {
        return Err(AbiError("nested too deeply"));
    }
    let mut out = Vec::with_capacity(tys.len());
    let mut at = base;
    for t in tys {
        let v = if t.is_dynamic() {
            let offset = read_usize(data, at)?;
            let start = base.checked_add(offset).ok_or(AbiError("offset out of range"))?;
            value(t, data, start, depth + 1)?
        } else {
            value(t, data, at, depth + 1)?
        };
        at += t.head_len();
        out.push(v);
    }
    Ok(out)
}

/// One value of type `t` at `at`.
fn value(t: &Ty, data: &[u8], at: usize, depth: usize) -> Result<Val, AbiError> {
    match t {
        Ty::Word => Ok(Val::Word(read_word(data, at)?)),
        Ty::Bytes => {
            let len = read_usize(data, at)?;
            let start = at + 32;
            let end = start.checked_add(len).ok_or(AbiError("bytes out of range"))?;
            data.get(start..end)
                .map(|b| Val::Bytes(b.to_vec()))
                .ok_or(AbiError("calldata too short"))
        }
        Ty::Array(item) => {
            let len = read_usize(data, at)?;
            if len > MAX_ITEMS {
                return Err(AbiError("array too long"));
            }
            let items = vec![**item; len];
            Ok(Val::Array(tuple(&items, data, at + 32, depth)?))
        }
        Ty::Tuple(ts) => Ok(Val::Tuple(tuple(ts, data, at, depth)?)),
    }
}

/// The 4-byte selector of a function signature, e.g. `transfer(address,uint256)`.
pub fn selector(signature: &str) -> [u8; 4] {
    let h = choice_wallet_core::secp256k1::keccak256(signature.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAIR: &[Ty] = &[Ty::Word, Ty::Bytes];
    const NESTED: &[Ty] = &[Ty::Word, Ty::Array(&Ty::Tuple(PAIR)), Ty::Word];

    fn word(n: u8) -> Val {
        let mut w = [0u8; 32];
        w[31] = n;
        Val::Word(w)
    }

    #[test]
    fn round_trips_and_matches_solidity() {
        // abi.encode(uint256 1, (uint256,bytes)[] [(2, 0xab), (3, "")], uint256 4), as
        // Solidity lays it out: the array behind an offset, each tuple behind its own.
        let vals = vec![
            word(1),
            Val::Array(vec![
                Val::Tuple(vec![word(2), Val::Bytes(vec![0xab])]),
                Val::Tuple(vec![word(3), Val::Bytes(vec![])]),
            ]),
            word(4),
        ];
        let data = encode(&vals);
        let hex = hex::encode(&data);
        let words: Vec<&str> = (0..hex.len() / 64).map(|i| &hex[i * 64..i * 64 + 64]).collect();
        let n = |x: u64| format!("{x:064x}");
        assert_eq!(
            words,
            [
                n(1),
                n(0x60),
                n(4),
                n(2),    // array length
                n(0x40), // offset of item 0, from the array's first item
                n(0xc0), // offset of item 1
                n(2),
                n(0x40),
                n(1),
                format!("ab{}", "0".repeat(62)),
                n(3),
                n(0x40),
                n(0),
            ]
        );
        assert_eq!(decode(NESTED, &data).unwrap(), vals);
    }

    #[test]
    fn refuses_what_isnt_canonical() {
        let data = encode(&[word(7), Val::Bytes(vec![1, 2, 3])]);
        assert!(decode(PAIR, &data).is_ok());
        // Trailing bytes.
        let mut longer = data.clone();
        longer.extend_from_slice(&[0; 32]);
        assert!(decode(PAIR, &longer).is_err());
        // Dirty padding after the bytes.
        let mut dirty = data.clone();
        *dirty.last_mut().unwrap() = 1;
        assert!(decode(PAIR, &dirty).is_err());
        // An offset that points elsewhere, with the bytes copied there too.
        let mut moved = data.clone();
        moved[63] = 0x60;
        moved.extend_from_slice(&data[64..]);
        assert!(decode(PAIR, &moved).is_err());
        // Short, and an absurd offset.
        assert!(decode(PAIR, &data[..40]).is_err());
        let mut far = data;
        far[32..64].copy_from_slice(&[0xff; 32]);
        assert!(decode(PAIR, &far).is_err());
    }

    #[test]
    fn typed_words_are_range_checked() {
        let mut w = [0u8; 32];
        w[31] = 2;
        assert!(Val::Word(w).boolean().is_err());
        assert_eq!(Val::Word(w).small(16), Ok(2));
        w[0] = 1;
        assert!(Val::Word(w).address().is_err());
        assert!(Val::Word(w).small(64).is_err());
        let mut w160 = [0u8; 32];
        w160[12] = 0xff;
        assert!(Val::Word(w160).uint_bits(160).is_ok());
        w160[11] = 1;
        assert!(Val::Word(w160).uint_bits(160).is_err());
        let mut w48 = [0u8; 32];
        w48[26] = 1;
        assert!(Val::Word(w48).uint_bits(48).is_ok());
        w48[25] = 1;
        assert!(Val::Word(w48).uint_bits(48).is_err());
        assert_eq!(hex::encode(selector("transfer(address,uint256)")), "a9059cbb");
    }
}
