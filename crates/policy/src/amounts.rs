//! Amounts leaving the account, against its balances.

use std::collections::BTreeMap;

use choice_wallet_core::address::parse_injective;
use choice_wallet_evm::U256;
use serde_json::{Value, json};

use crate::{Context, Finding, Level, finding};

/// 2^100: amounts at or above this are treated as unlimited. It's above any real balance
/// of an 18-decimal token (10^12 tokens), and below the sentinels dapps use (2^128 - 1,
/// 2^160 - 1, 2^256 - 1).
pub(crate) const UNLIMITED: U256 = {
    let mut b = [0u8; 32];
    b[19] = 1 << 4;
    U256::from_be_bytes(b)
};

/// Decimal string, `0x` hex, or a JSON number.
pub(crate) fn parse(v: &Value) -> Option<U256> {
    match v {
        Value::String(s) => match s.strip_prefix("0x") {
            Some(h) if !h.is_empty() && h.len() <= 64 => {
                let trimmed = h.trim_start_matches('0');
                U256::from_quantity(&format!("0x{}", if trimmed.is_empty() { "0" } else { trimmed })).ok()
            }
            Some(_) => None,
            None => U256::from_dec_str(s).ok(),
        },
        Value::Number(n) => n.as_u64().map(|n| U256::from_u128(n.into())),
        _ => None,
    }
}

fn key(token: &str) -> String {
    match parse_injective(token) {
        Ok(a) => a.to_checksum_hex().to_lowercase(),
        Err(_) => token.to_owned(),
    }
}

pub(crate) fn balance(ctx: &Context, token: &str) -> Option<U256> {
    let k = key(token);
    ctx.balances
        .iter()
        .find(|(t, _)| key(t) == k)
        .and_then(|(_, a)| U256::from_dec_str(a).ok())
}

/// Totals per token.
#[derive(Default)]
pub(crate) struct Outflows(BTreeMap<String, (String, U256)>);

impl Outflows {
    pub(crate) fn add(&mut self, token: &str, amount: U256) {
        let entry = self
            .0
            .entry(key(token))
            .or_insert_with(|| (token.to_owned(), U256::ZERO));
        entry.1 = entry.1.checked_add(&amount).unwrap_or(U256::MAX);
    }

    pub(crate) fn add_str(&mut self, token: &str, amount: &str) {
        if let Ok(a) = U256::from_dec_str(amount) {
            self.add(token, a);
        }
    }

    /// Amber when a token's total is more than half its balance.
    pub(crate) fn check(&self, ctx: &Context, out: &mut Vec<Finding>) {
        for (token, total) in self.0.values() {
            let Some(bal) = balance(ctx, token) else {
                continue;
            };
            let params = json!({ "token": token, "amount": total.to_string(), "balance": bal.to_string() });
            if *total > bal {
                out.push(finding(
                    "more_than_balance",
                    Level::Amber,
                    format!("Spends more {token} than this account holds, so it will likely fail."),
                    params,
                ));
            } else if total.checked_add(total).is_none_or(|double| double > bal) {
                out.push(finding(
                    "most_of_balance",
                    Level::Amber,
                    format!("Sends more than half of this account's {token}."),
                    params,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_threshold() {
        assert_eq!(UNLIMITED.to_string(), "1267650600228229401496703205376");
        assert!(parse(&json!("0xffffffffffffffffffffffffffffffffffffffff")).unwrap() > UNLIMITED);
        assert!(parse(&json!("1000000000000000000000000")).unwrap() < UNLIMITED);
        assert_eq!(parse(&json!(5)), Some(U256::from_u128(5)));
        assert_eq!(parse(&json!("0x0005")), Some(U256::from_u128(5)));
        assert_eq!(parse(&json!("05")), None);
    }

    #[test]
    fn half_and_over_balance() {
        let ctx = Context {
            balances: [("inj".to_owned(), "100".to_owned())].into(),
            ..Default::default()
        };
        let check = |amounts: &[&str]| {
            let mut o = Outflows::default();
            for a in amounts {
                o.add_str("inj", a);
            }
            let mut out = vec![];
            o.check(&ctx, &mut out);
            out.first().map(|f| f.rule)
        };
        assert_eq!(check(&["50"]), None);
        assert_eq!(check(&["30", "21"]), Some("most_of_balance"));
        assert_eq!(check(&["101"]), Some("more_than_balance"));
    }
}
