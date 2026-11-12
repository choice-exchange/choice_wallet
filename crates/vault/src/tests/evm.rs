// Injective EVM: typed data and personal_sign against viem, own sends, Choice swaps and
// their exact approvals.

use super::*;

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

/// F1: Injective's domain on Ethereum's chain ID (which Injective accepts) is the same Cosmos
/// tx, so it is decoded and graded on the Ethereum entry too, and refused off Injective's
/// networks.
#[test]
fn injective_typed_data_is_decoded_on_every_chain_of_its_network() {
    let cases = vectors("eip712_v2");
    let case = |name: &str, chain_id: &str| {
        let c = cases["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let mut td: Value = serde_json::from_str(c["typed_data"].as_str().unwrap()).unwrap();
        td["domain"]["chainId"] = chain_id.into();
        td.to_string()
    };
    let request = |chain: &str, td: String| {
        json!({ "evm_typed_data": {
            "chain": chain,
            "signer": "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "typed_data": td,
        }})
    };
    let grants = case("mainnet_grants_and_admin_changes", "0x1");
    let d = ok("decode", json!({ "request": request("eip155:1", grants.clone()) }));
    assert!(d["display"]["injective_tx"]["messages"].is_array(), "{d}");
    assert_eq!(
        (d["risk"]["level"].as_str(), d["risk"]["confirm"].as_str()),
        (Some("red"), Some("GRANT")),
        "{}",
        d["risk"]
    );
    let testnet = case("testnet_bank_to_cw20", "0xaa36a7");
    let d = ok("decode", json!({ "request": request("eip155:11155111", testnet) }));
    assert!(d["display"]["injective_tx"]["messages"].is_array(), "{d}");

    // On a chain the user added, Injective's domain is refused whatever its chain ID.
    assert_eq!(
        code("decode", json!({ "request": request("eip155:56", grants) })),
        "invalid"
    );
    let on_56 = case("mainnet_grants_and_admin_changes", "0x38");
    assert_eq!(
        code("decode", json!({ "request": request("eip155:56", on_56) })),
        "invalid"
    );

    // Legacy (v1) Injective typed data is refused on Ethereum, as on Injective EVM.
    let legacy = json!({
        "types": {
            "EIP712Domain": [
                { "name": "name", "type": "string" }, { "name": "version", "type": "string" },
                { "name": "chainId", "type": "uint256" }, { "name": "verifyingContract", "type": "string" },
                { "name": "salt", "type": "string" },
            ],
            "Tx": [
                { "name": "account_number", "type": "string" }, { "name": "chain_id", "type": "string" },
                { "name": "memo", "type": "string" }, { "name": "sequence", "type": "string" },
            ],
        },
        "primaryType": "Tx",
        "domain": { "name": "Injective Web3", "version": "1.0.0", "chainId": 1,
                    "verifyingContract": "cosmos", "salt": "0" },
        "message": { "account_number": "1", "chain_id": "injective-1", "memo": "", "sequence": "0" },
    });
    for chain in ["eip155:1", "eip155:1776"] {
        assert_eq!(
            code("decode", json!({ "request": request(chain, legacy.to_string()) })),
            "invalid",
            "{chain}"
        );
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
fn own_choice_swap_builds_decodes_and_signs() {
    let c = choice_route("m-inj-usdt");
    let me = c["api"]["recipient"].as_str().unwrap();
    let swap = |from: &str, value: &str| {
        evm_params(
            "eip155:1776",
            from,
            c["to"].as_str().unwrap(),
            value,
            json!({ "type": "swap", "data": c["data"] }),
        )
    };
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
    assert_eq!(
        code(
            "build_evm",
            swap(
                "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F",
                c["value"].as_str().unwrap()
            )
        ),
        "bad_request"
    );
    assert_eq!(code("build_evm", swap(me, "1")), "bad_request");
    let elsewhere = evm_params(
        "eip155:1776",
        me,
        "0x4444444444444444444444444444444444444444",
        "0",
        json!({ "type": "swap", "data": c["data"] }),
    );
    assert_eq!(code("build_evm", elsewhere), "bad_request");
    let junk = evm_params(
        "eip155:1776",
        me,
        c["to"].as_str().unwrap(),
        "0",
        json!({ "type": "swap", "data": "0xddab6e8d00" }),
    );
    assert_eq!(code("build_evm", junk), "bad_request");

    // The router on testnet: an ERC20 in, so no INJ sent.
    let t = choice_route("t-winj-usdt");
    let r = ok(
        "build_evm",
        evm_params(
            "eip155:1439",
            me,
            t["to"].as_str().unwrap(),
            "0",
            json!({ "type": "swap", "data": t["data"] }),
        ),
    )["request"]
        .clone();
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
    let r = ok(
        "build_evm",
        evm_params("eip155:1776", me, usdt, "5000000", json!({ "type": "approve" })),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": r }));
    assert_eq!(
        d["display"]["call"],
        json!({ "type": "approve", "spender": permit2, "amount": "5000000" })
    );
    assert_eq!(
        d["risk"]["findings"][0]["message"],
        "Permit2 could spend this token up to the amount shown."
    );
    assert_eq!(d["risk"]["level"], "amber");
    assert!(approve_and_sign(&r, account(0))["raw"].is_string());
    // Permit2.approve(USDT, aggregator, 5 USDT, an hour).
    let p2 = |to: &str, spender: &str, amount: &str| {
        evm_params(
            "eip155:1776",
            me,
            to,
            amount,
            json!({ "type": "permit2_approve", "token": usdt, "spender": spender, "expiration": 1_800_000_000u64 }),
        )
    };
    let r = ok("build_evm", p2(permit2, aggregator, "5000000"))["request"].clone();
    let d = ok("decode", json!({ "request": r }));
    assert_eq!(d["display"]["call"]["type"], "permit2_approve");
    assert_eq!(d["display"]["call"]["spender"], aggregator);
    assert_eq!(rules_of(&d), ["permit2_limited"]);
    assert!(
        d["risk"]["findings"][0]["message"]
            .as_str()
            .unwrap()
            .starts_with("Choice's aggregator could spend")
    );
    // Never unlimited, never for anyone but Choice's executors, only at Permit2.
    let unlimited = "1267650600228229401496703205376";
    assert_eq!(
        code(
            "build_evm",
            evm_params("eip155:1776", me, usdt, unlimited, json!({ "type": "approve" }))
        ),
        "bad_request"
    );
    assert_eq!(
        code(
            "build_evm",
            evm_params("eip155:1776", me, usdt, "0", json!({ "type": "approve" }))
        ),
        "bad_request"
    );
    assert_eq!(
        code(
            "build_evm",
            p2(permit2, "0x4444444444444444444444444444444444444444", "5")
        ),
        "bad_request"
    );
    assert_eq!(code("build_evm", p2(usdt, aggregator, "5")), "bad_request");
    assert_eq!(code("build_evm", p2(permit2, aggregator, unlimited)), "bad_request");
}

#[test]
fn an_added_chain_is_known_by_its_id_alone() {
    // BNB Smart Chain (56) isn't built in: a send there decodes as an added chain's, with no
    // name or symbol of the vault's, and signs for chain 56.
    let from = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    let build = |chain: &str| {
        json!({
            "chain": chain, "from": from, "to": "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F", "amount": "1000",
            "nonce": 0, "gas_limit": 21000, "max_fee_per_gas": "3000000000", "max_priority_fee_per_gas": "1000000000",
        })
    };
    let request = ok("build_evm", build("eip155:56"))["request"].clone();
    let d = ok("decode", json!({ "request": request }));
    assert_eq!(d["display"]["chain"], "eip155:56");
    assert_eq!(
        d["display"]["network"],
        json!({ "name": "", "symbol": "", "decimals": 18, "added": true })
    );
    assert_eq!(d["display"]["call"]["type"], "transfer");
    let signed = approve_and_sign(&request, account(0));
    // EIP-1559: 0x02, the list's two-byte header, then the chain ID (56 = 0x38) first.
    let raw = signed["raw"].as_str().unwrap();
    assert!(raw.starts_with("0x02f8") && &raw[8..10] == "38", "{raw}");
    // A built-in chain stays itself.
    let base = ok(
        "decode",
        json!({ "request": ok("build_evm", build("eip155:8453"))["request"] }),
    );
    assert_eq!(base["display"]["network"]["added"], false);
    // Only plain decimal IDs from 1 to MetaMask's highest.
    for bad in [
        "eip155:0",
        "eip155:056",
        "eip155:4503599627370477",
        "eip155:",
        "eip155:5x",
        "eip155:-1",
    ] {
        assert_eq!(code("build_evm", build(bad)), "unknown_chain", "{bad}");
    }
    // Typed data there must be for that chain.
    let td = json!({
        "types": { "EIP712Domain": [{ "name": "chainId", "type": "uint256" }], "Hello": [{ "name": "text", "type": "string" }] },
        "primaryType": "Hello",
        "domain": { "chainId": 1 },
        "message": { "text": "hi" },
    });
    let typed = |td: &Value| json!({ "evm_typed_data": { "chain": "eip155:56", "signer": from, "typed_data": td.to_string() } });
    assert_eq!(code("decode", json!({ "request": typed(&td) })), "invalid");
    let mut on56 = td.clone();
    on56["domain"]["chainId"] = 56.into();
    ok("decode", json!({ "request": typed(&on56) }));
}
