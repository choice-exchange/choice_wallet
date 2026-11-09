//! Rules for EIP-712 typed data (`eth_signTypedData_v4`). Off-chain signatures are how most
//! EVM drains happen: a Permit or Permit2 signature hands over tokens without a transaction
//! the user ever sees.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_injective::eip712::Web3Tx;
use serde_json::{Value, json};

use crate::amounts::{UNLIMITED, parse};
use crate::cosmos::{CosmosFee, cosmos};
use crate::text::short;
use crate::{Assessment, Context, Finding, Level, finding, site};

const PERMIT2_TYPES: &[&str] = &[
    "PermitSingle",
    "PermitBatch",
    "PermitTransferFrom",
    "PermitBatchTransferFrom",
    "PermitWitnessTransferFrom",
    "PermitBatchWitnessTransferFrom",
];

/// Grade typed data. `injective_tx` is the decoded transaction when the typed data is an
/// Injective EIP-712 v2 transaction; then the Cosmos rules apply to its messages.
pub fn typed_data(td: &TypedData, injective_tx: Option<&Web3Tx>, signer: &EthAddress, ctx: &Context) -> Assessment {
    if let Some(tx) = injective_tx {
        let fee = CosmosFee {
            amount: &tx.fee.amount,
            granter: None,
            payer: tx.fee.payer.as_deref(),
        };
        return cosmos(&tx.messages, &signer.to_inj(), &tx.memo, fee, ctx);
    }
    let mut out = site(ctx);
    out.push(rule(td));
    Assessment::from(out)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn rule(td: &TypedData) -> Finding {
    let domain = td.domain();
    let app = domain.get("name").and_then(Value::as_str).unwrap_or("");
    let msg = td.message();
    let primary = td.primary_type();
    let contract = domain.get("verifyingContract").and_then(Value::as_str);

    if app == "Permit2" && PERMIT2_TYPES.contains(&primary) {
        let spender = text(msg, "spender").unwrap_or("someone");
        return finding(
            "permit2_signature",
            Level::Red,
            format!("{} could spend your tokens through Permit2.", short(spender)),
            json!({ "spender": spender, "primary_type": primary, "permit2": contract }),
        );
    }
    if primary == "Permit"
        && let Some(spender) = text(msg, "spender")
    {
        let s = short(spender);
        let params =
            json!({ "token": contract, "spender": spender, "value": msg.get("value"), "allowed": msg.get("allowed") });
        // DAI-style permits grant `allowed: true` with no amount.
        let unlimited = msg.get("allowed") == Some(&Value::Bool(true))
            || msg.get("value").and_then(parse).is_some_and(|v| v >= UNLIMITED);
        return if unlimited {
            finding(
                "unlimited_permit",
                Level::Red,
                format!("{s} could take ALL of this token, without a transaction from you."),
                params,
            )
        } else {
            finding(
                "permit",
                Level::Red,
                format!("{s} could spend this token up to the amount shown, without a transaction from you."),
                params,
            )
        };
    }
    if app == "Seaport" && primary == "OrderComponents" {
        return finding(
            "marketplace_listing",
            Level::Red,
            "Lists your NFTs or tokens for sale. Check every item and price.".into(),
            json!({ "marketplace": contract }),
        );
    }
    finding(
        "typed_data",
        Level::Info,
        if app.is_empty() {
            "Signs a structured message.".into()
        } else {
            format!("Signs a structured message for {app}.")
        },
        json!({ "app": app, "primary_type": primary, "contract": contract }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn td(domain: Value, primary: &str, types: Value, message: Value) -> TypedData {
        let mut all = json!({
            "EIP712Domain": [
                { "name": "name", "type": "string" },
                { "name": "verifyingContract", "type": "address" }
            ]
        });
        all.as_object_mut().unwrap().extend(types.as_object().unwrap().clone());
        TypedData::parse(
            &json!({ "types": all, "primaryType": primary, "domain": domain, "message": message }).to_string(),
        )
        .unwrap()
    }

    fn grade(t: &TypedData) -> Assessment {
        typed_data(t, None, &EthAddress::from_bytes([1; 20]), &Context::default())
    }

    const SPENDER: &str = "0x2222222222222222222222222222222222222222";
    const TOKEN: &str = "0x1111111111111111111111111111111111111111";

    #[test]
    fn permits() {
        let permit_types = json!({ "Permit": [
            { "name": "owner", "type": "address" },
            { "name": "spender", "type": "address" },
            { "name": "value", "type": "uint256" },
            { "name": "nonce", "type": "uint256" },
            { "name": "deadline", "type": "uint256" }
        ]});
        let permit = |value: &str| {
            td(
                json!({ "name": "USD Coin", "verifyingContract": TOKEN }),
                "Permit",
                permit_types.clone(),
                json!({ "owner": TOKEN, "spender": SPENDER, "value": value, "nonce": 0, "deadline": 1 }),
            )
        };
        let a = grade(&permit(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        ));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "unlimited_permit"));
        let a = grade(&permit("5"));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "permit"));
    }

    #[test]
    fn permit2_and_listings() {
        let t = td(
            json!({ "name": "Permit2", "verifyingContract": "0x000000000022D473030F116dDEE9F6B43aC78BA3" }),
            "PermitSingle",
            json!({ "PermitSingle": [
                { "name": "spender", "type": "address" },
                { "name": "sigDeadline", "type": "uint256" }
            ]}),
            json!({ "spender": SPENDER, "sigDeadline": 1 }),
        );
        assert_eq!(grade(&t).findings[0].rule, "permit2_signature");

        let t = td(
            json!({ "name": "Seaport", "verifyingContract": TOKEN }),
            "OrderComponents",
            json!({ "OrderComponents": [{ "name": "offerer", "type": "address" }] }),
            json!({ "offerer": TOKEN }),
        );
        assert_eq!(grade(&t).findings[0].rule, "marketplace_listing");

        let t = td(
            json!({ "name": "Some Dapp", "verifyingContract": TOKEN }),
            "Hello",
            json!({ "Hello": [{ "name": "text", "type": "string" }] }),
            json!({ "text": "hi" }),
        );
        let a = grade(&t);
        assert_eq!(
            (a.level, a.findings[0].message.as_str()),
            (Level::Info, "Signs a structured message for Some Dapp.")
        );
    }
}
