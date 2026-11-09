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
    amount: String,
    nonce: U64,
    gas_limit: U64,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
}

pub(crate) fn evm(p: EvmParams) -> Result<Value, VaultError> {
    let entry = chains::find(&p.chain)?;
    let chain_id = entry.evm()?;
    let address = |s: &str| -> Result<choice_wallet_core::EthAddress, VaultError> {
        choice_wallet_core::EthAddress::parse_hex(&entry.parse_address(s)?).map_err(|_| VaultError::bad("address"))
    };
    let amount = U256::from_dec_str(&p.amount)?;
    let to = address(&p.to)?;
    let mut tx = match &p.token {
        Some(token) => Eip1559Tx::erc20_transfer(chain_id, address(token)?, &to, amount)?,
        None => Eip1559Tx::native_transfer(chain_id, to, amount)?,
    };
    tx.nonce = p.nonce.0;
    tx.gas_limit = p.gas_limit.0;
    let fee = |s: &str| {
        U256::from_dec_str(s)?
            .to_u128()
            .ok_or_else(|| VaultError::new(INVALID, format!("fee {s} out of range")))
    };
    tx.max_fee_per_gas = fee(&p.max_fee_per_gas)?;
    tx.max_priority_fee_per_gas = fee(&p.max_priority_fee_per_gas)?;
    let q = |n: u128| U256::from_u128(n).to_quantity();
    Ok(json!({
        "evm_transaction": {
            "chain": entry.id,
            "tx": {
                "type": "0x2",
                "chainId": q(u128::from(chain_id)),
                "from": address(&p.from)?.to_checksum_hex(),
                "to": tx.to.to_checksum_hex(),
                "value": tx.value.to_quantity(),
                "data": format!("0x{}", hexutil::encode(&tx.data)),
                "nonce": q(u128::from(tx.nonce)),
                "gas": q(u128::from(tx.gas_limit)),
                "maxFeePerGas": q(tx.max_fee_per_gas),
                "maxPriorityFeePerGas": q(tx.max_priority_fee_per_gas),
            }
        }
    }))
}
