//! Messages in the two JSON forms sign paths carry, decoded into the same [`Msg`] the
//! protobuf path produces:
//!
//! - amino JSON (LEGACY_AMINO_JSON, Ledger's Cosmos app, `signAmino`): `{"type": amino
//!   name, "value": {fields}}`, with nested `Any`s in the same shape;
//! - protobuf JSON (EIP-712 v2): `{"@type": type URL, fields}`, nested `Any`s likewise.
//!
//! Field names are the protobuf names in both. Fields left out read as empty, as amino JSON
//! omits zero values. A known type with fields we don't expect is kept raw
//! ([`Msg::UnknownJson`]); a coin or timestamp that fails its checks is an error.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::Error;
use crate::chain::Chain;
use crate::cosmwasm;
use crate::msg::{Allowance, Authorization, Coin, JsonCoin, Msg, coins_from_json};

/// Which JSON form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Form {
    Amino,
    Proto,
}

/// How deep `MsgExec` and nested allowances may go, as on the protobuf path.
const MAX_DEPTH: usize = 2;

const SEND: &str = "/cosmos.bank.v1beta1.MsgSend";
const EXECUTE: &str = "/cosmwasm.wasm.v1.MsgExecuteContract";
const GRANT: &str = "/cosmos.authz.v1beta1.MsgGrant";
const EXEC: &str = "/cosmos.authz.v1beta1.MsgExec";
const REVOKE: &str = "/cosmos.authz.v1beta1.MsgRevoke";
const GENERIC: &str = "/cosmos.authz.v1beta1.GenericAuthorization";
const SEND_AUTH: &str = "/cosmos.bank.v1beta1.SendAuthorization";
const FEE_GRANT: &str = "/cosmos.feegrant.v1beta1.MsgGrantAllowance";
const FEE_REVOKE: &str = "/cosmos.feegrant.v1beta1.MsgRevokeAllowance";
const BASIC: &str = "/cosmos.feegrant.v1beta1.BasicAllowance";
const PERIODIC: &str = "/cosmos.feegrant.v1beta1.PeriodicAllowance";
const ALLOWED: &str = "/cosmos.feegrant.v1beta1.AllowedMsgAllowance";
const WITHDRAW_ADDRESS: &str = "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress";
const WITHDRAW_REWARD: &str = "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward";
const UPDATE_ADMIN: &str = "/cosmwasm.wasm.v1.MsgUpdateAdmin";
const CLEAR_ADMIN: &str = "/cosmwasm.wasm.v1.MsgClearAdmin";
const DELEGATE: &str = "/cosmos.staking.v1beta1.MsgDelegate";
const UNDELEGATE: &str = "/cosmos.staking.v1beta1.MsgUndelegate";
const REDELEGATE: &str = "/cosmos.staking.v1beta1.MsgBeginRedelegate";
const CANCEL_UNBONDING: &str = "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation";
const TRANSFER_DELEGATION: &str = "/cosmos.staking.v1beta1.MsgTransferDelegation";

/// Amino names (`option (amino.name)` in the vendored protos) and their type URLs.
const AMINO_NAMES: &[(&str, &str)] = &[
    ("cosmos-sdk/MsgSend", SEND),
    ("wasm/MsgExecuteContract", EXECUTE),
    ("cosmos-sdk/MsgGrant", GRANT),
    ("cosmos-sdk/MsgExec", EXEC),
    ("cosmos-sdk/MsgRevoke", REVOKE),
    ("cosmos-sdk/GenericAuthorization", GENERIC),
    ("cosmos-sdk/SendAuthorization", SEND_AUTH),
    ("cosmos-sdk/MsgGrantAllowance", FEE_GRANT),
    ("cosmos-sdk/MsgRevokeAllowance", FEE_REVOKE),
    ("cosmos-sdk/BasicAllowance", BASIC),
    ("cosmos-sdk/PeriodicAllowance", PERIODIC),
    ("cosmos-sdk/AllowedMsgAllowance", ALLOWED),
    ("cosmos-sdk/MsgModifyWithdrawAddress", WITHDRAW_ADDRESS),
    ("cosmos-sdk/MsgWithdrawDelegationReward", WITHDRAW_REWARD),
    ("wasm/MsgUpdateAdmin", UPDATE_ADMIN),
    ("wasm/MsgClearAdmin", CLEAR_ADMIN),
    ("cosmos-sdk/MsgDelegate", DELEGATE),
    ("cosmos-sdk/MsgUndelegate", UNDELEGATE),
    ("cosmos-sdk/MsgBeginRedelegate", REDELEGATE),
    ("cosmos-sdk/MsgCancelUnbondingDelegation", CANCEL_UNBONDING),
    ("cosmos-sdk/MsgTransferDelegation", TRANSFER_DELEGATION),
];

/// Split a packed JSON value into its type URL and fields. An amino name we don't know is
/// returned as is, so it shows as the type.
fn unpack(v: &Value, form: Form, chain: &Chain) -> Result<(String, Map<String, Value>), Error> {
    let bad = || Error::Json(format!("not a packed message: {v}"));
    let obj = v.as_object().ok_or_else(bad)?;
    match form {
        Form::Proto => {
            let mut fields = obj.clone();
            let t = fields
                .remove("@type")
                .and_then(|t| t.as_str().map(str::to_owned))
                .ok_or_else(bad)?;
            Ok((t, fields))
        }
        Form::Amino => {
            if obj.len() != 2 {
                return Err(bad());
            }
            let name = obj.get("type").and_then(Value::as_str).ok_or_else(bad)?;
            let fields = obj.get("value").and_then(Value::as_object).ok_or_else(bad)?.clone();
            let url = AMINO_NAMES
                .iter()
                .chain(chain.amino_names)
                .find(|(n, _)| *n == name)
                .map_or(name, |(_, u)| u);
            Ok((url.to_owned(), fields))
        }
    }
}

/// Fields into `T`, or `None` when they don't fit (unknown or mistyped fields).
fn fields<T: DeserializeOwned>(f: &Map<String, Value>) -> Option<T> {
    serde_json::from_value(Value::Object(f.clone())).ok()
}

/// RFC 3339 UTC timestamp (`2030-01-01T00:00:00Z`, optional fraction) to Unix seconds.
pub(crate) fn timestamp(s: &str) -> Result<i64, Error> {
    let bad = || Error::Json(format!("not an RFC 3339 UTC timestamp: {s:?}"));
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[b.len() - 1] != b'Z'
    {
        return Err(bad());
    }
    let num = |r: std::ops::Range<usize>| -> Result<i64, Error> {
        let part = &s[r];
        if part.bytes().all(|c| c.is_ascii_digit()) {
            part.parse().map_err(|_| bad())
        } else {
            Err(bad())
        }
    };
    let (y, mo, d, h, mi, sec) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let frac = &s[19..s.len() - 1];
    if !(frac.is_empty()
        || (frac.len() >= 2
            && frac.len() <= 10
            && frac.starts_with('.')
            && frac[1..].bytes().all(|c| c.is_ascii_digit())))
    {
        return Err(bad());
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&mo) || d < 1 || d > days_in[(mo - 1) as usize] || h > 23 || mi > 59 || sec > 59 {
        return Err(bad());
    }
    // Howard Hinnant's days-from-civil.
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(days * 86_400 + h * 3_600 + mi * 60 + sec)
}

/// A canonical int64 written as a JSON string (`"0"`, `"123"`, `"-5"`); empty reads as 0, as
/// amino JSON omits zero values.
fn int64(s: &str) -> Result<i64, Error> {
    let bad = || Error::Json(format!("not a canonical int64: {s:?}"));
    if s.is_empty() {
        return Ok(0);
    }
    let digits = s.strip_prefix('-').unwrap_or(s);
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
        || s == "-0"
    {
        return Err(bad());
    }
    s.parse().map_err(|_| bad())
}

fn expiration(s: Option<String>) -> Result<Option<i64>, Error> {
    s.filter(|s| !s.is_empty()).map(|s| timestamp(&s)).transpose()
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SendF {
    from_address: String,
    to_address: String,
    amount: Vec<JsonCoin>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ExecuteF {
    sender: String,
    contract: String,
    msg: Value,
    funds: Vec<JsonCoin>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct GrantF {
    granter: String,
    grantee: String,
    grant: GrantInner,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct GrantInner {
    authorization: Value,
    expiration: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ExecF {
    grantee: String,
    msgs: Vec<Value>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RevokeF {
    granter: String,
    grantee: String,
    msg_type_url: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct FeeGrantF {
    granter: String,
    grantee: String,
    allowance: Value,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct PairF {
    granter: String,
    grantee: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct WithdrawAddressF {
    delegator_address: String,
    withdraw_address: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct WithdrawRewardF {
    delegator_address: String,
    validator_address: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct StakeF {
    delegator_address: String,
    validator_address: String,
    amount: Option<JsonCoin>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RedelegateF {
    delegator_address: String,
    validator_src_address: String,
    validator_dst_address: String,
    amount: Option<JsonCoin>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CancelUnbondingF {
    delegator_address: String,
    validator_address: String,
    amount: Option<JsonCoin>,
    /// int64, a string in both JSON forms.
    creation_height: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct TransferDelegationF {
    delegator_address: String,
    validator_address: String,
    receiver_address: String,
    amount: Option<JsonCoin>,
}

/// A staking message's one coin; leaving it out is an error, not a zero.
fn one_coin(c: Option<JsonCoin>) -> Result<Coin, Error> {
    Coin::try_from(c.ok_or_else(|| Error::Amount(String::new()))?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct AdminF {
    sender: String,
    contract: String,
    new_admin: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ClearAdminF {
    sender: String,
    contract: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct DenomAdminF {
    sender: String,
    denom: String,
    new_admin: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct GenericF {
    msg: String,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SendAuthF {
    spend_limit: Vec<JsonCoin>,
    allow_list: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct BasicF {
    spend_limit: Vec<JsonCoin>,
    expiration: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct AllowedF {
    allowed_messages: Vec<String>,
    allowance: Value,
}

/// Decode one packed JSON message.
pub(crate) fn message(v: &Value, form: Form, chain: &Chain, depth: usize) -> Result<Msg, Error> {
    let (t, f) = unpack(v, form, chain)?;
    let unknown = || -> Result<Msg, Error> {
        Ok(Msg::UnknownJson {
            type_url: t.clone(),
            json: crate::amino::canonical(v)?,
        })
    };
    let is_tokenfactory = chain
        .tokenfactory
        .is_some_and(|pkg| t.strip_prefix('/').and_then(|r| r.strip_prefix(pkg)) == Some(".MsgChangeAdmin"));
    let msg = match t.as_str() {
        SEND => match fields::<SendF>(&f) {
            Some(m) => Msg::BankSend {
                from: m.from_address,
                to: m.to_address,
                amount: coins_from_json(m.amount)?,
            },
            None => return unknown(),
        },
        EXECUTE => match fields::<ExecuteF>(&f) {
            Some(m) => {
                let json = crate::amino::canonical(&m.msg)?;
                Msg::ExecuteContract {
                    call: cosmwasm::parse(json.as_bytes())?,
                    sender: m.sender,
                    contract: m.contract,
                    funds: coins_from_json(m.funds)?,
                    json,
                }
            }
            None => return unknown(),
        },
        GRANT => match fields::<GrantF>(&f) {
            Some(m) => Msg::AuthzGrant {
                granter: m.granter,
                grantee: m.grantee,
                authorization: authorization(&m.grant.authorization, form, chain)?,
                expiration: expiration(m.grant.expiration)?,
            },
            None => return unknown(),
        },
        EXEC => match fields::<ExecF>(&f) {
            Some(m) => {
                if depth >= MAX_DEPTH {
                    return Err(Error::Json("MsgExec nested too deep".into()));
                }
                if m.msgs.is_empty() {
                    return Err(Error::NoMessages);
                }
                Msg::AuthzExec {
                    grantee: m.grantee,
                    msgs: m
                        .msgs
                        .iter()
                        .map(|inner| message(inner, form, chain, depth + 1))
                        .collect::<Result<_, _>>()?,
                }
            }
            None => return unknown(),
        },
        REVOKE => match fields::<RevokeF>(&f) {
            Some(m) => Msg::AuthzRevoke {
                granter: m.granter,
                grantee: m.grantee,
                msg_type_url: m.msg_type_url,
            },
            None => return unknown(),
        },
        FEE_GRANT => match fields::<FeeGrantF>(&f) {
            Some(m) => Msg::FeeGrant {
                granter: m.granter,
                grantee: m.grantee,
                allowance: allowance(&m.allowance, form, chain, 0)?,
            },
            None => return unknown(),
        },
        FEE_REVOKE => match fields::<PairF>(&f) {
            Some(m) => Msg::FeeRevoke {
                granter: m.granter,
                grantee: m.grantee,
            },
            None => return unknown(),
        },
        WITHDRAW_ADDRESS => match fields::<WithdrawAddressF>(&f) {
            Some(m) => Msg::SetWithdrawAddress {
                delegator: m.delegator_address,
                withdraw_address: m.withdraw_address,
            },
            None => return unknown(),
        },
        WITHDRAW_REWARD => match fields::<WithdrawRewardF>(&f) {
            Some(m) => Msg::WithdrawRewards {
                delegator: m.delegator_address,
                validator: m.validator_address,
            },
            None => return unknown(),
        },
        UPDATE_ADMIN => match fields::<AdminF>(&f) {
            Some(m) => Msg::WasmUpdateAdmin {
                sender: m.sender,
                contract: m.contract,
                new_admin: m.new_admin,
            },
            None => return unknown(),
        },
        CLEAR_ADMIN => match fields::<ClearAdminF>(&f) {
            Some(m) => Msg::WasmClearAdmin {
                sender: m.sender,
                contract: m.contract,
            },
            None => return unknown(),
        },
        DELEGATE => match fields::<StakeF>(&f) {
            Some(m) => Msg::Delegate {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount)?,
            },
            None => return unknown(),
        },
        UNDELEGATE => match fields::<StakeF>(&f) {
            Some(m) => Msg::Undelegate {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount)?,
            },
            None => return unknown(),
        },
        REDELEGATE => match fields::<RedelegateF>(&f) {
            Some(m) => Msg::Redelegate {
                delegator: m.delegator_address,
                from_validator: m.validator_src_address,
                to_validator: m.validator_dst_address,
                amount: one_coin(m.amount)?,
            },
            None => return unknown(),
        },
        CANCEL_UNBONDING => match fields::<CancelUnbondingF>(&f) {
            Some(m) => Msg::CancelUnbonding {
                delegator: m.delegator_address,
                validator: m.validator_address,
                amount: one_coin(m.amount)?,
                creation_height: int64(&m.creation_height)?,
            },
            None => return unknown(),
        },
        TRANSFER_DELEGATION => match fields::<TransferDelegationF>(&f) {
            Some(m) => Msg::TransferDelegation {
                delegator: m.delegator_address,
                validator: m.validator_address,
                receiver: m.receiver_address,
                amount: one_coin(m.amount)?,
            },
            None => return unknown(),
        },
        _ if is_tokenfactory => match fields::<DenomAdminF>(&f) {
            Some(m) => Msg::TokenfactoryChangeAdmin {
                type_url: t.clone(),
                sender: m.sender,
                denom: m.denom,
                new_admin: m.new_admin,
            },
            None => return unknown(),
        },
        _ => return unknown(),
    };
    Ok(msg)
}

/// A grant's authorization. A grant whose authorization we can't read still decodes as a
/// grant, so the risk rules still see it.
fn authorization(v: &Value, form: Form, chain: &Chain) -> Result<Authorization, Error> {
    let (t, f) = unpack(v, form, chain)?;
    let raw = || Authorization::Unknown {
        type_url: t.clone(),
        value: v.to_string().into_bytes(),
    };
    Ok(match t.as_str() {
        GENERIC => fields::<GenericF>(&f).map_or_else(raw, |a| Authorization::Generic { msg_type_url: a.msg }),
        SEND_AUTH => match fields::<SendAuthF>(&f) {
            Some(a) => Authorization::Send {
                spend_limit: coins_from_json(a.spend_limit)?,
                allow_list: a.allow_list,
            },
            None => raw(),
        },
        _ => raw(),
    })
}

/// A fee allowance, recursing into `AllowedMsgAllowance`.
fn allowance(v: &Value, form: Form, chain: &Chain, depth: usize) -> Result<Allowance, Error> {
    if depth > MAX_DEPTH {
        return Err(Error::Json("allowance nested too deep".into()));
    }
    let (t, f) = unpack(v, form, chain)?;
    let raw = || Allowance::Unknown {
        type_url: t.clone(),
        value: v.to_string().into_bytes(),
    };
    Ok(match t.as_str() {
        BASIC => match fields::<BasicF>(&f) {
            Some(a) => Allowance::Basic {
                spend_limit: coins_from_json(a.spend_limit)?,
                expiration: expiration(a.expiration)?,
            },
            None => raw(),
        },
        ALLOWED => match fields::<AllowedF>(&f) {
            Some(a) => Allowance::AllowedMsgs {
                allowed_messages: a.allowed_messages,
                inner: Box::new(allowance(&a.allowance, form, chain, depth + 1)?),
            },
            None => raw(),
        },
        // Periodic allowances carry durations whose JSON form differs between the paths;
        // shown raw. The grant is still a grant.
        _ => raw(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(timestamp("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(timestamp("2030-01-01T00:00:00Z").unwrap(), 1_893_456_000);
        assert_eq!(timestamp("2000-02-29T23:59:59.123456789Z").unwrap(), 951_868_799);
        for bad in [
            "",
            "2030-01-01",
            "2030-01-01T00:00:00",
            "2030-01-01T00:00:00+01:00",
            "2030-13-01T00:00:00Z",
            "2029-02-29T00:00:00Z",
            "2030-01-01T24:00:00Z",
            "2030-01-01T00:00:00.Z",
            "2030-01-01T00:00:00.1234567890Z",
            "+030-01-01T00:00:00Z",
        ] {
            assert!(timestamp(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn int64s() {
        assert_eq!(int64("").unwrap(), 0);
        assert_eq!(int64("0").unwrap(), 0);
        assert_eq!(int64("123456789").unwrap(), 123_456_789);
        assert_eq!(int64("-5").unwrap(), -5);
        for bad in ["-", "-0", "01", "+1", "1.0", " 1", "9223372036854775808"] {
            assert!(int64(bad).is_err(), "{bad:?}");
        }
    }
}
