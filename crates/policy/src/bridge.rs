//! Rules for USDC leaving Injective over Circle's CCTP (`choice_wallet_injective::cctp`),
//! whoever built the burn: the wallet's own Bridge screen or a site.
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
use choice_wallet_injective::cctp::{self, Burn, Cctp, CctpError, Hook, Recipient};
use serde_json::json;

use crate::text::short;
use crate::{Finding, Level, finding};

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
        (Hook::Other(h), None) => out.push(finding(
            "bridge_hook",
            Level::Amber,
            format!("Carries instructions for a contract on {chain}, and nobody is asked to deliver it."),
            json!({ "chain": chain, "hook": format!("0x{}", hex_bytes(h)) }),
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
