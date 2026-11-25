//! Review findings: Cosmos rules.

use choice_wallet_cosmos::msg::{Coin, Msg};
use choice_wallet_policy::{Assessment, Context, CosmosFee, Level, cosmos};

const ME: &str = "inj1npvwllfr9dqr8erajqqr6s0vxnk2ak55re90dz";
const OTHER: &str = "inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8";

fn ctx() -> Context {
    let mut c = Context::default();
    c.origin = Some("https://dapp.example".into());
    c.origin_known = true;
    c.balances = [("inj".to_owned(), "100".to_owned())].into();
    c
}

fn send_all() -> Msg {
    Msg::BankSend {
        from: ME.into(),
        to: OTHER.into(),
        amount: vec![Coin::new("inj", "100").unwrap()],
    }
}

fn rules(a: &Assessment) -> Vec<&'static str> {
    a.findings.iter().map(|f| f.rule).collect()
}

/// x/authz runs a message in MsgExec whose signer is the grantee itself without any grant
/// (keeper.DispatchActions: "If granter != grantee then check authorization ... otherwise
/// we implicitly accept"). So MsgExec{grantee: me, msgs: [MsgSend{from: me}]} spends the
/// signer's own coins: the rules count them, as for the bare send, and don't call it
/// others' permissions.
#[test]
fn self_exec_counts_own_outflows() {
    let plain = cosmos(&[send_all()], ME, "", CosmosFee::default(), &ctx());
    let wrapped = cosmos(
        &[Msg::AuthzExec {
            grantee: ME.into(),
            msgs: vec![send_all()],
        }],
        ME,
        "",
        CosmosFee::default(),
        &ctx(),
    );
    assert_eq!(plain.level, Level::Amber);
    assert_eq!(wrapped.level, Level::Amber);
    assert!(rules(&wrapped).contains(&"authz_exec_own"), "{:?}", rules(&wrapped));
    assert!(!rules(&wrapped).contains(&"authz_exec"), "{:?}", rules(&wrapped));
    assert!(rules(&wrapped).contains(&"most_of_balance"), "{:?}", rules(&wrapped));
    // Nested in an exec for another grantee, the signer's message still counts.
    let nested = cosmos(
        &[Msg::AuthzExec {
            grantee: ME.into(),
            msgs: vec![Msg::AuthzExec {
                grantee: OTHER.into(),
                msgs: vec![send_all()],
            }],
        }],
        ME,
        "",
        CosmosFee::default(),
        &ctx(),
    );
    assert!(rules(&nested).contains(&"most_of_balance"), "{:?}", rules(&nested));
    // Others' messages still move only the granters' funds.
    let others = cosmos(
        &[Msg::AuthzExec {
            grantee: ME.into(),
            msgs: vec![Msg::BankSend {
                from: OTHER.into(),
                to: ME.into(),
                amount: vec![Coin::new("inj", "100").unwrap()],
            }],
        }],
        ME,
        "",
        CosmosFee::default(),
        &ctx(),
    );
    assert_eq!(others.level, Level::Info, "{:?}", rules(&others));
    assert!(rules(&others).contains(&"authz_exec"), "{:?}", rules(&others));
}

/// The same through the Direct decoder the vault runs: the inner send's signer is the
/// exec's grantee, so the request is refused before review.
#[test]
fn self_exec_is_refused_end_to_end() {
    use choice_wallet_core::Mnemonic;
    use choice_wallet_core::hd::{derive, injective_path};
    use choice_wallet_cosmos::Error;
    use choice_wallet_cosmos::builder::{self, Fee, TxOptions};
    use choice_wallet_cosmos::direct;
    use choice_wallet_cosmos::proto::cosmos::authz::v1beta1::MsgExec;
    use choice_wallet_cosmos::wkt::Any;
    use choice_wallet_injective::chain::MAINNET;

    let m = Mnemonic::parse(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
    .unwrap();
    let key = derive(&m, &injective_path(0)).unwrap();
    let chain = &MAINNET.cosmos;
    let me = chain.address(&key.public_key());
    let send = builder::bank_send(chain, &me, OTHER, &[Coin::new("inj", "100").unwrap()]).unwrap();
    let exec = Any::pack(&MsgExec {
        grantee: me.clone(),
        msgs: vec![send],
    });
    let opts = TxOptions {
        account_number: 1,
        sequence: 0,
        fee: Fee {
            amount: vec![],
            gas_limit: 200_000,
            granter: None,
        },
        memo: String::new(),
        timeout_height: 0,
    };
    let req = builder::direct_request(chain, &key.public_key(), vec![exec], &opts).unwrap();
    assert_eq!(
        direct::decode(req, chain, &key.public_key()).unwrap_err(),
        Error::SelfExec(me)
    );
}

fn rewards() -> Msg {
    Msg::WithdrawRewards {
        delegator: ME.into(),
        validator: "injvaloper1qyqszqgpqyqszqgpqyqszqgpqyqszqgp0url7q".into(),
    }
}

fn with_fee(granter: Option<&str>, payer: Option<&str>) -> Assessment {
    let fee = [Coin::new("inj", "90").unwrap()];
    cosmos(
        &[rewards()],
        ME,
        "",
        CosmosFee {
            amount: &fee,
            granter,
            payer,
        },
        &ctx(),
    )
}

/// x/auth DeductFeeDecorator: a fee granter equal to the fee payer uses no grant and takes
/// the fee from the signer. The fee counts as the signer's, and no one else is said to pay.
#[test]
fn self_granter_pays_the_fee() {
    let paid = with_fee(None, None);
    let granted = with_fee(Some(ME), None);
    assert_eq!(paid.level, Level::Amber);
    assert_eq!((granted.level, rules(&granted)), (paid.level, rules(&paid)));
    // Someone else's grant still pays.
    assert_eq!(rules(&with_fee(Some(OTHER), None)), ["fee_grant_used"]);
    // With another payer the signer's grant to it pays: still the signer's fee.
    assert_eq!(rules(&with_fee(Some(ME), Some(OTHER))), rules(&paid));
}

/// direct::decode accepts fee.payer equal to the signer: that is the signer paying.
#[test]
fn self_payer_pays_the_fee() {
    let paid = with_fee(None, None);
    let a = with_fee(None, Some(ME));
    assert_eq!((a.level, rules(&a)), (paid.level, rules(&paid)));
    assert_eq!(rules(&with_fee(None, Some(OTHER))), ["fee_payer"]);
}
