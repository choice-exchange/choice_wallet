//! Signing requests: decode, show, approve, sign.
//!
//! [`decode`] checks a request and returns what the approval screen shows, plus a digest.
//! [`sign`] decodes the request again, refuses it unless the digest matches the one that
//! was approved, and only then signs. So a host can't sign anything the user wasn't
//! shown, and an approval can't be reused for a different request or account.
//!
//! The digest is keccak256 over a domain tag and, length-prefixed: the request kind, the
//! chain, the signer, and the exact bytes (or, for typed data, the EIP-712 hash) that get
//! signed.

use choice_wallet_core::secp256k1::keccak256;
use choice_wallet_core::{EthAddress, PrivateKey, PublicKey, hexutil};
use choice_wallet_cosmos::amino::{self, AminoTx};
use choice_wallet_cosmos::direct::{self, Decoded, Request};
use choice_wallet_evm::U256;
use choice_wallet_evm::eip712::TypedData;
use choice_wallet_evm::personal;
use choice_wallet_evm::request::{self as evm_request, Call, TxRequest};
use choice_wallet_injective::cctp::{self, Delivery, Source, SourceCall};
use choice_wallet_injective::eip712::{Web3Tx, decode_v2};
use choice_wallet_policy::{Assessment, Context, CosmosFee};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::chains::{self, Entry};
use crate::error::{BAD_SIGNATURE, DEVICE_UNSUPPORTED, INVALID, NOT_APPROVED, VaultError, WRONG_ACCOUNT};
use crate::util::{U64, hex, json_text};

/// A request to sign, as hosts send it. Byte fields are hex without a prefix.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SignRequest<'a> {
    /// `signDirect`, and the wallet's own Cosmos transactions.
    CosmosDirect(CosmosTx),
    /// The wallet's own LEGACY_AMINO_JSON transaction (for Ledger's Cosmos app).
    CosmosAminoTx(CosmosTx),
    /// `signAmino`: a dapp's StdSignDoc, as an object or a string.
    CosmosAmino {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's compressed public key.
        signer: String,
        /// The StdSignDoc.
        #[serde(borrow)]
        sign_doc: &'a RawValue,
    },
    /// `eth_sendTransaction`, with nonce, gas and fees filled in.
    EvmTransaction {
        /// CAIP-2 chain ID.
        chain: String,
        /// The transaction request object.
        #[serde(borrow)]
        tx: &'a RawValue,
    },
    /// `eth_signTypedData_v4`.
    EvmTypedData {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's address.
        signer: String,
        /// The typed data, as an object or a string.
        #[serde(borrow)]
        typed_data: &'a RawValue,
    },
    /// `signArbitrary` (ADR-036): data that isn't a transaction, signed inside a fixed sign
    /// doc the vault builds.
    CosmosArbitrary {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's compressed public key.
        signer: String,
        /// The data, hex.
        data: String,
    },
    /// `personal_sign`.
    EvmPersonalSign {
        /// CAIP-2 chain ID.
        chain: String,
        /// The signer's address.
        signer: String,
        /// The message: `0x` + hex for bytes, anything else as UTF-8 text (as wallets read
        /// `personal_sign`'s first parameter).
        message: String,
    },
}

/// The parts of a Cosmos SignDoc.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CosmosTx {
    chain: String,
    signer: String,
    body_bytes: String,
    auth_info_bytes: String,
    account_number: U64,
}

/// A request that passed its checks.
pub(crate) struct Checked {
    kind: Kind,
    /// What the approval screen shows.
    pub(crate) display: Value,
    /// What an approval is bound to.
    pub(crate) digest: [u8; 32],
}

enum Kind {
    Direct {
        d: Decoded,
        signer: String,
    },
    AminoTx {
        tx: AminoTx,
        signer: String,
    },
    Amino {
        tx: AminoTx,
        signer: String,
    },
    EvmTx {
        r: Box<TxRequest>,
        /// The Injective network, on Injective EVM.
        network: Option<&'static choice_wallet_injective::chain::Network>,
        /// On a chain USDC comes from: what the transaction was read as.
        deposit: Option<Box<SourceTx>>,
    },
    TypedData {
        td: Box<TypedData>,
        signer: EthAddress,
        injective_tx: Option<Box<Web3Tx>>,
    },
    Personal {
        message: Vec<u8>,
        signer: EthAddress,
    },
    Arbitrary {
        a: Box<choice_wallet_cosmos::adr36::Arbitrary>,
    },
}

impl Checked {
    /// Run the risk rules over the decoded request.
    pub(crate) fn assess(&self, ctx: &Context) -> Assessment {
        match &self.kind {
            Kind::Direct { d, signer } => {
                let fee = d.fee();
                let fee = CosmosFee {
                    amount: &fee.amount,
                    granter: fee.granter.as_deref(),
                    payer: fee.payer.as_deref(),
                };
                choice_wallet_policy::cosmos(d.messages(), signer, d.memo(), fee, ctx)
            }
            Kind::AminoTx { tx, signer } | Kind::Amino { tx, signer } => {
                let fee = CosmosFee {
                    amount: &tx.fee.amount,
                    granter: tx.fee.granter.as_deref(),
                    payer: None,
                };
                choice_wallet_policy::cosmos(&tx.messages, signer, &tx.memo, fee, ctx)
            }
            Kind::EvmTx {
                r, deposit: Some(d), ..
            } => choice_wallet_policy::source_transaction(r, &d.network.cctp, d.source, &d.call, ctx),
            Kind::EvmTx { r, network, .. } => choice_wallet_policy::evm_transaction(r, *network, ctx),
            Kind::TypedData {
                td,
                signer,
                injective_tx,
            } => choice_wallet_policy::typed_data(td, injective_tx.as_deref(), signer, ctx),
            Kind::Personal { message, signer } => choice_wallet_policy::personal_message(message, signer, ctx),
            Kind::Arbitrary { a } => choice_wallet_policy::arbitrary_message(a.data(), ctx),
        }
    }
}

fn digest(kind: &str, chain: &str, signer: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut buf = b"choice-wallet approval v1".to_vec();
    for part in [kind.as_bytes(), chain.as_bytes(), signer, payload] {
        buf.extend_from_slice(&(part.len() as u64).to_be_bytes());
        buf.extend_from_slice(part);
    }
    keccak256(&buf)
}

fn public_key(hex_key: &str) -> Result<PublicKey, VaultError> {
    PublicKey::from_sec1_bytes(&hex(hex_key, "signer")?).map_err(|_| VaultError::bad("signer is not a public key"))
}

fn evm_address(s: &str) -> Result<EthAddress, VaultError> {
    EthAddress::parse_hex(s).map_err(|_| VaultError::bad(format!("invalid address {s:?}")))
}

/// Check a request and describe it.
pub(crate) fn decode(req: SignRequest) -> Result<Checked, VaultError> {
    match req {
        SignRequest::CosmosDirect(t) => cosmos_tx(t, false),
        SignRequest::CosmosAminoTx(t) => cosmos_tx(t, true),
        SignRequest::CosmosAmino {
            chain,
            signer,
            sign_doc,
        } => {
            let entry = chains::find(&chain)?;
            let pk = public_key(&signer)?;
            let tx = amino::decode_sign_doc(&json_text(sign_doc)?, entry.cosmos()?, &pk)?;
            Ok(Checked {
                display: amino_display("cosmos_amino", entry, &pk, &tx),
                digest: digest("cosmos_amino", entry.id, &pk.compressed(), tx.sign_bytes()),
                kind: Kind::Amino {
                    tx,
                    signer: entry.address(&pk),
                },
            })
        }
        SignRequest::EvmTransaction { chain, tx } => {
            if let Some((network, source)) = chains::source(&chain) {
                return source_tx(&chain, network, source, tx.get());
            }
            let entry = chains::find(&chain)?;
            let r = evm_request::parse(tx.get(), entry.evm()?)?;
            let display = evm_tx_display(entry, &r)?;
            Ok(Checked {
                digest: digest("evm_transaction", entry.id, r.from.as_bytes(), &r.tx.unsigned_bytes()),
                display,
                kind: Kind::EvmTx {
                    r: Box::new(r),
                    network: entry.injective,
                    deposit: None,
                },
            })
        }
        SignRequest::EvmTypedData {
            chain,
            signer,
            typed_data,
        } => {
            let entry = chains::find(&chain)?;
            let chain_id = entry.evm()?;
            let signer = evm_address(&signer)?;
            let td = TypedData::parse(&json_text(typed_data)?)?;
            let injective = match entry.injective {
                Some(network) => decode_v2(&td, network, &signer)?,
                None => None,
            };
            // Outside Injective's own domain (which accepts Ethereum's chain ID too), the
            // domain's chain must be the connected one.
            if injective.is_none()
                && let Some(id) = td.chain_id()
                && id.to_u64() != Some(chain_id)
            {
                return Err(VaultError::new(
                    INVALID,
                    format!("typed data is for chain {id}, not {}", entry.id),
                ));
            }
            let display = json!({
                "kind": "evm_typed_data",
                "chain": entry.id,
                "signer": signer.to_checksum_hex(),
                "primary_type": td.primary_type(),
                "domain": td.domain(),
                "message": td.message(),
                "injective_tx": injective,
            });
            Ok(Checked {
                display,
                digest: digest("evm_typed_data", entry.id, signer.as_bytes(), &td.hash()?),
                kind: Kind::TypedData {
                    td: Box::new(td),
                    signer,
                    injective_tx: injective.map(Box::new),
                },
            })
        }
        SignRequest::CosmosArbitrary { chain, signer, data } => {
            let entry = chains::find(&chain)?;
            let pk = public_key(&signer)?;
            let a = choice_wallet_cosmos::adr36::Arbitrary::new(entry.cosmos()?, &pk, hex(&data, "data")?)?;
            let display = json!({
                "kind": "cosmos_arbitrary",
                "chain": entry.id,
                "signer": a.address(),
                "text": std::str::from_utf8(a.data()).ok(),
                "hex": format!("0x{}", hexutil::encode(a.data())),
            });
            Ok(Checked {
                display,
                digest: digest("cosmos_arbitrary", entry.id, &pk.compressed(), a.sign_bytes()),
                kind: Kind::Arbitrary { a: Box::new(a) },
            })
        }
        SignRequest::EvmPersonalSign { chain, signer, message } => {
            let entry = chains::find(&chain)?;
            entry.evm()?;
            let signer = evm_address(&signer)?;
            let bytes = match message.strip_prefix("0x") {
                Some(h) => hex(h, "message")?,
                None => message.into_bytes(),
            };
            let display = json!({
                "kind": "evm_personal_sign",
                "chain": entry.id,
                "signer": signer.to_checksum_hex(),
                "text": std::str::from_utf8(&bytes).ok(),
                "hex": format!("0x{}", hexutil::encode(&bytes)),
            });
            Ok(Checked {
                display,
                digest: digest(
                    "evm_personal_sign",
                    entry.id,
                    signer.as_bytes(),
                    &personal::hash(&bytes),
                ),
                kind: Kind::Personal { message: bytes, signer },
            })
        }
    }
}

/// A transaction on a chain USDC comes from, as `cctp::source_call` read it.
pub(crate) struct SourceTx {
    network: &'static choice_wallet_injective::chain::Network,
    source: &'static Source,
    call: SourceCall,
}

/// Read `r` as what the vault signs on `source`, or refuse it.
pub(crate) fn source_call(
    network: &choice_wallet_injective::chain::Network,
    source: &Source,
    r: &TxRequest,
) -> Result<SourceCall, VaultError> {
    cctp::source_call(&network.cctp, source, &r.from, &r.tx.to, r.tx.value, &r.tx.data).map_err(|e| {
        VaultError::new(
            INVALID,
            format!(
                "On {} the wallet signs only USDC bridge transfers to this account on Injective, and this isn't one: {e}.",
                source.name
            ),
        )
    })
}

/// `evm_transaction` on a chain USDC comes from: an exact USDC approval for Circle's bridge,
/// or a deposit into the signer's own account on Injective; anything else is refused here,
/// before anyone is asked to approve it.
fn source_tx(
    id: &str,
    network: &'static choice_wallet_injective::chain::Network,
    source: &'static Source,
    tx: &str,
) -> Result<Checked, VaultError> {
    let r = evm_request::parse(tx, source.chain_id)?;
    let call = source_call(network, source, &r)?;
    let t = &r.tx;
    let hex_addr = |a: &EthAddress| a.to_checksum_hex();
    let shown = match &call {
        SourceCall::Approve { amount } => json!({
            "type": "approve",
            "spender": hex_addr(&network.cctp.token_messenger()),
            "amount": amount.to_string(),
        }),
        SourceCall::Deposit(d) => json!({
            "type": "bridge_in",
            "amount": d.burn.amount.to_string(),
            "token": hex_addr(&d.burn.burn_token),
            "chain": source.name,
            "recipient": hex_addr(&r.from),
            "max_fee": d.burn.max_fee.to_string(),
            "finality": d.burn.min_finality,
            "delivery": match d.delivery { Delivery::Anyone => "anyone", Delivery::GasDrop { .. } => "gas_drop" },
            "max_drop_fee": match d.delivery { Delivery::Anyone => None, Delivery::GasDrop { max_drop_fee } => Some(max_drop_fee.to_string()) },
            "least": d.least().to_string(),
        }),
    };
    let display = json!({
        "kind": "evm_transaction",
        "chain": id,
        "source": { "name": source.name, "symbol": source.native.0, "decimals": source.native.1 },
        "from": hex_addr(&r.from),
        "to": hex_addr(&t.to),
        "value": t.value.to_string(),
        "nonce": t.nonce.to_string(),
        "gas_limit": t.gas_limit.to_string(),
        "max_fee_per_gas": t.max_fee_per_gas.to_string(),
        "max_priority_fee_per_gas": t.max_priority_fee_per_gas.to_string(),
        "max_gas_cost": U256::product(u128::from(t.gas_limit), t.max_fee_per_gas).to_string(),
        "data": format!("0x{}", hexutil::encode(&t.data)),
        "call": shown,
    });
    Ok(Checked {
        digest: digest("evm_transaction", id, r.from.as_bytes(), &t.unsigned_bytes()),
        display,
        kind: Kind::EvmTx {
            r: Box::new(r),
            network: None,
            deposit: Some(Box::new(SourceTx { network, source, call })),
        },
    })
}

fn cosmos_tx(t: CosmosTx, amino_mode: bool) -> Result<Checked, VaultError> {
    let entry = chains::find(&t.chain)?;
    let chain = entry.cosmos()?;
    let pk = public_key(&t.signer)?;
    let request = Request {
        body_bytes: hex(&t.body_bytes, "body_bytes")?,
        auth_info_bytes: hex(&t.auth_info_bytes, "auth_info_bytes")?,
        chain_id: chain.chain_id.into(),
        account_number: t.account_number.0,
    };
    if amino_mode {
        let tx = amino::from_tx(request, chain, &pk)?;
        return Ok(Checked {
            display: amino_display("cosmos_amino_tx", entry, &pk, &tx),
            digest: digest("cosmos_amino_tx", entry.id, &pk.compressed(), tx.sign_bytes()),
            kind: Kind::AminoTx {
                tx,
                signer: chain.address(&pk),
            },
        });
    }
    let d = direct::decode(request, chain, &pk)?;
    let fee = d.fee();
    let display = json!({
        "kind": "cosmos_direct",
        "chain": entry.id,
        "signer": chain.address(&pk),
        "account_number": d.account_number().to_string(),
        "sequence": d.sequence().to_string(),
        "memo": d.memo(),
        "timeout_height": d.timeout_height().to_string(),
        "fee": {
            "amount": fee.amount,
            "gas_limit": fee.gas_limit.to_string(),
            "granter": fee.granter,
            "payer": fee.payer,
        },
        "messages": d.messages(),
    });
    Ok(Checked {
        display,
        digest: digest("cosmos_direct", entry.id, &pk.compressed(), &d.sign_doc_bytes()),
        kind: Kind::Direct {
            d,
            signer: chain.address(&pk),
        },
    })
}

fn amino_display(kind: &str, entry: &Entry, pk: &PublicKey, tx: &AminoTx) -> Value {
    json!({
        "kind": kind,
        "chain": entry.id,
        "signer": entry.address(pk),
        "account_number": tx.account_number.to_string(),
        "sequence": tx.sequence.to_string(),
        "memo": tx.memo,
        "timeout_height": tx.timeout_height.to_string(),
        "fee": {
            "amount": tx.fee.amount,
            "gas_limit": tx.fee.gas_limit.to_string(),
            "granter": tx.fee.granter,
            "payer": Value::Null,
        },
        "messages": tx.messages,
    })
}

/// A contract call the wallet reads: a Choice swap, a CCTP bridge transfer or its mint, an
/// ERC20 approval, a Permit2 approval; otherwise just its selector.
fn contract_display(entry: &Entry, r: &TxRequest, selector: Option<[u8; 4]>) -> Value {
    use choice_wallet_evm::abi::{self, Ty};
    use choice_wallet_injective::choice::{self, Executor, Venue};
    let tx = &r.tx;
    let hex_addr = |a: &EthAddress| a.to_checksum_hex();
    let plain = json!({
        "type": "contract",
        "selector": selector.map(|s| format!("0x{}", hexutil::encode(&s))),
    });
    let Some(network) = entry.injective else {
        return plain;
    };
    let c = &network.choice;
    if let Some(read) = choice::swap(c, &tx.to, tx.value, &tx.data) {
        let Ok(s) = read else {
            return json!({ "type": "contract", "selector": plain["selector"], "unreadable_swap": true });
        };
        let venues: Vec<Value> = s
            .venues
            .iter()
            .filter_map(|v| match v {
                Venue::Wrap | Venue::Unwrap => None,
                Venue::Infinity { vault, hops } => Some(json!({
                    "venue": c.vault_name(vault).unwrap_or("Infinity"),
                    "contract": hex_addr(vault),
                    "hops": hops,
                })),
                Venue::Solidly { pair } => Some(json!({ "venue": "Solidly", "contract": hex_addr(pair) })),
                Venue::Orderbook { market } => Some(json!({ "venue": "INJ orderbook", "market": market })),
                Venue::Adapter { adapter } => Some(json!({ "venue": "Adapter", "contract": hex_addr(adapter) })),
                Venue::RouterSwap => Some(json!({ "venue": "Choice" })),
            })
            .collect();
        return json!({
            "type": "swap",
            "executor": match s.executor { Executor::Aggregator => "aggregator", Executor::UniversalRouter => "router" },
            "token_in": hex_addr(&s.token_in),
            "token_out": hex_addr(&s.token_out),
            "amount_in": s.amount_in.to_string(),
            "minimum_out": s.minimum_out.to_string(),
            "recipient": hex_addr(&s.recipient.unwrap_or(r.from)),
            "deadline": s.deadline.map(|d| d.to_string()),
            "fee_bps": s.fee_bps,
            "fee_recipient": s.fee_recipient.as_ref().map(hex_addr),
            "venues": venues,
            "permit": s.permit.as_ref().map(|p| json!({
                "token": hex_addr(&p.token),
                "spender": hex_addr(&p.spender),
                "amount": p.amount.to_string(),
                "expiration": p.expiration,
            })),
        });
    }
    if let Some(read) = cctp::burn(&network.cctp, &tx.to, tx.value, &tx.data) {
        let Ok(b) = read else {
            return json!({ "type": "contract", "selector": plain["selector"], "unreadable_bridge": true });
        };
        return json!({
            "type": "bridge",
            "amount": b.amount.to_string(),
            "token": hex_addr(&b.burn_token),
            "domain": b.domain,
            "chain": network.cctp.domain(b.domain).map(|d| d.name),
            "recipient": b.recipient(&network.cctp).map(|r| r.display()),
            "max_fee": b.max_fee.to_string(),
            "finality": b.min_finality,
            "delivery": match &b.hook {
                cctp::Hook::Forward | cctp::Hook::ForwardWithAccount { .. } => "circle",
                cctp::Hook::None => "claim",
                cctp::Hook::GasDrop { .. } | cctp::Hook::Other(_) => "hook",
            },
            "account_owner": match &b.hook {
                cctp::Hook::ForwardWithAccount { owner } => Some(cctp::base58(owner)),
                _ => None,
            },
            "destination_caller": (!b.permissionless()).then(|| format!("0x{}", hexutil::encode(&b.destination_caller))),
        });
    }
    if let Some(read) = cctp::receive(&network.cctp, &tx.to, tx.value, &tx.data) {
        let Ok(m) = read else {
            return json!({ "type": "contract", "selector": plain["selector"], "unreadable_bridge": true });
        };
        let source = network.cctp.source_domain(m.source_domain);
        return json!({
            "type": "bridge_receive",
            "domain": m.source_domain,
            "chain": source.map(|s| s.name),
            "to_injective": m.destination_domain == cctp::INJECTIVE_DOMAIN,
            "token": hex_addr(&network.cctp.usdc()),
            "known_token": source.is_some_and(|s| m.burn_token == cctp::word(&s.usdc())),
            "amount": m.amount.to_string(),
            "fee": m.fee_executed.to_string(),
            "minted": m.minted().to_string(),
            "recipient": m.paid().as_ref().map(hex_addr),
            "nonce": format!("0x{}", hexutil::encode(&m.nonce)),
        });
    }
    let args = tx.data.get(4..).unwrap_or_default();
    if selector == Some(choice_wallet_evm::erc20::SAFE_TRANSFER_FROM_SELECTOR)
        && let Ok(v) = abi::decode(&[Ty::Word, Ty::Word, Ty::Word], args)
        && let (Ok(from), Ok(to), Ok(id)) = (v[0].address(), v[1].address(), v[2].uint())
    {
        return json!({ "type": "nft_transfer", "from": hex_addr(&from), "to": hex_addr(&to), "token_id": id.to_string() });
    }
    match selector {
        Some(choice_wallet_evm::erc20::APPROVE_SELECTOR) => {
            if let Ok(v) = abi::decode(&[Ty::Word, Ty::Word], args)
                && let (Ok(spender), Ok(amount)) = (v[0].address(), v[1].uint())
            {
                return json!({ "type": "approve", "spender": hex_addr(&spender), "amount": amount.to_string() });
            }
        }
        Some(choice::PERMIT2_APPROVE) if tx.to == c.permit2() => {
            if let Ok(v) = abi::decode(&[Ty::Word, Ty::Word, Ty::Word, Ty::Word], args)
                && let (Ok(token), Ok(spender), Ok(amount), Ok(expiration)) =
                    (v[0].address(), v[1].address(), v[2].uint_bits(160), v[3].small(48))
            {
                return json!({
                    "type": "permit2_approve",
                    "token": hex_addr(&token),
                    "spender": hex_addr(&spender),
                    "amount": amount.to_string(),
                    "expiration": expiration,
                });
            }
        }
        _ => {}
    }
    plain
}

fn evm_tx_display(entry: &Entry, r: &TxRequest) -> Result<Value, VaultError> {
    let tx = &r.tx;
    let max_gas_cost = U256::product(u128::from(tx.gas_limit), tx.max_fee_per_gas);
    let call = match tx.call_kind() {
        Call::Transfer => json!({ "type": "transfer" }),
        Call::Erc20Transfer { to, amount } => json!({
            "type": "erc20_transfer",
            "to": to.to_checksum_hex(),
            "amount": amount.to_string(),
        }),
        Call::Contract { selector } => contract_display(entry, r, selector),
    };
    Ok(json!({
        "kind": "evm_transaction",
        "chain": entry.id,
        "from": r.from.to_checksum_hex(),
        "to": tx.to.to_checksum_hex(),
        "value": tx.value.to_string(),
        "nonce": tx.nonce.to_string(),
        "gas_limit": tx.gas_limit.to_string(),
        "max_fee_per_gas": tx.max_fee_per_gas.to_string(),
        "max_priority_fee_per_gas": tx.max_priority_fee_per_gas.to_string(),
        "max_gas_cost": max_gas_cost.to_string(),
        "data": format!("0x{}", hexutil::encode(&tx.data)),
        "call": call,
    }))
}

/// Sign a checked request with `key`, if `approved` is its digest.
pub(crate) fn sign(checked: Checked, approved: &str, key: &PrivateKey) -> Result<Value, VaultError> {
    if approved != hexutil::encode(&checked.digest) {
        return Err(VaultError::new(
            NOT_APPROVED,
            "this request is not the one that was approved",
        ));
    }
    let pk = key.public_key();
    let wrong_account = || {
        Err(VaultError::new(
            WRONG_ACCOUNT,
            "this account is not the request's signer",
        ))
    };
    let prefixed = |b: &[u8]| format!("0x{}", hexutil::encode(b));
    match checked.kind {
        Kind::Direct { d, .. } => {
            let s = direct::sign(&d, key)?;
            Ok(json!({
                "signature": hexutil::encode(&s.signature),
                "tx_raw": hexutil::encode(&s.tx_raw),
            }))
        }
        Kind::AminoTx { tx, .. } => {
            let sig = tx.sign(key)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "tx_raw": tx.tx_raw(&sig).map(|b| hexutil::encode(&b)),
            }))
        }
        Kind::Amino { tx, .. } => {
            let sig = tx.sign(key)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "signed_doc": String::from_utf8_lossy(tx.sign_bytes()),
            }))
        }
        Kind::EvmTx { r, .. } => {
            if pk.eth_address() != r.from {
                return wrong_account();
            }
            let s = r.tx.sign(key)?;
            Ok(json!({ "raw": prefixed(&s.raw), "hash": prefixed(&s.hash) }))
        }
        Kind::TypedData { td, signer, .. } => {
            if pk.eth_address() != signer {
                return wrong_account();
            }
            Ok(json!({ "signature": prefixed(&td.sign(key)?) }))
        }
        Kind::Personal { message, signer } => {
            if pk.eth_address() != signer {
                return wrong_account();
            }
            Ok(json!({ "signature": prefixed(&personal::sign(&message, key)) }))
        }
        Kind::Arbitrary { a } => {
            let sig = a.sign(key)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "signed_doc": String::from_utf8_lossy(a.sign_bytes()),
            }))
        }
    }
}

fn check_approved(checked: &Checked, approved: &str) -> Result<(), VaultError> {
    if approved == hexutil::encode(&checked.digest) {
        Ok(())
    } else {
        Err(VaultError::new(
            NOT_APPROVED,
            "this request is not the one that was approved",
        ))
    }
}

/// What a hardware wallet signs for an approved request: the app that signs it and the exact
/// bytes, which the device shows. Ledger's Cosmos app signs amino JSON; its Ethereum app
/// signs EVM transactions and `personal_sign` messages.
pub(crate) fn device_request(checked: &Checked, approved: &str) -> Result<Value, VaultError> {
    check_approved(checked, approved)?;
    let out = |app: &str, kind: &str, payload: &[u8]| json!({ "app": app, "kind": kind, "payload": hexutil::encode(payload) });
    match &checked.kind {
        Kind::AminoTx { tx, .. } | Kind::Amino { tx, .. } => Ok(out("cosmos", "amino", tx.sign_bytes())),
        Kind::EvmTx { r, .. } => Ok(out("ethereum", "transaction", &r.tx.unsigned_bytes())),
        Kind::Personal { message, .. } => Ok(out("ethereum", "message", message)),
        Kind::Arbitrary { a } => Ok(out("cosmos", "amino", a.sign_bytes())),
        Kind::Direct { .. } => Err(VaultError::new(
            DEVICE_UNSUPPORTED,
            "A Ledger signs Cosmos transactions as amino JSON, not this form.",
        )),
        Kind::TypedData { .. } => Err(VaultError::new(
            DEVICE_UNSUPPORTED,
            "A Ledger account can't sign typed data in Choice Wallet yet.",
        )),
    }
}

/// How a device wrote its signature.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SignatureFormat {
    /// ASN.1 DER (Ledger's Cosmos app).
    Der,
    /// 64 bytes `r || s` (Ledger's Ethereum app returns `v || r || s`; the host drops `v`,
    /// since the vault works the recovery id out itself).
    Rs,
}

/// The signed result for an approved request from a signature its signer's hardware wallet
/// made, in the same form [`sign`] returns. The signature must verify against `public_key`
/// (the account's, kept since pairing) over the exact bytes [`device_request`] gave, and
/// that key must be the request's signer; otherwise nothing comes back.
pub(crate) fn device_sign(
    checked: Checked,
    approved: &str,
    public_key: &PublicKey,
    signature: &[u8],
    format: SignatureFormat,
) -> Result<Value, VaultError> {
    check_approved(&checked, approved)?;
    let sig: [u8; 64] = match format {
        SignatureFormat::Der => choice_wallet_core::secp256k1::signature_from_der(signature),
        SignatureFormat::Rs => signature.try_into().ok(),
    }
    .ok_or_else(|| VaultError::new(BAD_SIGNATURE, "the device's signature isn't readable"))?;
    let bad = || {
        VaultError::new(
            BAD_SIGNATURE,
            "the device's signature isn't this account's, for this request",
        )
    };
    let wrong_account = || VaultError::new(WRONG_ACCOUNT, "this account is not the request's signer");
    let prefixed = |b: &[u8]| format!("0x{}", hexutil::encode(b));
    match checked.kind {
        Kind::AminoTx { tx, .. } | Kind::Amino { tx, .. } => {
            if *tx.signer() != public_key.compressed() {
                return Err(wrong_account());
            }
            let sig = tx.device_signature(&sig).ok_or_else(bad)?;
            Ok(match tx.tx_raw(&sig) {
                Some(raw) => json!({ "signature": hexutil::encode(&sig), "tx_raw": hexutil::encode(&raw) }),
                None => json!({
                    "signature": hexutil::encode(&sig),
                    "signed_doc": String::from_utf8_lossy(tx.sign_bytes()),
                }),
            })
        }
        Kind::EvmTx { r, .. } => {
            if public_key.eth_address() != r.from {
                return Err(wrong_account());
            }
            let (sig, recid) = public_key.check_prehash(&r.tx.signing_hash(), &sig).ok_or_else(bad)?;
            let s = r.tx.with_signature(&sig, recid)?;
            Ok(json!({ "raw": prefixed(&s.raw), "hash": prefixed(&s.hash) }))
        }
        Kind::Personal { message, signer } => {
            if public_key.eth_address() != signer {
                return Err(wrong_account());
            }
            let (sig, recid) = public_key
                .check_prehash(&personal::hash(&message), &sig)
                .ok_or_else(bad)?;
            Ok(json!({ "signature": prefixed(&personal::with_signature(&sig, recid)) }))
        }
        Kind::Arbitrary { a } => {
            if *a.signer() != public_key.compressed() {
                return Err(wrong_account());
            }
            let sig = a.check_signature(&sig).ok_or_else(bad)?;
            Ok(json!({
                "signature": hexutil::encode(&sig),
                "signed_doc": String::from_utf8_lossy(a.sign_bytes()),
            }))
        }
        Kind::Direct { .. } | Kind::TypedData { .. } => Err(VaultError::new(
            DEVICE_UNSUPPORTED,
            "A Ledger can't sign this kind of request here.",
        )),
    }
}

/// Whether `signature` (64 bytes `r || s`, either S) is `public_key`'s ADR-036 signature of
/// `data` and that key is `address`'s on `chain` (`verifyArbitrary`).
pub(crate) fn verify_arbitrary(
    chain: &str,
    address: &str,
    data: Vec<u8>,
    public_key: &PublicKey,
    signature: &[u8],
) -> Result<bool, VaultError> {
    let entry = chains::find(chain)?;
    let cosmos = entry.cosmos()?;
    if cosmos.address(public_key) != address {
        return Ok(false);
    }
    let Ok(sig) = <[u8; 64]>::try_from(signature) else {
        return Ok(false);
    };
    let a = choice_wallet_cosmos::adr36::Arbitrary::new(cosmos, public_key, data)?;
    Ok(a.check_signature(&sig).is_some())
}

/// The messages of a checked Cosmos request, for tests.
#[cfg(test)]
pub(crate) fn messages(checked: &Checked) -> Option<&[choice_wallet_cosmos::msg::Msg]> {
    match &checked.kind {
        Kind::Direct { d, .. } => Some(d.messages()),
        Kind::AminoTx { tx, .. } | Kind::Amino { tx, .. } => Some(&tx.messages),
        _ => None,
    }
}
