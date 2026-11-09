//! Rules for Cosmos messages, whichever sign path decoded them.

use choice_wallet_cosmos::cosmwasm::ContractCall;
use choice_wallet_cosmos::msg::{Allowance, Authorization, Coin, Msg};
use choice_wallet_evm::U256;
use serde_json::json;

use crate::addresses::{known_contract, own_name, recipient, same};
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

/// Grade a Cosmos transaction's messages, signed by `signer` (its bech32 address), with
/// its memo.
pub fn cosmos(messages: &[Msg], signer: &str, memo: &str, fee: CosmosFee, ctx: &Context) -> Assessment {
    let mut out = site(ctx);
    let mut outflows = Outflows::default();
    for m in messages {
        message(m, signer, memo, ctx, Some(&mut outflows), &mut out);
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
fn message(
    m: &Msg,
    signer: &str,
    memo: &str,
    ctx: &Context,
    mut outflows: Option<&mut Outflows>,
    out: &mut Vec<Finding>,
) {
    match m {
        Msg::BankSend { from, to, amount } => {
            recipient(ctx, to, Some(memo), out);
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
                    recipient(ctx, to, Some(memo), out);
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
                ContractCall::Cw20DecreaseAllowance { spender, amount } => out.push(finding(
                    "allowance_decrease",
                    Level::Info,
                    format!("Lowers {}'s allowance for this token.", short(spender)),
                    json!({ "token": contract, "spender": spender, "amount": amount }),
                )),
                ContractCall::NftTransfer {
                    recipient: to,
                    token_id,
                } => {
                    recipient(ctx, to, Some(memo), out);
                    out.push(finding(
                        "nft_send",
                        Level::Info,
                        format!(
                            "Gives NFT {} of collection {} to {}.",
                            nft_name(token_id),
                            short(contract),
                            short(to)
                        ),
                        json!({ "collection": contract, "token_id": token_id, "to": to }),
                    ));
                }
                ContractCall::NftSend {
                    contract: to, token_id, ..
                } => out.push(finding(
                    "nft_send_contract",
                    Level::Info,
                    format!(
                        "Gives NFT {} to contract {}, which runs its own code with it.",
                        nft_name(token_id),
                        short(to)
                    ),
                    json!({ "collection": contract, "token_id": token_id, "to": to }),
                )),
                ContractCall::NftApprove {
                    spender,
                    token_id,
                    expires,
                } => out.push(finding(
                    "nft_approval",
                    Level::Amber,
                    format!(
                        "{} could take NFT {} of this collection{}.",
                        short(spender),
                        nft_name(token_id),
                        cw_until(expires.as_deref())
                    ),
                    json!({ "collection": contract, "spender": spender, "token_id": token_id, "expires": expires }),
                )),
                ContractCall::NftApproveAll { operator, expires } => out.push(finding(
                    "nft_approval_all",
                    Level::Red,
                    format!(
                        "{} could take ALL your NFTs in collection {}{}.",
                        short(operator),
                        short(contract),
                        cw_until(expires.as_deref())
                    ),
                    json!({ "collection": contract, "operator": operator, "expires": expires }),
                )),
                ContractCall::NftRevoke { spender, token_id } => out.push(finding(
                    "nft_approval_revoke",
                    Level::Info,
                    match token_id {
                        Some(id) => format!("Takes back {}'s approval for NFT {}.", short(spender), nft_name(id)),
                        None => format!("Takes back {}'s approval for this whole collection.", short(spender)),
                    },
                    json!({ "collection": contract, "spender": spender, "token_id": token_id }),
                )),
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
                message(inner, signer, memo, ctx, None, out);
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
            if let Some(own) = own_name(ctx, grantee) {
                // Gas for the user's own account (a rescue setup): it spends this account's
                // INJ, so it's said, but it's not someone else's hand in it.
                out.push(finding(
                    "fee_grant_own",
                    Level::Amber,
                    format!("Lets {own} pay its fees from this account{limit}{}.", until(expiration)),
                    json!({ "grantee": grantee }),
                ));
                return;
            }
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
            if same(delegator, withdraw_address) {
                // Rewards to the account itself: nothing to say.
            } else if let Some(own) = own_name(ctx, withdraw_address) {
                out.push(finding(
                    "withdraw_address_own",
                    Level::Info,
                    format!("Your staking rewards go to {own} from now on."),
                    json!({ "withdraw_address": withdraw_address }),
                ));
            } else {
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
        // Staking keeps the coins the signer's: not outflows, so no "most of your balance".
        Msg::WithdrawRewards { .. } | Msg::Redelegate { .. } | Msg::CancelUnbonding { .. } => {}
        Msg::Delegate { validator, amount, .. } => out.push(finding(
            "stake",
            Level::Info,
            "Unstaking it later takes the unbonding period.".into(),
            json!({ "validator": validator, "amount": amount }),
        )),
        Msg::Undelegate { validator, amount, .. } => out.push(finding(
            "unstake",
            Level::Info,
            "Starts unstaking; it returns after the unbonding period.".into(),
            json!({ "validator": validator, "amount": amount }),
        )),
        Msg::TransferDelegation {
            delegator,
            validator,
            receiver,
            amount,
        } => {
            if let Some(own) = own_name(ctx, receiver) {
                out.push(finding(
                    "transfer_stake_own",
                    Level::Info,
                    format!(
                        "Moves {} of your stake to {own}, at once.",
                        ctx.token_name(amount.denom())
                    ),
                    json!({ "validator": validator, "receiver": receiver, "amount": amount }),
                ));
            } else if !same(delegator, receiver) {
                out.push(finding(
                    "transfer_stake",
                    Level::Red,
                    format!(
                        "Gives {} of your stake to {}.",
                        ctx.token_name(amount.denom()),
                        short(receiver)
                    ),
                    json!({ "validator": validator, "receiver": receiver, "amount": amount }),
                ));
            }
        }
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
        Msg::ExchangeWithdraw {
            sender,
            subaccount_id,
            amount,
        } => {
            // `0x` + the owner's address + a 12-byte nonce.
            let owner = format!("0x{}", subaccount_id.get(2..42).unwrap_or(""));
            let nonce = u128::from_str_radix(subaccount_id.get(42..).unwrap_or(""), 16).unwrap_or(0);
            // The review shows the amount in the token's units; the sentence names the token.
            let what = ctx.token_name(amount.denom());
            out.push(if same(sender, &owner) {
                finding(
                    "exchange_withdraw",
                    Level::Info,
                    format!("Moves {what} from trading account {nonce} to this account's balance."),
                    json!({ "subaccount_id": subaccount_id, "amount": amount }),
                )
            } else {
                finding(
                    "exchange_withdraw_other",
                    Level::Amber,
                    format!(
                        "Moves {what} out of another account's trading account {}.",
                        short(&owner)
                    ),
                    json!({ "subaccount_id": subaccount_id, "amount": amount }),
                )
            });
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
/// An NFT's ID as a sentence names it: `#7`, or a long one cut short.
fn nft_name(id: &str) -> String {
    let short: String = id.chars().take(24).collect();
    if short.len() < id.len() {
        format!("#{short}…")
    } else {
        format!("#{short}")
    }
}

/// The end of a CosmWasm approval (`{"at_time":"<ns>"}`, `{"at_height":n}`, `{"never":{}}`),
/// as a sentence ends with it.
fn cw_until(expires: Option<&str>) -> String {
    let v = expires.and_then(|e| serde_json::from_str::<serde_json::Value>(e).ok());
    if let Some(ns) = v
        .as_ref()
        .and_then(|v| v["at_time"].as_str())
        .and_then(|t| t.parse::<u128>().ok())
    {
        return i64::try_from(ns / 1_000_000_000)
            .map_or_else(|_| ", with no end date".into(), |t| format!(", until {}", date(t)));
    }
    if let Some(h) = v.as_ref().and_then(|v| v["at_height"].as_u64()) {
        return format!(", until block {h}");
    }
    ", with no end date".into()
}

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
        cosmos(msgs, ME, "", CosmosFee::default(), &Context::default())
    }

    fn exec(contract: &str, call: ContractCall) -> Msg {
        Msg::ExecuteContract {
            sender: ME.into(),
            contract: contract.into(),
            funds: vec![],
            json: String::new(),
            call,
        }
    }

    #[test]
    fn nfts() {
        let give = grade(&[exec(
            ADAPTER,
            ContractCall::NftTransfer {
                recipient: OTHER.into(),
                token_id: "7".into(),
            },
        )]);
        assert_eq!((give.level, give.findings[0].rule), (Level::Info, "nft_send"));
        assert_eq!(
            give.findings[0].message,
            "Gives NFT #7 of collection inj14e…neuk to inj1d7…z8h8."
        );
        let all = grade(&[exec(
            ADAPTER,
            ContractCall::NftApproveAll {
                operator: OTHER.into(),
                expires: None,
            },
        )]);
        assert_eq!((all.level, all.findings[0].rule), (Level::Red, "nft_approval_all"));
        assert!(
            all.findings[0].message.ends_with("with no end date."),
            "{}",
            all.findings[0].message
        );
        let one = grade(&[exec(
            ADAPTER,
            ContractCall::NftApprove {
                spender: OTHER.into(),
                token_id: "7".into(),
                expires: Some(r#"{"at_height":100}"#.into()),
            },
        )]);
        assert_eq!((one.level, one.findings[0].rule), (Level::Amber, "nft_approval"));
        assert!(one.findings[0].message.ends_with("until block 100."));
        let back = grade(&[exec(
            ADAPTER,
            ContractCall::NftRevoke {
                spender: OTHER.into(),
                token_id: None,
            },
        )]);
        assert_eq!(
            (back.level, back.findings[0].rule),
            (Level::Info, "nft_approval_revoke")
        );
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
    fn a_rescue_to_your_own_addresses_is_named_not_red() {
        let ctx = |rescue: bool| Context {
            address_book: vec![crate::Contact {
                address: OTHER.into(),
                name: if rescue { String::new() } else { "Vault".into() },
                mine: !rescue,
                rescue,
                ..Default::default()
            }],
            ..Default::default()
        };
        let msgs = [
            Msg::SetWithdrawAddress {
                delegator: ME.into(),
                withdraw_address: OTHER.into(),
            },
            Msg::TransferDelegation {
                delegator: ME.into(),
                validator: "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q".into(),
                receiver: OTHER.into(),
                amount: Coin::new("inj", "5").unwrap(),
            },
        ];
        let a = cosmos(&msgs, ME, "", CosmosFee::default(), &ctx(true));
        assert_eq!(a.level, Level::Info);
        let rules: Vec<_> = a.findings.iter().map(|f| f.rule).collect();
        assert_eq!(rules, ["withdraw_address_own", "transfer_stake_own"]);
        assert_eq!(
            a.findings[0].message,
            "Your staking rewards go to your rescue address from now on."
        );
        // Gas for your own account: said, amber, no word to type.
        let g = cosmos(
            &[Msg::FeeGrant {
                granter: ME.into(),
                grantee: OTHER.into(),
                allowance: Allowance::Basic {
                    spend_limit: vec![Coin::new("inj", "500000000000000000").unwrap()],
                    expiration: None,
                },
            }],
            ME,
            "",
            CosmosFee::default(),
            &ctx(false),
        );
        assert_eq!(
            (g.level, g.confirm, g.findings[0].rule),
            (Level::Amber, None, "fee_grant_own")
        );
        assert!(
            g.findings[0]
                .message
                .starts_with("Lets your account Vault pay its fees from this account"),
            "{}",
            g.findings[0].message
        );
        // Anyone else: still red.
        assert_eq!(grade(&msgs[..1]).level, Level::Red);
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
    fn staking_keeps_the_coins_yours() {
        const VAL: &str = "injvaloper1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn4kx8jx";
        let inj = |a: &str| Coin::new("inj", a).unwrap();
        // Staking all you hold is normal: no "most of your balance".
        let ctx = Context {
            balances: [("inj".to_owned(), "10".to_owned())].into(),
            ..Context::default()
        };
        let all = cosmos(
            &[Msg::Delegate {
                delegator: ME.into(),
                validator: VAL.into(),
                amount: inj("10"),
            }],
            ME,
            "",
            CosmosFee::default(),
            &ctx,
        );
        assert_eq!((all.level, rules(&all)), (Level::Info, vec!["stake"]));
        let a = grade(&[
            Msg::Undelegate {
                delegator: ME.into(),
                validator: VAL.into(),
                amount: inj("5"),
            },
            Msg::Redelegate {
                delegator: ME.into(),
                from_validator: VAL.into(),
                to_validator: VAL.into(),
                amount: inj("5"),
            },
            Msg::WithdrawRewards {
                delegator: ME.into(),
                validator: VAL.into(),
            },
        ]);
        assert_eq!((a.level, rules(&a)), (Level::Info, vec!["unstake"]));
        // Giving your stake to someone else is red; to yourself, nothing to say.
        let give = |receiver: &str| {
            grade(&[Msg::TransferDelegation {
                delegator: ME.into(),
                validator: VAL.into(),
                receiver: receiver.into(),
                amount: inj("5"),
            }])
        };
        assert_eq!(
            (give(OTHER).level, rules(&give(OTHER))),
            (Level::Red, vec!["transfer_stake"])
        );
        assert!(rules(&give(ME)).is_empty());
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
        let a = cosmos(&[send], ME, "", CosmosFee::default(), &ctx);
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
        let a = cosmos(&[call("5")], ME, "", CosmosFee::default(), &ctx);
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
            "",
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
            "",
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
        assert_eq!(
            cosmos(&[], ME, "", CosmosFee::default(), &blocked).level,
            Level::Blocked
        );
    }
}
