//! The protobuf well-known types the vault uses, so it doesn't need `prost-types`.

use prost::{Message, Name};

/// `google.protobuf.Any`: a message packed together with its type URL.
#[derive(Clone, PartialEq, Eq, Hash, Message)]
pub struct Any {
    /// The packed message's type URL, e.g. `/cosmos.bank.v1beta1.MsgSend`.
    #[prost(string, tag = "1")]
    pub type_url: String,
    /// The packed message's protobuf encoding.
    #[prost(bytes = "vec", tag = "2")]
    pub value: Vec<u8>,
}

impl Any {
    /// Pack `msg` under its type URL.
    pub fn pack<M: Name>(msg: &M) -> Self {
        Self {
            type_url: M::type_url(),
            value: msg.encode_to_vec(),
        }
    }
}

/// `google.protobuf.Timestamp`: seconds and nanoseconds since the Unix epoch.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Message)]
pub struct Timestamp {
    /// Seconds since 1970-01-01T00:00:00Z.
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    /// Nanoseconds within the second.
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}

/// `google.protobuf.Duration`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Message)]
pub struct Duration {
    /// Whole seconds.
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    /// Nanoseconds within the second.
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}
