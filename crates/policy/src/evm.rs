//! Rules for EVM transactions, including calls to Injective's precompiles, which change
//! Cosmos-side state (grants, orderbook funds, stakes) that an EVM state diff doesn't show.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::request::{Call, TxRequest};
use serde_json::json;

use crate::addresses::{known_contract, recipient};
use crate::amounts::{Outflows, UNLIMITED, balance};
use crate::text::short;
use crate::{Assessment, Context, Finding, Level, finding, site};

/// Injective precompiles.
const BANK: u8 = 0x64;
const EXCHANGE: u8 = 0x65;
const STAKING: u8 = 0x66;
const ORACLE: u8 = 0x67;

/// A precompile method: selector, canonical signature (checked in tests), level, and what it
/// does. Signatures from injective-core v1.20.3's precompile bindings; selectors computed by
/// viem.
struct Method {
    selector: [u8; 4],
    signature: &'static str,
    level: Level,
    what: &'static str,
}

const fn m(selector: u32, signature: &'static str, level: Level, what: &'static str) -> Method {
    Method {
        selector: selector.to_be_bytes(),
        signature,
        level,
        what,
    }
}

/// Exchange precompile approve: creates authz grants for the INJ orderbook.
const EXCHANGE_APPROVE: [u8; 4] = 0xd7ca8d06u32.to_be_bytes();

const EXCHANGE_METHODS: &[Method] = &[
    m(
        0xd7ca8d06,
        "approve(address,(uint8,(uint256,string)[],uint256)[])",
        Level::Red,
        "",
    ),
    m(
        0x3f79e2b1,
        "revoke(address,uint8[])",
        Level::Info,
        "Removes INJ orderbook permissions.",
    ),
    m(
        0xe441dec9,
        "deposit(address,string,string,uint256)",
        Level::Info,
        "Moves funds into your INJ orderbook account.",
    ),
    m(
        0xeb28c205,
        "withdraw(address,string,string,uint256)",
        Level::Info,
        "Moves funds from your INJ orderbook account to your wallet.",
    ),
    m(
        0x42eba2ed,
        "subaccountTransfer(address,string,string,string,uint256)",
        Level::Info,
        "Moves funds between your INJ orderbook subaccounts.",
    ),
    m(
        0xc01307d2,
        "externalTransfer(address,string,string,string,uint256)",
        Level::Amber,
        "Sends funds from your INJ orderbook account to another account.",
    ),
    m(
        0x8ff96af4,
        "increasePositionMargin(address,string,string,string,uint256)",
        Level::Info,
        "Adds margin to a position.",
    ),
    m(
        0xaf78360b,
        "decreasePositionMargin(address,string,string,string,uint256)",
        Level::Info,
        "Takes margin out of a position.",
    ),
    m(
        0xf642485e,
        "createSpotLimitOrder(address,(string,string,string,uint256,uint256,string,string,uint256))",
        Level::Amber,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x29d3d0e4,
        "createSpotMarketOrder(address,(string,string,string,uint256,uint256,string,string,uint256))",
        Level::Amber,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x4881c7c6,
        "batchCreateSpotLimitOrders(address,(string,string,string,uint256,uint256,string,string,uint256)[])",
        Level::Amber,
        "Places orders on the INJ orderbook.",
    ),
    m(
        0x25bf6b92,
        "cancelSpotOrder(address,string,string,string,string)",
        Level::Info,
        "Cancels an order.",
    ),
    m(
        0x438051ab,
        "batchCancelSpotOrders(address,(string,string,string,int32,string)[])",
        Level::Info,
        "Cancels orders.",
    ),
    m(
        0x20c69837,
        "createDerivativeLimitOrder(address,(string,string,string,uint256,uint256,string,string,uint256,uint256))",
        Level::Amber,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0xb84857a1,
        "createDerivativeMarketOrder(address,(string,string,string,uint256,uint256,string,string,uint256,uint256))",
        Level::Amber,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x79374eab,
        "batchCreateDerivativeLimitOrders(address,(string,string,string,uint256,uint256,string,string,uint256,uint256)[])",
        Level::Amber,
        "Places orders on the INJ orderbook.",
    ),
    m(
        0x44b9bf3a,
        "cancelDerivativeOrder(address,string,string,string,int32,string)",
        Level::Info,
        "Cancels an order.",
    ),
    m(
        0x8b073525,
        "batchCancelDerivativeOrders(address,(string,string,string,int32,string)[])",
        Level::Info,
        "Cancels orders.",
    ),
    m(
        0xcb0b6590,
        "batchUpdateOrders(address,(string,string[],(string,string,string,int32,string)[],(string,string,string,uint256,uint256,string,string,uint256)[],string[],(string,string,string,int32,string)[],(string,string,string,uint256,uint256,string,string,uint256,uint256)[]))",
        Level::Amber,
        "Places and cancels orders on the INJ orderbook.",
    ),
];

const STAKING_METHODS: &[Method] = &[
    m(
        0x03f24de1,
        "delegate(string,uint256)",
        Level::Info,
        "Stakes INJ with a validator.",
    ),
    m(
        0x8dfc8897,
        "undelegate(string,uint256)",
        Level::Info,
        "Starts unstaking; the INJ returns after the unbonding period.",
    ),
    m(
        0x7dd0209d,
        "redelegate(string,string,uint256)",
        Level::Info,
        "Moves a stake to another validator.",
    ),
    m(
        0x6636125e,
        "withdrawDelegatorRewards(string)",
        Level::Info,
        "Claims staking rewards.",
    ),
];

const APPROVE: [u8; 4] = 0x095ea7b3u32.to_be_bytes();
const INCREASE_ALLOWANCE: [u8; 4] = 0x39509351u32.to_be_bytes();
const SET_APPROVAL_FOR_ALL: [u8; 4] = 0xa22cb465u32.to_be_bytes();
/// Permit2 `approve(address token, address spender, uint160 amount, uint48 expiration)`.
const PERMIT2_APPROVE: [u8; 4] = 0x87517c45u32.to_be_bytes();

/// 32-byte argument `i` after the selector.
fn word(data: &[u8], i: usize) -> Option<&[u8]> {
    data.get(4 + 32 * i..4 + 32 * (i + 1))
}

fn address_arg(data: &[u8], i: usize) -> Option<EthAddress> {
    let w = word(data, i)?;
    w[..12]
        .iter()
        .all(|&b| b == 0)
        .then(|| EthAddress::from_bytes(w[12..].try_into().expect("20 bytes")))
}

fn uint_arg(data: &[u8], i: usize) -> Option<U256> {
    Some(U256::from_be_bytes(word(data, i)?.try_into().ok()?))
}

/// The precompile at `to`, if it's one of Injective's system addresses (0x…00 to 0x…ff).
fn system_address(to: &EthAddress) -> Option<u8> {
    let b = to.as_bytes();
    b[..19].iter().all(|&x| x == 0).then_some(b[19])
}

/// Grade an EVM transaction. `injective` says the chain is Injective EVM, where the
/// precompiles exist.
pub fn evm_transaction(req: &TxRequest, injective: bool, ctx: &Context) -> Assessment {
    let tx = &req.tx;
    let to = tx.to.to_checksum_hex();
    let mut out = site(ctx);
    let mut outflows = Outflows::default();
    if !tx.value.is_zero() {
        outflows.add("native", tx.value);
    }
    match tx.call_kind() {
        Call::Transfer => recipient(ctx, &to, &mut out),
        Call::Erc20Transfer { to: r, amount } => {
            recipient(ctx, &r.to_checksum_hex(), &mut out);
            outflows.add(&to, amount);
        }
        Call::Contract { selector } => contract_call(req, selector, injective, ctx, &mut out),
    }
    outflows.check(ctx, &mut out);
    // The amount plus the most gas could cost, against the native balance.
    if let Some(bal) = balance(ctx, "native") {
        let max_gas = U256::product(u128::from(tx.gas_limit), tx.max_fee_per_gas);
        if tx.value.checked_add(&max_gas).is_none_or(|need| need > bal) {
            out.push(finding(
                "gas_over_balance",
                Level::Amber,
                "The amount plus the maximum fee is more than this account holds.".into(),
                json!({ "value": tx.value.to_string(), "max_gas_cost": max_gas.to_string(), "balance": bal.to_string() }),
            ));
        }
    }
    Assessment::from(out)
}

fn contract_call(req: &TxRequest, selector: Option<[u8; 4]>, injective: bool, ctx: &Context, out: &mut Vec<Finding>) {
    let tx = &req.tx;
    let data = tx.data.as_slice();
    let to = tx.to.to_checksum_hex();
    if let Some(n) = system_address(&tx.to) {
        out.push(system_call(req, n, selector, injective));
        return;
    }
    let Some(sel) = selector else {
        out.push(finding(
            "short_calldata",
            Level::Amber,
            "Calls a contract with data too short to name a function.".into(),
            json!({ "to": to }),
        ));
        return;
    };
    match sel {
        APPROVE | INCREASE_ALLOWANCE if data.len() == 68 => {
            if let (Some(spender), Some(amount)) = (address_arg(data, 0), uint_arg(data, 1)) {
                out.push(erc20_allowance(
                    ctx,
                    &to,
                    &spender.to_checksum_hex(),
                    amount,
                    sel == APPROVE,
                ));
                return;
            }
        }
        SET_APPROVAL_FOR_ALL if data.len() == 68 => {
            if let (Some(operator), Some(flag)) = (address_arg(data, 0), uint_arg(data, 1)) {
                let operator = operator.to_checksum_hex();
                let params = json!({ "collection": to, "operator": operator });
                out.push(if flag.is_zero() {
                    finding(
                        "nft_approval_revoke",
                        Level::Info,
                        format!("Removes {}'s access to your NFTs in this collection.", short(&operator)),
                        params,
                    )
                } else {
                    finding(
                        "nft_approval_all",
                        Level::Red,
                        format!("{} could take ALL your NFTs in this collection.", short(&operator)),
                        params,
                    )
                });
                return;
            }
        }
        PERMIT2_APPROVE if data.len() == 4 + 4 * 32 => {
            if let (Some(token), Some(spender)) = (address_arg(data, 0), address_arg(data, 1)) {
                let spender = spender.to_checksum_hex();
                out.push(finding(
                    "permit2_allowance",
                    Level::Red,
                    format!("{} could spend your tokens through Permit2.", short(&spender)),
                    json!({ "permit2": to, "token": token.to_checksum_hex(), "spender": spender }),
                ));
                return;
            }
        }
        _ => {}
    }
    if !known_contract(ctx, &to) {
        out.push(finding(
            "new_contract",
            Level::Info,
            format!("First interaction with contract {}.", short(&to)),
            json!({ "contract": to }),
        ));
    }
}

fn erc20_allowance(ctx: &Context, token: &str, spender: &str, amount: U256, approve: bool) -> Finding {
    let s = short(spender);
    let params = json!({ "token": token, "spender": spender, "amount": amount.to_string() });
    if approve && amount.is_zero() {
        finding(
            "allowance_revoke",
            Level::Info,
            format!("Removes {s}'s allowance for this token."),
            params,
        )
    } else if amount >= UNLIMITED {
        finding(
            "unlimited_allowance",
            Level::Red,
            format!("{s} could take ALL of this token, now and later."),
            params,
        )
    } else if balance(ctx, token).is_some_and(|b| amount > b) {
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

fn system_call(req: &TxRequest, n: u8, selector: Option<[u8; 4]>, injective: bool) -> Finding {
    let to = req.tx.to.to_checksum_hex();
    let data = req.tx.data.as_slice();
    let params = |extra: serde_json::Value| {
        let mut p = json!({ "precompile": to, "selector": selector.map(u32::from_be_bytes) });
        if let (Some(p), Some(e)) = (p.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
        p
    };
    let unreadable = || {
        finding(
            "precompile_unknown",
            Level::Red,
            "Calls an Injective precompile in a way the wallet can't read.".into(),
            params(json!({})),
        )
    };
    if !injective {
        return finding(
            "system_address",
            Level::Amber,
            "Calls a system address, not a normal contract.".into(),
            params(json!({})),
        );
    }
    let table = match n {
        EXCHANGE => EXCHANGE_METHODS,
        STAKING => STAKING_METHODS,
        BANK => {
            return finding(
                "bank_precompile",
                Level::Amber,
                "Calls the bank precompile directly, which normally only token contracts do.".into(),
                params(json!({})),
            );
        }
        ORACLE => {
            return finding(
                "oracle_precompile",
                Level::Info,
                "Calls the oracle precompile.".into(),
                params(json!({})),
            );
        }
        _ => {
            return finding(
                "system_address",
                Level::Amber,
                "Calls a system address, not a normal contract.".into(),
                params(json!({})),
            );
        }
    };
    let Some(method) = selector.and_then(|s| table.iter().find(|m| m.selector == s)) else {
        return unreadable();
    };
    if method.selector == EXCHANGE_APPROVE {
        let Some(grantee) = address_arg(data, 0) else {
            return unreadable();
        };
        let grantee = grantee.to_checksum_hex();
        return Finding {
            confirm: Some("GRANT"),
            ..finding(
                "exchange_grant",
                Level::Red,
                format!(
                    "{} could trade and move funds in your INJ orderbook account.",
                    short(&grantee)
                ),
                params(json!({ "grantee": grantee })),
            )
        };
    }
    // Exchange methods name the account they act for first. Anything but the sender means
    // using a grant that account gave.
    if n == EXCHANGE
        && method.selector != 0x3f79e2b1u32.to_be_bytes()
        && address_arg(data, 0).is_some_and(|a| a != req.from)
    {
        let acting_for = address_arg(data, 0).expect("checked").to_checksum_hex();
        return finding(
            "exchange_for_other",
            Level::Amber,
            format!("Acts for {} using a permission it gave you.", short(&acting_for)),
            params(json!({ "for": acting_for, "method": method.signature })),
        );
    }
    finding(
        "precompile_call",
        method.level,
        method.what.into(),
        params(json!({ "method": method.signature })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use choice_wallet_core::secp256k1::keccak256;
    use choice_wallet_evm::{Eip1559Tx, erc20};

    #[test]
    fn selectors_match_their_signatures() {
        for m in EXCHANGE_METHODS.iter().chain(STAKING_METHODS) {
            assert_eq!(keccak256(m.signature.as_bytes())[..4], m.selector, "{}", m.signature);
        }
        for (sel, sig) in [
            (APPROVE, "approve(address,uint256)"),
            (INCREASE_ALLOWANCE, "increaseAllowance(address,uint256)"),
            (SET_APPROVAL_FOR_ALL, "setApprovalForAll(address,bool)"),
            (PERMIT2_APPROVE, "approve(address,address,uint160,uint48)"),
        ] {
            assert_eq!(keccak256(sig.as_bytes())[..4], sel, "{sig}");
        }
    }

    const FROM: [u8; 20] = [0xaa; 20];

    fn req(to: EthAddress, data: Vec<u8>) -> TxRequest {
        TxRequest {
            from: EthAddress::from_bytes(FROM),
            tx: Eip1559Tx {
                chain_id: 1776,
                nonce: 0,
                max_priority_fee_per_gas: 1,
                max_fee_per_gas: 1,
                gas_limit: 100_000,
                to,
                value: U256::ZERO,
                data,
            },
        }
    }

    fn call(selector: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
        let mut d = selector.to_vec();
        for w in words {
            d.extend_from_slice(w);
        }
        d
    }

    fn addr_word(a: [u8; 20]) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(&a);
        w
    }

    fn grade(r: &TxRequest) -> Assessment {
        evm_transaction(r, true, &Context::default())
    }

    fn precompile(n: u8) -> EthAddress {
        let mut b = [0u8; 20];
        b[19] = n;
        EthAddress::from_bytes(b)
    }

    #[test]
    fn approvals() {
        let token = EthAddress::from_bytes([0x11; 20]);
        let approve = |amount: U256| req(token, call(APPROVE, &[addr_word([0x22; 20]), amount.to_be_bytes()]));
        let a = grade(&approve(U256::MAX));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "unlimited_allowance"));
        assert_eq!(grade(&approve(U256::from_u128(5))).level, Level::Amber);
        assert_eq!(grade(&approve(U256::ZERO)).findings[0].rule, "allowance_revoke");

        let mut yes = [0u8; 32];
        yes[31] = 1;
        let a = grade(&req(token, call(SET_APPROVAL_FOR_ALL, &[addr_word([0x22; 20]), yes])));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "nft_approval_all"));

        // A plain transfer is just a send.
        let t = req(
            token,
            erc20::transfer_calldata(&EthAddress::from_bytes([0x22; 20]), &U256::from_u128(5)),
        );
        assert_eq!(grade(&t).findings.len(), 0);
    }

    #[test]
    fn precompiles() {
        // The exchange approve creates grants: red, typed confirmation.
        let a = grade(&req(
            precompile(EXCHANGE),
            call(EXCHANGE_APPROVE, &[addr_word([0x33; 20])]),
        ));
        assert_eq!(
            (a.level, a.confirm, a.findings[0].rule),
            (Level::Red, Some("GRANT"), "exchange_grant")
        );

        // A deposit for yourself is info; for someone else, it uses their grant.
        let deposit = 0xe441dec9u32.to_be_bytes();
        let a = grade(&req(precompile(EXCHANGE), call(deposit, &[addr_word(FROM)])));
        assert_eq!((a.level, a.findings[0].rule), (Level::Info, "precompile_call"));
        let a = grade(&req(precompile(EXCHANGE), call(deposit, &[addr_word([0x44; 20])])));
        assert_eq!(a.findings[0].rule, "exchange_for_other");

        // Unknown methods on a precompile are red; staking is readable.
        assert_eq!(grade(&req(precompile(EXCHANGE), vec![1, 2, 3, 4])).level, Level::Red);
        let a = grade(&req(precompile(STAKING), 0x03f24de1u32.to_be_bytes().to_vec()));
        assert_eq!(a.findings[0].message, "Stakes INJ with a validator.");
        assert_eq!(grade(&req(precompile(BANK), vec![0; 4])).level, Level::Amber);
        // Off Injective, a system address is just unusual.
        let a = evm_transaction(&req(precompile(EXCHANGE), vec![0; 4]), false, &Context::default());
        assert_eq!(a.findings[0].rule, "system_address");
    }

    #[test]
    fn value_and_gas_against_balance() {
        let mut r = req(EthAddress::from_bytes([0x55; 20]), vec![]);
        r.tx.value = U256::from_u128(60);
        let ctx = Context {
            balances: [("native".to_owned(), "100".to_owned())].into(),
            ..Default::default()
        };
        let rules: Vec<_> = evm_transaction(&r, true, &ctx)
            .findings
            .iter()
            .map(|f| f.rule)
            .collect();
        // 60 is over half; 60 + 100,000 gas at 1 wei is over the balance.
        assert_eq!(rules, ["most_of_balance", "gas_over_balance"]);
    }
}
