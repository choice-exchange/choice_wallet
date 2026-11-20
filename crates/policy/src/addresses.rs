//! Recipients against the address book: known contacts, and lookalikes (address poisoning:
//! an attacker sends dust from an address whose start and end match one the user uses, so
//! it shows up in history and gets copied by mistake).

use std::cell::OnceCell;

use choice_wallet_core::address::parse_injective;
use serde_json::json;

use crate::text::short;
use crate::{Contact, Context, Finding, Level, finding};

/// Longer than any form of an address (bech32's limit is 90 characters): such a string is
/// no address, matches only itself and looks like nothing, and never reaches a decoder.
const MAX_ADDRESS: usize = 128;

fn too_long(addr: &str) -> bool {
    // Trimmed: a padded address is still read as the address it is. Padding costs only one
    // trim per call now that the book's forms are made once (run-2 C7).
    addr.trim().len() > MAX_ADDRESS
}

/// The address book's entries, the known contracts and the memo addresses in their forms,
/// made once per assessment (run-2 C7): grading a request then costs a form of each
/// address it names, not one per address per entry. Kept on the `Context`, which is made
/// for one assessment.
#[derive(Default)]
pub struct AddressForms(OnceCell<Forms>);

struct Forms {
    /// Each book entry's forms, canonical first, with their bodies.
    book: Vec<Vec<(String, String)>>,
    contracts: Vec<String>,
    memos: Vec<String>,
    unchecked: Vec<String>,
}

// Derived data: a copy works it out again, and it never makes two contexts differ.
impl Clone for AddressForms {
    fn clone(&self) -> Self {
        Self::default()
    }
}
impl PartialEq for AddressForms {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl Eq for AddressForms {}
impl std::fmt::Debug for AddressForms {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AddressForms")
    }
}

fn forms_of(ctx: &Context) -> &Forms {
    ctx.address_forms.0.get_or_init(|| Forms {
        book: ctx
            .address_book
            .iter()
            .map(|c| with_bodies(forms(&c.address)))
            .collect(),
        contracts: ctx.known_contracts.iter().map(|c| canonical(c)).collect(),
        memos: ctx.memo_addresses.iter().map(|a| canonical(a)).collect(),
        unchecked: ctx.memo_unchecked.iter().map(|a| canonical(a)).collect(),
    })
}

fn with_bodies(forms: Vec<String>) -> Vec<(String, String)> {
    forms
        .into_iter()
        .map(|f| {
            let b = body(&f).to_owned();
            (f, b)
        })
        .collect()
}

/// The forms an address is shown in. An Injective account has two (`inj1…` and `0x…`) and
/// a poisoner can target either.
fn forms(addr: &str) -> Vec<String> {
    if too_long(addr) {
        return vec![addr.trim().to_owned()];
    }
    match parse_injective(addr) {
        Ok(a) => vec![a.to_inj(), a.to_checksum_hex().to_lowercase()],
        // Base58 is case-sensitive: two Solana addresses that differ only in case differ.
        Err(_) if solana(addr) => vec![addr.trim().to_owned()],
        Err(_) => vec![addr.trim().to_lowercase()],
    }
}

/// A Solana address (32 bytes in base58).
fn solana(addr: &str) -> bool {
    choice_wallet_core::base58::decode32(addr.trim()).is_some()
}

/// One canonical form, for equality.
fn canonical(addr: &str) -> String {
    forms(addr).swap_remove(0)
}

pub(crate) fn same(a: &str, b: &str) -> bool {
    if too_long(a) || too_long(b) {
        return a.trim() == b.trim();
    }
    canonical(a) == canonical(b)
}

/// The part after `0x` or after a bech32 prefix's `1`; all of a Solana address.
fn body(form: &str) -> &str {
    if solana(form) {
        return form;
    }
    form.strip_prefix("0x")
        .or_else(|| form.rfind('1').map(|i| &form[i + 1..]))
        .unwrap_or(form)
}

/// Two bodies with the same first and last four bytes, whatever the lengths: a Solana
/// address can be a character shorter or longer and still look the same. Compared as
/// bytes: a site's string may hold any character, and slicing it by byte offset must never
/// panic.
fn alike(x: &str, y: &str) -> bool {
    let (x, y) = (x.as_bytes(), y.as_bytes());
    x.len() > 8 && y.len() > 8 && x[..4] == y[..4] && x[x.len() - 4..] == y[y.len() - 4..]
}

fn contact<'a>(ctx: &'a Context, addr: &str) -> Option<&'a Contact> {
    let want = canonical(addr);
    let i = forms_of(ctx).book.iter().position(|f| f[0].0 == want)?;
    ctx.address_book.get(i)
}

/// How the user knows `addr` if it is theirs: one of their accounts, or their rescue
/// address. Rewards, stakes and fee allowances going there stay in the user's hands.
pub(crate) fn own_name(ctx: &Context, addr: &str) -> Option<String> {
    let c = contact(ctx, addr).filter(|c| c.mine || c.rescue)?;
    Some(match (c.rescue, c.name.is_empty()) {
        (true, true) => "your rescue address".into(),
        (true, false) => format!("your rescue address ({})", c.name),
        (false, true) => format!("your account {}", short(addr)),
        (false, false) => format!("your account {}", c.name),
    })
}

fn lookalike<'a>(ctx: &'a Context, addr: &str) -> Option<&'a Contact> {
    if too_long(addr) {
        return None;
    }
    let mine = with_bodies(forms(addr));
    let i = forms_of(ctx)
        .book
        .iter()
        .position(|theirs| mine.iter().any(|(_, m)| theirs.iter().any(|(_, t)| alike(m, t))))?;
    ctx.address_book.get(i)
}

/// Findings about sending to `to`. `memo` is the transaction's memo, or `None` where the
/// transaction can't carry one (EVM): an exchange's shared deposit address credits a
/// deposit by its memo, and one without is at best a support ticket.
pub(crate) fn recipient(ctx: &Context, to: &str, memo: Option<&str>, out: &mut Vec<Finding>) {
    let found = contact(ctx, to);
    if let Some(c) = found {
        let name = if c.name.is_empty() { short(to) } else { c.name.clone() };
        out.push(finding(
            "address_book",
            Level::Info,
            if c.rescue {
                format!("To {}.", own_name(ctx, to).unwrap_or_default())
            } else if c.mine {
                format!("To your account {name}.")
            } else {
                format!("To {name} from your address book.")
            },
            json!({ "address": to, "name": c.name, "mine": c.mine }),
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
    memo_rules(ctx, to, found, memo, out);
}

fn memo_rules(ctx: &Context, to: &str, found: Option<&Contact>, memo: Option<&str>, out: &mut Vec<Finding>) {
    let saved = found.map(|c| c.memo.trim()).filter(|m| !m.is_empty());
    let seen = forms_of(ctx).memos.contains(&canonical(to));
    if saved.is_none() && !seen {
        // Not known to need one, but not known not to: said when the send has no memo.
        let unchecked = found.is_none_or(|c| !c.mine) && forms_of(ctx).unchecked.contains(&canonical(to));
        let carries = memo.map(str::trim).is_some_and(|m| !m.is_empty());
        if unchecked && !carries {
            out.push(finding(
                "memo_unchecked",
                Level::Amber,
                format!(
                    "Couldn't check whether {} is an exchange, which needs a memo. {}",
                    short(to),
                    if memo.is_none() {
                        "An EVM send can't carry one."
                    } else {
                        "This send has none."
                    }
                ),
                json!({ "address": to }),
            ));
        }
        return;
    }
    let named = found.filter(|c| !c.name.is_empty()).map(|c| c.name.clone());
    let params = json!({ "address": to, "name": named, "memo": saved });
    // Who needs it, and why the wallet thinks so.
    let needs = match (saved, &named) {
        (Some(m), Some(n)) => format!("{n} needs memo {m}"),
        (Some(m), None) => format!("{} needs memo {m}", short(to)),
        (None, _) => format!(
            "{} looks like an exchange: its deposits carry a memo",
            named.clone().unwrap_or_else(|| short(to))
        ),
    };
    match memo.map(str::trim) {
        None => out.push(finding(
            "memo_unsupported",
            Level::Red,
            format!("{needs}, which an EVM send can't carry."),
            params,
        )),
        Some("") => out.push(finding(
            "memo_missing",
            Level::Red,
            format!("{needs}. This send has none."),
            params,
        )),
        Some(m) if saved.is_some_and(|s| s != m) => out.push(finding(
            "memo_differs",
            Level::Amber,
            format!(
                "The memo isn't the one saved for {}.",
                named.unwrap_or_else(|| short(to))
            ),
            json!({ "address": to, "memo": m, "saved": saved }),
        )),
        Some(_) => {}
    }
}

pub(crate) fn known_contract(ctx: &Context, addr: &str) -> bool {
    forms_of(ctx).contracts.contains(&canonical(addr))
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
                    ..Default::default()
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
        recipient(&c, &a.to_checksum_hex(), Some(""), &mut out);
        assert_eq!(out[0].rule, "address_book");
    }

    #[test]
    fn lookalikes_are_flagged() {
        let real = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
        let fake = "0x5aaeFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFeAed";
        let mut out = vec![];
        recipient(&ctx(&[real]), fake, Some(""), &mut out);
        assert_eq!(out[0].rule, "lookalike_address");
        assert_eq!(out[0].level, Level::Amber);
        // Unrelated addresses say nothing.
        let mut out = vec![];
        recipient(
            &ctx(&[real]),
            "0x0000000000000000000000000000000000000001",
            Some(""),
            &mut out,
        );
        assert!(out.is_empty());
    }

    /// F5: a site's address field is any string up to the request cap. Grading one far
    /// longer than any address against a full address book must stay cheap (base58 decoding
    /// costs the square of the length).
    #[test]
    fn a_huge_site_address_is_graded_quickly() {
        let mut book: Vec<String> = (0..100u8).map(|i| EthAddress::from_bytes([i; 20]).to_inj()).collect();
        book.extend((0..100u8).map(|i| choice_wallet_core::base58::encode(&[i | 1; 32])));
        let c = ctx(&book.iter().map(String::as_str).collect::<Vec<_>>());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let to = "2".repeat(999_000);
            let mut out = vec![];
            recipient(&c, &to, Some(""), &mut out);
            tx.send(out.len()).unwrap();
        });
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)), Ok(0));
        // A Solana address in the book is still matched, and its lookalike flagged.
        let real = choice_wallet_core::base58::encode(&[7; 32]);
        let mut fake = real.clone().into_bytes();
        fake[10] = if fake[10] == b'2' { b'3' } else { b'2' };
        let fake = String::from_utf8(fake).unwrap();
        assert_eq!(rules(&ctx(&[&real]), &real, None)[0].0, "address_book");
        assert_eq!(rules(&ctx(&[&real]), &fake, None)[0].0, "lookalike_address");
        // Hardening: a Solana address one character shorter, the same at both ends, is
        // still a lookalike (both are 32 bytes: 44 and 43 characters).
        let long = format!("9AAA{}WXYZ", "2".repeat(36));
        let short = format!("9AAA{}WXYZ", "2".repeat(35));
        assert!(
            choice_wallet_core::base58::decode32(&long).is_some()
                && choice_wallet_core::base58::decode32(&short).is_some()
        );
        assert_eq!(rules(&ctx(&[&long]), &short, None)[0].0, "lookalike_address");
        assert_eq!(rules(&ctx(&[&short]), &long, None)[0].0, "lookalike_address");
    }

    /// Run-2 C7: a request naming thousands of addresses, against a full address book, costs
    /// one form per address it names: the book's forms are worked out once per assessment.
    #[test]
    fn many_addresses_against_a_full_book_are_graded_quickly() {
        let mut book: Vec<String> = (0..150u8).map(|i| EthAddress::from_bytes([i; 20]).to_inj()).collect();
        book.extend((0..150u8).map(|i| EthAddress::from_bytes([i; 20]).to_checksum_hex()));
        book.push(choice_wallet_core::base58::encode(&[7; 32]));
        let c = ctx(&book.iter().map(String::as_str).collect::<Vec<_>>());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut found = 0;
            for i in 0..2_000u32 {
                let mut bytes = [0xee; 20];
                bytes[..4].copy_from_slice(&i.to_be_bytes());
                let mut out = vec![];
                recipient(&c, &EthAddress::from_bytes(bytes).to_inj(), Some(""), &mut out);
                found += out.len();
            }
            // Still matched in either form.
            let mut out = vec![];
            recipient(
                &c,
                &EthAddress::from_bytes([9; 20]).to_checksum_hex(),
                Some(""),
                &mut out,
            );
            tx.send((found, out.first().map(|f| f.rule))).unwrap();
        });
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(5)),
            Ok((0, Some("address_book")))
        );
    }

    /// F14: a 42-byte site address with a multibyte character where the body's last four
    /// bytes start must not panic (the vault aborts on a panic).
    #[test]
    fn a_multibyte_site_address_never_panics() {
        let me = EthAddress::from_bytes([0x33; 20]).to_inj();
        let body = &me[4..];
        // Across the body's fourth byte; and, with its first four bytes the contact's, across
        // its last four.
        for to in [
            format!("inj1{}é{}", &body[..3], "q".repeat(33)),
            format!("inj1{}{}é{}", &body[..4], "q".repeat(29), "qqq"),
        ] {
            assert_eq!(to.len(), me.len());
            assert!(rules(&ctx(&[&me]), &to, None).is_empty(), "{to}");
        }
    }

    fn rules(ctx: &Context, to: &str, memo: Option<&str>) -> Vec<(&'static str, Level, String)> {
        let mut out = vec![];
        recipient(ctx, to, memo, &mut out);
        out.into_iter().map(|f| (f.rule, f.level, f.message)).collect()
    }

    #[test]
    fn own_accounts_are_named_as_yours() {
        let a = EthAddress::from_bytes([0x22; 20]).to_inj();
        let c = Context {
            address_book: vec![Contact {
                address: a.clone(),
                name: "Savings".into(),
                mine: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(rules(&c, &a, Some(""))[0].2, "To your account Savings.");
    }

    /// Review of #8: a recipient whose deposits the host couldn't read is amber when the send
    /// carries no memo, and quiet when it carries one.
    #[test]
    fn an_unchecked_recipient_is_said() {
        let them = EthAddress::from_bytes([0x44; 20]);
        let c = Context {
            memo_unchecked: vec![them.to_inj()],
            ..Default::default()
        };
        let r = rules(&c, &them.to_inj(), Some(""));
        assert_eq!((r[0].0, r[0].1), ("memo_unchecked", Level::Amber));
        assert!(r[0].2.ends_with("This send has none."), "{}", r[0].2);
        let r = rules(&c, &them.to_checksum_hex(), None);
        assert_eq!(r[0].0, "memo_unchecked");
        assert!(r[0].2.ends_with("An EVM send can't carry one."), "{}", r[0].2);
        assert!(rules(&c, &them.to_inj(), Some("42")).is_empty());
        // Someone else: nothing.
        assert!(rules(&c, &EthAddress::from_bytes([0x45; 20]).to_inj(), Some("")).is_empty());
    }

    #[test]
    fn exchange_memos() {
        let exchange = EthAddress::from_bytes([0x33; 20]).to_inj();
        let saved = Context {
            address_book: vec![Contact {
                address: exchange.clone(),
                name: "My exchange".into(),
                memo: "101234567".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        // The saved memo: just the contact.
        assert_eq!(rules(&saved, &exchange, Some(" 101234567 ")).len(), 1);
        // None at all: red.
        let r = rules(&saved, &exchange, Some(""));
        assert_eq!((r[1].0, r[1].1), ("memo_missing", Level::Red));
        assert_eq!(r[1].2, "My exchange needs memo 101234567. This send has none.");
        // Another memo: amber.
        let r = rules(&saved, &exchange, Some("999"));
        assert_eq!((r[1].0, r[1].1), ("memo_differs", Level::Amber));
        // An EVM send can't carry one, in either address form.
        let hex = EthAddress::from_bytes([0x33; 20]).to_checksum_hex();
        let r = rules(&saved, &hex, None);
        assert_eq!((r[1].0, r[1].1), ("memo_unsupported", Level::Red));

        // Found from the chain, not saved: any memo will do, none won't.
        let seen = Context {
            memo_addresses: vec![hex.clone()],
            ..Default::default()
        };
        assert!(rules(&seen, &exchange, Some("42")).is_empty());
        let r = rules(&seen, &exchange, Some(""));
        assert_eq!(r[0].0, "memo_missing");
        assert!(r[0].2.contains("looks like an exchange"), "{}", r[0].2);
        assert_eq!(rules(&seen, &exchange, None)[0].0, "memo_unsupported");
        // Other addresses: nothing.
        assert!(rules(&seen, &EthAddress::from_bytes([0x44; 20]).to_inj(), Some("")).is_empty());
    }
}
