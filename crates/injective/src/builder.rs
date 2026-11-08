//! The wallet's own Cosmos-side transactions.
//!
//! Build the messages, wrap them with [`direct_request`], then pass the request through
//! [`crate::direct::decode`] like any dapp request before signing it.
//!
//! How each kind of token moves:
//!
//! | Token | Send with |
//! | --- | --- |
//! | Bank denom (`inj`, `peggy…`, `ibc/…`, `factory/…`, bank-backed `erc20:0x…`) | [`bank_send`] |
//! | CW20 | [`cw20_transfer`] |
//! | CW20 → its adapter bank denom | [`cw20_to_bank`] |
//! | Adapter bank denom → CW20 | [`bank_to_cw20`] |
//!
//! A bank denom with an ERC20 token pair is the same balance as that ERC20, so converting
//! a CW20 to bank also makes it usable as an ERC20 wherever its adapter denom has a pair.
//! Pure ERC20s (balances in contract storage) move only through EVM transactions.

use choice_wallet_core::{EthAddress, PublicKey};
use prost::Message;

use crate::Error;
use crate::chain::Network;
use crate::cosmwasm;
use crate::direct::Request;
use crate::msg::{Coin, is_canonical_amount};
use crate::proto::cosmos::bank::v1beta1::MsgSend;
use crate::proto::cosmos::tx::signing::v1beta1::SignMode;
use crate::proto::cosmos::tx::v1beta1::{AuthInfo, Fee as ProtoFee, ModeInfo, SignerInfo, TxBody, mode_info};
use crate::proto::cosmwasm::wasm::v1::MsgExecuteContract;
use crate::proto::injective::crypto::v1beta1::ethsecp256k1::PubKey;
use crate::wkt::Any;

/// Fee for a transaction the wallet builds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fee {
    /// Coins paid, usually one `inj` coin.
    pub amount: Vec<Coin>,
    /// Gas limit.
    pub gas_limit: u64,
    /// Pay through this account's fee grant.
    pub granter: Option<EthAddress>,
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
pub fn bank_send(from: &EthAddress, to: &EthAddress, amount: &[Coin]) -> Result<Any, Error> {
    if amount.is_empty() {
        return Err(Error::Amount(String::new()));
    }
    let mut coins = amount.to_vec();
    coins.sort();
    if let Some(w) = coins.windows(2).find(|w| w[0].denom() == w[1].denom()) {
        return Err(Error::Denom(w[0].denom().into()));
    }
    Ok(Any::pack(&MsgSend {
        from_address: from.to_inj(),
        to_address: to.to_inj(),
        amount: coins.iter().map(Coin::to_proto).collect(),
    }))
}

/// CW20 `transfer` of `amount` base units of the token at `cw20` to `recipient`.
pub fn cw20_transfer(from: &EthAddress, cw20: &EthAddress, recipient: &EthAddress, amount: &str) -> Result<Any, Error> {
    check_amount(amount)?;
    Ok(execute(
        from,
        cw20,
        cosmwasm::transfer(&recipient.to_inj(), amount),
        vec![],
    ))
}

/// Convert `amount` of the CW20 at `cw20` into the bank denom [`adapter_denom`], by sending
/// it to the CW20 adapter. The adapter mints the bank denom to `from`.
pub fn cw20_to_bank(from: &EthAddress, cw20: &EthAddress, adapter: &EthAddress, amount: &str) -> Result<Any, Error> {
    check_amount(amount)?;
    Ok(execute(
        from,
        cw20,
        cosmwasm::send(&adapter.to_inj(), amount, ""),
        vec![],
    ))
}

/// Convert `amount` of the adapter bank denom for `cw20` back into the CW20, delivered to
/// `recipient` (often `from` itself).
pub fn bank_to_cw20(
    from: &EthAddress,
    adapter: &EthAddress,
    cw20: &EthAddress,
    amount: &str,
    recipient: &EthAddress,
) -> Result<Any, Error> {
    let funds = Coin::new(&adapter_denom(adapter, cw20), amount)?;
    Ok(execute(
        from,
        adapter,
        cosmwasm::redeem_and_transfer(&recipient.to_inj()),
        vec![funds],
    ))
}

/// The bank denom the CW20 adapter mints for `cw20`: `factory/{adapter}/{cw20}`.
pub fn adapter_denom(adapter: &EthAddress, cw20: &EthAddress) -> String {
    format!("factory/{}/{}", adapter.to_inj(), cw20.to_inj())
}

/// The CW20 adapter on `network`, if we have verified one.
pub fn network_adapter(network: &Network) -> Option<EthAddress> {
    network
        .cw20_adapter
        .map(|a| EthAddress::parse_bech32(a, "inj").expect("built-in adapter address is valid"))
}

/// Wrap `messages` into a SIGN_MODE_DIRECT request for `signer`.
pub fn direct_request(
    network: &Network,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
) -> Result<Request, Error> {
    tx_request(network, signer, messages, opts, SignMode::Direct)
}

/// Wrap `messages` into a LEGACY_AMINO_JSON transaction for `signer`, for hardware wallets
/// that sign amino JSON (Ledger's Cosmos app). Pass it to [`crate::amino::from_tx`].
pub fn amino_request(
    network: &Network,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
) -> Result<Request, Error> {
    tx_request(network, signer, messages, opts, SignMode::LegacyAminoJson)
}

fn tx_request(
    network: &Network,
    signer: &PublicKey,
    messages: Vec<Any>,
    opts: &TxOptions,
    mode: SignMode,
) -> Result<Request, Error> {
    if messages.is_empty() {
        return Err(Error::NoMessages);
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
            public_key: Some(Any::pack(&PubKey {
                key: signer.compressed().to_vec(),
            })),
            mode_info: Some(ModeInfo {
                sum: Some(mode_info::Sum::Single(mode_info::Single { mode: mode as i32 })),
            }),
            sequence: opts.sequence,
        }],
        fee: Some(ProtoFee {
            amount: opts.fee.amount.iter().map(Coin::to_proto).collect(),
            gas_limit: opts.fee.gas_limit,
            payer: String::new(),
            granter: opts.fee.granter.map(|g| g.to_inj()).unwrap_or_default(),
        }),
        ..Default::default() // `tip`: deprecated, never set
    };
    Ok(Request {
        body_bytes: body.encode_to_vec(),
        auth_info_bytes: auth.encode_to_vec(),
        chain_id: network.chain_id.into(),
        account_number: opts.account_number,
    })
}

fn check_amount(amount: &str) -> Result<(), Error> {
    if is_canonical_amount(amount) && amount != "0" {
        Ok(())
    } else {
        Err(Error::Amount(amount.into()))
    }
}

fn execute(sender: &EthAddress, contract: &EthAddress, msg: Vec<u8>, funds: Vec<Coin>) -> Any {
    Any::pack(&MsgExecuteContract {
        sender: sender.to_inj(),
        contract: contract.to_inj(),
        msg,
        funds: funds.iter().map(Coin::to_proto).collect(),
    })
}
