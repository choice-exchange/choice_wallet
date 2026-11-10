//! Grants, allowances, admin changes and rewards, encoded by injective-ts
//! (`tools/vectors/gen.mjs`). The decoder must accept the exact bytes, read the same
//! fields, and recurse into every nested `Any`.

use choice_wallet_core::hd::{derive, injective_path};
use choice_wallet_core::{Mnemonic, PrivateKey};
use choice_wallet_cosmos::builder::{self, Fee, TxOptions};
use choice_wallet_cosmos::direct::{self, Request};
use choice_wallet_cosmos::msg::{Allowance, Authorization, Coin, Msg};
use choice_wallet_cosmos::proto::cosmos::authz::v1beta1::{GenericAuthorization, Grant, MsgExec, MsgGrant};
use choice_wallet_cosmos::proto::cosmos::bank::v1beta1::MsgSend;
use choice_wallet_cosmos::proto::cosmos::base::v1beta1::Coin as ProtoCoin;
use choice_wallet_cosmos::wkt::Any;
use choice_wallet_injective::Error;
use choice_wallet_injective::chain::MAINNET;
use prost::{Message, Name};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/messages.json")).unwrap()
}

fn key(i: u32) -> PrivateKey {
    let m = Mnemonic::parse(vectors()["phrase"].as_str().unwrap()).unwrap();
    derive(&m, &injective_path(i)).unwrap()
}

fn addr(name: &str) -> String {
    vectors()["addresses"][name].as_str().unwrap().to_owned()
}

fn inj(amount: &str) -> Vec<Coin> {
    vec![Coin::new("inj", amount).unwrap()]
}

fn opts() -> TxOptions {
    TxOptions {
        account_number: 12345,
        sequence: 1,
        fee: Fee {
            amount: inj("160000000000000"),
            gas_limit: 160000,
            granter: None,
        },
        memo: String::new(),
        timeout_height: 0,
    }
}

/// Decode `msgs` as the body of a Direct transaction signed by account 0.
fn decode(msgs: Vec<Any>) -> Result<Vec<Msg>, Error> {
    let req = builder::direct_request(&MAINNET.cosmos, &key(0).public_key(), msgs, &opts()).unwrap();
    Ok(direct::decode(req, &MAINNET.cosmos, &key(0).public_key())?
        .messages()
        .to_vec())
}

fn vector(name: &str) -> (Any, Value) {
    let v = vectors();
    let m = v["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == name)
        .unwrap()
        .clone();
    let any = Any {
        type_url: m["type_url"].as_str().unwrap().into(),
        value: hex::decode(m["value"].as_str().unwrap()).unwrap(),
    };
    (any, m)
}

fn decoded(name: &str) -> Msg {
    let (any, _) = vector(name);
    let mut msgs = decode(vec![any]).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(msgs.len(), 1);
    msgs.remove(0)
}

const SEND_URL: &str = "/cosmos.bank.v1beta1.MsgSend";

#[test]
fn every_message_decodes_exactly() {
    let (a0, a1, a2) = (addr("a0"), addr("a1"), addr("a2"));
    let expiry = vectors()["expiry"].as_i64().unwrap();
    let (_, grant) = vector("authz_generic_grant");
    let grant_expiry = grant["grant_expiration"].as_i64();
    assert_eq!(grant_expiry, Some(expiry));

    let expected = [
        (
            "authz_generic_grant",
            Msg::AuthzGrant {
                granter: a0.clone(),
                grantee: a1.clone(),
                authorization: Authorization::Generic {
                    msg_type_url: SEND_URL.into(),
                },
                expiration: grant_expiry,
            },
        ),
        (
            "authz_send_grant",
            Msg::AuthzGrant {
                granter: a0.clone(),
                grantee: a1.clone(),
                authorization: Authorization::Send {
                    spend_limit: inj("5000"),
                    allow_list: vec![a2.clone()],
                },
                expiration: grant_expiry,
            },
        ),
        (
            "authz_exec_send",
            Msg::AuthzExec {
                grantee: a0.clone(),
                msgs: vec![Msg::BankSend {
                    from: a1.clone(),
                    to: a0.clone(),
                    amount: inj("42"),
                }],
            },
        ),
        (
            "authz_revoke",
            Msg::AuthzRevoke {
                granter: a0.clone(),
                grantee: a1.clone(),
                msg_type_url: SEND_URL.into(),
            },
        ),
        (
            "feegrant_revoke",
            Msg::FeeRevoke {
                granter: a0.clone(),
                grantee: a1.clone(),
            },
        ),
        (
            "withdraw_rewards",
            Msg::WithdrawRewards {
                delegator: a0.clone(),
                validator: addr("valoper"),
            },
        ),
        (
            "set_withdraw_address",
            Msg::SetWithdrawAddress {
                delegator: a0.clone(),
                withdraw_address: a1.clone(),
            },
        ),
        (
            "tokenfactory_change_admin",
            Msg::TokenfactoryChangeAdmin {
                type_url: "/injective.tokenfactory.v1beta1.MsgChangeAdmin".into(),
                sender: a0.clone(),
                denom: format!("factory/{a0}/test"),
                new_admin: a1.clone(),
            },
        ),
        (
            "wasm_update_admin",
            Msg::WasmUpdateAdmin {
                sender: a0.clone(),
                contract: a2.clone(),
                new_admin: a1.clone(),
            },
        ),
        (
            "wasm_clear_admin",
            Msg::WasmClearAdmin {
                sender: a0.clone(),
                contract: a2.clone(),
            },
        ),
    ];
    for (name, want) in expected {
        let got = decoded(name);
        assert_eq!(got, want, "{name}");
        assert_eq!(got.type_url(), vector(name).0.type_url, "{name}");
    }

    // The fee grant's expiration units are whatever sdk-ts wrote; check the rest exactly.
    let Msg::FeeGrant {
        granter,
        grantee,
        allowance: Allowance::Basic {
            spend_limit,
            expiration,
        },
    } = decoded("feegrant_basic")
    else {
        panic!("expected a basic fee grant");
    };
    assert_eq!((granter, grantee, spend_limit), (a0, a1, inj("1000")));
    assert!(expiration.is_some());
}

#[test]
fn full_transaction_with_exec_and_grant() {
    let v = vectors();
    let req = Request {
        body_bytes: hex::decode(v["tx"]["body_bytes"].as_str().unwrap()).unwrap(),
        auth_info_bytes: hex::decode(v["tx"]["auth_info_bytes"].as_str().unwrap()).unwrap(),
        chain_id: "injective-1".into(),
        account_number: 12345,
    };
    let d = direct::decode(req, &MAINNET.cosmos, &key(0).public_key()).unwrap();
    assert!(matches!(&d.messages()[0], Msg::AuthzExec { msgs, .. } if matches!(msgs[0], Msg::BankSend { .. })));
    assert!(matches!(
        &d.messages()[1],
        Msg::AuthzGrant {
            authorization: Authorization::Generic { .. },
            ..
        }
    ));
}

fn send(from: &str, to: &str) -> Any {
    Any::pack(&MsgSend {
        from_address: from.into(),
        to_address: to.into(),
        amount: vec![ProtoCoin {
            denom: "inj".into(),
            amount: "1".into(),
        }],
    })
}

fn exec(grantee: &str, msgs: Vec<Any>) -> Any {
    Any::pack(&MsgExec {
        grantee: grantee.into(),
        msgs,
    })
}

#[test]
fn nested_messages_are_checked_too() {
    let (a0, a1) = (addr("a0"), addr("a1"));

    // A non-canonical inner MsgSend is refused, even inside MsgExec.
    let mut inner = send(&a1, &a0);
    inner.value.extend_from_slice(&[0x20, 0x01]);
    assert_eq!(
        decode(vec![exec(&a0, vec![inner])]).unwrap_err(),
        Error::NonCanonical("MsgSend")
    );

    // Unknown inner messages are kept raw, not dropped.
    let deposit = Any {
        type_url: "/cosmos.gov.v1beta1.MsgDeposit".into(),
        value: vec![0x08, 0x01],
    };
    let msgs = decode(vec![exec(&a0, vec![deposit.clone()])]).unwrap();
    assert!(
        matches!(&msgs[0], Msg::AuthzExec { msgs, .. } if msgs[0] == Msg::Unknown { type_url: deposit.type_url.clone(), value: deposit.value.clone() })
    );

    // One level of nesting is fine, three is refused, and an empty exec is refused.
    assert!(decode(vec![exec(&a0, vec![exec(&a0, vec![send(&a1, &a0)])])]).is_ok());
    let deep = exec(&a0, vec![exec(&a0, vec![exec(&a0, vec![send(&a1, &a0)])])]);
    assert!(matches!(decode(vec![deep]), Err(Error::Decode(_))));
    assert_eq!(decode(vec![exec(&a0, vec![])]).unwrap_err(), Error::NoMessages);

    // A grant whose authorization isn't canonical is refused.
    let mut auth = Any::pack(&GenericAuthorization { msg: SEND_URL.into() });
    auth.value.extend_from_slice(&[0x10, 0x01]);
    let grant = Any::pack(&MsgGrant {
        granter: a0.clone(),
        grantee: a1.clone(),
        grant: Some(Grant {
            authorization: Some(auth),
            expiration: None,
        }),
    });
    assert_eq!(
        decode(vec![grant]).unwrap_err(),
        Error::NonCanonical("GenericAuthorization")
    );

    // A grant without its grant field is refused.
    let empty = Any {
        type_url: MsgGrant::type_url(),
        value: MsgGrant {
            granter: a0.clone(),
            grantee: a1.clone(),
            grant: None,
        }
        .encode_to_vec(),
    };
    assert!(matches!(decode(vec![empty]), Err(Error::Decode(_))));
}

#[test]
fn grants_from_another_account_are_refused() {
    let (a0, a1) = (addr("a0"), addr("a1"));
    let grant = Any::pack(&MsgGrant {
        granter: a1.clone(),
        grantee: a0,
        grant: Some(Grant {
            authorization: Some(Any::pack(&GenericAuthorization { msg: SEND_URL.into() })),
            expiration: None,
        }),
    });
    assert_eq!(decode(vec![grant]).unwrap_err(), Error::ForeignSigner(a1));
}

/// The amino JSON (`signAmino`, Ledger) and protobuf JSON (EIP-712 v2) forms sdk-ts gives
/// each message must decode to exactly what the protobuf path decodes.
#[test]
fn json_paths_agree_with_the_protobuf_path() {
    let v = vectors();
    let chain = &MAINNET.cosmos;
    let mut checked = 0;
    for m in v["messages"].as_array().unwrap() {
        let name = m["name"].as_str().unwrap();
        let want = decoded(name);
        if m["web3"].is_object() {
            let got = Msg::from_proto_json(&m["web3"].to_string(), chain).unwrap();
            assert_eq!(got, want, "{name} protobuf JSON");
            checked += 1;
        }
        if m["amino"].is_object() {
            let doc = serde_json::json!({
                "account_number": "1", "chain_id": "injective-1", "memo": "", "sequence": "0",
                "fee": { "amount": [], "gas": "200000" },
                "msgs": [m["amino"]],
            });
            let tx =
                choice_wallet_cosmos::amino::decode_sign_doc(&doc.to_string(), chain, &key(0).public_key()).unwrap();
            assert_eq!(tx.messages, [want], "{name} amino JSON");
            checked += 1;
        }
    }
    assert_eq!(checked, 16, "8 messages have both forms");
}

/// Messages sdk-ts has no JSON form for, written by hand from the x/tx rules (protobuf
/// field names, amino names from the protos, timestamps as RFC 3339).
#[test]
fn hand_written_json_forms() {
    let chain = &MAINNET.cosmos;
    let (a0, a1, a2) = (addr("a0"), addr("a1"), addr("a2"));
    let cases = [
        (
            serde_json::json!({ "@type": "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress", "delegator_address": a0, "withdraw_address": a1 }),
            serde_json::json!({ "type": "cosmos-sdk/MsgModifyWithdrawAddress", "value": { "delegator_address": a0, "withdraw_address": a1 } }),
            decoded("set_withdraw_address"),
        ),
        (
            serde_json::json!({ "@type": "/cosmwasm.wasm.v1.MsgClearAdmin", "sender": a0, "contract": a2 }),
            serde_json::json!({ "type": "wasm/MsgClearAdmin", "value": { "sender": a0, "contract": a2 } }),
            decoded("wasm_clear_admin"),
        ),
        (
            serde_json::json!({ "@type": "/cosmos.authz.v1beta1.MsgGrant", "granter": a0, "grantee": a1, "grant": {
                "authorization": { "@type": "/cosmos.bank.v1beta1.SendAuthorization", "spend_limit": [{ "denom": "inj", "amount": "5000" }], "allow_list": [a2] },
                "expiration": "2030-01-01T00:00:00Z" } }),
            serde_json::json!({ "type": "cosmos-sdk/MsgGrant", "value": { "granter": a0, "grantee": a1, "grant": {
                "authorization": { "type": "cosmos-sdk/SendAuthorization", "value": { "spend_limit": [{ "denom": "inj", "amount": "5000" }], "allow_list": [a2] } },
                "expiration": "2030-01-01T00:00:00Z" } } }),
            decoded("authz_send_grant"),
        ),
    ];
    for (proto, amino_form, want) in cases {
        assert_eq!(
            Msg::from_proto_json(&proto.to_string(), chain).unwrap(),
            want,
            "{proto}"
        );
        let doc = serde_json::json!({
            "account_number": "1", "chain_id": "injective-1", "memo": "", "sequence": "0",
            "fee": { "amount": [], "gas": "200000" }, "msgs": [amino_form],
        });
        let tx = choice_wallet_cosmos::amino::decode_sign_doc(&doc.to_string(), chain, &key(0).public_key()).unwrap();
        assert_eq!(tx.messages, [want], "{amino_form}");
    }

    // A grant of a kind we can't read is still a grant (the risk rules see it), and a grant
    // with an extra field is kept raw instead.
    let odd = serde_json::json!({ "@type": "/cosmos.authz.v1beta1.MsgGrant", "granter": a0, "grantee": a1,
        "grant": { "authorization": { "@type": "/cosmos.staking.v1beta1.StakeAuthorization", "max_tokens": null } } });
    assert!(matches!(
        Msg::from_proto_json(&odd.to_string(), chain).unwrap(),
        Msg::AuthzGrant {
            authorization: Authorization::Unknown { .. },
            expiration: None,
            ..
        }
    ));
    let mut extra = odd.clone();
    extra["memo"] = "x".into();
    assert!(matches!(
        Msg::from_proto_json(&extra.to_string(), chain).unwrap(),
        Msg::UnknownJson { .. }
    ));
    // Bad timestamps and coins are errors, not unusual messages.
    let mut late = odd;
    late["grant"]["expiration"] = "2030-01-01".into();
    assert!(Msg::from_proto_json(&late.to_string(), chain).is_err());
}
