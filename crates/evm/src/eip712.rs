//! EIP-712 typed data (`eth_signTypedData_v4`): strict parsing, hashing and signing.
//!
//! The rules are stricter than most wallets, so that what the approval screen shows is
//! exactly what gets hashed:
//!
//! - Every field declared in `types` must be present, with a value of the right JSON kind.
//!   Fields the types don't declare are refused rather than silently ignored.
//! - `bytesN` values must be exactly N bytes, addresses exactly 20, and integers must fit
//!   their declared width.
//! - Integers may be JSON integers, decimal strings or `0x` hex strings.
//! - When `types` has no `EIP712Domain`, it is derived from the domain's keys in the
//!   standard order (name, version, chainId, verifyingContract, salt).

use std::collections::{BTreeMap, BTreeSet};

use choice_wallet_core::secp256k1::keccak256;
use choice_wallet_core::{EthAddress, PrivateKey};
use serde_json::{Map, Value};

use crate::U256;

/// Why typed data was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TypedDataError {
    /// The JSON isn't valid or isn't shaped like typed data.
    #[error("malformed typed data: {0}")]
    Malformed(String),
    /// A type is used but not defined, or a type name is invalid.
    #[error("unknown or invalid type {0:?}")]
    Type(String),
    /// A value doesn't match its declared type.
    #[error("invalid value for {field}: {reason}")]
    Value {
        /// Dotted path to the field.
        field: String,
        /// What's wrong.
        reason: String,
    },
}

type Result<T> = std::result::Result<T, TypedDataError>;

/// One field of a struct type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// Field name.
    pub name: String,
    /// Field type, e.g. `address`, `uint256`, `Person[]`.
    pub ty: String,
}

/// Parsed typed data.
#[derive(Debug, Clone, PartialEq)]
pub struct TypedData {
    types: BTreeMap<String, Vec<Field>>,
    primary_type: String,
    domain: Map<String, Value>,
    message: Value,
}

const DOMAIN_FIELDS: [(&str, &str); 5] = [
    ("name", "string"),
    ("version", "string"),
    ("chainId", "uint256"),
    ("verifyingContract", "address"),
    ("salt", "bytes32"),
];

impl TypedData {
    /// Parse the JSON a dapp passes to `eth_signTypedData_v4`.
    pub fn parse(json: &str) -> Result<Self> {
        let v: Value = serde_json::from_str(json).map_err(|e| TypedDataError::Malformed(e.to_string()))?;
        let mut obj = match v {
            Value::Object(o) => o,
            _ => return Err(malformed("expected an object")),
        };
        if let Some(k) = obj
            .keys()
            .find(|k| !["types", "primaryType", "domain", "message"].contains(&k.as_str()))
        {
            return Err(malformed(&format!("unexpected key {k:?}")));
        }
        let Some(Value::Object(raw_types)) = obj.remove("types") else {
            return Err(malformed("missing types"));
        };
        let Some(Value::String(primary_type)) = obj.remove("primaryType") else {
            return Err(malformed("missing primaryType"));
        };
        let Some(Value::Object(domain)) = obj.remove("domain") else {
            return Err(malformed("missing domain"));
        };
        let message = obj.remove("message").ok_or_else(|| malformed("missing message"))?;

        let mut types = BTreeMap::new();
        for (name, fields) in raw_types {
            // A struct named like an atomic type would be ambiguous.
            if !is_identifier(&name) || is_atomic(&name) {
                return Err(TypedDataError::Type(name));
            }
            let Value::Array(fields) = fields else {
                return Err(malformed("type fields must be a list"));
            };
            let mut parsed = Vec::with_capacity(fields.len());
            let mut seen = BTreeSet::new();
            for f in fields {
                let (Some(Value::String(n)), Some(Value::String(t)), 2) = (f.get("name"), f.get("type"), obj_len(&f))
                else {
                    return Err(malformed("each field needs exactly name and type"));
                };
                if !seen.insert(n.clone()) {
                    return Err(malformed(&format!("duplicate field {n:?} in {name}")));
                }
                parsed.push(Field {
                    name: n.clone(),
                    ty: t.clone(),
                });
            }
            types.insert(name, parsed);
        }
        if !types.contains_key("EIP712Domain") {
            let derived = DOMAIN_FIELDS
                .iter()
                .filter(|(n, _)| domain.contains_key(*n))
                .map(|(n, t)| Field {
                    name: (*n).into(),
                    ty: (*t).into(),
                })
                .collect();
            types.insert("EIP712Domain".into(), derived);
        }
        let td = Self {
            types,
            primary_type,
            domain,
            message,
        };
        // Validate every type reference up front, and the whole message by hashing it.
        for fields in td.types.values() {
            for f in fields {
                td.check_type(&f.ty)?;
            }
        }
        td.check_type(&td.primary_type)?;
        td.hash()?;
        Ok(td)
    }

    /// The struct types, by name.
    pub fn types(&self) -> &BTreeMap<String, Vec<Field>> {
        &self.types
    }

    /// The primary type.
    pub fn primary_type(&self) -> &str {
        &self.primary_type
    }

    /// The domain values.
    pub fn domain(&self) -> &Map<String, Value> {
        &self.domain
    }

    /// The message values.
    pub fn message(&self) -> &Value {
        &self.message
    }

    /// The domain's `chainId`, if it has one.
    pub fn chain_id(&self) -> Option<U256> {
        self.domain.get("chainId").and_then(|v| parse_uint(v, 256).ok())
    }

    /// `hashStruct(domain)`.
    pub fn domain_separator(&self) -> Result<[u8; 32]> {
        self.hash_struct("EIP712Domain", &Value::Object(self.domain.clone()), "domain")
    }

    /// The digest that gets signed: `keccak256(0x19 0x01 || domainSeparator || hashStruct(message))`.
    pub fn hash(&self) -> Result<[u8; 32]> {
        let mut buf = vec![0x19, 0x01];
        buf.extend_from_slice(&self.domain_separator()?);
        if self.primary_type != "EIP712Domain" {
            buf.extend_from_slice(&self.hash_struct(&self.primary_type, &self.message, "message")?);
        }
        Ok(keccak256(&buf))
    }

    /// Sign as `eth_signTypedData_v4` does: 65 bytes `r || s || v`, with v = 27 or 28.
    pub fn sign(&self, key: &PrivateKey) -> Result<[u8; 65]> {
        let (sig, recid) = key.sign_prehash(&self.hash()?);
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig);
        out[64] = 27 + (recid & 1);
        Ok(out)
    }

    fn check_type(&self, ty: &str) -> Result<()> {
        if let Some((inner, _)) = split_array(ty)? {
            return self.check_type(inner);
        }
        if self.types.contains_key(ty) || is_atomic(ty) {
            Ok(())
        } else {
            Err(TypedDataError::Type(ty.into()))
        }
    }

    /// `encodeType`: the primary type, then every struct type it references, sorted.
    fn encode_type(&self, primary: &str) -> Result<String> {
        let mut deps = BTreeSet::new();
        self.collect_deps(primary, &mut deps)?;
        deps.remove(primary);
        let mut out = String::new();
        for name in std::iter::once(primary).chain(deps.iter().map(String::as_str)) {
            let fields = &self.types[name];
            out.push_str(name);
            out.push('(');
            let list: Vec<String> = fields.iter().map(|f| format!("{} {}", f.ty, f.name)).collect();
            out.push_str(&list.join(","));
            out.push(')');
        }
        Ok(out)
    }

    fn collect_deps(&self, ty: &str, deps: &mut BTreeSet<String>) -> Result<()> {
        let base = match split_array(ty)? {
            Some((inner, _)) => return self.collect_deps(inner, deps),
            None => ty,
        };
        let Some(fields) = self.types.get(base) else {
            return Ok(());
        };
        if !deps.insert(base.to_owned()) {
            return Ok(());
        }
        for f in fields {
            self.collect_deps(&f.ty, deps)?;
        }
        Ok(())
    }

    fn hash_struct(&self, ty: &str, value: &Value, path: &str) -> Result<[u8; 32]> {
        let fields = self.types.get(ty).ok_or_else(|| TypedDataError::Type(ty.into()))?;
        let Value::Object(obj) = value else {
            return Err(bad(path, "expected an object"));
        };
        if let Some(k) = obj.keys().find(|k| !fields.iter().any(|f| &f.name == *k)) {
            return Err(bad(path, &format!("field {k:?} is not in type {ty}")));
        }
        let mut enc = keccak256(self.encode_type(ty)?.as_bytes()).to_vec();
        for f in fields {
            let p = format!("{path}.{}", f.name);
            let v = obj.get(&f.name).ok_or_else(|| bad(&p, "missing"))?;
            enc.extend_from_slice(&self.encode_value(&f.ty, v, &p)?);
        }
        Ok(keccak256(&enc))
    }

    fn encode_value(&self, ty: &str, v: &Value, path: &str) -> Result<[u8; 32]> {
        if let Some((inner, len)) = split_array(ty)? {
            let Value::Array(items) = v else {
                return Err(bad(path, "expected an array"));
            };
            if let Some(n) = len
                && items.len() != n
            {
                return Err(bad(path, &format!("expected {n} items, got {}", items.len())));
            }
            let mut buf = Vec::with_capacity(items.len() * 32);
            for (i, item) in items.iter().enumerate() {
                buf.extend_from_slice(&self.encode_value(inner, item, &format!("{path}[{i}]"))?);
            }
            return Ok(keccak256(&buf));
        }
        if self.types.contains_key(ty) {
            return self.hash_struct(ty, v, path);
        }
        encode_atomic(ty, v).map_err(|reason| bad(path, &reason))
    }
}

fn encode_atomic(ty: &str, v: &Value) -> std::result::Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    match ty {
        "string" => Ok(keccak256(v.as_str().ok_or("expected a string")?.as_bytes())),
        "bytes" => Ok(keccak256(&parse_hex_bytes(v)?)),
        "bool" => {
            out[31] = u8::from(v.as_bool().ok_or("expected true or false")?);
            Ok(out)
        }
        "address" => {
            let s = v.as_str().ok_or("expected an address string")?;
            let a = EthAddress::parse_hex(s).map_err(|_| "invalid address".to_owned())?;
            out[12..].copy_from_slice(a.as_bytes());
            Ok(out)
        }
        _ if ty.starts_with("bytes") => {
            let n: usize = ty[5..].parse().map_err(|_| "bad bytes size")?;
            let b = parse_hex_bytes(v)?;
            if b.len() != n {
                return Err(format!("expected {n} bytes, got {}", b.len()));
            }
            out[..n].copy_from_slice(&b);
            Ok(out)
        }
        _ if ty.starts_with("uint") => Ok(parse_uint(v, int_bits(&ty[4..])?)?.to_be_bytes()),
        _ if ty.starts_with("int") => parse_int(v, int_bits(&ty[3..])?),
        _ => Err(format!("unknown type {ty}")),
    }
}

fn is_atomic(ty: &str) -> bool {
    match ty {
        "string" | "bytes" | "bool" | "address" => true,
        _ if ty.starts_with("bytes") => ty[5..].parse::<usize>().is_ok_and(|n| (1..=32).contains(&n)),
        _ if ty.starts_with("uint") => int_bits(&ty[4..]).is_ok(),
        _ if ty.starts_with("int") => int_bits(&ty[3..]).is_ok(),
        _ => false,
    }
}

fn int_bits(s: &str) -> std::result::Result<u32, String> {
    if s.is_empty() || s.starts_with('0') {
        return Err("integer types need an explicit size, e.g. uint256".into());
    }
    match s.parse::<u32>() {
        Ok(n) if n % 8 == 0 && (8..=256).contains(&n) => Ok(n),
        _ => Err(format!("bad integer size {s}")),
    }
}

/// `T[]` → (T, None), `T[3]` → (T, Some(3)), otherwise None.
fn split_array(ty: &str) -> Result<Option<(&str, Option<usize>)>> {
    let Some(body) = ty.strip_suffix(']') else {
        return Ok(None);
    };
    let open = body.rfind('[').ok_or_else(|| TypedDataError::Type(ty.into()))?;
    let (inner, len) = (&body[..open], &body[open + 1..]);
    if len.is_empty() {
        return Ok(Some((inner, None)));
    }
    match len.parse::<usize>() {
        Ok(n) if !len.starts_with('0') => Ok(Some((inner, Some(n)))),
        _ => Err(TypedDataError::Type(ty.into())),
    }
}

fn parse_hex_bytes(v: &Value) -> std::result::Result<Vec<u8>, String> {
    let s = v.as_str().ok_or("expected a 0x hex string")?;
    let h = s.strip_prefix("0x").ok_or("expected a 0x hex string")?;
    if h.len() % 2 != 0 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid hex".into());
    }
    Ok((0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect())
}

/// A uintN from a JSON integer, decimal string or `0x` hex string.
fn parse_uint(v: &Value, bits: u32) -> std::result::Result<U256, String> {
    let n = match v {
        Value::Number(n) => U256::from_u128(u128::from(n.as_u64().ok_or("expected an unsigned integer")?)),
        Value::String(s) => parse_uint_str(s)?,
        _ => return Err("expected an integer".into()),
    };
    if bits < 256 {
        let be = n.to_be_bytes();
        let free = (256 - bits) as usize / 8;
        if be[..free].iter().any(|&b| b != 0) {
            return Err(format!("does not fit in uint{bits}"));
        }
    }
    Ok(n)
}

fn parse_uint_str(s: &str) -> std::result::Result<U256, String> {
    if let Some(h) = s.strip_prefix("0x") {
        if h.is_empty() || h.len() > 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid hex integer".into());
        }
        let padded = format!("{h:0>64}");
        let mut b = [0u8; 32];
        for (i, byte) in b.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16).unwrap();
        }
        Ok(U256::from_be_bytes(b))
    } else {
        U256::from_dec_str(s).map_err(|_| "invalid decimal integer".to_owned())
    }
}

/// An intN, two's complement in 32 bytes.
fn parse_int(v: &Value, bits: u32) -> std::result::Result<[u8; 32], String> {
    let (neg, mag) = match v {
        Value::Number(n) => match n.as_i64() {
            Some(i) => (i < 0, U256::from_u128(u128::from(i.unsigned_abs()))),
            None => (
                false,
                U256::from_u128(u128::from(n.as_u64().ok_or("expected an integer")?)),
            ),
        },
        Value::String(s) => match s.strip_prefix('-') {
            Some(rest) if !rest.starts_with('-') => (true, parse_uint_str(rest)?),
            Some(_) => return Err("invalid integer".into()),
            None => (false, parse_uint_str(s)?),
        },
        _ => return Err("expected an integer".into()),
    };
    // |v| must be < 2^(bits-1), or == 2^(bits-1) when negative.
    let limit = pow2(bits - 1);
    if mag > limit || (mag == limit && !neg) {
        return Err(format!("does not fit in int{bits}"));
    }
    let mut b = mag.to_be_bytes();
    if neg && !mag.is_zero() {
        // two's complement: invert and add one
        for byte in b.iter_mut() {
            *byte = !*byte;
        }
        for byte in b.iter_mut().rev() {
            let (s, carry) = byte.overflowing_add(1);
            *byte = s;
            if !carry {
                break;
            }
        }
    }
    Ok(b)
}

fn pow2(n: u32) -> U256 {
    let mut b = [0u8; 32];
    b[31 - (n / 8) as usize] = 1 << (n % 8);
    U256::from_be_bytes(b)
}

fn is_identifier(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_') && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn obj_len(v: &Value) -> usize {
    v.as_object().map_or(0, Map::len)
}

fn malformed(s: &str) -> TypedDataError {
    TypedDataError::Malformed(s.into())
}

fn bad(field: &str, reason: &str) -> TypedDataError {
    TypedDataError::Value {
        field: field.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The example from the EIP-712 specification, with its published hashes.
    const MAIL: &str = r#"{
      "types": {
        "EIP712Domain": [{"name":"name","type":"string"},{"name":"version","type":"string"},
                         {"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
        "Person": [{"name":"name","type":"string"},{"name":"wallet","type":"address"}],
        "Mail": [{"name":"from","type":"Person"},{"name":"to","type":"Person"},{"name":"contents","type":"string"}]
      },
      "primaryType": "Mail",
      "domain": {"name":"Ether Mail","version":"1","chainId":1,"verifyingContract":"0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},
      "message": {
        "from": {"name":"Cow","wallet":"0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},
        "to": {"name":"Bob","wallet":"0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},
        "contents": "Hello, Bob!"
      }
    }"#;

    #[test]
    fn eip712_spec_example() {
        let td = TypedData::parse(MAIL).unwrap();
        assert_eq!(
            td.encode_type("Mail").unwrap(),
            "Mail(Person from,Person to,string contents)Person(string name,address wallet)"
        );
        assert_eq!(
            hex::encode(td.domain_separator().unwrap()),
            "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
        );
        assert_eq!(
            hex::encode(td.hash().unwrap()),
            "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
        );
    }

    fn with(f: impl FnOnce(&mut Value)) -> std::result::Result<TypedData, TypedDataError> {
        let mut v: Value = serde_json::from_str(MAIL).unwrap();
        f(&mut v);
        TypedData::parse(&v.to_string())
    }

    #[test]
    fn refuses_missing_extra_and_mistyped_fields() {
        assert!(matches!(
            with(|v| {
                v["message"].as_object_mut().unwrap().remove("contents");
            }),
            Err(TypedDataError::Value { .. })
        ));
        assert!(matches!(
            with(|v| v["message"]["extra"] = 1.into()),
            Err(TypedDataError::Value { .. })
        ));
        assert!(matches!(
            with(|v| v["domain"]["salt"] = "0x00".into()),
            Err(TypedDataError::Value { .. })
        ));
        assert!(matches!(
            with(|v| v["message"]["contents"] = 5.into()),
            Err(TypedDataError::Value { .. })
        ));
        assert!(matches!(
            with(|v| v["message"]["to"]["wallet"] = "0x1234".into()),
            Err(TypedDataError::Value { .. })
        ));
        assert!(matches!(
            with(|v| v["types"]["Mail"][2]["type"] = "Letter".into()),
            Err(TypedDataError::Type(_))
        ));
        assert!(matches!(
            with(|v| v["extra"] = 1.into()),
            Err(TypedDataError::Malformed(_))
        ));
    }

    #[test]
    fn integer_ranges() {
        assert!(parse_uint(&"255".into(), 8).is_ok());
        assert!(parse_uint(&"256".into(), 8).is_err());
        assert!(parse_uint(&"0xff".into(), 8).is_ok());
        assert!(parse_uint(&Value::from(-1), 256).is_err());
        assert!(parse_uint(&Value::from(1.5), 256).is_err());
        assert_eq!(parse_int(&"-1".into(), 256).unwrap(), [0xff; 32]);
        assert!(parse_int(&"-128".into(), 8).is_ok());
        assert!(parse_int(&"-129".into(), 8).is_err());
        assert!(parse_int(&"127".into(), 8).is_ok());
        assert!(parse_int(&"128".into(), 8).is_err());
        assert!(parse_int(&"--1".into(), 8).is_err());
        assert!(int_bits("").is_err() && int_bits("7").is_err() && int_bits("264").is_err());
    }
}
