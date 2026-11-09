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
        "adr36" => include_str!("../../injective/tests/vectors/adr36.json"),
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

/// One vault holding the test phrase as wallet "w1": the vault, the sealed phrase and the
/// unlock key. Argon2 at full cost runs once.
fn wallet() -> &'static (String, String, String) {
    static W: OnceLock<(String, String, String)> = OnceLock::new();
    W.get_or_init(|| {
        let phrase = vectors("direct")["phrase"].as_str().unwrap().to_owned();
        let v = ok("create_vault", json!({ "password": PASSWORD }));
        let vault = v["vault"].as_str().unwrap().to_owned();
        let unlock_key = v["unlock_key"].as_str().unwrap().to_owned();
        let sealed = ok("seal_secret", json!({ "unlock_key": unlock_key, "wallet": "w1", "secret": { "mnemonic": phrase } }));
        assert_eq!(sealed["kind"], "mnemonic");
        (vault, sealed["secret"].as_str().unwrap().to_owned(), unlock_key)
    })
}

fn account(i: u32) -> Value {
    json!({ "derivation": "default", "index": i })
}

fn signer_key(i: u32) -> String {
    let (_, secret, unlock_key) = wallet();
    let r = ok(
        "accounts",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "accounts": [account(i)] }),
    );
    r["accounts"][0]["public_key"].as_str().unwrap().to_owned()
}

/// Decode, then sign with the digest decode returned.
fn approve_and_sign(request: &Value, acct: Value) -> Value {
    let (_, secret, unlock_key) = wallet();
    let d = ok("decode", json!({ "request": request }));
    ok(
        "sign",
        json!({
            "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "account": acct,
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

/// A fresh vault with one wallet, "w1", holding `secret`: (vault, sealed secret, unlock key).
fn vault_with(secret: Value) -> (Value, Value, Value) {
    let v = ok("create_vault", json!({ "password": PASSWORD }));
    let sealed = ok("seal_secret", json!({ "unlock_key": v["unlock_key"], "wallet": "w1", "secret": secret }));
    (v["vault"].clone(), sealed["secret"].clone(), v["unlock_key"].clone())
}

#[test]
fn several_wallets_behind_one_password() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (vault, a, uk) = vault_with(json!({ "mnemonic": phrase }));
    let b = ok("seal_secret", json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": "46".repeat(32) } }));
    assert_eq!(b["kind"], "private_key");
    // One unlock opens both.
    let key = ok("unlock", json!({ "vault": vault, "password": PASSWORD }))["unlock_key"].clone();
    assert_eq!(key, uk);
    let first = ok("accounts", json!({ "secret": a, "wallet": "w1", "unlock_key": key, "accounts": [account(0)] }));
    assert_eq!(first["accounts"][0]["addresses"]["eip155:1776"], "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    let imported = ok("accounts", json!({ "secret": b["secret"], "wallet": "w2", "unlock_key": key, "accounts": [{ "derivation": "imported" }] }));
    assert_eq!(imported["accounts"][0]["addresses"]["eip155:1776"], "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F");
    // A secret opens only as the wallet it was sealed for.
    assert_eq!(code("accounts", json!({ "secret": a, "wallet": "w2", "unlock_key": key, "accounts": [account(0)] })), "wrong_password");
    assert_eq!(code("seal_secret", json!({ "unlock_key": key, "wallet": "W 1", "secret": { "mnemonic": phrase } })), "keystore");
}

#[test]
fn reveal_needs_the_password_and_shows_the_phrase_or_a_key() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (vault, sealed, uk) = vault_with(json!({ "mnemonic": phrase }));
    let reveal = |extra: Value| {
        let mut p = json!({ "vault": vault, "password": PASSWORD, "secret": sealed, "wallet": "w1" });
        p.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        p
    };
    assert_eq!(ok("reveal", reveal(json!({})))["phrase"], phrase);
    // The second account's key (m/44'/60'/0'/0/1, the published test phrase's 0x6Fac…b9C0),
    // sealed on its own, is that account.
    let key = ok("reveal", reveal(json!({ "account": { "derivation": "default", "index": 1 } })))["private_key"].as_str().unwrap().to_owned();
    assert_eq!(key.len(), 64);
    let b = ok("seal_secret", json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": key } }));
    let a = ok("accounts", json!({ "secret": b["secret"], "wallet": "w2", "unlock_key": uk, "accounts": [{ "derivation": "imported" }] }));
    assert_eq!(a["accounts"][0]["addresses"]["eip155:1776"], "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0");
    assert_eq!(ok("reveal", json!({ "vault": vault, "password": PASSWORD, "secret": b["secret"], "wallet": "w2" }))["private_key"], key);
    assert_eq!(code("reveal", reveal(json!({ "password": "not the password" }))), "wrong_password");
    // The unlock key alone isn't enough: the method takes no such field.
    assert_eq!(code("reveal", json!({ "vault": vault, "unlock_key": uk, "secret": sealed, "wallet": "w1" })), "bad_request");
}

#[test]
fn change_password_rewraps_the_vault_and_keeps_its_key() {
    let (vault, sealed, uk) = vault_with(json!({ "private_key": "46".repeat(32) }));
    let next = ok("change_password", json!({ "vault": vault, "password": PASSWORD, "new_password": "a whole new password" }))["vault"].clone();
    assert_ne!(next, vault);
    assert_eq!(code("unlock", json!({ "vault": next, "password": PASSWORD })), "wrong_password");
    assert_eq!(ok("unlock", json!({ "vault": next, "password": "a whole new password" }))["unlock_key"], uk);
    let shown = ok("reveal", json!({ "vault": next, "password": "a whole new password", "secret": sealed, "wallet": "w1" }));
    assert_eq!(shown["private_key"], "46".repeat(32));
    assert_eq!(code("change_password", json!({ "vault": vault, "password": "wrong one", "new_password": "a whole new password" })), "wrong_password");
    assert_eq!(code("change_password", json!({ "vault": vault, "password": PASSWORD, "new_password": "short" })), "keystore");
}

#[test]
fn addresses_of_an_account_on_every_chain() {
    // The BIP-39 test phrase's first account, given either way.
    let want = json!({
        "cosmos:injective-1": "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz",
        "eip155:1776": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
        "cosmos:injective-888": "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz",
        "eip155:1439": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    });
    for a in [
        "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz",
        " 0x9858effd232b4033e47d90003d41ec34ecaeda94 ",
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    ] {
        assert_eq!(ok("addresses", json!({ "address": a }))["addresses"], want, "{a}");
    }
    // 32 bytes (a contract's length), another chain's prefix, a bad bech32 checksum, a bad
    // EIP-55 checksum (one letter's case flipped), junk.
    for a in [
        "inj1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sax6t9f",
        "cosmos1npvwllfr9dqr8erajqqr6s0vxnk2ak55fsjtl6",
        "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dy",
        "0x9858efFD232B4033E47d90003D41EC34EcaEda94",
        "hello",
    ] {
        assert_eq!(code("addresses", json!({ "address": a })), "bad_request", "{a}");
    }
}

#[test]
fn basics() {
    assert_eq!(ok("version", json!({}))["protocol"], 2);
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
    let (vault, secret, unlock_key) = wallet();
    let r = ok(
        "accounts",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "accounts": [account(0), account(1), account(2)] }),
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
        json!({ "vault": vault, "password": "not the password" }),
    );
    assert_eq!(wrong, "wrong_password");
    let imported = code(
        "accounts",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "accounts": [{ "derivation": "imported" }] }),
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
    let (_, secret, unlock_key) = wallet();
    let c = &vectors("direct")["cases"][0];
    let request = own_cosmos(c);
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let sign = |request: &Value, acct: Value, digest: &Value| {
        code(
            "sign",
            json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "account": acct, "request": request, "digest": digest }),
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
        json!({ "secret": secret, "wallet": "w1", "unlock_key": "00".repeat(32), "account": account(0), "request": request, "digest": digest }),
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
    let (_, secret, unlock_key) = wallet();
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let err = code(
        "sign",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "account": account(0), "request": request, "digest": digest }),
    );
    assert_eq!(err, "wrong_account");
}

#[test]
fn imported_keys() {
    // EIP-155's example key, published in the EIP.
    let key = "4646464646464646464646464646464646464646464646464646464646464646";
    let (_, sealed, uk) = vault_with(json!({ "private_key": key }));
    let r = ok(
        "accounts",
        json!({ "secret": sealed, "wallet": "w1", "unlock_key": uk, "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(r["accounts"][0]["addresses"]["eip155:1776"], "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F");
    let hd = code(
        "accounts",
        json!({ "secret": sealed, "wallet": "w1", "unlock_key": uk, "accounts": [account(0)] }),
    );
    assert_eq!(hd, "keystore");
    assert_eq!(code("create_vault", json!({ "password": "short" })), "keystore");
    assert_eq!(code("seal_secret", json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": "00".repeat(32) } })), "keystore");
}

#[test]
fn a_keystore_from_before_vaults_moves_into_one() {
    // A v1 keystore as the extension stored it before vaults: the secret sealed under the
    // password itself (made here with the core, at its fastest cost).
    use choice_wallet_core::keystore::{self, KdfParams, Secret};
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let old = keystore::seal(
        &Secret::Mnemonic(choice_wallet_core::Mnemonic::parse(phrase).unwrap()),
        PASSWORD.as_bytes(),
        KdfParams::MINIMUM,
    )
    .unwrap();
    let old = choice_wallet_core::hexutil::encode(&old);
    assert_eq!(code("migrate", json!({ "keystore": old, "password": "not the password", "wallet": "w1" })), "wrong_password");
    let m = ok("migrate", json!({ "keystore": old, "password": PASSWORD, "wallet": "w1" }));
    assert_eq!(m["kind"], "mnemonic");
    assert_eq!(ok("unlock", json!({ "vault": m["vault"], "password": PASSWORD }))["unlock_key"], m["unlock_key"]);
    let a = ok("accounts", json!({ "secret": m["secret"], "wallet": "w1", "unlock_key": m["unlock_key"], "accounts": [account(0)] }));
    assert_eq!(a["accounts"][0]["addresses"]["eip155:1776"], "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
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
fn the_signed_memo_meets_the_exchange_rules() {
    let case = &vectors("direct")["cases"][0];
    let to = case["build"]["to"].as_str().unwrap();
    let book = json!({ "address_book": [{ "address": to, "name": "Exchange", "memo": "101234567" }] });
    let rules = |memo: &str| {
        let mut c = case.clone();
        c["memo"] = memo.into();
        c["tx_raw"] = Value::Null;
        let d = ok("decode", json!({ "request": own_cosmos(&c), "context": book }));
        let found: Vec<String> = d["risk"]["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["rule"].as_str().unwrap().to_owned())
            .collect();
        (d["risk"]["level"].as_str().unwrap().to_owned(), found)
    };
    assert_eq!(rules("101234567"), ("info".into(), vec!["address_book".into()]));
    assert_eq!(rules("").0, "red");
    assert!(rules("").1.contains(&"memo_missing".to_owned()));
    assert_eq!(rules("7").0, "amber");
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

/// Test validators (fixed bytes, not real ones).
const VAL_A: &str = "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q";
const VAL_B: &str = "injvaloper1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz7c964k";

fn build_staking(messages: Value, sign_mode: &str) -> Result<Value, Value> {
    call(
        "build_cosmos",
        json!({
            "chain": "cosmos:injective-1",
            "signer": signer_key(0),
            "messages": messages,
            "account_number": "17",
            "sequence": "3",
            "fee": { "amount": [{ "denom": "inj", "amount": "20000000000000" }], "gas_limit": "250000" },
            "sign_mode": sign_mode,
        }),
    )
}

#[test]
fn own_staking_builds_decodes_and_signs_both_ways() {
    let inj = |a: &str| json!({ "denom": "inj", "amount": a });
    let messages = json!([
        { "type": "delegate", "validator": VAL_A, "amount": inj("5000000000000000000") },
        { "type": "undelegate", "validator": VAL_A, "amount": inj("1000000000000000000") },
        { "type": "redelegate", "from": VAL_A, "to": VAL_B, "amount": inj("2") },
        { "type": "cancel_unbonding", "validator": VAL_B, "amount": inj("7"), "height": "1234" },
        { "type": "withdraw_rewards", "validator": VAL_A },
    ]);
    let me = vectors("direct")["accounts"][0]["inj"].clone();
    for mode in ["direct", "amino_json"] {
        let request = build_staking(messages.clone(), mode).unwrap()["request"].clone();
        let d = ok("decode", json!({ "request": request }));
        let shown: Vec<(&str, &Value)> = d["display"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (m["type"].as_str().unwrap(), &m["delegator"]))
            .collect();
        assert_eq!(
            shown,
            [("delegate", &me), ("undelegate", &me), ("redelegate", &me), ("cancel_unbonding", &me), ("withdraw_rewards", &me)],
            "{mode}"
        );
        let m = &d["display"]["messages"];
        assert_eq!((&m[2]["from_validator"], &m[2]["to_validator"]), (&json!(VAL_A), &json!(VAL_B)), "{mode}");
        assert_eq!(m[3]["creation_height"], 1234, "{mode}");
        let rules: Vec<&str> = d["risk"]["findings"].as_array().unwrap().iter().map(|f| f["rule"].as_str().unwrap()).collect();
        assert_eq!(rules, ["stake", "unstake"], "{mode}");
        assert_eq!(d["risk"]["level"], "info", "{mode}");
        let signed = approve_and_sign(&request, account(0));
        assert!(signed["tx_raw"].as_str().is_some_and(|t| !t.is_empty()), "{mode}: {signed}");
    }

    // An account address where a validator goes, and a move to the same validator, are refused.
    let me_str = me.as_str().unwrap();
    for bad in [
        json!([{ "type": "delegate", "validator": me_str, "amount": inj("1") }]),
        json!([{ "type": "redelegate", "from": VAL_A, "to": VAL_A, "amount": inj("1") }]),
        json!([{ "type": "delegate", "validator": VAL_A, "amount": inj("0") }]),
        json!([{ "type": "cancel_unbonding", "validator": VAL_A, "amount": inj("1"), "height": "0" }]),
    ] {
        assert!(build_staking(bad.clone(), "direct").is_err(), "{bad}");
    }
}

#[test]
fn own_revokes_build_decode_and_sign() {
    let v = vectors("direct");
    let them = v["accounts"][1]["inj"].as_str().unwrap();
    // SHROOM's CW20 (a published contract).
    let cw20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
    let messages = json!([
        { "type": "authz_revoke", "grantee": them, "msg_type_url": "/cosmos.bank.v1beta1.MsgSend" },
        { "type": "fee_revoke", "grantee": them },
        { "type": "reset_withdraw_address" },
        { "type": "cw20_decrease_allowance", "contract": cw20, "spender": them, "amount": "5" },
    ]);
    for mode in ["direct", "amino_json"] {
        let request = build_staking(messages.clone(), mode).unwrap()["request"].clone();
        let d = ok("decode", json!({ "request": request }));
        let m = &d["display"]["messages"];
        let types: Vec<&str> = m.as_array().unwrap().iter().map(|x| x["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["authz_revoke", "fee_revoke", "set_withdraw_address", "execute_contract"], "{mode}");
        assert_eq!(m[2]["withdraw_address"], m[2]["delegator"], "{mode}");
        assert_eq!(m[3]["call"]["type"], "cw20_decrease_allowance", "{mode}");
        let rules: Vec<&str> = d["risk"]["findings"].as_array().unwrap().iter().map(|f| f["rule"].as_str().unwrap()).collect();
        assert_eq!(rules, ["authz_revoke", "fee_revoke", "allowance_decrease"], "{mode}");
        assert_eq!(d["risk"]["level"], "info", "{mode}");
        assert!(approve_and_sign(&request, account(0))["tx_raw"].is_string(), "{mode}");
    }
    for bad in [
        json!([{ "type": "authz_revoke", "grantee": them, "msg_type_url": "cosmos.bank.v1beta1.MsgSend" }]),
        json!([{ "type": "authz_revoke", "grantee": them, "msg_type_url": "/a b" }]),
        json!([{ "type": "reset_withdraw_address", "to": them }]),
        json!([{ "type": "cw20_decrease_allowance", "contract": cw20, "spender": them, "amount": "0" }]),
    ] {
        assert!(build_staking(bad.clone(), "direct").is_err(), "{bad}");
    }

    // ERC20: approve(spender, 0) on the token, read back as taking the allowance away.
    let e = vectors("eip1559");
    let token = "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13";
    let spender = "0x4444444444444444444444444444444444444444";
    let params = |to: &str, amount: &str, revoke: Option<&str>, token: Option<&str>| {
        let mut p = json!({
            "chain": "eip155:1776", "from": e["from"], "to": to, "amount": amount,
            "nonce": 3, "gas_limit": 60000, "max_fee_per_gas": "1160000000", "max_priority_fee_per_gas": "1000000000",
        });
        if let Some(t) = token {
            p["token"] = t.into();
        }
        if let Some(s) = revoke {
            p["revoke"] = s.into();
        }
        p
    };
    let request = ok("build_evm", params(token, "0", Some(spender), Some(token)))["request"].clone();
    assert_eq!(request["evm_transaction"]["tx"]["data"], format!("0x095ea7b3{:0>64}{}", spender[2..].to_lowercase(), "0".repeat(64)));
    let d = ok("decode", json!({ "request": request }));
    let rules: Vec<&str> = d["risk"]["findings"].as_array().unwrap().iter().map(|f| f["rule"].as_str().unwrap()).collect();
    assert!(rules.contains(&"allowance_revoke"), "{rules:?}");
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());
    // Only to the token itself, only for 0, only with a token.
    assert_eq!(code("build_evm", params(spender, "0", Some(spender), Some(token))), "bad_request");
    assert_eq!(code("build_evm", params(token, "1", Some(spender), Some(token))), "bad_request");
    assert_eq!(code("build_evm", params(token, "0", Some(spender), None)), "bad_request");
}

/// A real route from Choice's API (2026-11-09), paying the test phrase's account 0.
fn choice_route(name: &str) -> Value {
    let v: Value = serde_json::from_str(include_str!("../../injective/tests/choice_routes.json")).unwrap();
    v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone()
}

fn evm_params(chain: &str, from: &str, to: &str, amount: &str, call: Value) -> Value {
    json!({
        "chain": chain, "from": from, "to": to, "amount": amount, "call": call,
        "nonce": 3, "gas_limit": 400000, "max_fee_per_gas": "160000000", "max_priority_fee_per_gas": "0",
    })
}

fn rules_of(d: &Value) -> Vec<String> {
    d["risk"]["findings"].as_array().unwrap().iter().map(|f| f["rule"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn own_choice_swap_builds_decodes_and_signs() {
    let c = choice_route("m-inj-usdt");
    let me = c["api"]["recipient"].as_str().unwrap();
    let swap = |from: &str, value: &str| evm_params("eip155:1776", from, c["to"].as_str().unwrap(), value, json!({ "type": "swap", "data": c["data"] }));
    let request = ok("build_evm", swap(me, c["value"].as_str().unwrap()))["request"].clone();
    assert_eq!(request["evm_transaction"]["tx"]["data"], c["data"]);
    let d = ok("decode", json!({ "request": request }));
    let call = &d["display"]["call"];
    assert_eq!(call["type"], "swap");
    assert_eq!(call["executor"], "aggregator");
    assert_eq!(call["token_in"], "0x0000000000000000000000000000000000000000");
    assert_eq!(call["token_out"], "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13");
    assert_eq!(call["minimum_out"], "8145811");
    assert_eq!(call["recipient"], me);
    assert_eq!(call["venues"][0]["venue"], "Solidly");
    assert_eq!(d["risk"]["level"], "info");
    assert_eq!(rules_of(&d), ["swap"]);
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());

    // Refused: paying someone else, INJ that doesn't match, a contract that isn't Choice's,
    // and calldata that isn't a swap.
    assert_eq!(code("build_evm", swap("0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F", c["value"].as_str().unwrap())), "bad_request");
    assert_eq!(code("build_evm", swap(me, "1")), "bad_request");
    let elsewhere = evm_params("eip155:1776", me, "0x4444444444444444444444444444444444444444", "0", json!({ "type": "swap", "data": c["data"] }));
    assert_eq!(code("build_evm", elsewhere), "bad_request");
    let junk = evm_params("eip155:1776", me, c["to"].as_str().unwrap(), "0", json!({ "type": "swap", "data": "0xddab6e8d00" }));
    assert_eq!(code("build_evm", junk), "bad_request");

    // The router on testnet: an ERC20 in, so no INJ sent.
    let t = choice_route("t-winj-usdt");
    let r = ok("build_evm", evm_params("eip155:1439", me, t["to"].as_str().unwrap(), "0", json!({ "type": "swap", "data": t["data"] })))["request"].clone();
    let d = ok("decode", json!({ "request": r }));
    assert_eq!(d["display"]["call"]["executor"], "router");
    assert_eq!(rules_of(&d), ["swap"]);
}

#[test]
fn own_swap_approvals_are_exact() {
    let me = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    let usdt = "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13";
    let permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    let aggregator = "0xa705d0D5f549Af25024038dc575E3074B9Bd37c9";
    // approve(Permit2, 5 USDT) on the token.
    let r = ok("build_evm", evm_params("eip155:1776", me, usdt, "5000000", json!({ "type": "approve" })))["request"].clone();
    let d = ok("decode", json!({ "request": r }));
    assert_eq!(d["display"]["call"], json!({ "type": "approve", "spender": permit2, "amount": "5000000" }));
    assert_eq!(d["risk"]["findings"][0]["message"], "Permit2 could spend this token up to the amount shown.");
    assert_eq!(d["risk"]["level"], "amber");
    assert!(approve_and_sign(&r, account(0))["raw"].is_string());
    // Permit2.approve(USDT, aggregator, 5 USDT, an hour).
    let p2 = |to: &str, spender: &str, amount: &str| {
        evm_params("eip155:1776", me, to, amount, json!({ "type": "permit2_approve", "token": usdt, "spender": spender, "expiration": 1_800_000_000u64 }))
    };
    let r = ok("build_evm", p2(permit2, aggregator, "5000000"))["request"].clone();
    let d = ok("decode", json!({ "request": r }));
    assert_eq!(d["display"]["call"]["type"], "permit2_approve");
    assert_eq!(d["display"]["call"]["spender"], aggregator);
    assert_eq!(rules_of(&d), ["permit2_limited"]);
    assert!(d["risk"]["findings"][0]["message"].as_str().unwrap().starts_with("Choice's aggregator could spend"));
    // Never unlimited, never for anyone but Choice's executors, only at Permit2.
    let unlimited = "1267650600228229401496703205376";
    assert_eq!(code("build_evm", evm_params("eip155:1776", me, usdt, unlimited, json!({ "type": "approve" }))), "bad_request");
    assert_eq!(code("build_evm", evm_params("eip155:1776", me, usdt, "0", json!({ "type": "approve" }))), "bad_request");
    assert_eq!(code("build_evm", p2(permit2, "0x4444444444444444444444444444444444444444", "5")), "bad_request");
    assert_eq!(code("build_evm", p2(usdt, aggregator, "5")), "bad_request");
    assert_eq!(code("build_evm", p2(permit2, aggregator, unlimited)), "bad_request");
}

/// A Ledger in software: the test phrase's key on the Ledger Live path, signing as the
/// device's apps do (the Cosmos app answers in DER; the Ethereum app with r, s and v).
struct FakeLedger {
    key: choice_wallet_core::PrivateKey,
}

impl FakeLedger {
    fn new(index: u32) -> Self {
        let phrase = vectors("direct")["phrase"].as_str().unwrap().to_owned();
        let m = choice_wallet_core::Mnemonic::parse(&phrase).unwrap();
        let key = choice_wallet_core::hd::derive(&m, &choice_wallet_core::hd::ledger_live_path(index)).unwrap();
        Self { key }
    }

    fn public_key(&self) -> String {
        hex::encode(self.key.public_key().compressed())
    }

    /// `r || s`, flipped to its high-S twin when `high` (a device may return either).
    fn rs(&self, hash: &[u8; 32], high: bool) -> [u8; 64] {
        let (sig, _) = self.key.sign_prehash(hash);
        if !high {
            return sig;
        }
        // n - s, big-endian.
        const N: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xba, 0xae,
            0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
        ];
        let mut out = sig;
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = i16::from(N[i]) - i16::from(sig[32 + i]) - borrow;
            borrow = i16::from(d < 0);
            out[32 + i] = (d + 256 * borrow) as u8;
        }
        out
    }

    fn der(&self, hash: &[u8; 32], high: bool) -> String {
        let sig = self.rs(hash, high);
        let int = |v: &[u8]| {
            let v = &v[v.iter().position(|&b| b != 0).unwrap_or(31)..];
            let pad = v[0] & 0x80 != 0;
            let mut out = vec![0x02, v.len() as u8 + u8::from(pad)];
            if pad {
                out.push(0);
            }
            out.extend_from_slice(v);
            out
        };
        let body = [int(&sig[..32]), int(&sig[32..])].concat();
        hex::encode([vec![0x30, body.len() as u8], body].concat())
    }
}

const LEDGER_0: fn() -> Value = || json!({ "derivation": "ledger_live", "index": 0 });

#[test]
fn a_ledger_signs_what_the_vault_decoded() {
    use choice_wallet_core::secp256k1::keccak256;
    let ledger = FakeLedger::new(0);
    let pk = ledger.public_key();
    // The device's key gives the same account as the phrase on that path.
    let info = ok("key_addresses", json!({ "public_key": pk }));
    let (_, secret, unlock_key) = wallet();
    let soft = ok(
        "accounts",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "accounts": [LEDGER_0()] }),
    );
    assert_eq!(info["addresses"], soft["accounts"][0]["addresses"]);
    assert_eq!(info["public_key"], soft["accounts"][0]["public_key"]);

    // A Cosmos send in amino JSON: the device gets the exact sign bytes, and its signature
    // (either S) makes the same transaction the software key would.
    let to = vectors("direct")["accounts"][1]["inj"].clone();
    let request = ok(
        "build_cosmos",
        json!({
            "chain": "cosmos:injective-1", "signer": pk,
            "messages": [{ "type": "bank_send", "to": to, "amount": [{ "denom": "inj", "amount": "1000" }] }],
            "account_number": "17", "sequence": "3",
            "fee": { "amount": [{ "denom": "inj", "amount": "20000000000000" }], "gas_limit": "250000" },
            "sign_mode": "amino_json",
        }),
    )["request"]
        .clone();
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let dev = ok("device_request", json!({ "request": request, "digest": digest }));
    assert_eq!(
        (dev["app"].as_str(), dev["kind"].as_str()),
        (Some("cosmos"), Some("amino"))
    );
    let payload = hex::decode(dev["payload"].as_str().unwrap()).unwrap();
    assert!(
        payload.starts_with(b"{\"account_number\":\"17\""),
        "{}",
        String::from_utf8_lossy(&payload)
    );
    let expected = approve_and_sign(&request, LEDGER_0());
    for high in [false, true] {
        let signed = ok(
            "device_sign",
            json!({ "request": request, "digest": digest, "public_key": pk, "signature": ledger.der(&keccak256(&payload), high), "format": "der" }),
        );
        assert_eq!(signed["tx_raw"], expected["tx_raw"], "high S: {high}");
    }
    // Another request's signature, another account's key, another digest: nothing.
    let sign = |sig: String, key: &str, digest: &Value| {
        code(
            "device_sign",
            json!({ "request": request, "digest": digest, "public_key": key, "signature": sig, "format": "der" }),
        )
    };
    assert_eq!(
        sign(ledger.der(&keccak256(b"other"), false), &pk, &digest),
        "bad_signature"
    );
    let other = FakeLedger::new(1);
    assert_eq!(
        sign(other.der(&keccak256(&payload), false), &pk, &digest),
        "bad_signature"
    );
    assert_eq!(
        sign(other.der(&keccak256(&payload), false), &other.public_key(), &digest),
        "wrong_account"
    );
    assert_eq!(
        sign(ledger.der(&keccak256(&payload), false), &pk, &json!("00".repeat(32))),
        "not_approved"
    );
    assert_eq!(sign("3000".into(), &pk, &digest), "bad_signature");
    assert_eq!(
        code(
            "device_request",
            json!({ "request": request, "digest": "00".repeat(32) })
        ),
        "not_approved"
    );

    // SIGN_MODE_DIRECT isn't something the device signs.
    let direct = ok(
        "build_cosmos",
        json!({
            "chain": "cosmos:injective-1", "signer": pk,
            "messages": [{ "type": "bank_send", "to": to, "amount": [{ "denom": "inj", "amount": "1000" }] }],
            "account_number": "17", "sequence": "3",
            "fee": { "amount": [{ "denom": "inj", "amount": "20000000000000" }], "gas_limit": "250000" },
        }),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": direct }))["digest"].clone();
    assert_eq!(
        code("device_request", json!({ "request": direct, "digest": d })),
        "device_unsupported"
    );
}

#[test]
fn a_ledger_signs_evm_transactions_and_messages() {
    use choice_wallet_core::secp256k1::keccak256;
    let ledger = FakeLedger::new(0);
    let pk = ledger.public_key();
    let from = ok("key_addresses", json!({ "public_key": pk }))["addresses"]["eip155:1776"].clone();
    let request = ok(
        "build_evm",
        json!({
            "chain": "eip155:1776", "from": from, "to": vectors("eip1559")["from"], "amount": "12345",
            "nonce": 4, "gas_limit": 21000, "max_fee_per_gas": "160000000", "max_priority_fee_per_gas": "0",
        }),
    )["request"]
        .clone();
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let dev = ok("device_request", json!({ "request": request, "digest": digest }));
    assert_eq!(
        (dev["app"].as_str(), dev["kind"].as_str()),
        (Some("ethereum"), Some("transaction"))
    );
    let unsigned = hex::decode(dev["payload"].as_str().unwrap()).unwrap();
    assert_eq!(unsigned[0], 0x02);
    let expected = approve_and_sign(&request, LEDGER_0());
    for high in [false, true] {
        let rs = hex::encode(ledger.rs(&keccak256(&unsigned), high));
        let signed = ok(
            "device_sign",
            json!({ "request": request, "digest": digest, "public_key": pk, "signature": rs, "format": "rs" }),
        );
        assert_eq!(
            (&signed["raw"], &signed["hash"]),
            (&expected["raw"], &expected["hash"]),
            "high S: {high}"
        );
    }

    let message =
        json!({ "evm_personal_sign": { "chain": "eip155:1776", "signer": from, "message": "Sign in to example.org" } });
    let digest = ok("decode", json!({ "request": message }))["digest"].clone();
    let dev = ok("device_request", json!({ "request": message, "digest": digest }));
    assert_eq!(dev["kind"], "message");
    assert_eq!(
        hex::decode(dev["payload"].as_str().unwrap()).unwrap(),
        b"Sign in to example.org"
    );
    let hash = choice_wallet_evm::personal::hash(b"Sign in to example.org");
    let signed = ok(
        "device_sign",
        json!({ "request": message, "digest": digest, "public_key": pk, "signature": hex::encode(ledger.rs(&hash, true)), "format": "rs" }),
    );
    assert_eq!(signed["signature"], approve_and_sign(&message, LEDGER_0())["signature"]);
}

#[test]
fn sign_arbitrary_matches_injective_ts() {
    let v = vectors("adr36");
    let pk = v["public_key"].as_str().unwrap();
    assert_eq!(pk, signer_key(0));
    for c in v["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let request = json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": c["data_hex"] } });
        let d = ok("decode", json!({ "request": request }));
        assert_eq!(d["display"]["signer"], v["signer"], "{name}");
        let signed = approve_and_sign(&request, account(0));
        assert_eq!(signed["signed_doc"], c["sign_doc"], "{name}");
        assert_eq!(signed["signature"], c["signature"], "{name}");
        // verifyArbitrary: the signature, for this data and this account only.
        let verify = |address: &Value, data: &Value, sig: &Value| {
            ok(
                "verify_arbitrary",
                json!({ "chain": "cosmos:injective-1", "address": address, "data": data, "public_key": pk, "signature": sig }),
            )["valid"]
                .as_bool()
                .unwrap()
        };
        assert!(verify(&v["signer"], &c["data_hex"], &c["signature"]), "{name}");
        assert!(!verify(&v["signer"], &json!("00"), &c["signature"]), "{name}");
        let other = vectors("direct")["accounts"][1]["inj"].clone();
        assert!(!verify(&other, &c["data_hex"], &c["signature"]), "{name}");
    }
    // Shown as text; graded like a message: a transaction's shape is red.
    let text = json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode("hello") } });
    let d = ok("decode", json!({ "request": text }));
    assert_eq!((d["display"]["text"].as_str(), d["risk"]["level"].as_str()), (Some("hello"), Some("info")));
    let amino = json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode(r#"{"chain_id":"injective-1","msgs":[]}"#) } });
    let d = ok("decode", json!({ "request": amino }));
    assert_eq!(d["risk"]["findings"][0]["rule"], "arbitrary_tx");
    assert_eq!(d["risk"]["level"], "red");
}

#[test]
fn a_ledger_signs_arbitrary_messages_in_the_cosmos_app() {
    use choice_wallet_core::secp256k1::keccak256;
    let ledger = FakeLedger::new(0);
    let pk = ledger.public_key();
    let request = json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode("Sign in") } });
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let dev = ok("device_request", json!({ "request": request, "digest": digest }));
    assert_eq!((dev["app"].as_str(), dev["kind"].as_str()), (Some("cosmos"), Some("amino")));
    let doc = hex::decode(dev["payload"].as_str().unwrap()).unwrap();
    let signed = ok(
        "device_sign",
        json!({ "request": request, "digest": digest, "public_key": pk, "signature": ledger.der(&keccak256(&doc), true), "format": "der" }),
    );
    assert_eq!(signed["signature"], approve_and_sign(&request, LEDGER_0())["signature"]);
}
