//! Choice swaps read from real calldata: what Choice's routing API returned on 2026-11-09
//! (`choice_routes.json`), checked against what the API said each route does.

use choice_wallet_core::EthAddress;
use choice_wallet_evm::U256;
use choice_wallet_evm::abi::{self, Ty, Val};
use choice_wallet_injective::chain::{MAINNET, TESTNET};
use choice_wallet_injective::choice::{self, Executor, Venue};
use serde_json::Value;

fn cases() -> Vec<Value> {
    let v: Value = serde_json::from_str(include_str!("choice_routes.json")).unwrap();
    v["cases"].as_array().unwrap().clone()
}

fn addr(v: &Value) -> EthAddress {
    EthAddress::parse_hex(v.as_str().unwrap()).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn read(c: &Value) -> choice::Swap {
    let net = if c["network"] == "mainnet" { MAINNET } else { TESTNET };
    choice::swap(
        &net.choice,
        &addr(&c["to"]),
        U256::from_dec_str(c["value"].as_str().unwrap()).unwrap(),
        &bytes(&c["data"]),
    )
    .expect("a Choice executor")
    .unwrap_or_else(|e| panic!("{}: {e}", c["name"]))
}

#[test]
fn real_routes_read_as_the_api_described_them() {
    let zero = EthAddress::from_bytes([0; 20]);
    for c in cases() {
        let s = read(&c);
        let api = &c["api"];
        let name = c["name"].as_str().unwrap();
        assert_eq!(
            s.executor,
            if api["executor"] == "aggregator" {
                Executor::Aggregator
            } else {
                Executor::UniversalRouter
            },
            "{name}"
        );
        // Native INJ is the zero address in the API; a route paid in value reads as native.
        assert_eq!(s.token_in, addr(&api["tokenIn"]), "{name}");
        assert_eq!(s.token_out, addr(&api["tokenOut"]), "{name}");
        assert_eq!(s.amount_in.to_string(), api["amountIn"].as_str().unwrap(), "{name}");
        assert_eq!(
            s.minimum_out.to_string(),
            api["amountOutMinimum"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(s.fee_bps, 0, "{name}");
        assert_eq!(s.fee_recipient, None, "{name}");
        match s.executor {
            Executor::Aggregator => assert_eq!(s.recipient, Some(addr(&api["recipient"])), "{name}"),
            Executor::UniversalRouter => assert_eq!(s.recipient, None, "{name}"),
        }
        assert!(s.deadline.is_some(), "{name}");
        assert!(!s.venues.is_empty(), "{name}");
        assert!(s.token_in != s.token_out || s.token_in == zero, "{name}");
    }
}

#[test]
fn venues_are_named_by_their_vault() {
    let c = cases().into_iter().find(|c| c["name"] == "m-usdt-inj").unwrap();
    let s = read(&c);
    let names: Vec<String> = s
        .venues
        .iter()
        .map(|v| match v {
            Venue::Infinity { vault, .. } => MAINNET.choice.vault_name(vault).unwrap_or("?").to_owned(),
            Venue::Solidly { .. } => "Solidly".into(),
            Venue::Unwrap => "Unwrap".into(),
            Venue::Wrap => "Wrap".into(),
            other => format!("{other:?}"),
        })
        .collect();
    // The API called these legs "pumex" then "choice".
    assert!(
        names.contains(&"Pumex".to_owned()) && names.contains(&"Choice".to_owned()),
        "{names:?}"
    );
}

/// The first case's route, re-encoded with one field changed.
fn altered(change: impl Fn(&mut Vec<Val>)) -> Vec<u8> {
    let c = &cases()[0];
    let data = bytes(&c["data"]);
    let route_ty = Ty::Tuple(&[
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Word,
        Ty::Array(&Ty::Tuple(&[Ty::Word, Ty::Word, Ty::Word, Ty::Word, Ty::Bytes])),
    ]);
    let mut v = abi::decode(&[route_ty], &data[4..]).unwrap();
    let Val::Tuple(fields) = &mut v[0] else { panic!() };
    change(fields);
    let mut out = data[..4].to_vec();
    out.extend(abi::encode(&v));
    out
}

fn word_of(a: &str) -> Val {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(EthAddress::parse_hex(a).unwrap().as_bytes());
    Val::Word(w)
}

#[test]
fn what_it_refuses() {
    let c = &cases()[0];
    let to = addr(&c["to"]);
    let value = U256::from_dec_str(c["value"].as_str().unwrap()).unwrap();
    let try_read = |data: &[u8]| choice::swap(&MAINNET.choice, &to, value, data).unwrap();
    let data = bytes(&c["data"]);
    assert!(try_read(&data).is_ok());
    // Not canonical: a byte past the end.
    let mut longer = data.clone();
    longer.push(0);
    assert!(try_read(&longer).is_err());
    // A step kind past Adapter.
    let unknown = altered(|f| {
        let Val::Array(steps) = &mut f[8] else { panic!() };
        let Val::Tuple(s) = &mut steps[0] else { panic!() };
        s[0] = Val::Word([[0u8; 31].as_slice(), &[9]].concat().try_into().unwrap());
    });
    assert!(try_read(&unknown).is_err());
    // A dirty address word.
    let dirty = altered(|f| f[4] = Val::Word([0xff; 32]));
    assert!(try_read(&dirty).is_err());
    // A fee and its recipient read as they are (the risk rules judge them).
    let fee = altered(|f| {
        f[6] = Val::Word([[0u8; 31].as_slice(), &[30]].concat().try_into().unwrap());
        f[7] = word_of(MAINNET.choice.treasury);
    });
    let s = try_read(&fee).unwrap();
    assert_eq!(s.fee_bps, 30);
    assert_eq!(s.fee_recipient, Some(MAINNET.choice.treasury()));
    // Another selector, or another contract: not a swap.
    assert!(try_read(&[0xa9, 0x05, 0x9c, 0xbb]).is_err());
    assert!(choice::swap(&MAINNET.choice, &MAINNET.choice.permit2(), value, &data).is_none());
    // Testnet has no aggregator: the mainnet address is just a contract there.
    assert!(choice::swap(&TESTNET.choice, &to, value, &data).is_none());
}

#[test]
fn a_router_plan_that_does_more_than_swap_is_refused() {
    let c = cases().into_iter().find(|c| c["network"] == "testnet").unwrap();
    let data = bytes(&c["data"]);
    let to = addr(&c["to"]);
    let read = |d: &[u8]| choice::swap(&TESTNET.choice, &to, U256::ZERO, d).unwrap();
    assert!(read(&data).is_ok());
    let mut v = abi::decode(&[Ty::Bytes, Ty::Array(&Ty::Bytes), Ty::Word], &data[4..]).unwrap();
    // A second command (SWEEP) after the swap.
    v[0] = Val::Bytes(vec![0x10, 0x04]);
    let Val::Array(inputs) = &mut v[1] else { panic!() };
    inputs.push(Val::Bytes(vec![0; 96]));
    let mut more = data[..4].to_vec();
    more.extend(abi::encode(&v));
    assert!(read(&more).is_err());
}
