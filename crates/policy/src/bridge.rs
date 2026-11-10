//! Rules for USDC moving between chains over Circle's CCTP (`choice_wallet_injective::cctp`),
//! whoever built the transfer: the wallet's own Bridge screen or a site, from any chain the
//! wallet signs on (Injective EVM, the other EVM chains, Solana), and its mint on the
//! destination ([`receive`]).
//!
//! What a burn can't hide from its data, and is held to here:
//! - the token, which must be the signing chain's own USDC;
//! - the destination chain, which must be one the wallet names, other than the chain itself
//!   (an unknown domain may be a chain nobody can mint on);
//! - the recipient there, and whether it can receive at all (an EVM chain can't receive at a
//!   `bytes32` whose high bytes are set);
//! - who delivers: Circle (forwarding), anyone (a claim, which costs gas there), Choice's
//!   `BridgeReceiver` (a gas drop on Injective), or only the pinned `destinationCaller`;
//! - the most Circle (and a gas drop) may keep.

use choice_wallet_core::{EthAddress, base58};
use choice_wallet_evm::U256;
use choice_wallet_injective::cctp::{
    self, AddressKind, Burn, Cctp, CctpError, EvmChain, Hook, INJECTIVE_DOMAIN, Receive,
};
use choice_wallet_solana::pda;
use choice_wallet_solana::program::TOKEN;
use serde_json::json;

use crate::addresses::own_name;
use crate::amounts::Outflows;
use crate::text::short;
use crate::{Context, Finding, Level, finding};

/// How the rules name `TokenMessengerV2` (an approval's spender).
pub(crate) fn known_name(c: &Cctp, a: &EthAddress) -> Option<&'static str> {
    (*a == c.token_messenger()).then_some("Circle's bridge (CCTP)")
}

/// What a burn says, from whichever chain it starts on.
pub(crate) struct BurnFacts {
    pub amount: U256,
    pub domain: u32,
    pub mint_recipient: [u8; 32],
    pub destination_caller: [u8; 32],
    pub max_fee: U256,
    pub hook: Hook,
}

/// A 0x address from a `bytes32` recipient, if its high 12 bytes are zero.
fn evm_in(w: &[u8; 32]) -> Option<EthAddress> {
    w[..12]
        .iter()
        .all(|&b| b == 0)
        .then(|| EthAddress::from_bytes(w[12..].try_into().expect("20 bytes")))
}

/// Findings about a burn that starts on domain `local`, its token already checked. `me` is
/// the signer's own address in the destination's form, where it has one there (an EVM
/// signer on an EVM chain). Returns whether it arrives at one of the user's own accounts, or
/// `None` where it can't arrive anywhere.
pub(crate) fn burn_findings(
    c: &Cctp,
    local: u32,
    me: Option<&str>,
    b: &BurnFacts,
    ctx: &Context,
    out: &mut Vec<Finding>,
) -> Option<bool> {
    let Some(domain) = c.destination(local, b.domain) else {
        out.push(finding(
            "bridge_unknown_chain",
            Level::Red,
            format!(
                "Sends USDC to CCTP domain {}, a chain the wallet doesn't know.",
                b.domain
            ),
            json!({ "domain": b.domain }),
        ));
        return None;
    };
    let chain = domain.name;
    let permissionless = b.destination_caller == [0; 32];
    let drop_fee = match &b.hook {
        Hook::GasDrop { max_drop_fee, .. } => *max_drop_fee,
        _ => U256::ZERO,
    };
    // Who ends up with it: the hook's recipient for a gas drop through Choice's contract; on
    // Solana the wallet Circle opens the USDC account for, when the account is that wallet's;
    // otherwise the mint recipient.
    let (to, token_account) = match (&b.hook, domain.kind) {
        (Hook::GasDrop { recipient, .. }, _) => {
            let receiver = c.bridge_receiver().map(|r| cctp::word(&r));
            if domain.id != INJECTIVE_DOMAIN
                || receiver.is_none_or(|r| r != b.mint_recipient || r != b.destination_caller)
            {
                out.push(finding(
                    "bridge_gas_drop_wrong",
                    Level::Red,
                    "Asks for INJ for gas, but not through Choice's bridge contract: it may never arrive.".into(),
                    json!({ "chain": chain }),
                ));
                return None;
            }
            (Some(recipient.to_checksum_hex()), None)
        }
        (_, AddressKind::Evm) => (evm_in(&b.mint_recipient).map(|a| a.to_checksum_hex()), None),
        (Hook::ForwardWithAccount { owner }, AddressKind::Solana) => {
            let theirs = pda::associated_token_address(owner, &c.solana.usdc_mint(), &TOKEN.key()) == b.mint_recipient;
            if theirs {
                (Some(base58::encode(owner)), Some(base58::encode(&b.mint_recipient)))
            } else {
                out.push(finding(
                    "bridge_solana_account",
                    Level::Amber,
                    format!(
                        "Opens a USDC account for {}, but pays another account: {}.",
                        short(&base58::encode(owner)),
                        short(&base58::encode(&b.mint_recipient))
                    ),
                    json!({ "owner": base58::encode(owner), "token_account": base58::encode(&b.mint_recipient) }),
                ));
                (Some(base58::encode(&b.mint_recipient)), None)
            }
        }
        (_, AddressKind::Solana) => (Some(base58::encode(&b.mint_recipient)), None),
    };
    let Some(to) = to else {
        out.push(finding(
            "bridge_recipient_unusable",
            Level::Red,
            format!("The recipient on {chain} isn't an address: the USDC would be lost."),
            json!({ "chain": chain, "mint_recipient": format!("0x{}", hex(&b.mint_recipient)) }),
        ));
        return None;
    };
    out.push(finding(
        "bridge",
        Level::Info,
        format!("Bridges USDC to {chain} over Circle's CCTP."),
        json!({
            "chain": chain,
            "domain": b.domain,
            "recipient": to,
            "token_account": token_account,
            "amount": b.amount.to_string(),
            "max_fee": b.max_fee.to_string(),
        }),
    ));
    let own = if me.is_some_and(|m| m.eq_ignore_ascii_case(&to)) {
        Some("this account's own address".to_owned())
    } else {
        own_name(ctx, &to)
    };
    match &own {
        Some(name) => out.push(finding(
            "bridge_to_self",
            Level::Info,
            format!("Arrives at {name} on {chain}."),
            json!({ "chain": chain, "recipient": to }),
        )),
        None => out.push(finding(
            "bridge_recipient",
            Level::Amber,
            format!("Arrives at {} on {chain}, not at one of your accounts.", short(&to)),
            json!({ "chain": chain, "recipient": to }),
        )),
    }
    match (&b.hook, permissionless) {
        (Hook::GasDrop { .. }, _) => out.push(finding(
            "bridge_gas_drop",
            Level::Info,
            "Choice's bridge contract completes it, and buys INJ for gas with at most the fee shown.".into(),
            json!({ "max_drop_fee": drop_fee.to_string() }),
        )),
        (_, false) => out.push(finding(
            "bridge_caller",
            Level::Amber,
            format!(
                "Only {} can deliver it on {chain}; nobody else can complete it.",
                short(&format!("0x{}", hex(&b.destination_caller)))
            ),
            json!({ "chain": chain, "destination_caller": format!("0x{}", hex(&b.destination_caller)) }),
        )),
        (Hook::None, true) if domain.id == INJECTIVE_DOMAIN => out.push(delivery_on_injective(c)),
        (Hook::Forward | Hook::ForwardWithAccount { .. }, true) if domain.forwarding => out.push(finding(
            "bridge_forward",
            Level::Info,
            format!("Circle delivers it on {chain}, for a fee of at most the one shown."),
            json!({ "chain": chain, "max_fee": b.max_fee.to_string() }),
        )),
        (Hook::None, true) => out.push(finding(
            "bridge_claim",
            Level::Amber,
            format!("Nobody is asked to deliver it: it waits on {chain} until someone claims it, with gas there."),
            json!({ "chain": chain }),
        )),
        (Hook::Forward | Hook::ForwardWithAccount { .. }, true) => out.push(finding(
            "bridge_no_forwarding",
            Level::Amber,
            format!("Asks Circle to deliver on {chain}, which it doesn't: someone must claim it there."),
            json!({ "chain": chain }),
        )),
        (Hook::Other(h), true) => out.push(finding(
            "bridge_hook",
            Level::Amber,
            format!("Carries instructions for a contract on {chain}, and nobody is asked to deliver it."),
            json!({ "chain": chain, "hook": format!("0x{}", hex(h)) }),
        )),
    }
    let fees = b.max_fee.checked_add(&drop_fee).unwrap_or(U256::MAX);
    if fees >= b.amount {
        out.push(finding(
            "bridge_fee_all",
            Level::Red,
            "The fees could take all of it.".into(),
            json!({ "amount": b.amount.to_string(), "fees": fees.to_string() }),
        ));
    } else if times(fees, 20).is_none_or(|x| x > b.amount) {
        out.push(finding(
            "bridge_fee_high",
            Level::Amber,
            "The fees could take more than 5% of it.".into(),
            json!({ "amount": b.amount.to_string(), "fees": fees.to_string() }),
        ));
    }
    Some(own.is_some())
}

/// Findings about one burn on the EVM chain `local`, sent from `from`. USDC that leaves the
/// user's own accounts is counted in `outflows`.
pub(crate) fn burn(
    c: &Cctp,
    local: &EvmChain,
    from: &EthAddress,
    read: &Result<Burn, CctpError>,
    ctx: &Context,
    out: &mut Vec<Finding>,
    outflows: &mut Outflows,
) {
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
    if b.burn_token != local.usdc() {
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
    let facts = BurnFacts {
        amount: b.amount,
        domain: b.domain,
        mint_recipient: b.mint_recipient,
        destination_caller: b.destination_caller,
        max_fee: b.max_fee,
        hook: b.hook.clone(),
    };
    let me = from.to_checksum_hex();
    if burn_findings(c, local.domain, Some(&me), &facts, ctx, out) == Some(false) {
        outflows.add(&b.burn_token.to_checksum_hex(), b.amount);
    }
}

/// Who completes a plain transfer on Injective. Choice's bridge service runs where Choice's
/// `BridgeReceiver` is (mainnet); elsewhere only the wallet, or anyone, does.
pub(crate) fn delivery_on_injective(c: &Cctp) -> Finding {
    if c.bridge_receiver().is_some() {
        finding(
            "bridge_in_delivery",
            Level::Info,
            "Choice's bridge service completes it on Injective; anyone can, this wallet too.".into(),
            json!({}),
        )
    } else {
        finding(
            "bridge_in_delivery",
            Level::Info,
            "Nobody completes it on its own on this network; this wallet can.".into(),
            json!({ "service": false }),
        )
    }
}

/// `v × n`, `None` past 2^256.
fn times(v: U256, n: u32) -> Option<U256> {
    (1..n).try_fold(v, |acc, _| acc.checked_add(&v))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Findings about a mint (`receiveMessage`) on the EVM chain `local`, sent by `from`: it
/// completes a transfer someone burned elsewhere, and pays whoever the burn named.
pub(crate) fn receive(
    c: &Cctp,
    local: &EvmChain,
    from: &EthAddress,
    read: &Result<Receive, CctpError>,
    out: &mut Vec<Finding>,
) {
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
    let source = c.inbound(r.source_domain);
    let chain = source.map_or_else(|| format!("CCTP domain {}", r.source_domain), |s| s.name.to_owned());
    if r.destination_domain != local.domain {
        out.push(finding(
            "bridge_receive_elsewhere",
            Level::Red,
            format!("This transfer is for another chain: {} won't mint it.", local.name),
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
    if source.is_none_or(|s| r.burn_token != s.burn_token) {
        out.push(finding(
            "bridge_receive_token",
            Level::Amber,
            "The wallet can't tell which token this transfer mints.".into(),
            json!({ "burn_token": format!("0x{}", hex(&r.burn_token)) }),
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
            json!({ "mint_recipient": format!("0x{}", hex(&r.mint_recipient)) }),
        )),
    }
}
