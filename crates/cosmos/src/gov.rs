//! `cosmos.gov` votes, written from the wire format.
//!
//! Vendoring `gov/v1beta1/tx.proto` and `gov/v1/tx.proto` would pull in proposal records,
//! params and deposits for one small message, so it is spelled out instead, like the staking
//! messages (`staking.rs`). Field numbers are from InjectiveLabs/cosmos-sdk v0.50.14-inj.11
//! `proto/cosmos/gov/{v1beta1,v1}/tx.proto` (Apache-2.0); the tests check the encoding
//! against `protoc --encode` of those files.

use prost::Name;
use serde::Serialize;

/// How an account votes (`cosmos.gov.v1.VoteOption`, the same numbers in v1beta1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoteOption {
    /// 1.
    Yes,
    /// 2.
    Abstain,
    /// 3.
    No,
    /// 4: no, and the proposal's deposit is burned if a third of the votes say so.
    NoWithVeto,
}

impl VoteOption {
    /// The option for its wire number; none for 0 (unspecified) or an unknown number.
    pub fn from_number(n: i32) -> Option<Self> {
        match n {
            1 => Some(Self::Yes),
            2 => Some(Self::Abstain),
            3 => Some(Self::No),
            4 => Some(Self::NoWithVeto),
            _ => None,
        }
    }

    /// Its wire number.
    pub fn number(self) -> i32 {
        match self {
            Self::Yes => 1,
            Self::Abstain => 2,
            Self::No => 3,
            Self::NoWithVeto => 4,
        }
    }

    /// The option by its name: `yes`, `abstain`, `no`, `no_with_veto`, or the enum's own
    /// (`VOTE_OPTION_YES`, …).
    pub fn from_name(s: &str) -> Option<Self> {
        match s
            .strip_prefix("VOTE_OPTION_")
            .map_or_else(|| s.to_owned(), str::to_lowercase)
            .as_str()
        {
            "yes" => Some(Self::Yes),
            "abstain" => Some(Self::Abstain),
            "no" => Some(Self::No),
            "no_with_veto" => Some(Self::NoWithVeto),
            _ => None,
        }
    }
}

/// `cosmos.gov.v1beta1.MsgVote`: the signer's vote on a proposal.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgVoteV1beta1 {
    /// The proposal.
    #[prost(uint64, tag = "1")]
    pub proposal_id: u64,
    /// The signer.
    #[prost(string, tag = "2")]
    pub voter: String,
    /// `VoteOption`'s number.
    #[prost(int32, tag = "3")]
    pub option: i32,
}

/// `cosmos.gov.v1.MsgVote`: the same, with free-form metadata.
#[derive(Clone, PartialEq, prost::Message)]
pub struct MsgVoteV1 {
    /// The proposal.
    #[prost(uint64, tag = "1")]
    pub proposal_id: u64,
    /// The signer.
    #[prost(string, tag = "2")]
    pub voter: String,
    /// `VoteOption`'s number.
    #[prost(int32, tag = "3")]
    pub option: i32,
    /// The voter's note, if any.
    #[prost(string, tag = "4")]
    pub metadata: String,
}

impl Name for MsgVoteV1beta1 {
    const NAME: &'static str = "MsgVote";
    const PACKAGE: &'static str = "cosmos.gov.v1beta1";
    fn full_name() -> String {
        format!("{}.{}", Self::PACKAGE, Self::NAME)
    }
    fn type_url() -> String {
        format!("/{}", Self::full_name())
    }
}

impl Name for MsgVoteV1 {
    const NAME: &'static str = "MsgVote";
    const PACKAGE: &'static str = "cosmos.gov.v1";
    fn full_name() -> String {
        format!("{}.{}", Self::PACKAGE, Self::NAME)
    }
    fn type_url() -> String {
        format!("/{}", Self::full_name())
    }
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;
    use choice_wallet_core::hexutil;

    /// Expected bytes from `protoc --encode` (the C++ encoder) of the vendored sources'
    /// tx.proto files, an encoder written apart from this one.
    #[test]
    fn encodes_like_protoc() {
        let old = MsgVoteV1beta1 {
            proposal_id: 713,
            voter: "inj1voter".into(),
            option: VoteOption::NoWithVeto.number(),
        };
        assert_eq!(
            hexutil::encode(&old.encode_to_vec()),
            "08c9051209696e6a31766f7465721804"
        );
        let new = MsgVoteV1 {
            proposal_id: 713,
            voter: "inj1voter".into(),
            option: VoteOption::Yes.number(),
            metadata: "hi".into(),
        };
        assert_eq!(
            hexutil::encode(&new.encode_to_vec()),
            "08c9051209696e6a31766f746572180122026869"
        );
        assert_eq!(MsgVoteV1beta1::type_url(), "/cosmos.gov.v1beta1.MsgVote");
        assert_eq!(MsgVoteV1::type_url(), "/cosmos.gov.v1.MsgVote");
    }

    #[test]
    fn options_by_number_and_name() {
        for o in [
            VoteOption::Yes,
            VoteOption::Abstain,
            VoteOption::No,
            VoteOption::NoWithVeto,
        ] {
            assert_eq!(VoteOption::from_number(o.number()), Some(o));
        }
        assert_eq!(VoteOption::from_number(0), None);
        assert_eq!(VoteOption::from_number(5), None);
        assert_eq!(VoteOption::from_name("no_with_veto"), Some(VoteOption::NoWithVeto));
        assert_eq!(VoteOption::from_name("VOTE_OPTION_ABSTAIN"), Some(VoteOption::Abstain));
        assert_eq!(VoteOption::from_name("VOTE_OPTION_UNSPECIFIED"), None);
        assert_eq!(VoteOption::from_name("maybe"), None);
    }
}
