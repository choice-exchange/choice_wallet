//! LEGACY_AMINO_JSON against injective-ts (`tools/vectors/gen.mjs`): the sign doc bytes,
//! signatures and TxRaw must match byte for byte, on both entry points.

use choice_wallet_core::address::parse_injective;
use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{Mnemonic, PrivateKey};
use choice_wallet_cosmos::amino::{self, AminoTx};
use choice_wallet_cosmos::builder::{self, Fee, TxOptions};
use choice_wallet_cosmos::cosmwasm::ContractCall;
use choice_wallet_cosmos::msg::{Coin, Msg};
use choice_wallet_cosmos::wkt::Any;
use choice_wallet_injective::chain::{MAINNET, TESTNET};
use choice_wallet_injective::{Error, adapter};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/amino.json")).unwrap()
}

fn key(i: u32) -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(i)).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn addr(v: &Value) -> String {
    parse_injective(s(v)).unwrap().to_inj()
}

fn coins(v: &Value) -> Vec<Coin> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| Coin::new(s(&c[0]), s(&c[1])).unwrap())
        .collect()
}

fn msg(b: &Value) -> Any {
    let from = MAINNET.cosmos.address(&key(0).public_key());
    let chain = &MAINNET.cosmos;
    match s(&b["kind"]) {
        "bank_send" => builder::bank_send(chain, &from, &addr(&b["to"]), &coins(&b["coins"])),
        "cw20_transfer" => {
            builder::cw20_transfer(chain, &from, &addr(&b["cw20"]), &addr(&b["recipient"]), s(&b["amount"]))
        }
        "bank_to_cw20" => adapter::bank_to_cw20(
            &MAINNET,
            &from,
            &addr(&b["adapter"]),
            &addr(&b["cw20"]),
            s(&b["amount"]),
            &addr(&b["recipient"]),
        ),
        other => panic!("unknown kind {other}"),
    }
    .unwrap()
}

fn options(c: &Value) -> TxOptions {
    TxOptions {
        account_number: c["account_number"].as_u64().unwrap(),
        sequence: c["sequence"].as_u64().unwrap(),
        fee: Fee {
            amount: coins(&c["fee"]["amount"]),
            gas_limit: c["fee"]["gas_limit"].as_u64().unwrap(),
            granter: None,
        },
        memo: s(&c["memo"]).into(),
        timeout_height: c["timeout_height"].as_u64().unwrap(),
    }
}

fn own_tx(c: &Value) -> AminoTx {
    let msgs = c["build"].as_array().unwrap().iter().map(msg).collect();
    let req = builder::amino_request(&MAINNET.cosmos, &key(0).public_key(), msgs, &options(c)).unwrap();
    assert_eq!(hex::encode(&req.body_bytes), s(&c["body_bytes"]), "{} body", c["name"]);
    assert_eq!(
        hex::encode(&req.auth_info_bytes),
        s(&c["auth_info_bytes"]),
        "{} auth info",
        c["name"]
    );
    amino::from_tx(req, &MAINNET.cosmos, &key(0).public_key()).unwrap()
}

#[test]
fn own_transactions_match_injective_ts() {
    let k = key(0);
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let tx = own_tx(c);
        assert_eq!(
            std::str::from_utf8(tx.sign_bytes()).unwrap(),
            s(&c["sign_doc"]),
            "{name} sign doc"
        );
        let sig = tx.sign(&k).unwrap();
        assert_eq!(hex::encode(sig), s(&c["signature"]), "{name} signature");
        assert!(tx.verify(&sig));
        assert_eq!(hex::encode(tx.tx_raw(&sig).unwrap()), s(&c["tx_raw"]), "{name} tx_raw");
    }
}

#[test]
fn dapp_sign_docs_match_injective_ts() {
    let k = key(0);
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let tx = amino::decode_sign_doc(s(&c["sign_doc"]), &MAINNET.cosmos, &k.public_key()).unwrap();
        assert_eq!(
            std::str::from_utf8(tx.sign_bytes()).unwrap(),
            s(&c["sign_doc"]),
            "{name}"
        );
        assert_eq!(
            hex::encode(tx.sign(&k).unwrap()),
            s(&c["signature"]),
            "{name} signature"
        );
        assert_eq!(tx.tx_raw(&[0; 64]), None, "dapps assemble their own tx");
        assert_eq!(tx.memo, s(&c["memo"]));
        assert_eq!(tx.timeout_height, c["timeout_height"].as_u64().unwrap());
        assert!(
            tx.messages.iter().all(|m| !matches!(m, Msg::UnknownJson { .. })),
            "{name}"
        );
    }
    let redeem = vectors()["cases"][2].clone();
    let tx = amino::decode_sign_doc(s(&redeem["sign_doc"]), &MAINNET.cosmos, &k.public_key()).unwrap();
    assert!(matches!(
        &tx.messages[0],
        Msg::ExecuteContract {
            call: ContractCall::AdapterRedeem { .. },
            ..
        }
    ));
    assert!(matches!(
        &tx.messages[1],
        Msg::ExecuteContract {
            call: ContractCall::Cw20Transfer { .. },
            ..
        }
    ));
}

#[test]
fn zero_timeout_is_left_out_and_memo_is_go_escaped() {
    // The chain omits a zero timeout_height and escapes like Go; injective-ts does neither.
    let mut c = vectors()["cases"][0].clone();
    c["timeout_height"] = 0.into();
    c["memo"] = "a <b> & c".into();
    let msgs = c["build"].as_array().unwrap().iter().map(msg).collect();
    let req = builder::amino_request(&MAINNET.cosmos, &key(0).public_key(), msgs, &options(&c)).unwrap();
    let doc = String::from_utf8(
        amino::from_tx(req, &MAINNET.cosmos, &key(0).public_key())
            .unwrap()
            .sign_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(!doc.contains("timeout_height"), "{doc}");
    assert!(doc.contains(r#""memo":"a \u003cb\u003e \u0026 c""#), "{doc}");
}

fn doc() -> Value {
    serde_json::from_str(s(&vectors()["cases"][0]["sign_doc"])).unwrap()
}

fn decode(v: &Value) -> Result<AminoTx, Error> {
    amino::decode_sign_doc(&v.to_string(), &MAINNET.cosmos, &key(0).public_key())
}

#[test]
fn refuses_bad_sign_docs() {
    let mut v = doc();
    v["chain_id"] = "injective-888".into();
    assert!(matches!(decode(&v), Err(Error::WrongChain { .. })));
    assert!(matches!(
        amino::decode_sign_doc(&doc().to_string(), &TESTNET.cosmos, &key(0).public_key()),
        Err(Error::WrongChain { .. })
    ));

    let mut v = doc();
    v["extra"] = 1.into();
    assert!(matches!(decode(&v), Err(Error::Amino(_))));

    let mut v = doc();
    v["sequence"] = "01".into();
    assert!(matches!(decode(&v), Err(Error::Amino(_))));

    let mut v = doc();
    v["account_number"] = 12345.into(); // a number, not a string
    assert!(matches!(decode(&v), Err(Error::Amino(_))));

    let mut v = doc();
    v["msgs"][0]["value"]["from_address"] = key(1).public_key().eth_address().to_inj().into();
    assert!(matches!(decode(&v), Err(Error::ForeignSigner(_))));

    let mut v = doc();
    v["fee"]["payer"] = key(1).public_key().eth_address().to_inj().into();
    assert_eq!(decode(&v).unwrap_err(), Error::FeePayer);

    let mut v = doc();
    v["msgs"] = Value::Array(vec![]);
    assert_eq!(decode(&v).unwrap_err(), Error::NoMessages);
}

#[test]
fn unknown_or_unusual_messages_are_kept_raw() {
    let mut v = doc();
    v["msgs"][0]["value"]["extra"] = "x".into();
    assert!(matches!(&decode(&v).unwrap().messages[0], Msg::UnknownJson { .. }));
    let mut v = doc();
    v["msgs"][0]["type"] = "cosmos-sdk/MsgGrant".into();
    assert!(
        matches!(&decode(&v).unwrap().messages[0], Msg::UnknownJson { type_url, .. } if type_url == "/cosmos.authz.v1beta1.MsgGrant")
    );
}

#[test]
fn own_tx_with_unrenderable_message_is_refused() {
    let unknown = Any {
        type_url: "/cosmos.gov.v1beta1.MsgVote".into(),
        value: vec![0x08, 0x01],
    };
    let c = vectors()["cases"][0].clone();
    let req = builder::amino_request(&MAINNET.cosmos, &key(0).public_key(), vec![unknown], &options(&c)).unwrap();
    assert!(matches!(
        amino::from_tx(req, &MAINNET.cosmos, &key(0).public_key()),
        Err(Error::Amino(_))
    ));
}

#[test]
fn only_the_signer_key_can_sign() {
    let tx = own_tx(&vectors()["cases"][0]);
    assert_eq!(tx.sign(&key(1)).unwrap_err(), Error::KeyMismatch);
    assert!(!tx.verify(&[1; 64]));
}

#[test]
fn direct_decoder_refuses_amino_mode_and_vice_versa() {
    let c = vectors()["cases"][0].clone();
    let msgs = c["build"].as_array().unwrap().iter().map(msg).collect::<Vec<_>>();
    let amino_req = builder::amino_request(&MAINNET.cosmos, &key(0).public_key(), msgs.clone(), &options(&c)).unwrap();
    assert_eq!(
        choice_wallet_cosmos::direct::decode(amino_req, &MAINNET.cosmos, &key(0).public_key()).unwrap_err(),
        Error::SignMode
    );
    let direct_req = builder::direct_request(&MAINNET.cosmos, &key(0).public_key(), msgs, &options(&c)).unwrap();
    assert_eq!(
        amino::from_tx(direct_req, &MAINNET.cosmos, &key(0).public_key()).unwrap_err(),
        Error::SignMode
    );
}
