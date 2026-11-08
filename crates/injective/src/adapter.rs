//! CW20 ⇄ bank conversions through Injective's CW20 adapter.
//!
//! Sending a CW20 to the adapter (CW20 `send` with an empty `msg`) mints the bank denom
//! `factory/{adapter}/{cw20}` to the sender. `redeem_and_transfer` with that denom attached
//! burns it and delivers the CW20. The adapter registers new CW20s by itself.

use choice_wallet_cosmos::builder::{self, check_amount};
use choice_wallet_cosmos::cosmwasm;
use choice_wallet_cosmos::msg::Coin;
use choice_wallet_cosmos::wkt::Any;

use crate::Error;
use crate::chain::Network;

/// Convert `amount` of the CW20 at `cw20` into the bank denom [`adapter_denom`], by sending
/// it to the adapter at `adapter`. The adapter mints the bank denom to `from`.
pub fn cw20_to_bank(network: &Network, from: &str, cw20: &str, adapter: &str, amount: &str) -> Result<Any, Error> {
    builder::cw20_send(&network.cosmos, from, cw20, adapter, amount, "")
}

/// Convert `amount` of the adapter bank denom for `cw20` back into the CW20, delivered to
/// `recipient` (often `from` itself).
pub fn bank_to_cw20(
    network: &Network,
    from: &str,
    adapter: &str,
    cw20: &str,
    amount: &str,
    recipient: &str,
) -> Result<Any, Error> {
    check_amount(amount)?;
    network.cosmos.check_address(cw20)?;
    network.cosmos.check_address(recipient)?;
    let funds = Coin::new(&adapter_denom(adapter, cw20), amount)?;
    builder::execute_contract(
        &network.cosmos,
        from,
        adapter,
        cosmwasm::redeem_and_transfer(recipient),
        &[funds],
    )
}

/// The bank denom the CW20 adapter mints for `cw20`: `factory/{adapter}/{cw20}`.
pub fn adapter_denom(adapter: &str, cw20: &str) -> String {
    format!("factory/{adapter}/{cw20}")
}
