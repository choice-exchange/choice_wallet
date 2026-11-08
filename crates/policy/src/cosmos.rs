//! Rules for Cosmos messages, whichever sign path decoded them.

use choice_wallet_cosmos::cosmwasm::ContractCall;
use choice_wallet_cosmos::msg::{Allowance, Authorization, Coin, Msg};
use choice_wallet_evm::U256;
use serde_json::json;

use crate::addresses::{known_contract, recipient, same};
use crate::amounts::{Outflows, UNLIMITED, balance};
use crate::text::{date, msg_name, short};
use crate::{Assessment, Context, Finding, Level, finding, site};

/// The fee of a Cosmos transaction, as any sign path decodes it.
#[derive(Debug, Clone, Copy, Default)]
pub struct CosmosFee<'a> {
    /// Coins paid.
    pub amount: &'a [Coin],
    /// Account whose fee grant pays.
    pub granter: Option<&'a str>,
    /// Account that pays (EIP-712 fee delegation).
    pub payer: Option<&'a str>,
}

const MSG_SEND: &str = "/cosmos.bank.v1beta1.MsgSend";
const MSG_EXEC: &str = "/cosmos.authz.v1beta1.MsgExec";
/// The word to type before granting.
const GRANT: &str = "GRANT";

/// Grade a Cosmos transaction's messages, signed by `signer` (its bech32 address).
pub fn cosmos(messages: &[Msg], signer: &str, fee: CosmosFee, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    let mut outflows = Outflows::default();
    for m in messages {
        message(m, signer, ctx, Some(&mut outflows), &mut out);
    }
    match (fee.granter, fee.payer) {
        (Some(g), _) => out.push(finding(
            "fee_grant_used",
            Level::Info,
            format!("The fee is paid from {}'s fee grant.", short(g)),
            json!({ "granter": g }),
        )),
        (None, Some(p)) => out.push(finding(
            "fee_payer",
            Level::Info,
            format!("{} pays the fee.", short(p)),
            json!({ "payer": p }),
        )),
        (None, None) => {
            for c in fee.amount {
                outflows.add_str(c.denom(), c.amount());
            }
        }
    }
    outflows.check(ctx, &mut out);
    Assessment::from(out)
}

fn until(expiration: Option<i64>) -> String {
    match expiration {
        None => ", with no end date".into(),
        Some(t) => format!(", until {}", date(t)),
    }
}

fn grant_finding(rule: &'static str, message: String, params: serde_json::Value) -> Finding {
    Finding {
        confirm: Some(GRANT),
        ..finding(rule, Level::Red, message, params)
    }
}

/// `outflows` is `None` inside `MsgExec`, where messages move the granters' funds.
fn message(m: &Msg, signer: &str, ctx: &Context, mut outflows: Option<&mut Outflows>, out: &mut Vec<Finding>) {
    match m {
        Msg::BankSend { from, to, amount } => {
            recipient(ctx, to, out);
            if let Some(o) = outflows.as_deref_mut()
                && same(from, signer)
            {
                for c in amount {
                    o.add_str(c.denom(), c.amount());
                }
            }
        }
        Msg::ExecuteContract {
            contract, funds, call, ..
        } => {
            if let Some(o) = outflows.as_deref_mut() {
                for c in funds {
                    o.add_str(c.denom(), c.amount());
                }
            }
            match call {
                ContractCall::Cw20Transfer { recipient: to, amount } => {
                    recipient(ctx, to, out);
                    if let Some(o) = outflows {
                        o.add_str(contract, amount);
                    }
                }
                ContractCall::Cw20Send {
                    contract: to, amount, ..
                } => {
                    // A contract the host knows (the CW20 adapter, for the wallet's own
                    // conversions) needs no note; the amount still counts below.
                    if !known_contract(ctx, to) {
                        out.push(finding(
                            "cw20_send",
                            Level::Info,
                            format!(
                                "Sends tokens to contract {}, which runs its own code with them.",
                                short(to)
                            ),
                            json!({ "token": contract, "to": to, "amount": amount }),
                        ));
                    }
                    if let Some(o) = outflows {
                        o.add_str(contract, amount);
                    }
                }
                ContractCall::Cw20IncreaseAllowance {
                    spender,
                    amount,
                    expires,
                } => {
                    out.push(allowance(ctx, contract, spender, amount, expires.as_deref()));
                }
                ContractCall::AdapterRedeem { .. } => {}
                ContractCall::Other => {
                    if !known_contract(ctx, contract) {
                        out.push(finding(
                            "new_contract",
                            Level::Info,
                            format!("First interaction with contract {}.", short(contract)),
                            json!({ "contract": contract }),
                        ));
                    }
                }
            }
        }
        Msg::AuthzGrant {
            grantee,
            authorization,
            expiration,
            ..
        } => {
            let g = short(grantee);
            let u = until(*expiration);
            let (message, detail) = match authorization {
                Authorization::Generic { msg_type_url } if msg_type_url == MSG_SEND => (
                    format!("{g} could send ALL your tokens{u}."),
                    json!({ "msg_type_url": msg_type_url }),
                ),
                Authorization::Generic { msg_type_url } if msg_type_url == MSG_EXEC => (
                    format!("{g} could use every permission other accounts gave you{u}."),
                    json!({ "msg_type_url": msg_type_url }),
                ),
                Authorization::Generic { msg_type_url } => (
                    format!("{g} could run {} messages as you{u}.", msg_name(msg_type_url)),
                    json!({ "msg_type_url": msg_type_url }),
                ),
                Authorization::Send {
                    spend_limit,
                    allow_list,
                } => (
                    format!(
                        "{g} could send your tokens up to a limit{}{u}.",
                        if allow_list.is_empty() {
                            ""
                        } else {
                            ", only to listed addresses"
                        }
                    ),
                    json!({ "spend_limit": spend_limit, "allow_list": allow_list }),
                ),
                Authorization::Unknown { type_url, .. } => (
                    format!(
                        "{g} gets a permission the wallet can't read ({}){u}.",
                        msg_name(type_url)
                    ),
                    json!({ "type_url": type_url }),
                ),
            };
            out.push(grant_finding(
                "authz_grant",
                message,
                json!({ "grantee": grantee, "expiration": expiration, "authorization": detail }),
            ));
        }
        Msg::AuthzExec { msgs, .. } => {
            out.push(finding(
                "authz_exec",
                Level::Info,
                "Uses permissions other accounts gave you.".into(),
                json!({ "messages": msgs.len() }),
            ));
            for inner in msgs {
                message(inner, signer, ctx, None, out);
            }
        }
        Msg::AuthzRevoke {
            grantee, msg_type_url, ..
        } => out.push(finding(
            "authz_revoke",
            Level::Info,
            format!(
                "Removes {}'s permission for {} messages.",
                short(grantee),
                msg_name(msg_type_url)
            ),
            json!({ "grantee": grantee, "msg_type_url": msg_type_url }),
        )),
        Msg::FeeGrant { grantee, allowance, .. } => {
            let (limit, expiration) = describe_allowance(allowance);
            out.push(grant_finding(
                "fee_grant",
                format!(
                    "{} could spend your tokens on fees{limit}{}.",
                    short(grantee),
                    until(expiration)
                ),
                json!({ "grantee": grantee }),
            ));
        }
        Msg::FeeRevoke { grantee, .. } => out.push(finding(
            "fee_revoke",
            Level::Info,
            format!("Removes {}'s fee allowance.", short(grantee)),
            json!({ "grantee": grantee }),
        )),
        Msg::SetWithdrawAddress {
            delegator,
            withdraw_address,
        } => {
            if !same(delegator, withdraw_address) {
                out.push(finding(
                    "withdraw_address",
                    Level::Red,
                    format!(
                        "Your staking rewards would go to {} from now on.",
                        short(withdraw_address)
                    ),
                    json!({ "withdraw_address": withdraw_address }),
                ));
            }
        }
        Msg::WithdrawRewards { .. } => {}
        Msg::TokenfactoryChangeAdmin {
            sender,
            denom,
            new_admin,
            ..
        } => {
            if new_admin.is_empty() {
                out.push(finding(
                    "denom_admin",
                    Level::Red,
                    format!("Gives up control of {} for good.", ctx.token_name(denom)),
                    json!({ "denom": denom, "new_admin": new_admin }),
                ));
            } else if !same(sender, new_admin) {
                out.push(finding(
                    "denom_admin",
                    Level::Red,
                    format!("Hands control of {} to {}.", ctx.token_name(denom), short(new_admin)),
                    json!({ "denom": denom, "new_admin": new_admin }),
                ));
            }
        }
        Msg::WasmUpdateAdmin {
            sender,
            contract,
            new_admin,
        } => {
            if !same(sender, new_admin) {
                out.push(finding(
                    "contract_admin",
                    Level::Red,
                    format!("Hands control of contract {} to {}.", short(contract), short(new_admin)),
                    json!({ "contract": contract, "new_admin": new_admin }),
                ));
            }
        }
        Msg::WasmClearAdmin { contract, .. } => out.push(finding(
            "contract_admin",
            Level::Red,
            format!("Removes the admin of contract {} for good.", short(contract)),
            json!({ "contract": contract }),
        )),
        Msg::Unknown { type_url, .. } | Msg::UnknownJson { type_url, .. } => out.push(finding(
            "unknown_message",
            Level::Red,
            format!(
                "The wallet can't read this {} message. Only sign if you trust the site.",
                msg_name(type_url)
            ),
            json!({ "type_url": type_url }),
        )),
    }
}

/// Spend limit wording and expiry of a fee allowance.
fn describe_allowance(a: &Allowance) -> (&'static str, Option<i64>) {
    match a {
        Allowance::Basic {
            spend_limit,
            expiration,
        } => (
            if spend_limit.is_empty() {
                " with no limit"
            } else {
                " up to a limit"
            },
            *expiration,
        ),
        Allowance::Periodic { basic, .. } => (" up to a limit per period", describe_allowance(basic).1),
        Allowance::AllowedMsgs { inner, .. } => {
            let (_, e) = describe_allowance(inner);
            (" for some message types", e)
        }
        Allowance::Unknown { .. } => (" under terms the wallet can't read", None),
    }
}

/// CW20 `increase_allowance`.
fn allowance(ctx: &Context, token: &str, spender: &str, amount: &str, expires: Option<&str>) -> Finding {
    let amount_u = U256::from_dec_str(amount).unwrap_or(U256::MAX);
    let params = json!({ "token": token, "spender": spender, "amount": amount, "expires": expires });
    let s = short(spender);
    if amount_u >= UNLIMITED {
        finding(
            "unlimited_allowance",
            Level::Red,
            format!("{s} could take ALL of this token, now and later."),
            params,
        )
    } else if balance(ctx, token).is_some_and(|b| amount_u > b) {
        finding(
            "allowance_over_balance",
            Level::Red,
            format!("{s} could take more of this token than you hold now."),
            params,
        )
    } else {
        finding(
            "allowance",
            Level::Amber,
            format!("{s} could spend this token up to the amount shown."),
            params,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
    const OTHER: &str = "inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8";
    /// The mainnet CW20 adapter (a published contract).
    const ADAPTER: &str = "inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk";

    fn grade(msgs: &[Msg]) -> Assessment {
        cosmos(msgs, ME, CosmosFee::default(), &Context::default())
    }

    fn rules(a: &Assessment) -> Vec<&'static str> {
        a.findings.iter().map(|f| f.rule).collect()
    }

    #[test]
    fn plain_send_is_quiet() {
        let a = grade(&[Msg::BankSend {
            from: ME.into(),
            to: OTHER.into(),
            amount: vec![Coin::new("inj", "1").unwrap()],
        }]);
        assert_eq!((a.level, a.findings.len()), (Level::Info, 0));
    }

    #[test]
    fn grants_are_red_and_need_typing() {
        let a = grade(&[Msg::AuthzGrant {
            granter: ME.into(),
            grantee: OTHER.into(),
            authorization: Authorization::Generic {
                msg_type_url: MSG_SEND.into(),
            },
            expiration: None,
        }]);
        assert_eq!((a.level, a.confirm), (Level::Red, Some("GRANT")));
        assert_eq!(
            a.findings[0].message,
            "inj1d7…z8h8 could send ALL your tokens, with no end date."
        );

        let a = grade(&[Msg::FeeGrant {
            granter: ME.into(),
            grantee: OTHER.into(),
            allowance: Allowance::Basic {
                spend_limit: vec![],
                expiration: Some(1_794_096_000),
            },
        }]);
        assert_eq!(a.confirm, Some("GRANT"));
        assert_eq!(
            a.findings[0].message,
            "inj1d7…z8h8 could spend your tokens on fees with no limit, until 2026-11-08."
        );
    }

    #[test]
    fn handing_over_control_is_red() {
        for m in [
            Msg::SetWithdrawAddress {
                delegator: ME.into(),
                withdraw_address: OTHER.into(),
            },
            Msg::TokenfactoryChangeAdmin {
                type_url: "/injective.tokenfactory.v1beta1.MsgChangeAdmin".into(),
                sender: ME.into(),
                denom: format!("factory/{ME}/x"),
                new_admin: String::new(),
            },
            Msg::WasmUpdateAdmin {
                sender: ME.into(),
                contract: OTHER.into(),
                new_admin: OTHER.into(),
            },
            Msg::WasmClearAdmin {
                sender: ME.into(),
                contract: OTHER.into(),
            },
        ] {
            assert_eq!(grade(std::slice::from_ref(&m)).level, Level::Red, "{m:?}");
        }
        // Pointing rewards back at yourself is fine.
        let a = grade(&[Msg::SetWithdrawAddress {
            delegator: ME.into(),
            withdraw_address: ME.into(),
        }]);
        assert_eq!(a.level, Level::Info);
    }

    #[test]
    fn unknown_messages_are_red_even_inside_exec() {
        let unknown = Msg::Unknown {
            type_url: "/cosmos.gov.v1beta1.MsgVote".into(),
            value: vec![],
        };
        let a = grade(&[Msg::AuthzExec {
            grantee: ME.into(),
            msgs: vec![unknown],
        }]);
        assert_eq!(a.level, Level::Red);
        assert_eq!(rules(&a), ["unknown_message", "authz_exec"]);
    }

    #[test]
    fn cw20_send_notes_unknown_contracts_only() {
        let send = Msg::ExecuteContract {
            sender: ME.into(),
            contract: OTHER.into(),
            funds: vec![],
            json: String::new(),
            call: ContractCall::Cw20Send {
                contract: ADAPTER.into(),
                amount: "5".into(),
                msg: String::new(),
            },
        };
        assert_eq!(rules(&grade(std::slice::from_ref(&send))), ["cw20_send"]);
        let ctx = Context {
            known_contracts: vec![ADAPTER.into()],
            balances: [(OTHER.to_owned(), "5".to_owned())].into(),
            ..Default::default()
        };
        let a = cosmos(&[send], ME, CosmosFee::default(), &ctx);
        // No note about the contract; spending the whole balance is still said.
        assert!(!rules(&a).contains(&"cw20_send"), "{:?}", rules(&a));
    }

    #[test]
    fn cw20_allowances() {
        let call = |amount: &str| Msg::ExecuteContract {
            sender: ME.into(),
            contract: OTHER.into(),
            funds: vec![],
            json: String::new(),
            call: ContractCall::Cw20IncreaseAllowance {
                spender: ME.into(),
                amount: amount.into(),
                expires: None,
            },
        };
        assert_eq!(
            rules(&grade(&[call("340282366920938463463374607431768211455")])),
            ["unlimited_allowance"]
        );
        assert_eq!(grade(&[call("5")]).level, Level::Amber);
        let ctx = Context {
            balances: [(OTHER.to_owned(), "4".to_owned())].into(),
            ..Default::default()
        };
        let a = cosmos(&[call("5")], ME, CosmosFee::default(), &ctx);
        assert_eq!(rules(&a), ["allowance_over_balance"]);
    }

    #[test]
    fn balance_and_site_rules_use_the_context() {
        let ctx = Context {
            origin: Some("https://example.org".into()),
            balances: [("inj".to_owned(), "100".to_owned())].into(),
            symbols: [("inj".to_owned(), "INJ".to_owned())].into(),
            ..Default::default()
        };
        let fee = [Coin::new("inj", "10").unwrap()];
        let send = Msg::BankSend {
            from: ME.into(),
            to: OTHER.into(),
            amount: vec![Coin::new("inj", "45").unwrap()],
        };
        // 45 sent plus a 10 fee is more than half.
        let a = cosmos(
            std::slice::from_ref(&send),
            ME,
            CosmosFee {
                amount: &fee,
                ..Default::default()
            },
            &ctx,
        );
        assert_eq!(rules(&a), ["site_new", "most_of_balance"]);
        // Messages name tokens by the host's symbols.
        assert_eq!(a.findings[1].message, "Sends more than half of this account's INJ.");
        // A fee grant pays the fee, so only the send counts.
        let a = cosmos(
            &[send],
            ME,
            CosmosFee {
                amount: &fee,
                granter: Some(OTHER),
                payer: None,
            },
            &Context {
                origin_known: true,
                ..ctx
            },
        );
        assert_eq!(rules(&a), ["fee_grant_used"]);
        let blocked = Context {
            origin: Some("https://bad.example".into()),
            origin_blocked: true,
            ..Default::default()
        };
        assert_eq!(cosmos(&[], ME, CosmosFee::default(), &blocked).level, Level::Blocked);
    }
}
