//! Cross-implementation tests: `tests/vectors/eip1559.json` comes from viem
//! (`tools/vectors/gen_evm.mjs`). Our encoder and signer must match it byte for byte.

use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{EthAddress, Mnemonic, PrivateKey};
use choice_wallet_evm::{Eip1559Tx, Error, U256, erc20};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/eip1559.json")).unwrap()
}

fn key() -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(0)).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn addr(v: &Value) -> EthAddress {
    EthAddress::parse_hex(s(v)).unwrap()
}

fn h(v: &Value) -> String {
    s(v).trim_start_matches("0x").to_owned()
}

fn build(c: &Value) -> Eip1559Tx {
    let b = &c["build"];
    let chain_id = c["chain_id"].as_u64().unwrap();
    let mut tx = match s(&b["kind"]) {
        "native" => Eip1559Tx::native_transfer(chain_id, addr(&b["to"]), U256::from_dec_str(s(&b["value"])).unwrap()),
        "erc20" => Eip1559Tx::erc20_transfer(
            chain_id,
            addr(&b["token"]),
            &addr(&b["to"]),
            U256::from_dec_str(s(&b["amount"])).unwrap(),
        ),
        other => panic!("unknown kind {other}"),
    }
    .unwrap();
    tx.nonce = c["nonce"].as_u64().unwrap();
    tx.max_priority_fee_per_gas = s(&c["max_priority_fee_per_gas"]).parse().unwrap();
    tx.max_fee_per_gas = s(&c["max_fee_per_gas"]).parse().unwrap();
    tx.gas_limit = c["gas_limit"].as_u64().unwrap();
    tx
}

#[test]
fn sender_matches_viem() {
    assert_eq!(key().public_key().eth_address(), addr(&vectors()["from"]));
}

#[test]
fn encoding_and_signatures_match_viem() {
    let k = key();
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let tx = build(c);
        assert_eq!(hex::encode(&tx.data), h(&c["data"]), "{name} calldata");
        assert_eq!(hex::encode(tx.unsigned_bytes()), h(&c["unsigned"]), "{name} unsigned");
        assert_eq!(
            hex::encode(tx.signing_hash()),
            h(&c["signing_hash"]),
            "{name} signing hash"
        );
        let signed = tx.sign(&k).unwrap();
        assert_eq!(hex::encode(&signed.raw), h(&c["raw"]), "{name} raw");
        assert_eq!(hex::encode(signed.hash), h(&c["hash"]), "{name} hash");
    }
}

#[test]
fn erc20_calldata_is_recognised() {
    for c in vectors()["cases"].as_array().unwrap() {
        if s(&c["build"]["kind"]) != "erc20" {
            continue;
        }
        let data = hex::decode(h(&c["data"])).unwrap();
        let (to, amount) = erc20::parse_transfer(&data).unwrap();
        assert_eq!(to, addr(&c["build"]["to"]));
        assert_eq!(amount.to_string(), s(&c["build"]["amount"]));
    }
}

#[test]
fn refuses_zero_amounts_and_inverted_fees() {
    let to = EthAddress::from_bytes([0x22; 20]);
    assert_eq!(
        Eip1559Tx::native_transfer(1776, to, U256::ZERO).unwrap_err(),
        Error::ZeroAmount
    );
    assert_eq!(
        Eip1559Tx::erc20_transfer(1776, to, &to, U256::ZERO).unwrap_err(),
        Error::ZeroAmount
    );
    let mut tx = Eip1559Tx::native_transfer(1776, to, U256::from_u128(1)).unwrap();
    tx.max_priority_fee_per_gas = 2;
    tx.max_fee_per_gas = 1;
    assert_eq!(tx.sign(&key()).unwrap_err(), Error::PriorityFee);
}
