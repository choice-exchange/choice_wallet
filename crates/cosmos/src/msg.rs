//! Messages decoded from a transaction body.

use choice_wallet_core::hexutil;
use prost::Name;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::Error;
use crate::canonical::decode_exact;
use crate::chain::Chain;
use crate::cosmwasm::{self, ContractCall};
use crate::gov::{self, VoteOption};
use crate::proto::cosmos::bank::v1beta1::{self as bank, MsgSend};
use crate::proto::cosmos::base::v1beta1::Coin as ProtoCoin;
use crate::proto::cosmos::{
    authz::v1beta1 as authz, distribution::v1beta1 as distribution, feegrant::v1beta1 as feegrant,
};
use crate::proto::cosmwasm::wasm::v1::{self as wasm, MsgExecuteContract};
use crate::staking;
use crate::wkt::Any;

/// A bank coin with a valid denom and a canonical positive amount. In JSON it reads
/// `{"denom": …, "amount": …}`, with the same checks.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "JsonCoin")]
pub struct Coin {
    denom: String,
    amount: String,
}

impl Coin {
    /// A coin of `amount` base units of `denom`.
    pub fn new(denom: &str, amount: &str) -> Result<Self, Error> {
        if !is_valid_denom(denom) {
            return Err(Error::Denom(denom.into()));
        }
        if !is_canonical_amount(amount) || amount == "0" {
            return Err(Error::Amount(amount.into()));
        }
        Ok(Self {
            denom: denom.into(),
            amount: amount.into(),
        })
    }

    /// The denom, e.g. `inj`, `peggy0x…`, `ibc/…`, `factory/…`, `erc20:0x…`.
    pub fn denom(&self) -> &str {
        &self.denom
    }

    /// The amount in base units, as a decimal string.
    pub fn amount(&self) -> &str {
        &self.amount
    }

    pub(crate) fn to_proto(&self) -> ProtoCoin {
        ProtoCoin {
            denom: self.denom.clone(),
            amount: self.amount.clone(),
        }
    }

    fn from_proto(c: ProtoCoin) -> Result<Self, Error> {
        Self::new(&c.denom, &c.amount)
    }
}

/// A coin as it appears in JSON sign paths (`{"denom": …, "amount": …}`, either order),
/// before its checks.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct JsonCoin {
    denom: String,
    amount: String,
}

/// Check coins read from JSON.
pub(crate) fn coins_from_json(coins: Vec<JsonCoin>) -> Result<Vec<Coin>, Error> {
    coins.into_iter().map(Coin::try_from).collect()
}

impl TryFrom<JsonCoin> for Coin {
    type Error = Error;

    fn try_from(c: JsonCoin) -> Result<Self, Error> {
        Coin::new(&c.denom, &c.amount)
    }
}

/// The tokenfactory module's `MsgChangeAdmin`, written here from the wire format (Injective's
/// module is BUSL-licensed, so its `.proto` isn't vendored). Each chain's module has its own
/// package name, given by [`Chain::tokenfactory`].
#[derive(Clone, PartialEq, prost::Message)]
struct TokenfactoryMsgChangeAdmin {
    #[prost(string, tag = "1")]
    sender: String,
    #[prost(string, tag = "2")]
    denom: String,
    #[prost(string, tag = "3")]
    new_admin: String,
}

/// Injective's exchange `MsgWithdraw` (v2): move coins from a trading subaccount back to the
/// bank balance. Written from the wire format, like the tokenfactory message.
#[derive(Clone, PartialEq, prost::Message)]
pub(crate) struct ExchangeMsgWithdraw {
    #[prost(string, tag = "1")]
    pub(crate) sender: String,
    #[prost(string, tag = "2")]
    pub(crate) subaccount_id: String,
    #[prost(message, optional, tag = "3")]
    pub(crate) amount: Option<ProtoCoin>,
}

/// `/injective.exchange.v2.MsgWithdraw`.
pub const EXCHANGE_WITHDRAW: &str = "/injective.exchange.v2.MsgWithdraw";

/// A subaccount ID as Injective writes it: `0x`, the owner's 20-byte address, a 12-byte
/// nonce, lowercase hex.
pub fn is_subaccount_id(id: &str) -> bool {
    id.len() == 66
        && id.starts_with("0x")
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Decode a list of coins, refusing invalid ones.
pub(crate) fn coins_from_proto(coins: Vec<ProtoCoin>) -> Result<Vec<Coin>, Error> {
    coins.into_iter().map(Coin::from_proto).collect()
}

/// The one coin a staking message carries; it must be there and valid.
fn one_coin(c: Option<ProtoCoin>, field: &'static str) -> Result<Coin, Error> {
    Coin::from_proto(c.ok_or(Error::Decode(field))?)
}

/// What an authz grant lets the grantee do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Authorization {
    /// `GenericAuthorization`: run any message of this type as the granter, without limit.
    Generic {
        /// The message type URL, e.g. `/cosmos.bank.v1beta1.MsgSend`.
        msg_type_url: String,
    },
    /// Bank `SendAuthorization`: send up to `spend_limit` of the granter's coins.
    Send {
        /// Coins that may be sent in total.
        spend_limit: Vec<Coin>,
        /// Only to these addresses, when not empty.
        allow_list: Vec<String>,
    },
    /// Any other authorization type. Shown raw.
    Unknown {
        /// Its type URL.
        type_url: String,
        /// Its protobuf bytes.
        #[serde(serialize_with = "hex_bytes")]
        value: Vec<u8>,
    },
}

/// What a fee grant lets the grantee spend on fees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Allowance {
    /// `BasicAllowance`. An empty `spend_limit` means no limit.
    Basic {
        /// Total fee coins the grantee may spend; empty for unlimited.
        spend_limit: Vec<Coin>,
        /// When the grant ends, in Unix seconds; `None` for never.
        expiration: Option<i64>,
    },
    /// `PeriodicAllowance`: a basic allowance plus a limit per period.
    Periodic {
        /// The overall limit.
        basic: Box<Allowance>,
        /// Period length in seconds.
        period_seconds: i64,
        /// Spend limit per period.
        period_spend_limit: Vec<Coin>,
    },
    /// `AllowedMsgAllowance`: the inner allowance, only for these message types.
    AllowedMsgs {
        /// Message type URLs the fees may be spent on.
        allowed_messages: Vec<String>,
        /// The allowance being restricted.
        inner: Box<Allowance>,
    },
    /// Any other allowance type. Shown raw.
    Unknown {
        /// Its type URL.
        type_url: String,
        /// Its protobuf bytes.
        #[serde(serialize_with = "hex_bytes")]
        value: Vec<u8>,
    },
}

/// A message from a transaction body. In JSON (for the approval screen) it is tagged by
/// `type`, e.g. `{"type": "bank_send", "from": …}`; raw bytes are hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Msg {
    /// `cosmos.bank.v1beta1.MsgSend`.
    BankSend {
        /// Sender.
        from: String,
        /// Recipient.
        to: String,
        /// Coins sent.
        amount: Vec<Coin>,
    },
    /// `cosmwasm.wasm.v1.MsgExecuteContract`.
    ExecuteContract {
        /// Sender.
        sender: String,
        /// Contract called.
        contract: String,
        /// Coins attached to the call.
        funds: Vec<Coin>,
        /// The JSON message exactly as signed.
        json: String,
        /// What the call is, when we recognise it.
        call: ContractCall,
    },
    /// `cosmos.authz.v1beta1.MsgGrant`: let `grantee` act as `granter`. High risk.
    AuthzGrant {
        /// Who gives the permission (the signer).
        granter: String,
        /// Who receives it.
        grantee: String,
        /// What it allows.
        authorization: Authorization,
        /// When it ends, in Unix seconds; `None` for never.
        expiration: Option<i64>,
    },
    /// `cosmos.authz.v1beta1.MsgExec`: run messages on behalf of the accounts that granted
    /// the signer permission. The inner messages are decoded too.
    AuthzExec {
        /// The account using its grants (the signer).
        grantee: String,
        /// The messages run, each as its granter.
        msgs: Vec<Msg>,
    },
    /// `cosmos.authz.v1beta1.MsgRevoke`.
    AuthzRevoke {
        /// The signer.
        granter: String,
        /// Who loses the permission.
        grantee: String,
        /// The message type it covered.
        msg_type_url: String,
    },
    /// `cosmos.feegrant.v1beta1.MsgGrantAllowance`: let `grantee` pay fees from the signer's
    /// balance.
    FeeGrant {
        /// The signer, who pays.
        granter: String,
        /// Who may spend.
        grantee: String,
        /// How much, for what, until when.
        allowance: Allowance,
    },
    /// `cosmos.feegrant.v1beta1.MsgRevokeAllowance`.
    FeeRevoke {
        /// The signer.
        granter: String,
        /// Who loses the allowance.
        grantee: String,
    },
    /// `cosmos.distribution.v1beta1.MsgSetWithdrawAddress`: where staking rewards go. High risk
    /// when it isn't the signer's own address.
    SetWithdrawAddress {
        /// The signer.
        delegator: String,
        /// The new rewards address.
        withdraw_address: String,
    },
    /// `cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward`.
    WithdrawRewards {
        /// The signer.
        delegator: String,
        /// Validator the rewards come from.
        validator: String,
    },
    /// `cosmos.staking.v1beta1.MsgDelegate`: stake with a validator.
    Delegate {
        /// The signer.
        delegator: String,
        /// The validator (`…valoper1…`).
        validator: String,
        /// The coin staked.
        amount: Coin,
    },
    /// `cosmos.staking.v1beta1.MsgUndelegate`: start unstaking; it returns after the
    /// unbonding period.
    Undelegate {
        /// The signer.
        delegator: String,
        /// The validator.
        validator: String,
        /// The coin unstaked.
        amount: Coin,
    },
    /// `cosmos.staking.v1beta1.MsgBeginRedelegate`: move a stake to another validator.
    Redelegate {
        /// The signer.
        delegator: String,
        /// The validator the stake leaves.
        from_validator: String,
        /// The validator it moves to.
        to_validator: String,
        /// The coin moved.
        amount: Coin,
    },
    /// `cosmos.staking.v1beta1.MsgCancelUnbondingDelegation`: stake again what is unbonding.
    CancelUnbonding {
        /// The signer.
        delegator: String,
        /// The validator.
        validator: String,
        /// The coin staked again.
        amount: Coin,
        /// The height the unbonding entry started at.
        creation_height: i64,
    },
    /// Injective's `cosmos.staking.v1beta1.MsgTransferDelegation`: give part of a stake to
    /// another account. High risk when the receiver isn't the signer.
    TransferDelegation {
        /// The signer.
        delegator: String,
        /// The validator.
        validator: String,
        /// Who receives the stake.
        receiver: String,
        /// The coin given.
        amount: Coin,
    },
    /// `cosmos.gov.v1beta1.MsgVote` or `cosmos.gov.v1.MsgVote`: the signer's vote on a
    /// governance proposal.
    Vote {
        /// The signer.
        voter: String,
        /// The proposal.
        proposal_id: u64,
        /// The vote.
        option: VoteOption,
        /// The voter's note (gov v1 only).
        metadata: String,
        /// Sent as gov v1's message (else v1beta1's).
        #[serde(skip)]
        v1: bool,
    },
    /// Injective's exchange `MsgWithdraw`: coins from a trading subaccount to the bank balance.
    ExchangeWithdraw {
        /// The signer.
        sender: String,
        /// The subaccount (`0x` + address + nonce).
        subaccount_id: String,
        /// The coin moved.
        amount: Coin,
    },
    /// The tokenfactory module's `MsgChangeAdmin`: give away a denom's admin rights.
    TokenfactoryChangeAdmin {
        /// Its type URL, e.g. `/injective.tokenfactory.v1beta1.MsgChangeAdmin`.
        type_url: String,
        /// The signer, the current admin.
        sender: String,
        /// The denom.
        denom: String,
        /// The new admin; empty renounces.
        new_admin: String,
    },
    /// `cosmwasm.wasm.v1.MsgUpdateAdmin`: give away a contract's admin (migration) rights.
    WasmUpdateAdmin {
        /// The signer, the current admin.
        sender: String,
        /// The contract.
        contract: String,
        /// The new admin.
        new_admin: String,
    },
    /// `cosmwasm.wasm.v1.MsgClearAdmin`: remove a contract's admin for good.
    WasmClearAdmin {
        /// The signer, the current admin.
        sender: String,
        /// The contract.
        contract: String,
    },
    /// Any other message type. The wallet shows it raw, with extra friction.
    Unknown {
        /// Its type URL.
        type_url: String,
        /// Its protobuf bytes.
        #[serde(serialize_with = "hex_bytes")]
        value: Vec<u8>,
    },
    /// Any other message, from a JSON sign path (EIP-712). Shown raw, with extra friction.
    UnknownJson {
        /// Its type URL (`@type`).
        type_url: String,
        /// The message's JSON exactly as signed.
        json: String,
    },
}

fn hex_bytes<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&hexutil::encode(bytes))
}

/// How deep `MsgExec` may nest. Real dapps use one level; more is refused.
const MAX_EXEC_DEPTH: usize = 2;

impl Msg {
    /// Decode a packed message from a transaction on `chain`. Known types, and every `Any`
    /// inside them, must round-trip byte for byte.
    pub fn decode(any: &Any, chain: &Chain) -> Result<Self, Error> {
        Self::decode_at(any, chain, 0)
    }

    fn decode_at(any: &Any, chain: &Chain, depth: usize) -> Result<Self, Error> {
        let t = any.type_url.as_str();
        let v = any.value.as_slice();
        let msg = if t == MsgSend::type_url() {
            let m: MsgSend = decode_exact(v, "MsgSend")?;
            Self::BankSend {
                from: m.from_address,
                to: m.to_address,
                amount: coins_from_proto(m.amount)?,
            }
        } else if t == MsgExecuteContract::type_url() {
            let m: MsgExecuteContract = decode_exact(v, "MsgExecuteContract")?;
            let call = cosmwasm::parse(&m.msg)?;
            let json = String::from_utf8(m.msg).map_err(|_| Error::ContractJson)?;
            Self::ExecuteContract {
                sender: m.sender,
                contract: m.contract,
                funds: coins_from_proto(m.funds)?,
                json,
                call,
            }
        } else if t == authz::MsgGrant::type_url() {
            let m: authz::MsgGrant = decode_exact(v, "MsgGrant")?;
            let grant = m.grant.ok_or(Error::Decode("MsgGrant.grant"))?;
            let auth = grant.authorization.ok_or(Error::Decode("Grant.authorization"))?;
            Self::AuthzGrant {
                granter: m.granter,
                grantee: m.grantee,
                authorization: decode_authorization(&auth)?,
                expiration: grant.expiration.map(|e| e.seconds),
            }
        } else if t == authz::MsgExec::type_url() {
            let m: authz::MsgExec = decode_exact(v, "MsgExec")?;
            if depth >= MAX_EXEC_DEPTH {
                return Err(Error::Decode("MsgExec nested too deep"));
            }
            if m.msgs.is_empty() {
                return Err(Error::NoMessages);
            }
            let msgs = m
                .msgs
                .iter()
                .map(|a| Self::decode_at(a, chain, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            Self::AuthzExec {
                grantee: m.grantee,
                msgs,
            }
        } else if t == authz::MsgRevoke::type_url() {
            let m: authz::MsgRevoke = decode_exact(v, "MsgRevoke")?;
            Self::AuthzRevoke {
                granter: m.granter,
                grantee: m.grantee,
                msg_type_url: m.msg_type_url,
            }
        } else if t == feegrant::MsgGrantAllowance::type_url() {
            let m: feegrant::MsgGrantAllowance = decode_exact(v, "MsgGrantAllowance")?;
            let a = m.allowance.ok_or(Error::Decode("MsgGrantAllowance.allowance"))?;
            Self::FeeGrant {
                granter: m.granter,
                grantee: m.grantee,
                allowance: decode_allowance(&a, 0)?,
            }
        } else if t == feegrant::MsgRevokeAllowance::type_url() {
            let m: feegrant::MsgRevokeAllowance = decode_exact(v, "MsgRevokeAllowance")?;
            Self::FeeRevoke {
                granter: m.granter,
                grantee: m.grantee,
            }
        } else if t == distribution::MsgSetWithdrawAddress::type_url() {
            let m: distribution::MsgSetWithdrawAddress = decode_exact(v, "MsgSetWithdrawAddress")?;
            Self::SetWithdrawAddress {
                delegator: m.delegator_address,
                withdraw_address: m.withdraw_address,
            }
        } else if t == distribution::MsgWithdrawDelegatorReward::type_url() {
            let m: distribution::MsgWithdrawDelegatorReward = decode_exact(v, "MsgWithdrawDelegatorReward")?;
            Self::WithdrawRewards {
                delegator: m.delegator_address,
                validator: m.validator_address,
            }
        } else if t == gov::MsgVoteV1beta1::type_url() {
            let m: gov::MsgVoteV1beta1 = decode_exact(v, "MsgVote")?;
            Self::Vote {
                voter: m.voter,
                proposal_id: m.proposal_id,
                option: VoteOption::from_number(m.option).ok_or(Error::Decode("MsgVote.option"))?,
                metadata: String::new(),
                v1: false,
            }
        } else if t == gov::MsgVoteV1::type_url() {
            let m: gov::MsgVoteV1 = decode_exact(v, "MsgVote")?;
            Self::Vote {
                voter: m.voter,
                proposal_id: m.proposal_id,
                option: VoteOption::from_number(m.option).ok_or(Error::Decode("MsgVote.option"))?,
                metadata: m.metadata,
                v1: true,
            }
        } else if t == staking::MsgDelegate::type_url() {
            let m: staking::MsgDelegate = decode_exact(v, "MsgDelegate")?;
            Self::Delegate {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount, "MsgDelegate.amount")?,
            }
        } else if t == staking::MsgUndelegate::type_url() {
            let m: staking::MsgUndelegate = decode_exact(v, "MsgUndelegate")?;
            Self::Undelegate {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount, "MsgUndelegate.amount")?,
            }
        } else if t == staking::MsgBeginRedelegate::type_url() {
            let m: staking::MsgBeginRedelegate = decode_exact(v, "MsgBeginRedelegate")?;
            Self::Redelegate {
                delegator: m.delegator_address,
                from_validator: m.validator_src_address,
                to_validator: m.validator_dst_address,
                amount: one_coin(m.amount, "MsgBeginRedelegate.amount")?,
            }
        } else if t == staking::MsgCancelUnbondingDelegation::type_url() {
            let m: staking::MsgCancelUnbondingDelegation = decode_exact(v, "MsgCancelUnbondingDelegation")?;
            Self::CancelUnbonding {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount, "MsgCancelUnbondingDelegation.amount")?,
                creation_height: m.creation_height,
            }
        } else if t == staking::MsgTransferDelegation::type_url() {
            let m: staking::MsgTransferDelegation = decode_exact(v, "MsgTransferDelegation")?;
            Self::TransferDelegation {
                delegator: m.delegator_address,
                validator: m.validator_address,
                receiver: m.receiver_address,
                amount: one_coin(m.amount, "MsgTransferDelegation.amount")?,
            }
        } else if t == EXCHANGE_WITHDRAW {
            let m: ExchangeMsgWithdraw = decode_exact(v, "MsgWithdraw")?;
            if !is_subaccount_id(&m.subaccount_id) {
                return Err(Error::Decode("MsgWithdraw.subaccount_id"));
            }
            Self::ExchangeWithdraw {
                sender: m.sender,
                subaccount_id: m.subaccount_id,
                amount: one_coin(m.amount, "MsgWithdraw.amount")?,
            }
        } else if chain
            .tokenfactory
            .is_some_and(|pkg| t.strip_prefix('/').and_then(|r| r.strip_prefix(pkg)) == Some(".MsgChangeAdmin"))
        {
            let m: TokenfactoryMsgChangeAdmin = decode_exact(v, "MsgChangeAdmin")?;
            Self::TokenfactoryChangeAdmin {
                type_url: t.into(),
                sender: m.sender,
                denom: m.denom,
                new_admin: m.new_admin,
            }
        } else if t == wasm::MsgUpdateAdmin::type_url() {
            let m: wasm::MsgUpdateAdmin = decode_exact(v, "MsgUpdateAdmin")?;
            Self::WasmUpdateAdmin {
                sender: m.sender,
                contract: m.contract,
                new_admin: m.new_admin,
            }
        } else if t == wasm::MsgClearAdmin::type_url() {
            let m: wasm::MsgClearAdmin = decode_exact(v, "MsgClearAdmin")?;
            Self::WasmClearAdmin {
                sender: m.sender,
                contract: m.contract,
            }
        } else {
            Self::Unknown {
                type_url: any.type_url.clone(),
                value: any.value.clone(),
            }
        };
        Ok(msg)
    }

    /// The message's type URL.
    pub fn type_url(&self) -> &str {
        match self {
            Self::BankSend { .. } => "/cosmos.bank.v1beta1.MsgSend",
            Self::ExecuteContract { .. } => "/cosmwasm.wasm.v1.MsgExecuteContract",
            Self::AuthzGrant { .. } => "/cosmos.authz.v1beta1.MsgGrant",
            Self::AuthzExec { .. } => "/cosmos.authz.v1beta1.MsgExec",
            Self::AuthzRevoke { .. } => "/cosmos.authz.v1beta1.MsgRevoke",
            Self::FeeGrant { .. } => "/cosmos.feegrant.v1beta1.MsgGrantAllowance",
            Self::FeeRevoke { .. } => "/cosmos.feegrant.v1beta1.MsgRevokeAllowance",
            Self::SetWithdrawAddress { .. } => "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress",
            Self::WithdrawRewards { .. } => "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
            Self::Delegate { .. } => "/cosmos.staking.v1beta1.MsgDelegate",
            Self::Undelegate { .. } => "/cosmos.staking.v1beta1.MsgUndelegate",
            Self::Redelegate { .. } => "/cosmos.staking.v1beta1.MsgBeginRedelegate",
            Self::CancelUnbonding { .. } => "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation",
            Self::TransferDelegation { .. } => "/cosmos.staking.v1beta1.MsgTransferDelegation",
            Self::WasmUpdateAdmin { .. } => "/cosmwasm.wasm.v1.MsgUpdateAdmin",
            Self::WasmClearAdmin { .. } => "/cosmwasm.wasm.v1.MsgClearAdmin",
            Self::ExchangeWithdraw { .. } => EXCHANGE_WITHDRAW,
            Self::Vote { v1: true, .. } => "/cosmos.gov.v1.MsgVote",
            Self::Vote { v1: false, .. } => "/cosmos.gov.v1beta1.MsgVote",
            Self::TokenfactoryChangeAdmin { type_url, .. }
            | Self::Unknown { type_url, .. }
            | Self::UnknownJson { type_url, .. } => type_url,
        }
    }

    /// The account that must sign this message, when we know the type. For `MsgExec` that
    /// is the grantee; its inner messages run as their granters.
    pub fn signer(&self) -> Option<&str> {
        match self {
            Self::BankSend { from, .. } => Some(from),
            Self::ExecuteContract { sender, .. }
            | Self::ExchangeWithdraw { sender, .. }
            | Self::TokenfactoryChangeAdmin { sender, .. }
            | Self::WasmUpdateAdmin { sender, .. }
            | Self::WasmClearAdmin { sender, .. } => Some(sender),
            Self::AuthzGrant { granter, .. }
            | Self::AuthzRevoke { granter, .. }
            | Self::FeeGrant { granter, .. }
            | Self::FeeRevoke { granter, .. } => Some(granter),
            Self::AuthzExec { grantee, .. } => Some(grantee),
            Self::Vote { voter, .. } => Some(voter),
            Self::SetWithdrawAddress { delegator, .. }
            | Self::WithdrawRewards { delegator, .. }
            | Self::Delegate { delegator, .. }
            | Self::Undelegate { delegator, .. }
            | Self::Redelegate { delegator, .. }
            | Self::CancelUnbonding { delegator, .. }
            | Self::TransferDelegation { delegator, .. } => Some(delegator),
            Self::Unknown { .. } | Self::UnknownJson { .. } => None,
        }
    }
}

#[derive(Deserialize)]
struct TypeOnly {
    #[serde(rename = "@type")]
    type_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MsgSendJson {
    #[serde(rename = "@type")]
    _type_url: String,
    from_address: String,
    to_address: String,
    amount: Vec<JsonCoin>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MsgExecuteContractJson<'a> {
    #[serde(rename = "@type")]
    _type_url: String,
    sender: String,
    contract: String,
    #[serde(borrow)]
    msg: &'a RawValue,
    #[serde(default)]
    funds: Vec<JsonCoin>,
}

impl Msg {
    /// Decode one message in protobuf JSON (`{"@type": …, …}`), as EIP-712 typed data
    /// carries them, for `chain`. Known types with unexpected fields are kept raw, because a
    /// field we don't know could change what the message does. Bank sends and contract
    /// calls keep the contract message exactly as written; the other types (grants,
    /// `MsgExec`, admin changes, …) go through the decoder shared with amino JSON.
    pub fn from_proto_json(text: &str, chain: &Chain) -> Result<Self, Error> {
        let TypeOnly { type_url } =
            serde_json::from_str(text).map_err(|_| Error::Json("message without @type".into()))?;
        let unknown = || Self::UnknownJson {
            type_url: type_url.clone(),
            json: text.to_owned(),
        };
        let msg = match type_url.as_str() {
            "/cosmos.bank.v1beta1.MsgSend" => match serde_json::from_str::<MsgSendJson>(text) {
                Ok(m) => Self::BankSend {
                    from: m.from_address,
                    to: m.to_address,
                    amount: coins_from_json(m.amount)?,
                },
                Err(_) => unknown(),
            },
            "/cosmwasm.wasm.v1.MsgExecuteContract" => match serde_json::from_str::<MsgExecuteContractJson>(text) {
                Ok(m) => {
                    let json = m.msg.get().to_owned();
                    Self::ExecuteContract {
                        call: cosmwasm::parse(json.as_bytes())?,
                        sender: m.sender,
                        contract: m.contract,
                        funds: coins_from_json(m.funds)?,
                        json,
                    }
                }
                Err(_) => unknown(),
            },
            _ => {
                let v: Value = serde_json::from_str(text).map_err(|e| Error::Json(e.to_string()))?;
                return crate::json::message(&v, crate::json::Form::Proto, chain, 0);
            }
        };
        Ok(msg)
    }
}

fn decode_authorization(any: &Any) -> Result<Authorization, Error> {
    let v = any.value.as_slice();
    Ok(if any.type_url == authz::GenericAuthorization::type_url() {
        let a: authz::GenericAuthorization = decode_exact(v, "GenericAuthorization")?;
        Authorization::Generic { msg_type_url: a.msg }
    } else if any.type_url == bank::SendAuthorization::type_url() {
        let a: bank::SendAuthorization = decode_exact(v, "SendAuthorization")?;
        Authorization::Send {
            spend_limit: coins_from_proto(a.spend_limit)?,
            allow_list: a.allow_list,
        }
    } else {
        Authorization::Unknown {
            type_url: any.type_url.clone(),
            value: any.value.clone(),
        }
    })
}

fn decode_allowance(any: &Any, depth: usize) -> Result<Allowance, Error> {
    if depth > MAX_EXEC_DEPTH {
        return Err(Error::Decode("allowance nested too deep"));
    }
    let v = any.value.as_slice();
    let basic = |b: feegrant::BasicAllowance| -> Result<Allowance, Error> {
        Ok(Allowance::Basic {
            spend_limit: coins_from_proto(b.spend_limit)?,
            expiration: b.expiration.map(|e| e.seconds),
        })
    };
    Ok(if any.type_url == feegrant::BasicAllowance::type_url() {
        basic(decode_exact(v, "BasicAllowance")?)?
    } else if any.type_url == feegrant::PeriodicAllowance::type_url() {
        let p: feegrant::PeriodicAllowance = decode_exact(v, "PeriodicAllowance")?;
        Allowance::Periodic {
            basic: Box::new(basic(p.basic.unwrap_or_default())?),
            period_seconds: p.period.map_or(0, |d| d.seconds),
            period_spend_limit: coins_from_proto(p.period_spend_limit)?,
        }
    } else if any.type_url == feegrant::AllowedMsgAllowance::type_url() {
        let a: feegrant::AllowedMsgAllowance = decode_exact(v, "AllowedMsgAllowance")?;
        let inner = a.allowance.ok_or(Error::Decode("AllowedMsgAllowance.allowance"))?;
        Allowance::AllowedMsgs {
            allowed_messages: a.allowed_messages,
            inner: Box::new(decode_allowance(&inner, depth + 1)?),
        }
    } else {
        Allowance::Unknown {
            type_url: any.type_url.clone(),
            value: any.value.clone(),
        }
    })
}

/// A canonical non-negative integer: digits only, no sign, no leading zeros, at most 78
/// digits (2^256 has 78).
pub(crate) fn is_canonical_amount(s: &str) -> bool {
    !s.is_empty() && s.len() <= 78 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

/// Cosmos SDK denom rule: `[a-zA-Z][a-zA-Z0-9/:._-]{2,127}`.
pub(crate) fn is_valid_denom(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=128).contains(&b.len())
        && b[0].is_ascii_alphabetic()
        && b[1..]
            .iter()
            .all(|&c| c.is_ascii_alphanumeric() || b"/:._-".contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts() {
        for ok in ["1", "10", "1000000000000000000"] {
            assert!(Coin::new("inj", ok).is_ok(), "{ok}");
        }
        for bad in ["", "0", "01", "+1", "-1", "1.0", "1e18", " 1", &"9".repeat(79)] {
            assert_eq!(Coin::new("inj", bad).unwrap_err(), Error::Amount(bad.into()), "{bad:?}");
        }
    }

    #[test]
    fn denoms() {
        for ok in [
            "inj",
            "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7",
            "ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9",
            "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1keckja4ra05d8xkwkpph9u30lrngqtt6vv34da",
            "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
        ] {
            assert!(is_valid_denom(ok), "{ok}");
        }
        for bad in ["", "ab", "1inj", "inj!", "in j", &"a".repeat(129)] {
            assert!(!is_valid_denom(bad), "{bad:?}");
        }
    }
}
