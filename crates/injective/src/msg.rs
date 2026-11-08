//! Messages decoded from a transaction body.

use prost::Name;

use crate::Error;
use crate::canonical::decode_exact;
use crate::cosmwasm::{self, ContractCall};
use crate::proto::cosmos::bank::v1beta1::MsgSend;
use crate::proto::cosmos::base::v1beta1::Coin as ProtoCoin;
use crate::proto::cosmwasm::wasm::v1::MsgExecuteContract;
use crate::wkt::Any;

/// A bank coin with a valid denom and a canonical positive amount.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
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

/// Decode a list of coins, refusing invalid ones.
pub(crate) fn coins_from_proto(coins: Vec<ProtoCoin>) -> Result<Vec<Coin>, Error> {
    coins.into_iter().map(Coin::from_proto).collect()
}

/// A message from a transaction body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    /// `cosmos.bank.v1beta1.MsgSend`.
    BankSend {
        /// Sender, `inj1…`.
        from: String,
        /// Recipient, `inj1…`.
        to: String,
        /// Coins sent.
        amount: Vec<Coin>,
    },
    /// `cosmwasm.wasm.v1.MsgExecuteContract`.
    ExecuteContract {
        /// Sender, `inj1…`.
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
    /// Any other message type. The wallet shows it raw, with extra friction.
    Unknown {
        /// Its type URL.
        type_url: String,
        /// Its protobuf bytes.
        value: Vec<u8>,
    },
}

impl Msg {
    /// Decode a packed message. Known types must round-trip byte for byte.
    pub(crate) fn decode(any: &Any) -> Result<Self, Error> {
        if any.type_url == MsgSend::type_url() {
            let m: MsgSend = decode_exact(&any.value, "MsgSend")?;
            return Ok(Self::BankSend {
                from: m.from_address,
                to: m.to_address,
                amount: coins_from_proto(m.amount)?,
            });
        }
        if any.type_url == MsgExecuteContract::type_url() {
            let m: MsgExecuteContract = decode_exact(&any.value, "MsgExecuteContract")?;
            let call = cosmwasm::parse(&m.msg)?;
            let json = String::from_utf8(m.msg).map_err(|_| Error::ContractJson)?;
            return Ok(Self::ExecuteContract {
                sender: m.sender,
                contract: m.contract,
                funds: coins_from_proto(m.funds)?,
                json,
                call,
            });
        }
        Ok(Self::Unknown {
            type_url: any.type_url.clone(),
            value: any.value.clone(),
        })
    }

    /// The account that must sign this message, when we know the type.
    pub fn signer(&self) -> Option<&str> {
        match self {
            Self::BankSend { from, .. } => Some(from),
            Self::ExecuteContract { sender, .. } => Some(sender),
            Self::Unknown { .. } => None,
        }
    }
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
