//! Injective networks.

use choice_wallet_cosmos::chain::{Chain, KeyKind};

/// Type URL of Injective's `ethsecp256k1` public key.
pub const PUB_KEY_TYPE_URL: &str = "/injective.crypto.v1beta1.ethsecp256k1.PubKey";

/// The fee and staking denom. On Injective EVM the same balance is the native coin.
pub const INJ: &str = "inj";

/// Bech32 prefix of Injective accounts.
pub const PREFIX: &str = "inj";

const fn cosmos(chain_id: &'static str) -> Chain {
    Chain {
        chain_id,
        bech32_prefix: PREFIX,
        key: KeyKind::EthSecp256k1 {
            pub_key_type_url: PUB_KEY_TYPE_URL,
        },
        tokenfactory: Some("injective.tokenfactory.v1beta1"),
        amino_names: &[(
            "injective/tokenfactory/change-admin",
            "/injective.tokenfactory.v1beta1.MsgChangeAdmin",
        )],
    }
}

/// An Injective network: one chain with a Cosmos side and an EVM side, sharing accounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Network {
    /// The Cosmos side.
    pub cosmos: Chain,
    /// EVM chain ID (EIP-155), signed into every EVM transaction and EIP-712 domain.
    pub evm_chain_id: u64,
    /// The CW20 adapter contract, which wraps a CW20 into the bank denom
    /// `factory/{adapter}/{cw20}` and back. `None` where we haven't verified one.
    pub cw20_adapter: Option<&'static str>,
    /// EIP-712 domain chain IDs the chain accepts for Cosmos txs signed as typed data. Besides
    /// its own EVM chain ID it accepts Ethereum's, so MetaMask needn't switch networks.
    pub eip712_chain_ids: &'static [u64],
}

impl Network {
    /// CAIP-2 ID of the EVM side, e.g. `eip155:1776`.
    pub fn evm_caip2(&self) -> String {
        format!("eip155:{}", self.evm_chain_id)
    }
}

/// Injective mainnet.
pub const MAINNET: Network = Network {
    cosmos: cosmos("injective-1"),
    evm_chain_id: 1776,
    cw20_adapter: Some("inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk"),
    eip712_chain_ids: &[1776, 1],
};

/// Injective testnet. Its adapter (Injective's, label "Cw20Adapter") was checked with a
/// round trip on 2026-11-09: a CW20 in, the bank denom out, and back.
pub const TESTNET: Network = Network {
    cosmos: cosmos("injective-888"),
    evm_chain_id: 1439,
    cw20_adapter: Some("inj1hdvy6tl89llqy3ze8lv6mz5qh66sx9enn0jxg6"),
    eip712_chain_ids: &[1439, 11155111],
};

/// Every Injective network the wallet knows.
pub const NETWORKS: [Network; 2] = [MAINNET, TESTNET];
