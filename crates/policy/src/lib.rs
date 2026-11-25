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
//! own, and a contract call it couldn't read is never below amber, so a gap in the
//! decoders never shows as safe.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod addresses;
mod amounts;
mod bridge;
mod cosmos;
mod evm;
mod message;
mod solana;
mod swap;
mod text;
mod typed;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use cosmos::{CosmosFee, cosmos};
pub use evm::{EvmSide, evm_transaction};
pub use message::{arbitrary_message, personal_message, solana_message};
pub use solana::{solana_transaction, token_mint as solana_token_mint};
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
    /// The address the user set to rescue this account to.
    #[serde(default)]
    pub rescue: bool,
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
    /// Recipients whose deposits the host couldn't read in time (or didn't look at, past
    /// how many it checks): whether they need a memo is unknown.
    #[serde(default)]
    pub memo_unchecked: Vec<String>,
    /// The site whose endpoint the host checked this request through: a chain it added
    /// that chainlist.org doesn't list, before the user set endpoints of their own. It can
    /// make what the review shows (balance, gas estimate, token) look safe.
    #[serde(default)]
    pub endpoint_from: Option<String>,
    /// A site's swap through Choice, weighed by the host: what its minimum could lose
    /// against the input, by Choice's prices. `None` for the wallet's own swaps, which the
    /// swap screen weighs itself.
    #[serde(default)]
    pub site_swap: Option<SiteSwap>,
    /// Contracts this account has used before.
    #[serde(default)]
    pub known_contracts: Vec<String>,
    /// ERC20 contracts the wallet itself vouches for in a request it built: the token of its
    /// own revoke, read from an ERC20 allowance it listed. Only there is `approve(spender, 0)`
    /// a revoke; on an ERC721 the same bytes approve `spender` for NFT #0. A site's request
    /// never carries these.
    #[serde(default)]
    pub erc20_contracts: Vec<String>,
    /// How to name tokens in messages ("INJ" rather than "inj"), by the same keys as
    /// `balances`. A token without one is named by its key.
    #[serde(default)]
    pub symbols: BTreeMap<String, String>,
    /// Solana token accounts the host looked up, by address: the owner and token its RPC
    /// says they hold. The rules call an owner checked only when the address derives from
    /// it.
    #[serde(default)]
    pub solana_token_accounts: BTreeMap<String, SolanaTokenAccount>,
    /// What the host's simulation of a Solana transaction shows it hands over, by comparing
    /// the account and its token accounts before and after. A program the vault can't read
    /// can do this without an instruction that says so.
    #[serde(default)]
    pub solana_handovers: Vec<SolanaHandover>,
    /// The host simulated a site's Solana transaction and it succeeded, so `solana_handovers`
    /// is what it showed. Otherwise nothing shows what a program the vault can't read does
    /// with the account, given its signature.
    #[serde(default)]
    pub solana_simulated: bool,
    /// A site's EVM transaction as the user's own node simulated it: every token, NFT and coin
    /// move it would make. `None` when it wasn't simulated. A contract the vault can't read
    /// can move tokens the account approved or deposited there; this is where that shows.
    #[serde(default)]
    pub evm_transfers: Option<Vec<EvmTransfer>>,
    /// The simulation had more than the host reads (too many logs, or a token move it couldn't
    /// parse): `evm_transfers` is then only part of what the transaction moves.
    #[serde(default)]
    pub evm_transfers_partial: bool,
    /// The addresses above in their forms, worked out once when the rules first need them.
    #[serde(skip)]
    pub(crate) address_forms: addresses::AddressForms,
}

/// One move in a simulated EVM transaction: an ERC20 or NFT `Transfer`, or a coin move.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvmTransfer {
    /// The token's contract (`0x…`, lowercase), or `native` for the chain's coin.
    pub token: String,
    /// Who it leaves, as a lowercase `0x…` address (the zero address mints).
    pub from: String,
    /// Who gets it, as a lowercase `0x…` address (the zero address burns).
    pub to: String,
    /// Base units (1 for an NFT).
    pub amount: String,
    /// An NFT move: an ERC-721 `Transfer` (the amount is one token) or an ERC-1155 transfer.
    #[serde(default)]
    pub nft: bool,
    /// The NFT's token ID.
    #[serde(default)]
    pub id: Option<String>,
}

/// Control of the account, or of one of its token accounts, passing to someone else.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolanaHandover {
    /// `assign` (the account's own program owner), `token_owner`, `delegate` or
    /// `close_authority`.
    pub kind: String,
    /// The token account, base58; none for `assign`.
    #[serde(default)]
    pub account: Option<String>,
    /// Its token (mint), base58.
    #[serde(default)]
    pub mint: Option<String>,
    /// Who gets it: the new program owner, owner, delegate or close authority.
    pub to: String,
    /// A delegate's amount covers all the account holds.
    #[serde(default)]
    pub all: bool,
    /// A delegate's allowance after the transaction, in base units.
    #[serde(default)]
    pub amount: Option<String>,
}

/// How the host weighed a site's swap.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteSwap {
    /// The share of the input's value the minimum could lose, in basis points (negative: a
    /// gain); `None` when either token can't be priced.
    #[serde(default)]
    pub lost_bps: Option<i64>,
}

/// A Solana token account as the host's RPC describes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolanaTokenAccount {
    /// The wallet that owns it, base58.
    pub owner: String,
    /// The token (mint), base58.
    pub mint: String,
}

impl Context {
    /// A token's name for messages.
    pub(crate) fn token_name<'a>(&'a self, token: &'a str) -> &'a str {
        self.symbols.get(token).map_or(token, String::as_str)
    }
}

/// Every finding's sentence goes through [`text::shown`]: whatever a site wrote into a name
/// it quotes, it can't hide or reorder the words around it.
fn finding(rule: &'static str, level: Level, message: String, params: Value) -> Finding {
    Finding {
        rule,
        level,
        message: text::shown(&message),
        confirm: None,
        params,
    }
}

/// Rules about the site itself, for every request.
fn site(ctx: &Context) -> Vec<Finding> {
    let mut out = Vec::new();
    // The wallet's own sends on such a chain too, not only the site's requests.
    if let Some(from) = &ctx.endpoint_from {
        let host = from.split_once("://").map_or(from.as_str(), |(_, h)| h);
        out.push(finding(
            "site_endpoint",
            Level::Amber,
            // An endpoint kept from an older version, which didn't record whose it was.
            if from == "unknown" {
                "Checked through an endpoint a site may have given. Set your own in Settings.".into()
            } else {
                format!(
                    "Checked through {}'s endpoint, which can make this look safe. Set your own in Settings.",
                    text::clip(host, 64)
                )
            },
            serde_json::json!({ "from": from }),
        ));
    }
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
