//! The wallet's own Cosmos transactions.
//!
//! Build the messages, wrap them with [`direct_request`] (or [`amino_request`] for Ledger's
//! Cosmos app), then pass the request through [`crate::direct::decode`] (or
//! [`crate::amino::from_tx`]) like any dapp request before signing it.
//!
//! Addresses are bech32 strings on the chain being built for, and are checked against its
//! prefix. Chain crates add their own builders on top of [`execute_contract`] (Injective's
//! CW20 adapter conversions, for example).

use choice_wallet_core::PublicKey;
use prost::Message;

use crate::Error;
use crate::chain::Chain;
use crate::cosmwasm;
use crate::direct::Request;
use crate::msg::{Coin, is_canonical_amount};
use crate::proto::cosmos::bank::v1beta1::MsgSend;
use crate::proto::cosmos::crypto::secp256k1::PubKey;
use crate::proto::cosmos::tx::signing::v1beta1::SignMode;
use crate::proto::cosmos::tx::v1beta1::{AuthInfo, Fee as ProtoFee, ModeInfo, SignerInfo, TxBody, mode_info};
use crate::proto::cosmwasm::wasm::v1::MsgExecuteContract;
use crate::wkt::Any;

/// Fee for a transaction the wallet builds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fee {
    /// Coins paid, usually one coin of the chain's fee denom.
    pub amount: Vec<Coin>,
    /// Gas limit.
    pub gas_limit: u64,
    /// Pay through this account's fee grant.
    pub granter: Option<String>,
}

/// Everything besides the messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOptions {
    /// The signer's account number.
    pub account_number: u64,
    /// The signer's next sequence number.
    pub sequence: u64,
    /// The fee.
    pub fee: Fee,
    /// Memo; empty for none. Exchanges often need one.
    pub memo: String,
    /// Block height after which the tx is invalid; 0 for none.
    pub timeout_height: u64,
}

/// Bank send of `amount` from `from` to `to`. Coins are sorted by denom, as the chain
/// requires; a denom listed twice is refused.
pub fn bank_send(chain: &Chain, from: &str, to: &str, amount: &[Coin]) -> Result<Any, Error> {
    chain.check_address(from)?;
    chain.check_address(to)?;
    if amount.is_empty() {
        return Err(Error::Amount(String::new()));
    }
    let mut coins = amount.to_vec();
    coins.sort();
    if let Some(w) = coins.windows(2).find(|w| w[0].denom() == w[1].denom()) {
        return Err(Error::Denom(w[0].denom().into()));
    }
    Ok(Any::pack(&MsgSend {
        from_address: from.into(),
        to_address: to.into(),
        amount: coins.iter().map(Coin::to_proto).collect(),
    }))
}

/// CW20 `transfer` of `amount` base units of the token at `cw20` to `recipient`.
pub fn cw20_transfer(chain: &Chain, from: &str, cw20: &str, recipient: &str, amount: &str) -> Result<Any, Error> {
    check_amount(amount)?;
    chain.check_address(recipient)?;
    execute_contract(chain, from, cw20, cosmwasm::transfer(recipient, amount), &[])
}

/// CW20 `send` of `amount` base units of the token at `cw20` to the contract `to`, calling
/// its receive hook with `msg` (base64; empty for none).
pub fn cw20_send(chain: &Chain, from: &str, cw20: &str, to: &str, amount: &str, msg: &str) -> Result<Any, Error> {
    check_amount(amount)?;
    chain.check_address(to)?;
    execute_contract(chain, from, cw20, cosmwasm::send(to, amount, msg), &[])
}

/// `MsgExecuteContract` calling `contract` with the JSON `msg`, attaching `funds`.
pub fn execute_contract(
    chain: &Chain,
    sender: &str,
    contract: &str,
    msg: Vec<u8>,
    funds: &[Coin],
) -> Result<Any, Error> {
    chain.check_address(sender)?;
    chain.check_address(contract)?;
    cosmwasm::parse(&msg)?;
    Ok(Any::pack(&MsgExecuteContract {
        sender: sender.into(),
        contract: contract.into(),
        msg,
        funds: funds.iter().map(Coin::to_proto).collect(),
    }))
}

/// Wrap `messages` into a SIGN_MODE_DIRECT request for `signer`.
pub fn direct_request(
    chain: &Chain,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
) -> Result<Request, Error> {
    tx_request(chain, signer, messages, opts, SignMode::Direct)
}

/// Wrap `messages` into a LEGACY_AMINO_JSON transaction for `signer`, for hardware wallets
/// that sign amino JSON (Ledger's Cosmos app). Pass it to [`crate::amino::from_tx`].
pub fn amino_request(
    chain: &Chain,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
) -> Result<Request, Error> {
    tx_request(chain, signer, messages, opts, SignMode::LegacyAminoJson)
}

fn tx_request(
    chain: &Chain,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
    mode: SignMode,
) -> Result<Request, Error> {
    if messages.is_empty() {
        return Err(Error::NoMessages);
    }
    if let Some(g) = &opts.fee.granter {
        chain.check_address(g)?;
    }
    let body = TxBody {
        messages,
        memo: opts.memo.clone(),
        timeout_height: opts.timeout_height,
        extension_options: vec![],
        non_critical_extension_options: vec![],
    };
    let auth = AuthInfo {
        signer_infos: vec![SignerInfo {
            public_key: Some(Any {
                type_url: chain.pub_key_type_url().into(),
                value: PubKey {
                    key: signer.compressed().to_vec(),
                }
                .encode_to_vec(),
            }),
            mode_info: Some(ModeInfo {
                sum: Some(mode_info::Sum::Single(mode_info::Single { mode: mode as i32 })),
            }),
            sequence: opts.sequence,
        }],
        fee: Some(ProtoFee {
            amount: opts.fee.amount.iter().map(Coin::to_proto).collect(),
            gas_limit: opts.fee.gas_limit,
            payer: String::new(),
            granter: opts.fee.granter.clone().unwrap_or_default(),
        }),
        ..Default::default() // `tip`: deprecated, never set
    };
    Ok(Request {
        body_bytes: body.encode_to_vec(),
        auth_info_bytes: auth.encode_to_vec(),
        chain_id: chain.chain_id.into(),
        account_number: opts.account_number,
    })
}

/// A canonical, positive amount.
pub fn check_amount(amount: &str) -> Result<(), Error> {
    if is_canonical_amount(amount) && amount != "0" {
        Ok(())
    } else {
        Err(Error::Amount(amount.into()))
    }
}
