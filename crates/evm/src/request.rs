//! Transaction requests for `eth_sendTransaction`.
//!
//! A dapp's request usually leaves out the nonce, gas limit and fees. The wallet fills those
//! in (from its own RPC), then parses the complete request here and signs exactly what
//! this returns.
//!
//! Strict on purpose:
//!
//! - Quantities are JSON-RPC quantities (`0x` + hex, no leading zeros); data is `0x` +
//!   even-length hex; addresses are `0x` + 40 hex with a valid EIP-55 checksum when mixed
//!   case.
//! - Only EIP-1559 (type 2) transactions, with an empty access list. Legacy gas prices,
//!   EIP-7702 authorizations (Injective EVM has none, and they hand over the account) and
//!   contract creation are refused.
//! - Unknown or duplicate fields are refused. `data` and `input` may both appear only when
//!   equal.

use choice_wallet_core::{EthAddress, hexutil};
use serde::Deserialize;
use serde_json::Value;

use crate::{Eip1559Tx, Error, U256, erc20};

/// A parsed transaction request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxRequest {
    /// The account the request asks to send from.
    pub from: EthAddress,
    /// The transaction to sign.
    pub tx: Eip1559Tx,
}

/// What a transaction does, as far as calldata alone tells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    /// Native coin sent, no calldata.
    Transfer,
    /// ERC20 `transfer(to, amount)` on the contract `tx.to`.
    Erc20Transfer {
        /// Recipient of the tokens.
        to: EthAddress,
        /// Token base units.
        amount: U256,
    },
    /// Any other contract call. `selector` is `None` when the calldata is shorter than 4
    /// bytes.
    Contract {
        /// First 4 bytes of the calldata.
        selector: Option<[u8; 4]>,
    },
}

impl Eip1559Tx {
    /// What this transaction does, judged by its calldata.
    pub fn call_kind(&self) -> Call {
        if self.data.is_empty() {
            return Call::Transfer;
        }
        if let Some((to, amount)) = erc20::parse_transfer(&self.data) {
            return Call::Erc20Transfer { to, amount };
        }
        Call::Contract {
            selector: self.data.first_chunk::<4>().copied(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Raw {
    from: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    input: Option<String>,
    nonce: String,
    gas: String,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    #[serde(default, rename = "type")]
    tx_type: Option<String>,
    #[serde(default)]
    chain_id: Option<String>,
    #[serde(default)]
    access_list: Option<Vec<Value>>,
    // Accepted by the parser only to be refused with a clear reason.
    #[serde(default)]
    gas_price: Option<Value>,
    #[serde(default)]
    authorization_list: Option<Value>,
}

/// Parse a complete `eth_sendTransaction` request for the chain `chain_id`.
pub fn parse(json: &str, chain_id: u64) -> Result<TxRequest, Error> {
    let raw: Raw = serde_json::from_str(json).map_err(|e| Error::Request(e.to_string()))?;
    let refuse = |why: &str| Err(Error::Request(why.into()));
    if raw.authorization_list.is_some() {
        return refuse("EIP-7702 authorizations are not signed");
    }
    if raw.gas_price.is_some() {
        return refuse("only EIP-1559 transactions are supported, not gasPrice");
    }
    if raw.tx_type.as_deref().is_some_and(|t| t != "0x2") {
        return refuse("only EIP-1559 (type 0x2) transactions are supported");
    }
    if raw.access_list.as_ref().is_some_and(|l| !l.is_empty()) {
        return refuse("access lists are not supported");
    }
    if let Some(c) = &raw.chain_id {
        let got = u64_quantity(c)?;
        if got != chain_id {
            return Err(Error::WrongChain {
                expected: chain_id,
                got,
            });
        }
    }
    let data = match (&raw.data, &raw.input) {
        (Some(d), Some(i)) if d != i => return refuse("data and input differ"),
        (Some(d), _) | (None, Some(d)) => data_bytes(d)?,
        (None, None) => Vec::new(),
    };
    let to = raw.to.as_deref().ok_or(Error::NoRecipient)?;
    let address = |s: &str| EthAddress::parse_hex(s).map_err(|_| Error::Request(format!("invalid address {s:?}")));
    let tx = Eip1559Tx {
        chain_id,
        nonce: u64_quantity(&raw.nonce)?,
        max_priority_fee_per_gas: u128_quantity(&raw.max_priority_fee_per_gas)?,
        max_fee_per_gas: u128_quantity(&raw.max_fee_per_gas)?,
        gas_limit: u64_quantity(&raw.gas)?,
        to: address(to)?,
        value: raw
            .value
            .as_deref()
            .map(U256::from_quantity)
            .transpose()?
            .unwrap_or(U256::ZERO),
        data,
    };
    if tx.max_priority_fee_per_gas > tx.max_fee_per_gas {
        return Err(Error::PriorityFee);
    }
    if tx.gas_limit == 0 {
        return refuse("gas limit is zero");
    }
    Ok(TxRequest {
        from: address(&raw.from)?,
        tx,
    })
}

fn u64_quantity(s: &str) -> Result<u64, Error> {
    U256::from_quantity(s)?
        .to_u64()
        .ok_or_else(|| Error::Quantity(s.into()))
}

fn u128_quantity(s: &str) -> Result<u128, Error> {
    U256::from_quantity(s)?
        .to_u128()
        .ok_or_else(|| Error::Quantity(s.into()))
}

fn data_bytes(s: &str) -> Result<Vec<u8>, Error> {
    s.strip_prefix("0x")
        .and_then(|h| hexutil::decode(h).ok())
        .ok_or_else(|| Error::Request(format!("invalid data {s:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FROM: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    const TO: &str = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";

    fn base() -> Value {
        json!({
            "from": FROM,
            "to": TO,
            "value": "0xde0b6b3a7640000",
            "nonce": "0x7",
            "gas": "0x5208",
            "maxFeePerGas": "0x3b9aca00",
            "maxPriorityFeePerGas": "0x1",
        })
    }

    fn with(f: impl FnOnce(&mut Value)) -> Result<TxRequest, Error> {
        let mut v = base();
        f(&mut v);
        parse(&v.to_string(), 1776)
    }

    #[test]
    fn parses_a_complete_request() {
        let r = parse(&base().to_string(), 1776).unwrap();
        assert_eq!(r.from, EthAddress::parse_hex(FROM).unwrap());
        assert_eq!(r.tx.to, EthAddress::parse_hex(TO).unwrap());
        assert_eq!(r.tx.value.to_string(), "1000000000000000000");
        assert_eq!((r.tx.nonce, r.tx.gas_limit), (7, 21000));
        assert_eq!(
            (r.tx.max_fee_per_gas, r.tx.max_priority_fee_per_gas),
            (1_000_000_000, 1)
        );
        assert_eq!(r.tx.call_kind(), Call::Transfer);

        // Optional fields that agree are fine.
        let r = with(|v| {
            v["type"] = "0x2".into();
            v["chainId"] = "0x6f0".into();
            v["accessList"] = json!([]);
            v["data"] = "0xa9059cbb".into();
            v["input"] = "0xa9059cbb".into();
        })
        .unwrap();
        assert_eq!(
            r.tx.call_kind(),
            Call::Contract {
                selector: Some([0xa9, 0x05, 0x9c, 0xbb])
            }
        );
    }

    #[test]
    fn recognises_erc20_transfers() {
        let to = EthAddress::from_bytes([0x22; 20]);
        let data = erc20::transfer_calldata(&to, &U256::from_u128(5));
        let r = with(|v| {
            v["value"] = "0x0".into();
            v["data"] = format!("0x{}", hexutil::encode(&data)).into();
        })
        .unwrap();
        assert_eq!(
            r.tx.call_kind(),
            Call::Erc20Transfer {
                to,
                amount: U256::from_u128(5)
            }
        );
    }

    #[test]
    fn refuses_what_it_wont_sign() {
        type Edit = fn(&mut Value);
        let refused: [(&str, Edit); 13] = [
            ("7702", |v| v["authorizationList"] = json!([])),
            ("legacy", |v| v["gasPrice"] = "0x1".into()),
            ("type 1", |v| v["type"] = "0x1".into()),
            ("access list", |v| {
                v["accessList"] = json!([{"address": TO, "storageKeys": []}])
            }),
            ("creation", |v| {
                v.as_object_mut().unwrap().remove("to");
            }),
            ("null to", |v| v["to"] = Value::Null),
            ("data != input", |v| {
                v["data"] = "0x01".into();
                v["input"] = "0x02".into();
            }),
            ("odd data", |v| v["data"] = "0x123".into()),
            ("unknown field", |v| v["extra"] = 1.into()),
            ("missing nonce", |v| {
                v.as_object_mut().unwrap().remove("nonce");
            }),
            ("leading zero", |v| v["nonce"] = "0x07".into()),
            ("decimal", |v| v["gas"] = "21000".into()),
            ("zero gas", |v| v["gas"] = "0x0".into()),
        ];
        for (name, f) in refused {
            assert!(with(f).is_err(), "{name}");
        }
        assert_eq!(
            with(|v| v["chainId"] = "0x1".into()).unwrap_err(),
            Error::WrongChain { expected: 1776, got: 1 }
        );
        assert_eq!(
            with(|v| v["maxPriorityFeePerGas"] = "0x3b9aca01".into()).unwrap_err(),
            Error::PriorityFee
        );
        // A bad EIP-55 checksum (one letter's case flipped).
        assert!(with(|v| v["to"] = "0x6fac4D18c912343BF86fa7049364Dd4E424Ab9C0".into()).is_err());
        // A duplicate key.
        let dup = base()
            .to_string()
            .replacen("\"nonce\":\"0x7\"", "\"nonce\":\"0x7\",\"nonce\":\"0x8\"", 1);
        assert!(parse(&dup, 1776).is_err());
    }
}
