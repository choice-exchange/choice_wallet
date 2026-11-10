//! End-to-end through the JSON protocol, against the injective-ts and viem vectors: what
//! a host gets back from `handle` must match the independent implementations byte for byte.

use std::sync::OnceLock;

use serde_json::{Value, json};

use super::handle;

mod bridge;
mod cosmos;
mod evm;
mod keys;
mod ledger;
mod solana;

fn vectors(name: &str) -> Value {
    let text = match name {
        "direct" => include_str!("../../../injective/tests/vectors/direct.json"),
        "amino" => include_str!("../../../injective/tests/vectors/amino.json"),
        "eip712_v2" => include_str!("../../../injective/tests/vectors/eip712_v2.json"),
        "eip1559" => include_str!("../../../evm/tests/vectors/eip1559.json"),
        "personal" => include_str!("../../../evm/tests/vectors/personal.json"),
        "messages" => include_str!("../../../injective/tests/vectors/messages.json"),
        "adr36" => include_str!("../../../injective/tests/vectors/adr36.json"),
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
        let sealed = ok(
            "seal_secret",
            json!({ "unlock_key": unlock_key, "wallet": "w1", "secret": { "mnemonic": phrase } }),
        );
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
    let sealed = ok(
        "seal_secret",
        json!({ "unlock_key": v["unlock_key"], "wallet": "w1", "secret": secret }),
    );
    (v["vault"].clone(), sealed["secret"].clone(), v["unlock_key"].clone())
}

/// A real route from Choice's API (2026-11-09), paying the test phrase's account 0.
fn choice_route(name: &str) -> Value {
    let v: Value = serde_json::from_str(include_str!("../../../injective/tests/choice_routes.json")).unwrap();
    v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
        .clone()
}

fn evm_params(chain: &str, from: &str, to: &str, amount: &str, call: Value) -> Value {
    json!({
        "chain": chain, "from": from, "to": to, "amount": amount, "call": call,
        "nonce": 3, "gas_limit": 400000, "max_fee_per_gas": "160000000", "max_priority_fee_per_gas": "0",
    })
}

fn rules_of(d: &Value) -> Vec<String> {
    d["risk"]["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["rule"].as_str().unwrap().to_owned())
        .collect()
}
