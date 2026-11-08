//! Cross-implementation tests: `tests/vectors/personal.json` comes from viem's
//! `signMessage` (`tools/vectors/gen_evm.mjs`). Hashes and signatures must match.

use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{EthAddress, Mnemonic, PrivateKey};
use choice_wallet_evm::personal;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/personal.json")).unwrap()
}

fn key() -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(0)).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

#[test]
fn hashes_and_signatures_match_viem() {
    let k = key();
    let signer = EthAddress::parse_hex(vectors()["signer"].as_str().unwrap()).unwrap();
    assert_eq!(k.public_key().eth_address(), signer);
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let message = bytes(&c["message_hex"]);
        assert_eq!(personal::hash(&message).to_vec(), bytes(&c["hash"]), "{name} hash");
        assert_eq!(
            personal::sign(&message, &k).to_vec(),
            bytes(&c["signature"]),
            "{name} signature"
        );
    }
}
