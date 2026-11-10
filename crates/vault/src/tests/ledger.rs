// Hardware wallets: a software Ledger signs what the vault decoded, in each app's form.

use super::*;

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
    // Its Solana address comes from the device's Solana app, a key of its own: without it,
    // only the others.
    let secp: serde_json::Map<String, Value> = soft["accounts"][0]["addresses"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| !k.starts_with("solana:"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    assert_eq!(info["addresses"], Value::Object(secp));
    assert_eq!(info["public_key"], soft["accounts"][0]["public_key"]);
    // With the Solana app's key at Ledger Live's path, every address the phrase gives.
    let m = choice_wallet_core::Mnemonic::parse(vectors("direct")["phrase"].as_str().unwrap()).unwrap();
    let sol = choice_wallet_core::ed25519::derive(&m, "m/44'/501'/0'").unwrap();
    let both = ok(
        "key_addresses",
        json!({ "public_key": pk, "solana_public_key": hex::encode(sol.public_key()) }),
    );
    assert_eq!(both["addresses"], soft["accounts"][0]["addresses"]);
    // A hash off the curve (a program-derived address) isn't a key anyone holds.
    let pda = choice_wallet_core::base58::decode32("45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE").unwrap();
    assert_eq!(
        code(
            "key_addresses",
            json!({ "public_key": pk, "solana_public_key": hex::encode(pda) })
        ),
        "bad_request"
    );

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
fn a_ledger_signs_arbitrary_messages_in_the_cosmos_app() {
    use choice_wallet_core::secp256k1::keccak256;
    let ledger = FakeLedger::new(0);
    let pk = ledger.public_key();
    let request =
        json!({ "cosmos_arbitrary": { "chain": "cosmos:injective-1", "signer": pk, "data": hex::encode("Sign in") } });
    let digest = ok("decode", json!({ "request": request }))["digest"].clone();
    let dev = ok("device_request", json!({ "request": request, "digest": digest }));
    assert_eq!(
        (dev["app"].as_str(), dev["kind"].as_str()),
        (Some("cosmos"), Some("amino"))
    );
    let doc = hex::decode(dev["payload"].as_str().unwrap()).unwrap();
    let signed = ok(
        "device_sign",
        json!({ "request": request, "digest": digest, "public_key": pk, "signature": ledger.der(&keccak256(&doc), true), "format": "der" }),
    );
    assert_eq!(signed["signature"], approve_and_sign(&request, LEDGER_0())["signature"]);
}
