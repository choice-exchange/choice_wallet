//! Rules for EVM transactions, including calls to Injective's precompiles, which change
//! Cosmos-side state (grants, orderbook funds, stakes) that an EVM state diff doesn't show.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::request::{Call, TxRequest};
use choice_wallet_evm::{abi, erc20};
use choice_wallet_injective::cctp::{self, Cctp};
use choice_wallet_injective::chain::Network;
use choice_wallet_injective::{choice, talis};
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
        Level::Red,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x29d3d0e4,
        "createSpotMarketOrder(address,(string,string,string,uint256,uint256,string,string,uint256))",
        Level::Red,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x4881c7c6,
        "batchCreateSpotLimitOrders(address,(string,string,string,uint256,uint256,string,string,uint256)[])",
        Level::Red,
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
        Level::Red,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0xb84857a1,
        "createDerivativeMarketOrder(address,(string,string,string,uint256,uint256,string,string,uint256,uint256))",
        Level::Red,
        "Places an order on the INJ orderbook.",
    ),
    m(
        0x79374eab,
        "batchCreateDerivativeLimitOrders(address,(string,string,string,uint256,uint256,string,string,uint256,uint256)[])",
        Level::Red,
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
        Level::Red,
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

/// Permit2: one address on every chain.
fn permit2() -> EthAddress {
    EthAddress::parse_hex("0x000000000022D473030F116dDEE9F6B43aC78BA3").expect("pinned")
}

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

/// A name at the start of a sentence ("the Talis auction" → "The Talis auction").
fn capitalized(s: &str) -> String {
    let mut out = s.to_owned();
    if let Some(first) = out.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    out
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

    /// The name of a contract the wallet pins on this chain (Talis's on Injective EVM).
    fn name(&self, a: &EthAddress) -> Option<&'static str> {
        self.injective.and_then(|n| n.talis.name(a))
    }

    /// A contract as a sentence names it: by name when pinned, else "contract 0x12…cdef".
    fn contract(&self, a: &EthAddress) -> String {
        self.name(a)
            .map_or_else(|| format!("contract {}", short(&a.to_checksum_hex())), str::to_owned)
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
                format!("Sends {amount} to {}.", chain.contract(&tx.to))
            },
            json!({ "value": tx.value.to_string(), "to": to }),
        ));
    }
    outflows.check(ctx, &mut out);
    if let Some(moves) = &ctx.evm_transfers {
        simulated(moves, req, ctx, &mut out);
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
fn simulated(moves: &[crate::EvmTransfer], req: &TxRequest, ctx: &Context, out: &mut Vec<Finding>) {
    let me = req.from.to_checksum_hex().to_lowercase();
    let called = req.tx.to.to_checksum_hex().to_lowercase();
    let zero = format!("0x{}", "0".repeat(40));
    // Only part of the simulation was read: what it shows can't say what the rest moves.
    if ctx.evm_transfers_partial {
        out.push(finding(
            "simulation_partial",
            Level::Red,
            "The simulation moves more than the wallet could read. It can't say what leaves your account.".into(),
            json!({ "moves_read": moves.len() }),
        ));
    }
    let gone: Vec<&crate::EvmTransfer> = moves.iter().filter(|m| m.from == me && m.to != me).collect();
    // Something comes back only when the wallet can value it: the chain's coin or a token it
    // lists, not an NFT or a token anyone can mint and log a Transfer of (run-4).
    let back: Vec<&crate::EvmTransfer> = moves
        .iter()
        .filter(|m| {
            m.to == me
                && m.from != me
                && !m.nft
                && m.amount != "0"
                && (m.token == "native" || ctx.symbols.contains_key(&m.token))
        })
        .collect();
    if gone.is_empty() {
        return;
    }
    if !back.is_empty() {
        // A trade: the wallet can't weigh what comes back against what leaves.
        let to: std::collections::BTreeSet<&str> = gone.iter().map(|m| m.to.as_str()).collect();
        out.push(finding(
            "simulated_trade",
            Level::Amber,
            format!(
                "Simulated: tokens leave your account for {} and {} comes back. The wallet can't weigh one against the other.",
                to.iter().map(|t| short(t)).collect::<Vec<_>>().join(", "),
                back.iter()
                    .map(|m| ctx.token_name(&m.token))
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            json!({ "to": to, "back": back.iter().map(|m| &m.token).collect::<Vec<_>>() }),
        ));
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
            format!("Simulated: tokens leave your account and nothing the wallet can value comes back. {what}."),
            json!({ "to": m.to, "token": m.token, "amount": m.amount, "tokens": tokens }),
        ));
    } else {
        out.push(finding(
            "simulated_payment",
            Level::Amber,
            "Simulated: tokens leave your account for this contract and nothing the wallet can value comes back."
                .into(),
            json!({ "contract": called, "tokens": tokens }),
        ));
    }
}

pub(crate) fn coin_units(v: &U256) -> String {
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
                // approve(address(0), id) clears an ERC721 token's approval (no ERC20 spends for
                // the zero address).
                if sel == APPROVE && spender == EthAddress::from_bytes([0; 20]) {
                    out.push(finding(
                        "approval_clear",
                        Level::Info,
                        format!("Clears the approval on NFT #{amount} of this collection."),
                        json!({ "collection": to, "token_id": amount.to_string() }),
                    ));
                    return;
                }
                // approve(spender, 0) takes an ERC20 allowance back, but on an ERC721 the same
                // bytes approve `spender` for NFT #0, which it can then take. Only a token the
                // wallet itself vouches for (its own revoke) reads as a revoke.
                if sel == APPROVE
                    && amount.is_zero()
                    && !ctx.erc20_contracts.iter().any(|c| c.eq_ignore_ascii_case(&to))
                {
                    let s = spender.to_checksum_hex();
                    out.push(finding(
                        "approve_zero_ambiguous",
                        Level::Amber,
                        format!(
                            "On a token, removes {0}'s allowance. On an NFT collection, lets {0} take NFT #0.",
                            short(&s)
                        ),
                        json!({ "contract": to, "spender": s }),
                    ));
                    if !known_contract(ctx, &to) {
                        out.push(finding(
                            "new_contract",
                            Level::Info,
                            format!("First interaction with {}.", chain.contract(&tx.to)),
                            json!({ "contract": to }),
                        ));
                    }
                    return;
                }
                let named = network
                    .and_then(|n| swap::known_name(&n.choice, &spender))
                    .or_else(|| chain.cctp.and_then(|(c, _)| bridge::known_name(c, &spender)))
                    .or_else(|| (spender == talis::seaport()).then_some("Seaport"))
                    .or_else(|| chain.name(&spender));
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
                let seaport = operator == talis::seaport();
                let who = if seaport {
                    "Seaport".to_owned()
                } else {
                    chain
                        .name(&operator)
                        .map_or_else(|| short(&operator.to_checksum_hex()), str::to_owned)
                };
                let operator = operator.to_checksum_hex();
                let params = json!({ "collection": to, "operator": operator });
                out.push(if flag.is_zero() {
                    finding(
                        "nft_approval_revoke",
                        Level::Info,
                        format!("Removes {who}'s access to your NFTs in this collection."),
                        params,
                    )
                } else if seaport {
                    // Listing on Talis (or any market on Seaport 1.6) starts here. Seaport has no
                    // owner and moves an approved NFT only for an order its owner signed or sent,
                    // and the wallet reads every Seaport order before it is signed.
                    finding(
                        "nft_approval_seaport",
                        Level::Amber,
                        "Lets Seaport move NFTs in this collection, only for listings you sign.".into(),
                        params,
                    )
                } else {
                    finding(
                        "nft_approval_all",
                        Level::Red,
                        // Talis's auction escrows a listed NFT this way, and it is upgradeable:
                        // named, still red.
                        format!("{} could take ALL your NFTs in this collection.", capitalized(&who)),
                        params,
                    )
                });
                return;
            }
        }
        // Permit2's approve is read only at Permit2, as the vault's own Permit2 revoke is
        // built only for it. The same selector anywhere else is a call the wallet can't read.
        PERMIT2_APPROVE if data.len() == 4 + 4 * 32 && tx.to == permit2() => {
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
    if let Some(name) = token_call_name(&sel).filter(|_| sel != PERMIT2_APPROVE || tx.to == permit2()) {
        out.push(finding(
            "token_call_unreadable",
            Level::Red,
            format!("Calls {name} in a form the wallet can't read. The token may still run it."),
            json!({ "contract": to, "bytes": data.len() }),
        ));
    } else {
        // A pinned name says whose contract this is, not what the call does: still amber.
        let who = chain.name(&tx.to).map_or_else(|| short(&to), str::to_owned);
        out.push(finding(
            "contract_call_unread",
            Level::Amber,
            format!("The wallet can't read what this call to {who} does. It can move tokens you approved or deposited there."),
            json!({ "contract": to, "name": chain.name(&tx.to), "selector": format!("0x{:08x}", u32::from_be_bytes(sel)) }),
        ));
    }
    if !known_contract(ctx, &to) {
        out.push(finding(
            "new_contract",
            Level::Info,
            format!("First interaction with {}.", chain.contract(&tx.to)),
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
            format!("{} could take ALL of this token, now and later.", capitalized(&s)),
            params,
        )
    } else if balance(ctx, token).is_some_and(|b| amount > b) {
        finding(
            "allowance_over_balance",
            Level::Red,
            format!("{} could take more of this token than you hold now.", capitalized(&s)),
            params,
        )
    } else {
        finding(
            "allowance",
            Level::Amber,
            format!("{} could spend this token up to the amount shown.", capitalized(&s)),
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
    let sel = u32::from_be_bytes(method.selector);
    if n == EXCHANGE && sel == EXCHANGE_DEPOSIT {
        return deposit(data, &req.from).unwrap_or_else(unreadable);
    }
    if n == EXCHANGE && ORDER_METHODS.contains(&sel) {
        return order(data, sel, method).unwrap_or_else(unreadable);
    }
    finding(
        "precompile_call",
        method.level,
        method.what.into(),
        params(json!({ "method": method.signature })),
    )
}

/// `deposit(address sender, string subaccountID, string denom, uint256 amount)`.
const EXCHANGE_DEPOSIT: u32 = 0xe441dec9;

/// The owner a subaccount ID names, read as the exchange module reads a deposit's
/// (`GetSubaccountIDOrDeriveFromNonce`): up to 3 characters is a nonce of the sender's own
/// account; otherwise 64 hex digits, after an optional lowercase "0x", whose first 20 bytes
/// are the owner. `None` for anything else, which the module refuses.
fn subaccount_owner(id: &[u8], sender: &EthAddress) -> Option<EthAddress> {
    if id.len() <= 3 {
        return Some(*sender);
    }
    let hex = id.strip_prefix(b"0x").unwrap_or(id);
    if hex.len() != 64 || !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let mut owner = [0u8; 20];
    for (i, b) in owner.iter_mut().enumerate() {
        *b = u8::from_str_radix(std::str::from_utf8(&hex[2 * i..2 * i + 2]).ok()?, 16).ok()?;
    }
    Some(EthAddress::from_bytes(owner))
}

/// A deposit into an INJ orderbook (exchange) account. The module takes it from the sender's
/// bank balance into whichever subaccount the ID names, another account's included, and that
/// account's owner can withdraw it: a deposit anywhere but the sender's own is a transfer.
fn deposit(data: &[u8], from: &EthAddress) -> Option<Finding> {
    use abi::Ty::{Bytes, Word};
    let v = args(data, &[Word, Bytes, Bytes, Word])?;
    let (id, denom, amount) = (v[1].bytes().ok()?, v[2].bytes().ok()?, v[3].uint().ok()?);
    let owner = subaccount_owner(id, from)?;
    let denom = String::from_utf8(denom.to_vec()).ok()?;
    let params = json!({
        "precompile": "0x0000000000000000000000000000000000000065",
        "method": "deposit(address,string,string,uint256)",
        "subaccount_id": crate::text::clip(&String::from_utf8_lossy(id), 66),
        "owner": owner.to_checksum_hex(),
        "denom": crate::text::clip(&denom, 128),
        "amount": amount.to_string(),
    });
    Some(if owner == *from {
        finding(
            "precompile_call",
            Level::Info,
            "Moves funds into your INJ orderbook account.".into(),
            params,
        )
    } else {
        finding(
            "exchange_deposit_other",
            Level::Red,
            format!(
                "Sends funds into the INJ orderbook account of {}, which can withdraw them.",
                short(&owner.to_checksum_hex())
            ),
            params,
        )
    })
}

/// Exchange methods that place orders. Each spends this account's bank balance (its default
/// trading account) or a trading account's deposits, at a worst price the site chose, and a
/// market order fills at the resting orders' prices. The wallet can't weigh that price here,
/// so an order is the unread sale it is: red, as the same order signed as a Cosmos message is.
const ORDER_METHODS: [u32; 7] = [
    0xf642485e, // createSpotLimitOrder
    0x29d3d0e4, // createSpotMarketOrder
    0x4881c7c6, // batchCreateSpotLimitOrders
    0x20c69837, // createDerivativeLimitOrder
    0xb84857a1, // createDerivativeMarketOrder
    0x79374eab, // batchCreateDerivativeLimitOrders
    0xcb0b6590, // batchUpdateOrders
];

/// `(marketID, subaccountID, feeRecipient, price, quantity, cid, orderType, triggerPrice)`.
const SPOT_ORDER: abi::Ty = abi::Ty::Tuple(&[
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Word,
    abi::Ty::Word,
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Word,
]);
/// The spot order's fields with `margin` before `triggerPrice`.
const DERIVATIVE_ORDER: abi::Ty = abi::Ty::Tuple(&[
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Word,
    abi::Ty::Word,
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Word,
    abi::Ty::Word,
]);

/// `(marketID, subaccountID, orderHash, orderMask, cid)`.
const CANCEL: abi::Ty = abi::Ty::Tuple(&[
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Bytes,
    abi::Ty::Word,
    abi::Ty::Bytes,
]);
/// `batchUpdateOrders`' request: subaccount, spot markets to cancel all in, spot cancels, spot
/// orders to create, derivative markets to cancel all in, derivative cancels, derivative
/// orders to create.
const BATCH_UPDATE: abi::Ty = abi::Ty::Tuple(&[
    abi::Ty::Bytes,
    abi::Ty::Array(&abi::Ty::Bytes),
    abi::Ty::Array(&CANCEL),
    abi::Ty::Array(&SPOT_ORDER),
    abi::Ty::Array(&abi::Ty::Bytes),
    abi::Ty::Array(&CANCEL),
    abi::Ty::Array(&DERIVATIVE_ORDER),
]);

/// An order's market, side, worst price, quantity and margin, as the precompile reads them.
fn order_fields(v: &abi::Val) -> Option<serde_json::Value> {
    let abi::Val::Tuple(f) = v else { return None };
    let text = |i: usize| String::from_utf8(f.get(i)?.bytes().ok()?.to_vec()).ok();
    let side = text(6)?;
    if !["buy", "sell", "buyPostOnly", "sellPostOnly"].contains(&side.as_str()) {
        return None;
    }
    let mut o = json!({
        "market": crate::text::clip(&text(0)?, 66),
        "order_type": side,
        "price": f.get(3)?.uint().ok()?.to_string(),
        "quantity": f.get(4)?.uint().ok()?.to_string(),
    });
    if f.len() == 9 {
        o["margin"] = json!(f.get(7)?.uint().ok()?.to_string());
    }
    Some(o)
}

/// An order placed through the exchange precompile, read in its canonical encoding.
fn order(data: &[u8], sel: u32, method: &Method) -> Option<Finding> {
    use abi::Ty::{Array, Word};
    let orders: Vec<serde_json::Value> = match sel {
        0xf642485e | 0x29d3d0e4 => vec![order_fields(&args(data, &[Word, SPOT_ORDER])?[1])?],
        0x20c69837 | 0xb84857a1 => vec![order_fields(&args(data, &[Word, DERIVATIVE_ORDER])?[1])?],
        0x4881c7c6 => args(data, &[Word, Array(&SPOT_ORDER)])?[1]
            .array()
            .ok()?
            .iter()
            .map(order_fields)
            .collect::<Option<_>>()?,
        0x79374eab => args(data, &[Word, Array(&DERIVATIVE_ORDER)])?[1]
            .array()
            .ok()?
            .iter()
            .map(order_fields)
            .collect::<Option<_>>()?,
        // batchUpdateOrders: the orders it creates sit among cancels in one struct. With none
        // to create it only cancels.
        _ => {
            let batch = &args(data, &[Word, BATCH_UPDATE])?[1];
            let abi::Val::Tuple(f) = batch else { return None };
            let mut created = Vec::new();
            for i in [3, 6] {
                for o in f.get(i)?.array().ok()? {
                    created.push(order_fields(o)?);
                }
            }
            if created.is_empty() {
                return Some(finding(
                    "precompile_call",
                    Level::Info,
                    "Cancels orders on the INJ orderbook.".into(),
                    json!({ "precompile": "0x0000000000000000000000000000000000000065", "method": method.signature }),
                ));
            }
            created
        }
    };
    let what = match orders.as_slice() {
        [o] if o["order_type"].as_str().is_some_and(|t| t.starts_with("buy")) => "Places a buy order".to_owned(),
        [_] => "Places a sell order".to_owned(),
        many => format!("Places {} orders", many.len()),
    };
    Some(finding(
        "order_unweighed",
        Level::Red,
        format!("{what} on the INJ orderbook at a price the wallet can't check. It can spend all of what it trades."),
        json!({
            "precompile": "0x0000000000000000000000000000000000000065",
            "method": method.signature,
            "orders": orders,
        }),
    ))
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
            id: None,
        };
        let grade_partial = |moves: Option<Vec<crate::EvmTransfer>>, partial: bool| {
            let r = req(
                EthAddress::from_bytes([0x6f; 20]),
                call(0x3593564cu32.to_be_bytes(), &[[0x60; 32]]),
            );
            let ctx = Context {
                evm_transfers: moves,
                evm_transfers_partial: partial,
                // USDC is a token the wallet lists here.
                symbols: [(usdc.clone(), "USDC".to_owned())].into(),
                ..Context::default()
            };
            evm_transaction(&r, &EvmSide::injective(&MAINNET), &ctx)
        };
        let grade_with = |moves: Option<Vec<crate::EvmTransfer>>| grade_partial(moves, false);
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
        // A listed token comes back (a swap, a withdrawal to the account): a trade the wallet
        // can't weigh, amber, naming where the tokens go.
        let swap = grade_with(Some(vec![mv(&me, &router), mv(&router, &me)]));
        assert_eq!(
            (swap.level, rules_of(&swap).contains(&"simulated_trade")),
            (Level::Amber, true)
        );
        let withdraw = grade_with(Some(vec![burned.clone(), mv(&router, &me)]));
        assert!(rules_of(&withdraw).contains(&"simulated_trade"));
        // Run-4: an NFT, an unlisted token or a zero amount coming back is nothing: the
        // contract that drains the account can log any of them.
        let mut nft_back = mv(&payee, &me);
        (nft_back.nft, nft_back.id, nft_back.amount) = (true, Some("1".into()), "1".into());
        let mut junk_back = mv(&payee, &me);
        junk_back.token = format!("0x{}", "66".repeat(20));
        let mut nothing_back = mv(&payee, &me);
        nothing_back.amount = "0".into();
        for back in [nft_back, junk_back, nothing_back] {
            let a = grade_with(Some(vec![mv(&me, &payee), back]));
            assert_eq!((a.level, rules_of(&a).contains(&"simulated_loss")), (Level::Red, true));
        }
        // Only part of the simulation read: red, whatever the part shows.
        let a = grade_partial(Some(vec![]), true);
        assert_eq!(
            (a.level, rules_of(&a).contains(&"simulation_partial")),
            (Level::Red, true)
        );
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

    /// Talis on Injective EVM: its contracts named on their own network only, never graded
    /// lower for it; NFTs approved to Seaport (how a Talis listing starts) amber, on any chain.
    #[test]
    fn talis_contracts_are_named() {
        let pinned = |s: &str| EthAddress::parse_hex(s).unwrap();
        let auction = pinned("0xa4174A3aA35a04Fc6fA53817E74416B61CcC2C5F");
        let seaport = talis::seaport();
        let collection = EthAddress::from_bytes([0x44; 20]);
        let mut yes = [0u8; 32];
        yes[31] = 1;

        // A bid: an unread call carrying INJ, to the auction by name, still amber.
        let mut bid = req(auction, call([0x45, 0x4a, 0x2a, 0xb3], &[[0u8; 32]]));
        bid.tx.value = U256::from_u128(10u128.pow(18));
        let inj = Context {
            symbols: [("native".to_owned(), "INJ".to_owned())].into(),
            ..Context::default()
        };
        let a = evm_transaction(&bid, &EvmSide::injective(&MAINNET), &inj);
        assert_eq!(a.level, Level::Amber);
        let msg = |a: &Assessment, rule: &str| a.findings.iter().find(|f| f.rule == rule).unwrap().message.clone();
        assert_eq!(
            msg(&a, "contract_call_unread"),
            "The wallet can't read what this call to the Talis auction does. It can move tokens you approved or deposited there."
        );
        assert_eq!(msg(&a, "value_with_call"), "Sends 1 INJ to the Talis auction.");
        assert_eq!(msg(&a, "new_contract"), "First interaction with the Talis auction.");
        // Mainnet's address on testnet is someone else's.
        let t = evm_transaction(&bid, &EvmSide::injective(&TESTNET), &Context::default());
        assert!(
            msg(&t, "contract_call_unread").contains("0xa417"),
            "{}",
            msg(&t, "contract_call_unread")
        );

        // Escrowing NFTs with the auction (upgradeable): named, still red.
        let a = grade(&req(
            collection,
            call(SET_APPROVAL_FOR_ALL, &[addr_word(*auction.as_bytes()), yes]),
        ));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "nft_approval_all"));
        assert_eq!(
            a.findings[0].message,
            "The Talis auction could take ALL your NFTs in this collection."
        );

        // Seaport: amber here and on a chain the wallet pins nothing for; its revoke is named.
        let to_seaport = req(
            collection,
            call(SET_APPROVAL_FOR_ALL, &[addr_word(*seaport.as_bytes()), yes]),
        );
        let elsewhere = EvmSide {
            injective: None,
            cctp: None,
        };
        for a in [
            grade(&to_seaport),
            evm_transaction(&to_seaport, &elsewhere, &Context::default()),
        ] {
            assert_eq!((a.level, a.findings[0].rule), (Level::Amber, "nft_approval_seaport"));
            assert_eq!(
                a.findings[0].message,
                "Lets Seaport move NFTs in this collection, only for listings you sign."
            );
        }
        let off = grade(&req(
            collection,
            call(SET_APPROVAL_FOR_ALL, &[addr_word(*seaport.as_bytes()), [0u8; 32]]),
        ));
        assert_eq!(
            off.findings[0].message,
            "Removes Seaport's access to your NFTs in this collection."
        );
        // An ERC20 allowance to Seaport (an offer in WINJ) is named, and unlimited is still red.
        let a = grade(&req(
            collection,
            call(APPROVE, &[addr_word(*seaport.as_bytes()), U256::MAX.to_be_bytes()]),
        ));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "unlimited_allowance"));
        assert_eq!(
            a.findings[0].message,
            "Seaport could take ALL of this token, now and later."
        );
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
        // approve(x, 0) is a revoke on an ERC20 and a grant of NFT #0 on an ERC721: amber,
        // naming both, unless the wallet itself vouches for the token (its own revoke).
        let a = grade(&approve(U256::ZERO));
        assert_eq!((a.level, a.findings[0].rule), (Level::Amber, "approve_zero_ambiguous"));
        assert!(a.findings[0].message.contains("NFT #0"), "{}", a.findings[0].message);
        let own = Context {
            erc20_contracts: vec![token.to_checksum_hex().to_lowercase()],
            ..Default::default()
        };
        let a = evm_transaction(&approve(U256::ZERO), &EvmSide::injective(&MAINNET), &own);
        assert_eq!((a.level, rules_of(&a)), (Level::Info, vec!["allowance_revoke"]));

        // Permit2's approve is read only at Permit2; the same selector elsewhere is unread.
        let p2 = |to: EthAddress| {
            req(
                to,
                call(
                    PERMIT2_APPROVE,
                    &[addr_word([0x11; 20]), addr_word([0x22; 20]), [0; 32], [0; 32]],
                ),
            )
        };
        assert_eq!(rules_of(&grade(&p2(permit2()))), ["allowance_revoke"]);
        let a = grade(&p2(EthAddress::from_bytes([0x6f; 20])));
        assert_eq!((a.level, a.findings[0].rule), (Level::Amber, "contract_call_unread"));

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

        // A deposit names its sender first: anyone but this account means using a grant it gave.
        let deposit = |sender: [u8; 32], id: &str| {
            let mut d = 0xe441dec9u32.to_be_bytes().to_vec();
            d.extend(abi::encode(&[
                abi::Val::Word(sender),
                abi::Val::Bytes(id.as_bytes().to_vec()),
                abi::Val::Bytes(b"inj".to_vec()),
                abi::Val::Word(U256::from_u128(500).to_be_bytes()),
            ]));
            req(precompile(EXCHANGE), d)
        };
        let a = grade(&deposit(addr_word(FROM), "1"));
        assert_eq!((a.level, a.findings[0].rule), (Level::Info, "precompile_call"));
        let a = grade(&deposit(addr_word([0x44; 20]), "1"));
        assert_eq!(a.findings[0].rule, "exchange_for_other");
        // Dirty high bytes: the precompile still acts for the low 20 bytes' account.
        let mut dirty = addr_word([0x44; 20]);
        dirty[0] = 0xff;
        assert_eq!(grade(&deposit(dirty, "1")).findings[0].rule, "exchange_for_other");
        let mut mine = addr_word(FROM);
        mine[0] = 0xff;
        assert_eq!(grade(&deposit(mine, "1")).findings[0].rule, "precompile_call");

        // Where it goes is the subaccount ID's, read as the exchange module reads it: the
        // sender's own (a nonce, or an ID that starts with the sender) is info; another
        // account's is a transfer it can withdraw (run-4: graded info before).
        let id = |owner: [u8; 20], prefix: &str| format!("{prefix}{}{}", hex::encode(owner), "0".repeat(23) + "1");
        for own in [id(FROM, "0x"), id(FROM, "")] {
            let a = grade(&deposit(addr_word(FROM), &own));
            assert_eq!((a.level, a.findings[0].rule), (Level::Info, "precompile_call"), "{own}");
        }
        for other in [
            id([0xab; 20], "0x"),
            id([0xab; 20], ""),
            id([0xab; 20], "0x").to_uppercase().replacen("0X", "0x", 1),
        ] {
            let a = grade(&deposit(addr_word(FROM), &other));
            assert_eq!(
                (a.level, a.findings[0].rule),
                (Level::Red, "exchange_deposit_other"),
                "{other}"
            );
            assert_eq!(a.findings[0].params["denom"], "inj");
            assert_eq!(a.findings[0].params["amount"], "500");
        }
        // An ID the module refuses, and calldata not in its canonical form: unreadable.
        for bad in [id([0x44; 20], "0X"), "abcd".to_owned(), id([0x44; 20], "0x") + "0"] {
            assert_eq!(
                grade(&deposit(addr_word(FROM), &bad)).findings[0].rule,
                "precompile_unknown",
                "{bad}"
            );
        }
        let short_form = req(
            precompile(EXCHANGE),
            call(0xe441dec9u32.to_be_bytes(), &[addr_word(FROM)]),
        );
        assert_eq!(grade(&short_form).findings[0].rule, "precompile_unknown");

        // An order spends this account's balance at a worst price the site chose: red, as the
        // same Cosmos message is (run-4: a fixed amber before). A batch that only cancels is info.
        let spot = |order_type: &str, price: u128| {
            abi::Val::Tuple(vec![
                abi::Val::Bytes(format!("0x{}", "22".repeat(32)).into_bytes()),
                abi::Val::Bytes(id(FROM, "0x").into_bytes()),
                abi::Val::Bytes(Vec::new()),
                abi::Val::Word(U256::from_u128(price).to_be_bytes()),
                abi::Val::Word(U256::from_u128(1_000_000_000_000_000_000).to_be_bytes()),
                abi::Val::Bytes(Vec::new()),
                abi::Val::Bytes(order_type.as_bytes().to_vec()),
                abi::Val::Word([0; 32]),
            ])
        };
        let with = |sel: u32, vals: Vec<abi::Val>| {
            let mut d = sel.to_be_bytes().to_vec();
            d.extend(abi::encode(&vals));
            req(precompile(EXCHANGE), d)
        };
        let a = grade(&with(0x29d3d0e4, vec![abi::Val::Word(addr_word(FROM)), spot("buy", 1)]));
        assert_eq!((a.level, a.findings[0].rule), (Level::Red, "order_unweighed"));
        assert!(
            a.findings[0].message.starts_with("Places a buy order"),
            "{}",
            a.findings[0].message
        );
        assert_eq!(a.findings[0].params["orders"][0]["price"], "1");
        let a = grade(&with(
            0x4881c7c6,
            vec![
                abi::Val::Word(addr_word(FROM)),
                abi::Val::Array(vec![spot("sell", 1), spot("sellPostOnly", 2)]),
            ],
        ));
        assert_eq!(
            (a.level, a.findings[0].message.as_str()),
            (
                Level::Red,
                "Places 2 orders on the INJ orderbook at a price the wallet can't check. It can spend all of what it trades."
            )
        );
        let batch = |creates: Vec<abi::Val>| {
            with(
                0xcb0b6590,
                vec![
                    abi::Val::Word(addr_word(FROM)),
                    abi::Val::Tuple(vec![
                        abi::Val::Bytes(id(FROM, "0x").into_bytes()),
                        abi::Val::Array(vec![abi::Val::Bytes(b"0x22".to_vec())]),
                        abi::Val::Array(Vec::new()),
                        abi::Val::Array(creates),
                        abi::Val::Array(Vec::new()),
                        abi::Val::Array(Vec::new()),
                        abi::Val::Array(Vec::new()),
                    ]),
                ],
            )
        };
        assert_eq!(
            (
                grade(&batch(Vec::new())).level,
                grade(&batch(Vec::new())).findings[0].rule
            ),
            (Level::Info, "precompile_call")
        );
        assert_eq!(grade(&batch(vec![spot("sell", 1)])).findings[0].rule, "order_unweighed");
        // An order type the module refuses, or a non-canonical order: unreadable, red.
        let a = grade(&with(
            0x29d3d0e4,
            vec![abi::Val::Word(addr_word(FROM)), spot("buyAtomic", 1)],
        ));
        assert_eq!(a.findings[0].rule, "precompile_unknown");
        let mut d = with(0x29d3d0e4, vec![abi::Val::Word(addr_word(FROM)), spot("buy", 1)]);
        d.tx.data.push(0);
        assert_eq!(grade(&d).findings[0].rule, "precompile_unknown");

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
