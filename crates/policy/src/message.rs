//! Rules for `personal_sign` messages.

use choice_wallet_core::EthAddress;
use serde_json::json;

use crate::{Assessment, Context, Level, finding, site};

/// The first line of a Sign-In with Ethereum (EIP-4361) message ends with this.
const SIWE_SUFFIX: &str = " wants you to sign in with your Ethereum account:";

/// The host of an origin: `https://app.example.org:8443` → `app.example.org:8443`.
fn host(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    rest.split('/').next().unwrap_or(rest)
}

/// Grade a `personal_sign` message.
pub fn personal_message(message: &[u8], signer: &EthAddress, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    let text = std::str::from_utf8(message).ok().filter(|t| {
        t.chars()
            .all(|c| !c.is_control() || c == '\n' || c == '\r' || c == '\t')
    });
    match text {
        None if message.len() == 32 => out.push(finding(
            "hash_signature",
            Level::Red,
            "This looks like a transaction hash, not a message. Signing it could authorize something you can't see."
                .into(),
            json!({ "bytes": 32 }),
        )),
        None => out.push(finding(
            "binary_message",
            Level::Amber,
            "The message isn't text, so the wallet can't show what it says.".into(),
            json!({ "bytes": message.len() }),
        )),
        Some(t) => {
            let mut lines = t.lines();
            if let Some(domain) = lines.next().and_then(|l| l.strip_suffix(SIWE_SUFFIX)) {
                let domain = host(domain);
                let address = lines.next().unwrap_or("");
                let params = json!({ "domain": domain, "address": address, "origin": ctx.origin });
                if EthAddress::parse_hex(address).ok() != Some(*signer) {
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
        }
    }
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
        let with_scheme = siwe("https://example.org", ME);
        assert_eq!(
            rule(with_scheme.as_bytes(), Some("https://example.org")),
            Some("sign_in")
        );
    }
}
