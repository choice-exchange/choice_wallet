use choice_wallet_core::secp256k1::keccak256;
use choice_wallet_core::{EthAddress, PrivateKey};

use crate::{Error, U256, erc20, rlp};

/// An EIP-1559 (type 2) transaction with an empty access list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eip1559Tx {
    /// EIP-155 chain ID: 1776 on Injective mainnet, 1439 on testnet.
    pub chain_id: u64,
    /// The sender's nonce.
    pub nonce: u64,
    /// Tip per gas, in wei.
    pub max_priority_fee_per_gas: u128,
    /// Fee cap per gas, in wei.
    pub max_fee_per_gas: u128,
    /// Gas limit.
    pub gas_limit: u64,
    /// Recipient or contract. Contract creation isn't supported.
    pub to: EthAddress,
    /// Native coin sent, in wei (on Injective, INJ with 18 decimals).
    pub value: U256,
    /// Calldata.
    pub data: Vec<u8>,
}

/// A signed transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTx {
    /// `0x02 || rlp([...fields, y_parity, r, s])`, for `eth_sendRawTransaction`.
    pub raw: Vec<u8>,
    /// keccak256 of `raw`: the transaction hash.
    pub hash: [u8; 32],
}

impl Eip1559Tx {
    /// A native-coin transfer of `value` to `to`. Gas and fees are filled in later.
    pub fn native_transfer(chain_id: u64, to: EthAddress, value: U256) -> Result<Self, Error> {
        if value.is_zero() {
            return Err(Error::ZeroAmount);
        }
        Ok(Self::call(chain_id, to, value, Vec::new()))
    }

    /// An ERC20 `transfer(to, amount)` on the token contract `token`.
    pub fn erc20_transfer(chain_id: u64, token: EthAddress, to: &EthAddress, amount: U256) -> Result<Self, Error> {
        if amount.is_zero() {
            return Err(Error::ZeroAmount);
        }
        Ok(Self::call(
            chain_id,
            token,
            U256::ZERO,
            erc20::transfer_calldata(to, &amount),
        ))
    }

    fn call(chain_id: u64, to: EthAddress, value: U256, data: Vec<u8>) -> Self {
        Self {
            chain_id,
            nonce: 0,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: 0,
            gas_limit: 0,
            to,
            value,
            data,
        }
    }

    fn fields(&self, out: &mut Vec<u8>) {
        rlp::u64(out, self.chain_id);
        rlp::u64(out, self.nonce);
        rlp::u128(out, self.max_priority_fee_per_gas);
        rlp::u128(out, self.max_fee_per_gas);
        rlp::u64(out, self.gas_limit);
        rlp::bytes(out, self.to.as_bytes());
        rlp::uint(out, &self.value.to_be_bytes());
        rlp::bytes(out, &self.data);
        rlp::list(out, &[]); // access list
    }

    /// The unsigned encoding, `0x02 || rlp([...fields])`.
    pub fn unsigned_bytes(&self) -> Vec<u8> {
        let mut payload = Vec::new();
        self.fields(&mut payload);
        let mut out = vec![0x02];
        rlp::list(&mut out, &payload);
        out
    }

    /// The hash that gets signed: keccak256 of [`Self::unsigned_bytes`].
    pub fn signing_hash(&self) -> [u8; 32] {
        keccak256(&self.unsigned_bytes())
    }

    /// Sign with `key`.
    pub fn sign(&self, key: &PrivateKey) -> Result<SignedTx, Error> {
        if self.max_priority_fee_per_gas > self.max_fee_per_gas {
            return Err(Error::PriorityFee);
        }
        let (sig, recid) = key.sign_prehash(&self.signing_hash());
        if recid > 1 {
            return Err(Error::RecoveryId);
        }
        let mut payload = Vec::new();
        self.fields(&mut payload);
        rlp::u64(&mut payload, u64::from(recid));
        rlp::uint(&mut payload, &sig[..32]);
        rlp::uint(&mut payload, &sig[32..]);
        let mut raw = vec![0x02];
        rlp::list(&mut raw, &payload);
        let hash = keccak256(&raw);
        Ok(SignedTx { raw, hash })
    }
}
