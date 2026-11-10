//! The wallet's own transactions. Each builder returns a sign request in the same form a
//! dapp's would take, which then goes through `decode` and `sign` like any other: the
//! wallet's own sends get no shortcut past the checks.

use choice_wallet_core::PublicKey;
use choice_wallet_core::hexutil;
use choice_wallet_cosmos::builder::{self, Fee, TxOptions};
use choice_wallet_cosmos::msg::Coin;
use choice_wallet_evm::{Eip1559Tx, U256};
use choice_wallet_injective::adapter;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::chains;
use crate::error::{INVALID, VaultError};
use crate::util::{U64, hex};

/// One message of a Cosmos transaction the wallet builds.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum OwnMsg {
    /// Bank send.
    BankSend { to: String, amount: Vec<Coin> },
    /// CW20 transfer of `amount` base units of the token at `contract`.
    Cw20Transfer {
        contract: String,
        to: String,
        amount: String,
    },
    /// CW721 `transfer_nft` of NFT `token_id` in the collection at `contract`.
    NftTransfer {
        contract: String,
        to: String,
        token_id: String,
    },
    /// Injective: CW20 → its bank denom, through the network's CW20 adapter.
    Cw20ToBank { contract: String, amount: String },
    /// Injective: adapter bank denom → the CW20 at `contract`, to `to` (default: the signer).
    BankToCw20 {
        contract: String,
        amount: String,
        #[serde(default)]
        to: Option<String>,
    },
    /// Stake `amount` with `validator` (`…valoper1…`).
    Delegate { validator: String, amount: Coin },
    /// Start unstaking `amount` from `validator`.
    Undelegate { validator: String, amount: Coin },
    /// Move `amount` of the stake with `from` to `to`.
    Redelegate { from: String, to: String, amount: Coin },
    /// Stake again `amount` of the unbonding entry with `validator` that started at `height`.
    CancelUnbonding {
        validator: String,
        amount: Coin,
        height: U64,
    },
    /// Claim the rewards of the stake with `validator`.
    WithdrawRewards { validator: String },
    /// Take back the authz permission for `msg_type_url` given to `grantee`.
    AuthzRevoke { grantee: String, msg_type_url: String },
    /// Take back the fee allowance given to `grantee`.
    FeeRevoke { grantee: String },
    /// Send staking rewards to the signer itself again.
    ResetWithdrawAddress {},
    /// Send staking rewards to `to` from now on (a rescue moves them to the rescue address).
    SetWithdrawAddress { to: String },
    /// Injective: give `amount` of the stake with `validator` to `to`, at once.
    TransferDelegation {
        validator: String,
        to: String,
        amount: Coin,
    },
    /// Injective: `amount` from the signer's trading subaccount back to its balance.
    ExchangeWithdraw { subaccount_id: String, amount: Coin },
    /// A fee allowance for `grantee`: up to `spend_limit`, for `allowed_messages` only.
    FeeGrant {
        grantee: String,
        spend_limit: Vec<Coin>,
        allowed_messages: Vec<String>,
    },
    /// CW20 `decrease_allowance` of `spender` by `amount` on the token at `contract`.
    Cw20DecreaseAllowance {
        contract: String,
        spender: String,
        amount: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OwnFee {
    amount: Vec<Coin>,
    gas_limit: U64,
    #[serde(default)]
    granter: Option<String>,
}

#[derive(Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SignMode {
    /// SIGN_MODE_DIRECT, for software keys.
    #[default]
    Direct,
    /// LEGACY_AMINO_JSON, for Ledger's Cosmos app.
    AminoJson,
}

/// Parameters of `build_cosmos`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CosmosParams {
    chain: String,
    /// The signer's compressed public key, hex.
    signer: String,
    messages: Vec<OwnMsg>,
    account_number: U64,
    sequence: U64,
    fee: OwnFee,
    #[serde(default)]
    memo: String,
    #[serde(default)]
    timeout_height: U64,
    #[serde(default)]
    sign_mode: SignMode,
}

/// `build_cosmos`: the sign request, and the same transaction with an empty signature for
/// the chain's simulate endpoint (`simulate_tx`, hex).
pub(crate) fn cosmos(p: CosmosParams) -> Result<Value, VaultError> {
    let entry = chains::find(&p.chain)?;
    let chain = entry.cosmos()?;
    let pk = PublicKey::from_sec1_bytes(&hex(&p.signer, "signer")?)
        .map_err(|_| VaultError::bad("signer is not a public key"))?;
    let from = chain.address(&pk);
    let adapter = || {
        entry
            .injective
            .and_then(|n| n.cw20_adapter)
            .ok_or_else(|| VaultError::new(INVALID, format!("no verified CW20 adapter on {}", entry.id)))
    };
    let network = || {
        entry
            .injective
            .ok_or_else(|| VaultError::new(INVALID, "CW20 adapter conversions are Injective only"))
    };
    let addr = |s: &str| entry.parse_address(s);

    let mut msgs = Vec::with_capacity(p.messages.len());
    for m in p.messages {
        msgs.push(match m {
            OwnMsg::BankSend { to, amount } => builder::bank_send(chain, &from, &addr(&to)?, &amount)?,
            OwnMsg::Cw20Transfer { contract, to, amount } => {
                builder::cw20_transfer(chain, &from, &addr(&contract)?, &addr(&to)?, &amount)?
            }
            OwnMsg::NftTransfer { contract, to, token_id } => {
                builder::nft_transfer(chain, &from, &addr(&contract)?, &addr(&to)?, &token_id)?
            }
            OwnMsg::Cw20ToBank { contract, amount } => {
                adapter::cw20_to_bank(network()?, &from, &addr(&contract)?, adapter()?, &amount)?
            }
            OwnMsg::BankToCw20 { contract, amount, to } => {
                let to = match to {
                    Some(t) => addr(&t)?,
                    None => from.clone(),
                };
                adapter::bank_to_cw20(network()?, &from, adapter()?, &addr(&contract)?, &amount, &to)?
            }
            OwnMsg::Delegate { validator, amount } => builder::delegate(chain, &from, &validator, &amount)?,
            OwnMsg::Undelegate { validator, amount } => builder::undelegate(chain, &from, &validator, &amount)?,
            OwnMsg::Redelegate { from: src, to, amount } => builder::redelegate(chain, &from, &src, &to, &amount)?,
            OwnMsg::CancelUnbonding {
                validator,
                amount,
                height,
            } => {
                let h = i64::try_from(height.0).map_err(|_| VaultError::bad("height"))?;
                builder::cancel_unbonding(chain, &from, &validator, &amount, h)?
            }
            OwnMsg::WithdrawRewards { validator } => builder::withdraw_rewards(chain, &from, &validator)?,
            OwnMsg::AuthzRevoke { grantee, msg_type_url } => {
                builder::authz_revoke(chain, &from, &addr(&grantee)?, &msg_type_url)?
            }
            OwnMsg::FeeRevoke { grantee } => builder::fee_revoke(chain, &from, &addr(&grantee)?)?,
            OwnMsg::ResetWithdrawAddress {} => builder::reset_withdraw_address(chain, &from)?,
            OwnMsg::SetWithdrawAddress { to } => builder::set_withdraw_address(chain, &from, &addr(&to)?)?,
            OwnMsg::TransferDelegation { validator, to, amount } => {
                builder::transfer_delegation(chain, &from, &validator, &addr(&to)?, &amount)?
            }
            OwnMsg::ExchangeWithdraw { subaccount_id, amount } => {
                builder::exchange_withdraw(chain, &from, &subaccount_id, &amount)?
            }
            OwnMsg::FeeGrant {
                grantee,
                spend_limit,
                allowed_messages,
            } => builder::fee_grant(chain, &from, &addr(&grantee)?, &spend_limit, &allowed_messages)?,
            OwnMsg::Cw20DecreaseAllowance {
                contract,
                spender,
                amount,
            } => builder::cw20_decrease_allowance(chain, &from, &addr(&contract)?, &addr(&spender)?, &amount)?,
        });
    }
    let opts = TxOptions {
        account_number: p.account_number.0,
        sequence: p.sequence.0,
        fee: Fee {
            amount: p.fee.amount,
            gas_limit: p.fee.gas_limit.0,
            granter: p.fee.granter.map(|g| addr(&g)).transpose()?,
        },
        memo: p.memo,
        timeout_height: p.timeout_height.0,
    };
    let (req, kind) = if p.sign_mode == SignMode::AminoJson {
        (builder::amino_request(chain, &pk, msgs, &opts)?, "cosmos_amino_tx")
    } else {
        (builder::direct_request(chain, &pk, msgs, &opts)?, "cosmos_direct")
    };
    let tx = json!({
        "chain": entry.id,
        "signer": p.signer,
        "body_bytes": hexutil::encode(&req.body_bytes),
        "auth_info_bytes": hexutil::encode(&req.auth_info_bytes),
        "account_number": req.account_number.to_string(),
    });
    Ok(json!({
        "request": Value::Object([(kind.to_owned(), tx)].into_iter().collect()),
        "simulate_tx": hexutil::encode(&req.simulation_tx()),
    }))
}

/// Parameters of `build_evm`. Amounts and fees are decimal strings in base units / wei.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EvmParams {
    chain: String,
    from: String,
    to: String,
    /// The ERC20 contract, for a token transfer; absent for the native coin.
    #[serde(default)]
    token: Option<String>,
    /// Instead of a transfer: take back this spender's allowance of `token` (`approve(spender,
    /// 0)`). `to` must be the token and `amount` "0".
    #[serde(default)]
    revoke: Option<String>,
    /// Instead of a transfer: one step of a Choice swap. `amount` is the INJ sent with a
    /// swap, or the allowance an approval gives.
    #[serde(default)]
    call: Option<OwnCall>,
    amount: String,
    nonce: U64,
    gas_limit: U64,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
}

/// A contract call the wallet makes itself on Injective EVM: a step of a Choice swap, an NFT
/// transfer, or a step of a bridge transfer.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum OwnCall {
    /// The swap: calldata from Choice's routing API, sent to its executor (`to`). Built
    /// only when the vault reads it as a swap that pays the sender, with a minimum, any fee
    /// to Choice's treasury, and no adapter Choice doesn't trust.
    Swap { data: String },
    /// `approve(Permit2, amount)` on the ERC20 at `to`: exactly what one swap spends.
    Approve,
    /// `Permit2.approve(token, spender, amount, expiration)` at Permit2 (`to`), for a Choice
    /// executor.
    Permit2Approve {
        token: String,
        spender: String,
        expiration: U64,
    },
    /// ERC721 `safeTransferFrom(from, to, token_id)` on `collection`, to the recipient `to`.
    /// `amount` is "0".
    NftTransfer { collection: String, token_id: String },
    /// `approve(TokenMessengerV2, amount)` on the chain's USDC (`to`): exactly what one
    /// bridge transfer burns. On any chain on CCTP.
    BridgeApprove,
    /// A bridge transfer: `TokenMessengerV2` calldata (built by `injective-usdc-bridge`),
    /// sent to it (`to`), on any chain on CCTP. Built only when `cctp::transfer` reads it as
    /// one the wallet makes: the chain's USDC, to another chain the wallet names, at an
    /// address that chain can use, that someone is set to deliver, with every fee below the
    /// amount. `amount` is "0".
    Bridge { data: String },
    /// `MessageTransmitterV2.receiveMessage(message, attestation)` (`to`): mints a transfer
    /// Circle attested, from a chain the wallet names, of its USDC, to this chain, which
    /// anyone may submit (the review says when it pays someone else). `amount` is "0". Both
    /// are hex.
    BridgeReceive { message: String, attestation: String },
}

fn own_call(
    entry: &chains::Entry,
    chain_id: u64,
    from: &choice_wallet_core::EthAddress,
    to: choice_wallet_core::EthAddress,
    amount: U256,
    call: &OwnCall,
) -> Result<Eip1559Tx, VaultError> {
    use choice_wallet_injective::choice;
    let coin = entry.native.0;
    // Bridge calls are made on any chain on CCTP; Choice's only on Injective EVM.
    let bridge = || {
        entry
            .bridge
            .ok_or_else(|| VaultError::new(INVALID, format!("{} isn't on Circle's bridge", entry.name)))
    };
    let injective = || {
        entry
            .injective
            .ok_or_else(|| VaultError::new(INVALID, "Choice's swaps are on Injective only"))
    };
    let parse = |s: &str| {
        choice_wallet_core::EthAddress::parse_hex(&entry.parse_address(s)?).map_err(|_| VaultError::bad("address"))
    };
    let unlimited = U256::from_dec_str("1267650600228229401496703205376")?; // 2^100, the risk rules' "unlimited"
    match call {
        OwnCall::Swap { data } => {
            let c = &injective()?.choice;
            let data = hex(data.strip_prefix("0x").unwrap_or(data), "data")?;
            let s = choice::swap(c, &to, amount, &data)
                .ok_or_else(|| VaultError::bad("that isn't a Choice swap contract on this network"))?
                .map_err(|e| VaultError::bad(format!("not a swap the wallet can read: {e}")))?;
            let refuse = |why: &str| Err(VaultError::bad(format!("refused: {why}")));
            if s.recipient.is_some_and(|r| r != *from) {
                return refuse("the swap pays someone else");
            }
            if s.minimum_out.is_zero() {
                return refuse("the swap has no minimum");
            }
            if s.fee_bps > 0 && s.fee_recipient != Some(c.treasury()) {
                return refuse("the fee goes somewhere other than Choice's treasury");
            }
            if s.venues
                .iter()
                .any(|v| matches!(v, choice::Venue::Adapter { adapter } if !c.trusts_adapter(adapter)))
            {
                return refuse("the route runs an adapter Choice doesn't trust");
            }
            if s.permit.is_some() {
                return refuse("the wallet approves on chain, not by a signed permit");
            }
            let inj = s.token_in == choice_wallet_core::EthAddress::from_bytes([0; 20]);
            if !amount.is_zero() && !(inj && amount == s.amount_in) {
                return refuse("the INJ sent doesn't match the swap");
            }
            Ok(Eip1559Tx::contract_call(chain_id, to, amount, data))
        }
        OwnCall::Approve => {
            let c = &injective()?.choice;
            if amount.is_zero() || amount >= unlimited {
                return Err(VaultError::bad("an approval for a swap is for the exact amount"));
            }
            Ok(Eip1559Tx::contract_call(
                chain_id,
                to,
                U256::ZERO,
                choice_wallet_evm::erc20::approve_calldata(&c.permit2(), &amount),
            ))
        }
        OwnCall::NftTransfer { .. } => unreachable!("built in evm()"),
        OwnCall::BridgeApprove => {
            let (network, local) = bridge()?;
            if to != local.usdc() {
                return Err(VaultError::bad("a bridge approval is on USDC"));
            }
            if amount.is_zero() || amount >= unlimited {
                return Err(VaultError::bad(
                    "an approval for a bridge transfer is for the exact amount",
                ));
            }
            Ok(Eip1559Tx::contract_call(
                chain_id,
                to,
                U256::ZERO,
                choice_wallet_evm::erc20::approve_calldata(&network.cctp.token_messenger(), &amount),
            ))
        }
        OwnCall::Bridge { data } => {
            use choice_wallet_injective::cctp;
            let (network, local) = bridge()?;
            let c = &network.cctp;
            let data = hex(data.strip_prefix("0x").unwrap_or(data), "data")?;
            if !amount.is_zero() {
                return Err(VaultError::bad(format!("a bridge transfer sends no {coin}")));
            }
            let b = cctp::burn(c, &to, amount, &data)
                .ok_or_else(|| VaultError::bad("that isn't Circle's TokenMessengerV2 on this network"))?
                .map_err(|e| VaultError::bad(format!("not a burn the wallet can read: {e}")))?;
            cctp::transfer(c, local, b).map_err(|e| VaultError::bad(format!("refused: {e}")))?;
            Ok(Eip1559Tx::contract_call(chain_id, to, U256::ZERO, data))
        }
        OwnCall::BridgeReceive { message, attestation } => {
            use choice_wallet_injective::cctp;
            let (network, local) = bridge()?;
            let c = &network.cctp;
            if !amount.is_zero() {
                return Err(VaultError::bad(format!("a mint sends no {coin}")));
            }
            let strip = |s: &str| s.strip_prefix("0x").unwrap_or(s).to_owned();
            let data = cctp::receive_calldata(
                &hex(&strip(message), "message")?,
                &hex(&strip(attestation), "attestation")?,
            );
            let m = cctp::receive(c, &to, U256::ZERO, &data)
                .ok_or_else(|| VaultError::bad("that isn't Circle's MessageTransmitterV2 on this network"))?
                .map_err(|e| VaultError::bad(format!("not a mint the wallet can read: {e}")))?;
            let refuse = |why: &str| Err(VaultError::bad(format!("refused: {why}")));
            let Some(source) = c.inbound(m.source_domain) else {
                return refuse("it comes from a chain the wallet doesn't name");
            };
            let tm = cctp::word(&c.token_messenger());
            if m.destination_domain != local.domain || m.sender != source.sender || m.recipient != tm {
                return refuse(&format!("it isn't a USDC transfer to {}", local.name));
            }
            if m.burn_token != source.burn_token {
                return refuse("it mints a token other than USDC");
            }
            // Anyone's transfer may be completed (the wallet pays the gas, as the review says),
            // but not one only some other address may submit, nor an empty one.
            if !m.permissionless() || m.paid().is_none() || m.amount.is_zero() {
                return refuse("it isn't one this account can complete");
            }
            Ok(Eip1559Tx::contract_call(chain_id, to, U256::ZERO, data))
        }
        OwnCall::Permit2Approve {
            token,
            spender,
            expiration,
        } => {
            let c = &injective()?.choice;
            let spender = parse(spender)?;
            if to != c.permit2() || c.executor(&spender).is_none() {
                return Err(VaultError::bad(
                    "a Permit2 approval goes to Permit2, for a Choice swap contract",
                ));
            }
            if amount.is_zero() || amount >= unlimited {
                return Err(VaultError::bad("an approval for a swap is for the exact amount"));
            }
            let data = choice::permit2_approve_calldata(&parse(token)?, &spender, amount, expiration.0)
                .ok_or_else(|| VaultError::bad("amount or expiration out of range for Permit2"))?;
            Ok(Eip1559Tx::contract_call(chain_id, to, U256::ZERO, data))
        }
    }
}

pub(crate) fn evm(p: EvmParams) -> Result<Value, VaultError> {
    let entry = chains::find(&p.chain)?;
    let chain_id = entry.evm()?;
    let address = |s: &str| -> Result<choice_wallet_core::EthAddress, VaultError> {
        choice_wallet_core::EthAddress::parse_hex(&entry.parse_address(s)?).map_err(|_| VaultError::bad("address"))
    };
    let amount = U256::from_dec_str(&p.amount)?;
    let to = address(&p.to)?;
    let from = address(&p.from)?;
    let mut tx = match (&p.token, &p.revoke, &p.call) {
        (None, None, Some(OwnCall::NftTransfer { collection, token_id })) => {
            if !amount.is_zero() {
                return Err(VaultError::bad(format!("an NFT transfer sends no {}", entry.native.0)));
            }
            if to == from {
                return Err(VaultError::bad("that NFT is already this account's"));
            }
            let id = U256::from_dec_str(token_id)?;
            Eip1559Tx::contract_call(
                chain_id,
                address(collection)?,
                U256::ZERO,
                choice_wallet_evm::erc20::nft_transfer_calldata(&from, &to, &id),
            )
        }
        (None, None, Some(call)) => own_call(entry, chain_id, &from, to, amount, call)?,
        (_, _, Some(_)) => return Err(VaultError::bad("a call takes no token or revoke")),
        (Some(token), Some(spender), None) => {
            let token = address(token)?;
            if token != to || !amount.is_zero() {
                return Err(VaultError::bad("a revoke goes to the token, with amount 0"));
            }
            Eip1559Tx::erc20_revoke(chain_id, token, &address(spender)?)
        }
        (None, Some(_), None) => return Err(VaultError::bad("a revoke needs the token")),
        (Some(token), None, None) => Eip1559Tx::erc20_transfer(chain_id, address(token)?, &to, amount)?,
        (None, None, None) => Eip1559Tx::native_transfer(chain_id, to, amount)?,
    };
    with_fees(&mut tx, &p)?;
    Ok(request(entry.id, &from, &tx))
}

fn with_fees(tx: &mut Eip1559Tx, p: &EvmParams) -> Result<(), VaultError> {
    tx.nonce = p.nonce.0;
    tx.gas_limit = p.gas_limit.0;
    let fee = |s: &str| {
        U256::from_dec_str(s)?
            .to_u128()
            .ok_or_else(|| VaultError::new(INVALID, format!("fee {s} out of range")))
    };
    tx.max_fee_per_gas = fee(&p.max_fee_per_gas)?;
    tx.max_priority_fee_per_gas = fee(&p.max_priority_fee_per_gas)?;
    Ok(())
}

/// The sign request for `tx`, in the form a dapp's `eth_sendTransaction` takes.
fn request(chain: &str, from: &choice_wallet_core::EthAddress, tx: &Eip1559Tx) -> Value {
    let q = |n: u128| U256::from_u128(n).to_quantity();
    json!({
        "evm_transaction": {
            "chain": chain,
            "tx": {
                "type": "0x2",
                "chainId": q(u128::from(tx.chain_id)),
                "from": from.to_checksum_hex(),
                "to": tx.to.to_checksum_hex(),
                "value": tx.value.to_quantity(),
                "data": format!("0x{}", hexutil::encode(&tx.data)),
                "nonce": q(u128::from(tx.nonce)),
                "gas": q(u128::from(tx.gas_limit)),
                "maxFeePerGas": q(tx.max_fee_per_gas),
                "maxPriorityFeePerGas": q(tx.max_priority_fee_per_gas),
            }
        }
    })
}
