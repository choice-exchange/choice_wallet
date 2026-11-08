//! Injective EIP-712 v2: Cosmos transactions that EVM wallets sign as typed data.
//!
//! Injective dapps send these to `eth_signTypedData_v4`. The typed data is
//! `Tx { context: string, msgs: string }` under the "Injective Web3" domain. `context` is
//! JSON with the account number, chain ID, fee, memo, sequence and timeout height; `msgs`
//! is a JSON list of the messages in protobuf JSON. The chain rebuilds both strings from
//! the broadcast transaction and checks the signature against them, so what [`decode_v2`]
//! reads is what can execute.
//!
//! injective-ts sends v2 to the wallets on its v2-only list (MetaMask, WalletConnect,
//! Phantom, Magic) and v1, typed data derived from amino JSON, to the others. Choice
//! Wallet asks to be on the v2 list. v1 typed data is not recognised here and is shown
//! as generic typed data.

use choice_wallet_core::EthAddress;
use choice_wallet_cosmos::msg::{Coin, Msg};
use choice_wallet_evm::eip712::TypedData;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::Error;
use crate::chain::Network;

/// The domain's `verifyingContract` for v2.
const VERIFYING_CONTRACT: &str = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";

/// The fee of an EIP-712 transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Web3Fee {
    /// Coins paid.
    pub amount: Vec<Coin>,
    /// Gas limit.
    pub gas_limit: u64,
    /// Who pays, when someone else does (fee delegation, e.g. Injective's web3 gateway).
    pub payer: Option<String>,
}

/// A decoded Injective EIP-712 v2 transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Web3Tx {
    /// The EIP-712 domain chain ID: the network's EVM chain ID, or Ethereum's.
    pub evm_chain_id: u64,
    /// The Cosmos chain ID.
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
    pub fee: Web3Fee,
    /// The messages, in order.
    pub messages: Vec<Msg>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    account_number: u64,
    chain_id: String,
    fee: ContextFee,
    memo: String,
    sequence: u64,
    timeout_height: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextFee {
    amount: Option<Vec<Coin>>,
    gas: u64,
    #[serde(default)]
    payer: Option<String>,
}

/// Decode typed data as an Injective EIP-712 v2 transaction on `network`, signed by
/// `signer`.
///
/// Returns `Ok(None)` when the domain isn't "Injective Web3": it's some other typed data.
/// Typed data that claims the Injective domain but differs from v2 in any way is refused.
pub fn decode_v2(td: &TypedData, network: &Network, signer: &EthAddress) -> Result<Option<Web3Tx>, Error> {
    let domain = td.domain();
    if domain.get("name").and_then(Value::as_str) != Some("Injective Web3") {
        return Ok(None);
    }
    let fail = |s: &str| Err(Error::Eip712(s.into()));

    let expected_types: [(&str, &[(&str, &str)]); 2] = [
        (
            "EIP712Domain",
            &[
                ("name", "string"),
                ("version", "string"),
                ("chainId", "uint256"),
                ("verifyingContract", "address"),
                ("salt", "string"),
            ],
        ),
        ("Tx", &[("context", "string"), ("msgs", "string")]),
    ];
    let types = td.types();
    let types_match = types.len() == 2
        && expected_types.iter().all(|(name, fields)| {
            types.get(*name).is_some_and(|got| {
                got.len() == fields.len()
                    && got
                        .iter()
                        .zip(fields.iter())
                        .all(|(g, (n, t))| g.name == *n && g.ty == *t)
            })
        });
    if !types_match || td.primary_type() != "Tx" {
        return fail("types are not EIP-712 v2");
    }
    if domain.get("version").and_then(Value::as_str) != Some("1.0.0")
        || domain.get("salt").and_then(Value::as_str) != Some("0")
    {
        return fail("unexpected domain version or salt");
    }
    let verifying = domain
        .get("verifyingContract")
        .and_then(Value::as_str)
        .map(EthAddress::parse_hex);
    if verifying != Some(EthAddress::parse_hex(VERIFYING_CONTRACT)) {
        return fail("unexpected verifyingContract");
    }
    let evm_chain_id = td
        .chain_id()
        .and_then(|id| {
            let b = id.to_be_bytes();
            b[..24]
                .iter()
                .all(|&x| x == 0)
                .then(|| u64::from_be_bytes(b[24..].try_into().unwrap()))
        })
        .ok_or_else(|| Error::Eip712("missing chainId".into()))?;
    let chain = &network.cosmos;
    if !network.eip712_chain_ids.contains(&evm_chain_id) {
        return Err(Error::WrongChain {
            expected: chain.chain_id.into(),
            got: format!("EVM chain {evm_chain_id}"),
        });
    }

    let message = td.message();
    let (Some(context), Some(msgs)) = (
        message.get("context").and_then(Value::as_str),
        message.get("msgs").and_then(Value::as_str),
    ) else {
        return fail("missing context or msgs");
    };
    let ctx: Context = serde_json::from_str(context).map_err(|e| Error::Eip712(format!("context: {e}")))?;
    if ctx.chain_id != chain.chain_id {
        return Err(Error::WrongChain {
            expected: chain.chain_id.into(),
            got: ctx.chain_id,
        });
    }

    let raw_msgs: Vec<&RawValue> = serde_json::from_str(msgs).map_err(|e| Error::Eip712(format!("msgs: {e}")))?;
    if raw_msgs.is_empty() {
        return Err(Error::NoMessages);
    }
    let messages = raw_msgs
        .into_iter()
        .map(|m| Msg::from_proto_json(m.get()))
        .collect::<Result<Vec<_>, _>>()?;
    let signer_addr = chain.address_of(signer);
    for m in &messages {
        if let Some(s) = m.signer()
            && s != signer_addr
        {
            return Err(Error::ForeignSigner(s.into()));
        }
    }

    let payer = match ctx.fee.payer {
        Some(p) if p != signer_addr => {
            chain.check_address(&p)?;
            Some(p)
        }
        _ => None,
    };
    Ok(Some(Web3Tx {
        evm_chain_id,
        chain_id: ctx.chain_id,
        account_number: ctx.account_number,
        sequence: ctx.sequence,
        timeout_height: ctx.timeout_height,
        memo: ctx.memo,
        fee: Web3Fee {
            amount: ctx.fee.amount.unwrap_or_default(),
            gas_limit: ctx.fee.gas,
            payer,
        },
        messages,
    }))
}
