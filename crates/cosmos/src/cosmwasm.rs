//! The CosmWasm contract messages the wallet builds and recognises.
//!
//! - CW20 `transfer` and `send`.
//! - CW721 (NFT) `transfer_nft`, `send_nft`, `approve`, `approve_all`, `revoke` and
//!   `revoke_all`.
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
    /// Any other call. Shown raw.
    Other,
}

/// Wire shapes. `deny_unknown_fields` and serde's duplicate-field check make anything
/// unusual fall through to [`ContractCall::Other`].
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
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
    /// Without `expires`: a decrease that also sets an expiry isn't a plain decrease.
    DecreaseAllowance {
        spender: String,
        amount: String,
    },
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

/// A CW721 token ID the wallet will name: 1 to 256 characters, none of them control
/// characters. (CW721 allows any string; one built to mislead is shown raw elsewhere.)
pub fn is_token_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control)
}

/// Parse a `MsgExecuteContract.msg`. The bytes must be UTF-8 JSON, as wasmd requires.
pub fn parse(msg: &[u8]) -> Result<ContractCall, Error> {
    serde_json::from_slice::<serde_json::Value>(msg).map_err(|_| Error::ContractJson)?;
    let call = match serde_json::from_slice::<Known>(msg) {
        Ok(Known::Transfer { recipient, amount }) if is_canonical_amount(&amount) => {
            ContractCall::Cw20Transfer { recipient, amount }
        }
        Ok(Known::Send { contract, amount, msg }) if is_canonical_amount(&amount) => {
            ContractCall::Cw20Send { contract, amount, msg }
        }
        Ok(Known::RedeemAndTransfer { recipient }) => ContractCall::AdapterRedeem { recipient },
        Ok(Known::IncreaseAllowance {
            spender,
            amount,
            expires,
        }) if is_canonical_amount(&amount) => ContractCall::Cw20IncreaseAllowance {
            spender,
            amount,
            expires: expires.map(|e| e.to_string()),
        },
        Ok(Known::DecreaseAllowance { spender, amount }) if is_canonical_amount(&amount) => {
            ContractCall::Cw20DecreaseAllowance { spender, amount }
        }
        Ok(Known::TransferNft { recipient, token_id }) if is_token_id(&token_id) => {
            ContractCall::NftTransfer { recipient, token_id }
        }
        Ok(Known::SendNft {
            contract,
            token_id,
            msg,
        }) if is_token_id(&token_id) => ContractCall::NftSend {
            contract,
            token_id,
            msg,
        },
        Ok(Known::Approve {
            spender,
            token_id,
            expires,
        }) if is_token_id(&token_id) => ContractCall::NftApprove {
            spender,
            token_id,
            expires: expires.map(|e| e.to_string()),
        },
        Ok(Known::ApproveAll { operator, expires }) => ContractCall::NftApproveAll {
            operator,
            expires: expires.map(|e| e.to_string()),
        },
        Ok(Known::Revoke { spender, token_id }) if is_token_id(&token_id) => ContractCall::NftRevoke {
            spender,
            token_id: Some(token_id),
        },
        Ok(Known::RevokeAll { operator }) => ContractCall::NftRevoke {
            spender: operator,
            token_id: None,
        },
        _ => ContractCall::Other,
    };
    Ok(call)
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
                amount: "5".into()
            }
        );
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
        for bad in [
            r#"{"transfer_nft":{"recipient":"inj1a","token_id":""}}"#,
            r#"{"transfer_nft":{"recipient":"inj1a","token_id":"a\u0000b"}}"#,
            r#"{"transfer_nft":{"recipient":"inj1a","token_id":7}}"#,
        ] {
            assert_eq!(parse(bad.as_bytes()).unwrap(), ContractCall::Other, "{bad}");
        }
    }

    #[test]
    fn anything_unusual_is_other() {
        for json in [
            r#"{"transfer":{"recipient":"inj1a","amount":"5","extra":1}}"#,
            r#"{"transfer":{"recipient":"inj1a","amount":"5","amount":"6"}}"#,
            r#"{"transfer":{"recipient":"inj1a","amount":"5"},"send":{}}"#,
            r#"{"transfer":{"recipient":"inj1a","amount":"05"}}"#,
            r#"{"transfer":{"recipient":"inj1a","amount":5}}"#,
            r#"{"increase_allowance":{"spender":"inj1a","amount":"5","memo":"x"}}"#,
            r#"{"decrease_allowance":{"spender":"inj1a","amount":"5","expires":{"never":{}}}}"#,
            r#"{"decrease_allowance":{"spender":"inj1a","amount":"-5"}}"#,
        ] {
            assert_eq!(parse(json.as_bytes()).unwrap(), ContractCall::Other, "{json}");
        }
    }

    #[test]
    fn refuses_non_json() {
        assert_eq!(parse(b"not json").unwrap_err(), Error::ContractJson);
        assert_eq!(parse(&[0xff, 0xfe]).unwrap_err(), Error::ContractJson);
    }
}
