//! Rules for swaps through Choice's aggregator or router (`choice_wallet_injective::choice`),
//! whoever built them: the wallet's own swap screen or a site.
//!
//! What a swap can't hide from its calldata, and is held to here:
//! - who receives the output (the aggregator names a recipient; the router pays the caller);
//! - the minimum, the one guard on what arrives;
//! - the fee, and who gets it;
//! - adapters, contracts handed the input mid-route, which the aggregator doesn't allowlist;
//! - a Permit2 allowance signed into the transaction.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_injective::choice::{Choice, Executor, Swap, SwapError, Venue};
use serde_json::json;

use crate::amounts::UNLIMITED;
use crate::text::{date, short};
use crate::{Finding, Level, finding};

fn executor_name(e: Executor) -> &'static str {
    match e {
        Executor::Aggregator => "Choice's aggregator",
        Executor::UniversalRouter => "Choice's router",
    }
}

/// How the rules name an address Choice pins on this network, if they do.
pub(crate) fn known_name(choice: &Choice, a: &EthAddress) -> Option<&'static str> {
    if *a == choice.permit2() {
        Some("Permit2")
    } else {
        choice.executor(a).map(executor_name)
    }
}

/// Whether a swap pays its output to `from` (and so moves value without giving it away).
pub(crate) fn to_self(s: &Swap, from: &EthAddress) -> bool {
    s.recipient.is_none_or(|r| r == *from)
}

/// Findings about one Choice swap, sent from `from` with `value` attached.
pub(crate) fn swap(
    choice: &Choice,
    from: &EthAddress,
    value: U256,
    read: &Result<Swap, SwapError>,
    out: &mut Vec<Finding>,
) {
    let s = match read {
        Ok(s) => s,
        Err(e) => {
            out.push(finding(
                "swap_unreadable",
                Level::Red,
                "A call to Choice's swap contract that the wallet can't read.".into(),
                json!({ "reason": e.0 }),
            ));
            return;
        }
    };
    let who = executor_name(s.executor);
    let token = |a: &EthAddress| a.to_checksum_hex();
    out.push(finding(
        "swap",
        Level::Info,
        format!("A swap through {who}: at least the minimum shown arrives, or nothing happens."),
        json!({
            "executor": who,
            "token_in": token(&s.token_in),
            "token_out": token(&s.token_out),
            "amount_in": s.amount_in.to_string(),
            "minimum_out": s.minimum_out.to_string(),
        }),
    ));
    if let Some(r) = s.recipient
        && r != *from
    {
        let r = r.to_checksum_hex();
        out.push(finding(
            "swap_recipient",
            Level::Red,
            format!("This swap pays {}, not this account.", short(&r)),
            json!({ "recipient": r }),
        ));
    }
    if s.minimum_out.is_zero() {
        out.push(finding(
            "swap_no_minimum",
            Level::Red,
            "This swap has no minimum: it could return nothing.".into(),
            json!({}),
        ));
    }
    if s.fee_bps > 0 {
        let pct = format!("{}.{:02}%", s.fee_bps / 100, s.fee_bps % 100);
        let to = s.fee_recipient.map(|r| r.to_checksum_hex()).unwrap_or_default();
        let params = json!({ "fee_bps": s.fee_bps, "recipient": to });
        out.push(if s.fee_recipient == Some(choice.treasury()) {
            finding(
                "swap_fee",
                Level::Info,
                format!("Choice keeps {pct} of what this swap returns."),
                params,
            )
        } else {
            finding(
                "swap_fee_elsewhere",
                Level::Red,
                format!("{pct} of what this swap returns goes to {}.", short(&to)),
                params,
            )
        });
    }
    for v in &s.venues {
        if let Venue::Adapter { adapter } = v
            && !choice.trusts_adapter(adapter)
        {
            let a = adapter.to_checksum_hex();
            out.push(finding(
                "swap_adapter",
                Level::Red,
                format!(
                    "Hands your tokens to contract {} mid-swap, which the wallet doesn't know.",
                    short(&a)
                ),
                json!({ "adapter": a }),
            ));
        }
    }
    if s.executor == Executor::UniversalRouter && !value.is_zero() {
        out.push(finding(
            "swap_value",
            Level::Red,
            "Sends INJ that this swap doesn't use.".into(),
            json!({ "value": value.to_string() }),
        ));
    }
    if let Some(p) = &s.permit {
        let spender = p.spender.to_checksum_hex();
        let params = json!({
            "token": p.token.to_checksum_hex(),
            "spender": spender,
            "amount": p.amount.to_string(),
            "expiration": p.expiration,
        });
        let name = known_name(choice, &p.spender).map_or_else(|| short(&spender), str::to_owned);
        let until =
            i64::try_from(p.expiration).map_or_else(|_| "for good".to_owned(), |t| format!("until {}", date(t)));
        out.push(if choice.executor(&p.spender) != Some(s.executor) {
            finding(
                "permit2_signature",
                Level::Red,
                format!("Also lets {name} spend your tokens through Permit2."),
                params,
            )
        } else if p.amount >= UNLIMITED {
            finding(
                "unlimited_permit",
                Level::Red,
                format!("Also lets {name} take ALL of this token through Permit2, {until}."),
                params,
            )
        } else {
            finding(
                "permit2_allowance",
                Level::Amber,
                format!("Also lets {name} spend this token up to the amount shown, {until}."),
                params,
            )
        });
    }
}

/// Findings about `Permit2.approve(token, spender, amount, expiration)`.
pub(crate) fn permit2_approve(
    choice: Option<&Choice>,
    token: &EthAddress,
    spender: &EthAddress,
    amount: U256,
    expiration: u64,
) -> Finding {
    let s = spender.to_checksum_hex();
    let name = choice
        .and_then(|c| known_name(c, spender))
        .map_or_else(|| short(&s), str::to_owned);
    let params = json!({ "token": token.to_checksum_hex(), "spender": s, "amount": amount.to_string(), "expiration": expiration });
    if amount.is_zero() {
        return finding(
            "allowance_revoke",
            Level::Info,
            format!("Removes {name}'s Permit2 allowance for this token."),
            params,
        );
    }
    let until = i64::try_from(expiration).map_or_else(|_| "for good".to_owned(), |t| format!("until {}", date(t)));
    if amount >= UNLIMITED {
        finding(
            "permit2_allowance",
            Level::Red,
            format!("{name} could take ALL of this token through Permit2, {until}."),
            params,
        )
    } else {
        finding(
            "permit2_limited",
            Level::Amber,
            format!("{name} could spend this token through Permit2 up to the amount shown, {until}."),
            params,
        )
    }
}
