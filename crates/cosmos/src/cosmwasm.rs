//! The CosmWasm contract messages the wallet builds and recognises.
//!
//! - CW20 `transfer`, `send`, `increase_allowance`, `decrease_allowance`, `burn` and
//!   `update_minter`.
//! - CW721 (NFT) `transfer_nft`, `send_nft`, `approve`, `approve_all`, `revoke`,
//!   `revoke_all` and `burn`.
//! - cw-ownable `update_ownership` (any contract's owner handing it on or giving it up).
//!
//! These are read the way the contracts read them: cosmwasm-schema 2's `cw_serde` (cw20 2.x,
//! cw721 0.19+, cw-ownable 2.x, the CW20 adapter) ignores fields a message doesn't define,
//! so a known shape with extra fields is still that call; [`ignored_fields`] names the
//! extras for the policy. A message named like one of these but shaped otherwise is
//! [`ContractCall::Unread`]; a known shape with an amount or NFT ID the wallet can't read as
//! written is refused.
//! - The CW20 adapter's `redeem_and_transfer` (the adapter runs on Injective). Sending a
//!   CW20 to the adapter (`send` with an empty `msg`) mints the bank denom
//!   `factory/{adapter}/{cw20}` to the sender; redeeming burns that denom and returns the
//!   CW20.
//!
//! Recognition is by message shape only. Whether the contract really is a CW20 or the
//! adapter is for the caller to check against its token list; a CW721's for its NFT list.

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::msg::is_canonical_amount;

/// A contract call parsed from a `MsgExecuteContract`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContractCall {
    /// CW20 `transfer`: move `amount` to `recipient`.
    Cw20Transfer {
        /// Receiving account.
        recipient: String,
        /// Amount in the token's base units.
        amount: String,
    },
    /// CW20 `send`: move `amount` to `contract` and call its receive hook with `msg`.
    Cw20Send {
        /// Receiving contract.
        contract: String,
        /// Amount in the token's base units.
        amount: String,
        /// Base64 message passed to the receiving contract.
        msg: String,
    },
    /// CW20 `increase_allowance`: let `spender` move up to `amount` more of the sender's
    /// tokens.
    Cw20IncreaseAllowance {
        /// Who may spend.
        spender: String,
        /// Additional allowance, in base units.
        amount: String,
        /// When the allowance ends, as the contract's JSON (`{"at_height": …}`,
        /// `{"at_time": …}`, `{"never": {}}`); `None` when not given, which means never.
        expires: Option<String>,
    },
    /// CW20 `decrease_allowance`: lower `spender`'s allowance by `amount` (to none when it is
    /// at least the allowance).
    Cw20DecreaseAllowance {
        /// Whose allowance.
        spender: String,
        /// How much less, in base units.
        amount: String,
        /// A new end for what's left, as the contract's JSON; `None` keeps the old one. With
        /// it, a decrease can make an allowance that was about to end last for good.
        expires: Option<String>,
    },
    /// CW20 `burn`: destroy `amount` of the sender's tokens.
    Cw20Burn {
        /// Amount in the token's base units.
        amount: String,
    },
    /// CW20 `update_minter`: hand minting to `new_minter`, or end it for good (`None`).
    /// Only the minter can.
    Cw20UpdateMinter {
        /// The new minter.
        new_minter: Option<String>,
    },
    /// CW20 adapter `redeem_and_transfer`: burn the attached adapter denom and send the CW20
    /// to `recipient`, or to the sender when `None`.
    AdapterRedeem {
        /// Who receives the CW20.
        recipient: Option<String>,
    },
    /// CW721 `transfer_nft`: give NFT `token_id` to `recipient`.
    NftTransfer {
        /// Receiving account.
        recipient: String,
        /// The NFT's ID in its collection.
        token_id: String,
    },
    /// CW721 `send_nft`: give NFT `token_id` to `contract` and call its receive hook.
    NftSend {
        /// Receiving contract.
        contract: String,
        /// The NFT's ID in its collection.
        token_id: String,
        /// Base64 message passed to the receiving contract.
        msg: String,
    },
    /// CW721 `approve`: let `spender` take NFT `token_id`.
    NftApprove {
        /// Who may take it.
        spender: String,
        /// The NFT.
        token_id: String,
        /// When the approval ends, as the contract's JSON; `None` for never.
        expires: Option<String>,
    },
    /// CW721 `approve_all`: let `operator` take every NFT the sender holds in the collection.
    NftApproveAll {
        /// Who may take them.
        operator: String,
        /// When the approval ends, as the contract's JSON; `None` for never.
        expires: Option<String>,
    },
    /// CW721 `revoke` / `revoke_all`: take an approval back.
    NftRevoke {
        /// Whose approval.
        spender: String,
        /// The NFT, or `None` for every NFT (`revoke_all`).
        token_id: Option<String>,
    },
    /// CW721 `burn`: destroy NFT `token_id`.
    NftBurn {
        /// The NFT's ID in its collection.
        token_id: String,
    },
    /// cw-ownable `update_ownership` with `transfer_ownership`: offer the contract to
    /// `new_owner`, who takes it by accepting. Only the owner can.
    OwnershipTransfer {
        /// The new owner.
        new_owner: String,
        /// When the offer ends, as the contract's JSON; `None` for never.
        expiry: Option<String>,
    },
    /// cw-ownable `update_ownership` with `renounce_ownership`: the contract has no owner
    /// from then on.
    OwnershipRenounce,
    /// A call named like a token call (`action`, such as `transfer` or `approve`) in a shape
    /// the wallet can't read: a field of the wrong type, or a `burn` with both an amount
    /// and an NFT ID (a CW20 burns the one, a CW721 the other). The standard contracts
    /// refuse the first; one that doesn't may still move tokens.
    Unread {
        /// The message's one top-level key.
        action: String,
    },
    /// Any other call. Shown raw.
    Other,
}

/// The top-level keys only the token standards (and cw-ownable) use. A message under one of
/// these that doesn't parse is [`ContractCall::Unread`], not [`ContractCall::Other`].
const TOKEN_ACTIONS: &[&str] = &[
    "increase_allowance",
    "decrease_allowance",
    "update_minter",
    "transfer_nft",
    "send_nft",
    "approve_all",
    "revoke_all",
    "update_ownership",
];

/// Keys other contracts use too (a multisig's `approve`, a bridge's `transfer`): unread only
/// when the message carries a field a token call would, so it reads like one.
const COMMON_ACTIONS: &[&str] = &["transfer", "send", "burn", "approve", "revoke"];
const TOKEN_FIELDS: &[&str] = &["amount", "recipient", "spender", "token_id", "operator", "contract"];

/// A message the token rules would have read, had it been shaped like the standard's.
fn token_named(o: &serde_json::Map<String, serde_json::Value>) -> Option<&str> {
    let (key, inner) = o.iter().next().filter(|_| o.len() == 1)?;
    if TOKEN_ACTIONS.contains(&key.as_str()) {
        return Some(key);
    }
    let fields = inner.as_object()?;
    (COMMON_ACTIONS.contains(&key.as_str()) && fields.keys().any(|f| TOKEN_FIELDS.contains(&f.as_str())))
        .then_some(key.as_str())
}

/// Wire shapes, read as `cw_serde` reads them: fields a shape doesn't define are ignored
/// (and named by [`ignored_fields`]); a duplicate field, a second top-level key or a field
/// of the wrong type fails, as it does in the contract, and falls through to
/// [`ContractCall::Unread`] or [`ContractCall::Other`].
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Known {
    Transfer {
        recipient: String,
        amount: String,
    },
    Send {
        contract: String,
        amount: String,
        msg: String,
    },
    RedeemAndTransfer {
        recipient: Option<String>,
    },
    IncreaseAllowance {
        spender: String,
        amount: String,
        #[serde(default)]
        expires: Option<serde_json::Value>,
    },
    DecreaseAllowance {
        spender: String,
        amount: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires: Option<serde_json::Value>,
    },
    /// CW20 `{"burn": {"amount"}}` or CW721 `{"burn": {"token_id"}}`.
    Burn(Burn),
    UpdateMinter {
        #[serde(default)]
        new_minter: Option<String>,
    },
    UpdateOwnership(OwnerAction),
    TransferNft {
        recipient: String,
        token_id: String,
    },
    SendNft {
        contract: String,
        token_id: String,
        msg: String,
    },
    Approve {
        spender: String,
        token_id: String,
        #[serde(default)]
        expires: Option<serde_json::Value>,
    },
    ApproveAll {
        operator: String,
        #[serde(default)]
        expires: Option<serde_json::Value>,
    },
    Revoke {
        spender: String,
        token_id: String,
    },
    RevokeAll {
        operator: String,
    },
}

/// `burn`'s two shapes: CW20 by amount, CW721 by token.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Burn {
    Amount(BurnAmount),
    Token(BurnToken),
}

#[derive(Serialize, Deserialize)]
struct BurnAmount {
    amount: String,
}

#[derive(Serialize, Deserialize)]
struct BurnToken {
    token_id: String,
}

/// cw-ownable's `update_ownership` actions.
#[allow(clippy::enum_variant_names, reason = "the wire names are cw-ownable's")]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OwnerAction {
    TransferOwnership {
        new_owner: String,
        #[serde(default)]
        expiry: Option<serde_json::Value>,
    },
    AcceptOwnership,
    RenounceOwnership,
}

/// A CW721 token ID the wallet will name: 1 to 256 characters, none of them control
/// characters. (CW721 allows any string; one built to mislead is shown raw elsewhere.)
pub fn is_token_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control)
}

/// Parse a `MsgExecuteContract.msg`. The bytes must be UTF-8 JSON, as wasmd requires.
pub fn parse(msg: &[u8]) -> Result<ContractCall, Error> {
    read(msg).map(|(call, _)| call)
}

/// The fields of a recognised token call that its standard doesn't define, as dotted paths
/// (`transfer.memo`), sorted. The standard contracts ignore them; a contract that only looks
/// like a token may not. Empty for anything [`parse`] doesn't read as a token call.
pub fn ignored_fields(msg: &[u8]) -> Vec<String> {
    read(msg).map(|(_, ignored)| ignored).unwrap_or_default()
}

fn read(msg: &[u8]) -> Result<(ContractCall, Vec<String>), Error> {
    let value = serde_json::from_slice::<serde_json::Value>(msg).map_err(|_| Error::ContractJson)?;
    let unread = || match value.as_object().and_then(token_named) {
        // Named like a token call but not shaped like one: said, not passed on as any call.
        Some(action) => ContractCall::Unread { action: action.into() },
        None => ContractCall::Other,
    };
    let Ok(known) = serde_json::from_slice::<Known>(msg) else {
        return Ok((unread(), Vec::new()));
    };
    // A burn with both an amount and an NFT ID burns tokens on a CW20 and an NFT on a CW721:
    // which one is the contract's to say.
    if let Known::Burn(_) = known
        && value["burn"].get("amount").is_some()
        && value["burn"].get("token_id").is_some()
    {
        return Ok((unread(), Vec::new()));
    }
    let mut ignored = Vec::new();
    extra_keys(
        &value,
        &serde_json::to_value(&known).expect("plain values always serialize"),
        "",
        &mut ignored,
    );
    ignored.sort();
    let call = recognised(known)?;
    if call == ContractCall::Other {
        ignored.clear();
    }
    Ok((call, ignored))
}

/// Object keys in `signed` that the re-serialized reading `read` doesn't have.
fn extra_keys(signed: &serde_json::Value, read: &serde_json::Value, path: &str, out: &mut Vec<String>) {
    let (Some(signed), Some(read)) = (signed.as_object(), read.as_object()) else {
        return;
    };
    for (k, v) in signed {
        let here = if path.is_empty() {
            k.clone()
        } else {
            format!("{path}.{k}")
        };
        match read.get(k) {
            Some(r) => extra_keys(v, r, &here, out),
            // `"expires": null` reads as no expiry, which the wallet writes by leaving it out.
            None if v.is_null() => {}
            None => out.push(here),
        }
    }
}

fn recognised(known: Known) -> Result<ContractCall, Error> {
    // A CW20 amount or CW721 token ID the wallet can't read as written is refused, not
    // passed on as an unknown call: cw20's Uint128 parses "0340…" and "+1" as numbers, so
    // an allowance or transfer written that way would move tokens while graded as any
    // contract call.
    if let Known::Transfer { amount, .. }
    | Known::Send { amount, .. }
    | Known::IncreaseAllowance { amount, .. }
    | Known::DecreaseAllowance { amount, .. }
    | Known::Burn(Burn::Amount(BurnAmount { amount })) = &known
        && !is_canonical_amount(amount)
    {
        return Err(Error::Amount(amount.clone()));
    }
    if let Known::TransferNft { token_id, .. }
    | Known::SendNft { token_id, .. }
    | Known::Approve { token_id, .. }
    | Known::Revoke { token_id, .. }
    | Known::Burn(Burn::Token(BurnToken { token_id })) = &known
        && !is_token_id(token_id)
    {
        return Err(Error::TokenId(token_id.clone()));
    }
    let expiry = |e: Option<serde_json::Value>| e.map(|e| e.to_string());
    Ok(match known {
        Known::Transfer { recipient, amount } => ContractCall::Cw20Transfer { recipient, amount },
        Known::Send { contract, amount, msg } => ContractCall::Cw20Send { contract, amount, msg },
        Known::RedeemAndTransfer { recipient } => ContractCall::AdapterRedeem { recipient },
        Known::IncreaseAllowance {
            spender,
            amount,
            expires,
        } => ContractCall::Cw20IncreaseAllowance {
            spender,
            amount,
            expires: expiry(expires),
        },
        Known::DecreaseAllowance {
            spender,
            amount,
            expires,
        } => ContractCall::Cw20DecreaseAllowance {
            spender,
            amount,
            expires: expiry(expires),
        },
        Known::Burn(Burn::Amount(BurnAmount { amount })) => ContractCall::Cw20Burn { amount },
        Known::Burn(Burn::Token(BurnToken { token_id })) => ContractCall::NftBurn { token_id },
        Known::UpdateMinter { new_minter } => ContractCall::Cw20UpdateMinter { new_minter },
        Known::TransferNft { recipient, token_id } => ContractCall::NftTransfer { recipient, token_id },
        Known::SendNft {
            contract,
            token_id,
            msg,
        } => ContractCall::NftSend {
            contract,
            token_id,
            msg,
        },
        Known::Approve {
            spender,
            token_id,
            expires,
        } => ContractCall::NftApprove {
            spender,
            token_id,
            expires: expiry(expires),
        },
        Known::ApproveAll { operator, expires } => ContractCall::NftApproveAll {
            operator,
            expires: expiry(expires),
        },
        Known::Revoke { spender, token_id } => ContractCall::NftRevoke {
            spender,
            token_id: Some(token_id),
        },
        Known::RevokeAll { operator } => ContractCall::NftRevoke {
            spender: operator,
            token_id: None,
        },
        Known::UpdateOwnership(OwnerAction::TransferOwnership { new_owner, expiry: e }) => {
            ContractCall::OwnershipTransfer {
                new_owner,
                expiry: expiry(e),
            }
        }
        Known::UpdateOwnership(OwnerAction::RenounceOwnership) => ContractCall::OwnershipRenounce,
        // Taking ownership offered to the signer hands nothing over.
        Known::UpdateOwnership(OwnerAction::AcceptOwnership) => ContractCall::Other,
    })
}

/// CW20 `{"transfer": {"recipient", "amount"}}`.
pub fn transfer(recipient: &str, amount: &str) -> Vec<u8> {
    to_json(&Known::Transfer {
        recipient: recipient.into(),
        amount: amount.into(),
    })
}

/// CW20 `{"send": {"contract", "amount", "msg"}}`.
pub fn send(contract: &str, amount: &str, msg: &str) -> Vec<u8> {
    to_json(&Known::Send {
        contract: contract.into(),
        amount: amount.into(),
        msg: msg.into(),
    })
}

/// CW20 adapter `{"redeem_and_transfer": {"recipient"}}`.
pub fn redeem_and_transfer(recipient: &str) -> Vec<u8> {
    to_json(&Known::RedeemAndTransfer {
        recipient: Some(recipient.into()),
    })
}

/// CW20 `{"decrease_allowance": {"spender", "amount"}}`.
pub fn decrease_allowance(spender: &str, amount: &str) -> Vec<u8> {
    to_json(&Known::DecreaseAllowance {
        spender: spender.into(),
        amount: amount.into(),
        expires: None,
    })
}

/// CW721 `{"transfer_nft": {"recipient", "token_id"}}`.
pub fn transfer_nft(recipient: &str, token_id: &str) -> Vec<u8> {
    to_json(&Known::TransferNft {
        recipient: recipient.into(),
        token_id: token_id.into(),
    })
}

fn to_json(k: &Known) -> Vec<u8> {
    serde_json::to_vec(k).expect("plain strings always serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_shapes_dapps_use() {
        assert_eq!(
            transfer("inj1a", "5"),
            br#"{"transfer":{"recipient":"inj1a","amount":"5"}}"#
        );
        assert_eq!(
            send("inj1b", "7", ""),
            br#"{"send":{"contract":"inj1b","amount":"7","msg":""}}"#
        );
        assert_eq!(
            redeem_and_transfer("inj1c"),
            br#"{"redeem_and_transfer":{"recipient":"inj1c"}}"#
        );
    }

    #[test]
    fn recognises_known_calls() {
        assert_eq!(
            parse(br#"{"transfer":{"amount":"5","recipient":"inj1a"}}"#).unwrap(),
            ContractCall::Cw20Transfer {
                recipient: "inj1a".into(),
                amount: "5".into()
            }
        );
        assert_eq!(
            parse(br#"{"redeem_and_transfer":{}}"#).unwrap(),
            ContractCall::AdapterRedeem { recipient: None }
        );
    }

    #[test]
    fn recognises_allowances() {
        assert_eq!(
            parse(br#"{"increase_allowance":{"spender":"inj1a","amount":"5"}}"#).unwrap(),
            ContractCall::Cw20IncreaseAllowance {
                spender: "inj1a".into(),
                amount: "5".into(),
                expires: None
            }
        );
        let with_expiry =
            parse(br#"{"increase_allowance":{"spender":"inj1a","amount":"5","expires":{"at_height":9}}}"#);
        assert!(
            matches!(with_expiry.unwrap(), ContractCall::Cw20IncreaseAllowance { expires: Some(e), .. } if e == r#"{"at_height":9}"#)
        );
        assert_eq!(
            parse(&decrease_allowance("inj1a", "5")).unwrap(),
            ContractCall::Cw20DecreaseAllowance {
                spender: "inj1a".into(),
                amount: "5".into(),
                expires: None
            }
        );
        // A decrease that also sets when the rest ends: read, with its new end.
        assert!(matches!(
            parse(br#"{"decrease_allowance":{"spender":"inj1a","amount":"1","expires":{"never":{}}}}"#).unwrap(),
            ContractCall::Cw20DecreaseAllowance { expires: Some(e), .. } if e == r#"{"never":{}}"#
        ));
        assert_eq!(
            decrease_allowance("inj1a", "5"),
            br#"{"decrease_allowance":{"spender":"inj1a","amount":"5"}}"#
        );
    }

    #[test]
    fn recognises_nft_calls() {
        assert_eq!(
            transfer_nft("inj1a", "7"),
            br#"{"transfer_nft":{"recipient":"inj1a","token_id":"7"}}"#
        );
        assert_eq!(
            parse(&transfer_nft("inj1a", "7")).unwrap(),
            ContractCall::NftTransfer {
                recipient: "inj1a".into(),
                token_id: "7".into()
            }
        );
        assert_eq!(
            parse(br#"{"approve_all":{"operator":"inj1m"}}"#).unwrap(),
            ContractCall::NftApproveAll {
                operator: "inj1m".into(),
                expires: None
            }
        );
        assert!(matches!(
            parse(br#"{"approve":{"spender":"inj1m","token_id":"7","expires":{"never":{}}}}"#).unwrap(),
            ContractCall::NftApprove { expires: Some(_), .. }
        ));
        assert_eq!(
            parse(br#"{"revoke_all":{"operator":"inj1m"}}"#).unwrap(),
            ContractCall::NftRevoke {
                spender: "inj1m".into(),
                token_id: None
            }
        );
        // A token ID the wallet won't name is refused, as an unreadable amount is.
        for (bad, id) in [
            (r#"{"transfer_nft":{"recipient":"inj1a","token_id":""}}"#, ""),
            (
                r#"{"transfer_nft":{"recipient":"inj1a","token_id":"a\u0000b"}}"#,
                "a\u{0}b",
            ),
            (r#"{"approve":{"spender":"inj1a","token_id":"a\nb"}}"#, "a\nb"),
            (r#"{"burn":{"token_id":""}}"#, ""),
        ] {
            assert_eq!(parse(bad.as_bytes()).unwrap_err(), Error::TokenId(id.into()), "{bad}");
        }
        let long = format!(
            r#"{{"send_nft":{{"contract":"inj1a","token_id":"{}","msg":""}}}}"#,
            "x".repeat(257)
        );
        assert!(matches!(parse(long.as_bytes()).unwrap_err(), Error::TokenId(_)));
        // A number isn't a CW721 token ID: named like an NFT call, not shaped like one.
        assert_eq!(
            parse(br#"{"transfer_nft":{"recipient":"inj1a","token_id":7}}"#).unwrap(),
            ContractCall::Unread {
                action: "transfer_nft".into()
            }
        );
    }

    #[test]
    fn recognises_burns_minters_and_owners() {
        assert_eq!(
            parse(br#"{"burn":{"amount":"5"}}"#).unwrap(),
            ContractCall::Cw20Burn { amount: "5".into() }
        );
        assert_eq!(
            parse(br#"{"burn":{"token_id":"7"}}"#).unwrap(),
            ContractCall::NftBurn { token_id: "7".into() }
        );
        assert_eq!(
            parse(br#"{"burn":{"amount":"05"}}"#).unwrap_err(),
            Error::Amount("05".into())
        );
        assert_eq!(
            parse(br#"{"update_minter":{"new_minter":"inj1m"}}"#).unwrap(),
            ContractCall::Cw20UpdateMinter {
                new_minter: Some("inj1m".into())
            }
        );
        assert_eq!(
            parse(br#"{"update_minter":{}}"#).unwrap(),
            ContractCall::Cw20UpdateMinter { new_minter: None }
        );
        assert_eq!(
            parse(br#"{"update_ownership":{"transfer_ownership":{"new_owner":"inj1o","expiry":null}}}"#).unwrap(),
            ContractCall::OwnershipTransfer {
                new_owner: "inj1o".into(),
                expiry: None
            }
        );
        assert!(matches!(
            parse(br#"{"update_ownership":{"transfer_ownership":{"new_owner":"inj1o","expiry":{"at_height":9}}}}"#)
                .unwrap(),
            ContractCall::OwnershipTransfer { expiry: Some(_), .. }
        ));
        assert_eq!(
            parse(br#"{"update_ownership":"renounce_ownership"}"#).unwrap(),
            ContractCall::OwnershipRenounce
        );
        assert_eq!(
            parse(br#"{"update_ownership":"accept_ownership"}"#).unwrap(),
            ContractCall::Other
        );
    }

    #[test]
    fn extra_fields_are_ignored_as_the_contracts_ignore_them() {
        // cw_serde 2 (cw20 2.x, cw721 0.19+, cw-ownable 2.x) ignores fields a message
        // doesn't define, so an extra field can't make a token call read as another one.
        assert_eq!(
            parse(br#"{"increase_allowance":{"spender":"inj1a","amount":"5","memo":"x"}}"#).unwrap(),
            ContractCall::Cw20IncreaseAllowance {
                spender: "inj1a".into(),
                amount: "5".into(),
                expires: None
            }
        );
        assert_eq!(
            ignored_fields(br#"{"increase_allowance":{"spender":"inj1a","amount":"5","memo":"x"}}"#),
            ["increase_allowance.memo"]
        );
        assert_eq!(
            parse(br#"{"approve_all":{"operator":"inj1m","z":1,"a":{"b":2}}}"#).unwrap(),
            ContractCall::NftApproveAll {
                operator: "inj1m".into(),
                expires: None
            }
        );
        assert_eq!(
            ignored_fields(br#"{"approve_all":{"operator":"inj1m","z":1,"a":{"b":2}}}"#),
            ["approve_all.a", "approve_all.z"]
        );
        assert_eq!(
            parse(br#"{"update_ownership":{"transfer_ownership":{"new_owner":"inj1o","note":1}}}"#).unwrap(),
            ContractCall::OwnershipTransfer {
                new_owner: "inj1o".into(),
                expiry: None
            }
        );
        assert_eq!(
            ignored_fields(br#"{"update_ownership":{"transfer_ownership":{"new_owner":"inj1o","note":1}}}"#),
            ["update_ownership.transfer_ownership.note"]
        );
        assert_eq!(
            parse(br#"{"redeem_and_transfer":{"recipient":"inj1b","x":[]}}"#).unwrap(),
            ContractCall::AdapterRedeem {
                recipient: Some("inj1b".into())
            }
        );
        // An extra field doesn't hide a non-canonical amount either.
        assert_eq!(
            parse(br#"{"transfer":{"recipient":"inj1a","amount":"05","extra":1}}"#).unwrap_err(),
            Error::Amount("05".into())
        );
        // What the wallet writes, and an explicit null, carry nothing extra.
        assert!(ignored_fields(&decrease_allowance("inj1a", "5")).is_empty());
        assert!(
            ignored_fields(br#"{"decrease_allowance":{"spender":"inj1a","amount":"5","expires":null}}"#).is_empty()
        );
        assert!(
            ignored_fields(br#"{"increase_allowance":{"spender":"inj1a","amount":"5","expires":{"never":{}}}}"#)
                .is_empty()
        );
        // Not a token call: nothing to name.
        assert!(ignored_fields(br#"{"swap":{"offer_asset":{},"x":1}}"#).is_empty());
        assert!(ignored_fields(br#"{"update_ownership":"accept_ownership"}"#).is_empty());
    }

    #[test]
    fn token_calls_in_odd_shapes_are_unread() {
        // Shapes the standard contracts reject (a duplicate field; Uint128 is a string), but
        // one that doesn't may still move tokens: unread, not any call. A burn with both an
        // amount and an NFT ID means one thing to a CW20 and another to a CW721. A malformed
        // amount cw20 would still read ("05") is refused: see refuses_non_json.
        for (json, action) in [
            (
                r#"{"transfer":{"recipient":"inj1a","amount":"5","amount":"6"}}"#,
                "transfer",
            ),
            (r#"{"transfer":{"recipient":"inj1a","amount":5}}"#, "transfer"),
            (r#"{"approve":{"spender":"inj1a","token_id":7}}"#, "approve"),
            (r#"{"burn":{"amount":"5","token_id":"7"}}"#, "burn"),
            (r#"{"burn":{"token_id":"7","amount":"5","x":1}}"#, "burn"),
            (r#"{"update_ownership":{"transfer_ownership":{}}}"#, "update_ownership"),
        ] {
            assert_eq!(
                parse(json.as_bytes()).unwrap(),
                ContractCall::Unread { action: action.into() },
                "{json}"
            );
        }
    }

    #[test]
    fn anything_else_is_other() {
        for json in [
            r#"{"transfer":{"recipient":"inj1a","amount":"5"},"send":{}}"#,
            r#"{"swap":{"offer_asset":{}}}"#,
            r#"{"mint":{"recipient":"inj1a","amount":"5"}}"#,
            r#"{"transfer_from":{"owner":"inj1a","recipient":"inj1b","amount":"5"}}"#,
            // Common names with nothing a token call would carry: another contract's own.
            r#"{"approve":{"proposal_id":7}}"#,
            r#"{"transfer":{"channel":"channel-1"}}"#,
            r#"{"burn":{}}"#,
            r#""transfer""#,
            r#"[]"#,
        ] {
            assert_eq!(parse(json.as_bytes()).unwrap(), ContractCall::Other, "{json}");
        }
    }

    #[test]
    fn refuses_non_json() {
        assert_eq!(parse(b"not json").unwrap_err(), Error::ContractJson);
        // Review: a CW20 amount cw20 would read but the wallet can't is refused.
        for bad in ["0340282366920938463463374607431768211455", "+1", " 1", "1.0", "-1", ""] {
            for json in [
                format!(r#"{{"increase_allowance":{{"spender":"inj1x","amount":"{bad}"}}}}"#),
                format!(r#"{{"transfer":{{"recipient":"inj1x","amount":"{bad}"}}}}"#),
                format!(r#"{{"send":{{"contract":"inj1x","amount":"{bad}","msg":""}}}}"#),
                format!(r#"{{"decrease_allowance":{{"spender":"inj1x","amount":"{bad}"}}}}"#),
            ] {
                assert_eq!(parse(json.as_bytes()).unwrap_err(), Error::Amount(bad.into()), "{json}");
            }
        }
        assert_eq!(parse(&[0xff, 0xfe]).unwrap_err(), Error::ContractJson);
    }
}
