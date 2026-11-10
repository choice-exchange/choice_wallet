//! Cross-implementation tests: `tests/vectors/direct.json` comes from injective-ts
//! (`tools/vectors/gen.mjs`). Our builder, decoder and signer must match it byte for byte.

use choice_wallet_core::address::parse_injective;
use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{Mnemonic, PrivateKey};
use choice_wallet_cosmos::builder::{self, Fee, TxOptions};
use choice_wallet_cosmos::cosmwasm::ContractCall;
use choice_wallet_cosmos::direct::{self, Request};
use choice_wallet_cosmos::msg::{Coin, Msg};
use choice_wallet_cosmos::proto::cosmos::tx::v1beta1::{AuthInfo, TxBody};
use choice_wallet_cosmos::wkt::Any;
use choice_wallet_injective::chain::MAINNET;
use choice_wallet_injective::{Error, adapter};
use prost::Message;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/direct.json")).unwrap()
}

fn key(i: u32) -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(i)).unwrap()
}

fn h(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
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

fn request(c: &Value) -> Request {
    Request {
        body_bytes: h(&c["body_bytes"]),
        auth_info_bytes: h(&c["auth_info_bytes"]),
        chain_id: "injective-1".into(),
        account_number: c["account_number"].as_u64().unwrap(),
    }
}

fn build(c: &Value) -> Request {
    let from = MAINNET.cosmos.address(&key(0).public_key());
    let chain = &MAINNET.cosmos;
    let b = &c["build"];
    let msg = match s(&b["kind"]) {
        "bank_send" => builder::bank_send(chain, &from, &addr(&b["to"]), &coins(&b["coins"])),
        "cw20_transfer" => {
            builder::cw20_transfer(chain, &from, &addr(&b["cw20"]), &addr(&b["recipient"]), s(&b["amount"]))
        }
        "cw20_to_bank" => adapter::cw20_to_bank(
            &MAINNET,
            &from,
            &addr(&b["cw20"]),
            &addr(&b["adapter"]),
            s(&b["amount"]),
        ),
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
    .unwrap();
    let opts = TxOptions {
        account_number: c["account_number"].as_u64().unwrap(),
        sequence: c["sequence"].as_u64().unwrap(),
        fee: Fee {
            amount: coins(&c["fee"]["amount"]),
            gas_limit: c["fee"]["gas_limit"].as_u64().unwrap(),
            granter: None,
        },
        memo: s(&c["memo"]).into(),
        timeout_height: c["timeout_height"].as_u64().unwrap(),
    };
    builder::direct_request(&MAINNET.cosmos, &key(0).public_key(), vec![msg], &opts).unwrap()
}

#[test]
fn accounts_match_injective_ts() {
    for (i, a) in vectors()["accounts"].as_array().unwrap().iter().enumerate() {
        let pk = key(i as u32).public_key();
        assert_eq!(pk.eth_address().to_inj(), s(&a["inj"]), "account {i}");
        assert_eq!(
            pk.eth_address().to_checksum_hex().to_lowercase(),
            s(&a["eth"]),
            "account {i}"
        );
        assert_eq!(hex::encode(pk.compressed()), s(&a["pubkey"]), "account {i}");
    }
}

#[test]
fn builder_matches_injective_ts() {
    for c in vectors()["cases"].as_array().unwrap() {
        let ours = build(c);
        assert_eq!(hex::encode(&ours.body_bytes), s(&c["body_bytes"]), "{} body", c["name"]);
        assert_eq!(
            hex::encode(&ours.auth_info_bytes),
            s(&c["auth_info_bytes"]),
            "{} auth_info",
            c["name"]
        );
    }
}

#[test]
fn decode_and_sign_match_injective_ts() {
    let k = key(0);
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let d = direct::decode(request(c), &MAINNET.cosmos, &k.public_key()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(hex::encode(d.sign_doc_bytes()), s(&c["sign_doc"]), "{name} sign doc");
        assert_eq!(d.memo(), s(&c["memo"]));
        assert_eq!(d.sequence(), c["sequence"].as_u64().unwrap());
        assert_eq!(d.fee().gas_limit, c["fee"]["gas_limit"].as_u64().unwrap());
        let signed = direct::sign(&d, &k).unwrap();
        assert_eq!(hex::encode(signed.signature), s(&c["signature"]), "{name} signature");
        assert_eq!(hex::encode(&signed.tx_raw), s(&c["tx_raw"]), "{name} tx_raw");
        assert!(k.public_key().verify_keccak256(&d.sign_doc_bytes(), &signed.signature));
    }
}

#[test]
fn decoded_messages_are_recognised() {
    let k = key(0);
    let v = vectors();
    let decoded = |name: &str| {
        let c = v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        direct::decode(request(c), &MAINNET.cosmos, &k.public_key())
            .unwrap()
            .messages()
            .to_vec()
    };
    let a1 = key(1).public_key().eth_address().to_inj();

    let msgs = decoded("bank_send_two_coins_memo_timeout");
    let [Msg::BankSend { to, amount, .. }] = msgs.as_slice() else {
        panic!("expected one bank send")
    };
    assert_eq!(*to, a1);
    assert_eq!(amount.len(), 2);

    let msgs = decoded("cw20_transfer");
    let [Msg::ExecuteContract { call, .. }] = msgs.as_slice() else {
        panic!()
    };
    assert_eq!(
        *call,
        ContractCall::Cw20Transfer {
            recipient: a1,
            amount: "1000000".into()
        }
    );

    let msgs = decoded("cw20_to_bank");
    let [Msg::ExecuteContract { call, .. }] = msgs.as_slice() else {
        panic!()
    };
    assert!(
        matches!(call, ContractCall::Cw20Send { contract, msg, .. } if Some(contract.as_str()) == MAINNET.cw20_adapter && msg.is_empty())
    );

    let msgs = decoded("bank_to_cw20");
    let [Msg::ExecuteContract { call, funds, .. }] = msgs.as_slice() else {
        panic!()
    };
    assert!(matches!(call, ContractCall::AdapterRedeem { recipient: Some(_) }));
    assert!(
        funds[0]
            .denom()
            .starts_with("factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/")
    );
}

// ---- Refusals ----

fn first_case() -> Value {
    vectors()["cases"][0].clone()
}

fn decode_err(req: Request) -> Error {
    direct::decode(req, &MAINNET.cosmos, &key(0).public_key()).unwrap_err()
}

fn with_body(f: impl FnOnce(&mut TxBody)) -> Request {
    let mut req = request(&first_case());
    let mut body = TxBody::decode(req.body_bytes.as_slice()).unwrap();
    f(&mut body);
    req.body_bytes = body.encode_to_vec();
    req
}

fn with_auth(f: impl FnOnce(&mut AuthInfo)) -> Request {
    let mut req = request(&first_case());
    let mut auth = AuthInfo::decode(req.auth_info_bytes.as_slice()).unwrap();
    f(&mut auth);
    req.auth_info_bytes = auth.encode_to_vec();
    req
}

#[test]
fn refuses_wrong_chain() {
    let mut req = request(&first_case());
    req.chain_id = "injective-888".into();
    assert!(matches!(decode_err(req), Error::WrongChain { .. }));
}

#[test]
fn refuses_another_accounts_key() {
    let err = direct::decode(request(&first_case()), &MAINNET.cosmos, &key(1).public_key()).unwrap_err();
    // The bank send names account 0 as sender, which isn't account 1.
    assert!(matches!(err, Error::ForeignSigner(_)));
}

#[test]
fn refuses_non_canonical_body_and_auth_info() {
    let mut req = request(&first_case());
    req.body_bytes.extend_from_slice(&[0x20, 0x01]); // field 4 = `unordered: true` on SDK v0.53, unknown here
    assert_eq!(decode_err(req), Error::NonCanonical("TxBody"));

    let mut req = request(&first_case());
    req.body_bytes.extend_from_slice(&[0xf8, 0x3f, 0x01]); // field 1023 (extension_options) with the wrong wire type
    assert_eq!(decode_err(req), Error::Decode("TxBody"));

    let mut req = request(&first_case());
    req.auth_info_bytes.extend_from_slice(&[0x20, 0x01]); // unknown field 4
    assert_eq!(decode_err(req), Error::NonCanonical("AuthInfo"));
}

#[test]
fn refuses_non_canonical_nested_message() {
    let req = with_body(|b| b.messages[0].value.extend_from_slice(&[0x20, 0x01]));
    assert_eq!(decode_err(req), Error::NonCanonical("MsgSend"));
}

#[test]
fn refuses_extension_options() {
    let ext = Any {
        type_url: "/injective.types.v1beta1.ExtensionOptionsWeb3Tx".into(),
        value: vec![],
    };
    assert_eq!(
        decode_err(with_body(|b| b.extension_options.push(ext.clone()))),
        Error::ExtensionOptions
    );
    assert_eq!(
        decode_err(with_body(|b| b.non_critical_extension_options.push(ext))),
        Error::ExtensionOptions
    );
}

#[test]
fn refuses_empty_body() {
    assert_eq!(decode_err(with_body(|b| b.messages.clear())), Error::NoMessages);
}

#[test]
fn refuses_second_signer_and_fee_payer() {
    assert_eq!(
        decode_err(with_auth(|a| a.signer_infos.push(a.signer_infos[0].clone()))),
        Error::SignerCount
    );
    assert_eq!(decode_err(with_auth(|a| a.signer_infos.clear())), Error::SignerCount);
    let other = key(1).public_key().eth_address().to_inj();
    assert_eq!(
        decode_err(with_auth(|a| a.fee.as_mut().unwrap().payer = other)),
        Error::FeePayer
    );
    assert_eq!(decode_err(with_auth(|a| a.fee = None)), Error::MissingFee);
}

#[test]
fn refuses_other_sign_modes() {
    use choice_wallet_cosmos::proto::cosmos::tx::v1beta1::mode_info::Sum;
    let req = with_auth(|a| {
        if let Some(Sum::Single(s)) = a.signer_infos[0].mode_info.as_mut().unwrap().sum.as_mut() {
            s.mode = 127; // LEGACY_AMINO_JSON
        }
    });
    assert_eq!(decode_err(req), Error::SignMode);
}

#[test]
fn refuses_other_pubkey_types() {
    let req = with_auth(|a| {
        a.signer_infos[0].public_key.as_mut().unwrap().type_url = "/cosmos.crypto.secp256k1.PubKey".into()
    });
    assert!(matches!(decode_err(req), Error::PubKeyType(_)));
}

#[test]
fn unknown_messages_are_kept_raw() {
    let unknown = Any {
        type_url: "/cosmos.gov.v1beta1.MsgDeposit".into(),
        value: vec![0x08, 0x01],
    };
    let req = with_body(|b| b.messages.push(unknown.clone()));
    let d = direct::decode(req, &MAINNET.cosmos, &key(0).public_key()).unwrap();
    assert_eq!(
        d.messages()[1],
        Msg::Unknown {
            type_url: unknown.type_url,
            value: unknown.value
        }
    );
}

#[test]
fn only_the_signers_key_can_sign() {
    let d = direct::decode(request(&first_case()), &MAINNET.cosmos, &key(0).public_key()).unwrap();
    assert_eq!(direct::sign(&d, &key(1)).unwrap_err(), Error::KeyMismatch);
}

#[test]
fn builder_refuses_bad_input() {
    let chain = &MAINNET.cosmos;
    let a = chain.address(&key(0).public_key());
    let inj = Coin::new("inj", "1").unwrap();
    assert!(matches!(builder::bank_send(chain, &a, &a, &[]), Err(Error::Amount(_))));
    assert!(matches!(
        builder::bank_send(chain, &a, &a, &[inj.clone(), inj.clone()]),
        Err(Error::Denom(_))
    ));
    for bad in ["0", "01", "1.5", ""] {
        assert!(
            matches!(builder::cw20_transfer(chain, &a, &a, &a, bad), Err(Error::Amount(_))),
            "{bad:?}"
        );
    }
    // Addresses must be canonical bech32 on this chain.
    let hex = key(0).public_key().eth_address().to_checksum_hex();
    for bad in [a.to_uppercase(), hex, a.replacen("inj", "cosmos", 1), String::new()] {
        assert_eq!(
            builder::bank_send(chain, &a, &bad, std::slice::from_ref(&inj)).unwrap_err(),
            Error::Address(bad.clone())
        );
    }
}
