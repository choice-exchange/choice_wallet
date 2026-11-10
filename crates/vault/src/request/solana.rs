//! Solana requests: a transaction read and checked to be one this account signs, its
//! display (what each instruction does, by the cluster's own programs and Circle's CCTP),
//! and signing it with the account's key or checking a device's signature.

use super::*;

pub(super) fn solana_chain(id: &str) -> Result<&'static SolanaChain, VaultError> {
    chains::solana(id).ok_or_else(|| VaultError::new(crate::error::UNKNOWN_CHAIN, format!("unknown chain {id:?}")))
}

pub(super) fn solana_key_of(s: &str) -> Result<[u8; 32], VaultError> {
    base58::decode32(s.trim()).ok_or_else(|| VaultError::bad(format!("invalid Solana address {s:?}")))
}

/// A Solana transaction: read, checked to be one this account signs, and described.
pub(super) fn solana_tx(
    chain: &str,
    signer: &str,
    message: &str,
    tables: &[LookupTable],
) -> Result<Checked, VaultError> {
    let cluster = solana_chain(chain)?;
    let signer = solana_key_of(signer)?;
    let bytes = hex(message, "message")?;
    let tables = tables
        .iter()
        .map(|t| {
            Ok((
                solana_key_of(&t.address)?,
                t.addresses
                    .iter()
                    .map(|a| solana_key_of(a))
                    .collect::<Result<Vec<_>, VaultError>>()?,
            ))
        })
        .collect::<Result<Vec<_>, VaultError>>()?;
    let read = choice_wallet_solana::read(&bytes, &tables)
        .map_err(|e| VaultError::new(INVALID, format!("not a Solana transaction the wallet reads: {e}")))?;
    if !read.signs(&signer) {
        return Err(VaultError::new(
            WRONG_ACCOUNT,
            "this account doesn't sign this transaction",
        ));
    }
    Ok(Checked {
        display: solana_display(cluster, &read, &signer),
        digest: digest("solana_transaction", cluster.id, &signer, &bytes),
        kind: Kind::SolanaTx {
            read: Box::new(read),
            bytes,
            signer,
            chain: cluster,
        },
    })
}

fn solana_display(cluster: &SolanaChain, r: &choice_wallet_solana::Read, signer: &[u8; 32]) -> Value {
    use choice_wallet_solana::message::Version;
    let b58 = |k: &[u8; 32]| base58::encode(k);
    json!({
        "kind": "solana_transaction",
        "chain": cluster.id,
        "signer": b58(signer),
        "fee_payer": b58(r.message.fee_payer()),
        "signers": r.message.signers().iter().map(b58).collect::<Vec<_>>(),
        "version": match r.message.version { Version::Legacy => "legacy", Version::V0 => "v0" },
        "fee": {
            "base": r.fee.base.to_string(),
            "priority": r.fee.priority.to_string(),
            "total": r.fee.total().to_string(),
            "unit_limit": r.fee.unit_limit,
            "unit_price": r.fee.unit_price.map(|p| p.to_string()),
        },
        "durable_nonce": r.durable_nonce,
        "lookup_tables": r.message.lookups.iter().map(|l| b58(&l.table)).collect::<Vec<_>>(),
        "instructions": r.steps.iter().map(|s| solana_step(cluster, r, s)).collect::<Vec<_>>(),
    })
}

/// One instruction for the approval screen: what it does, in the chain's terms.
fn solana_step(cluster: &SolanaChain, r: &choice_wallet_solana::Read, s: &choice_wallet_solana::Step) -> Value {
    use choice_wallet_solana::program::{self, Instruction as I};
    let b58 = |k: &[u8; 32]| base58::encode(k);
    let opt = |k: &Option<[u8; 32]>| k.as_ref().map(b58);
    let created_for = |account: &[u8; 32]| {
        r.steps.iter().find_map(|o| match &o.instruction {
            I::CreateTokenAccount { account: a, owner, .. } if a == account => Some(b58(owner)),
            _ => None,
        })
    };
    let mut v = match &s.instruction {
        I::Transfer { from, to, lamports } => {
            json!({ "type": "sol_transfer", "from": b58(from), "to": b58(to), "lamports": lamports.to_string() })
        }
        I::CreateAccount {
            from,
            account,
            lamports,
            space,
            owner,
        } => json!({
            "type": "create_account", "from": b58(from), "account": b58(account), "lamports": lamports.to_string(),
            "space": space.to_string(), "owner": b58(owner), "owner_name": program::name(owner),
        }),
        I::Assign { account, owner } => {
            json!({ "type": "assign", "account": b58(account), "owner": b58(owner), "owner_name": program::name(owner) })
        }
        I::AdvanceNonce { nonce, authority } => {
            json!({ "type": "advance_nonce", "nonce": b58(nonce), "authority": b58(authority) })
        }
        I::ComputeUnitLimit(n) => json!({ "type": "compute_budget", "unit_limit": n }),
        I::ComputeUnitPrice(p) => json!({ "type": "compute_budget", "unit_price": p.to_string() }),
        I::TokenTransfer {
            source,
            destination,
            authority,
            amount,
            mint,
            decimals,
            ..
        } => json!({
            "type": "token_transfer", "source": b58(source), "destination": b58(destination),
            "destination_owner": created_for(destination), "authority": b58(authority),
            "amount": amount.to_string(), "mint": opt(mint), "decimals": decimals,
            "usdc": mint.is_some_and(|m| m == cluster.network.cctp.solana.usdc_mint()),
        }),
        I::TokenApprove {
            source,
            delegate,
            owner,
            amount,
            mint,
            decimals,
            ..
        } => json!({
            "type": "token_approve", "source": b58(source), "delegate": b58(delegate), "owner": b58(owner),
            "amount": amount.to_string(), "mint": opt(mint), "decimals": decimals,
        }),
        I::TokenRevoke { source, owner, .. } => {
            json!({ "type": "token_revoke", "source": b58(source), "owner": b58(owner) })
        }
        I::TokenSetAuthority {
            account,
            kind,
            new_authority,
            current,
            ..
        } => json!({
            "type": "token_set_authority", "account": b58(account), "authority_kind": kind,
            "new_authority": opt(new_authority), "current": b58(current),
        }),
        I::TokenClose {
            account,
            destination,
            owner,
            ..
        } => {
            json!({ "type": "token_close", "account": b58(account), "destination": b58(destination), "owner": b58(owner) })
        }
        I::TokenBurn {
            account,
            mint,
            owner,
            amount,
            decimals,
            ..
        } => json!({
            "type": "token_burn", "account": b58(account), "mint": b58(mint), "owner": b58(owner),
            "amount": amount.to_string(), "decimals": decimals,
        }),
        I::TokenSyncNative { account } => json!({ "type": "token_sync_native", "account": b58(account) }),
        I::TokenInitializeAccount {
            account, mint, owner, ..
        } => {
            json!({ "type": "token_init", "account": b58(account), "mint": b58(mint), "owner": b58(owner) })
        }
        I::TokenOther { kind, .. } => json!({ "type": "token_other", "kind": kind }),
        I::CreateTokenAccount {
            payer,
            account,
            owner,
            mint,
            idempotent,
            ..
        } => json!({
            "type": "create_token_account", "payer": b58(payer), "account": b58(account), "owner": b58(owner),
            "mint": b58(mint), "idempotent": idempotent,
        }),
        I::Memo(m) => json!({ "type": "memo", "text": std::str::from_utf8(m).ok(), "hex": hexutil::encode(m) }),
        I::CctpBurn(b) => solana_bridge(&cluster.network.cctp, b),
        I::CctpReclaim { payee, event_account } => {
            json!({ "type": "bridge_reclaim", "payee": b58(payee), "event_account": b58(event_account) })
        }
        I::Unreadable { reason, .. } => json!({ "type": "unreadable", "reason": reason }),
        I::Other { .. } => json!({
            "type": "program",
            "accounts": s.accounts.iter().map(|a| json!({
                "address": b58(&a.key),
                "signer": a.signer,
                "writable": a.writable,
                "table": a.table.map(|(t, i)| json!({ "address": b58(&t), "index": i })),
            })).collect::<Vec<_>>(),
            "data": hexutil::encode(&s.data),
        }),
    };
    v["program"] = Value::String(b58(&s.program));
    v["program_name"] = json!(program::name(&s.program));
    v
}

/// A burn on Solana: where it goes, who gets it there, who delivers, and what Circle (and a
/// gas drop) may keep.
fn solana_bridge(c: &cctp::Cctp, b: &choice_wallet_solana::program::CctpBurn) -> Value {
    use cctp::{AddressKind, Hook};
    let hook = b.hook.as_deref().map_or(Hook::None, cctp::read_hook);
    let domain = c.destination(cctp::SOLANA_DOMAIN, b.domain);
    let evm_in = |w: &[u8; 32]| {
        w[..12]
            .iter()
            .all(|&x| x == 0)
            .then(|| EthAddress::from_bytes(w[12..].try_into().expect("20 bytes")).to_checksum_hex())
    };
    let (recipient, delivery, drop) = match &hook {
        Hook::GasDrop {
            recipient,
            max_drop_fee,
        } => (Some(recipient.to_checksum_hex()), "gas_drop", Some(*max_drop_fee)),
        _ => (
            match domain.map(|d| d.kind) {
                Some(AddressKind::Evm) => evm_in(&b.mint_recipient),
                Some(AddressKind::Solana) => Some(base58::encode(&b.mint_recipient)),
                None => None,
            },
            match (&hook, b.destination_caller == [0; 32]) {
                (_, false) => "caller",
                (Hook::None, true) => "anyone",
                (Hook::Forward | Hook::ForwardWithAccount { .. }, true) => "circle",
                _ => "hook",
            },
            None,
        ),
    };
    let fees = U256::from_u128(b.max_fee.into())
        .checked_add(&drop.unwrap_or(U256::ZERO))
        .unwrap_or(U256::MAX);
    let amount = U256::from_u128(b.amount.into());
    json!({
        "type": "bridge",
        "amount": b.amount.to_string(),
        "token": base58::encode(&b.mint),
        "usdc": b.mint == c.solana.usdc_mint(),
        "domain": b.domain,
        "chain": domain.map(|d| d.name),
        "recipient": recipient,
        "max_fee": b.max_fee.to_string(),
        "finality": b.min_finality,
        "delivery": delivery,
        "max_drop_fee": drop.map(|d| d.to_string()),
        "least": amount.checked_sub(&fees).unwrap_or(U256::ZERO).to_string(),
        "owner": base58::encode(&b.owner),
        "event_account": base58::encode(&b.event_account),
    })
}

/// Sign an approved Solana request with the account's Solana key.
pub(crate) fn sign_solana(checked: Checked, approved: &str, key: &Ed25519Key) -> Result<Value, VaultError> {
    check_approved(&checked, approved)?;
    solana_signed(checked, &key.public_key(), |bytes| Ok(key.sign(bytes)))
}

/// An approved Solana transaction signed by a hardware wallet's Solana key: the signature
/// must verify against `public_key` over the exact message, and that key must be the signer.
pub(crate) fn device_sign_solana(
    checked: Checked,
    approved: &str,
    public_key: &[u8; 32],
    signature: &[u8],
) -> Result<Value, VaultError> {
    check_approved(&checked, approved)?;
    let bad = || {
        VaultError::new(
            BAD_SIGNATURE,
            "the device's signature isn't this account's, for this request",
        )
    };
    let sig: [u8; 64] = signature.try_into().map_err(|_| bad())?;
    solana_signed(checked, public_key, |bytes| {
        ed25519::verify(public_key, bytes, &sig).then_some(sig).ok_or_else(bad)
    })
}

fn solana_signed(
    checked: Checked,
    public_key: &[u8; 32],
    sign: impl FnOnce(&[u8]) -> Result<[u8; 64], VaultError>,
) -> Result<Value, VaultError> {
    let wrong_account = || VaultError::new(WRONG_ACCOUNT, "this account is not the request's signer");
    match checked.kind {
        Kind::SolanaTx {
            read, bytes, signer, ..
        } => {
            if *public_key != signer {
                return Err(wrong_account());
            }
            let sig = sign(&bytes)?;
            let signers = read.message.signers();
            let index = signers
                .iter()
                .position(|k| *k == signer)
                .expect("decode checked that it signs");
            let mut out = json!({ "signature": hexutil::encode(&sig), "index": index });
            // The only signer: the transaction is complete.
            if signers.len() == 1 {
                let wire = [&[1u8][..], &sig, &bytes].concat();
                out["transaction"] = Value::String(hexutil::encode(&wire));
            }
            Ok(out)
        }
        Kind::SolanaMessage { message, signer } => {
            if *public_key != signer {
                return Err(wrong_account());
            }
            Ok(json!({ "signature": hexutil::encode(&sign(&message)?) }))
        }
        _ => Err(VaultError::bad("not a Solana request")),
    }
}
