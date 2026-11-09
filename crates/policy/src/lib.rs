//! Risk rules: grade a decoded request before the user signs it.
//!
//! Each entry point takes what a decoder produced, plus a [`Context`] the host knows (the
//! site, balances, address book), and returns an [`Assessment`]: findings, each with a
//! level, a stable rule ID, one short sentence for the approval screen, and the facts
//! behind it for the UI to render (`params`).
//!
//! | Level | Meaning |
//! | --- | --- |
//! | `info` | Worth showing; nothing unusual |
//! | `amber` | Check before signing |
//! | `red` | Dangerous; some ask the user to type a word to continue (`confirm`) |
//! | `blocked` | Don't sign at all |
//!
//! The rules only see what was decoded. Anything a decoder couldn't read is red on its
//! own, so a gap in the decoders never shows as safe.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod addresses;
mod amounts;
mod cosmos;
mod evm;
mod message;
mod swap;
mod text;
mod typed;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use cosmos::{CosmosFee, cosmos};
pub use evm::evm_transaction;
pub use message::personal_message;
pub use typed::typed_data;

/// How risky something is. Ordered: `Info < Amber < Red < Blocked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    /// Worth showing; nothing unusual.
    Info,
    /// Check before signing.
    Amber,
    /// Dangerous.
    Red,
    /// Don't sign.
    Blocked,
}

/// One thing the rules found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    /// Stable rule ID, e.g. `authz_grant`, for the UI and for tests.
    pub rule: &'static str,
    /// How risky.
    pub level: Level,
    /// One short sentence for the approval screen.
    pub message: String,
    /// A word the user must type to continue, for the most dangerous findings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<&'static str>,
    /// The facts behind the finding (addresses, amounts in base units, …).
    pub params: Value,
}

/// Everything the rules found about one request.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Assessment {
    /// The highest level among the findings; `info` when there are none.
    pub level: Level,
    /// The word to type, if any finding needs one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<&'static str>,
    /// The findings, most severe first.
    pub findings: Vec<Finding>,
}

impl Assessment {
    fn from(mut findings: Vec<Finding>) -> Self {
        findings.sort_by_key(|f| std::cmp::Reverse(f.level));
        Self {
            level: findings.first().map_or(Level::Info, |f| f.level),
            confirm: findings.iter().find_map(|f| f.confirm),
            findings,
        }
    }
}

/// An entry in the user's address book.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    /// The address, in any form the chain accepts.
    pub address: String,
    /// The name the user gave it.
    #[serde(default)]
    pub name: String,
    /// The memo this address needs, as an exchange's deposit address credits deposits by
    /// it. Empty when it needs none.
    #[serde(default)]
    pub memo: String,
    /// One of the user's own accounts rather than a saved contact.
    #[serde(default)]
    pub mine: bool,
}

/// What the host knows that the request doesn't say. Everything is optional; rules that
/// need a missing fact don't fire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    /// The requesting site's origin (`https://choice.exchange`); `None` for the wallet's own
    /// screens.
    #[serde(default)]
    pub origin: Option<String>,
    /// The site has had a request approved before.
    #[serde(default)]
    pub origin_known: bool,
    /// The host's blocklist matched the site.
    #[serde(default)]
    pub origin_blocked: bool,
    /// The account's balances in base units, by token: a bank denom, a CW20 or ERC20
    /// contract address, or `native` for an EVM chain's coin.
    #[serde(default)]
    pub balances: BTreeMap<String, String>,
    /// The user's address book, and the user's own accounts.
    #[serde(default)]
    pub address_book: Vec<Contact>,
    /// Addresses the host found take deposits with a memo: most transfers they receive
    /// carry one, from many senders, as an exchange's shared deposit address does.
    #[serde(default)]
    pub memo_addresses: Vec<String>,
    /// Contracts this account has used before.
    #[serde(default)]
    pub known_contracts: Vec<String>,
    /// How to name tokens in messages ("INJ" rather than "inj"), by the same keys as
    /// `balances`. A token without one is named by its key.
    #[serde(default)]
    pub symbols: BTreeMap<String, String>,
}

impl Context {
    /// A token's name for messages.
    pub(crate) fn token_name<'a>(&'a self, token: &'a str) -> &'a str {
        self.symbols.get(token).map_or(token, String::as_str)
    }
}

fn finding(rule: &'static str, level: Level, message: String, params: Value) -> Finding {
    Finding {
        rule,
        level,
        message,
        confirm: None,
        params,
    }
}

/// Rules about the site itself, for every request.
fn site(ctx: &Context) -> Vec<Finding> {
    let mut out = Vec::new();
    let Some(origin) = &ctx.origin else {
        return out;
    };
    let params = serde_json::json!({ "origin": origin });
    if ctx.origin_blocked {
        out.push(finding(
            "site_blocked",
            Level::Blocked,
            "This site is on the blocklist.".into(),
            params,
        ));
    } else if !ctx.origin_known {
        out.push(finding(
            "site_new",
            Level::Amber,
            "First request from this site.".into(),
            params,
        ));
    }
    out
}
