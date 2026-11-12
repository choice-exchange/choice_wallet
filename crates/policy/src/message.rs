//! Rules for signed messages: `personal_sign`, ADR-036 `signArbitrary`, and Solana's
//! `signMessage`.

use choice_wallet_core::EthAddress;
use serde_json::json;

use crate::{Assessment, Context, Level, finding, site};

/// The first line of a Sign-In with Ethereum (EIP-4361) message ends with this.
const SIWE_SUFFIX: &str = " wants you to sign in with your Ethereum account:";
/// The first line of a Sign-In with Solana message (the same format) ends with this.
const SIWS_SUFFIX: &str = " wants you to sign in with your Solana account:";

/// The host of an origin: `https://app.example.org:8443` → `app.example.org:8443`.
fn host(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    rest.split('/').next().unwrap_or(rest)
}

/// The message as text, if it is printable text.
fn as_text(message: &[u8]) -> Option<&str> {
    std::str::from_utf8(message).ok().filter(|t| {
        t.chars()
            .all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
    })
}

/// Grade an ADR-036 message (`signArbitrary`). The signature covers a sign doc that wraps
/// the data and can't be broadcast, but data shaped like a transaction (a Cosmos or EVM
/// transaction's bytes, or amino or protobuf JSON) has no business here: a site that asks
/// for it is likely dressing one up.
pub fn arbitrary_message(data: &[u8], ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    if let Some(shape) = tx_shaped(data) {
        out.push(finding(
            "arbitrary_tx",
            Level::Red,
            "This message is shaped like a transaction. Sites have no reason to ask for that here.".into(),
            json!({ "shape": shape }),
        ));
    } else if as_text(data).is_none() {
        binary(data, &mut out);
    }
    Assessment::from(out)
}

/// What kind of transaction `data` looks like, if any.
fn tx_shaped(data: &[u8]) -> Option<&'static str> {
    // JSON: an amino sign doc, a protobuf-JSON tx or its body.
    if let Ok(serde_json::Value::Object(o)) = serde_json::from_slice::<serde_json::Value>(data) {
        const KEYS: [&str; 7] = [
            "msgs",
            "messages",
            "body",
            "body_bytes",
            "bodyBytes",
            "auth_info",
            "authInfoBytes",
        ];
        if KEYS.iter().any(|k| o.contains_key(*k)) {
            return Some("json");
        }
    }
    if cosmos_tx(data) {
        return Some("cosmos");
    }
    if evm_tx(data) {
        return Some("evm");
    }
    None
}

/// A protobuf field: its number and, if length-delimited, its bytes.
type Field<'a> = (u64, Option<&'a [u8]>);

/// A protobuf field walk. `None` unless the whole input is well-formed fields.
fn proto_fields(mut b: &[u8]) -> Option<Vec<Field<'_>>> {
    fn varint(b: &mut &[u8]) -> Option<u64> {
        let mut v = 0u64;
        for i in 0..10 {
            let (&x, rest) = b.split_first()?;
            *b = rest;
            v |= u64::from(x & 0x7f) << (7 * i);
            if x & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    }
    let mut out = Vec::new();
    while !b.is_empty() {
        let key = varint(&mut b)?;
        let (field, wire) = (key >> 3, key & 7);
        if field == 0 {
            return None;
        }
        match wire {
            0 => {
                varint(&mut b)?;
                out.push((field, None));
            }
            2 => {
                let len = usize::try_from(varint(&mut b)?).ok()?;
                if b.len() < len {
                    return None;
                }
                let (v, rest) = b.split_at(len);
                out.push((field, Some(v)));
                b = rest;
            }
            _ => return None,
        }
    }
    Some(out)
}

/// A Cosmos `TxRaw`, `SignDoc` or `Tx`: field 1 is a body whose messages (field 1) are
/// `Any`s with a type URL (`/…`).
fn cosmos_tx(data: &[u8]) -> bool {
    let is_body = |body: &[u8]| {
        proto_fields(body).is_some_and(|f| {
            f.iter().any(|(n, v)| {
                *n == 1
                    && v.and_then(proto_fields)
                        .and_then(|any| any.into_iter().find(|(n, _)| *n == 1))
                        .and_then(|(_, url)| url)
                        .is_some_and(|u| u.first() == Some(&b'/') && u.len() > 1 && u.iter().all(u8::is_ascii_graphic))
            })
        })
    };
    proto_fields(data).is_some_and(|f| f.iter().any(|(n, v)| *n == 1 && v.is_some_and(is_body))) || is_body(data)
}

/// An EVM transaction: a typed one (`0x01`..`0x04` then an RLP list) or a legacy RLP list,
/// covering the whole input.
fn evm_tx(data: &[u8]) -> bool {
    let list = |b: &[u8]| -> bool {
        let Some(&h) = b.first() else { return false };
        let (head, len) = match h {
            0xc0..=0xf7 => (1, usize::from(h - 0xc0)),
            0xf8..=0xff => {
                let n = usize::from(h - 0xf7);
                let Some(bytes) = b.get(1..1 + n) else { return false };
                (
                    1 + n,
                    bytes
                        .iter()
                        .fold(0usize, |a, &x| a.saturating_mul(256).saturating_add(usize::from(x))),
                )
            }
            _ => return false,
        };
        len > 0 && head.checked_add(len) == Some(b.len())
    };
    match data.first() {
        Some(0x01..=0x04) => list(&data[1..]),
        Some(0xc0..) => list(data),
        _ => false,
    }
}

fn binary(message: &[u8], out: &mut Vec<crate::Finding>) {
    out.push(if message.len() == 32 {
        finding(
            "hash_signature",
            Level::Red,
            "This looks like a transaction hash, not a message. Signing it could authorize something you can't see."
                .into(),
            json!({ "bytes": 32 }),
        )
    } else {
        finding(
            "binary_message",
            Level::Amber,
            "The message isn't text, so the wallet can't show what it says.".into(),
            json!({ "bytes": message.len() }),
        )
    });
}

/// Sign-in rules for a message in the EIP-4361 format (Ethereum's, and Solana's with its own
/// first line): the site it names must be the one asking, and the account the signer.
fn sign_in(text: &str, suffix: &str, is_signer: impl Fn(&str) -> bool, ctx: &Context, out: &mut Vec<crate::Finding>) {
    let mut lines = text.lines();
    let Some(domain) = lines.next().and_then(|l| l.strip_suffix(suffix)) else {
        return;
    };
    let domain = host(domain);
    let address = lines.next().unwrap_or("");
    let params = json!({ "domain": domain, "address": address, "origin": ctx.origin });
    if !is_signer(address) {
        out.push(finding(
            "sign_in_wrong_account",
            Level::Red,
            "This sign-in message names a different account.".into(),
            params,
        ));
    } else if let Some(origin) = &ctx.origin
        && host(origin) != domain
    {
        out.push(finding(
            "sign_in_wrong_site",
            Level::Red,
            format!(
                "This signs you in to {domain}, but the request came from {}.",
                host(origin)
            ),
            params,
        ));
    } else {
        out.push(finding(
            "sign_in",
            Level::Info,
            format!("Signs you in to {domain}."),
            params,
        ));
    }
}

/// Grade a message the window shows as text when it is UTF-8: the sign-in rules apply to all
/// of it, and control characters (which the window can't show) get their own note rather
/// than hiding a sign-in from those rules. Bytes that aren't UTF-8, or a 32-byte message that
/// isn't plain text, are graded as binary.
fn text_message(
    message: &[u8],
    suffix: &str,
    is_signer: impl Fn(&str) -> bool,
    ctx: &Context,
    out: &mut Vec<crate::Finding>,
) {
    let Ok(text) = std::str::from_utf8(message) else {
        return binary(message, out);
    };
    if as_text(message).is_none() {
        if message.len() == 32 {
            binary(message, out);
        } else {
            out.push(finding(
                "message_control_characters",
                Level::Amber,
                "The message has hidden control characters.".into(),
                json!({ "bytes": message.len() }),
            ));
        }
    }
    sign_in(text, suffix, is_signer, ctx, out);
}

/// Grade a `personal_sign` message.
pub fn personal_message(message: &[u8], signer: &EthAddress, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    text_message(
        message,
        SIWE_SUFFIX,
        |a| EthAddress::parse_hex(a).ok() == Some(*signer),
        ctx,
        &mut out,
    );
    Assessment::from(out)
}

/// Grade a Solana `signMessage` message, signed by `signer` (base58). The vault refuses bytes
/// that are a Solana transaction this key signs before they get here.
pub fn solana_message(message: &[u8], signer: &str, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    text_message(message, SIWS_SUFFIX, |a| a == signer, ctx, &mut out);
    Assessment::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

    fn me() -> EthAddress {
        EthAddress::parse_hex(ME).unwrap()
    }

    fn rule(message: &[u8], origin: Option<&str>) -> Option<&'static str> {
        let ctx = Context {
            origin: origin.map(Into::into),
            origin_known: true,
            ..Default::default()
        };
        personal_message(message, &me(), &ctx).findings.first().map(|f| f.rule)
    }

    #[test]
    fn hashes_and_binary() {
        assert_eq!(rule(&[0xab; 32], None), Some("hash_signature"));
        assert_eq!(rule(&[0xff, 0xfe, 0], None), Some("binary_message"));
        assert_eq!(rule(b"hello", None), None);
    }

    #[test]
    fn arbitrary_messages() {
        let rule = |data: &[u8]| {
            arbitrary_message(
                data,
                &Context {
                    origin_known: true,
                    ..Default::default()
                },
            )
            .findings
            .first()
            .map(|f| f.rule)
        };
        assert_eq!(rule(b"Sign in to example.org\nNonce: 42"), None);
        assert_eq!(rule(&[0xab; 32]), Some("hash_signature"));
        assert_eq!(rule(&[0xff, 0xfe, 0]), Some("binary_message"));
        // Shaped like transactions: amino and protobuf JSON, a TxRaw, EVM transactions.
        assert_eq!(rule(br#"{"chain_id":"injective-1","msgs":[]}"#), Some("arbitrary_tx"));
        assert_eq!(rule(br#"{"body":{"messages":[]}}"#), Some("arbitrary_tx"));
        let any = [&[0x0a, 0x1c][..], b"/cosmos.bank.v1beta1.MsgSend", &[0x12, 0x00]].concat();
        let body = [&[0x0a, any.len() as u8][..], &any].concat();
        let tx_raw = [&[0x0a, body.len() as u8][..], &body, &[0x12, 0x02, 0x0a, 0x00]].concat();
        assert_eq!(rule(&tx_raw), Some("arbitrary_tx"));
        assert_eq!(rule(&body), Some("arbitrary_tx"));
        assert_eq!(rule(&[0x02, 0xc3, 0x01, 0x02, 0x03]), Some("arbitrary_tx"));
        assert_eq!(rule(&[0xc3, 0x80, 0x80, 0x80]), Some("arbitrary_tx"));
        // Text that merely mentions a transaction is fine; JSON without tx keys too.
        assert_eq!(rule(br#"{"nonce":"42","domain":"example.org"}"#), None);
        assert_eq!(rule(&[0x02, 0xc3, 0x01]), Some("binary_message"));
    }

    /// F7: a control character in a sign-in message adds a note; it never takes the sign-in
    /// rules away.
    #[test]
    fn control_characters_never_skip_the_sign_in_rules() {
        let siwe = |statement: &str, tail: &str| {
            format!(
                "victim.example{SIWE_SUFFIX}\n{ME}\n\n{statement}\n\nURI: https://victim.example/login\nVersion: 1\n\
                 Chain ID: 1\nNonce: abcdef123456\nIssued At: 2026-11-01T00:00:00.000Z{tail}"
            )
        };
        let rules = |m: &str| {
            let ctx = Context {
                origin: Some("https://evil.example".into()),
                origin_known: true,
                ..Default::default()
            };
            let a = personal_message(m.as_bytes(), &me(), &ctx);
            (a.level, a.findings.iter().map(|f| f.rule).collect::<Vec<_>>())
        };
        let plain = rules(&siwe("Sign in to Victim.", ""));
        assert_eq!(plain, (Level::Red, vec!["sign_in_wrong_site"]));
        for m in [siwe("Sign in to\u{b}Victim.", ""), siwe("Sign in to Victim.", "\n\u{85}")] {
            let (level, found) = rules(&m);
            assert_eq!(level, Level::Red, "{m:?}");
            assert!(found.contains(&"sign_in_wrong_site"), "{found:?}");
            assert!(found.contains(&"message_control_characters"), "{found:?}");
            assert!(!found.contains(&"binary_message"), "{found:?}");
        }
        // Solana's sign-in gets the same treatment.
        let siws = format!(
            "victim.example{SIWS_SUFFIX}\nHAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk\n\nSign in\u{b}.\n\nURI: https://victim.example"
        );
        let ctx = Context {
            origin: Some("https://evil.example".into()),
            origin_known: true,
            ..Default::default()
        };
        let a = solana_message(siws.as_bytes(), "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", &ctx);
        assert_eq!(a.level, Level::Red);
        assert!(a.findings.iter().any(|f| f.rule == "sign_in_wrong_site"));
        // Not UTF-8, or a 32-byte message that isn't plain text: still binary.
        assert_eq!(rule(&[0xff, 0xfe, 0], None), Some("binary_message"));
        assert_eq!(rule(&[0x0b; 32], None), Some("hash_signature"));
    }

    #[test]
    fn sign_in_must_match_the_site_and_account() {
        let siwe = |domain: &str, address: &str| format!("{domain}{SIWE_SUFFIX}\n{address}\n\nURI: https://{domain}");
        let ok = siwe("example.org", ME);
        assert_eq!(rule(ok.as_bytes(), Some("https://example.org")), Some("sign_in"));
        assert_eq!(
            rule(ok.as_bytes(), Some("https://examp1e.org")),
            Some("sign_in_wrong_site")
        );
        let other = siwe("example.org", "0x0000000000000000000000000000000000000001");
        assert_eq!(
            rule(other.as_bytes(), Some("https://example.org")),
            Some("sign_in_wrong_account")
        );
        let siws = |address: &str| format!("example.org{SIWS_SUFFIX}\n{address}\n\nURI: https://example.org");
        let solana = |m: String, origin: &str| {
            let ctx = Context {
                origin: Some(origin.into()),
                origin_known: true,
                ..Default::default()
            };
            solana_message(m.as_bytes(), "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", &ctx).findings[0].rule
        };
        assert_eq!(
            solana(
                siws("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
                "https://example.org"
            ),
            "sign_in"
        );
        assert_eq!(
            solana(
                siws("hagk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
                "https://example.org"
            ),
            "sign_in_wrong_account"
        );
        assert_eq!(
            solana(
                siws("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"),
                "https://evil.example"
            ),
            "sign_in_wrong_site"
        );
        let with_scheme = siwe("https://example.org", ME);
        assert_eq!(
            rule(with_scheme.as_bytes(), Some("https://example.org")),
            Some("sign_in")
        );
    }
}
