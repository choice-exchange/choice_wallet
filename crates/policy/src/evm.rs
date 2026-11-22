//! Rules for EVM transactions, including calls to Injective's precompiles, which change
//! Cosmos-side state (grants, orderbook funds, stakes) that an EVM state diff doesn't show.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::request::{Call, TxRequest};
use choice_wallet_evm::{abi, erc20};
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
/// The spot swap precompile (v1.20.4): sells the caller's bank balance on one INJ orderbook
/// market, with no approve, and pays `recipient`.
const SWAP: u8 = 0x68;
/// `swapExactInputV1(address tokenIn, string marketId, uint256 amountIn, uint256 minOut,
/// address recipient, uint256 deadline)`.
const SWAP_EXACT_INPUT: [u8; 4] = 0x8d90dc37u32.to_be_bytes();

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

const APPROVE: [u8; 4] = erc20::APPROVE_SELECTOR;
const INCREASE_ALLOWANCE: [u8; 4] = 0x39509351u32.to_be_bytes();
const SET_APPROVAL_FOR_ALL: [u8; 4] = 0xa22cb465u32.to_be_bytes();
/// ERC721 `safeTransferFrom(address,address,uint256)` and its `bytes` form.
pub(crate) const SAFE_TRANSFER_FROM: [u8; 4] = erc20::SAFE_TRANSFER_FROM_SELECTOR;
const SAFE_TRANSFER_FROM_DATA: [u8; 4] = 0xb88d4fdeu32.to_be_bytes();
/// `transferFrom(address,address,uint256)`: ERC20's and ERC721's alike.
const TRANSFER_FROM: [u8; 4] = 0x23b872ddu32.to_be_bytes();
/// Permit2 `approve(address token, address spender, uint160 amount, uint48 expiration)`.
const PERMIT2_APPROVE: [u8; 4] = 0x87517c45u32.to_be_bytes();
/// ERC20 `transfer(address,uint256)`. Its exact form is `Call::Erc20Transfer`; any other form
/// reaches `contract_call`.
const TRANSFER: [u8; 4] = erc20::TRANSFER_SELECTOR;
/// ERC-1363 `approveAndCall(address,uint256)`: an `approve`, then a call to the spender.
const APPROVE_AND_CALL: [u8; 4] = 0x3177029fu32.to_be_bytes();
/// ERC-1363 `approveAndCall(address,uint256,bytes)`.
const APPROVE_AND_CALL_DATA: [u8; 4] = 0xcae9ca51u32.to_be_bytes();
/// `increaseApproval(address,uint256)`: older OpenZeppelin ERC20s' `increaseAllowance`.
const INCREASE_APPROVAL: [u8; 4] = 0xd73dd623u32.to_be_bytes();
/// ERC-777 `authorizeOperator(address)`: the operator may send all of the holder's tokens.
const AUTHORIZE_OPERATOR: [u8; 4] = 0x959b8c3fu32.to_be_bytes();
/// ERC-1155 `safeTransferFrom(address,address,uint256,uint256,bytes)`.
const SAFE_TRANSFER_1155: [u8; 4] = 0xf242432au32.to_be_bytes();
/// ERC-1155 `safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)`.
const SAFE_BATCH_TRANSFER_1155: [u8; 4] = 0x2eb2c2d6u32.to_be_bytes();
/// ERC-1363 `transferAndCall(address,uint256)`: a `transfer`, then a call to the recipient.
const TRANSFER_AND_CALL: [u8; 4] = 0x1296ee62u32.to_be_bytes();
/// ERC-677 / ERC-1363 `transferAndCall(address,uint256,bytes)`.
const TRANSFER_AND_CALL_DATA: [u8; 4] = 0x4000aea0u32.to_be_bytes();
/// ERC-1363 `transferFromAndCall(address,address,uint256)`.
const TRANSFER_FROM_AND_CALL: [u8; 4] = 0xd8fbe994u32.to_be_bytes();
/// ERC-1363 `transferFromAndCall(address,address,uint256,bytes)`.
const TRANSFER_FROM_AND_CALL_DATA: [u8; 4] = 0xc1d34b89u32.to_be_bytes();

/// Token calls a contract runs whatever their exact byte form: Solidity's decoder ignores
/// bytes after the arguments, and ABI coder v1 masks an address's padding. The rules read
/// each one only in its exact form, so any other form of these is graded as unreadable.
const TOKEN_CALLS: [([u8; 4], &str); 18] = [
    (APPROVE, "approve"),
    (INCREASE_ALLOWANCE, "increaseAllowance"),
    (SET_APPROVAL_FOR_ALL, "setApprovalForAll"),
    (SAFE_TRANSFER_FROM, "safeTransferFrom"),
    (SAFE_TRANSFER_FROM_DATA, "safeTransferFrom"),
    (TRANSFER_FROM, "transferFrom"),
    (PERMIT2_APPROVE, "Permit2 approve"),
    (TRANSFER, "transfer"),
    (APPROVE_AND_CALL, "approveAndCall"),
    (APPROVE_AND_CALL_DATA, "approveAndCall"),
    (INCREASE_APPROVAL, "increaseApproval"),
    (AUTHORIZE_OPERATOR, "authorizeOperator"),
    (SAFE_TRANSFER_1155, "safeTransferFrom"),
    (SAFE_BATCH_TRANSFER_1155, "safeBatchTransferFrom"),
    (TRANSFER_AND_CALL, "transferAndCall"),
    (TRANSFER_AND_CALL_DATA, "transferAndCall"),
    (TRANSFER_FROM_AND_CALL, "transferFromAndCall"),
    (TRANSFER_FROM_AND_CALL_DATA, "transferFromAndCall"),
];

/// The arguments of a call with a dynamic argument, read only in their canonical encoding.
fn args(data: &[u8], tys: &[abi::Ty]) -> Option<Vec<abi::Val>> {
    abi::decode(tys, data.get(4..)?).ok()
}

fn token_call_name(sel: &[u8; 4]) -> Option<&'static str> {
    TOKEN_CALLS.iter().find(|(s, _)| s == sel).map(|(_, name)| *name)
}

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

/// An address argument as a precompile unpacks it: the word's low 20 bytes.
fn low_address_arg(data: &[u8], i: usize) -> Option<EthAddress> {
    Some(EthAddress::from_bytes(word(data, i)?[12..].try_into().ok()?))
}

fn uint_arg(data: &[u8], i: usize) -> Option<U256> {
    Some(U256::from_be_bytes(word(data, i)?.try_into().ok()?))
}

/// The precompile at `to`, if it's one of Injective's system addresses (0x…00 to 0x…ff).
/// Another wallet chain's own system contract that moves the caller's funds with no
/// allowance and no value attached (to an L1 address, an IBC channel, a HyperCore account),
/// which the rules don't read: by chain ID. Read as unread calls, red (run-3).
fn chain_system_contract(chain_id: u64, to: &EthAddress) -> Option<&'static str> {
    let b = to.as_bytes();
    let low = |n: u16| b[..18].iter().all(|&x| x == 0) && u16::from_be_bytes([b[18], b[19]]) == n;
    let predeploy = |n: u8| b[0] == 0x42 && b[1..19].iter().all(|&x| x == 0) && b[19] == n;
    match chain_id {
        // OP-stack chains (OP, Base, Unichain, World Chain, Ink, and their test networks):
        // the predeploys that send funds or messages to L1.
        10 | 11_155_420 | 8453 | 84_532 | 130 | 1301 | 480 | 4801 | 57_073 | 763_373 => match () {
            () if predeploy(0x07) => Some("the L2 cross-domain messenger"),
            () if predeploy(0x10) => Some("the L2 standard bridge"),
            () if predeploy(0x14) => Some("the L2 ERC-721 bridge"),
            () if predeploy(0x16) => Some("the L2-to-L1 message passer"),
            () => None,
        },
        // Arbitrum: ArbSys (withdrawEth, sendTxToL1), ArbRetryableTx, and the L2 gateway
        // router, whose outboundTransfer burns bridged tokens with no allowance.
        42_161 | 421_614 => match () {
            () if low(0x64) => Some("ArbSys"),
            () if low(0x6e) => Some("ArbRetryableTx"),
            () if *to == EthAddress::from_bytes(hex20("5288c571fd7ad117bea99bf60fe0846c4e84f933")) => {
                Some("the L2 gateway router")
            }
            () => None,
        },
        // Ethereum: the EIP-7002 withdrawal and EIP-7251 consolidation request predeploys,
        // which act on validators whose withdrawal address is the caller.
        1 | 11_155_111 => match () {
            () if *to == EthAddress::from_bytes(hex20("00000961ef480eb55e80d19ad83579a64c007002")) => {
                Some("the validator withdrawal request contract")
            }
            () if *to == EthAddress::from_bytes(hex20("0000bbddc7ce488642fb579f8b00f3a590007251")) => {
                Some("the validator consolidation request contract")
            }
            () => None,
        },
        // HyperEVM: CoreWriter, whose actions move HyperCore balances.
        999 | 998 => b.iter().all(|&x| x == 0x33).then_some("CoreWriter"),
        // Sei EVM's precompiles (bank, wasm, staking, gov, distribution, IBC, pointers, …).
        1329 | 1328 => (0x1001..=0x100c).any(low).then_some("a Sei precompile"),
        _ => None,
    }
}

/// 20 bytes from 40 hex digits (a constant written in source).
fn hex20(h: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("hex");
    }
    out
}

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
        (Some(read), _, _, Some(n), _) => swap::swap(&n.choice, &req.from, tx.value, read, ctx, &mut out),
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
            Call::Contract { selector } => contract_call(req, selector, chain, ctx, &mut out, &mut outflows),
        },
    }
    // Native coin a call carries besides what its calldata reads as. A token call never
    // needs it, so there it is a warning; Choice's swaps and CCTP have their own rules.
    if !tx.value.is_zero() && !tx.data.is_empty() && swapped.is_none() && bridged.is_none() && minted.is_none() {
        let token_call = matches!(tx.call_kind(), Call::Erc20Transfer { .. })
            || tx.data.first_chunk::<4>().is_some_and(|s| token_call_name(s).is_some());
        let amount = format!("{} {}", coin_units(&tx.value), ctx.token_name("native"));
        out.push(finding(
            "value_with_call",
            if token_call { Level::Amber } else { Level::Info },
            if token_call {
                format!("Also sends {amount} to {}, besides the token call.", short(&to))
            } else {
                format!("Sends {amount} to contract {}.", short(&to))
            },
            json!({ "value": tx.value.to_string(), "to": to }),
        ));
    }
    outflows.check(ctx, &mut out);
    if let Some(moves) = &ctx.evm_transfers {
        simulated(moves, req, &mut out);
    }
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

/// An amount of an EVM chain's coin (18 decimals on every chain the wallet signs on).
/// What the node's simulation shows leaving the account. A call that sends the account's
/// tokens away and brings nothing back is a payment at best; when some go anywhere but the
/// contract called (another address, or burned), it is how an approval or deposit is drained.
fn simulated(moves: &[crate::EvmTransfer], req: &TxRequest, out: &mut Vec<Finding>) {
    let me = req.from.to_checksum_hex().to_lowercase();
    let called = req.tx.to.to_checksum_hex().to_lowercase();
    let zero = format!("0x{}", "0".repeat(40));
    let gone: Vec<&crate::EvmTransfer> = moves.iter().filter(|m| m.from == me && m.to != me).collect();
    let back = moves.iter().any(|m| m.to == me && m.from != me);
    if gone.is_empty() || back {
        return;
    }
    let tokens = gone
        .iter()
        .map(|m| m.token.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if let Some(m) = gone.iter().find(|m| m.to != called) {
        let what = if m.to == zero {
            "Some are burned".to_string()
        } else {
            format!("Some go to {}, not to the contract you call", short(&m.to))
        };
        out.push(finding(
            "simulated_loss",
            Level::Red,
            format!("Simulated: tokens leave your account and nothing comes back. {what}."),
            json!({ "to": m.to, "token": m.token, "amount": m.amount, "tokens": tokens }),
        ));
    } else {
        out.push(finding(
            "simulated_payment",
            Level::Amber,
            "Simulated: tokens leave your account for this contract and nothing comes back.".into(),
            json!({ "contract": called, "tokens": tokens }),
        ));
    }
}

fn coin_units(v: &U256) -> String {
    let s = format!("{:0>19}", v.to_string());
    let (whole, frac) = s.split_at(s.len() - 18);
    match frac.trim_end_matches('0') {
        "" => whole.to_owned(),
        f => format!("{whole}.{f}"),
    }
}

fn contract_call(
    req: &TxRequest,
    selector: Option<[u8; 4]>,
    chain: &EvmSide<'_>,
    ctx: &Context,
    out: &mut Vec<Finding>,
    outflows: &mut Outflows,
) {
    let network = chain.injective;
    let tx = &req.tx;
    let data = tx.data.as_slice();
    let to = tx.to.to_checksum_hex();
    let choice = network.map(|n| &n.choice);
    if network.is_none()
        && let Some(name) = chain_system_contract(tx.chain_id, &tx.to)
    {
        out.push(finding(
            "chain_system_contract",
            Level::Red,
            format!("Calls {name}, a system contract of this chain the wallet can't read. It can move your funds."),
            json!({ "contract": to, "name": name }),
        ));
        return;
    }
    if let Some(n) = system_address(&tx.to) {
        if n == SWAP && network.is_some() {
            orderbook_swap(req, out, outflows);
            return;
        }
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
        APPROVE | INCREASE_ALLOWANCE | INCREASE_APPROVAL | APPROVE_AND_CALL | APPROVE_AND_CALL_DATA
            if data.len() == 68
                || (sel == APPROVE_AND_CALL_DATA
                    && args(data, &[abi::Ty::Word, abi::Ty::Word, abi::Ty::Bytes]).is_some()) =>
        {
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
                    sel == APPROVE || sel == APPROVE_AND_CALL || sel == APPROVE_AND_CALL_DATA,
                ));
                return;
            }
        }
        AUTHORIZE_OPERATOR if data.len() == 36 => {
            if let Some(operator) = address_arg(data, 0) {
                let operator = operator.to_checksum_hex();
                out.push(finding(
                    "token_operator",
                    Level::Red,
                    format!("{} could move ALL of this token, now and later.", short(&operator)),
                    json!({ "token": to, "operator": operator }),
                ));
                return;
            }
        }
        TRANSFER_AND_CALL | TRANSFER_AND_CALL_DATA
            if data.len() == 68
                || (sel == TRANSFER_AND_CALL_DATA
                    && args(data, &[abi::Ty::Word, abi::Ty::Word, abi::Ty::Bytes]).is_some()) =>
        {
            if let (Some(dest), Some(amount)) = (address_arg(data, 0), uint_arg(data, 1)) {
                let dest = dest.to_checksum_hex();
                recipient(ctx, &dest, None, out);
                out.push(finding(
                    "token_send_call",
                    Level::Info,
                    format!("Sends tokens to {}, then runs its code.", short(&dest)),
                    json!({ "token": to, "to": dest, "amount": amount.to_string() }),
                ));
                outflows.add(&to, amount);
                return;
            }
        }
        SAFE_TRANSFER_1155 | SAFE_BATCH_TRANSFER_1155 => {
            use abi::Ty::{Array, Bytes, Word};
            let read = if sel == SAFE_TRANSFER_1155 {
                args(data, &[Word, Word, Word, Word, Bytes]).and_then(|v| {
                    Some((
                        v[0].address().ok()?,
                        v[1].address().ok()?,
                        vec![(v[2].uint().ok()?, v[3].uint().ok()?)],
                    ))
                })
            } else {
                args(data, &[Word, Word, Array(&Word), Array(&Word), Bytes]).and_then(|v| {
                    let ids = v[2].array().ok()?;
                    let amounts = v[3].array().ok()?;
                    (ids.len() == amounts.len()).then_some(())?;
                    let pairs = ids
                        .iter()
                        .zip(amounts)
                        .map(|(i, a)| Some((i.uint().ok()?, a.uint().ok()?)))
                        .collect::<Option<Vec<_>>>()?;
                    Some((v[0].address().ok()?, v[1].address().ok()?, pairs))
                })
            };
            if let Some((from, dest, items)) = read {
                let dest_hex = dest.to_checksum_hex();
                let what = match items.as_slice() {
                    [(id, amount)] => format!("{amount} of token #{id} of collection {}", short(&to)),
                    _ => format!("{} kinds of token of collection {}", items.len(), short(&to)),
                };
                let params = json!({
                    "collection": to,
                    "from": from.to_checksum_hex(),
                    "to": dest_hex,
                    "items": items.iter().map(|(i, a)| json!({ "token_id": i.to_string(), "amount": a.to_string() })).collect::<Vec<_>>(),
                });
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
        SAFE_TRANSFER_FROM
        | SAFE_TRANSFER_FROM_DATA
        | TRANSFER_FROM
        | TRANSFER_FROM_AND_CALL
        | TRANSFER_FROM_AND_CALL_DATA
            if data.len() == 4 + 3 * 32
                || (sel == SAFE_TRANSFER_FROM_DATA && data.len() >= 4 + 4 * 32)
                || (sel == TRANSFER_FROM_AND_CALL_DATA
                    && args(data, &[abi::Ty::Word, abi::Ty::Word, abi::Ty::Word, abi::Ty::Bytes]).is_some()) =>
        {
            if let (Some(from), Some(dest), Some(id)) = (address_arg(data, 0), address_arg(data, 1), uint_arg(data, 2))
            {
                let dest_hex = dest.to_checksum_hex();
                let what = if matches!(
                    sel,
                    TRANSFER_FROM | TRANSFER_FROM_AND_CALL | TRANSFER_FROM_AND_CALL_DATA
                ) {
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
    // Every arm that read its call has returned. A token call left here has a trailing byte,
    // a dirty address word or the wrong length, and the token may still run it. Any other call
    // is one the wallet can't read: a contract the account approved, gave a Permit2 allowance
    // or deposited at (a router, a vault, a lending pool) can pay that out to whoever the
    // calldata names, so it is never shown as nothing unusual.
    if let Some(name) = token_call_name(&sel) {
        out.push(finding(
            "token_call_unreadable",
            Level::Red,
            format!("Calls {name} in a form the wallet can't read. The token may still run it."),
            json!({ "contract": to, "bytes": data.len() }),
        ));
    } else {
        out.push(finding(
            "contract_call_unread",
            Level::Amber,
            format!(
                "The wallet can't read what this call to {} does. It can move tokens you approved or deposited there.",
                short(&to)
            ),
            json!({ "contract": to, "selector": format!("0x{:08x}", u32::from_be_bytes(sel)) }),
        ));
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

/// A swap sent straight to the spot swap precompile. It debits this account's bank balance
/// whatever `minOut` is (an order larger than the book fills partly), and the wallet can't
/// weigh the minimum against prices here: amber at best, red for someone else as recipient or
/// no minimum, and red unread.
fn orderbook_swap(req: &TxRequest, out: &mut Vec<Finding>, outflows: &mut Outflows) {
    use abi::Ty::{Bytes, Word};
    let data = req.tx.data.as_slice();
    let read = (data.first_chunk::<4>() == Some(&SWAP_EXACT_INPUT))
        .then(|| abi::decode(&[Word, Bytes, Word, Word, Word, Word], &data[4..]).ok())
        .flatten()
        .and_then(|v| {
            let market = String::from_utf8(v[1].bytes().ok()?.to_vec()).ok()?;
            Some((
                v[0].address().ok()?,
                market,
                v[2].uint().ok()?,
                v[3].uint().ok()?,
                v[4].address().ok()?,
            ))
        });
    let Some((token_in, market, amount_in, min_out, recipient)) = read else {
        out.push(finding(
            "precompile_unknown",
            Level::Red,
            "Calls Injective's swap precompile in a way the wallet can't read. It can sell your tokens.".into(),
            json!({ "precompile": req.tx.to.to_checksum_hex() }),
        ));
        return;
    };
    let native = token_in == EthAddress::from_bytes([0; 20]);
    outflows.add(
        if native {
            "native".to_owned()
        } else {
            token_in.to_checksum_hex()
        }
        .as_str(),
        amount_in,
    );
    let params = json!({
        "token_in": token_in.to_checksum_hex(),
        "market": crate::text::clip(&market, 66),
        "amount_in": amount_in.to_string(),
        "minimum_out": min_out.to_string(),
        "recipient": recipient.to_checksum_hex(),
    });
    if recipient != req.from {
        out.push(finding(
            "swap_recipient",
            Level::Red,
            format!(
                "This swap pays {}, not this account.",
                short(&recipient.to_checksum_hex())
            ),
            params.clone(),
        ));
    }
    if min_out.is_zero() {
        out.push(finding(
            "swap_no_minimum",
            Level::Red,
            "This swap has no minimum: it could return nothing.".into(),
            params.clone(),
        ));
    }
    out.push(finding(
        "orderbook_swap",
        Level::Amber,
        "Sells on the INJ orderbook directly, at the minimum shown: the wallet can't check it against prices.".into(),
        params,
    ));
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
        // Injective's own range: a precompile the wallet doesn't know may move funds as the
        // swap one does, so it is graded as the unread call it is.
        0x60..=0xff => return unreadable(),
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
    // using a grant that account gave. The precompile takes the word's low 20 bytes whatever
    // the high ones hold (go-ethereum's BytesToAddress), so that is what is read here.
    if n == EXCHANGE
        && method.selector != 0x3f79e2b1u32.to_be_bytes()
        && low_address_arg(data, 0).is_some_and(|a| a != req.from)
    {
        let acting_for = low_address_arg(data, 0).expect("checked").to_checksum_hex();
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
            (TRANSFER, "transfer(address,uint256)"),
            (TRANSFER_FROM, "transferFrom(address,address,uint256)"),
            (SAFE_TRANSFER_FROM, "safeTransferFrom(address,address,uint256)"),
            (
                SAFE_TRANSFER_FROM_DATA,
                "safeTransferFrom(address,address,uint256,bytes)",
            ),
            (
                SWAP_EXACT_INPUT,
                "swapExactInputV1(address,string,uint256,uint256,address,uint256)",
            ),
            (APPROVE_AND_CALL, "approveAndCall(address,uint256)"),
            (APPROVE_AND_CALL_DATA, "approveAndCall(address,uint256,bytes)"),
            (INCREASE_APPROVAL, "increaseApproval(address,uint256)"),
            (AUTHORIZE_OPERATOR, "authorizeOperator(address)"),
            (
                SAFE_TRANSFER_1155,
                "safeTransferFrom(address,address,uint256,uint256,bytes)",
            ),
            (
                SAFE_BATCH_TRANSFER_1155,
                "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
            ),
            (TRANSFER_AND_CALL, "transferAndCall(address,uint256)"),
            (TRANSFER_AND_CALL_DATA, "transferAndCall(address,uint256,bytes)"),
            (TRANSFER_FROM_AND_CALL, "transferFromAndCall(address,address,uint256)"),
            (
                TRANSFER_FROM_AND_CALL_DATA,
                "transferFromAndCall(address,address,uint256,bytes)",
            ),
        ] {
            assert_eq!(keccak256(sig.as_bytes())[..4], sel, "{sig}");
        }
    }

    /// Run-3: another wallet chain's own fund-moving system contracts are unread calls, red;
    /// the same addresses on other chains, and the predeploys that are ordinary tokens (WETH
    /// at 0x4200…0006), are not.
    #[test]
    fn simulated_moves_show_what_leaves() {
        let me = format!("0x{}", hex::encode(FROM));
        let router = format!("0x{}", hex::encode([0x6f; 20]));
        let payee = format!("0x{}", "bb".repeat(20));
        let zero = format!("0x{}", "00".repeat(20));
        let usdc = format!("0x{}", "83".repeat(20));
        let mv = |from: &str, to: &str| crate::EvmTransfer {
            token: usdc.clone(),
            from: from.into(),
            to: to.into(),
            amount: "5000000000".into(),
            nft: false,
        };
        let grade_with = |moves: Option<Vec<crate::EvmTransfer>>| {
            let r = req(
                EthAddress::from_bytes([0x6f; 20]),
                call(0x3593564cu32.to_be_bytes(), &[[0x60; 32]]),
            );
            let ctx = Context {
                evm_transfers: moves,
                ..Context::default()
            };
            evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx)
        };
        // A router paying the account's tokens to someone else: red.
        let drained = grade_with(Some(vec![mv(&me, &payee)]));
        assert_eq!(drained.level, Level::Red);
        assert!(rules_of(&drained).contains(&"simulated_loss"));
        // A vault burning the account's shares and paying the assets elsewhere: red too.
        let mut burned = mv(&me, &zero);
        burned.token = router.clone();
        let paid_out = mv(&router, &payee);
        assert!(rules_of(&grade_with(Some(vec![burned.clone(), paid_out]))).contains(&"simulated_loss"));
        // Paying the contract called, nothing back: amber.
        let pay = grade_with(Some(vec![mv(&me, &router)]));
        assert_eq!(pay.level, Level::Amber);
        assert!(rules_of(&pay).contains(&"simulated_payment"));
        // Something comes back (a swap, a withdrawal to the account): no simulated finding.
        let swap = grade_with(Some(vec![mv(&me, &router), mv(&router, &me)]));
        assert!(!rules_of(&swap).iter().any(|r| r.starts_with("simulated_")));
        let withdraw = grade_with(Some(vec![burned, mv(&router, &me)]));
        assert!(!rules_of(&withdraw).iter().any(|r| r.starts_with("simulated_")));
        // Not simulated, or nothing moved: no simulated finding.
        assert!(!rules_of(&grade_with(None)).iter().any(|r| r.starts_with("simulated_")));
        assert!(
            !rules_of(&grade_with(Some(vec![])))
                .iter()
                .any(|r| r.starts_with("simulated_"))
        );
    }

    #[test]
    fn calls_the_wallet_cant_read_are_never_info() {
        // A router, vault or lending pool the account approved or deposited at can pay that out
        // to whoever the calldata names: UniversalRouter execute (PERMIT2_TRANSFER_FROM to a
        // payee), ERC-4626 redeem(shares, receiver, owner), Aave withdraw(asset, max, to).
        let payee = [0xbb; 32];
        let mut user = [0u8; 32];
        user[12..].copy_from_slice(&FROM);
        let max = [0xff; 32];
        let grade_on = |chain_id: u64, cctp: Option<u64>, data: Vec<u8>| {
            let mut r = req(EthAddress::from_bytes([0x6f; 20]), data);
            r.tx.chain_id = chain_id;
            let side = match cctp {
                Some(c) => EvmSide {
                    injective: None,
                    cctp: Some((&MAINNET.cctp, MAINNET.cctp.evm_chain(c).unwrap())),
                },
                None => EvmSide::injective(&MAINNET),
            };
            evm_transaction(&r, &side, &Context::default())
        };
        for data in [
            call(0x3593564cu32.to_be_bytes(), &[[0x60; 32], payee]),
            call(0xba087652u32.to_be_bytes(), &[max, payee, user]),
            call(0x69328decu32.to_be_bytes(), &[payee, max, payee]),
        ] {
            for (chain_id, cctp) in [(8453, Some(8453)), (1776, None)] {
                let a = grade_on(chain_id, cctp, data.clone());
                assert_eq!(a.level, Level::Amber, "{chain_id} {}", hex::encode(&data[..4]));
                assert!(rules_of(&a).contains(&"contract_call_unread"));
            }
        }
    }

    #[test]
    fn other_chains_system_contracts() {
        let on = |chain_id: u64, to: [u8; 20], cctp: u64| {
            let mut r = req(EthAddress::from_bytes(to), vec![1, 2, 3, 4]);
            r.tx.chain_id = chain_id;
            let side = EvmSide {
                injective: None,
                cctp: Some((&MAINNET.cctp, MAINNET.cctp.evm_chain(cctp).unwrap())),
            };
            evm_transaction(&r, &side, &Context::default())
        };
        let mut bridge = [0u8; 20];
        bridge[0] = 0x42;
        bridge[19] = 0x10;
        let mut weth = bridge;
        weth[19] = 0x06;
        let mut arbsys = [0u8; 20];
        arbsys[19] = 0x64;
        let mut sei = [0u8; 20];
        sei[18] = 0x10;
        sei[19] = 0x09;
        assert_eq!(on(8453, bridge, 8453).level, Level::Red);
        assert!(rules_of(&on(8453, bridge, 8453)).contains(&"chain_system_contract"));
        assert!(!rules_of(&on(8453, weth, 8453)).contains(&"chain_system_contract"));
        assert_eq!(on(42_161, arbsys, 42_161).level, Level::Red);
        assert_eq!(on(999, [0x33; 20], 999).level, Level::Red);
        assert_eq!(on(1329, sei, 1329).level, Level::Red);
        assert_eq!(
            on(1, hex20("0000bbddc7ce488642fb579f8b00f3a590007251"), 1).level,
            Level::Red
        );
        assert_eq!(
            on(42_161, hex20("5288c571fd7ad117bea99bf60fe0846c4e84f933"), 42_161).level,
            Level::Red
        );
        // Base's predeploy address means nothing on Arbitrum.
        assert!(!rules_of(&on(42_161, bridge, 42_161)).contains(&"chain_system_contract"));
    }

    /// Run-3: a swap sent straight to the spot swap precompile (0x68) is read: someone else
    /// as recipient or no minimum is red, and it is never below amber. Another Injective
    /// system address the wallet doesn't know is an unread call, red.
    #[test]
    fn orderbook_swap_precompile() {
        use abi::Val;
        let swap = |recipient: [u8; 20], min: u128| {
            let mut d = SWAP_EXACT_INPUT.to_vec();
            d.extend(abi::encode(&[
                Val::Word(addr_word([0; 20])),
                Val::Bytes(b"0xa508cb32923323679f29a032c70342c147c17d0145625922b0ef22e955c844c0".to_vec()),
                Val::Word(U256::from_u128(10u128.pow(21)).to_be_bytes()),
                Val::Word(U256::from_u128(min).to_be_bytes()),
                Val::Word(addr_word(recipient)),
                Val::Word(U256::from_u128(9_999_999_999).to_be_bytes()),
            ]));
            grade(&req(precompile(SWAP), d))
        };
        let own = swap(FROM, 5_000_000);
        assert_eq!(own.level, Level::Amber);
        assert!(rules_of(&own).contains(&"orderbook_swap"));
        let theirs = swap([0x22; 20], 5_000_000);
        assert_eq!(theirs.level, Level::Red);
        assert!(rules_of(&theirs).contains(&"swap_recipient"));
        let free = swap(FROM, 0);
        assert!(rules_of(&free).contains(&"swap_no_minimum"));
        // Most of the balance going in is said, as for a send.
        let ctx = Context {
            balances: [("native".to_owned(), "1100000000000000000000".to_owned())].into(),
            ..Context::default()
        };
        let mut d = req(precompile(SWAP), vec![]);
        d.tx.data = {
            let mut x = SWAP_EXACT_INPUT.to_vec();
            x.extend(abi::encode(&[
                Val::Word(addr_word([0; 20])),
                Val::Bytes(b"m".to_vec()),
                Val::Word(U256::from_u128(10u128.pow(21)).to_be_bytes()),
                Val::Word(U256::from_u128(1).to_be_bytes()),
                Val::Word(addr_word(FROM)),
                Val::Word([0; 32]),
            ]));
            x
        };
        assert!(rules_of(&evm_transaction(&d, &EvmSide::injective(&MAINNET), &ctx)).contains(&"most_of_balance"));
        // Unread forms, and an unknown Injective precompile: red.
        assert_eq!(grade(&req(precompile(SWAP), vec![1, 2, 3, 4])).level, Level::Red);
        assert_eq!(grade(&req(precompile(0x69), vec![1, 2, 3, 4])).level, Level::Red);
        // An Ethereum precompile (ecrecover) called directly: odd, not dangerous.
        assert_eq!(grade(&req(precompile(0x01), vec![1, 2, 3, 4])).level, Level::Amber);
    }

    /// Run-3: the other standard ways to grant an allowance or operator rights are graded
    /// like approve, and the other standard sends go through the recipient rules.
    #[test]
    fn other_token_standards_grant_and_send() {
        use abi::Val;
        let token = EthAddress::from_bytes([0x11; 20]);
        let them = addr_word([0x22; 20]);
        let me = addr_word(FROM);
        let max = U256::MAX.to_be_bytes();
        let five = U256::from_u128(5).to_be_bytes();
        let with_data = |sel: [u8; 4], vals: Vec<Val>| {
            let mut d = sel.to_vec();
            d.extend(abi::encode(&vals));
            d
        };
        let one = |data: Vec<u8>| grade(&req(token, data));
        for data in [
            call(APPROVE_AND_CALL, &[them, max]),
            with_data(
                APPROVE_AND_CALL_DATA,
                vec![Val::Word(them), Val::Word(max), Val::Bytes(vec![1, 2])],
            ),
            call(INCREASE_APPROVAL, &[them, max]),
        ] {
            let a = one(data);
            assert_eq!(a.level, Level::Red);
            assert!(rules_of(&a).contains(&"unlimited_allowance"), "{:?}", rules_of(&a));
        }
        let op = one(call(AUTHORIZE_OPERATOR, &[them]));
        assert_eq!(op.level, Level::Red);
        assert!(rules_of(&op).contains(&"token_operator"));
        // approveAndCall(x, 0) takes an allowance back, as approve(x, 0) does.
        assert!(rules_of(&one(call(APPROVE_AND_CALL, &[them, [0; 32]]))).contains(&"allowance_revoke"));
        // Sends: named, and through the recipient rules.
        let sent = one(call(TRANSFER_AND_CALL, &[them, five]));
        assert!(rules_of(&sent).contains(&"token_send_call"), "{:?}", rules_of(&sent));
        let sent = one(with_data(
            TRANSFER_AND_CALL_DATA,
            vec![Val::Word(them), Val::Word(five), Val::Bytes(vec![])],
        ));
        assert!(rules_of(&sent).contains(&"token_send_call"), "{:?}", rules_of(&sent));
        let nft = one(with_data(
            SAFE_TRANSFER_1155,
            vec![
                Val::Word(me),
                Val::Word(them),
                Val::Word(five),
                Val::Word(five),
                Val::Bytes(vec![]),
            ],
        ));
        assert!(rules_of(&nft).contains(&"nft_send"), "{:?}", rules_of(&nft));
        let batch = one(with_data(
            SAFE_BATCH_TRANSFER_1155,
            vec![
                Val::Word(me),
                Val::Word(them),
                Val::Array(vec![Val::Word(five), Val::Word(max)]),
                Val::Array(vec![Val::Word(five), Val::Word(five)]),
                Val::Bytes(vec![]),
            ],
        ));
        let f = batch.findings.iter().find(|f| f.rule == "nft_send").expect("named");
        assert!(f.message.contains("2 kinds of token"), "{}", f.message);
        let other = one(with_data(
            SAFE_TRANSFER_1155,
            vec![
                Val::Word(them),
                Val::Word(them),
                Val::Word(five),
                Val::Word(five),
                Val::Bytes(vec![]),
            ],
        ));
        assert!(rules_of(&other).contains(&"transfer_from_other"));
        let other = one(call(TRANSFER_FROM_AND_CALL, &[them, them, five]));
        assert!(rules_of(&other).contains(&"transfer_from_other"));
        // Any other form of these is unreadable, and red.
        let mut trailing = call(AUTHORIZE_OPERATOR, &[them]);
        trailing.push(0);
        let mut uneven = with_data(
            SAFE_BATCH_TRANSFER_1155,
            vec![
                Val::Word(me),
                Val::Word(them),
                Val::Array(vec![Val::Word(five)]),
                Val::Array(vec![Val::Word(five), Val::Word(five)]),
                Val::Bytes(vec![]),
            ],
        );
        let mut extra = call(INCREASE_APPROVAL, &[them, max]);
        extra.push(0);
        let mut dirty = them;
        dirty[0] = 1;
        for data in [trailing, uneven.clone(), extra, call(APPROVE_AND_CALL, &[dirty, max])] {
            let a = one(data);
            assert_eq!(a.level, Level::Red);
            assert!(rules_of(&a).contains(&"token_call_unreadable"), "{:?}", rules_of(&a));
        }
        uneven.push(0);
        assert!(rules_of(&one(uneven)).contains(&"token_call_unreadable"));
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

    /// Review of #8: a transaction checked through an endpoint a site gave (a chain it
    /// added that the list doesn't have) says so, the wallet's own sends too.
    #[test]
    fn a_site_endpoint_is_said() {
        let r = req(EthAddress::from_bytes([0x22; 20]), vec![]);
        let ctx = Context {
            endpoint_from: Some("https://app.example".into()),
            ..Default::default()
        };
        let a = evm_transaction(
            &r,
            &EvmSide {
                injective: None,
                cctp: None,
            },
            &ctx,
        );
        assert_eq!((a.level, a.findings[0].rule), (Level::Amber, "site_endpoint"));
        assert_eq!(
            a.findings[0].message,
            "Checked through app.example's endpoint, which can make this look safe. Set your own in Settings."
        );
        assert!(grade(&r).findings.iter().all(|f| f.rule != "site_endpoint"));
    }

    /// F4: native coin attached to a token call is named, with its amount.
    #[test]
    fn value_attached_to_a_call_is_named() {
        let token = EthAddress::from_bytes([0x11; 20]);
        let them = EthAddress::from_bytes([0x22; 20]);
        let ctx = Context {
            symbols: [("native".to_owned(), "INJ".to_owned())].into(),
            ..Default::default()
        };
        let with_value = |data: Vec<u8>, value: u128| {
            let mut r = req(token, data);
            r.tx.value = U256::from_u128(value);
            evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx)
        };
        let transfer = erc20::transfer_calldata(&them, &U256::from_u128(1));
        let approve = call(APPROVE, &[addr_word([0x22; 20]), U256::from_u128(1).to_be_bytes()]);
        for data in [transfer.clone(), approve] {
            let a = with_value(data, 2_000_000_000_000_000_000);
            let f = a
                .findings
                .iter()
                .find(|f| f.rule == "value_with_call")
                .expect("value_with_call");
            assert_eq!(f.level, Level::Amber);
            assert_eq!(f.message, "Also sends 2 INJ to 0x1111…1111, besides the token call.");
        }
        // Any other call: named at info. No value, no finding.
        let a = with_value(vec![0x12, 0x34, 0x56, 0x78], 500_000_000_000_000_000);
        let f = a.findings.iter().find(|f| f.rule == "value_with_call").unwrap();
        assert_eq!(
            (f.level, f.message.as_str()),
            (Level::Info, "Sends 0.5 INJ to contract 0x1111…1111.")
        );
        assert!(
            !with_value(transfer, 0)
                .findings
                .iter()
                .any(|f| f.rule == "value_with_call")
        );
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

    /// Run-2 C1: a token call the rules can't read in its exact form (a trailing byte, a dirty
    /// address word) still runs on a Solidity token, so it is red, never an ungraded call.
    #[test]
    fn token_calls_the_wallet_cant_read_are_red() {
        let token = EthAddress::from_bytes([0x11; 20]);
        let them = addr_word([0x22; 20]);
        let me = addr_word(FROM);
        let mut yes = [0u8; 32];
        yes[31] = 1;
        let plus = |mut d: Vec<u8>| {
            d.push(0);
            d
        };
        let mut dirty = them;
        dirty[..12].fill(0xff);
        let max = U256::MAX.to_be_bytes();
        let unreadable = [
            plus(call(APPROVE, &[them, max])),
            call(APPROVE, &[dirty, max]),
            plus(call(INCREASE_ALLOWANCE, &[them, max])),
            plus(call(SET_APPROVAL_FOR_ALL, &[them, yes])),
            call(SET_APPROVAL_FOR_ALL, &[dirty, yes]),
            plus(erc20::transfer_calldata(
                &EthAddress::from_bytes([0x22; 20]),
                &U256::from_u128(5),
            )),
            plus(call(TRANSFER_FROM, &[me, them, yes])),
            plus(call(SAFE_TRANSFER_FROM, &[me, them, yes])),
        ];
        let base = MAINNET.cctp.evm_chain(8453).unwrap();
        let sides = [
            EvmSide::injective(&MAINNET),
            EvmSide {
                injective: None,
                cctp: Some((&MAINNET.cctp, base)),
            },
        ];
        // Known site and contract: nothing else is said about them.
        let ctx = Context {
            origin_known: true,
            known_contracts: vec![token.to_checksum_hex()],
            ..Default::default()
        };
        for side in &sides {
            for data in &unreadable {
                let a = evm_transaction(&req(token, data.clone()), side, &ctx);
                assert_eq!(a.level, Level::Red, "{}", hex::encode(data));
                assert_eq!(rules_of(&a), ["token_call_unreadable"], "{}", hex::encode(data));
            }
        }
        let a = grade(&req(token, unreadable[0].clone()));
        assert_eq!(
            a.findings[0].message,
            "Calls approve in a form the wallet can't read. The token may still run it."
        );
        // A contract never used before still says so: a lookalike token is that signal.
        assert_eq!(rules_of(&a), ["token_call_unreadable", "new_contract"]);
        // The exact forms keep their own rules.
        assert_eq!(
            rules_of(&grade(&req(token, call(APPROVE, &[them, max])))),
            ["unlimited_allowance"]
        );
        assert_eq!(
            rules_of(&grade(&req(token, call(SET_APPROVAL_FOR_ALL, &[them, yes])))),
            ["nft_approval_all"]
        );
        // Any other function of the same shape is a call the wallet can't read: never Info.
        let other = plus(call(0x12345678u32.to_be_bytes(), &[them, max]));
        let a = evm_transaction(&req(token, other), &sides[0], &ctx);
        assert_eq!(a.level, Level::Amber);
        assert!(rules_of(&a).contains(&"contract_call_unread"));
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
        // Dirty high bytes: the precompile still acts for the low 20 bytes' account.
        let mut dirty = addr_word([0x44; 20]);
        dirty[0] = 0xff;
        let a = grade(&req(precompile(EXCHANGE), call(deposit, &[dirty])));
        assert_eq!(a.findings[0].rule, "exchange_for_other");
        let mut mine = addr_word(FROM);
        mine[0] = 0xff;
        let a = grade(&req(precompile(EXCHANGE), call(deposit, &[mine])));
        assert_eq!(a.findings[0].rule, "precompile_call");

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
        // A site's swap, weighed by the host: a minimum worth far less than the input is red,
        // one the wallet can't price is amber, a fair one adds nothing.
        let site = |lost_bps: Option<i64>| {
            let ctx = Context {
                site_swap: Some(crate::SiteSwap { lost_bps }),
                ..Context::default()
            };
            evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx)
        };
        let dust = site(Some(9_999));
        assert_eq!(dust.level, Level::Red);
        assert!(rules_of(&dust).contains(&"swap_value_lost"));
        assert_eq!(site(Some(800)).level, Level::Amber);
        assert!(rules_of(&site(None)).contains(&"swap_unweighed"));
        assert_eq!(rules_of(&site(Some(100))), ["swap"]);
        // Signed by another account, the same route pays someone else.
        r.from = EthAddress::from_bytes(FROM);
        let a = grade(&r);
        assert_eq!(a.level, Level::Red);
        assert!(rules_of(&a).contains(&"swap_recipient"));
        // Testnet has no aggregator there: a contract call the wallet can't read.
        let mut t = req(to, data);
        t.tx.chain_id = 1439;
        assert_eq!(
            rules_of(&evm_transaction(&t, &EvmSide::injective(&TESTNET), &Context::default())),
            ["contract_call_unread", "new_contract"]
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
        // Out of range for uint160: not read as an approval, so red as unreadable (and Permit2
        // is a contract this context hasn't seen).
        assert_eq!(
            rules_of(&grade(&p2([0xff; 32], soon))),
            ["token_call_unreadable", "new_contract"]
        );
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
