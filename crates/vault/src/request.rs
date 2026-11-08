//! Signing requests: decode, show, approve, sign.
//!
//! [`decode`] checks a request and returns what the approval screen shows, plus a digest.
//! [`sign`] decodes the request again, refuses it unless the digest matches the one that
//! was approved, and only then signs. So a host can't sign anything the user wasn't
//! shown, and an approval can't be reused for a different request or account.
//!
//! The digest is keccak256 over a domain tag and, length-prefixed: the request kind, the
//! chain, the signer, and the exact bytes (or, for typed data, the EIP-712 hash) that get
//! signed.

use choice_wallet_core::secp256k1::keccak256;
use choice_wallet_core::{EthAddress, PrivateKey, PublicKey, hexutil};
use choice_wallet_cosmos::amino::{self, AminoTx};
use choice_wallet_cosmos::direct::{self, Decoded, Request};
use choice_wallet_evm::U256;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_evm::request::{self as evm_request, Call, TxRequest};
use choice_wallet_injective::eip712::decode_v2;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::chains::{self, Entry};
use crate::error::{INVALID, NOT_APPROVED, VaultError, WRONG_ACCOUNT};
use crate::util::{U64, hex, json_text};

/// A request to sign, as hosts send it. Byte fields are hex without a prefix.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SignRequest<'a> {
    /// `signDirect`, and the wallet's own Cosmos transactions.
    CosmosDirect(CosmosTx),
    /// The wallet's own LEGACY_AMINO_JSON transaction (for Ledger's Cosmos app).
    CosmosAminoTx(CosmosTx),
    /// `signAmino`: a dapp's StdSignDoc, as an object or a string.
    CosmosAmino {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's compressed public key.
        signer: String,
        /// The StdSignDoc.
        #[serde(borrow)]
        sign_doc: &'a RawValue,
    },
    /// `eth_sendTransaction`, with nonce, gas and fees filled in.
    EvmTransaction {
        /// CAIP-2 chain ID.
        chain: String,
        /// The transaction request object.
        #[serde(borrow)]
        tx: &'a RawValue,
    },
    /// `eth_signTypedData_v4`.
    EvmTypedData {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's address.
        signer: String,
        /// The typed data, as an object or a string.
        #[serde(borrow)]
        typed_data: &'a RawValue,
    },
}

/// The parts of a Cosmos SignDoc.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CosmosTx {
    chain: String,
    signer: String,
    body_bytes: String,
    auth_info_bytes: String,
    account_number: U64,
}

/// A request that passed its checks.
pub(crate) struct Checked {
    kind: Kind,
    /// What the approval screen shows.
    pub(crate) display: Value,
    /// What an approval is bound to.
    pub(crate) digest: [u8; 32],
}

enum Kind {
    Direct(Decoded),
    AminoTx(AminoTx),
    Amino(AminoTx),
    EvmTx(Box<TxRequest>),
    TypedData { td: Box<TypedData>, signer: EthAddress },
}

fn digest(kind: &str, chain: &str, signer: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut buf = b"choice-wallet approval v1".to_vec();
    for part in [kind.as_bytes(), chain.as_bytes(), signer, payload] {
        buf.extend_from_slice(&(part.len() as u64).to_be_bytes());
        buf.extend_from_slice(part);
    }
    keccak256(&buf)
}

fn public_key(hex_key: &str) -> Result<PublicKey, VaultError> {
    PublicKey::from_sec1_bytes(&hex(hex_key, "signer")?).map_err(|_| VaultError::bad("signer is not a public key"))
}

fn evm_address(s: &str) -> Result<EthAddress, VaultError> {
    EthAddress::parse_hex(s).map_err(|_| VaultError::bad(format!("invalid address {s:?}")))
}

/// Check a request and describe it.
pub(crate) fn decode(req: SignRequest) -> Result<Checked, VaultError> {
    match req {
        SignRequest::CosmosDirect(t) => cosmos_tx(t, false),
        SignRequest::CosmosAminoTx(t) => cosmos_tx(t, true),
        SignRequest::CosmosAmino {
            chain,
            signer,
            sign_doc,
        } => {
            let entry = chains::find(&chain)?;
            let pk = public_key(&signer)?;
            let tx = amino::decode_sign_doc(&json_text(sign_doc)?, entry.cosmos()?, &pk)?;
            Ok(Checked {
                display: amino_display("cosmos_amino", entry, &pk, &tx),
                digest: digest("cosmos_amino", entry.id, &pk.compressed(), tx.sign_bytes()),
                kind: Kind::Amino(tx),
            })
        }
        SignRequest::EvmTransaction { chain, tx } => {
            let entry = chains::find(&chain)?;
            let r = evm_request::parse(tx.get(), entry.evm()?)?;
            let display = evm_tx_display(entry, &r)?;
            Ok(Checked {
                digest: digest("evm_transaction", entry.id, r.from.as_bytes(), &r.tx.unsigned_bytes()),
                display,
                kind: Kind::EvmTx(Box::new(r)),
            })
        }
        SignRequest::EvmTypedData {
            chain,
            signer,
            typed_data,
        } => {
            let entry = chains::find(&chain)?;
            let chain_id = entry.evm()?;
            let signer = evm_address(&signer)?;
            let td = TypedData::parse(&json_text(typed_data)?)?;
            let injective = match entry.injective {
                Some(network) => decode_v2(&td, network, &signer)?,
                None => None,
            };
            // Outside Injective's own domain (which accepts Ethereum's chain ID too), the
            // domain's chain must be the connected one.
            if injective.is_none()
                && let Some(id) = td.chain_id()
                && id.to_u64() != Some(chain_id)
            {
                return Err(VaultError::new(
                    INVALID,
                    format!("typed data is for chain {id}, not {}", entry.id),
                ));
            }
            let display = json!({
                "kind": "evm_typed_data",
                "chain": entry.id,
                "signer": signer.to_checksum_hex(),
                "primary_type": td.primary_type(),
                "domain": td.domain(),
                "message": td.message(),
                "injective_tx": injective,
            });
            Ok(Checked {
                display,
                digest: digest("evm_typed_data", entry.id, signer.as_bytes(), &td.hash()?),
                kind: Kind::TypedData {
                    td: Box::new(td),
                    signer,
                },
            })
        }
    }
}

fn cosmos_tx(t: CosmosTx, amino_mode: bool) -> Result<Checked, VaultError> {
    let entry = chains::find(&t.chain)?;
    let chain = entry.cosmos()?;
    let pk = public_key(&t.signer)?;
    let request = Request {
        body_bytes: hex(&t.body_bytes, "body_bytes")?,
        auth_info_bytes: hex(&t.auth_info_bytes, "auth_info_bytes")?,
        chain_id: chain.chain_id.into(),
        account_number: t.account_number.0,
    };
    if amino_mode {
        let tx = amino::from_tx(request, chain, &pk)?;
        return Ok(Checked {
            display: amino_display("cosmos_amino_tx", entry, &pk, &tx),
            digest: digest("cosmos_amino_tx", entry.id, &pk.compressed(), tx.sign_bytes()),
            kind: Kind::AminoTx(tx),
        });
    }
    let d = direct::decode(request, chain, &pk)?;
    let fee = d.fee();
    let display = json!({
        "kind": "cosmos_direct",
        "chain": entry.id,
        "signer": chain.address(&pk),
        "account_number": d.account_number().to_string(),
        "sequence": d.sequence().to_string(),
        "memo": d.memo(),
        "timeout_height": d.timeout_height().to_string(),
        "fee": {
            "amount": fee.amount,
            "gas_limit": fee.gas_limit.to_string(),
            "granter": fee.granter,
            "payer": fee.payer,
        },
        "messages": d.messages(),
    });
    Ok(Checked {
        display,
        digest: digest("cosmos_direct", entry.id, &pk.compressed(), &d.sign_doc_bytes()),
        kind: Kind::Direct(d),
    })
}

fn amino_display(kind: &str, entry: &Entry, pk: &PublicKey, tx: &AminoTx) -> Value {
    json!({
        "kind": kind,
        "chain": entry.id,
        "signer": entry.address(pk),
        "account_number": tx.account_number.to_string(),
        "sequence": tx.sequence.to_string(),
        "memo": tx.memo,
        "timeout_height": tx.timeout_height.to_string(),
        "fee": {
            "amount": tx.fee.amount,
            "gas_limit": tx.fee.gas_limit.to_string(),
            "granter": tx.fee.granter,
            "payer": Value::Null,
        },
        "messages": tx.messages,
    })
}

fn evm_tx_display(entry: &Entry, r: &TxRequest) -> Result<Value, VaultError> {
    let tx = &r.tx;
    let max_gas_cost = U256::product(u128::from(tx.gas_limit), tx.max_fee_per_gas);
    let call = match tx.call_kind() {
        Call::Transfer => json!({ "type": "transfer" }),
        Call::Erc20Transfer { to, amount } => json!({
            "type": "erc20_transfer",
            "to": to.to_checksum_hex(),
            "amount": amount.to_string(),
        }),
        Call::Contract { selector } => json!({
            "type": "contract",
            "selector": selector.map(|s| format!("0x{}", hexutil::encode(&s))),
        }),
    };
    Ok(json!({
        "kind": "evm_transaction",
        "chain": entry.id,
        "from": r.from.to_checksum_hex(),
        "to": tx.to.to_checksum_hex(),
        "value": tx.value.to_string(),
        "nonce": tx.nonce.to_string(),
        "gas_limit": tx.gas_limit.to_string(),
        "max_fee_per_gas": tx.max_fee_per_gas.to_string(),
        "max_priority_fee_per_gas": tx.max_priority_fee_per_gas.to_string(),
        "max_gas_cost": max_gas_cost.to_string(),
        "data": format!("0x{}", hexutil::encode(&tx.data)),
        "call": call,
    }))
}

/// Sign a checked request with `key`, if `approved` is its digest.
pub(crate) fn sign(checked: Checked, approved: &str, key: &PrivateKey) -> Result<Value, VaultError> {
    if approved != hexutil::encode(&checked.digest) {
        return Err(VaultError::new(
            NOT_APPROVED,
            "this request is not the one that was approved",
        ));
    }
    let pk = key.public_key();
    let wrong_account = || {
        Err(VaultError::new(
            WRONG_ACCOUNT,
            "this account is not the request's signer",
        ))
    };
    let prefixed = |b: &[u8]| format!("0x{}", hexutil::encode(b));
    match checked.kind {
        Kind::Direct(d) => {
            let s = direct::sign(&d, key)?;
            Ok(json!({
                "signature": hexutil::encode(&s.signature),
                "tx_raw": hexutil::encode(&s.tx_raw),
            }))
        }
        Kind::AminoTx(tx) => {
            let sig = tx.sign(key)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "tx_raw": tx.tx_raw(&sig).map(|b| hexutil::encode(&b)),
            }))
        }
        Kind::Amino(tx) => {
            let sig = tx.sign(key)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "signed_doc": String::from_utf8_lossy(tx.sign_bytes()),
            }))
        }
        Kind::EvmTx(r) => {
            if pk.eth_address() != r.from {
                return wrong_account();
            }
            let s = r.tx.sign(key)?;
            Ok(json!({ "raw": prefixed(&s.raw), "hash": prefixed(&s.hash) }))
        }
        Kind::TypedData { td, signer } => {
            if pk.eth_address() != signer {
                return wrong_account();
            }
            Ok(json!({ "signature": prefixed(&td.sign(key)?) }))
        }
    }
}

/// The messages of a checked Cosmos request, for tests.
#[cfg(test)]
pub(crate) fn messages(checked: &Checked) -> Option<&[choice_wallet_cosmos::msg::Msg]> {
    match &checked.kind {
        Kind::Direct(d) => Some(d.messages()),
        Kind::AminoTx(t) | Kind::Amino(t) => Some(&t.messages),
        _ => None,
    }
}
