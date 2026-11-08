//! SIGN_MODE_DIRECT: protobuf SignDocs, as sent by Cosmos dapps (`signDirect`) and used for
//! the wallet's own transactions.
//!
//! [`decode`] checks a request and returns a [`Decoded`] transaction. [`sign`] only accepts
//! a [`Decoded`], so nothing can be signed without going through the checks:
//!
//! - `TxBody` and `AuthInfo` round-trip byte for byte, and so does every message type we
//!   know. Unknown message types are kept raw for the approval screen.
//! - The chain ID matches the connected chain.
//! - Exactly one signer, using this account's ethsecp256k1 key in SIGN_MODE_DIRECT.
//! - Every message we can read names this account as its signer.
//! - A fee is present, paid by the signer (a fee granter is allowed). No tip, no extension
//!   options.
//!
//! Injective accounts sign keccak256 of the SignDoc bytes: a 64-byte `r || s` signature
//! with low S.

use choice_wallet_core::{PrivateKey, PublicKey};
use prost::{Message, Name};

use crate::Error;
use crate::canonical::decode_exact;
use crate::msg::{Coin, Msg, coins_from_proto};
use crate::proto::cosmos::tx::signing::v1beta1::SignMode;
use crate::proto::cosmos::tx::v1beta1::{AuthInfo, SignDoc, TxBody, TxRaw, mode_info};
use crate::proto::injective::crypto::v1beta1::ethsecp256k1::PubKey;

/// A SIGN_MODE_DIRECT request: the parts of a SignDoc, as a dapp sends them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// Protobuf `TxBody`.
    pub body_bytes: Vec<u8>,
    /// Protobuf `AuthInfo`.
    pub auth_info_bytes: Vec<u8>,
    /// Chain ID the request is for.
    pub chain_id: String,
    /// The signer's account number.
    pub account_number: u64,
}

/// The fee, as decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fee {
    /// Coins paid.
    pub amount: Vec<Coin>,
    /// Gas limit.
    pub gas_limit: u64,
    /// Account that pays the fee through a fee grant, if any.
    pub granter: Option<String>,
    /// The fee payer, when the request names one explicitly. It can only be the signer.
    pub payer: Option<String>,
}

/// A request that passed every check in [`decode`]. Only this can be signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    request: Request,
    signer: [u8; 33],
    messages: Vec<Msg>,
    memo: String,
    timeout_height: u64,
    sequence: u64,
    fee: Fee,
}

impl Decoded {
    /// The messages, in order.
    pub fn messages(&self) -> &[Msg] {
        &self.messages
    }
    /// The memo.
    pub fn memo(&self) -> &str {
        &self.memo
    }
    /// Block height after which the tx is invalid; 0 for none.
    pub fn timeout_height(&self) -> u64 {
        self.timeout_height
    }
    /// The signer's sequence number.
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    /// The signer's account number.
    pub fn account_number(&self) -> u64 {
        self.request.account_number
    }
    /// The chain ID.
    pub fn chain_id(&self) -> &str {
        &self.request.chain_id
    }
    /// The fee.
    pub fn fee(&self) -> &Fee {
        &self.fee
    }
    /// The bytes that get signed: the protobuf SignDoc.
    pub fn sign_doc_bytes(&self) -> Vec<u8> {
        SignDoc {
            body_bytes: self.request.body_bytes.clone(),
            auth_info_bytes: self.request.auth_info_bytes.clone(),
            chain_id: self.request.chain_id.clone(),
            account_number: self.request.account_number,
        }
        .encode_to_vec()
    }
}

/// A signed transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signed {
    /// The 64-byte `r || s` signature, as `signDirect` returns it.
    pub signature: [u8; 64],
    /// Protobuf `TxRaw`, ready to broadcast.
    pub tx_raw: Vec<u8>,
}

/// Check a request for `chain_id`, to be signed by `signer`.
pub fn decode(request: Request, chain_id: &str, signer: &PublicKey) -> Result<Decoded, Error> {
    decode_with_mode(request, chain_id, signer, SignMode::Direct)
}

/// The checks of [`decode`], for a transaction whose signer info declares `mode`. The
/// amino JSON path uses this with LEGACY_AMINO_JSON.
pub(crate) fn decode_with_mode(
    request: Request,
    chain_id: &str,
    signer: &PublicKey,
    mode: SignMode,
) -> Result<Decoded, Error> {
    if request.chain_id != chain_id {
        return Err(Error::WrongChain {
            expected: chain_id.into(),
            got: request.chain_id,
        });
    }
    let signer_key = signer.compressed();
    let signer_addr = signer.eth_address().to_inj();

    let body: TxBody = decode_exact(&request.body_bytes, "TxBody")?;
    if !body.extension_options.is_empty() || !body.non_critical_extension_options.is_empty() {
        return Err(Error::ExtensionOptions);
    }
    if body.messages.is_empty() {
        return Err(Error::NoMessages);
    }
    let messages = body.messages.iter().map(Msg::decode).collect::<Result<Vec<_>, _>>()?;
    for m in &messages {
        if let Some(s) = m.signer()
            && s != signer_addr
        {
            return Err(Error::ForeignSigner(s.into()));
        }
    }

    let auth: AuthInfo = decode_exact(&request.auth_info_bytes, "AuthInfo")?;
    #[allow(deprecated)] // read only to refuse it
    if auth.tip.is_some() {
        return Err(Error::Tip);
    }
    let [info] = auth.signer_infos.as_slice() else {
        return Err(Error::SignerCount);
    };
    let pk_any = info.public_key.as_ref().ok_or(Error::WrongSigner)?;
    if pk_any.type_url != PubKey::type_url() {
        return Err(Error::PubKeyType(pk_any.type_url.clone()));
    }
    let pk: PubKey = decode_exact(&pk_any.value, "PubKey")?;
    if pk.key != signer_key {
        return Err(Error::WrongSigner);
    }
    match info.mode_info.as_ref().and_then(|m| m.sum.as_ref()) {
        Some(mode_info::Sum::Single(s)) if s.mode == mode as i32 => {}
        _ => return Err(Error::SignMode),
    }
    let fee = auth.fee.ok_or(Error::MissingFee)?;
    if !fee.payer.is_empty() && fee.payer != signer_addr {
        return Err(Error::FeePayer);
    }
    let fee = Fee {
        amount: coins_from_proto(fee.amount)?,
        gas_limit: fee.gas_limit,
        granter: (!fee.granter.is_empty()).then_some(fee.granter),
        payer: (!fee.payer.is_empty()).then_some(fee.payer),
    };

    Ok(Decoded {
        sequence: info.sequence,
        request,
        signer: signer_key,
        messages,
        memo: body.memo,
        timeout_height: body.timeout_height,
        fee,
    })
}

/// Sign a decoded request. `key` must be the signer's.
pub fn sign(decoded: &Decoded, key: &PrivateKey) -> Result<Signed, Error> {
    if key.public_key().compressed() != decoded.signer {
        return Err(Error::KeyMismatch);
    }
    let signature = key.sign_keccak256(&decoded.sign_doc_bytes());
    Ok(Signed {
        signature,
        tx_raw: decoded.tx_raw(&signature),
    })
}

impl Decoded {
    /// The signer's compressed public key.
    pub(crate) fn signer_key(&self) -> &[u8; 33] {
        &self.signer
    }

    /// `TxRaw` with `signature` attached.
    pub(crate) fn tx_raw(&self, signature: &[u8; 64]) -> Vec<u8> {
        TxRaw {
            body_bytes: self.request.body_bytes.clone(),
            auth_info_bytes: self.request.auth_info_bytes.clone(),
            signatures: vec![signature.to_vec()],
        }
        .encode_to_vec()
    }
}
