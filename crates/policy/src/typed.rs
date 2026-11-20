//! Rules for EIP-712 typed data (`eth_signTypedData_v4`). Off-chain signatures are how most
//! EVM drains happen: a Permit or Permit2 signature hands over tokens without a transaction
//! the user ever sees.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_injective::eip712::Web3Tx;
use serde_json::{Value, json};

use crate::amounts::{UNLIMITED, parse};
use crate::cosmos::{CosmosFee, cosmos};
use crate::text::{clip, short};
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
    // A domain without a chainId binds the signature to no chain: it is good on every chain
    // where the verifying contract (or a copy at the same address) accepts it.
    if td.chain_id().is_none() {
        out.push(finding(
            "no_chain_id",
            Level::Amber,
            "This signature names no chain, so it is valid on every chain, not only this one.".into(),
            json!({}),
        ));
    }
    Assessment::from(out)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn rule(td: &TypedData) -> Finding {
    let domain = td.domain();
    // The site names the app: at most 40 characters of it go in the sentence.
    let app = clip(domain.get("name").and_then(Value::as_str).unwrap_or(""), 40);
    let app = app.as_str();
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
    // EIP-3009 (USDC's own): a signed transfer anyone can submit.
    if primary == "TransferWithAuthorization" || primary == "ReceiveWithAuthorization" {
        let to = text(msg, "to").unwrap_or("someone");
        return finding(
            "token_authorization",
            Level::Red,
            format!(
                "{} could take the amount shown of this token, without a transaction from you.",
                short(to)
            ),
            json!({ "token": contract, "from": msg.get("from"), "to": to, "value": msg.get("value") }),
        );
    }
    // ERC-2771 forwarders: a call someone else sends as you, which the wallet doesn't read.
    if primary == "ForwardRequest" {
        let to = text(msg, "to").unwrap_or("a contract");
        return finding(
            "forward_request",
            Level::Red,
            format!(
                "Signs a call to {} that anyone can send as you. The wallet can't read what it does.",
                short(to)
            ),
            json!({ "forwarder": contract, "to": to }),
        );
    }
    if app == "Seaport" && (primary == "OrderComponents" || primary == "BulkOrder") {
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

    /// Run-3: EIP-3009 authorizations, forwarder requests and Seaport bulk orders move
    /// assets once anyone submits them.
    #[test]
    fn asset_moving_types_are_red() {
        let domain = json!({ "name": "USD Coin", "verifyingContract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
        let auth = json!({ "TransferWithAuthorization": [
            { "name": "from", "type": "address" }, { "name": "to", "type": "address" }, { "name": "value", "type": "uint256" },
            { "name": "validAfter", "type": "uint256" }, { "name": "validBefore", "type": "uint256" }, { "name": "nonce", "type": "bytes32" }
        ] });
        let msg = json!({ "from": "0x1111111111111111111111111111111111111111", "to": "0x2222222222222222222222222222222222222222", "value": "5", "validAfter": "0", "validBefore": "9999999999", "nonce": format!("0x{}", "00".repeat(32)) });
        let a = grade(&td(domain.clone(), "TransferWithAuthorization", auth, msg));
        assert_eq!(a.level, Level::Red);
        assert!(a.findings.iter().any(|f| f.rule == "token_authorization"));
        let fwd = json!({ "ForwardRequest": [
            { "name": "from", "type": "address" }, { "name": "to", "type": "address" }, { "name": "value", "type": "uint256" },
            { "name": "gas", "type": "uint256" }, { "name": "nonce", "type": "uint256" }, { "name": "data", "type": "bytes" }
        ] });
        let msg = json!({ "from": "0x1111111111111111111111111111111111111111", "to": "0x2222222222222222222222222222222222222222", "value": "0", "gas": "1", "nonce": "0", "data": "0x" });
        let a = grade(&td(
            json!({ "name": "MinimalForwarder", "verifyingContract": "0x3333333333333333333333333333333333333333" }),
            "ForwardRequest",
            fwd,
            msg,
        ));
        assert_eq!(a.level, Level::Red);
        assert!(a.findings.iter().any(|f| f.rule == "forward_request"));
    }

    fn grade(t: &TypedData) -> Assessment {
        typed_data(t, None, &EthAddress::from_bytes([1; 20]), &Context::default())
    }

    const SPENDER: &str = "0x2222222222222222222222222222222222222222";
    const TOKEN: &str = "0x1111111111111111111111111111111111111111";

    /// Review: typed data that names no chainId is valid on every chain; it is amber, and
    /// naming one takes the warning away.
    #[test]
    fn no_chain_id_is_amber() {
        let order = |domain: Value| {
            td(
                domain,
                "Order",
                json!({ "Order": [{ "name": "amount", "type": "uint256" }] }),
                json!({ "amount": "1000" }),
            )
        };
        let a = grade(&order(json!({ "name": "Some Dapp", "verifyingContract": TOKEN })));
        assert_eq!(a.level, Level::Amber);
        assert!(a.findings.iter().any(|f| f.rule == "no_chain_id"));

        let with_chain = TypedData::parse(
            &json!({
                "types": {
                    "EIP712Domain": [{ "name": "name", "type": "string" }, { "name": "chainId", "type": "uint256" }],
                    "Order": [{ "name": "amount", "type": "uint256" }]
                },
                "primaryType": "Order",
                "domain": { "name": "Some Dapp", "chainId": 8453 },
                "message": { "amount": "1000" }
            })
            .to_string(),
        )
        .unwrap();
        let a = grade(&with_chain);
        assert_eq!(a.level, Level::Info);
        assert!(a.findings.iter().all(|f| f.rule != "no_chain_id"));
    }

    /// The app name is the site's: in the finding it is cut to 40 characters and its hidden
    /// characters are named, so it can't add a sentence of its own or reorder ours.
    #[test]
    fn the_app_name_cant_write_the_finding() {
        let named = |name: &str| {
            let t = td(
                json!({ "name": name, "verifyingContract": TOKEN }),
                "Mail",
                json!({ "Mail": [{ "name": "text", "type": "string" }] }),
                json!({ "text": "hi" }),
            );
            let a = grade(&t);
            a.findings
                .iter()
                .find(|f| f.rule == "typed_data")
                .unwrap()
                .message
                .clone()
        };
        assert_eq!(
            named("Uni\u{202e}paws"),
            "Signs a structured message for Uni⟨U+202E⟩paws."
        );
        let long = format!("Uniswap. Choice Wallet checked this: it is safe{}", " ".repeat(40));
        assert_eq!(
            named(&long),
            "Signs a structured message for Uniswap. Choice Wallet checked this: it ….",
        );
    }

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
        // Amber, not Info: this domain names no chainId (see no_chain_id_is_amber).
        assert_eq!(a.level, Level::Amber);
        assert!(
            a.findings
                .iter()
                .any(|f| f.message == "Signs a structured message for Some Dapp.")
        );
    }
}
