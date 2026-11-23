//! Rules for EIP-712 typed data (`eth_signTypedData_v4`). Off-chain signatures are how most
//! EVM drains happen: a Permit or Permit2 signature hands over tokens without a transaction
//! the user ever sees.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_injective::chain::NETWORKS;
use choice_wallet_injective::eip712::Web3Tx;
use choice_wallet_injective::talis;
use serde_json::{Value, json};

use crate::amounts::{UNLIMITED, parse};
use crate::cosmos::{CosmosFee, cosmos};
use crate::text::{clip, short};
use crate::{Assessment, Context, Finding, Level, finding, site};
use choice_wallet_evm::U256;

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
    let app = td.domain().get("name").and_then(Value::as_str).unwrap_or("");
    if app == "Seaport" && td.primary_type() == "OrderComponents" {
        out.extend(seaport_order(td.message(), signer, ctx, on_talis(td)));
    } else {
        out.push(rule(td));
    }
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

/// A listing on Talis: an order for Seaport 1.6 on an Injective network's EVM chain that names
/// that network's Talis zone. Named only; what it gives and gets is graded as any order.
fn on_talis(td: &TypedData) -> bool {
    let addr = |v: Option<&Value>| v.and_then(Value::as_str).and_then(|s| EthAddress::parse_hex(s).ok());
    let Some(chain) = td.chain_id().and_then(|c| c.to_u64()) else {
        return false;
    };
    let zone = addr(td.message().get("zone"));
    // Only an order the zone must approve (FULL_RESTRICTED or PARTIAL_RESTRICTED) is Talis's.
    let restricted = td
        .message()
        .get("orderType")
        .and_then(parse)
        .and_then(|t| t.to_u64())
        .is_some_and(|t| t == 2 || t == 3);
    restricted
        && addr(td.domain().get("verifyingContract")) == Some(talis::seaport())
        && NETWORKS
            .iter()
            .any(|n| n.evm_chain_id == chain && zone == Some(n.talis.zone()))
}

/// A Seaport order (OpenSea's protocol, which Talis runs on Injective EVM), read item by item:
/// what the signer gives (`offer`), what comes back to them, and what goes to others
/// (`consideration`). Signing one lets anyone fulfil it until it ends, so it is never below
/// Amber; it is Red when the signer's items leave and nothing comes back to them (how a fake
/// "listing" drains a wallet), or when it gives away any NFT of a collection (criteria).
fn seaport_order(msg: &Value, signer: &EthAddress, ctx: &Context, talis: bool) -> Vec<Finding> {
    let unreadable = || {
        vec![finding(
            "marketplace_listing",
            Level::Red,
            "Signs a Seaport order the wallet can't read. Check every item and price.".into(),
            json!({}),
        )]
    };
    let (Some(offer), Some(consideration)) = (
        msg.get("offer").and_then(Value::as_array),
        msg.get("consideration").and_then(Value::as_array),
    ) else {
        return unreadable();
    };
    let me = signer.to_checksum_hex().to_lowercase();
    let coin = ctx.symbols.get("native").map_or("coin", String::as_str);
    let Some(gives) = offer
        .iter()
        .map(|i| SeaportItem::read(i, false))
        .collect::<Option<Vec<_>>>()
    else {
        return unreadable();
    };
    let Some(wants) = consideration
        .iter()
        .map(|i| SeaportItem::read(i, true))
        .collect::<Option<Vec<_>>>()
    else {
        return unreadable();
    };
    let mut out = Vec::new();
    if text(msg, "offerer").is_some_and(|o| o.to_lowercase() != me) {
        out.push(finding(
            "seaport_other_offerer",
            Level::Amber,
            format!(
                "The order is for {}, not this account.",
                short(text(msg, "offerer").unwrap_or(""))
            ),
            json!({ "offerer": msg.get("offerer") }),
        ));
    }
    let back: Vec<&SeaportItem> = wants
        .iter()
        .filter(|w| w.recipient.as_deref() == Some(me.as_str()))
        .collect();
    let others: Vec<&SeaportItem> = wants
        .iter()
        .filter(|w| w.recipient.as_deref() != Some(me.as_str()))
        .collect();
    let list = |xs: &[&SeaportItem]| xs.iter().map(|x| x.describe(coin, ctx)).collect::<Vec<_>>().join(", ");
    let give_text = list(&gives.iter().collect::<Vec<_>>());
    let params = json!({
        "talis": talis,
        "gives": gives.iter().map(|g| g.describe(coin, ctx)).collect::<Vec<_>>(),
        "you_get": back.iter().map(|g| g.describe(coin, ctx)).collect::<Vec<_>>(),
        "others_get": others.iter().map(|g| json!({ "item": g.describe(coin, ctx), "to": g.recipient })).collect::<Vec<_>>(),
    });
    if let Some(c) = gives.iter().find(|g| g.criteria) {
        out.push(finding(
            "seaport_criteria",
            Level::Red,
            format!(
                "Gives any NFT of collection {} the buyer picks, not one named NFT.",
                short(&c.token)
            ),
            params.clone(),
        ));
    }
    // What comes back counts only when the wallet can name it as a price: the chain's coin, or
    // an ERC20 the host lists (named in `symbols` by its address), in a non-zero amount no less
    // than what others get of the same token. An NFT, a criteria item or an unlisted token is
    // anyone's to mint, and a sliver beside the fees is not a price (run-4).
    let to_others = |p: &SeaportItem| {
        others
            .iter()
            .filter(|o| o.kind == p.kind && o.token == p.token)
            .fold(U256::ZERO, |s, o| s.checked_add(&o.amount).unwrap_or(U256::MAX))
    };
    let zero = format!("0x{}", "0".repeat(40));
    let paid = back.iter().any(|p| {
        !p.amount.is_zero()
            && match p.kind {
                0 => p.token == zero,
                1 => ctx.symbols.contains_key(&p.token),
                _ => false,
            }
            && p.amount >= to_others(p)
    });
    if !gives.is_empty() && !paid {
        let got = if back.is_empty() {
            String::new()
        } else {
            format!(" ({} isn't a price the wallet can count)", list(&back))
        };
        out.push(finding(
            "seaport_nothing_back",
            Level::Red,
            format!("Gives {give_text}, and nothing of value comes back to you{got}."),
            params,
        ));
        return out;
    }
    let fees = if others.is_empty() {
        String::new()
    } else {
        format!(" Others get {}.", list(&others))
    };
    out.push(finding(
        "marketplace_order",
        Level::Amber,
        format!(
            "{} {give_text} for {} to you.{fees} Anyone can take it until it ends.",
            if talis { "On Talis: offers" } else { "Offers" },
            list(&back)
        ),
        params,
    ));
    out
}

/// One Seaport offer or consideration item.
struct SeaportItem {
    /// 0 coin, 1 ERC20, 2 ERC721, 3 ERC1155; 4 and 5 are those NFTs by criteria (any of a set).
    kind: u8,
    token: String,
    id: U256,
    /// The larger of the start and end amounts for what is given, the smaller for what is
    /// received (a Dutch auction moves between them).
    amount: U256,
    recipient: Option<String>,
    criteria: bool,
}

impl SeaportItem {
    fn read(v: &Value, consideration: bool) -> Option<Self> {
        let kind = u8::try_from(parse(v.get("itemType")?)?.to_u64()?)
            .ok()
            .filter(|k| *k <= 5)?;
        let token = text(v, "token")?.to_lowercase();
        let id = parse(v.get("identifierOrCriteria")?)?;
        let (start, end) = (parse(v.get("startAmount")?)?, parse(v.get("endAmount")?)?);
        let amount = if consideration { start.min(end) } else { start.max(end) };
        let recipient = if consideration {
            Some(text(v, "recipient")?.to_lowercase())
        } else {
            None
        };
        Some(Self {
            kind,
            token,
            id,
            amount,
            recipient,
            criteria: kind >= 4,
        })
    }

    fn describe(&self, coin: &str, ctx: &Context) -> String {
        match self.kind {
            0 => format!("{} {coin}", crate::evm::coin_units(&self.amount)),
            1 => match ctx.symbols.get(&self.token) {
                Some(symbol) => format!("{} base units of {symbol} ({})", self.amount, short(&self.token)),
                None => format!("{} base units of unlisted token {}", self.amount, short(&self.token)),
            },
            2 => format!("NFT #{} of {}", self.id, short(&self.token)),
            3 => format!("{} of NFT #{} of {}", self.amount, self.id, short(&self.token)),
            _ => format!("any NFT of {}", short(&self.token)),
        }
    }
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
        let mut fields = vec![json!({ "name": "name", "type": "string" })];
        if domain.get("chainId").is_some() {
            fields.push(json!({ "name": "chainId", "type": "uint256" }));
        }
        fields.push(json!({ "name": "verifyingContract", "type": "address" }));
        let mut all = json!({ "EIP712Domain": fields });
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

    /// Seaport (Talis on Injective EVM): a listing is read item by item; giving items away
    /// with nothing back, or any NFT of a collection, is red.
    #[test]
    fn seaport_orders_are_read() {
        let me = "0x1111111111111111111111111111111111111111";
        let nft = "0x4444444444444444444444444444444444444444";
        let fee = "0x5555555555555555555555555555555555555555";
        let types = json!({
            "OrderComponents": [
                { "name": "offerer", "type": "address" }, { "name": "zone", "type": "address" },
                { "name": "offer", "type": "OfferItem[]" }, { "name": "consideration", "type": "ConsiderationItem[]" },
                { "name": "orderType", "type": "uint8" }, { "name": "startTime", "type": "uint256" }, { "name": "endTime", "type": "uint256" },
                { "name": "zoneHash", "type": "bytes32" }, { "name": "salt", "type": "uint256" }, { "name": "conduitKey", "type": "bytes32" },
                { "name": "counter", "type": "uint256" }
            ],
            "OfferItem": [
                { "name": "itemType", "type": "uint8" }, { "name": "token", "type": "address" }, { "name": "identifierOrCriteria", "type": "uint256" },
                { "name": "startAmount", "type": "uint256" }, { "name": "endAmount", "type": "uint256" }
            ],
            "ConsiderationItem": [
                { "name": "itemType", "type": "uint8" }, { "name": "token", "type": "address" }, { "name": "identifierOrCriteria", "type": "uint256" },
                { "name": "startAmount", "type": "uint256" }, { "name": "endAmount", "type": "uint256" }, { "name": "recipient", "type": "address" }
            ]
        });
        let zero = format!("0x{}", "00".repeat(20));
        let word = format!("0x{}", "00".repeat(32));
        let order = |offer: Value, consideration: Value| {
            json!({ "offerer": me, "zone": zero, "offer": offer, "consideration": consideration, "orderType": 2, "startTime": "0", "endTime": "9999999999",
                    "zoneHash": word, "salt": "1", "conduitKey": word, "counter": "0" })
        };
        let nft_item = |kind: u8, id: &str| json!({ "itemType": kind, "token": nft, "identifierOrCriteria": id, "startAmount": "1", "endAmount": "1" });
        let pay = |amount: &str, to: &str| json!({ "itemType": 0, "token": zero, "identifierOrCriteria": "0", "startAmount": amount, "endAmount": amount, "recipient": to });
        let domain = json!({ "name": "Seaport", "verifyingContract": "0x0000000000000068F116a894984e2DB1123eB395" });
        let signer = EthAddress::parse_hex(me).unwrap();
        let ctx = Context {
            symbols: [("native".to_owned(), "INJ".to_owned())].into(),
            ..Context::default()
        };
        let grade = |o: Value| {
            typed_data(
                &td(domain.clone(), "OrderComponents", types.clone(), o),
                None,
                &signer,
                &ctx,
            )
        };
        // A listing: NFT #7 for 10 INJ, 9.7 to the seller and 0.3 in fees.
        let a = grade(order(
            json!([nft_item(2, "7")]),
            json!([pay("9700000000000000000", me), pay("300000000000000000", fee)]),
        ));
        assert_eq!(a.level, Level::Amber);
        let f = a.findings.iter().find(|f| f.rule == "marketplace_order").expect("read");
        assert!(
            f.message.contains("NFT #7") && f.message.contains("9.7 INJ") && f.message.contains("0.3 INJ"),
            "{}",
            f.message
        );
        // The drainer's "listing": the NFT goes, everything is paid to someone else.
        let a = grade(order(
            json!([nft_item(2, "7")]),
            json!([pay("10000000000000000000", fee)]),
        ));
        assert_eq!(a.level, Level::Red);
        assert!(a.findings.iter().any(|f| f.rule == "seaport_nothing_back"));
        // Any NFT of the collection, by criteria.
        let a = grade(order(json!([nft_item(4, "0")]), json!([pay("1", me)])));
        assert!(
            a.findings
                .iter()
                .any(|f| f.rule == "seaport_criteria" && f.level == Level::Red)
        );
        // An item the wallet can't read.
        let a = grade(order(
            json!([{ "itemType": 9, "token": nft, "identifierOrCriteria": "1", "startAmount": "1", "endAmount": "1" }]),
            json!([]),
        ));
        assert_eq!(a.level, Level::Red);

        // On Talis: Seaport 1.6 on chain 1776, restricted to mainnet's Talis zone. Named, and
        // graded the same; the zone alone, on another chain or for another contract, isn't Talis.
        let talis_zone = choice_wallet_injective::talis::MAINNET.zone;
        let on = |chain: u64, contract: &str, o: Value| {
            let mut o = o;
            o["zone"] = json!(talis_zone);
            typed_data(
                &td(
                    json!({ "name": "Seaport", "chainId": chain, "verifyingContract": contract }),
                    "OrderComponents",
                    types.clone(),
                    o,
                ),
                None,
                &signer,
                &ctx,
            )
        };
        let seaport = choice_wallet_injective::talis::SEAPORT;
        let listing = || {
            order(
                json!([nft_item(2, "7")]),
                json!([pay("9700000000000000000", me), pay("300000000000000000", fee)]),
            )
        };
        let a = on(1776, seaport, listing());
        assert_eq!(a.level, Level::Amber);
        let f = a.findings.iter().find(|f| f.rule == "marketplace_order").expect("read");
        assert!(f.message.starts_with("On Talis: offers NFT #7"), "{}", f.message);
        assert_eq!(f.params["talis"], json!(true));
        for (chain, contract) in [(1439, seaport), (1, seaport), (1776, nft)] {
            let a = on(chain, contract, listing());
            let f = a.findings.iter().find(|f| f.rule == "marketplace_order").expect("read");
            assert!(
                f.message.starts_with("Offers NFT #7"),
                "{chain} {contract}: {}",
                f.message
            );
        }
        let a = on(1776, seaport, order(json!([nft_item(2, "7")]), json!([pay("1", fee)])));
        assert_eq!(a.level, Level::Red, "a drain through Talis's zone is still a drain");
        // An order anyone may fill (FULL_OPEN, 0) names the zone without being Talis's.
        let mut open = listing();
        open["orderType"] = json!(0);
        let a = on(1776, seaport, open);
        let f = a.findings.iter().find(|f| f.rule == "marketplace_order").expect("read");
        assert!(f.message.starts_with("Offers NFT #7"), "{}", f.message);

        // Run-4: what comes back counts only when the wallet can value it. A sliver beside
        // the fees, an NFT, or a token the host doesn't list is nothing; a listed token is a price.
        let usdt = "0x88f7f2b685f9692caf8c478f5badf09ee9b1cc13";
        let junk = "0x6666666666666666666666666666666666666666";
        let token = |t: &str, amount: &str, to: &str| json!({ "itemType": 1, "token": t, "identifierOrCriteria": "0", "startAmount": amount, "endAmount": amount, "recipient": to });
        let nft_back = json!({ "itemType": 2, "token": junk, "identifierOrCriteria": "1", "startAmount": "1", "endAmount": "1", "recipient": me });
        for consideration in [
            json!([pay("1", me), pay("10000000000000000000", fee)]),
            json!([nft_back, pay("10000000000000000000", fee)]),
            json!([token(junk, "1000000", me)]),
            json!([token(usdt, "1", me), token(usdt, "1000000", fee)]),
        ] {
            let a = grade(order(json!([nft_item(2, "7")]), consideration.clone()));
            assert_eq!(
                (a.level, a.findings.iter().any(|f| f.rule == "seaport_nothing_back")),
                (Level::Red, true),
                "{consideration}"
            );
        }
        let listed = Context {
            symbols: [
                ("native".to_owned(), "INJ".to_owned()),
                (usdt.to_owned(), "USDT".to_owned()),
            ]
            .into(),
            ..Context::default()
        };
        let a = typed_data(
            &td(
                domain.clone(),
                "OrderComponents",
                types.clone(),
                order(
                    json!([nft_item(2, "7")]),
                    json!([token(usdt, "9700000", me), token(usdt, "300000", fee)]),
                ),
            ),
            None,
            &signer,
            &listed,
        );
        assert_eq!(a.level, Level::Amber);
        let f = a.findings.iter().find(|f| f.rule == "marketplace_order").expect("read");
        assert!(f.message.contains("9700000 base units of USDT"), "{}", f.message);
    }
}
