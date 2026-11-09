//! SIGN_MODE_LEGACY_AMINO_JSON: what Ledger's Cosmos app signs, and what Cosmos dapps send
//! to `signAmino`.
//!
//! The chain rebuilds the amino JSON from the protobuf transaction (cosmos-sdk `x/tx`
//! aminojson) and checks the signature against it, so the bytes here follow that encoder
//! exactly:
//!
//! - Object keys sorted at every level; fields with zero values left out unless the proto
//!   marks them `dont_omitempty` (`account_number`, `sequence`, `chain_id`, `memo`, `fee`,
//!   `msgs`, `fee.gas`, coin lists). So `timeout_height` appears only when it isn't 0.
//! - Integers as decimal strings. Strings escaped as Go's `encoding/json` does, including
//!   `<`, `>`, `&`, U+2028 and U+2029.
//! - CosmWasm messages inline as JSON with sorted keys. Go re-reads their numbers as
//!   float64, so any number that isn't a safe integer (|n| < 2^53) is refused rather than
//!   signed in a form the chain would render differently.
//!
//! Two entry points, both ending in an [`AminoTx`], the only thing [`AminoTx::sign`] signs:
//! [`from_tx`] for the wallet's own transactions (built with
//! [`crate::builder::amino_request`]), and [`decode_sign_doc`] for a dapp's StdSignDoc.

use choice_wallet_core::{PrivateKey, PublicKey};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::Error;
use crate::chain::Chain;
use crate::direct::{self, Decoded, Request};
use crate::json::{self, Form};
use crate::msg::{Coin, JsonCoin, Msg, coins_from_json};
use crate::proto::cosmos::tx::signing::v1beta1::SignMode;

/// The fee of an amino transaction.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AminoFee {
    /// Coins paid.
    pub amount: Vec<Coin>,
    /// Gas limit.
    pub gas_limit: u64,
    /// Account that pays through a fee grant, if any.
    pub granter: Option<String>,
}

/// An amino JSON transaction that passed every check. Only this can be signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AminoTx {
    sign_bytes: Vec<u8>,
    signer: [u8; 33],
    chain: Chain,
    tx: Option<Decoded>,
    /// The chain ID.
    pub chain_id: String,
    /// The signer's account number.
    pub account_number: u64,
    /// The signer's sequence.
    pub sequence: u64,
    /// Block height after which the tx is invalid; 0 for none.
    pub timeout_height: u64,
    /// The memo.
    pub memo: String,
    /// The fee.
    pub fee: AminoFee,
    /// The messages, in order.
    pub messages: Vec<Msg>,
}

impl AminoTx {
    /// The exact bytes that get signed: the canonical amino JSON.
    pub fn sign_bytes(&self) -> &[u8] {
        &self.sign_bytes
    }

    /// Sign with a software key, as the chain's key type signs: 64 bytes `r || s`.
    pub fn sign(&self, key: &PrivateKey) -> Result<[u8; 64], Error> {
        if key.public_key().compressed() != self.signer {
            return Err(Error::KeyMismatch);
        }
        Ok(self.chain.sign(key, &self.sign_bytes))
    }

    /// Check a signature a hardware wallet returned against the signer key and these bytes.
    pub fn verify(&self, signature: &[u8; 64]) -> bool {
        PublicKey::from_sec1_bytes(&self.signer).is_ok_and(|pk| self.chain.verify(&pk, &self.sign_bytes, signature))
    }

    /// `TxRaw` ready to broadcast, for a transaction built with [`from_tx`]. `None` for a
    /// dapp's sign doc, which the dapp assembles and broadcasts itself.
    pub fn tx_raw(&self, signature: &[u8; 64]) -> Option<Vec<u8>> {
        self.tx.as_ref().map(|d| d.tx_raw(signature))
    }
}

/// Check one of the wallet's own LEGACY_AMINO_JSON transactions and derive its amino JSON.
/// Every message must be a type we can render; anything else is refused.
pub fn from_tx(request: Request, chain: &Chain, signer: &PublicKey) -> Result<AminoTx, Error> {
    let d = direct::decode_with_mode(request, chain, signer, SignMode::LegacyAminoJson)?;
    let msgs = d.messages().iter().map(render_msg).collect::<Result<Vec<_>, _>>()?;
    let fee = d.fee();
    let mut fee_json = Map::new();
    fee_json.insert("amount".into(), coins_json(&fee.amount));
    fee_json.insert("gas".into(), fee.gas_limit.to_string().into());
    if let Some(g) = &fee.granter {
        fee_json.insert("granter".into(), g.clone().into());
    }
    if let Some(p) = &fee.payer {
        fee_json.insert("payer".into(), p.clone().into());
    }
    let mut doc = Map::new();
    doc.insert("account_number".into(), d.account_number().to_string().into());
    doc.insert("chain_id".into(), d.chain_id().into());
    doc.insert("fee".into(), Value::Object(fee_json));
    doc.insert("memo".into(), d.memo().into());
    doc.insert("msgs".into(), Value::Array(msgs));
    doc.insert("sequence".into(), d.sequence().to_string().into());
    if d.timeout_height() != 0 {
        doc.insert("timeout_height".into(), d.timeout_height().to_string().into());
    }
    Ok(AminoTx {
        sign_bytes: canonical(&Value::Object(doc))?.into_bytes(),
        signer: *d.signer_key(),
        chain: *chain,
        chain_id: d.chain_id().into(),
        account_number: d.account_number(),
        sequence: d.sequence(),
        timeout_height: d.timeout_height(),
        memo: d.memo().into(),
        fee: AminoFee {
            amount: fee.amount.clone(),
            gas_limit: fee.gas_limit,
            granter: fee.granter.clone(),
        },
        messages: d.messages().to_vec(),
        tx: Some(d),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StdSignDoc {
    account_number: String,
    chain_id: String,
    fee: StdFee,
    memo: String,
    msgs: Vec<AminoMsg>,
    sequence: String,
    #[serde(default)]
    timeout_height: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StdFee {
    amount: Vec<JsonCoin>,
    gas: String,
    #[serde(default)]
    payer: Option<String>,
    #[serde(default)]
    granter: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AminoMsg {
    #[serde(rename = "type")]
    type_name: String,
    value: Value,
}

/// Check a dapp's `signAmino` StdSignDoc (JSON) for `chain`, signed by `signer`.
///
/// What gets signed is the canonical form of this document. If the dapp then broadcasts a
/// transaction whose amino JSON differs, the chain rejects the signature.
pub fn decode_sign_doc(json: &str, chain: &Chain, signer: &PublicKey) -> Result<AminoTx, Error> {
    let value: Value = serde_json::from_str(json).map_err(|e| Error::Amino(e.to_string()))?;
    let doc: StdSignDoc = serde_json::from_value(value.clone()).map_err(|e| Error::Amino(e.to_string()))?;
    if doc.chain_id != chain.chain_id {
        return Err(Error::WrongChain {
            expected: chain.chain_id.into(),
            got: doc.chain_id,
        });
    }
    let signer_addr = chain.address(signer);
    if doc.msgs.is_empty() {
        return Err(Error::NoMessages);
    }
    let messages = doc
        .msgs
        .into_iter()
        .map(|m| decode_amino_msg(m, chain))
        .collect::<Result<Vec<_>, _>>()?;
    for m in &messages {
        if let Some(s) = m.signer()
            && s != signer_addr
        {
            return Err(Error::ForeignSigner(s.into()));
        }
    }
    if doc.fee.payer.as_ref().is_some_and(|p| *p != signer_addr) {
        return Err(Error::FeePayer);
    }
    if let Some(g) = &doc.fee.granter {
        chain.check_address(g)?;
    }
    Ok(AminoTx {
        sign_bytes: canonical(&value)?.into_bytes(),
        signer: signer.compressed(),
        chain: *chain,
        tx: None,
        chain_id: doc.chain_id,
        account_number: parse_u64(&doc.account_number)?,
        sequence: parse_u64(&doc.sequence)?,
        timeout_height: doc.timeout_height.as_deref().map(parse_u64).transpose()?.unwrap_or(0),
        memo: doc.memo,
        fee: AminoFee {
            amount: coins(doc.fee.amount)?,
            gas_limit: parse_u64(&doc.fee.gas)?,
            granter: doc.fee.granter,
        },
        messages,
    })
}

fn decode_amino_msg(m: AminoMsg, chain: &Chain) -> Result<Msg, Error> {
    let packed = json!({ "type": m.type_name, "value": m.value });
    json::message(&packed, Form::Amino, chain, 0)
}

/// The amino JSON of a message we know, as `x/tx` renders it.
fn render_msg(m: &Msg) -> Result<Value, Error> {
    match m {
        Msg::BankSend { from, to, amount } => {
            let mut v = Map::new();
            v.insert("amount".into(), coins_json(amount));
            insert_nonempty(&mut v, "from_address", from);
            insert_nonempty(&mut v, "to_address", to);
            Ok(json!({ "type": "cosmos-sdk/MsgSend", "value": v }))
        }
        Msg::ExecuteContract {
            sender,
            contract,
            funds,
            json,
            ..
        } => {
            let mut v = Map::new();
            insert_nonempty(&mut v, "contract", contract);
            v.insert("funds".into(), coins_json(funds));
            let msg: Value = serde_json::from_str(json).map_err(|_| Error::ContractJson)?;
            v.insert("msg".into(), msg);
            insert_nonempty(&mut v, "sender", sender);
            Ok(json!({ "type": "wasm/MsgExecuteContract", "value": v }))
        }
        Msg::Delegate {
            delegator,
            validator,
            amount,
        }
        | Msg::Undelegate {
            delegator,
            validator,
            amount,
        } => {
            let name = if matches!(m, Msg::Delegate { .. }) {
                "cosmos-sdk/MsgDelegate"
            } else {
                "cosmos-sdk/MsgUndelegate"
            };
            let mut v = Map::new();
            v.insert("amount".into(), coin_json(amount));
            insert_nonempty(&mut v, "delegator_address", delegator);
            insert_nonempty(&mut v, "validator_address", validator);
            Ok(json!({ "type": name, "value": v }))
        }
        Msg::Redelegate {
            delegator,
            from_validator,
            to_validator,
            amount,
        } => {
            let mut v = Map::new();
            v.insert("amount".into(), coin_json(amount));
            insert_nonempty(&mut v, "delegator_address", delegator);
            insert_nonempty(&mut v, "validator_dst_address", to_validator);
            insert_nonempty(&mut v, "validator_src_address", from_validator);
            Ok(json!({ "type": "cosmos-sdk/MsgBeginRedelegate", "value": v }))
        }
        Msg::CancelUnbonding {
            delegator,
            validator,
            amount,
            creation_height,
        } => {
            let mut v = Map::new();
            v.insert("amount".into(), coin_json(amount));
            if *creation_height != 0 {
                v.insert("creation_height".into(), creation_height.to_string().into());
            }
            insert_nonempty(&mut v, "delegator_address", delegator);
            insert_nonempty(&mut v, "validator_address", validator);
            Ok(json!({ "type": "cosmos-sdk/MsgCancelUnbondingDelegation", "value": v }))
        }
        Msg::WithdrawRewards { delegator, validator } => {
            let mut v = Map::new();
            insert_nonempty(&mut v, "delegator_address", delegator);
            insert_nonempty(&mut v, "validator_address", validator);
            Ok(json!({ "type": "cosmos-sdk/MsgWithdrawDelegationReward", "value": v }))
        }
        other => Err(Error::Amino(format!("no amino JSON encoding for {}", other.type_url()))),
    }
}

fn insert_nonempty(m: &mut Map<String, Value>, key: &str, s: &str) {
    if !s.is_empty() {
        m.insert(key.into(), s.into());
    }
}

fn coins_json(c: &[Coin]) -> Value {
    Value::Array(
        c.iter()
            .map(|c| json!({ "amount": c.amount(), "denom": c.denom() }))
            .collect(),
    )
}

fn coin_json(c: &Coin) -> Value {
    json!({ "amount": c.amount(), "denom": c.denom() })
}

fn coins(c: Vec<JsonCoin>) -> Result<Vec<Coin>, Error> {
    coins_from_json(c)
}

fn parse_u64(s: &str) -> Result<u64, Error> {
    let canonical = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    s.parse()
        .ok()
        .filter(|_| canonical)
        .ok_or_else(|| Error::Amino(format!("not a canonical integer: {s:?}")))
}

/// Largest integer that survives Go's float64 round trip unchanged.
const MAX_SAFE_INT: u64 = (1 << 53) - 1;

/// Serialize as the chain does: sorted keys, Go string escaping, safe integers only.
pub(crate) fn canonical(v: &Value) -> Result<String, Error> {
    let mut out = String::new();
    write_canonical(v, &mut out)?;
    Ok(out)
}

fn write_canonical(v: &Value, out: &mut String) -> Result<(), Error> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let ok = n
                .as_u64()
                .filter(|&u| u <= MAX_SAFE_INT)
                .map(|u| u.to_string())
                .or_else(|| {
                    n.as_i64()
                        .filter(|&i| i < 0 && i.unsigned_abs() <= MAX_SAFE_INT)
                        .map(|i| i.to_string())
                });
            out.push_str(&ok.ok_or_else(|| Error::Amino(format!("number {n} can't be signed exactly as amino JSON")))?);
        }
        Value::String(s) => write_go_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Sort explicitly: serde_json's map is only sorted without its preserve_order feature.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_go_string(k, out);
                out.push(':');
                write_canonical(&map[k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Go `encoding/json` string escaping (with HTML escaping, its default).
fn write_go_string(s: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => {
                let n = c as u32;
                out.push_str("\\u");
                for shift in [12, 8, 4, 0] {
                    out.push(HEX[((n >> shift) & 0xf) as usize] as char);
                }
            }
            c if (c as u32) < 0x20 => {
                out.push_str("\\u00");
                out.push(HEX[(c as usize) >> 4] as char);
                out.push(HEX[(c as usize) & 0xf] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected strings are what Go 1.23's encoding/json produced for the same input.
    #[test]
    fn strings_escape_like_go() {
        let cases = [
            ("m <&> \u{2028}\u{2029}", r#""m \u003c\u0026\u003e \u2028\u2029""#),
            (
                "tab\tnl\nbs\u{8}ff\u{c}bell\u{7} é ✓ 😀",
                r#""tab\tnl\nbs\bff\fbell\u0007 é ✓ 😀""#,
            ),
            (r#"quote" back\ slash/"#, r#""quote\" back\\ slash/""#),
        ];
        for (input, want) in cases {
            assert_eq!(canonical(&Value::String(input.into())).unwrap(), want);
        }
    }

    #[test]
    fn objects_are_sorted_and_numbers_must_be_safe() {
        let v: Value = serde_json::from_str(r#"{"b":1,"a":[5,-7,{"z":true,"y":null}]}"#).unwrap();
        assert_eq!(canonical(&v).unwrap(), r#"{"a":[5,-7,{"y":null,"z":true}],"b":1}"#);
        for bad in ["9007199254740993", "1.5", "1e21", "-9007199254740993"] {
            assert!(canonical(&serde_json::from_str(bad).unwrap()).is_err(), "{bad}");
        }
        assert!(canonical(&serde_json::from_str("9007199254740991").unwrap()).is_ok());
    }

    #[test]
    fn integers_must_be_canonical() {
        assert_eq!(parse_u64("0").unwrap(), 0);
        assert_eq!(parse_u64("18446744073709551615").unwrap(), u64::MAX);
        for bad in ["", "01", "+1", "-1", "1.0", "18446744073709551616"] {
            assert!(parse_u64(bad).is_err(), "{bad:?}");
        }
    }
}
