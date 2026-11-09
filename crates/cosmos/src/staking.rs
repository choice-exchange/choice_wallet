//! `cosmos.staking.v1beta1` messages, written from the wire format.
//!
//! Vendoring `staking/v1beta1/tx.proto` would pull in cometbft's types and ABCI protos
//! (`staking.proto` imports them for validator records) for a handful of small messages, so
//! these are spelled out instead. Field numbers are from InjectiveLabs/cosmos-sdk
//! v0.50.14-inj.11 `proto/cosmos/staking/v1beta1/tx.proto` (Apache-2.0); the tests check the
//! encoding against bytes from an independent encoder.

use prost::Name;

use crate::proto::cosmos::base::v1beta1::Coin;

const PACKAGE: &str = "cosmos.staking.v1beta1";

/// `MsgDelegate`: stake `amount` with a validator.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgDelegate {
    /// The signer.
    #[prost(string, tag = "1")]
    pub delegator_address: String,
    /// The validator (`…valoper1…`).
    #[prost(string, tag = "2")]
    pub validator_address: String,
    /// The coins staked.
    #[prost(message, optional, tag = "3")]
    pub amount: Option<Coin>,
}

/// `MsgUndelegate`: start unstaking `amount`; it returns after the unbonding period.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgUndelegate {
    /// The signer.
    #[prost(string, tag = "1")]
    pub delegator_address: String,
    /// The validator.
    #[prost(string, tag = "2")]
    pub validator_address: String,
    /// The coins unstaked.
    #[prost(message, optional, tag = "3")]
    pub amount: Option<Coin>,
}

/// `MsgBeginRedelegate`: move `amount` of a stake to another validator, at once.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgBeginRedelegate {
    /// The signer.
    #[prost(string, tag = "1")]
    pub delegator_address: String,
    /// The validator the stake leaves.
    #[prost(string, tag = "2")]
    pub validator_src_address: String,
    /// The validator it moves to.
    #[prost(string, tag = "3")]
    pub validator_dst_address: String,
    /// The coins moved.
    #[prost(message, optional, tag = "4")]
    pub amount: Option<Coin>,
}

/// `MsgCancelUnbondingDelegation`: stake again what an unbonding entry (found by the height
/// it started at) is returning.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgCancelUnbondingDelegation {
    /// The signer.
    #[prost(string, tag = "1")]
    pub delegator_address: String,
    /// The validator.
    #[prost(string, tag = "2")]
    pub validator_address: String,
    /// The coins to stake again.
    #[prost(message, optional, tag = "3")]
    pub amount: Option<Coin>,
    /// The height the unbonding entry was created at.
    #[prost(int64, tag = "4")]
    pub creation_height: i64,
}

/// Injective's `MsgTransferDelegation`: give `amount` of the signer's stake to `receiver_address`.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgTransferDelegation {
    /// The signer.
    #[prost(string, tag = "1")]
    pub delegator_address: String,
    /// The validator.
    #[prost(string, tag = "2")]
    pub validator_address: String,
    /// Who receives the stake.
    #[prost(string, tag = "3")]
    pub receiver_address: String,
    /// The coins given.
    #[prost(message, optional, tag = "4")]
    pub amount: Option<Coin>,
}

macro_rules! name {
    ($($t:ident),*) => {$(
        impl Name for $t {
            const NAME: &'static str = stringify!($t);
            const PACKAGE: &'static str = PACKAGE;
            fn full_name() -> String {
                format!("{PACKAGE}.{}", Self::NAME)
            }
            fn type_url() -> String {
                format!("/{}", Self::full_name())
            }
        }
    )*};
}

name!(
    MsgDelegate,
    MsgUndelegate,
    MsgBeginRedelegate,
    MsgCancelUnbondingDelegation,
    MsgTransferDelegation
);

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;
    use choice_wallet_core::hexutil;

    fn inj(amount: &str) -> Option<Coin> {
        Some(Coin {
            denom: "inj".into(),
            amount: amount.into(),
        })
    }

    /// Expected bytes from `@keplr-wallet/proto-types` (protobufjs), an encoder written apart
    /// from this one.
    #[test]
    fn encodes_like_an_independent_encoder() {
        let d = MsgDelegate {
            delegator_address: "inj1delegator".into(),
            validator_address: "injvaloper1validator".into(),
            amount: inj("1000000000000000000"),
        };
        assert_eq!(hexutil::encode(&d.encode_to_vec()), DELEGATE);
        let r = MsgBeginRedelegate {
            delegator_address: "inj1delegator".into(),
            validator_src_address: "injvaloper1from".into(),
            validator_dst_address: "injvaloper1to".into(),
            amount: inj("5"),
        };
        assert_eq!(hexutil::encode(&r.encode_to_vec()), REDELEGATE);
        let c = MsgCancelUnbondingDelegation {
            delegator_address: "inj1delegator".into(),
            validator_address: "injvaloper1validator".into(),
            amount: inj("7"),
            creation_height: 123_456_789,
        };
        assert_eq!(hexutil::encode(&c.encode_to_vec()), CANCEL);
        assert_eq!(MsgDelegate::type_url(), "/cosmos.staking.v1beta1.MsgDelegate");
        assert_eq!(
            MsgBeginRedelegate::type_url(),
            "/cosmos.staking.v1beta1.MsgBeginRedelegate"
        );
        assert_eq!(
            MsgTransferDelegation::type_url(),
            "/cosmos.staking.v1beta1.MsgTransferDelegation"
        );
    }

    const DELEGATE: &str = "0a0d696e6a3164656c656761746f721214696e6a76616c6f7065723176616c696461746f721a1a0a03696e6a121331303030303030303030303030303030303030";
    const REDELEGATE: &str = "0a0d696e6a3164656c656761746f72120f696e6a76616c6f7065723166726f6d1a0d696e6a76616c6f70657231746f22080a03696e6a120135";
    const CANCEL: &str =
        "0a0d696e6a3164656c656761746f721214696e6a76616c6f7065723176616c696461746f721a080a03696e6a12013720959aef3a";
}
