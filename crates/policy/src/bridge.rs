//! Rules for USDC leaving Injective over Circle's CCTP (`choice_wallet_injective::cctp`),
//! whoever built the burn: the wallet's own Bridge screen or a site. Also for USDC coming in:
//! the deposits the wallet signs on other chains ([`source_transaction`]), and their mint on
//! Injective ([`receive`]).
//!
//! What a burn can't hide from its calldata, and is held to here:
//! - the destination chain, which must be one the wallet names (an unknown domain may be a
//!   chain nobody can mint on);
//! - the recipient there, and whether it can receive at all (an EVM chain can't receive at a
//!   `bytes32` whose high bytes are set);
//! - who delivers: Circle (forwarding), anyone (a claim, which costs gas there), or only the
//!   pinned `destinationCaller`;
//! - the most Circle may keep (`maxFee`).

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::request::TxRequest;
use choice_wallet_injective::cctp::{
    self, Burn, Cctp, CctpError, Delivery, Hook, Receive, Recipient, Source, SourceCall,
};
use serde_json::json;

use crate::amounts::balance;
use crate::text::short;
use crate::{Assessment, Context, Finding, Level, finding, site};

/// How the rules name `TokenMessengerV2` (an approval's spender).
pub(crate) fn known_name(c: &Cctp, a: &EthAddress) -> Option<&'static str> {
    (*a == c.token_messenger()).then_some("Circle's bridge (CCTP)")
}

/// Whether the burn delivers to `from`'s own address on an EVM chain (the same key, so the
/// value stays the user's).
pub(crate) fn to_self(c: &Cctp, b: &Burn, from: &EthAddress) -> bool {
    b.recipient(c) == Some(Recipient::Evm(*from))
}

/// Findings about one burn, sent from `from`.
pub(crate) fn burn(c: &Cctp, from: &EthAddress, read: &Result<Burn, CctpError>, out: &mut Vec<Finding>) {
    let b = match read {
        Ok(b) => b,
        Err(e) => {
            out.push(finding(
                "bridge_unreadable",
                Level::Red,
                "A call to Circle's bridge that the wallet can't read.".into(),
                json!({ "reason": e.0 }),
            ));
            return;
        }
    };
    if b.burn_token != c.usdc() {
        out.push(finding(
            "bridge_token",
            Level::Red,
            format!(
                "Bridges a token other than USDC ({}).",
                short(&b.burn_token.to_checksum_hex())
            ),
            json!({ "token": b.burn_token.to_checksum_hex() }),
        ));
    }
    let Some(domain) = c.domain(b.domain) else {
        out.push(finding(
            "bridge_unknown_chain",
            Level::Red,
            format!(
                "Sends USDC to CCTP domain {}, a chain the wallet doesn't know.",
                b.domain
            ),
            json!({ "domain": b.domain }),
        ));
        return;
    };
    let chain = domain.name;
    let Some(recipient) = b.recipient(c) else {
        out.push(finding(
            "bridge_recipient_unusable",
            Level::Red,
            format!("The recipient on {chain} isn't an address: the USDC would be lost."),
            json!({ "chain": chain, "mint_recipient": format!("0x{}", hex32(&b.mint_recipient)) }),
        ));
        return;
    };
    let to = recipient.display();
    out.push(finding(
        "bridge",
        Level::Info,
        format!("Bridges USDC to {chain} over Circle's CCTP."),
        json!({
            "chain": chain,
            "domain": b.domain,
            "recipient": to,
            "amount": b.amount.to_string(),
            "max_fee": b.max_fee.to_string(),
        }),
    ));
    match &recipient {
        Recipient::Evm(a) if a == from => out.push(finding(
            "bridge_to_self",
            Level::Info,
            format!("Arrives at this account's own address on {chain}."),
            json!({ "chain": chain, "recipient": to }),
        )),
        Recipient::Evm(_) => out.push(finding(
            "bridge_recipient",
            Level::Amber,
            format!(
                "Arrives at {} on {chain}, not at this account's address there.",
                short(&to)
            ),
            json!({ "chain": chain, "recipient": to }),
        )),
        Recipient::Solana(_) => {
            let owner = match &b.hook {
                Hook::ForwardWithAccount { owner } => cctp::base58(owner),
                _ => to.clone(),
            };
            out.push(finding(
                "bridge_recipient",
                Level::Amber,
                format!(
                    "Arrives at {} on Solana. Check that it is the right wallet.",
                    short(&owner)
                ),
                json!({ "chain": chain, "recipient": owner, "token_account": to }),
            ));
        }
    }
    let caller = (!b.permissionless()).then(|| format!("0x{}", hex32(&b.destination_caller)));
    match (&b.hook, &caller) {
        (_, Some(caller)) => out.push(finding(
            "bridge_caller",
            Level::Amber,
            format!(
                "Only {} can deliver it on {chain}; nobody else can complete it.",
                short(caller)
            ),
            json!({ "chain": chain, "destination_caller": caller }),
        )),
        (Hook::Forward | Hook::ForwardWithAccount { .. }, None) if domain.forwarding => out.push(finding(
            "bridge_forward",
            Level::Info,
            format!("Circle delivers it on {chain}, for a fee of at most the one shown."),
            json!({ "chain": chain, "max_fee": b.max_fee.to_string() }),
        )),
        (Hook::Forward | Hook::ForwardWithAccount { .. }, None) => out.push(finding(
            "bridge_no_forwarding",
            Level::Amber,
            format!("Asks Circle to deliver on {chain}, which it doesn't: someone must claim it there."),
            json!({ "chain": chain }),
        )),
        (Hook::None, None) => out.push(finding(
            "bridge_claim",
            Level::Amber,
            format!("Nobody is asked to deliver it: it waits on {chain} until someone claims it, with gas there."),
            json!({ "chain": chain }),
        )),
        (Hook::Other(_) | Hook::GasDrop { .. }, None) => out.push(finding(
            "bridge_hook",
            Level::Amber,
            format!("Carries instructions for a contract on {chain}, and nobody is asked to deliver it."),
            json!({ "chain": chain, "hook": format!("0x{}", hex_bytes(&cctp::hook_bytes(&b.hook).unwrap_or_default())) }),
        )),
    }
    if b.max_fee >= b.amount {
        out.push(finding(
            "bridge_fee_all",
            Level::Red,
            "Circle could keep all of it as its fee.".into(),
            json!({ "amount": b.amount.to_string(), "max_fee": b.max_fee.to_string() }),
        ));
    } else if times(b.max_fee, 20).is_none_or(|x| x > b.amount) {
        out.push(finding(
            "bridge_fee_high",
            Level::Amber,
            "Circle could keep more than 5% of it as its fee.".into(),
            json!({ "amount": b.amount.to_string(), "max_fee": b.max_fee.to_string() }),
        ));
    }
}

/// `v × n`, `None` past 2^256.
fn times(v: U256, n: u32) -> Option<U256> {
    (1..n).try_fold(v, |acc, _| acc.checked_add(&v))
}

fn hex32(b: &[u8; 32]) -> String {
    hex_bytes(b)
}

fn hex_bytes(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// For `evm_transaction`: the USDC a burn sends away (none when it goes to this account's own
/// address).
pub(crate) fn outflow(c: &Cctp, b: &Burn, from: &EthAddress) -> Option<U256> {
    (!to_self(c, b, from)).then_some(b.amount)
}

/// Rules for a transaction on a chain USDC comes from, which the vault signs only as
/// `cctp::source_call` reads it: an exact USDC approval for Circle's bridge, or a deposit
/// into the signer's own account on Injective. The host's `balances` are that chain's
/// (`native` for its coin, USDC by its address there).
pub fn source_transaction(req: &TxRequest, c: &Cctp, source: &Source, call: &SourceCall, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    let chain = source.name;
    let usdc = source.usdc().to_checksum_hex();
    match call {
        SourceCall::Approve { amount } => out.push(crate::evm::erc20_allowance(
            ctx,
            &usdc,
            &c.token_messenger().to_checksum_hex(),
            Some("Circle's bridge (CCTP)"),
            *amount,
            true,
        )),
        SourceCall::Deposit(d) => {
            let b = &d.burn;
            out.push(finding(
                "bridge_in",
                Level::Info,
                format!("Bridges USDC from {chain} to this account on Injective."),
                json!({
                    "chain": chain,
                    "amount": b.amount.to_string(),
                    "max_fee": b.max_fee.to_string(),
                    "least": d.least().to_string(),
                }),
            ));
            match d.delivery {
                Delivery::Anyone => out.push(finding(
                    "bridge_in_delivery",
                    Level::Info,
                    "Choice's bridge service completes it on Injective; anyone can, this wallet too.".into(),
                    json!({}),
                )),
                Delivery::GasDrop { max_drop_fee } => out.push(finding(
                    "bridge_gas_drop",
                    Level::Info,
                    "Choice's bridge contract completes it, and buys INJ for gas with at most the fee shown.".into(),
                    json!({ "max_drop_fee": max_drop_fee.to_string() }),
                )),
            }
            let fees = b.amount.checked_sub(&d.least()).unwrap_or(b.amount);
            if times(fees, 20).is_none_or(|x| x > b.amount) {
                out.push(finding(
                    "bridge_fee_high",
                    Level::Amber,
                    "The fees could take more than 5% of it.".into(),
                    json!({ "amount": b.amount.to_string(), "fees": fees.to_string() }),
                ));
            }
            if balance(ctx, &usdc).is_some_and(|held| b.amount > held) {
                out.push(finding(
                    "bridge_over_balance",
                    Level::Amber,
                    format!("Bridges more USDC than this account holds on {chain}."),
                    json!({ "amount": b.amount.to_string() }),
                ));
            }
        }
    }
    let tx = &req.tx;
    if let Some(bal) = balance(ctx, "native") {
        let max_gas = U256::product(u128::from(tx.gas_limit), tx.max_fee_per_gas);
        if max_gas > bal {
            out.push(finding(
                "gas_over_balance",
                Level::Amber,
                format!(
                    "The maximum fee is more {} than this account holds on {chain}.",
                    source.native.0
                ),
                json!({ "max_gas_cost": max_gas.to_string(), "balance": bal.to_string() }),
            ));
        }
    }
    Assessment::from(out)
}

/// Findings about a mint on Injective (`receiveMessage`), sent by `from`: it completes a
/// transfer someone burned elsewhere, and pays whoever the burn named.
pub(crate) fn receive(c: &Cctp, from: &EthAddress, read: &Result<Receive, CctpError>, out: &mut Vec<Finding>) {
    let r = match read {
        Ok(r) => r,
        Err(e) => {
            out.push(finding(
                "bridge_unreadable",
                Level::Red,
                "A call to Circle's bridge that the wallet can't read.".into(),
                json!({ "reason": e.0 }),
            ));
            return;
        }
    };
    let source = c.source_domain(r.source_domain);
    let chain = source.map_or_else(|| format!("CCTP domain {}", r.source_domain), |s| s.name.to_owned());
    if r.destination_domain != cctp::INJECTIVE_DOMAIN {
        out.push(finding(
            "bridge_receive_elsewhere",
            Level::Red,
            "This transfer is for another chain: Injective won't mint it.".into(),
            json!({ "destination_domain": r.destination_domain }),
        ));
        return;
    }
    let paid = r.paid();
    out.push(finding(
        "bridge_receive",
        Level::Info,
        format!("Completes a USDC transfer from {chain}."),
        json!({
            "chain": chain,
            "recipient": paid.map(|a| a.to_checksum_hex()),
            "amount": r.amount.to_string(),
            "fee": r.fee_executed.to_string(),
        }),
    ));
    if source.is_none_or(|s| r.burn_token != cctp::word(&s.usdc())) {
        out.push(finding(
            "bridge_receive_token",
            Level::Amber,
            "The wallet can't tell which token this transfer mints.".into(),
            json!({ "burn_token": format!("0x{}", hex32(&r.burn_token)) }),
        ));
    }
    match paid {
        Some(a) if a == *from => {}
        Some(a) => out.push(finding(
            "bridge_receive_other",
            Level::Amber,
            format!(
                "Pays {}, not this account; you pay the gas.",
                short(&a.to_checksum_hex())
            ),
            json!({ "recipient": a.to_checksum_hex() }),
        )),
        None => out.push(finding(
            "bridge_receive_other",
            Level::Amber,
            "Pays an account that isn't an address here.".into(),
            json!({ "mint_recipient": format!("0x{}", hex32(&r.mint_recipient)) }),
        )),
    }
}
