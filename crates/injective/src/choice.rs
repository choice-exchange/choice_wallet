//! Swaps through Choice on Injective EVM, read from the calldata a wallet signs.
//!
//! Two contracts execute a Choice swap, and the routing API picks one per route:
//!
//! - `ChoiceAggregator` 1.1.0 (`execute(RouteParams)`, and `executeWithPermit`, which adds a
//!   signed Permit2 allowance): any venue, native INJ at either end. Its `minimumReceive` is
//!   measured on what `recipient` gets after the fee; `feeBps` (at most 1%) goes to
//!   `feeRecipient`; leftovers go back to the caller.
//! - The Infinity `UniversalRouter` (`execute(bytes,bytes[],uint256)`), for routes on
//!   Choice's own pools with an ERC20 at both ends. Read only in the one shape the routing API
//!   builds: a single `INFI_SWAP` command whose plan is swap actions, then `SETTLE_ALL`, then
//!   `TAKE_ALL`. Inside the vault lock the swaps only move deltas; `SETTLE_ALL` pays the input
//!   from the caller, capped; `TAKE_ALL` pays the output to the caller, floored; any other
//!   currency left owing reverts. So the caller gets at least the floor, and nothing else in
//!   the plan can send funds elsewhere.
//!
//! Addresses are pinned per network ([`Choice`]), read off chain 2026-11-09 (code present at
//! each; the aggregator's `VERSION()` is "1.1.0"). Calldata to one of them that isn't one of
//! these shapes, or isn't canonically encoded, is a [`SwapError`]: the risk rules grade it
//! red, and the wallet's own swaps refuse it.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::abi::{self, Ty, Val};

/// Choice's contracts on one network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    /// `ChoiceAggregator` 1.1.0.
    pub aggregator: Option<&'static str>,
    /// The Infinity `UniversalRouter`.
    pub universal_router: Option<&'static str>,
    /// Uniswap's Permit2 (canonical address), which both pull ERC20 input through.
    pub permit2: &'static str,
    /// Wrapped INJ, which the aggregator treats as INJ.
    pub wrapped_inj: &'static str,
    /// Where a route's fee may go.
    pub treasury: &'static str,
    /// Adapters a route may run (code handed the step's input; the aggregator doesn't
    /// allowlist them): the launch-curve adapters Choice's own frontend trusts.
    pub adapters: &'static [&'static str],
    /// Infinity vaults, by name: Choice's own and the ones the aggregator allowlists.
    pub vaults: &'static [(&'static str, &'static str)],
}

/// Choice on Injective mainnet (chain 1776).
pub const MAINNET: Choice = Choice {
    aggregator: Some("0xa705d0D5f549Af25024038dc575E3074B9Bd37c9"),
    universal_router: Some("0xDF242D1937Cfaf2F3f5245CFBd5A8F2012cda856"),
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    wrapped_inj: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
    treasury: "0xE176FeE809C388113eb022EB11bb830f6260AA1d",
    adapters: &[
        "0xc4907c25789bc92d3D047446086279C7EB41217b",
        "0xA47DB6B1e393092306D791e657Fa44b3c8410aeD",
        "0x6f8a9badA85A27BfbED15da2be15f9d31Fa46Af9",
    ],
    vaults: &[
        ("Choice", "0xB67dd13b30ed21310be170968301eF83827B1Cad"),
        ("Pumex", "0x8367cc5B351183f486E007DfEA712B909EdDCC12"),
    ],
};

/// Choice on Injective testnet (chain 1439): no aggregator, so only the router's routes.
pub const TESTNET: Choice = Choice {
    aggregator: None,
    universal_router: Some("0x6F82761E0103846E4F4588DB5B7A5505A2907B04"),
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    wrapped_inj: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
    treasury: "0x0ee0Db41E787FdFcD0a35680074935C6bdC00237",
    adapters: &[],
    vaults: &[("Choice", "0x17BDb95424cA07c31C23ecA9925CBA10818CBF6e")],
};

fn pinned(s: &str) -> EthAddress {
    EthAddress::parse_hex(s).expect("pinned addresses are valid")
}

impl Choice {
    /// Which Choice contract `to` is, if it executes swaps.
    pub fn executor(&self, to: &EthAddress) -> Option<Executor> {
        if self.aggregator.is_some_and(|a| pinned(a) == *to) {
            Some(Executor::Aggregator)
        } else if self.universal_router.is_some_and(|a| pinned(a) == *to) {
            Some(Executor::UniversalRouter)
        } else {
            None
        }
    }

    /// The executor's address.
    pub fn executor_address(&self, e: Executor) -> Option<EthAddress> {
        match e {
            Executor::Aggregator => self.aggregator,
            Executor::UniversalRouter => self.universal_router,
        }
        .map(pinned)
    }

    /// Permit2.
    pub fn permit2(&self) -> EthAddress {
        pinned(self.permit2)
    }

    /// Wrapped INJ.
    pub fn wrapped_inj(&self) -> EthAddress {
        pinned(self.wrapped_inj)
    }

    /// The treasury, where a fee may go.
    pub fn treasury(&self) -> EthAddress {
        pinned(self.treasury)
    }

    /// Whether a route may run this adapter.
    pub fn trusts_adapter(&self, a: &EthAddress) -> bool {
        self.adapters.iter().any(|x| pinned(x) == *a)
    }

    /// An Infinity vault's name, if it is one Choice knows.
    pub fn vault_name(&self, v: &EthAddress) -> Option<&'static str> {
        self.vaults.iter().find(|(_, a)| pinned(a) == *v).map(|(n, _)| *n)
    }
}

/// The contract that executes a swap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Executor {
    /// `ChoiceAggregator`.
    Aggregator,
    /// The Infinity `UniversalRouter`.
    UniversalRouter,
}

/// One step of an aggregator route, or one swap of a router plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Venue {
    /// INJ into wINJ.
    Wrap,
    /// wINJ into INJ.
    Unwrap,
    /// Hops through pools of one Infinity vault.
    Infinity {
        /// The vault.
        vault: EthAddress,
        /// Pools crossed.
        hops: usize,
    },
    /// A Solidly pair.
    Solidly {
        /// The pair.
        pair: EthAddress,
    },
    /// The INJ orderbook, through the `0x68` swap precompile.
    Orderbook {
        /// The market ID.
        market: String,
    },
    /// An adapter contract, which runs its own code with the step's input.
    Adapter {
        /// The adapter.
        adapter: EthAddress,
    },
    /// A swap action of a router plan, on Choice's own pools.
    RouterSwap,
}

/// A Permit2 allowance signed into the transaction (`executeWithPermit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permit {
    /// The token.
    pub token: EthAddress,
    /// The most it allows (`uint160`).
    pub amount: U256,
    /// When it ends, unix seconds.
    pub expiration: u64,
    /// Who may spend.
    pub spender: EthAddress,
}

/// A swap, as its calldata says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Swap {
    /// Which contract executes it.
    pub executor: Executor,
    /// What is paid in; the zero address is native INJ. An aggregator route named in wINJ
    /// with the whole input sent as value reads as native INJ.
    pub token_in: EthAddress,
    /// What is received; the zero address is native INJ.
    pub token_out: EthAddress,
    /// The input: exact for the aggregator, a cap for the router.
    pub amount_in: U256,
    /// The least the recipient receives, after any fee.
    pub minimum_out: U256,
    /// Who receives the output; `None` for the router, which pays the caller.
    pub recipient: Option<EthAddress>,
    /// Unix seconds; `None` for a router call without one.
    pub deadline: Option<U256>,
    /// The route's fee, in basis points of the output.
    pub fee_bps: u16,
    /// Who receives the fee, when there is one.
    pub fee_recipient: Option<EthAddress>,
    /// The steps or swaps, in order.
    pub venues: Vec<Venue>,
    /// A Permit2 allowance signed in, if any.
    pub permit: Option<Permit>,
}

/// Calldata to a Choice executor that the wallet can't read as a swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapError(pub &'static str);

impl std::fmt::Display for SwapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for SwapError {}

impl From<abi::AbiError> for SwapError {
    fn from(e: abi::AbiError) -> Self {
        SwapError(e.0)
    }
}

const STEP: Ty = Ty::Tuple(&[Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Bytes]);
const ROUTE: Ty = Ty::Tuple(&[
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Word,
    Ty::Array(&STEP),
]);
const PERMIT_SINGLE: Ty = Ty::Tuple(&[Ty::Tuple(&[Ty::Word, Ty::Word, Ty::Word, Ty::Word]), Ty::Word, Ty::Word]);
const POOL_KEY: Ty = Ty::Tuple(&[Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Word]);
const HOP: Ty = Ty::Tuple(&[POOL_KEY, Ty::Word, Ty::Word, Ty::Word, Ty::Bytes]);
const STAGE: Ty = Ty::Tuple(&[Ty::Word, Ty::Array(&HOP)]);

/// `execute((address,address,uint256,uint256,address,uint256,uint16,address,(uint8,address,address,uint16,bytes)[]))`.
pub const EXECUTE: [u8; 4] = [0xdd, 0xab, 0x6e, 0x8d];
/// `executeWithPermit(…, ((address,uint160,uint48,uint48),address,uint256), bytes)`.
pub const EXECUTE_WITH_PERMIT: [u8; 4] = [0x4a, 0x6e, 0xd4, 0x9b];
/// `UniversalRouter.execute(bytes,bytes[],uint256)`.
pub const ROUTER_EXECUTE: [u8; 4] = [0x35, 0x93, 0x56, 0x4c];
/// `UniversalRouter.execute(bytes,bytes[])`.
pub const ROUTER_EXECUTE_NO_DEADLINE: [u8; 4] = [0x24, 0x85, 0x6b, 0xc3];

/// The router's `INFI_SWAP` command, with no flag bits.
const INFI_SWAP: u8 = 0x10;
/// Infinity actions: the exact-input swaps (CL single, CL path, Bin single, Bin path).
const SWAP_ACTIONS: [u8; 4] = [0x06, 0x07, 0x1c, 0x1d];
const SETTLE_ALL: u8 = 0x0c;
const TAKE_ALL: u8 = 0x0f;

/// `Permit2.approve(address,address,uint160,uint48)`.
pub const PERMIT2_APPROVE: [u8; 4] = [0x87, 0x51, 0x7c, 0x45];

/// `Permit2.approve(token, spender, amount, expiration)` calldata: `None` if `amount` doesn't
/// fit 160 bits or `expiration` 48.
pub fn permit2_approve_calldata(
    token: &EthAddress,
    spender: &EthAddress,
    amount: U256,
    expiration: u64,
) -> Option<Vec<u8>> {
    let a = amount.to_be_bytes();
    if a[..12].iter().any(|&b| b != 0) || expiration >> 48 != 0 {
        return None;
    }
    let word = |b: &[u8]| {
        let mut w = [0u8; 32];
        w[32 - b.len()..].copy_from_slice(b);
        Val::Word(w)
    };
    let mut out = PERMIT2_APPROVE.to_vec();
    out.extend(abi::encode(&[
        word(token.as_bytes()),
        word(spender.as_bytes()),
        Val::Word(a),
        word(&expiration.to_be_bytes()),
    ]));
    Some(out)
}

/// Read calldata sent to `to` (with `value` attached) as a Choice swap: `None` if `to` isn't
/// a Choice executor on this network.
pub fn swap(choice: &Choice, to: &EthAddress, value: U256, data: &[u8]) -> Option<Result<Swap, SwapError>> {
    let executor = choice.executor(to)?;
    Some(match executor {
        Executor::Aggregator => aggregator(choice, value, data),
        Executor::UniversalRouter => router(data),
    })
}

fn aggregator(choice: &Choice, value: U256, data: &[u8]) -> Result<Swap, SwapError> {
    let (sel, args) = data.split_first_chunk::<4>().ok_or(SwapError("calldata too short"))?;
    let (route, permit) = match *sel {
        EXECUTE => (abi::decode(&[ROUTE], args)?.swap_remove(0), None),
        EXECUTE_WITH_PERMIT => {
            let mut v = abi::decode(&[ROUTE, PERMIT_SINGLE, Ty::Bytes], args)?;
            let permit = permit_single(&v[1])?;
            (v.swap_remove(0), Some(permit))
        }
        _ => return Err(SwapError("not an aggregator swap")),
    };
    let f = route.fields()?;
    let fee_bps = u16::try_from(f[6].small(16)?).expect("16 bits");
    let fee_recipient = f[7].address()?;
    let mut token_in = f[0].address()?;
    let amount_in = f[2].uint()?;
    // INJ in either form: a route named in wINJ paid wholly in value is a native INJ swap.
    if token_in == choice.wrapped_inj() && value == amount_in {
        token_in = EthAddress::from_bytes([0; 20]);
    }
    let venues = f[8].array()?.iter().map(step).collect::<Result<Vec<_>, _>>()?;
    if venues.is_empty() {
        return Err(SwapError("a route with no steps"));
    }
    Ok(Swap {
        executor: Executor::Aggregator,
        token_in,
        token_out: f[1].address()?,
        amount_in,
        minimum_out: f[3].uint()?,
        recipient: Some(f[4].address()?),
        deadline: Some(f[5].uint()?),
        fee_bps,
        fee_recipient: (fee_recipient != EthAddress::from_bytes([0; 20])).then_some(fee_recipient),
        venues,
        permit,
    })
}

fn permit_single(v: &Val) -> Result<Permit, SwapError> {
    let f = v.fields()?;
    let d = f[0].fields()?;
    // `nonce` (d[3]) is Permit2's to check; it is still range-checked.
    d[3].uint_bits(48)?;
    Ok(Permit {
        token: d[0].address()?,
        amount: d[1].uint_bits(160)?,
        expiration: d[2].small(48)?,
        spender: f[1].address()?,
    })
}

/// One aggregator step: its kind, with its `data` read by that kind's own shape.
fn step(s: &Val) -> Result<Venue, SwapError> {
    let f = s.fields()?;
    let kind = f[0].small(8)?;
    f[1].address()?;
    f[2].address()?;
    let share = f[3].small(16)?;
    if share == 0 || share > 10_000 {
        return Err(SwapError("a step's share is out of range"));
    }
    let data = f[4].bytes()?;
    Ok(match kind {
        0 | 1 if data.is_empty() => {
            if kind == 0 {
                Venue::Wrap
            } else {
                Venue::Unwrap
            }
        }
        2 => {
            let stage = abi::decode(&[STAGE], data)?.swap_remove(0);
            let sf = stage.fields()?;
            let hops = sf[1].array()?;
            for h in hops {
                let hf = h.fields()?;
                for w in hf[0].fields()?.iter().take(4) {
                    w.address()?;
                }
                hf[1].boolean()?;
                hf[2].boolean()?;
                hf[3].small(16)?;
            }
            if hops.is_empty() {
                return Err(SwapError("an Infinity step with no hops"));
            }
            Venue::Infinity {
                vault: sf[0].address()?,
                hops: hops.len(),
            }
        }
        3 => {
            let v = abi::decode(&[Ty::Word, Ty::Word], data)?;
            v[1].boolean()?;
            Venue::Solidly { pair: v[0].address()? }
        }
        4 => {
            let v = abi::decode(&[Ty::Bytes], data)?;
            let market = std::str::from_utf8(v[0].bytes()?).map_err(|_| SwapError("a market ID that isn't text"))?;
            if !market.starts_with("0x") || market.len() != 66 || !market[2..].bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(SwapError("a market ID that isn't one"));
            }
            Venue::Orderbook {
                market: market.to_owned(),
            }
        }
        5 => {
            let v = abi::decode(&[Ty::Word, Ty::Bytes], data)?;
            Venue::Adapter {
                adapter: v[0].address()?,
            }
        }
        _ => return Err(SwapError("a step this wallet can't read")),
    })
}

fn router(data: &[u8]) -> Result<Swap, SwapError> {
    let (sel, args) = data.split_first_chunk::<4>().ok_or(SwapError("calldata too short"))?;
    let (v, deadline) = match *sel {
        ROUTER_EXECUTE => {
            let v = abi::decode(&[Ty::Bytes, Ty::Array(&Ty::Bytes), Ty::Word], args)?;
            let d = v[2].uint()?;
            (v, Some(d))
        }
        ROUTER_EXECUTE_NO_DEADLINE => (abi::decode(&[Ty::Bytes, Ty::Array(&Ty::Bytes)], args)?, None),
        _ => return Err(SwapError("not a router swap")),
    };
    let more = SwapError("a router plan that does more than swap");
    let inputs = v[1].array()?;
    if v[0].bytes()? != [INFI_SWAP] || inputs.len() != 1 {
        return Err(more);
    }
    let plan = abi::decode(&[Ty::Bytes, Ty::Array(&Ty::Bytes)], inputs[0].bytes()?)?;
    let actions = plan[0].bytes()?;
    let params = plan[1].array()?;
    let n = actions.len();
    if n < 3 || params.len() != n {
        return Err(more);
    }
    if !actions[..n - 2].iter().all(|a| SWAP_ACTIONS.contains(a))
        || actions[n - 2] != SETTLE_ALL
        || actions[n - 1] != TAKE_ALL
    {
        return Err(more);
    }
    let settle = abi::decode(&[Ty::Word, Ty::Word], params[n - 2].bytes()?)?;
    let take = abi::decode(&[Ty::Word, Ty::Word], params[n - 1].bytes()?)?;
    Ok(Swap {
        executor: Executor::UniversalRouter,
        token_in: settle[0].address()?,
        token_out: take[0].address()?,
        amount_in: settle[1].uint()?,
        minimum_out: take[1].uint()?,
        recipient: None,
        deadline,
        fee_bps: 0,
        fee_recipient: None,
        venues: vec![Venue::RouterSwap; n - 2],
        permit: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_are_the_signatures() {
        let route =
            "(address,address,uint256,uint256,address,uint256,uint16,address,(uint8,address,address,uint16,bytes)[])";
        assert_eq!(abi::selector(&format!("execute({route})")), EXECUTE);
        assert_eq!(
            abi::selector(&format!(
                "executeWithPermit({route},((address,uint160,uint48,uint48),address,uint256),bytes)"
            )),
            EXECUTE_WITH_PERMIT
        );
        assert_eq!(abi::selector("execute(bytes,bytes[],uint256)"), ROUTER_EXECUTE);
        assert_eq!(abi::selector("execute(bytes,bytes[])"), ROUTER_EXECUTE_NO_DEADLINE);
        assert_eq!(
            abi::selector("approve(address,address,uint160,uint48)"),
            PERMIT2_APPROVE
        );
    }

    #[test]
    fn pins_are_checksummed() {
        for c in [MAINNET, TESTNET] {
            let all = c
                .aggregator
                .into_iter()
                .chain(c.universal_router)
                .chain([c.permit2, c.wrapped_inj, c.treasury])
                .chain(c.adapters.iter().copied())
                .chain(c.vaults.iter().map(|(_, a)| *a));
            for a in all {
                assert_eq!(pinned(a).to_checksum_hex(), a);
            }
        }
    }
}
