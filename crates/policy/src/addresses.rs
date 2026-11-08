//! Recipients against the address book: known contacts, and lookalikes (address poisoning:
//! an attacker sends dust from an address whose start and end match one the user uses, so
//! it shows up in history and gets copied by mistake).

use choice_wallet_core::address::parse_injective;
use serde_json::json;

use crate::text::short;
use crate::{Contact, Context, Finding, Level, finding};

/// The forms an address is shown in. An Injective account has two (`inj1…` and `0x…`) and
/// a poisoner can target either.
fn forms(addr: &str) -> Vec<String> {
    match parse_injective(addr) {
        Ok(a) => vec![a.to_inj(), a.to_checksum_hex().to_lowercase()],
        Err(_) => vec![addr.trim().to_lowercase()],
    }
}

/// One canonical form, for equality.
fn canonical(addr: &str) -> String {
    forms(addr).swap_remove(0)
}

pub(crate) fn same(a: &str, b: &str) -> bool {
    canonical(a) == canonical(b)
}

/// The part after `0x` or after a bech32 prefix's `1`.
fn body(form: &str) -> &str {
    form.strip_prefix("0x")
        .or_else(|| form.rfind('1').map(|i| &form[i + 1..]))
        .unwrap_or(form)
}

fn alike(a: &str, b: &str) -> bool {
    let (x, y) = (body(a), body(b));
    a.len() == b.len() && x.len() > 8 && x[..4] == y[..4] && x[x.len() - 4..] == y[y.len() - 4..]
}

fn contact<'a>(ctx: &'a Context, addr: &str) -> Option<&'a Contact> {
    ctx.address_book.iter().find(|c| same(&c.address, addr))
}

fn lookalike<'a>(ctx: &'a Context, addr: &str) -> Option<&'a Contact> {
    let mine = forms(addr);
    ctx.address_book.iter().find(|c| {
        let theirs = forms(&c.address);
        mine.iter().any(|m| theirs.iter().any(|t| alike(m, t)))
    })
}

/// Findings about sending to `to`.
pub(crate) fn recipient(ctx: &Context, to: &str, out: &mut Vec<Finding>) {
    if let Some(c) = contact(ctx, to) {
        out.push(finding(
            "address_book",
            Level::Info,
            format!(
                "To {} from your address book.",
                if c.name.is_empty() { short(to) } else { c.name.clone() }
            ),
            json!({ "address": to, "name": c.name }),
        ));
    } else if let Some(c) = lookalike(ctx, to) {
        out.push(finding(
            "lookalike_address",
            Level::Amber,
            format!(
                "{} looks like {} in your address book but isn't the same address.",
                short(to),
                if c.name.is_empty() {
                    short(&c.address)
                } else {
                    c.name.clone()
                }
            ),
            json!({ "address": to, "looks_like": c.address, "name": c.name }),
        ));
    }
}

pub(crate) fn known_contract(ctx: &Context, addr: &str) -> bool {
    ctx.known_contracts.iter().any(|c| same(c, addr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use choice_wallet_core::EthAddress;

    fn ctx(book: &[&str]) -> Context {
        Context {
            address_book: book
                .iter()
                .map(|a| Contact {
                    address: (*a).into(),
                    name: String::new(),
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn contacts_match_in_either_form() {
        let a = EthAddress::from_bytes([0x11; 20]);
        let c = ctx(&[&a.to_inj()]);
        let mut out = vec![];
        recipient(&c, &a.to_checksum_hex(), &mut out);
        assert_eq!(out[0].rule, "address_book");
    }

    #[test]
    fn lookalikes_are_flagged() {
        let real = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
        let fake = "0x5aaeFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFeAed";
        let mut out = vec![];
        recipient(&ctx(&[real]), fake, &mut out);
        assert_eq!(out[0].rule, "lookalike_address");
        assert_eq!(out[0].level, Level::Amber);
        // Unrelated addresses say nothing.
        let mut out = vec![];
        recipient(&ctx(&[real]), "0x0000000000000000000000000000000000000001", &mut out);
        assert!(out.is_empty());
    }
}
