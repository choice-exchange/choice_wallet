// Injective's Cosmos side: own sends against injective-ts, a site's amino sign docs,
// decoded messages and their grades, staking, revokes, NFTs, rescue, trading accounts.

use super::*;

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
    let parsed: crate::request::SignRequest = serde_json::from_str(&text).unwrap();
    let checked = crate::request::decode(parsed).unwrap();
    assert_eq!(crate::request::messages(&checked).unwrap().len(), 1);
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
            [
                ("delegate", &me),
                ("undelegate", &me),
                ("redelegate", &me),
                ("cancel_unbonding", &me),
                ("withdraw_rewards", &me)
            ],
            "{mode}"
        );
        let m = &d["display"]["messages"];
        assert_eq!(
            (&m[2]["from_validator"], &m[2]["to_validator"]),
            (&json!(VAL_A), &json!(VAL_B)),
            "{mode}"
        );
        assert_eq!(m[3]["creation_height"], 1234, "{mode}");
        let rules: Vec<&str> = d["risk"]["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["rule"].as_str().unwrap())
            .collect();
        assert_eq!(rules, ["stake", "unstake"], "{mode}");
        assert_eq!(d["risk"]["level"], "info", "{mode}");
        let signed = approve_and_sign(&request, account(0));
        assert!(
            signed["tx_raw"].as_str().is_some_and(|t| !t.is_empty()),
            "{mode}: {signed}"
        );
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
fn own_votes_build_decode_and_sign_both_ways() {
    let me = vectors("direct")["accounts"][0]["inj"].clone();
    let vote = json!([{ "type": "vote", "proposal": "713", "option": "no_with_veto" }]);
    for mode in ["direct", "amino_json"] {
        let request = build_staking(vote.clone(), mode).unwrap()["request"].clone();
        let d = ok("decode", json!({ "request": request }));
        assert_eq!(
            d["display"]["messages"],
            json!([{ "type": "vote", "voter": me, "proposal_id": 713, "option": "no_with_veto", "metadata": "" }]),
            "{mode}"
        );
        assert_eq!(d["risk"]["findings"][0]["rule"], "vote", "{mode}");
        assert_eq!(d["risk"]["level"], "info", "{mode}");
        if mode == "amino_json" {
            // What Ledger's Cosmos app shows: the SDK's amino JSON, the option by number.
            let dev = ok("device_request", json!({ "request": request, "digest": d["digest"] }));
            let payload =
                String::from_utf8(choice_wallet_core::hexutil::decode(dev["payload"].as_str().unwrap()).unwrap())
                    .unwrap();
            let want =
                format!(r#"{{"type":"cosmos-sdk/MsgVote","value":{{"option":4,"proposal_id":"713","voter":{me}}}}}"#);
            assert!(payload.contains(&want), "{payload}");
        }
        let signed = approve_and_sign(&request, account(0));
        assert!(
            signed["tx_raw"].as_str().is_some_and(|t| !t.is_empty()),
            "{mode}: {signed}"
        );
    }
    for bad in [
        json!([{ "type": "vote", "proposal": "0", "option": "yes" }]),
        json!([{ "type": "vote", "proposal": "713", "option": "maybe" }]),
        json!([{ "type": "vote", "proposal": "713", "option": "unspecified" }]),
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
        let types: Vec<&str> = m
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            types,
            ["authz_revoke", "fee_revoke", "set_withdraw_address", "execute_contract"],
            "{mode}"
        );
        assert_eq!(m[2]["withdraw_address"], m[2]["delegator"], "{mode}");
        assert_eq!(m[3]["call"]["type"], "cw20_decrease_allowance", "{mode}");
        let rules: Vec<&str> = d["risk"]["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["rule"].as_str().unwrap())
            .collect();
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
    assert_eq!(
        request["evm_transaction"]["tx"]["data"],
        format!("0x095ea7b3{:0>64}{}", spender[2..].to_lowercase(), "0".repeat(64))
    );
    let d = ok("decode", json!({ "request": request }));
    let rules: Vec<&str> = d["risk"]["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["rule"].as_str().unwrap())
        .collect();
    assert!(rules.contains(&"allowance_revoke"), "{rules:?}");
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());
    // Only to the token itself, only for 0, only with a token.
    assert_eq!(
        code("build_evm", params(spender, "0", Some(spender), Some(token))),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", params(token, "1", Some(spender), Some(token))),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", params(token, "0", Some(spender), None)),
        "bad_request"
    );
}

#[test]
fn sign_arbitrary_matches_injective_ts() {
    let v = vectors("adr36");
    let pk = v["public_key"].as_str().unwrap();
    assert_eq!(pk, signer_key(0));
    for c in v["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let request =
            json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": c["data_hex"] } });
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
    let text =
        json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode("hello") } });
    let d = ok("decode", json!({ "request": text }));
    assert_eq!(
        (d["display"]["text"].as_str(), d["risk"]["level"].as_str()),
        (Some("hello"), Some("info"))
    );
    let amino = json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode(r#"{"chain_id":"injective-1","msgs":[]}"#) } });
    let d = ok("decode", json!({ "request": amino }));
    assert_eq!(d["risk"]["findings"][0]["rule"], "arbitrary_tx");
    assert_eq!(d["risk"]["level"], "red");
}

#[test]
fn own_nft_sends_build_decode_and_sign() {
    // A CW721 (test-phrase account 2's address stands in for the collection: only its shape
    // matters) in both sign modes, and an ERC721 on Injective EVM.
    let accounts = vectors("direct")["accounts"].clone();
    let collection = accounts[2]["inj"].clone();
    let to = accounts[1]["inj"].clone();
    for mode in ["direct", "amino_json"] {
        let request = build_staking(
            json!([{ "type": "nft_transfer", "contract": collection, "to": to, "token_id": "42" }]),
            mode,
        )
        .unwrap()["request"]
            .clone();
        let d = ok("decode", json!({ "request": request }));
        let m = &d["display"]["messages"][0];
        assert_eq!(
            (&m["call"]["type"], &m["call"]["token_id"], &m["call"]["recipient"]),
            (&json!("nft_transfer"), &json!("42"), &to),
            "{mode}"
        );
        assert_eq!(d["risk"]["findings"][0]["rule"], "nft_send", "{mode}");
        assert!(approve_and_sign(&request, account(0))["tx_raw"].is_string(), "{mode}");
    }
    // To itself, or a token ID with a control character: refused.
    let me = accounts[0]["inj"].clone();
    assert!(
        build_staking(
            json!([{ "type": "nft_transfer", "contract": collection, "to": me, "token_id": "1" }]),
            "direct"
        )
        .is_err()
    );
    assert!(
        build_staking(
            json!([{ "type": "nft_transfer", "contract": collection, "to": to, "token_id": "a\u{7}" }]),
            "direct"
        )
        .is_err()
    );

    let checksum = |a: &Value| ok("addresses", json!({ "address": a }))["addresses"]["eip155:1776"].clone();
    let from = checksum(&accounts[0]["eth"]);
    let dest = checksum(&accounts[1]["eth"]);
    let request = ok(
        "build_evm",
        json!({
            "chain": "eip155:1776", "from": from, "to": dest, "amount": "0",
            "call": { "type": "nft_transfer", "collection": "0x1111111111111111111111111111111111111111", "token_id": "7" },
            "nonce": 1, "gas_limit": 90000, "max_fee_per_gas": "160000000", "max_priority_fee_per_gas": "0",
        }),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": request }));
    assert_eq!(d["display"]["to"], "0x1111111111111111111111111111111111111111");
    assert_eq!(
        d["display"]["call"],
        json!({ "type": "nft_transfer", "from": from, "to": dest, "token_id": "7" })
    );
    assert_eq!(d["risk"]["findings"][0]["rule"], "nft_send");
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());
}

#[test]
fn rescue_messages_build_decode_and_sign_both_ways() {
    let accounts = vectors("direct")["accounts"].clone();
    let rescue = accounts[1]["inj"].clone();
    let inj = |a: &str| json!({ "denom": "inj", "amount": a });
    let sweep = json!([
        { "type": "set_withdraw_address", "to": rescue },
        { "type": "withdraw_rewards", "validator": VAL_A },
        { "type": "transfer_delegation", "validator": VAL_A, "to": rescue, "amount": inj("2000000000000000000") },
        { "type": "bank_send", "to": rescue, "amount": [inj("1000")] },
    ]);
    let grant = json!([{
        "type": "fee_grant", "grantee": rescue, "spend_limit": [inj("500000000000000000")],
        "allowed_messages": ["/cosmos.bank.v1beta1.MsgSend", "/cosmos.staking.v1beta1.MsgTransferDelegation"],
    }]);
    let mine = json!({ "address_book": [{ "address": rescue, "name": "Vault", "mine": true }] });
    for mode in ["direct", "amino_json"] {
        let request = build_staking(sweep.clone(), mode).unwrap()["request"].clone();
        let d = ok("decode", json!({ "request": request, "context": mine }));
        let types: Vec<&str> = d["display"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            types,
            [
                "set_withdraw_address",
                "withdraw_rewards",
                "transfer_delegation",
                "bank_send"
            ],
            "{mode}"
        );
        let rules: Vec<&str> = d["risk"]["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["rule"].as_str().unwrap())
            .collect();
        assert!(
            rules.contains(&"withdraw_address_own") && rules.contains(&"transfer_stake_own"),
            "{mode}: {rules:?}"
        );
        assert!(approve_and_sign(&request, account(0))["tx_raw"].is_string(), "{mode}");

        let request = build_staking(grant.clone(), mode).unwrap()["request"].clone();
        let d = ok("decode", json!({ "request": request, "context": mine }));
        assert_eq!(d["risk"]["findings"][0]["rule"], "fee_grant_own", "{mode}");
        assert!(d["risk"]["confirm"].is_null(), "{mode}");
        assert!(approve_and_sign(&request, account(0))["tx_raw"].is_string(), "{mode}");
    }
    // A grant without a limit or a message list isn't built.
    for bad in [
        json!([{ "type": "fee_grant", "grantee": rescue, "spend_limit": [], "allowed_messages": ["/cosmos.bank.v1beta1.MsgSend"] }]),
        json!([{ "type": "fee_grant", "grantee": rescue, "spend_limit": [inj("1")], "allowed_messages": [] }]),
        json!([{ "type": "transfer_delegation", "validator": VAL_A, "to": accounts[0]["inj"], "amount": inj("1") }]),
    ] {
        assert!(build_staking(bad.clone(), "direct").is_err(), "{bad}");
    }
}

#[test]
fn trading_account_withdrawals_build_decode_and_sign_both_ways() {
    let accounts = vectors("direct")["accounts"].clone();
    let me = accounts[0]["eth"].as_str().unwrap().trim_start_matches("0x").to_owned();
    let other = accounts[1]["eth"].as_str().unwrap().trim_start_matches("0x").to_owned();
    let sub = |owner: &str, nonce: u32| format!("0x{owner}{nonce:024x}");
    let usdt = json!({ "denom": "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", "amount": "2500000" });
    for mode in ["direct", "amino_json"] {
        let request = build_staking(
            json!([{ "type": "exchange_withdraw", "subaccount_id": sub(&me, 1), "amount": usdt }]),
            mode,
        )
        .unwrap()["request"]
            .clone();
        let d = ok("decode", json!({ "request": request }));
        assert_eq!(d["display"]["messages"][0]["type"], "exchange_withdraw", "{mode}");
        assert_eq!(d["risk"]["findings"][0]["rule"], "exchange_withdraw", "{mode}");
        assert_eq!(d["risk"]["level"], "info", "{mode}");
        assert!(
            d["risk"]["findings"][0]["message"]
                .as_str()
                .unwrap()
                .contains("from trading account 1 to this account's balance"),
            "{mode}"
        );
        assert!(approve_and_sign(&request, account(0))["tx_raw"].is_string(), "{mode}");
    }
    // Another account's subaccount, or a malformed ID, isn't built.
    for bad in [sub(&other, 1), sub(&me, 1).to_uppercase(), format!("0x{me}")] {
        let r = build_staking(
            json!([{ "type": "exchange_withdraw", "subaccount_id": bad, "amount": usdt }]),
            "direct",
        );
        assert!(r.is_err(), "{bad}");
    }
}
