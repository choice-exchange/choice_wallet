// Vaults and keys: wallets behind one password, revealing and rewrapping, accounts and
// their addresses against injective-ts, imported keys, keystores from before vaults.

use super::*;

#[test]
fn several_wallets_behind_one_password() {
    let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let (vault, a, uk) = vault_with(json!({ "mnemonic": phrase }));
    let b = ok(
        "seal_secret",
        json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": "46".repeat(32) } }),
    );
    assert_eq!(b["kind"], "private_key");
    // One unlock opens both.
    let key = ok("unlock", json!({ "vault": vault, "password": PASSWORD }))["unlock_key"].clone();
    assert_eq!(key, uk);
    let first = ok(
        "accounts",
        json!({ "secret": a, "wallet": "w1", "unlock_key": key, "accounts": [account(0)] }),
    );
    assert_eq!(
        first["accounts"][0]["addresses"]["eip155:1776"],
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    );
    let imported = ok(
        "accounts",
        json!({ "secret": b["secret"], "wallet": "w2", "unlock_key": key, "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(
        imported["accounts"][0]["addresses"]["eip155:1776"],
        "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F"
    );
    // A secret opens only as the wallet it was sealed for.
    assert_eq!(
        code(
            "accounts",
            json!({ "secret": a, "wallet": "w2", "unlock_key": key, "accounts": [account(0)] })
        ),
        "wrong_password"
    );
    assert_eq!(
        code(
            "seal_secret",
            json!({ "unlock_key": key, "wallet": "W 1", "secret": { "mnemonic": phrase } })
        ),
        "keystore"
    );
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
    let key = ok(
        "reveal",
        reveal(json!({ "account": { "derivation": "default", "index": 1 } })),
    )["private_key"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(key.len(), 64);
    let b = ok(
        "seal_secret",
        json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": key } }),
    );
    let a = ok(
        "accounts",
        json!({ "secret": b["secret"], "wallet": "w2", "unlock_key": uk, "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(
        a["accounts"][0]["addresses"]["eip155:1776"],
        "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0"
    );
    assert_eq!(
        ok(
            "reveal",
            json!({ "vault": vault, "password": PASSWORD, "secret": b["secret"], "wallet": "w2" })
        )["private_key"],
        key
    );
    assert_eq!(
        code("reveal", reveal(json!({ "password": "not the password" }))),
        "wrong_password"
    );
    // The unlock key alone isn't enough: the method takes no such field.
    assert_eq!(
        code(
            "reveal",
            json!({ "vault": vault, "unlock_key": uk, "secret": sealed, "wallet": "w1" })
        ),
        "bad_request"
    );
}

#[test]
fn change_password_rewraps_the_vault_and_keeps_its_key() {
    let (vault, sealed, uk) = vault_with(json!({ "private_key": "46".repeat(32) }));
    let next = ok(
        "change_password",
        json!({ "vault": vault, "password": PASSWORD, "new_password": "a whole new password" }),
    )["vault"]
        .clone();
    assert_ne!(next, vault);
    assert_eq!(
        code("unlock", json!({ "vault": next, "password": PASSWORD })),
        "wrong_password"
    );
    assert_eq!(
        ok("unlock", json!({ "vault": next, "password": "a whole new password" }))["unlock_key"],
        uk
    );
    let shown = ok(
        "reveal",
        json!({ "vault": next, "password": "a whole new password", "secret": sealed, "wallet": "w1" }),
    );
    assert_eq!(shown["private_key"], "46".repeat(32));
    assert_eq!(
        code(
            "change_password",
            json!({ "vault": vault, "password": "wrong one", "new_password": "a whole new password" })
        ),
        "wrong_password"
    );
    assert_eq!(
        code(
            "change_password",
            json!({ "vault": vault, "password": PASSWORD, "new_password": "short" })
        ),
        "keystore"
    );
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
    let wrong = code("unlock", json!({ "vault": vault, "password": "not the password" }));
    assert_eq!(wrong, "wrong_password");
    let imported = code(
        "accounts",
        json!({ "secret": secret, "wallet": "w1", "unlock_key": unlock_key, "accounts": [{ "derivation": "imported" }] }),
    );
    assert_eq!(imported, "keystore");
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
    assert_eq!(
        r["accounts"][0]["addresses"]["eip155:1776"],
        "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F"
    );
    let hd = code(
        "accounts",
        json!({ "secret": sealed, "wallet": "w1", "unlock_key": uk, "accounts": [account(0)] }),
    );
    assert_eq!(hd, "keystore");
    assert_eq!(code("create_vault", json!({ "password": "short" })), "keystore");
    assert_eq!(
        code(
            "seal_secret",
            json!({ "unlock_key": uk, "wallet": "w2", "secret": { "private_key": "00".repeat(32) } })
        ),
        "keystore"
    );
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
    assert_eq!(
        code(
            "migrate",
            json!({ "keystore": old, "password": "not the password", "wallet": "w1" })
        ),
        "wrong_password"
    );
    let m = ok(
        "migrate",
        json!({ "keystore": old, "password": PASSWORD, "wallet": "w1" }),
    );
    assert_eq!(m["kind"], "mnemonic");
    assert_eq!(
        ok("unlock", json!({ "vault": m["vault"], "password": PASSWORD }))["unlock_key"],
        m["unlock_key"]
    );
    let a = ok(
        "accounts",
        json!({ "secret": m["secret"], "wallet": "w1", "unlock_key": m["unlock_key"], "accounts": [account(0)] }),
    );
    assert_eq!(
        a["accounts"][0]["addresses"]["eip155:1776"],
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    );
}
