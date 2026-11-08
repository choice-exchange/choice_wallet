//! Strict protobuf decoding.

use prost::Message;

use crate::Error;

/// Decode `bytes` as `M` and refuse it unless re-encoding gives back exactly the same bytes.
///
/// prost drops unknown fields, keeps the last of duplicated fields and writes fields in tag
/// order with minimal varints, so any of those in the input makes the round trip differ.
/// Nested `Any`s are opaque bytes here; callers decode them with this function too.
pub(crate) fn decode_exact<M: Message + Default>(bytes: &[u8], what: &'static str) -> Result<M, Error> {
    let msg = M::decode(bytes).map_err(|_| Error::Decode(what))?;
    if msg.encode_to_vec() != bytes {
        return Err(Error::NonCanonical(what));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::cosmos::base::v1beta1::Coin;

    fn coin() -> Vec<u8> {
        Coin {
            denom: "inj".into(),
            amount: "1".into(),
        }
        .encode_to_vec()
    }

    #[test]
    fn accepts_canonical_bytes() {
        let c: Coin = decode_exact(&coin(), "Coin").unwrap();
        assert_eq!(c.denom, "inj");
    }

    #[test]
    fn refuses_unknown_fields() {
        let mut b = coin();
        b.extend_from_slice(&[0x18, 0x01]); // field 3, varint 1
        assert_eq!(
            decode_exact::<Coin>(&b, "Coin").unwrap_err(),
            Error::NonCanonical("Coin")
        );
    }

    #[test]
    fn refuses_fields_out_of_order() {
        // amount (2) before denom (1)
        let b = [0x12, 0x01, b'1', 0x0a, 0x03, b'i', b'n', b'j'];
        assert_eq!(
            decode_exact::<Coin>(&b, "Coin").unwrap_err(),
            Error::NonCanonical("Coin")
        );
    }

    #[test]
    fn refuses_duplicate_fields() {
        let mut b = coin();
        b.extend_from_slice(&[0x12, 0x01, b'2']); // a second amount
        assert_eq!(
            decode_exact::<Coin>(&b, "Coin").unwrap_err(),
            Error::NonCanonical("Coin")
        );
    }

    #[test]
    fn refuses_explicit_defaults_and_long_varints() {
        let mut b = coin();
        b.splice(0..0, [0x0a, 0x00]); // empty denom written explicitly, then the real one
        assert!(decode_exact::<Coin>(&b, "Coin").is_err());
        let long_len = [0x0a, 0x83, 0x00, b'i', b'n', b'j']; // length 3 as a two-byte varint
        assert_eq!(
            decode_exact::<Coin>(&long_len, "Coin").unwrap_err(),
            Error::NonCanonical("Coin")
        );
    }

    #[test]
    fn refuses_garbage() {
        assert_eq!(
            decode_exact::<Coin>(&[0xff, 0xff], "Coin").unwrap_err(),
            Error::Decode("Coin")
        );
    }
}
