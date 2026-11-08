//! Injective EIP-712 v2: typed data built by injective-ts, hashed and signed by viem
//! (`tools/vectors/gen.mjs`). We must decode it, hash it and sign it identically.

use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{EthAddress, Mnemonic, PrivateKey};
use choice_wallet_cosmos::cosmwasm::ContractCall;
use choice_wallet_cosmos::msg::Msg;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_injective::Error;
use choice_wallet_injective::chain::{MAINNET, Network, TESTNET};
use choice_wallet_injective::eip712::{Web3Tx, decode_v2};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/eip712_v2.json")).unwrap()
}

fn key(i: u32) -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(i)).unwrap()
}

fn signer() -> EthAddress {
    key(0).public_key().eth_address()
}

fn case(name: &str) -> Value {
    vectors()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
        .clone()
}

fn network_for(c: &Value) -> Network {
    if c["expect"]["chain_id"] == "injective-1" {
        MAINNET
    } else {
        TESTNET
    }
}

fn decode(json: &str, network: &Network) -> Result<Option<Web3Tx>, Error> {
    decode_v2(&TypedData::parse(json).unwrap(), network, &signer())
}

#[test]
fn decodes_hashes_and_signs_like_injective_ts_and_viem() {
    let k = key(0);
    for c in vectors()["cases"].as_array().unwrap() {
        let name = &c["name"];
        let json = c["typed_data"].as_str().unwrap();
        let td = TypedData::parse(json).unwrap();
        assert_eq!(
            format!("0x{}", hex::encode(td.hash().unwrap())),
            c["hash"].as_str().unwrap(),
            "{name} hash"
        );
        assert_eq!(
            format!("0x{}", hex::encode(td.sign(&k).unwrap())),
            c["signature"].as_str().unwrap(),
            "{name} signature"
        );

        let tx = decode_v2(&td, &network_for(c), &signer()).unwrap().unwrap();
        let e = &c["expect"];
        assert_eq!(tx.evm_chain_id, e["evm_chain_id"].as_u64().unwrap(), "{name}");
        assert_eq!(tx.chain_id, e["chain_id"].as_str().unwrap(), "{name}");
        assert_eq!(tx.account_number, e["account_number"].as_u64().unwrap(), "{name}");
        assert_eq!(tx.sequence, e["sequence"].as_u64().unwrap(), "{name}");
        assert_eq!(tx.timeout_height, e["timeout_height"].as_u64().unwrap(), "{name}");
        assert_eq!(tx.memo, e["memo"].as_str().unwrap(), "{name}");
        assert_eq!(tx.fee.payer.as_deref(), e["fee_payer"].as_str(), "{name}");
        assert_eq!(tx.messages.len() as u64, e["messages"].as_u64().unwrap(), "{name}");
        assert!(
            tx.messages.iter().all(|m| !matches!(m, Msg::UnknownJson { .. })),
            "{name}: every message recognised"
        );
    }
}

#[test]
fn recognises_the_messages() {
    let c = case("mainnet_send_and_cw20_transfer");
    let tx = decode(c["typed_data"].as_str().unwrap(), &MAINNET).unwrap().unwrap();
    let a1 = key(1).public_key().eth_address().to_inj();
    assert!(
        matches!(&tx.messages[0], Msg::BankSend { to, amount, .. } if *to == a1 && amount[0].amount() == "1000000000000000000")
    );
    assert!(matches!(
        &tx.messages[1],
        Msg::ExecuteContract { call: ContractCall::Cw20Transfer { recipient, amount }, .. } if *recipient == a1 && amount == "5"
    ));

    let c = case("mainnet_eth_chain_id_fee_delegation");
    let tx = decode(c["typed_data"].as_str().unwrap(), &MAINNET).unwrap().unwrap();
    assert!(matches!(
        &tx.messages[0],
        Msg::ExecuteContract {
            call: ContractCall::Cw20Send { .. },
            ..
        }
    ));
}

/// Edit the typed data JSON, or the context / msgs JSON strings inside it.
fn edited(name: &str, f: impl FnOnce(&mut Value, &mut Value, &mut Value)) -> String {
    let c = case(name);
    let mut td: Value = serde_json::from_str(c["typed_data"].as_str().unwrap()).unwrap();
    let mut ctx: Value = serde_json::from_str(td["message"]["context"].as_str().unwrap()).unwrap();
    let mut msgs: Value = serde_json::from_str(td["message"]["msgs"].as_str().unwrap()).unwrap();
    f(&mut td, &mut ctx, &mut msgs);
    td["message"]["context"] = ctx.to_string().into();
    td["message"]["msgs"] = msgs.to_string().into();
    td.to_string()
}

const SEND: &str = "mainnet_send_and_cw20_transfer";

#[test]
fn other_typed_data_is_not_claimed() {
    let json = edited(SEND, |td, _, _| td["domain"]["name"] = "Some Dapp".into());
    assert_eq!(decode(&json, &MAINNET).unwrap(), None);
}

#[test]
fn refuses_wrong_chains() {
    let c = case(SEND);
    assert!(matches!(
        decode(c["typed_data"].as_str().unwrap(), &TESTNET),
        Err(Error::WrongChain { .. })
    ));
    let json = edited(SEND, |td, _, _| td["domain"]["chainId"] = "0x59f".into()); // 1439 on mainnet
    assert!(matches!(decode(&json, &MAINNET), Err(Error::WrongChain { .. })));
    let json = edited(SEND, |_, ctx, _| ctx["chain_id"] = "injective-888".into());
    assert!(matches!(decode(&json, &MAINNET), Err(Error::WrongChain { .. })));
}

#[test]
fn refuses_lookalike_domains_and_types() {
    let lookalikes: [fn(&mut Value); 4] = [
        |td| td["domain"]["version"] = "2.0.0".into(),
        |td| td["domain"]["salt"] = "1".into(),
        |td| td["domain"]["verifyingContract"] = "0x0000000000000000000000000000000000000001".into(),
        |td| {
            td["types"]["Tx"][1]["name"] = "messages".into();
            let msgs = td["message"].as_object_mut().unwrap().remove("msgs").unwrap();
            td["message"]["messages"] = msgs;
        },
    ];
    for f in lookalikes {
        let mut td: Value = serde_json::from_str(case(SEND)["typed_data"].as_str().unwrap()).unwrap();
        f(&mut td);
        let parsed = TypedData::parse(&td.to_string()).expect("still valid typed data");
        assert!(
            matches!(decode_v2(&parsed, &MAINNET, &signer()), Err(Error::Eip712(_))),
            "{td}"
        );
    }
}

#[test]
fn refuses_unexpected_context_and_foreign_signers() {
    let json = edited(SEND, |_, ctx, _| ctx["extra"] = 1.into());
    assert!(matches!(decode(&json, &MAINNET), Err(Error::Eip712(_))));
    let json = edited(SEND, |_, ctx, _| ctx["fee"]["granter"] = "inj1x".into());
    assert!(matches!(decode(&json, &MAINNET), Err(Error::Eip712(_))));
    let other = key(1).public_key().eth_address().to_inj();
    let json = edited(SEND, |_, _, msgs| msgs[0]["from_address"] = other.clone().into());
    assert!(matches!(decode(&json, &MAINNET), Err(Error::ForeignSigner(_))));
    let json = edited(SEND, |_, _, msgs| *msgs = Value::Array(vec![]));
    assert_eq!(decode(&json, &MAINNET).unwrap_err(), Error::NoMessages);
}

#[test]
fn unexpected_message_fields_or_types_are_kept_raw() {
    let json = edited(SEND, |_, _, msgs| msgs[0]["extra"] = 1.into());
    let tx = decode(&json, &MAINNET).unwrap().unwrap();
    assert!(matches!(&tx.messages[0], Msg::UnknownJson { type_url, .. } if type_url == "/cosmos.bank.v1beta1.MsgSend"));
    let json = edited(SEND, |_, _, msgs| {
        msgs[0]["@type"] = "/cosmos.authz.v1beta1.MsgGrant".into()
    });
    let tx = decode(&json, &MAINNET).unwrap().unwrap();
    assert!(matches!(&tx.messages[0], Msg::UnknownJson { .. }));
}
