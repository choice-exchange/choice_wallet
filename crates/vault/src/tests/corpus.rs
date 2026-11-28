//! The real-dapp corpus (`crates/vault/tests/corpus.json`, made by `tools/corpus`): mainnet
//! transactions that Helix, Injective Hub, Mito, Choice, the DEXes and their wallets
//! signed, with every account replaced by the test phrase's. Each one goes through `decode`
//! as a dapp would send it, and what comes back (refused or not, the grade, the rules) must
//! stay what was reviewed. `CORPUS_RECORD=<file>` writes what comes back instead, to review.

use serde_json::{Map, Value, json};

use super::{call, signer_key};

fn corpus() -> Value {
    serde_json::from_str(include_str!("../../tests/corpus.json")).unwrap()
}

fn hex_of_base64(s: &str) -> String {
    hex::encode(base64(s))
}

fn base64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        acc = (acc << 6) | A.iter().position(|&a| a == c).expect("base64") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

const TEST_ETH: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/// The request a dapp sends for this case.
fn request(c: &Value) -> Value {
    let cosmos = |kind: &str| {
        json!({ kind: {
            "chain": "cosmos:injective-1",
            "signer": signer_key(0),
            "body_bytes": hex_of_base64(c["body_bytes"].as_str().unwrap()),
            "auth_info_bytes": hex_of_base64(c["auth_info_bytes"].as_str().unwrap()),
            "account_number": c["account_number"],
        }})
    };
    match c["sign_mode"].as_str().unwrap() {
        // signDirect sends the body and auth info as the dapp encoded them.
        "direct" => cosmos("cosmos_direct"),
        // A transaction signed in amino JSON: the wallet's amino JSON for it (the dapp's
        // signAmino doc is that JSON; the capture checked it against the chain's signature).
        "amino" => cosmos("cosmos_amino_tx"),
        "eip712_v2" => json!({ "evm_typed_data": {
            "chain": "eip155:1776", "signer": TEST_ETH, "typed_data": c["typed_data"],
        }}),
        "evm" => {
            let t = &c["tx"];
            let mut tx = json!({
                "from": TEST_ETH, "value": t["value"], "data": t["data"],
                "nonce": "0x3", "gas": t["gas"], "maxFeePerGas": "0x9896800", "maxPriorityFeePerGas": "0x0",
            });
            if !t["to"].is_null() {
                tx["to"] = t["to"].clone();
            }
            json!({ "evm_transaction": { "chain": "eip155:1776", "tx": tx } })
        }
        m => panic!("sign mode {m}"),
    }
}

/// What `decode` says about a case, in the corpus's terms.
fn outcome(c: &Value) -> Value {
    match call("decode", json!({ "request": request(c) })) {
        Err(e) => json!({ "refused": e["code"], "why": e["message"] }),
        Ok(d) => {
            let mut rules: Vec<String> = d["risk"]["findings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["rule"].as_str().unwrap().to_owned())
                .collect();
            rules.sort();
            rules.dedup();
            json!({ "level": d["risk"]["level"], "rules": rules })
        }
    }
}

#[test]
fn real_dapp_transactions_decode_as_reviewed() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 50, "{}", cases.len());
    if let Ok(path) = std::env::var("CORPUS_RECORD") {
        let got: Map<String, Value> = cases
            .iter()
            .map(|c| (c["name"].as_str().unwrap().to_owned(), outcome(c)))
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap()).unwrap();
        return;
    }
    let mut wrong = Vec::new();
    for c in cases {
        let got = outcome(c);
        if got != c["expect"] {
            wrong.push(format!("{}: expected {} got {}", c["name"], c["expect"], got));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The amino JSON the wallet derives for a transaction must be what wallets actually signed:
/// each mainnet transaction fetch.mjs saved in amino mode is checked against its own
/// signature. Needs that private capture: `CORPUS_PRIVATE=<dir> cargo test -p
/// choice-wallet-vault corpus_amino -- --ignored`.
#[test]
#[ignore]
fn corpus_amino_json_matches_the_chains_signatures() {
    use choice_wallet_core::PublicKey;
    use choice_wallet_cosmos::{amino, direct};

    let dir = std::env::var("CORPUS_PRIVATE").expect("CORPUS_PRIVATE");
    let verified: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/verified.json")).unwrap()).unwrap();
    let chain = crate::chains::find("cosmos:injective-1").unwrap().cosmos().unwrap();
    let (mut ok, mut differ, mut unread) = (0, Vec::new(), std::collections::BTreeMap::<String, usize>::new());
    let mut report = Map::new();
    for f in std::fs::read_dir(format!("{dir}/raw")).unwrap() {
        let txs: Value = serde_json::from_str(&std::fs::read_to_string(f.unwrap().path()).unwrap()).unwrap();
        for t in txs.as_array().unwrap() {
            let hash = t["hash"].as_str().unwrap();
            let Some(n) = verified["amino"][hash]["account_number"].as_str() else {
                continue;
            };
            let raw = base64(t["tx"].as_str().unwrap());
            let tx: choice_wallet_cosmos::proto::cosmos::tx::v1beta1::TxRaw =
                prost::Message::decode(raw.as_slice()).unwrap();
            let auth: choice_wallet_cosmos::proto::cosmos::tx::v1beta1::AuthInfo =
                prost::Message::decode(tx.auth_info_bytes.as_slice()).unwrap();
            let pk_any = auth.signer_infos[0].public_key.as_ref().unwrap();
            let key: choice_wallet_cosmos::proto::cosmos::crypto::secp256k1::PubKey =
                prost::Message::decode(pk_any.value.as_slice()).unwrap();
            let pk = PublicKey::from_sec1_bytes(&key.key).unwrap();
            let request = direct::Request {
                body_bytes: tx.body_bytes.clone(),
                auth_info_bytes: tx.auth_info_bytes.clone(),
                chain_id: chain.chain_id.into(),
                account_number: n.parse().unwrap(),
            };
            match amino::from_tx(request, chain, &pk) {
                Ok(a) => {
                    let sig: [u8; 64] = tx.signatures[0][..64].try_into().unwrap();
                    if pk.verify_keccak256(a.sign_bytes(), &sig) {
                        ok += 1;
                        report.insert(hash.into(), json!("verified"));
                    } else {
                        differ.push(hash.to_owned());
                        report.insert(
                            hash.into(),
                            json!({ "differs": String::from_utf8_lossy(a.sign_bytes()) }),
                        );
                    }
                }
                Err(e) => {
                    *unread.entry(e.to_string()).or_default() += 1;
                    report.insert(hash.into(), json!({ "refused": e.to_string() }));
                }
            }
        }
    }
    std::fs::write(
        format!("{dir}/amino_verified.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    eprintln!(
        "amino: {ok} match the chain's signature, {} differ, refused: {unread:?}",
        differ.len()
    );
    assert!(differ.is_empty(), "amino JSON differs from what was signed: {differ:?}");
}
