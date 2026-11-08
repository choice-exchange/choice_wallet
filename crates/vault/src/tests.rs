//! End-to-end through the JSON protocol, against the injective-ts and viem vectors: what
//! a host gets back from `handle` must match the independent implementations byte for byte.

use std::sync::OnceLock;

use serde_json::{Value, json};

use super::handle;

fn vectors(name: &str) -> Value {
    let text = match name {
        "direct" => include_str!("../../injective/tests/vectors/direct.json"),
        "amino" => include_str!("../../injective/tests/vectors/amino.json"),
        "eip712_v2" => include_str!("../../injective/tests/vectors/eip712_v2.json"),
        "eip1559" => include_str!("../../evm/tests/vectors/eip1559.json"),
        "personal" => include_str!("../../evm/tests/vectors/personal.json"),
        "messages" => include_str!("../../injective/tests/vectors/messages.json"),
        _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
}

const PASSWORD: &str = "correct horse battery staple";

fn call(method: &str, params: Value) -> Result<Value, Value> {
    let out: Value = serde_json::from_str(&handle(&json!({ "method": method, "params": params }).to_string())).unwrap();
    if out["ok"] == true {
        Ok(out["result"].clone())
    } else {
        Err(out["error"].clone())
    }
}

fn ok(method: &str, params: Value) -> Value {
    call(method, params).unwrap_or_else(|e| panic!("{method}: {e}"))
}

fn code(method: &str, params: Value) -> String {
    call(method, params).expect_err(method)["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// One keystore for the test phrase, with its unlock key. Argon2 at full cost runs once.
fn wallet() -> &'static (String, String) {
    static W: OnceLock<(String, String)> = OnceLock::new();
    W.get_or_init(|| {
        let phrase = vectors("direct")["phrase"].as_str().unwrap().to_owned();
        let ks = ok(
            "create_keystore",
            json!({ "secret": { "mnemonic": phrase }, "password": PASSWORD }),
        );
        assert_eq!(ks["kind"], "mnemonic");
        let keystore = ks["keystore"].as_str().unwrap().to_owned();
        let unlock = ok("unlock", json!({ "keystore": keystore, "password": PASSWORD }));
        (keystore, unlock["unlock_key"].as_str().unwrap().to_owned())
    })
}

fn account(i: u32) -> Value {
    json!({ "derivation": "default", "index": i })
}

fn signer_key(i: u32) -> String {
    let (keystore, unlock_key) = wallet();
    let r = ok(
        "accounts",
        json!({ "keystore": keystore, "unlock_key": unlock_key, "accounts": [account(i)] }),
    );
    r["accounts"][0]["public_key"].as_str().unwrap().to_owned()
}

/// Decode, then sign with the digest decode returned.
fn approve_and_sign(request: &Value, acct: Value) -> Value {
    let (keystore, unlock_key) = wallet();
    let d = ok("decode", json!({ "request": request }));
    ok(
        "sign",
        json!({
            "keystore": keystore, "unlock_key": unlock_key, "account": acct,
            "request": request, "digest": d["digest"],
        }),
    )
}

fn coins(v: &Value) -> Value {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| json!({ "denom": c[0], "amount": c[1] }))
        .collect()
}

#[test]
fn basics() {
    assert_eq!(ok("version", json!({}))["protocol"], 1);
    let chains = ok("chains", Value::Null);
    assert_eq!(chains[0]["id"], "cosmos:injective-1");
    assert_eq!(chains[0]["pair"], "eip155:1776");
    assert_eq!(code("nope", json!({})), "unknown_method");
    let out: Value = serde_json::from_str(&handle("not json")).unwrap();
    assert_eq!(out["error"]["code"], "bad_request");
    assert_eq!(
        ok("generate_mnemonic", json!({ "words": 24 }))["phrase"]
            .as_str()
            .unwrap()
            .split(' ')
            .count(),
        24
    );
    assert_eq!(code("generate_mnemonic", json!({ "words": 13 })), "keystore");
}

#[test]
fn accounts_match_injective_ts() {
    let (keystore, unlock_key) = wallet();
    let r = ok(
        "accounts",
        json!({ "keystore": keystore, "unlock_key": unlock_key, "accounts": [account(0), account(1), account(2)] }),
    );
    for (i, want) in vectors("direct")["accounts"].as_array().unwrap().iter().enumerate() {
        let got = &r["accounts"][i];
        assert_eq!(got["public_key"], want["pubkey"], "{i}");
        assert_eq!(got["addresses"]["cosmos:injective-1"], want["inj"], "{i}");
        let eth = got["addresses"]["eip155:1776"].as_str().unwrap().to_lowercase();
        assert_eq!(eth, want["eth"].as_str().unwrap(), "{i}");
    }
    let wrong = code(
        "unlock",
        json!({ "keystore": keystore, "password": "not the password" }),
    );
    assert_eq!(wrong, "wrong_password");
    let imported = code(
        "accounts",
        json!({ "keystore": keystore, "unlock_key": unlock_key, "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(imported, "keystore");
}

fn own_cosmos(c: &Value) -> Value {
    let b = &c["build"];
    let msg = match b["kind"].as_str().unwrap() {
        "bank_send" => json!({ "type": "bank_send", "to": b["to"], "amount": coins(&b["coins"]) }),
        "cw20_transfer" => {
            json!({ "type": "cw20_transfer", "contract": b["cw20"], "to": b["recipient"], "amount": b["amount"] })
        }
        "cw20_to_bank" => json!({ "type": "cw20_to_bank", "contract": b["cw20"], "amount": b["amount"] }),
        "bank_to_cw20" => {
            json!({ "type": "bank_to_cw20", "contract": b["cw20"], "amount": b["amount"], "to": b["recipient"] })
        }
        other => panic!("{other}"),
    };
    let built = ok(
        "build_cosmos",
        json!({
            "chain": "cosmos:injective-1",
            "signer": signer_key(0),
            "messages": [msg],
            "account_number": c["account_number"],
            "sequence": c["sequence"].to_string(),
            "fee": { "amount": coins(&c["fee"]["amount"]), "gas_limit": c["fee"]["gas_limit"] },
            "memo": c["memo"],
            "timeout_height": c["timeout_height"],
        }),
    );
    // The simulation tx is the broadcast tx with an empty signature: field 3 is
    // `1a 40 <64 bytes>` there and `1a 00` here.
    if let Some(tx_raw) = c["tx_raw"].as_str()
        && built["request"]["cosmos_direct"]["body_bytes"] == c["body_bytes"]
    {
        let unsigned = &tx_raw[..tx_raw.len() - 2 * (2 + 64)];
        assert_eq!(built["simulate_tx"], format!("{unsigned}1a00"), "{}", c["name"]);
    }
    built["request"].clone()
}

#[test]
fn own_cosmos_sends_match_injective_ts() {
    for c in vectors("direct")["cases"].as_array().unwrap() {
        let name = &c["name"];
        let request = own_cosmos(c);
        assert_eq!(request["cosmos_direct"]["body_bytes"], c["body_bytes"], "{name}");
        let d = ok("decode", json!({ "request": request }));
        assert_eq!(
            d["display"]["signer"],
            vectors("direct")["accounts"][0]["inj"],
            "{name}"
        );
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["signature"], c["signature"], "{name}");
        assert_eq!(signed["tx_raw"], c["tx_raw"], "{name}");
    }
}

#[test]
fn approvals_bind_to_the_request_and_account() {
    let (keystore, unlock_key) = wallet();
    let c = &vectors("direct")["cases"][0];
    let request = own_cosmos(c);
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let sign = |request: &Value, acct: Value, digest: &Value| {
        code(
            "sign",
            json!({ "keystore": keystore, "unlock_key": unlock_key, "account": acct, "request": request, "digest": digest }),
        )
    };
    // Another account can't use this approval.
    assert_eq!(sign(&request, account(1), &digest), "wrong_account");
    // A changed request (the memo, here) doesn't match the approval.
    let mut other = c.clone();
    other["memo"] = "changed".into();
    assert_eq!(sign(&own_cosmos(&other), account(0), &digest), "not_approved");
    assert_eq!(sign(&request, account(0), &json!("00")), "not_approved");
    // A bad unlock key doesn't open the keystore.
    let bad = code(
        "sign",
        json!({ "keystore": keystore, "unlock_key": "00".repeat(32), "account": account(0), "request": request, "digest": digest }),
    );
    assert_eq!(bad, "wrong_password");
}

#[test]
fn dapp_amino_sign_docs_match_injective_ts() {
    for c in vectors("amino")["cases"].as_array().unwrap() {
        let request = json!({ "cosmos_amino": {
            "chain": "cosmos:injective-1",
            "signer": signer_key(0),
            "sign_doc": c["sign_doc"],
        }});
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["signature"], c["signature"], "{}", c["name"]);
        assert_eq!(signed["signed_doc"], c["sign_doc"], "{}", c["name"]);
    }
}

#[test]
fn injective_typed_data_matches_viem() {
    for c in vectors("eip712_v2")["cases"].as_array().unwrap() {
        let chain = if c["expect"]["chain_id"] == "injective-1" {
            "eip155:1776"
        } else {
            "eip155:1439"
        };
        let request = json!({ "evm_typed_data": {
            "chain": chain,
            "signer": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "typed_data": c["typed_data"],
        }});
        let d = ok("decode", json!({ "request": request }));
        assert!(d["display"]["injective_tx"]["messages"].is_array(), "{}", c["name"]);
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["signature"], c["signature"], "{}", c["name"]);
    }
}

#[test]
fn generic_typed_data_must_be_for_the_connected_chain() {
    let td = json!({
        "types": {
            "EIP712Domain": [{ "name": "name", "type": "string" }, { "name": "chainId", "type": "uint256" }],
            "Hello": [{ "name": "text", "type": "string" }],
        },
        "primaryType": "Hello",
        "domain": { "name": "Some Dapp", "chainId": 1 },
        "message": { "text": "hi" },
    });
    let request = |chain_id: u64| {
        let mut td = td.clone();
        td["domain"]["chainId"] = chain_id.into();
        json!({ "evm_typed_data": {
            "chain": "eip155:1776",
            "signer": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "typed_data": td.to_string(),
        }})
    };
    assert_eq!(code("decode", json!({ "request": request(1) })), "invalid");
    let d = ok("decode", json!({ "request": request(1776) }));
    assert_eq!(d["display"]["primary_type"], "Hello");
    assert!(d["display"]["injective_tx"].is_null());
}

#[test]
fn own_evm_sends_match_viem() {
    let v = vectors("eip1559");
    for c in v["cases"].as_array().unwrap() {
        let b = &c["build"];
        let chain = format!("eip155:{}", c["chain_id"]);
        let mut params = json!({
            "chain": chain,
            "from": v["from"],
            "to": b["to"],
            "amount": if b["kind"] == "native" { &b["value"] } else { &b["amount"] },
            "nonce": c["nonce"],
            "gas_limit": c["gas_limit"],
            "max_fee_per_gas": c["max_fee_per_gas"],
            "max_priority_fee_per_gas": c["max_priority_fee_per_gas"],
        });
        if b["kind"] == "erc20" {
            params["token"] = b["token"].clone();
        }
        let request = ok("build_evm", params)["request"].clone();
        let d = ok("decode", json!({ "request": request }));
        let expected_call = if b["kind"] == "native" {
            "transfer"
        } else {
            "erc20_transfer"
        };
        assert_eq!(d["display"]["call"]["type"], expected_call, "{}", c["name"]);
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["raw"], c["raw"], "{}", c["name"]);
        assert_eq!(signed["hash"], c["hash"], "{}", c["name"]);
    }
    // A dapp request from another account can't be signed by account 0.
    let mut request = ok(
        "build_evm",
        json!({
            "chain": "eip155:1776", "from": v["from"], "to": v["from"], "amount": "1",
            "nonce": 0, "gas_limit": 21000, "max_fee_per_gas": "1", "max_priority_fee_per_gas": "1",
        }),
    )["request"]
        .clone();
    request["evm_transaction"]["tx"]["from"] = "0x0000000000000000000000000000000000000001".into();
    let (keystore, unlock_key) = wallet();
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let err = code(
        "sign",
        json!({ "keystore": keystore, "unlock_key": unlock_key, "account": account(0), "request": request, "digest": digest }),
    );
    assert_eq!(err, "wrong_account");
}

#[test]
fn imported_keys() {
    // EIP-155's example key, published in the EIP.
    let key = "4646464646464646464646464646464646464646464646464646464646464646";
    let ks = ok(
        "create_keystore",
        json!({ "secret": { "private_key": key }, "password": PASSWORD }),
    );
    assert_eq!(ks["kind"], "private_key");
    let unlock = ok("unlock", json!({ "keystore": ks["keystore"], "password": PASSWORD }));
    let r = ok(
        "accounts",
        json!({ "keystore": ks["keystore"], "unlock_key": unlock["unlock_key"], "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(
        r["accounts"][0]["addresses"]["eip155:1776"],
        "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F"
    );
    let hd = code(
        "accounts",
        json!({ "keystore": ks["keystore"], "unlock_key": unlock["unlock_key"], "accounts": [account(0)] }),
    );
    assert_eq!(hd, "keystore");
    assert_eq!(
        code(
            "create_keystore",
            json!({ "secret": { "private_key": key }, "password": "short" })
        ),
        "keystore"
    );
}

#[test]
fn decoded_messages_are_shown() {
    let v = vectors("direct");
    let case = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "cw20_transfer")
        .unwrap();
    let request = own_cosmos(case);
    let d = ok("decode", json!({ "request": request }));
    let m = &d["display"]["messages"][0];
    assert_eq!(m["type"], "execute_contract", "{m}");
    assert_eq!(m["call"]["type"], "cw20_transfer", "{m}");
    assert_eq!(m["call"]["recipient"], v["accounts"][1]["inj"], "{m}");

    let text = request.to_string();
    let parsed: super::request::SignRequest = serde_json::from_str(&text).unwrap();
    let checked = super::request::decode(parsed).unwrap();
    assert_eq!(super::request::messages(&checked).unwrap().len(), 1);
}

#[test]
fn grants_come_back_red_with_a_word_to_type() {
    let tx = &vectors("messages")["tx"];
    let request = json!({ "cosmos_direct": {
        "chain": "cosmos:injective-1",
        "signer": signer_key(0),
        "body_bytes": tx["body_bytes"],
        "auth_info_bytes": tx["auth_info_bytes"],
        "account_number": tx["account_number"],
    }});
    let d = ok("decode", json!({ "request": request }));
    let risk = &d["risk"];
    assert_eq!(risk["level"], "red", "{risk}");
    assert_eq!(risk["confirm"], "GRANT", "{risk}");
    let rules: Vec<&str> = risk["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["rule"].as_str().unwrap())
        .collect();
    assert!(
        rules.contains(&"authz_grant") && rules.contains(&"authz_exec"),
        "{rules:?}"
    );
}

#[test]
fn context_changes_the_grade() {
    let request = own_cosmos(&vectors("direct")["cases"][0]); // sends 1.5 INJ
    let quiet = ok("decode", json!({ "request": request }));
    assert_eq!(quiet["risk"]["level"], "info");
    let context = json!({
        "origin": "https://example.org",
        "origin_known": true,
        "balances": { "inj": "2000000000000000000" },
    });
    let d = ok("decode", json!({ "request": request, "context": context }));
    assert_eq!(d["risk"]["level"], "amber");
    assert_eq!(d["risk"]["findings"][0]["rule"], "most_of_balance");
    // The digest doesn't depend on the context: the same approval signs either way.
    assert_eq!(d["digest"], quiet["digest"]);
    assert_eq!(
        code("decode", json!({ "request": request, "context": { "nope": 1 } })),
        "bad_request"
    );
}

#[test]
fn personal_sign_matches_viem_and_checks_sign_in() {
    let v = vectors("personal");
    for c in v["cases"].as_array().unwrap() {
        let request = json!({ "evm_personal_sign": {
            "chain": "eip155:1776", "signer": v["signer"], "message": c["message_hex"],
        }});
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["signature"], c["signature"], "{}", c["name"]);
    }
    let raw = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "raw_32_bytes")
        .unwrap();
    let request =
        json!({ "evm_personal_sign": { "chain": "eip155:1776", "signer": v["signer"], "message": raw["message_hex"] }});
    assert_eq!(ok("decode", json!({ "request": request }))["risk"]["level"], "red");

    let siwe = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "siwe")
        .unwrap();
    let request = json!({ "evm_personal_sign": { "chain": "eip155:1776", "signer": v["signer"], "message": siwe["message_hex"] }});
    let at = |origin: &str| {
        let d = ok(
            "decode",
            json!({ "request": request, "context": { "origin": origin, "origin_known": true } }),
        );
        d["risk"]["findings"][0]["rule"].as_str().unwrap().to_owned()
    };
    assert_eq!(at("https://example.org"), "sign_in");
    assert_eq!(at("https://example-login.org"), "sign_in_wrong_site");
    // Plain text is shown as text.
    let text = json!({ "evm_personal_sign": { "chain": "eip155:1776", "signer": v["signer"], "message": "hello" }});
    assert_eq!(ok("decode", json!({ "request": text }))["display"]["text"], "hello");
}

#[test]
fn grants_on_json_paths_get_the_same_treatment() {
    // EIP-712 v2 typed data carrying a grant, a fee grant and admin changes.
    let v = vectors("eip712_v2");
    let c = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "mainnet_grants_and_admin_changes")
        .unwrap();
    let request = json!({ "evm_typed_data": {
        "chain": "eip155:1776",
        "signer": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
        "typed_data": c["typed_data"],
    }});
    let risk = &ok("decode", json!({ "request": request }))["risk"];
    assert_eq!(
        (risk["level"].as_str(), risk["confirm"].as_str()),
        (Some("red"), Some("GRANT")),
        "{risk}"
    );
    let rules: Vec<&str> = risk["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["rule"].as_str().unwrap())
        .collect();
    for r in [
        "authz_grant",
        "fee_grant",
        "denom_admin",
        "contract_admin",
        "authz_revoke",
        "fee_revoke",
    ] {
        assert!(rules.contains(&r), "{r} missing from {rules:?}");
    }

    // The same grant as a dapp's signAmino sign doc.
    let m = vectors("messages")["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "authz_generic_grant")
        .unwrap()
        .clone();
    let doc = json!({
        "account_number": "1", "chain_id": "injective-1", "memo": "", "sequence": "0",
        "fee": { "amount": [], "gas": "200000" }, "msgs": [m["amino"]],
    });
    let request =
        json!({ "cosmos_amino": { "chain": "cosmos:injective-1", "signer": signer_key(0), "sign_doc": doc } });
    let risk = &ok("decode", json!({ "request": request }))["risk"];
    assert_eq!(risk["confirm"], "GRANT", "{risk}");
    assert_eq!(
        risk["findings"][0]["message"],
        "inj1d7…z8h8 could send ALL your tokens, until 2030-01-01."
    );
}
