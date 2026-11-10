//! Rules for EVM transactions, including calls to Injective's precompiles, which change
//! Cosmos-side state (grants, orderbook funds, stakes) that an EVM state diff doesn't show.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::abi;
use choice_wallet_evm::request::{Call, TxRequest};
use choice_wallet_injective::cctp::{self, Cctp};
use choice_wallet_injective::chain::Network;
use choice_wallet_injective::choice;
use serde_json::json;

use crate::addresses::{known_contract, recipient};
use crate::amounts::{Outflows, UNLIMITED, balance};
use crate::text::short;
use crate::{Assessment, Context, Finding, Level, finding, site};
use crate::{bridge, swap};

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
/// ERC721 `safeTransferFrom(address,address,uint256)` and its `bytes` form.
pub(crate) const SAFE_TRANSFER_FROM: [u8; 4] = 0x42842e0eu32.to_be_bytes();
const SAFE_TRANSFER_FROM_DATA: [u8; 4] = 0xb88d4fdeu32.to_be_bytes();
/// `transferFrom(address,address,uint256)`: ERC20's and ERC721's alike.
const TRANSFER_FROM: [u8; 4] = 0x23b872ddu32.to_be_bytes();
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

/// The EVM chain a transaction is for, as the rules need it.
#[derive(Debug, Clone, Copy)]
pub struct EvmSide<'a> {
    /// The Injective network, when the chain is Injective EVM: its precompiles and Choice's
    /// swap contracts are there.
    pub injective: Option<&'a Network>,
    /// CCTP on the chain's network, and the chain as CCTP names it.
    pub cctp: Option<(&'a Cctp, &'a cctp::EvmChain)>,
}

impl<'a> EvmSide<'a> {
    /// Injective EVM on network `n`.
    pub fn injective(n: &'a Network) -> Self {
        Self {
            injective: Some(n),
            cctp: Some((&n.cctp, &n.cctp.evm[0])),
        }
    }
}

/// Grade an EVM transaction on `chain`.
pub fn evm_transaction(req: &TxRequest, chain: &EvmSide<'_>, ctx: &Context) -> Assessment {
    let tx = &req.tx;
    let to = tx.to.to_checksum_hex();
    let mut out = site(ctx);
    let mut outflows = Outflows::default();
    let network = chain.injective;
    let swapped = network.and_then(|n| choice::swap(&n.choice, &tx.to, tx.value, &tx.data));
    // A swap that pays this account trades value rather than giving it away: its input isn't
    // counted as leaving. Its findings say what comes back.
    let to_self = matches!(&swapped, Some(Ok(s)) if swap::to_self(s, &req.from));
    if !tx.value.is_zero() && !to_self {
        outflows.add("native", tx.value);
    }
    let bridged = chain.cctp.and_then(|(c, _)| cctp::burn(c, &tx.to, tx.value, &tx.data));
    let minted = chain
        .cctp
        .and_then(|(c, _)| cctp::receive(c, &tx.to, tx.value, &tx.data));
    match (&swapped, &bridged, &minted, network, chain.cctp) {
        (Some(read), _, _, Some(n), _) => swap::swap(&n.choice, &req.from, tx.value, read, &mut out),
        (_, Some(read), _, _, Some((c, local))) => {
            bridge::burn(c, local, &req.from, read, ctx, &mut out, &mut outflows);
        }
        (_, _, Some(read), _, Some((c, local))) => bridge::receive(c, local, &req.from, read, &mut out),
        _ => match tx.call_kind() {
            Call::Transfer => recipient(ctx, &to, None, &mut out),
            Call::Erc20Transfer { to: r, amount } => {
                recipient(ctx, &r.to_checksum_hex(), None, &mut out);
                outflows.add(&to, amount);
            }
            Call::Contract { selector } => contract_call(req, selector, chain, ctx, &mut out),
        },
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

fn contract_call(
    req: &TxRequest,
    selector: Option<[u8; 4]>,
    chain: &EvmSide<'_>,
    ctx: &Context,
    out: &mut Vec<Finding>,
) {
    let network = chain.injective;
    let tx = &req.tx;
    let data = tx.data.as_slice();
    let to = tx.to.to_checksum_hex();
    let choice = network.map(|n| &n.choice);
    if let Some(n) = system_address(&tx.to) {
        out.push(system_call(req, n, selector, network.is_some()));
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
                let named = network
                    .and_then(|n| swap::known_name(&n.choice, &spender))
                    .or_else(|| chain.cctp.and_then(|(c, _)| bridge::known_name(c, &spender)));
                out.push(erc20_allowance(
                    ctx,
                    &to,
                    &spender.to_checksum_hex(),
                    named,
                    amount,
                    sel == APPROVE,
                ));
                return;
            }
        }
        SAFE_TRANSFER_FROM | SAFE_TRANSFER_FROM_DATA | TRANSFER_FROM
            if data.len() == 4 + 3 * 32 || (sel == SAFE_TRANSFER_FROM_DATA && data.len() >= 4 + 4 * 32) =>
        {
            if let (Some(from), Some(dest), Some(id)) = (address_arg(data, 0), address_arg(data, 1), uint_arg(data, 2))
            {
                let dest_hex = dest.to_checksum_hex();
                let what = if sel == TRANSFER_FROM {
                    format!("tokens or NFT #{id} of contract {}", short(&to))
                } else {
                    format!("NFT #{id} of collection {}", short(&to))
                };
                let params = json!({ "collection": to, "from": from.to_checksum_hex(), "to": dest_hex, "token_id": id.to_string() });
                if from == req.from {
                    recipient(ctx, &dest_hex, None, out);
                    out.push(finding(
                        "nft_send",
                        Level::Info,
                        format!("Gives {what} to {}.", short(&dest_hex)),
                        params,
                    ));
                } else {
                    out.push(finding(
                        "transfer_from_other",
                        Level::Amber,
                        format!(
                            "Moves {what} out of {}, using its approval.",
                            short(&from.to_checksum_hex())
                        ),
                        params,
                    ));
                }
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
            let typed = |i: usize, bits: u32| {
                let w: [u8; 32] = word(data, i)?.try_into().ok()?;
                abi::Val::Word(w).uint_bits(bits).ok()
            };
            if let (Some(token), Some(spender), Some(amount), Some(expiration)) =
                (address_arg(data, 0), address_arg(data, 1), typed(2, 160), typed(3, 48))
            {
                let expiration = expiration.to_u64().expect("48 bits");
                out.push(swap::permit2_approve(choice, &token, &spender, amount, expiration));
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

pub(crate) fn erc20_allowance(
    ctx: &Context,
    token: &str,
    spender: &str,
    named: Option<&str>,
    amount: U256,
    approve: bool,
) -> Finding {
    let s = named.map_or_else(|| short(spender), str::to_owned);
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
    use choice_wallet_injective::chain::{MAINNET, TESTNET};

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
        evm_transaction(r, &EvmSide::injective(&MAINNET), &Context::default())
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
        let a = evm_transaction(
            &req(precompile(EXCHANGE), vec![0; 4]),
            &EvmSide {
                injective: None,
                cctp: None,
            },
            &Context::default(),
        );
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
        let rules: Vec<_> = evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx)
            .findings
            .iter()
            .map(|f| f.rule)
            .collect();
        // 60 is over half; 60 + 100,000 gas at 1 wei is over the balance.
        assert_eq!(rules, ["most_of_balance", "gas_over_balance"]);
    }

    fn route(name: &str) -> (EthAddress, U256, Vec<u8>, EthAddress) {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../injective/tests/choice_routes.json")).unwrap();
        let c = v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let hex = |k: &str| hex::decode(c[k].as_str().unwrap().trim_start_matches("0x")).unwrap();
        (
            EthAddress::from_bytes(hex("to").try_into().unwrap()),
            U256::from_dec_str(c["value"].as_str().unwrap()).unwrap(),
            hex("data"),
            EthAddress::parse_hex(c["api"]["recipient"].as_str().unwrap()).unwrap(),
        )
    }

    fn rules_of(a: &Assessment) -> Vec<&'static str> {
        a.findings.iter().map(|f| f.rule).collect()
    }

    #[test]
    fn choice_swaps() {
        let (to, value, data, recipient) = route("m-inj-usdt");
        let mut r = req(to, data.clone());
        r.tx.value = value;
        r.from = recipient;
        // All of this account's INJ into the swap: it pays this account, so nothing "leaves".
        let ctx = Context {
            balances: [("native".to_owned(), value.to_string())].into(),
            ..Context::default()
        };
        let a = evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx);
        // The gas is on top of a balance the swap takes whole; nothing about the swap itself.
        assert_eq!(rules_of(&a), ["gas_over_balance", "swap"]);
        assert_eq!(
            a.findings[1].params["token_in"],
            "0x0000000000000000000000000000000000000000"
        );
        assert_eq!(a.findings[1].params["minimum_out"], "8145811");
        // Signed by another account, the same route pays someone else.
        r.from = EthAddress::from_bytes(FROM);
        let a = grade(&r);
        assert_eq!(a.level, Level::Red);
        assert!(rules_of(&a).contains(&"swap_recipient"));
        // Testnet has no aggregator there: just a contract.
        let mut t = req(to, data);
        t.tx.chain_id = 1439;
        assert_eq!(
            rules_of(&evm_transaction(&t, &EvmSide::injective(&TESTNET), &Context::default())),
            ["new_contract"]
        );
        // Junk to the aggregator.
        assert_eq!(
            rules_of(&grade(&req(to, vec![0xdd, 0xab, 0x6e, 0x8d, 1]))),
            ["swap_unreadable"]
        );
        // The router: value it doesn't use.
        let (rt, _, rdata, _) = route("t-winj-usdt");
        let mut rr = req(rt, rdata);
        rr.tx.chain_id = 1439;
        rr.tx.value = U256::from_u128(1);
        let a = evm_transaction(&rr, &EvmSide::injective(&TESTNET), &Context::default());
        assert_eq!(rules_of(&a), ["swap_value", "swap"]);
    }

    #[test]
    fn permit2_and_choice_are_named() {
        let permit2 = MAINNET.choice.permit2();
        let aggregator = EthAddress::parse_hex(MAINNET.choice.aggregator.unwrap()).unwrap();
        let token = addr_word([0x11; 20]);
        let small = U256::from_u128(5_000_000).to_be_bytes();
        let soon = U256::from_u128(1_800_000_000).to_be_bytes();
        let p2 = |amount: [u8; 32], exp: [u8; 32]| {
            req(
                permit2,
                call(
                    PERMIT2_APPROVE,
                    &[token, addr_word(*aggregator.as_bytes()), amount, exp],
                ),
            )
        };
        let a = grade(&p2(small, soon));
        assert_eq!((a.level, a.findings[0].rule), (Level::Amber, "permit2_limited"));
        assert!(
            a.findings[0]
                .message
                .starts_with("Choice's aggregator could spend this token through Permit2"),
            "{}",
            a.findings[0].message
        );
        let mut max160 = [0u8; 32];
        max160[12..].fill(0xff);
        assert_eq!(grade(&p2(max160, soon)).level, Level::Red);
        assert_eq!(grade(&p2([0; 32], soon)).findings[0].rule, "allowance_revoke");
        // Out of range for uint160: not read as an approval at all.
        assert!(rules_of(&grade(&p2([0xff; 32], soon))).contains(&"new_contract"));
        // An ERC20 approval to Permit2 names it.
        let a = grade(&req(
            EthAddress::from_bytes([0x11; 20]),
            call(APPROVE, &[addr_word(*permit2.as_bytes()), small]),
        ));
        assert_eq!(
            a.findings[0].message,
            "Permit2 could spend this token up to the amount shown."
        );
    }

    /// A burn on mainnet, built like the wallet's Bridge screen builds one.
    fn burn_req(domain: u32, recipient: [u8; 32], hook: cctp::Hook, max_fee: u128) -> TxRequest {
        let b = cctp::Burn {
            amount: U256::from_u128(25_000_000),
            domain,
            mint_recipient: recipient,
            burn_token: MAINNET.cctp.usdc(),
            destination_caller: [0; 32],
            max_fee: U256::from_u128(max_fee),
            min_finality: cctp::STANDARD,
            hook,
        };
        req(MAINNET.cctp.token_messenger(), cctp::burn_calldata(&b))
    }

    #[test]
    fn cctp_bridges() {
        let me = addr_word(FROM);
        // To this account's own address on Base, delivered by Circle: nothing to warn about.
        let a = grade(&burn_req(6, me, cctp::Hook::Forward, 200_000));
        assert_eq!(rules_of(&a), ["bridge", "bridge_to_self", "bridge_forward"]);
        assert_eq!(a.level, Level::Info);
        assert_eq!(a.findings[0].params["chain"], "Base");
        assert_eq!(
            a.findings[0].params["recipient"],
            EthAddress::from_bytes(FROM).to_checksum_hex()
        );
        // Someone else's address there.
        let other = grade(&burn_req(6, addr_word([0x33; 20]), cctp::Hook::Forward, 200_000));
        assert_eq!(other.level, Level::Amber);
        assert!(rules_of(&other).contains(&"bridge_recipient"));
        // Solana: the owner Circle opens the account for is the one named, when the account
        // is that owner's USDC account; otherwise the account paid, with a warning.
        let ata = choice_wallet_solana::pda::associated_token_address(
            &[9; 32],
            &MAINNET.cctp.solana.usdc_mint(),
            &choice_wallet_solana::program::TOKEN.key(),
        );
        let sol = grade(&burn_req(
            5,
            ata,
            cctp::Hook::ForwardWithAccount { owner: [9; 32] },
            300_000,
        ));
        let named = sol.findings.iter().find(|f| f.rule == "bridge_recipient").unwrap();
        assert_eq!(named.params["recipient"], cctp::base58(&[9; 32]));
        assert!(!rules_of(&sol).contains(&"bridge_solana_account"));
        let elsewhere = grade(&burn_req(
            5,
            [7; 32],
            cctp::Hook::ForwardWithAccount { owner: [9; 32] },
            300_000,
        ));
        let named = elsewhere
            .findings
            .iter()
            .find(|f| f.rule == "bridge_recipient")
            .unwrap();
        assert_eq!(named.params["recipient"], cctp::base58(&[7; 32]));
        assert!(rules_of(&elsewhere).contains(&"bridge_solana_account"));
        // Nobody delivers; a chain Circle doesn't forward to; an unknown domain; an EVM
        // recipient no address can be; Circle keeping all of it, or more than 5%.
        assert!(rules_of(&grade(&burn_req(6, me, cctp::Hook::None, 0))).contains(&"bridge_claim"));
        assert!(rules_of(&grade(&burn_req(33, me, cctp::Hook::Forward, 200_000))).contains(&"bridge_no_forwarding"));
        assert_eq!(
            rules_of(&grade(&burn_req(29, me, cctp::Hook::Forward, 0))),
            ["bridge_unknown_chain"]
        );
        assert_eq!(grade(&burn_req(6, [7; 32], cctp::Hook::Forward, 0)).level, Level::Red);
        assert_eq!(
            grade(&burn_req(6, me, cctp::Hook::Forward, 25_000_000)).level,
            Level::Red
        );
        assert!(rules_of(&grade(&burn_req(6, me, cctp::Hook::Forward, 1_250_001))).contains(&"bridge_fee_high"));
        assert!(!rules_of(&grade(&burn_req(6, me, cctp::Hook::Forward, 1_250_000))).contains(&"bridge_fee_high"));
        // Junk to TokenMessengerV2.
        assert_eq!(
            rules_of(&grade(&req(MAINNET.cctp.token_messenger(), vec![1, 2, 3, 4]))),
            ["bridge_unreadable"]
        );
        // The approval it needs names Circle's bridge.
        let approve = grade(&req(
            MAINNET.cctp.usdc(),
            call(
                APPROVE,
                &[
                    addr_word(*MAINNET.cctp.token_messenger().as_bytes()),
                    U256::from_u128(25_000_000).to_be_bytes(),
                ],
            ),
        ));
        assert!(
            approve.findings[0]
                .message
                .starts_with("Circle's bridge (CCTP) could spend"),
            "{}",
            approve.findings[0].message
        );
        // All of this account's USDC to someone else counts as leaving; to itself it doesn't.
        let ctx = Context {
            balances: [(MAINNET.cctp.usdc().to_checksum_hex(), "25000000".to_owned())].into(),
            ..Context::default()
        };
        let mine = evm_transaction(
            &burn_req(6, me, cctp::Hook::Forward, 200_000),
            &EvmSide::injective(&MAINNET),
            &ctx,
        );
        assert!(!rules_of(&mine).contains(&"most_of_balance"));
        let theirs = evm_transaction(
            &burn_req(6, addr_word([0x33; 20]), cctp::Hook::Forward, 200_000),
            &EvmSide::injective(&MAINNET),
            &ctx,
        );
        assert!(rules_of(&theirs).contains(&"most_of_balance"));
    }

    /// The same burns from another EVM chain: Base's USDC, read against Base.
    #[test]
    fn cctp_from_any_evm_chain() {
        let base = MAINNET.cctp.evm_chain(8453).unwrap();
        let side = EvmSide {
            injective: None,
            cctp: Some((&MAINNET.cctp, base)),
        };
        let me = addr_word(FROM);
        let on_base = |domain: u32, recipient: [u8; 32], hook: cctp::Hook, token: EthAddress| {
            let b = cctp::Burn {
                amount: U256::from_u128(25_000_000),
                domain,
                mint_recipient: recipient,
                burn_token: token,
                destination_caller: [0; 32],
                max_fee: U256::from_u128(3_000),
                min_finality: cctp::FAST,
                hook,
            };
            evm_transaction(
                &req(MAINNET.cctp.token_messenger(), cctp::burn_calldata(&b)),
                &side,
                &Context::default(),
            )
        };
        // To this account on Injective, minted by Choice's bridge service or the wallet.
        let a = on_base(29, me, cctp::Hook::None, base.usdc());
        assert_eq!(rules_of(&a), ["bridge", "bridge_to_self", "bridge_in_delivery"]);
        assert_eq!(a.findings[0].params["chain"], "Injective");
        // Base to Arbitrum, forwarded.
        assert_eq!(
            rules_of(&on_base(3, me, cctp::Hook::Forward, base.usdc())),
            ["bridge", "bridge_to_self", "bridge_forward"]
        );
        // To Base itself; Injective's USDC burned on Base.
        assert_eq!(
            rules_of(&on_base(6, me, cctp::Hook::Forward, base.usdc())),
            ["bridge_unknown_chain"]
        );
        assert_eq!(
            on_base(3, me, cctp::Hook::Forward, MAINNET.cctp.usdc()).level,
            Level::Red
        );
        // A gas drop through Choice's contract pays its recipient; through anything else, red.
        let receiver = addr_word(*MAINNET.cctp.bridge_receiver().unwrap().as_bytes());
        let mut b = cctp::Burn {
            amount: U256::from_u128(25_000_000),
            domain: 29,
            mint_recipient: receiver,
            burn_token: base.usdc(),
            destination_caller: receiver,
            max_fee: U256::from_u128(3_000),
            min_finality: cctp::FAST,
            hook: cctp::Hook::GasDrop {
                recipient: EthAddress::from_bytes(FROM),
                max_drop_fee: U256::from_u128(500_000),
            },
        };
        let drop = evm_transaction(
            &req(MAINNET.cctp.token_messenger(), cctp::burn_calldata(&b)),
            &side,
            &Context::default(),
        );
        assert_eq!(rules_of(&drop), ["bridge", "bridge_to_self", "bridge_gas_drop"]);
        b.mint_recipient = me;
        let wrong = evm_transaction(
            &req(MAINNET.cctp.token_messenger(), cctp::burn_calldata(&b)),
            &side,
            &Context::default(),
        );
        assert_eq!(rules_of(&wrong), ["bridge_gas_drop_wrong"]);
        // The approval names Circle's bridge on Base too.
        let approve = evm_transaction(
            &req(
                base.usdc(),
                call(
                    APPROVE,
                    &[
                        addr_word(*MAINNET.cctp.token_messenger().as_bytes()),
                        U256::from_u128(25_000_000).to_be_bytes(),
                    ],
                ),
            ),
            &side,
            &Context::default(),
        );
        assert!(
            approve.findings[0]
                .message
                .starts_with("Circle's bridge (CCTP) could spend")
        );
    }
}
