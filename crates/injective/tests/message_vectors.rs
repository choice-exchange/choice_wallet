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
    let vote = Any {
        type_url: "/cosmos.gov.v1beta1.MsgVote".into(),
        value: vec![0x08, 0x01],
    };
    let msgs = decode(vec![exec(&a0, vec![vote.clone()])]).unwrap();
    assert!(
        matches!(&msgs[0], Msg::AuthzExec { msgs, .. } if msgs[0] == Msg::Unknown { type_url: vote.type_url.clone(), value: vote.value.clone() })
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
