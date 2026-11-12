//! Rules for Solana transactions, as `choice_wallet_solana::read` reads them.
//!
//! What matters on Solana, and is held to here:
//! - who signs and who pays the fee, and what the fee may come to;
//! - SOL and tokens leaving the account, and to whom: a token goes to a token account, so the
//!   rules name its owner only when the transaction itself opens that account for them, or
//!   the address derives from the owner the host named;
//! - handing an account away: System `Assign` (the program then owns everything in it) and
//!   Token `SetAuthority` (someone else then owns the token account), the drains Solana is
//!   known for; delegates (`Approve`);
//! - a durable nonce, which keeps a signed transaction valid until used;
//! - USDC leaving over Circle's CCTP: the destination, the recipient, who delivers, the fee;
//! - programs the wallet doesn't read: named, and never shown as safe.

use choice_wallet_core::base58;
use choice_wallet_evm::U256;
use choice_wallet_injective::cctp::{self, Cctp, Hook};
use choice_wallet_solana::Read;
use choice_wallet_solana::message::Pubkey;
use choice_wallet_solana::pda;
use choice_wallet_solana::program::{self, CctpBurn, Instruction};
use serde_json::json;

use crate::addresses::recipient;
use crate::amounts::{Outflows, balance};
use crate::text::short;
use crate::{Assessment, Context, Finding, Level, finding, site};

/// A priority fee above 0.01 SOL is worth a look.
const HIGH_PRIORITY_FEE: u64 = 10_000_000;
/// Delegations at or above this are as good as unlimited (u64::MAX is the usual sentinel).
const UNLIMITED_DELEGATE: u64 = 1 << 60;

fn b58(k: &Pubkey) -> String {
    base58::encode(k)
}

fn program_name(p: &Pubkey) -> String {
    program::name(p).map_or_else(|| short(&b58(p)), str::to_owned)
}

/// Whose token account `account` is, and whether the wallet checked it: an account this
/// transaction opens for its owner (the Associated Token Account program derives it, or the
/// transaction fails), or one the host looked up whose address derives from that owner and
/// mint. `mint` is the instruction's, when it names one.
fn token_owner(r: &Read, ctx: &Context, account: &Pubkey, mint: Option<&Pubkey>) -> Option<(Pubkey, bool)> {
    for s in &r.steps {
        if let Instruction::CreateTokenAccount {
            account: a,
            owner,
            mint: m,
            ..
        } = &s.instruction
            && a == account
            && mint.is_none_or(|x| x == m)
        {
            return Some((*owner, true));
        }
    }
    let info = ctx.solana_token_accounts.get(&b58(account))?;
    let owner = base58::decode32(&info.owner)?;
    let held = base58::decode32(&info.mint)?;
    if mint.is_some_and(|m| *m != held) {
        return None;
    }
    Some((owner, pda::token_account_of(account, &owner, &held).is_some()))
}

/// The mint of a token account, if the transaction or the host names it.
fn token_mint(r: &Read, ctx: &Context, account: &Pubkey) -> Option<Pubkey> {
    r.steps
        .iter()
        .find_map(|s| match &s.instruction {
            Instruction::CreateTokenAccount { account: a, mint, .. } if a == account => Some(*mint),
            _ => None,
        })
        .or_else(|| base58::decode32(&ctx.solana_token_accounts.get(&b58(account))?.mint))
}

/// Grade a Solana transaction that `signer` signs. `c` is CCTP on the network the chain
/// belongs to (its Solana USDC, and the chains a burn may go to).
pub fn solana_transaction(r: &Read, signer: &Pubkey, c: &Cctp, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    let mut outflows = Outflows::default();
    let mut sol_out: u64 = 0;
    let mut unread: Vec<Pubkey> = Vec::new();
    let mut expected_signers: Vec<Pubkey> = vec![*signer];

    if r.durable_nonce {
        out.push(finding(
            "solana_durable_nonce",
            Level::Amber,
            "It stays valid until it's used, so it can be sent much later.".into(),
            json!({}),
        ));
    }
    if r.fee.priority > HIGH_PRIORITY_FEE {
        out.push(finding(
            "solana_priority_fee_high",
            Level::Amber,
            "The priority fee is unusually high.".into(),
            json!({ "lamports": r.fee.priority.to_string() }),
        ));
    }

    for s in &r.steps {
        match &s.instruction {
            Instruction::Transfer { from, to, lamports } => {
                if from == signer {
                    sol_out = sol_out.saturating_add(*lamports);
                    if to != signer {
                        recipient(ctx, &b58(to), None, &mut out);
                    }
                }
            }
            Instruction::CreateAccount {
                from,
                account,
                lamports,
                owner,
                ..
            } => {
                expected_signers.push(*account);
                if from == signer {
                    sol_out = sol_out.saturating_add(*lamports);
                }
                if account == signer {
                    out.push(assign_away(owner));
                }
            }
            Instruction::Assign { account, owner } => {
                if account == signer {
                    out.push(assign_away(owner));
                }
            }
            Instruction::AdvanceNonce { .. }
            | Instruction::ComputeUnitLimit(_)
            | Instruction::ComputeUnitPrice(_)
            | Instruction::Memo(_)
            | Instruction::TokenSyncNative { .. } => {}
            Instruction::TokenTransfer {
                source,
                destination,
                authority,
                amount,
                mint,
                ..
            } => {
                if authority != signer {
                    continue;
                }
                let mint = mint.or_else(|| token_mint(r, ctx, source));
                match mint {
                    Some(m) => outflows.add(&b58(&m), U256::from_u128((*amount).into())),
                    None => out.push(finding(
                        "solana_token_unnamed",
                        Level::Amber,
                        "Moves tokens without naming which token.".into(),
                        json!({ "source": b58(source), "amount": amount.to_string() }),
                    )),
                }
                match token_owner(r, ctx, destination, mint.as_ref()) {
                    Some((owner, _)) if owner == *signer => {}
                    Some((owner, true)) => recipient(ctx, &b58(&owner), None, &mut out),
                    Some((owner, false)) => {
                        recipient(ctx, &b58(&owner), None, &mut out);
                        out.push(finding(
                            "solana_token_account_unchecked",
                            Level::Amber,
                            format!(
                                "The RPC says {} belongs to {}, which the wallet couldn't check.",
                                short(&b58(destination)),
                                short(&b58(&owner))
                            ),
                            json!({ "account": b58(destination), "owner": b58(&owner) }),
                        ));
                    }
                    None => out.push(finding(
                        "solana_token_account_unknown",
                        Level::Amber,
                        format!(
                            "Sends to token account {}; the wallet can't tell whose it is.",
                            short(&b58(destination))
                        ),
                        json!({ "account": b58(destination) }),
                    )),
                }
            }
            Instruction::TokenApprove {
                source,
                delegate,
                owner,
                amount,
                mint,
                ..
            } => {
                if owner != signer {
                    continue;
                }
                let token = mint.or_else(|| token_mint(r, ctx, source)).map(|m| b58(&m));
                let params = json!({ "account": b58(source), "delegate": b58(delegate), "amount": amount.to_string(), "token": token });
                let name = token.as_deref().map_or("this token", |t| ctx.token_name(t));
                out.push(if *amount >= UNLIMITED_DELEGATE {
                    finding(
                        "solana_unlimited_delegate",
                        Level::Red,
                        format!("{} could take ALL of {name} from this account.", short(&b58(delegate))),
                        params,
                    )
                } else {
                    finding(
                        "solana_delegate",
                        Level::Amber,
                        format!("Lets {} move some of {name} from this account.", short(&b58(delegate))),
                        params,
                    )
                });
            }
            Instruction::TokenRevoke { .. } => {}
            Instruction::TokenSetAuthority {
                account,
                kind,
                new_authority,
                current,
                ..
            } => {
                if current != signer {
                    continue;
                }
                let to = new_authority.as_ref().map(b58);
                let params = json!({ "account": b58(account), "kind": kind, "new_authority": to });
                let who = to.as_deref().map_or_else(|| "nobody".to_owned(), short);
                out.push(match kind {
                    2 => {
                        let mut f = finding(
                            "solana_token_account_owner",
                            Level::Red,
                            format!("Gives this token account, and everything in it, to {who}."),
                            params,
                        );
                        f.confirm = Some("GIVE");
                        f
                    }
                    3 => finding(
                        "solana_close_authority",
                        Level::Amber,
                        format!("Lets {who} close this token account and take its SOL."),
                        params,
                    ),
                    _ => finding(
                        "solana_authority",
                        Level::Amber,
                        format!("Changes who controls {} to {who}.", short(&b58(account))),
                        params,
                    ),
                });
            }
            Instruction::TokenClose {
                account,
                destination,
                owner,
                ..
            } => {
                if owner == signer && destination != signer {
                    out.push(finding(
                        "solana_close_elsewhere",
                        Level::Amber,
                        format!(
                            "Closes a token account and sends its SOL to {}.",
                            short(&b58(destination))
                        ),
                        json!({ "account": b58(account), "destination": b58(destination) }),
                    ));
                }
            }
            Instruction::TokenBurn {
                mint, owner, amount, ..
            } => {
                if owner == signer {
                    out.push(finding(
                        "solana_token_burn",
                        Level::Amber,
                        format!("Destroys some {}.", ctx.token_name(&b58(mint))),
                        json!({ "token": b58(mint), "amount": amount.to_string() }),
                    ));
                }
            }
            Instruction::TokenInitializeAccount { .. } | Instruction::CreateTokenAccount { .. } => {}
            Instruction::TokenOther { program, kind } => out.push(finding(
                "solana_token_other",
                Level::Amber,
                format!("A {} instruction the wallet doesn't read.", program_name(program)),
                json!({ "program": b58(program), "kind": kind }),
            )),
            Instruction::CctpBurn(b) => {
                expected_signers.push(b.event_account);
                bridge_burn(c, b, signer, ctx, &mut out, &mut outflows);
            }
            Instruction::CctpReclaim { payee, .. } => {
                if payee == signer {
                    out.push(finding(
                        "solana_bridge_reclaim",
                        Level::Info,
                        "Takes back the rent of a finished bridge transfer's record.".into(),
                        json!({}),
                    ));
                }
            }
            Instruction::Unreadable { program, reason } => out.push(finding(
                "solana_unreadable",
                Level::Red,
                format!("A {} instruction the wallet can't read.", program_name(program)),
                json!({ "program": b58(program), "reason": reason }),
            )),
            Instruction::Other { program } => {
                if !unread.contains(program) {
                    unread.push(*program);
                }
            }
        }
    }

    for p in &unread {
        let name = program_name(p);
        let id = b58(p);
        out.push(finding(
            "solana_unread_program",
            Level::Amber,
            format!("The wallet can't read what {name} does here."),
            json!({ "program": id }),
        ));
        if !ctx.known_contracts.contains(&id) {
            out.push(finding(
                "new_program",
                Level::Info,
                format!("First use of {name}."),
                json!({ "program": id }),
            ));
        }
    }

    let others: Vec<String> = r
        .message
        .signers()
        .iter()
        .filter(|k| !expected_signers.contains(k))
        .map(b58)
        .collect();
    if !others.is_empty() {
        out.push(finding(
            "solana_cosigners",
            Level::Info,
            format!(
                "Also signed by {}.",
                others.iter().map(|s| short(s)).collect::<Vec<_>>().join(", ")
            ),
            json!({ "signers": others }),
        ));
    }
    let payer = r.message.fee_payer();
    if payer != signer {
        out.push(finding(
            "solana_fee_paid_by_other",
            Level::Info,
            format!("{} pays the network fee.", short(&b58(payer))),
            json!({ "fee_payer": b58(payer) }),
        ));
    }
    if r.from_tables() {
        out.push(finding(
            "solana_lookup_tables",
            Level::Info,
            "Some accounts come from lookup tables, as the RPC read them.".into(),
            json!({}),
        ));
    }

    handovers(ctx, &mut out);
    if sol_out > 0 {
        outflows.add("native", U256::from_u128(sol_out.into()));
    }
    outflows.check(ctx, &mut out);
    let fee = if payer == signer { r.fee.total() } else { 0 };
    if let Some(bal) = balance(ctx, "native")
        && U256::from_u128(u128::from(sol_out) + u128::from(fee)) > bal
    {
        out.push(finding(
            "solana_fee_over_balance",
            Level::Amber,
            "This account doesn't hold enough SOL for this and its fee.".into(),
            json!({ "needed": (u128::from(sol_out) + u128::from(fee)).to_string(), "balance": bal.to_string() }),
        ));
    }
    Assessment::from(out)
}

/// Findings for what the host's simulation shows the transaction hands over, the same as
/// for the instructions that would say so, unless one already did.
fn handovers(ctx: &Context, out: &mut Vec<Finding>) {
    for h in &ctx.solana_handovers {
        let account = h.account.as_deref();
        let said = |out: &[Finding], rules: &[&str]| {
            out.iter().any(|f| {
                rules.contains(&f.rule) && account.is_none_or(|a| f.params.get("account").and_then(|v| v.as_str()) == Some(a))
            })
        };
        let to = base58::decode32(&h.to).map_or_else(|| short(&h.to), |p| program_name(&p));
        let token = h.mint.as_deref().map_or("this token", |m| ctx.token_name(m));
        let params = json!({ "account": account, "to": h.to, "token": h.mint, "simulated": true });
        let f = match h.kind.as_str() {
            "assign" if !said(out, &["solana_assign"]) => {
                let mut f = finding(
                    "solana_assign",
                    Level::Red,
                    format!("Hands this account to {to}: it could take all its SOL and tokens."),
                    params,
                );
                f.confirm = Some("GIVE");
                f
            }
            "token_owner" if !said(out, &["solana_token_account_owner"]) => {
                let mut f = finding(
                    "solana_token_account_owner",
                    Level::Red,
                    format!("Gives this token account, and everything in it, to {to}."),
                    params,
                );
                f.confirm = Some("GIVE");
                f
            }
            "delegate" if !said(out, &["solana_unlimited_delegate", "solana_delegate"]) => {
                if h.all {
                    finding(
                        "solana_unlimited_delegate",
                        Level::Red,
                        format!("{to} could take ALL of {token} from this account."),
                        params,
                    )
                } else {
                    finding(
                        "solana_delegate",
                        Level::Amber,
                        format!("Lets {to} move some of {token} from this account."),
                        params,
                    )
                }
            }
            "close_authority" if !said(out, &["solana_close_authority"]) => finding(
                "solana_close_authority",
                Level::Amber,
                format!("Lets {to} close this token account and take its SOL."),
                params,
            ),
            _ => continue,
        };
        out.push(f);
    }
}

fn assign_away(owner: &Pubkey) -> Finding {
    let mut f = finding(
        "solana_assign",
        Level::Red,
        format!(
            "Hands this account to {}: it could take all its SOL and tokens.",
            program_name(owner)
        ),
        json!({ "owner": b58(owner) }),
    );
    f.confirm = Some("GIVE");
    f
}

fn bridge_burn(
    c: &Cctp,
    b: &CctpBurn,
    signer: &Pubkey,
    ctx: &Context,
    out: &mut Vec<Finding>,
    outflows: &mut Outflows,
) {
    let usdc = c.solana.usdc_mint();
    if b.mint != usdc {
        out.push(finding(
            "bridge_token",
            Level::Red,
            format!("Bridges a token other than USDC ({}).", short(&b58(&b.mint))),
            json!({ "token": b58(&b.mint) }),
        ));
    }
    let facts = crate::bridge::BurnFacts {
        amount: U256::from_u128(b.amount.into()),
        domain: b.domain,
        mint_recipient: b.mint_recipient,
        destination_caller: b.destination_caller,
        max_fee: U256::from_u128(b.max_fee.into()),
        hook: b.hook.as_deref().map_or(Hook::None, cctp::read_hook),
    };
    let own = crate::bridge::burn_findings(c, cctp::SOLANA_DOMAIN, None, &facts, ctx, out);
    if &b.owner == signer && own == Some(false) {
        outflows.add(&b58(&b.mint), facts.amount);
    }
    if &b.rent_payer == signer {
        out.push(finding(
            "bridge_record_rent",
            Level::Info,
            "Also locks a little SOL as rent for the transfer's record; it comes back after 5 days.".into(),
            json!({}),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Contact, SolanaTokenAccount};
    use choice_wallet_core::EthAddress;
    use choice_wallet_injective::cctp::{MAINNET, TESTNET};
    use choice_wallet_solana::message::Account;
    use choice_wallet_solana::program::{SYSTEM, TOKEN};
    use choice_wallet_solana::{Fee, Step};

    const ME: Pubkey = [1; 32];
    const THEM: Pubkey = [2; 32];
    const ME_EVM: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

    fn tx(signers: &[Pubkey], steps: Vec<Instruction>) -> Read {
        let keys = signers.to_vec();
        Read {
            message: choice_wallet_solana::message::Message {
                version: choice_wallet_solana::message::Version::Legacy,
                header: choice_wallet_solana::message::Header {
                    required_signatures: signers.len() as u8,
                    readonly_signed: 0,
                    readonly_unsigned: 0,
                },
                keys,
                blockhash: [0; 32],
                instructions: vec![],
                lookups: vec![],
            },
            accounts: vec![],
            steps: steps
                .into_iter()
                .map(|instruction| Step {
                    program: SYSTEM.key(),
                    accounts: Vec::<Account>::new(),
                    instruction,
                    data: vec![],
                })
                .collect(),
            fee: Fee {
                base: 5_000,
                priority: 0,
                unit_limit: None,
                unit_price: None,
            },
            durable_nonce: false,
        }
    }

    fn rules(r: &Read, c: &Cctp, ctx: &Context) -> Vec<&'static str> {
        solana_transaction(r, &ME, c, ctx)
            .findings
            .iter()
            .map(|f| f.rule)
            .collect()
    }

    fn word(a: &str) -> [u8; 32] {
        cctp::word(&EthAddress::parse_hex(a).unwrap())
    }

    fn mine() -> Context {
        Context {
            address_book: vec![Contact {
                address: ME_EVM.into(),
                mine: true,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    /// F2: what a simulation shows handed over through a program the vault can't read is
    /// graded as the instruction that does it directly would be.
    #[test]
    fn simulated_handovers_are_graded_like_the_instructions() {
        let program = [0x42; 32];
        let r = tx(
            &[ME],
            vec![Instruction::Other { program }],
        );
        let grade = |h: crate::SolanaHandover| {
            let ctx = Context {
                solana_handovers: vec![h],
                ..Default::default()
            };
            let a = solana_transaction(&r, &ME, &MAINNET, &ctx);
            let f = a.findings.iter().find(|f| f.params["simulated"] == true).cloned();
            (a.level, a.confirm, f.map(|f| f.rule))
        };
        let account = Some(b58(&[7; 32]));
        let them = b58(&THEM);
        assert_eq!(
            grade(crate::SolanaHandover {
                kind: "token_owner".into(),
                account: account.clone(),
                to: them.clone(),
                ..Default::default()
            }),
            (Level::Red, Some("GIVE"), Some("solana_token_account_owner"))
        );
        assert_eq!(
            grade(crate::SolanaHandover {
                kind: "assign".into(),
                to: b58(&program),
                ..Default::default()
            }),
            (Level::Red, Some("GIVE"), Some("solana_assign"))
        );
        assert_eq!(
            grade(crate::SolanaHandover {
                kind: "delegate".into(),
                account: account.clone(),
                to: them.clone(),
                all: true,
                ..Default::default()
            }),
            (Level::Red, None, Some("solana_unlimited_delegate"))
        );
        assert_eq!(
            grade(crate::SolanaHandover {
                kind: "close_authority".into(),
                account,
                to: them,
                ..Default::default()
            })
            .2,
            Some("solana_close_authority")
        );
    }

    #[test]
    fn handing_the_account_away_is_red() {
        let r = tx(
            &[ME],
            vec![Instruction::Assign {
                account: ME,
                owner: THEM,
            }],
        );
        let a = solana_transaction(&r, &ME, &MAINNET, &Context::default());
        assert_eq!(
            (a.level, a.confirm, a.findings[0].rule),
            (Level::Red, Some("GIVE"), "solana_assign")
        );
        let r = tx(
            &[ME],
            vec![Instruction::TokenSetAuthority {
                program: TOKEN.key(),
                account: [3; 32],
                kind: 2,
                new_authority: Some(THEM),
                current: ME,
            }],
        );
        assert_eq!(
            rules(&r, &MAINNET, &Context::default())[0],
            "solana_token_account_owner"
        );
        let r = tx(
            &[ME],
            vec![Instruction::TokenApprove {
                program: TOKEN.key(),
                source: [3; 32],
                delegate: THEM,
                owner: ME,
                amount: u64::MAX,
                mint: None,
                decimals: None,
            }],
        );
        assert_eq!(rules(&r, &MAINNET, &Context::default())[0], "solana_unlimited_delegate");
    }

    #[test]
    fn token_recipients_are_named_only_when_checked() {
        let usdc = MAINNET.solana.usdc_mint();
        let theirs = pda::associated_token_address(&THEM, &usdc, &TOKEN.key());
        let send = |create: bool| {
            let mut steps = vec![];
            if create {
                steps.push(Instruction::CreateTokenAccount {
                    payer: ME,
                    account: theirs,
                    owner: THEM,
                    mint: usdc,
                    token_program: TOKEN.key(),
                    idempotent: true,
                });
            }
            steps.push(Instruction::TokenTransfer {
                program: TOKEN.key(),
                source: pda::associated_token_address(&ME, &usdc, &TOKEN.key()),
                destination: theirs,
                authority: ME,
                amount: 5,
                mint: Some(usdc),
                decimals: Some(6),
            });
            tx(&[ME], steps)
        };
        assert!(rules(&send(false), &MAINNET, &Context::default()).contains(&"solana_token_account_unknown"));
        let book = Context {
            address_book: vec![Contact {
                address: b58(&THEM),
                name: "Sam".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(rules(&send(true), &MAINNET, &book).contains(&"address_book"));
        // The host's lookup: checked when the address derives from the owner, flagged when not.
        let looked_up = |owner: &Pubkey| Context {
            solana_token_accounts: [(
                b58(&theirs),
                SolanaTokenAccount {
                    owner: b58(owner),
                    mint: b58(&usdc),
                },
            )]
            .into(),
            ..book.clone()
        };
        let ok = rules(&send(false), &MAINNET, &looked_up(&THEM));
        assert!(ok.contains(&"address_book") && !ok.contains(&"solana_token_account_unchecked"));
        assert!(rules(&send(false), &MAINNET, &looked_up(&[9; 32])).contains(&"solana_token_account_unchecked"));
    }

    fn burn(domain: u32, recipient: [u8; 32], caller: [u8; 32], hook: Option<Vec<u8>>, c: &Cctp) -> Read {
        tx(
            &[ME, [7; 32]],
            vec![Instruction::CctpBurn(Box::new(CctpBurn {
                owner: ME,
                rent_payer: ME,
                token_account: [3; 32],
                mint: c.solana.usdc_mint(),
                event_account: [7; 32],
                amount: 2_000_000,
                domain,
                mint_recipient: recipient,
                destination_caller: caller,
                max_fee: 300,
                min_finality: 1000,
                hook,
            }))],
        )
    }

    #[test]
    fn bridging_in_from_solana() {
        // To this account on Injective: its own, delivered by Choice (mainnet) or this wallet.
        let r = burn(29, word(ME_EVM), [0; 32], None, &MAINNET);
        let got = rules(&r, &MAINNET, &mine());
        assert!(
            got.contains(&"bridge_to_self") && got.contains(&"bridge_in_delivery"),
            "{got:?}"
        );
        assert!(
            !got.contains(&"solana_cosigners"),
            "the burn's record signs too: {got:?}"
        );
        assert_eq!(solana_transaction(&r, &ME, &MAINNET, &mine()).level, Level::Info);
        let testnet = solana_transaction(&burn(29, word(ME_EVM), [0; 32], None, &TESTNET), &ME, &TESTNET, &mine());
        let delivery = testnet
            .findings
            .iter()
            .find(|f| f.rule == "bridge_in_delivery")
            .unwrap();
        assert!(delivery.message.starts_with("Nobody"));
        // Someone else's address.
        assert!(rules(&r, &MAINNET, &Context::default()).contains(&"bridge_recipient"));
        // A gas drop through Choice's contract, and one that isn't.
        let receiver = word("0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A");
        let hook = cctp::hook_bytes(&Hook::GasDrop {
            recipient: EthAddress::parse_hex(ME_EVM).unwrap(),
            max_drop_fee: U256::from_u128(200_000),
        });
        let got = rules(&burn(29, receiver, receiver, hook.clone(), &MAINNET), &MAINNET, &mine());
        assert!(
            got.contains(&"bridge_gas_drop") && got.contains(&"bridge_to_self"),
            "{got:?}"
        );
        assert_eq!(
            rules(&burn(29, word(ME_EVM), [0; 32], hook, &MAINNET), &MAINNET, &mine())[0],
            "bridge_gas_drop_wrong"
        );
        // Unknown chains, and Solana itself, are red.
        assert_eq!(
            rules(&burn(99, word(ME_EVM), [0; 32], None, &MAINNET), &MAINNET, &mine())[0],
            "bridge_unknown_chain"
        );
        assert_eq!(
            rules(&burn(5, word(ME_EVM), [0; 32], None, &MAINNET), &MAINNET, &mine())[0],
            "bridge_unknown_chain"
        );
    }

    #[test]
    fn unread_programs_are_never_safe() {
        let mut r = tx(&[ME], vec![Instruction::Other { program: [9; 32] }]);
        r.steps[0].program = [9; 32];
        let a = solana_transaction(&r, &ME, &MAINNET, &Context::default());
        assert_eq!(a.level, Level::Amber);
        assert!(a.findings.iter().any(|f| f.rule == "new_program"));
        let r = tx(
            &[ME],
            vec![Instruction::Unreadable {
                program: SYSTEM.key(),
                reason: "x",
            }],
        );
        assert_eq!(
            solana_transaction(&r, &ME, &MAINNET, &Context::default()).level,
            Level::Red
        );
    }

    #[test]
    fn sol_against_the_balance() {
        let r = tx(
            &[ME],
            vec![Instruction::Transfer {
                from: ME,
                to: THEM,
                lamports: 1_000_000,
            }],
        );
        let ctx = |bal: &str| Context {
            balances: [("native".to_owned(), bal.to_owned())].into(),
            ..Default::default()
        };
        assert!(rules(&r, &MAINNET, &ctx("1003000")).contains(&"solana_fee_over_balance"));
        assert!(!rules(&r, &MAINNET, &ctx("10000000")).contains(&"solana_fee_over_balance"));
        let mut nonce = r.clone();
        nonce.durable_nonce = true;
        assert!(rules(&nonce, &MAINNET, &Context::default()).contains(&"solana_durable_nonce"));
    }
}
