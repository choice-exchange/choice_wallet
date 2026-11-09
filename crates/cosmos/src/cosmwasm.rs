//! The CosmWasm contract messages the wallet builds and recognises.
//!
//! - CW20 `transfer` and `send`.
//! - The CW20 adapter's `redeem_and_transfer` (the adapter runs on Injective). Sending a
//!   CW20 to the adapter (`send` with an empty `msg`) mints the bank denom
//!   `factory/{adapter}/{cw20}` to the sender; redeeming burns that denom and returns the
//!   CW20.
//!
//! Recognition is by message shape only. Whether the contract really is a CW20 or the
//! adapter is for the caller to check against its token list.

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
