// USDC over Circle's CCTP: transfers out, deposits from other chains, receives that
// mint only to this account.

use super::*;

/// A bridge transfer's calldata on mainnet, as `injective-usdc-bridge` builds it.
fn burn_data(recipient: &str, domain: u32, hook: choice_wallet_injective::cctp::Hook, max_fee: u128) -> String {
    use choice_wallet_core::{EthAddress, hexutil};
    use choice_wallet_evm::U256;
    use choice_wallet_injective::{cctp, chain::MAINNET};
    let mut mint_recipient = [0u8; 32];
    mint_recipient[12..].copy_from_slice(EthAddress::parse_hex(recipient).unwrap().as_bytes());
    let b = cctp::Burn {
        amount: U256::from_u128(25_000_000),
        domain,
        mint_recipient,
        burn_token: MAINNET.cctp.usdc(),
        destination_caller: [0; 32],
        max_fee: U256::from_u128(max_fee),
        min_finality: cctp::STANDARD,
        hook,
    };
    format!("0x{}", hexutil::encode(&cctp::burn_calldata(&b)))
}

#[test]
fn own_bridge_transfer_builds_decodes_and_signs() {
    use choice_wallet_injective::cctp::{Hook, MAINNET};
    let me = choice_route("m-inj-usdt")["api"]["recipient"]
        .as_str()
        .unwrap()
        .to_owned();
    let tm = MAINNET.token_messenger;
    let bridge = |data: String| evm_params("eip155:1776", &me, tm, "0", json!({ "type": "bridge", "data": data }));
    let data = burn_data(&me, 6, Hook::Forward, 200_000);
    let request = ok("build_evm", bridge(data.clone()))["request"].clone();
    assert_eq!(request["evm_transaction"]["tx"]["data"], data);
    let d = ok("decode", json!({ "request": request }));
    let call = &d["display"]["call"];
    assert_eq!(call["type"], "bridge");
    assert_eq!(call["chain"], "Base");
    assert_eq!(call["recipient"], me);
    assert_eq!(call["amount"], "25000000");
    assert_eq!(call["max_fee"], "200000");
    assert_eq!(call["delivery"], "circle");
    assert_eq!(d["risk"]["level"], "info");
    assert_eq!(rules_of(&d), ["bridge", "bridge_to_self", "bridge_forward"]);
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());

    // Its approval: on USDC, for Circle's TokenMessengerV2, the exact amount.
    let approve = ok(
        "build_evm",
        evm_params(
            "eip155:1776",
            &me,
            MAINNET.usdc,
            "25000000",
            json!({ "type": "bridge_approve" }),
        ),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": approve }));
    assert_eq!(d["display"]["call"]["type"], "approve");
    assert_eq!(d["display"]["call"]["spender"], tm);
    assert_eq!(d["display"]["call"]["amount"], "25000000");
    assert_eq!(
        code(
            "build_evm",
            evm_params("eip155:1776", &me, tm, "25000000", json!({ "type": "bridge_approve" }))
        ),
        "bad_request"
    );
    assert_eq!(
        code(
            "build_evm",
            evm_params(
                "eip155:1776",
                &me,
                MAINNET.usdc,
                "0",
                json!({ "type": "bridge_approve" })
            )
        ),
        "bad_request"
    );

    // Plain, nobody asked to deliver: built, as the wallet can mint it there itself, and
    // the review says it waits for a claim.
    let plain = ok("build_evm", bridge(burn_data(&me, 6, Hook::None, 0)))["request"].clone();
    let d = ok("decode", json!({ "request": plain }));
    assert_eq!(d["display"]["call"]["delivery"], "claim");
    assert_eq!(rules_of(&d), ["bridge_claim", "bridge", "bridge_to_self"]);

    // Refused: a chain Circle doesn't deliver to, a chain the wallet doesn't name, an EVM
    // recipient no address can be, Circle keeping all of it, INJ sent with it, another
    // contract, and calldata that isn't a burn.
    assert_eq!(
        code("build_evm", bridge(burn_data(&me, 33, Hook::Forward, 200_000))),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", bridge(burn_data(&me, 12, Hook::Forward, 200_000))),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", bridge(burn_data(&me, 6, Hook::Forward, 25_000_000))),
        "bad_request"
    );
    let mut sent_inj = bridge(data.clone());
    sent_inj["amount"] = "1".into();
    assert_eq!(code("build_evm", sent_inj), "bad_request");
    let elsewhere = evm_params(
        "eip155:1776",
        &me,
        MAINNET.usdc,
        "0",
        json!({ "type": "bridge", "data": data }),
    );
    assert_eq!(code("build_evm", elsewhere), "bad_request");
    assert_eq!(code("build_evm", bridge("0x12345678".into())), "bad_request");
}

/// A deposit's burn on Base, into `recipient` on Injective (`hook` decides who mints it).
fn deposit_data(recipient: &str, hook: choice_wallet_injective::cctp::Hook, mint_recipient: Option<&str>) -> String {
    use choice_wallet_core::{EthAddress, hexutil};
    use choice_wallet_evm::U256;
    use choice_wallet_injective::cctp::{self, MAINNET};
    let word = |a: &str| cctp::word(&EthAddress::parse_hex(a).unwrap());
    let minter = mint_recipient.unwrap_or(recipient);
    let gas_drop = matches!(hook, cctp::Hook::GasDrop { .. });
    let b = cctp::Burn {
        amount: U256::from_u128(25_000_000),
        domain: cctp::INJECTIVE_DOMAIN,
        mint_recipient: word(minter),
        burn_token: MAINNET.evm_chain(8453).unwrap().usdc(),
        destination_caller: if gas_drop { word(minter) } else { [0; 32] },
        max_fee: U256::from_u128(3_000),
        min_finality: cctp::FAST,
        hook,
    };
    format!("0x{}", hexutil::encode(&cctp::burn_calldata(&b)))
}

#[test]
fn bridging_from_other_evm_chains_builds_decodes_and_signs() {
    use choice_wallet_core::EthAddress;
    use choice_wallet_evm::U256;
    use choice_wallet_injective::cctp::{Hook, MAINNET};
    let me = choice_route("m-inj-usdt")["api"]["recipient"]
        .as_str()
        .unwrap()
        .to_owned();
    let them = "0x2222222222222222222222222222222222222222";
    let base = MAINNET.evm_chain(8453).unwrap();
    let (tm, usdc) = (MAINNET.token_messenger, base.usdc);
    let on_base = |to: &str, amount: &str, call: Value| evm_params("eip155:8453", &me, to, amount, call);

    // The approval: Base's USDC, for Circle's TokenMessengerV2, the exact amount.
    let approve = ok(
        "build_evm",
        on_base(usdc, "25000000", json!({ "type": "bridge_approve" })),
    )["request"]
        .clone();
    assert_eq!(approve["evm_transaction"]["tx"]["chainId"], "0x2105");
    let d = ok(
        "decode",
        json!({ "request": approve, "context": { "balances": { usdc: "30000000", "native": "1000000000000000" } } }),
    );
    assert_eq!(d["display"]["chain"], "eip155:8453");
    assert_eq!(
        d["display"]["network"],
        json!({ "name": "Base", "symbol": "ETH", "decimals": 18, "added": false })
    );
    assert_eq!(
        d["display"]["call"],
        json!({ "type": "approve", "spender": tm, "amount": "25000000" })
    );
    assert_eq!(rules_of(&d), ["allowance"]);
    assert!(approve_and_sign(&approve, account(0))["raw"].is_string());
    // Only on Base's own USDC.
    assert_eq!(
        code(
            "build_evm",
            on_base(MAINNET.usdc, "25000000", json!({ "type": "bridge_approve" }))
        ),
        "bad_request"
    );

    // The burn: minted by anyone, paying this account on Injective.
    let data = deposit_data(&me, Hook::None, None);
    let burn = ok("build_evm", on_base(tm, "0", json!({ "type": "bridge", "data": data })))["request"].clone();
    let d = ok("decode", json!({ "request": burn }));
    let shown = &d["display"]["call"];
    assert_eq!(shown["type"], "bridge");
    assert_eq!(shown["chain"], "Injective");
    assert_eq!(shown["recipient"], me);
    assert_eq!(shown["delivery"], "claim");
    assert_eq!(shown["least"], "24997000");
    assert_eq!(d["risk"]["level"], "info");
    assert_eq!(rules_of(&d), ["bridge", "bridge_to_self", "bridge_in_delivery"]);
    let signed = approve_and_sign(&burn, account(0));
    assert!(signed["raw"].as_str().unwrap().starts_with("0x02"));
    // Another account of the same wallet can't sign it: it is account 0's transaction.
    let (_, secret, unlock_key) = wallet();
    let wrong = call(
        "sign",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "account": account(1), "request": burn, "digest": d["digest"] }),
    );
    assert!(wrong.is_err());

    // Through BridgeReceiver, which buys INJ for gas.
    let receiver = MAINNET.bridge_receiver.unwrap();
    let drop = Hook::GasDrop {
        recipient: EthAddress::parse_hex(&me).unwrap(),
        max_drop_fee: U256::from_u128(500_000),
    };
    let burn = ok(
        "build_evm",
        on_base(
            tm,
            "0",
            json!({ "type": "bridge", "data": deposit_data(&me, drop, Some(receiver)) }),
        ),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": burn }));
    assert_eq!(d["display"]["call"]["delivery"], "gas_drop");
    assert_eq!(d["display"]["call"]["max_drop_fee"], "500000");
    assert_eq!(d["display"]["call"]["least"], "24497000");
    assert_eq!(rules_of(&d), ["bridge", "bridge_to_self", "bridge_gas_drop"]);

    // To someone else on Injective: built, and the review says so.
    let theirs = ok(
        "build_evm",
        on_base(
            tm,
            "0",
            json!({ "type": "bridge", "data": deposit_data(them, Hook::None, None) }),
        ),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": theirs }));
    assert_eq!(d["risk"]["level"], "amber");
    assert!(rules_of(&d).contains(&"bridge_recipient".to_owned()));

    // Refused when built: a gas drop through another contract, coin attached, a swap
    // approval (Choice is on Injective only).
    let other_drop = Hook::GasDrop {
        recipient: EthAddress::parse_hex(&me).unwrap(),
        max_drop_fee: U256::from_u128(1),
    };
    assert_eq!(
        code(
            "build_evm",
            on_base(
                tm,
                "0",
                json!({ "type": "bridge", "data": deposit_data(&me, other_drop, Some(them)) })
            )
        ),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", on_base(tm, "1", json!({ "type": "bridge", "data": data }))),
        "bad_request"
    );
    assert_eq!(
        code("build_evm", on_base(usdc, "25000000", json!({ "type": "approve" }))),
        "invalid"
    );

    // Base is a wallet chain like any other: USDC and ETH sends, and a site's messages.
    let send = ok(
        "build_evm",
        json!({ "chain": "eip155:8453", "from": me, "to": them, "amount": "1", "token": usdc, "nonce": 0, "gas_limit": 60000, "max_fee_per_gas": "1", "max_priority_fee_per_gas": "0" }),
    )["request"]
        .clone();
    let d = ok("decode", json!({ "request": send }));
    assert_eq!(d["display"]["call"]["type"], "erc20_transfer");
    assert!(approve_and_sign(&send, account(0))["raw"].is_string());
    let send = ok(
        "build_evm",
        json!({ "chain": "eip155:8453", "from": me, "to": them, "amount": "1", "nonce": 0, "gas_limit": 21000, "max_fee_per_gas": "1", "max_priority_fee_per_gas": "0" }),
    )["request"]
        .clone();
    assert_eq!(
        ok("decode", json!({ "request": send }))["display"]["call"]["type"],
        "transfer"
    );
    let message = json!({ "evm_personal_sign": { "chain": "eip155:8453", "signer": me, "message": "hi" } });
    assert!(call("decode", json!({ "request": message })).is_ok());
    // A site's burn of another chain's USDC on Base is red.
    let tx = |to: &str, data: &str, value: &str| {
        json!({ "evm_transaction": { "chain": "eip155:8453", "tx": {
            "type": "0x2", "chainId": "0x2105", "from": me, "to": to, "value": value, "data": data,
            "nonce": "0x0", "gas": "0x30d40", "maxFeePerGas": "0x1", "maxPriorityFeePerGas": "0x0",
        } } })
    };
    let d = ok(
        "decode",
        json!({ "request": tx(tm, &burn_data(&me, 3, Hook::Forward, 200_000), "0x0") }),
    );
    assert_eq!(d["risk"]["level"], "red");
    assert!(rules_of(&d).contains(&"bridge_token".to_owned()));
    // Another EVM chain is one the user added (tests/evm.rs); an ID in another form is none.
    assert_eq!(
        code(
            "decode",
            json!({ "request": { "evm_personal_sign": { "chain": "eip155:056", "signer": me, "message": "hi" } } })
        ),
        "unknown_chain"
    );
}

#[test]
fn own_bridge_receive_mints_attested_transfers() {
    use choice_wallet_core::{EthAddress, hexutil};
    use choice_wallet_evm::U256;
    use choice_wallet_injective::cctp::{self, MAINNET};
    let me = choice_route("m-inj-usdt")["api"]["recipient"]
        .as_str()
        .unwrap()
        .to_owned();
    let them = "0x2222222222222222222222222222222222222222";
    // A message as MessageTransmitterV2 lays it out: 25 USDC burned on Base, 0.0025 to Circle.
    let message = |recipient: &str, token: EthAddress, source: u32| {
        let tm = cctp::word(&MAINNET.token_messenger());
        let mut m = Vec::new();
        for n in [1u32, source, 29] {
            m.extend_from_slice(&n.to_be_bytes());
        }
        m.extend_from_slice(&[3; 32]);
        m.extend_from_slice(&tm);
        m.extend_from_slice(&tm);
        m.extend_from_slice(&[0; 32]);
        m.extend_from_slice(&1000u32.to_be_bytes());
        m.extend_from_slice(&1000u32.to_be_bytes());
        m.extend_from_slice(&1u32.to_be_bytes());
        m.extend_from_slice(&cctp::word(&token));
        m.extend_from_slice(&cctp::word(&EthAddress::parse_hex(recipient).unwrap()));
        m.extend_from_slice(&U256::from_u128(25_000_000).to_be_bytes());
        m.extend_from_slice(&cctp::word(&EthAddress::parse_hex(recipient).unwrap()));
        m.extend_from_slice(&U256::from_u128(3_000).to_be_bytes());
        m.extend_from_slice(&U256::from_u128(2_500).to_be_bytes());
        m.extend_from_slice(&[0; 32]);
        hexutil::encode(&m)
    };
    let base_usdc = MAINNET.evm_chain(8453).unwrap().usdc();
    let mt = MAINNET.message_transmitter;
    let receive = |m: String| {
        evm_params(
            "eip155:1776",
            &me,
            mt,
            "0",
            json!({ "type": "bridge_receive", "message": m, "attestation": "07".repeat(65) }),
        )
    };
    let request = ok("build_evm", receive(message(&me, base_usdc, 6)))["request"].clone();
    let d = ok("decode", json!({ "request": request }));
    let call = &d["display"]["call"];
    assert_eq!(call["type"], "bridge_receive");
    assert_eq!(call["chain"], "Base");
    assert_eq!(call["recipient"], me);
    assert_eq!(call["minted"], "24997500");
    assert_eq!(call["token"], MAINNET.usdc);
    assert_eq!(d["risk"]["level"], "info");
    assert_eq!(rules_of(&d), ["bridge_receive"]);
    assert!(approve_and_sign(&request, account(0))["raw"].is_string());

    // Someone else's: built (the wallet pays the gas, and the review says so).
    let request = ok("build_evm", receive(message(them, base_usdc, 6)))["request"].clone();
    let d = ok("decode", json!({ "request": request }));
    assert_eq!(d["risk"]["level"], "amber");
    assert!(rules_of(&d).contains(&"bridge_receive_other".to_owned()));
    // Another token, an unnamed chain, the wrong contract: not built.
    assert_eq!(
        code("build_evm", receive(message(&me, MAINNET.usdc(), 6))),
        "bad_request"
    );
    assert_eq!(code("build_evm", receive(message(&me, base_usdc, 12))), "bad_request");
    assert_eq!(
        code(
            "build_evm",
            evm_params(
                "eip155:1776",
                &me,
                MAINNET.token_messenger,
                "0",
                json!({ "type": "bridge_receive", "message": message(&me, base_usdc, 6), "attestation": "07" })
            )
        ),
        "bad_request"
    );
    // A site may ask for someone else's mint; it is shown as theirs.
    let mut theirs = ok("build_evm", receive(message(&me, base_usdc, 6)))["request"].clone();
    let data = cctp::receive_calldata(&hexutil::decode(&message(them, base_usdc, 6)).unwrap(), &[7; 65]);
    theirs["evm_transaction"]["tx"]["data"] = format!("0x{}", hexutil::encode(&data)).into();
    let d = ok("decode", json!({ "request": theirs }));
    assert_eq!(d["risk"]["level"], "amber");
    assert!(rules_of(&d).contains(&"bridge_receive_other".to_owned()));

    // From Solana: the sender is Circle's program there, the token Solana's USDC mint.
    let program = choice_wallet_core::base58::decode32(MAINNET.solana.token_messenger_minter).unwrap();
    let solana = |sender: [u8; 32], token: [u8; 32]| {
        let mut m = hexutil::decode(&message(&me, base_usdc, 5)).unwrap();
        m[44..76].copy_from_slice(&sender);
        m[148 + 4..148 + 36].copy_from_slice(&token);
        hexutil::encode(&m)
    };
    let request = ok("build_evm", receive(solana(program, MAINNET.solana.usdc_mint())))["request"].clone();
    let d = ok("decode", json!({ "request": request }));
    assert_eq!(d["display"]["call"]["chain"], "Solana");
    assert_eq!(d["display"]["call"]["known_token"], true);
    assert_eq!(d["risk"]["level"], "info");
    // Not from Circle's program, or not its USDC: refused.
    assert_eq!(
        code("build_evm", receive(solana([9; 32], MAINNET.solana.usdc_mint()))),
        "bad_request"
    );
    assert_eq!(code("build_evm", receive(solana(program, [9; 32]))), "bad_request");
}
