// Solana: each account's key, transactions and messages decoded and signed, devices.

use super::*;

fn solana_vectors() -> Value {
    serde_json::from_str(include_str!("../../../solana/tests/vectors/messages.json")).unwrap()
}

const SOLANA_MAINNET: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

#[test]
fn a_phrase_has_solana_accounts_and_an_imported_key_has_none() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (_, a, uk) = vault_with(json!({ "mnemonic": phrase }));
    let accounts = ok(
        "accounts",
        json!({ "secret": a, "wallet": "w1", "unlock_key": uk, "accounts": [
            account(0), account(1), { "derivation": "ledger_live", "index": 1 },
        ] }),
    );
    // Phantom's addresses for the phrase (m/44'/501'/i'/0'), Ledger Live's (m/44'/501'/i').
    for (i, want) in [
        "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
        "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb",
        "ANf3TEKFL6jPWjzkndo4CbnNdUNkBk4KHPggJs2nu8Xi",
    ]
    .iter()
    .enumerate()
    {
        let addresses = &accounts["accounts"][i]["addresses"];
        assert_eq!(addresses[SOLANA_MAINNET], *want, "account {i}");
        assert_eq!(addresses[SOLANA_DEVNET], *want, "account {i}");
    }
    let (_, b, uk) = vault_with(json!({ "private_key": "46".repeat(32) }));
    let imported = ok(
        "accounts",
        json!({ "secret": b, "wallet": "w1", "unlock_key": uk, "accounts": [{ "derivation": "imported" }] }),
    );
    assert!(imported["accounts"][0]["addresses"].get(SOLANA_MAINNET).is_none());
    let request = json!({ "solana_message": { "chain": SOLANA_MAINNET, "signer": "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", "message": "6869" } });
    let d = ok("decode", json!({ "request": request }));
    let err = call(
        "sign",
        json!({ "secret": b, "wallet": "w1", "unlock_key": uk, "account": { "derivation": "imported" }, "request": request, "digest": d["digest"] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "keystore");
}

#[test]
fn an_accounts_solana_key_exports_as_phantom_imports_it() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (vault, a, _) = vault_with(json!({ "mnemonic": phrase }));
    let shown = ok(
        "reveal",
        json!({ "vault": vault, "password": PASSWORD, "secret": a, "wallet": "w1", "account": account(0) }),
    );
    // base58 of the 32-byte secret, then the public key: Phantom's "private key" import.
    let pair = choice_wallet_core::base58::decode(shown["solana_private_key"].as_str().unwrap()).unwrap();
    assert_eq!(pair.len(), 64);
    let k = choice_wallet_core::ed25519::Ed25519Key::from_secret(&pair[..32].try_into().unwrap());
    assert_eq!(k.address(), "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    assert_eq!(&pair[32..], &k.public_key());
}

#[test]
fn solana_transactions_decode_and_sign() {
    let v = solana_vectors();
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (_, secret, uk) = vault_with(json!({ "mnemonic": phrase }));
    let tx = |message: &Value| json!({ "solana_transaction": { "chain": SOLANA_MAINNET, "signer": v["owner"], "message": message } });
    let sign = |request: &Value, acct: Value| {
        let d = ok("decode", json!({ "request": request }));
        call(
            "sign",
            json!({ "secret": secret, "wallet": "w1", "unlock_key": uk, "account": acct, "request": request, "digest": d["digest"] }),
        )
    };

    // 0.01 SOL to another wallet: shown, graded, signed by account 0's Solana key.
    let send = tx(&v["sol_transfer"]);
    let d = ok("decode", json!({ "request": send }));
    assert_eq!(d["display"]["kind"], "solana_transaction");
    assert_eq!(d["display"]["fee"]["total"], "5200");
    let step = &d["display"]["instructions"][2];
    assert_eq!(
        (step["type"].as_str(), step["to"].as_str(), step["lamports"].as_str()),
        (Some("sol_transfer"), v["other"].as_str(), Some("10000000"))
    );
    assert_eq!(d["risk"]["level"], "info");
    let signed = sign(&send, account(0)).unwrap();
    let message = hex::decode(v["sol_transfer"].as_str().unwrap()).unwrap();
    let sig: [u8; 64] = hex::decode(signed["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let owner = choice_wallet_core::base58::decode32(v["owner"].as_str().unwrap()).unwrap();
    assert!(choice_wallet_core::ed25519::verify(&owner, &message, &sig));
    assert_eq!(signed["index"], 0);
    assert_eq!(
        signed["transaction"].as_str().unwrap(),
        format!("01{}{}", hex::encode(sig), hex::encode(&message))
    );
    // Another account's key isn't the signer; an approval binds the exact message.
    assert_eq!(sign(&send, account(1)).unwrap_err()["code"], "wrong_account");
    let d = ok("decode", json!({ "request": send }));
    let other = tx(&v["burn_plain"]);
    let err = call(
        "sign",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": uk, "account": account(0), "request": other, "digest": d["digest"] }),
    )
    .unwrap_err();
    assert_eq!(err["code"], "not_approved");
    // A transaction this account doesn't sign is refused before anyone sees it.
    let theirs = json!({ "solana_transaction": { "chain": SOLANA_MAINNET, "signer": v["other"], "message": v["sol_transfer"] } });
    assert_eq!(code("decode", json!({ "request": theirs })), "wrong_account");

    // USDC to Injective over CCTP: the burn read, to this account's 0x address, Circle's fee
    // capped; signed by the owner, with the burn's record (the event account) left to sign.
    let burn = tx(&v["burn_plain"]);
    let d = ok("decode", json!({ "request": burn }));
    let b = &d["display"]["instructions"][2];
    assert_eq!(b["type"], "bridge");
    assert_eq!(
        (b["chain"].as_str(), b["recipient"].as_str()),
        (Some("Injective"), v["me_evm"].as_str())
    );
    assert_eq!(
        (b["delivery"].as_str(), b["least"].as_str(), b["usdc"].as_bool()),
        (Some("anyone"), Some("1999700"), Some(true))
    );
    assert_eq!(d["display"]["signers"], json!([v["owner"], v["event"]]));
    let signed = sign(&burn, account(0)).unwrap();
    assert_eq!(signed["index"], 0);
    assert!(signed.get("transaction").is_none());
    // With the user's own 0x account in the address book, it is theirs: no amber.
    let ctx = json!({ "address_book": [{ "address": v["me_evm"], "mine": true }] });
    let d = ok("decode", json!({ "request": burn, "context": ctx }));
    assert_eq!(d["risk"]["level"], "info", "{}", d["risk"]);

    // The rent back, and a gas drop through Choice's contract.
    let reclaim = ok("decode", json!({ "request": tx(&v["reclaim"]) }));
    assert_eq!(reclaim["display"]["instructions"][0]["type"], "bridge_reclaim");
    let drop = ok("decode", json!({ "request": tx(&v["burn_drop"]) }));
    let b = &drop["display"]["instructions"][2];
    assert_eq!(
        (
            b["delivery"].as_str(),
            b["recipient"].as_str(),
            b["max_drop_fee"].as_str()
        ),
        (Some("gas_drop"), v["me_evm"].as_str(), Some("200000"))
    );

    // Only the clusters the vault knows.
    let unknown = json!({ "solana_transaction": { "chain": "solana:mainnet", "signer": v["owner"], "message": v["sol_transfer"] } });
    assert_eq!(code("decode", json!({ "request": unknown })), "unknown_chain");
}

#[test]
fn solana_messages_and_devices() {
    let v = solana_vectors();
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (_, secret, uk) = vault_with(json!({ "mnemonic": phrase }));
    let owner = v["owner"].as_str().unwrap();
    let msg = |hex: &str| json!({ "solana_message": { "chain": SOLANA_DEVNET, "signer": owner, "message": hex } });
    let text = msg(&hex::encode("Sign in to example.org"));
    let d = ok("decode", json!({ "request": text }));
    assert_eq!(d["display"]["text"], "Sign in to example.org");
    let signed = ok(
        "sign",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": uk, "account": account(0), "request": text, "digest": d["digest"] }),
    );
    let sig: [u8; 64] = hex::decode(signed["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let key = choice_wallet_core::base58::decode32(owner).unwrap();
    assert!(choice_wallet_core::ed25519::verify(
        &key,
        b"Sign in to example.org",
        &sig
    ));
    // A transaction dressed as a message is refused.
    assert_eq!(
        code("decode", json!({ "request": msg(v["sol_transfer"].as_str().unwrap()) })),
        "invalid"
    );

    // A Ledger's Solana app signs the exact message; the vault checks the signature.
    let send =
        json!({ "solana_transaction": { "chain": SOLANA_MAINNET, "signer": owner, "message": v["sol_transfer"] } });
    let d = ok("decode", json!({ "request": send }));
    let dev = ok("device_request", json!({ "request": send, "digest": d["digest"] }));
    assert_eq!(
        (dev["app"].as_str(), dev["payload"].as_str()),
        (Some("solana"), v["sol_transfer"].as_str())
    );
    let m = choice_wallet_core::Mnemonic::parse(phrase).unwrap();
    let device = choice_wallet_core::ed25519::derive(&m, "m/44'/501'/0'/0'").unwrap();
    let message = hex::decode(v["sol_transfer"].as_str().unwrap()).unwrap();
    let device_sign = |sig: &[u8]| {
        call(
            "device_sign",
            json!({ "request": send, "digest": d["digest"], "public_key": hex::encode(key), "signature": hex::encode(sig), "format": "rs" }),
        )
    };
    let good = device_sign(&device.sign(&message)).unwrap();
    assert!(good["transaction"].as_str().unwrap().starts_with("01"));
    let mut bad = device.sign(&message);
    bad[5] ^= 1;
    assert_eq!(device_sign(&bad).unwrap_err()["code"], "bad_signature");
    assert_eq!(
        code(
            "device_request",
            json!({ "request": text, "digest": ok("decode", json!({ "request": text }))["digest"] })
        ),
        "device_unsupported"
    );
}
