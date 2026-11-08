//! Cross-implementation tests: `tests/vectors/eip712.json` comes from viem
//! (`tools/vectors/gen_evm.mjs`). Hashes and `eth_signTypedData_v4` signatures must match.

use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{EthAddress, Mnemonic, PrivateKey};
use choice_wallet_evm::eip712::TypedData;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/eip712.json")).unwrap()
}

fn key() -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(0)).unwrap()
}

fn hex_of(v: &Value) -> String {
    v.as_str().unwrap().trim_start_matches("0x").to_owned()
}

#[test]
fn signer_matches_viem() {
    let want = EthAddress::parse_hex(vectors()["signer"].as_str().unwrap()).unwrap();
    assert_eq!(key().public_key().eth_address(), want);
}

#[test]
fn hashes_and_signatures_match_viem() {
    let k = key();
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let td = TypedData::parse(c["typed_data"].as_str().unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(hex::encode(td.hash().unwrap()), hex_of(&c["hash"]), "{name} hash");
        assert_eq!(
            hex::encode(td.sign(&k).unwrap()),
            hex_of(&c["signature"]),
            "{name} signature"
        );
    }
}

#[test]
fn chain_id_is_read_from_hex_and_numbers() {
    let ids: Vec<String> = vectors()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            TypedData::parse(c["typed_data"].as_str().unwrap())
                .unwrap()
                .chain_id()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(ids, ["1", "1776", "1439", "1"]);
}
