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
use crate::proto::cosmos::distribution::v1beta1::{MsgSetWithdrawAddress, MsgWithdrawDelegatorReward};
use crate::proto::cosmos::tx::signing::v1beta1::SignMode;
use crate::proto::cosmos::tx::v1beta1::{AuthInfo, Fee as ProtoFee, ModeInfo, SignerInfo, TxBody, mode_info};
use crate::proto::cosmos::{authz::v1beta1 as authz, feegrant::v1beta1 as feegrant};
use crate::proto::cosmwasm::wasm::v1::MsgExecuteContract;
use crate::staking;
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

/// CW721 `transfer_nft` of NFT `token_id` in the collection at `cw721` to `recipient`.
pub fn nft_transfer(chain: &Chain, from: &str, cw721: &str, recipient: &str, token_id: &str) -> Result<Any, Error> {
    if !cosmwasm::is_token_id(token_id) {
        return Err(Error::ContractJson);
    }
    chain.check_address(recipient)?;
    if recipient == from {
        return Err(Error::Address(recipient.into()));
    }
    execute_contract(chain, from, cw721, cosmwasm::transfer_nft(recipient, token_id), &[])
}

/// CW20 `send` of `amount` base units of the token at `cw20` to the contract `to`, calling
/// its receive hook with `msg` (base64; empty for none).
pub fn cw20_send(chain: &Chain, from: &str, cw20: &str, to: &str, amount: &str, msg: &str) -> Result<Any, Error> {
    check_amount(amount)?;
    chain.check_address(to)?;
    execute_contract(chain, from, cw20, cosmwasm::send(to, amount, msg), &[])
}

/// Stake `amount` with `validator`.
pub fn delegate(chain: &Chain, delegator: &str, validator: &str, amount: &Coin) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(validator)?;
    Ok(Any::pack(&staking::MsgDelegate {
        delegator_address: delegator.into(),
        validator_address: validator.into(),
        amount: Some(amount.to_proto()),
    }))
}

/// Start unstaking `amount` from `validator`.
pub fn undelegate(chain: &Chain, delegator: &str, validator: &str, amount: &Coin) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(validator)?;
    Ok(Any::pack(&staking::MsgUndelegate {
        delegator_address: delegator.into(),
        validator_address: validator.into(),
        amount: Some(amount.to_proto()),
    }))
}

/// Move `amount` of the stake with `from` to `to`. Moving to the same validator is refused,
/// as the chain would.
pub fn redelegate(chain: &Chain, delegator: &str, from: &str, to: &str, amount: &Coin) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(from)?;
    chain.check_validator(to)?;
    if from == to {
        return Err(Error::Address(to.into()));
    }
    Ok(Any::pack(&staking::MsgBeginRedelegate {
        delegator_address: delegator.into(),
        validator_src_address: from.into(),
        validator_dst_address: to.into(),
        amount: Some(amount.to_proto()),
    }))
}

/// Stake again `amount` of the unbonding entry with `validator` that started at
/// `creation_height`.
pub fn cancel_unbonding(
    chain: &Chain,
    delegator: &str,
    validator: &str,
    amount: &Coin,
    creation_height: i64,
) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(validator)?;
    if creation_height <= 0 {
        return Err(Error::Decode("creation_height"));
    }
    Ok(Any::pack(&staking::MsgCancelUnbondingDelegation {
        delegator_address: delegator.into(),
        validator_address: validator.into(),
        amount: Some(amount.to_proto()),
        creation_height,
    }))
}

/// Claim the rewards of the stake with `validator`.
pub fn withdraw_rewards(chain: &Chain, delegator: &str, validator: &str) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(validator)?;
    Ok(Any::pack(&MsgWithdrawDelegatorReward {
        delegator_address: delegator.into(),
        validator_address: validator.into(),
    }))
}

/// Take back every permission of one message type that `granter` gave `grantee` (authz).
pub fn authz_revoke(chain: &Chain, granter: &str, grantee: &str, msg_type_url: &str) -> Result<Any, Error> {
    chain.check_address(granter)?;
    chain.check_address(grantee)?;
    let ok = msg_type_url.len() <= 128
        && msg_type_url.starts_with('/')
        && msg_type_url[1..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_');
    if !ok {
        return Err(Error::Decode("msg_type_url"));
    }
    Ok(Any::pack(&authz::MsgRevoke {
        granter: granter.into(),
        grantee: grantee.into(),
        msg_type_url: msg_type_url.into(),
    }))
}

/// Take back the fee allowance `granter` gave `grantee`.
pub fn fee_revoke(chain: &Chain, granter: &str, grantee: &str) -> Result<Any, Error> {
    chain.check_address(granter)?;
    chain.check_address(grantee)?;
    Ok(Any::pack(&feegrant::MsgRevokeAllowance {
        granter: granter.into(),
        grantee: grantee.into(),
    }))
}

/// Send `delegator`'s staking rewards to `delegator` itself again.
pub fn reset_withdraw_address(chain: &Chain, delegator: &str) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    Ok(Any::pack(&MsgSetWithdrawAddress {
        delegator_address: delegator.into(),
        withdraw_address: delegator.into(),
    }))
}

/// Send `delegator`'s staking rewards to `to` from now on.
pub fn set_withdraw_address(chain: &Chain, delegator: &str, to: &str) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_address(to)?;
    Ok(Any::pack(&MsgSetWithdrawAddress {
        delegator_address: delegator.into(),
        withdraw_address: to.into(),
    }))
}

/// Injective's `MsgTransferDelegation`: give `amount` of the stake with `validator` to
/// `receiver`, at once (no unbonding period).
pub fn transfer_delegation(
    chain: &Chain,
    delegator: &str,
    validator: &str,
    receiver: &str,
    amount: &Coin,
) -> Result<Any, Error> {
    chain.check_address(delegator)?;
    chain.check_validator(validator)?;
    chain.check_address(receiver)?;
    if receiver == delegator {
        return Err(Error::Address(receiver.into()));
    }
    check_amount(amount.amount())?;
    Ok(Any::pack(&staking::MsgTransferDelegation {
        delegator_address: delegator.into(),
        validator_address: validator.into(),
        receiver_address: receiver.into(),
        amount: Some(amount.to_proto()),
    }))
}

/// A fee allowance from `granter` to `grantee`: up to `spend_limit` in all, with no end
/// date, for `allowed_messages` only (`AllowedMsgAllowance` around a `BasicAllowance`).
pub fn fee_grant(
    chain: &Chain,
    granter: &str,
    grantee: &str,
    spend_limit: &[Coin],
    allowed_messages: &[String],
) -> Result<Any, Error> {
    chain.check_address(granter)?;
    chain.check_address(grantee)?;
    if granter == grantee {
        return Err(Error::Address(grantee.into()));
    }
    // A limit, and a list of messages: an allowance without either could pay for anything.
    if spend_limit.is_empty() || allowed_messages.is_empty() || allowed_messages.len() > 16 {
        return Err(Error::Decode("fee allowance"));
    }
    for c in spend_limit {
        check_amount(c.amount())?;
    }
    for m in allowed_messages {
        let ok = m.len() <= 128
            && m.starts_with('/')
            && m[1..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_');
        if !ok {
            return Err(Error::Decode("allowed message type"));
        }
    }
    let basic = feegrant::BasicAllowance {
        spend_limit: spend_limit.iter().map(Coin::to_proto).collect(),
        expiration: None,
    };
    let allowed = feegrant::AllowedMsgAllowance {
        allowance: Some(Any::pack(&basic)),
        allowed_messages: allowed_messages.to_vec(),
    };
    Ok(Any::pack(&feegrant::MsgGrantAllowance {
        granter: granter.into(),
        grantee: grantee.into(),
        allowance: Some(Any::pack(&allowed)),
    }))
}

/// Injective: move `amount` from the signer's trading subaccount `subaccount_id` to its bank
/// balance (exchange `MsgWithdraw`). Only the signer's own subaccounts.
pub fn exchange_withdraw(chain: &Chain, from: &str, subaccount_id: &str, amount: &Coin) -> Result<Any, Error> {
    chain.check_address(from)?;
    check_amount(amount.amount())?;
    let own = choice_wallet_core::address::decode_bech32(from, chain.bech32_prefix)
        .ok()
        .is_some_and(|b| {
            b.len() == 20 && subaccount_id.get(2..42) == Some(choice_wallet_core::hexutil::encode(&b).as_str())
        });
    if !crate::msg::is_subaccount_id(subaccount_id) || !own {
        return Err(Error::Decode("subaccount_id"));
    }
    Ok(Any {
        type_url: crate::msg::EXCHANGE_WITHDRAW.into(),
        value: crate::msg::ExchangeMsgWithdraw {
            sender: from.into(),
            subaccount_id: subaccount_id.into(),
            amount: Some(amount.to_proto()),
        }
        .encode_to_vec(),
    })
}

/// CW20 `decrease_allowance` of `spender` by `amount` on the token at `cw20`.
pub fn cw20_decrease_allowance(
    chain: &Chain,
    owner: &str,
    cw20: &str,
    spender: &str,
    amount: &str,
) -> Result<Any, Error> {
    check_amount(amount)?;
    chain.check_address(spender)?;
    execute_contract(chain, owner, cw20, cosmwasm::decrease_allowance(spender, amount), &[])
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
