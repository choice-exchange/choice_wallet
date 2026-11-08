//! The one protobuf well-known type the vault uses, so it doesn't need `prost-types`.

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
