//! Injective networks.

/// An Injective network the wallet can connect to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Network {
    /// Cosmos chain ID, signed into every SignDoc.
    pub chain_id: &'static str,
    /// EVM chain ID (EIP-155), signed into every EVM transaction and EIP-712 domain.
    pub evm_chain_id: u64,
    /// The CW20 adapter contract, which wraps a CW20 into the bank denom
    /// `factory/{adapter}/{cw20}` and back. `None` where we haven't verified one.
    pub cw20_adapter: Option<&'static str>,
    /// EIP-712 domain chain IDs the chain accepts for Cosmos txs signed as typed data. Besides
    /// its own EVM chain ID it accepts Ethereum's, so MetaMask needn't switch networks.
    pub eip712_chain_ids: &'static [u64],
}

/// Injective mainnet.
pub const MAINNET: Network = Network {
    chain_id: "injective-1",
    evm_chain_id: 1776,
    cw20_adapter: Some("inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk"),
    eip712_chain_ids: &[1776, 1],
};

/// Injective testnet.
pub const TESTNET: Network = Network {
    chain_id: "injective-888",
    evm_chain_id: 1439,
    cw20_adapter: None,
    eip712_chain_ids: &[1439, 11155111],
};

/// The fee and staking denom. On Injective EVM the same balance is the native coin.
pub const INJ: &str = "inj";
