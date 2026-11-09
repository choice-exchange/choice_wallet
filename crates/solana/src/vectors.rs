//! Reference messages for the tests, compiled by `@solana/web3.js` 1.98.4 (Solana's own SDK)
//! from instructions built by web3.js or `injective-usdc-bridge` 0.2.0 (`depositForBurnInstruction`,
//! `reclaimEventAccountInstruction`, `createAssociatedTokenAccountInstruction`). The wallets
//! are the "abandon … about" phrase's Phantom accounts 0 and 1; the blockhash is bytes 1..=32.

use choice_wallet_core::base58;

use crate::message::Pubkey;

pub(crate) fn key(s: &str) -> Pubkey {
    base58::decode32(s).unwrap()
}

pub(crate) const OWNER: &str = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
pub(crate) const OTHER: &str = "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb";
/// The burn's record (a fresh keypair in real use).
pub(crate) const EVENT: &str = "GjJyeC1r2RgkuoCWMyPYkCWSGSGLcz266EaAkLA27AhL";
pub(crate) const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub(crate) const RENT: &str = "SysvarRent111111111111111111111111111111111";
pub(crate) const TABLE: &str = "AddressLookupTab1e1111111111111111111111111";
pub(crate) const TOKEN_MESSENGER_MINTER: &str = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
pub(crate) const MESSAGE_TRANSMITTER: &str = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
pub(crate) const BLOCKHASH: Pubkey = {
    let mut b = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        b[i] = i as u8 + 1;
        i += 1;
    }
    b
};
pub(crate) const ATA_OWNER_USDC: &str = "5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt";
pub(crate) const ATA_OTHER_USDC: &str = "8X8ts1CnpZmtqApE2rREA97xEJuSRcomPGVcMFdS2cgY";
pub(crate) const PDA_SENDER_AUTHORITY: &str = "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE";
pub(crate) const PDA_REMOTE_TOKEN_MESSENGER_29: &str = "2tFfjwfzfzBrfftSrbsC5L3PmCtvkNfLLyXDTA7KYvng";
pub(crate) const PDA_MESSAGE_TRANSMITTER: &str = "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU";
/// The "abandon … about" phrase's 0x address: the burns pay it on Injective.
pub(crate) const ME_EVM: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
/// Choice's BridgeReceiver on Injective mainnet.
pub(crate) const RECEIVER: &str = "0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A";

/// Compute limit 200,000, price 1,000 micro-lamports, then 0.01 SOL from OWNER to OTHER.
pub(crate) const SOL_TRANSFER: &str = concat!(
    "01000204f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7f8029acf5cbcbdd5ac46ec14",
    "7f3b78a3df6e5022ef0411db2bab650d329a4cd400000000000000000000000000000000000000000000000000000000",
    "000000000306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a400000000102030405060708090a0b0c",
    "0d0e0f101112131415161718191a1b1c1d1e1f200303000502400d030003000903e803000000000000020200010c0200",
    "00008096980000000000",
);
/// v0: 5,000 lamports from OWNER to OTHER, OTHER loaded from TABLE (entries RENT, OTHER, USDC); a memo "hi" naming USDC (read-only, from the table).
pub(crate) const V0_TABLE: &str = concat!(
    "8001000203f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f70000000000000000000000",
    "000000000000000000000000000000000000000000054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8",
    "404105448d0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2002010200030c0200000088",
    "13000000000000020104026869010277a6af97339b7ac88d1892c90446f50002309266f62e53c1182449820000000101",
    "0102",
);
/// OTHER's USDC account created (idempotent, OWNER pays), then TransferChecked 1.5 USDC from OWNER's.
pub(crate) const USDC_TRANSFER: &str = concat!(
    "01000508f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f740d2f27c461f29e9feba1ab8",
    "acd39496a9c65b0ae62a713f01f941a993bf55ed6fba28a26d689207fea24e10ed953fce2eefd0081b494945c4adb205",
    "479f509900000000000000000000000000000000000000000000000000000000000000008c97258f4e2489f1bb3d1029",
    "148e0d830b5a1399daff1084048e7bd8dbe9f859c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203",
    "452f5d61f8029acf5cbcbdd5ac46ec147f3b78a3df6e5022ef0411db2bab650d329a4cd406ddf6e1d765a193d9cbe146",
    "ceeb79ac1cb485ed5f5b37913a8cf5857eff00a90102030405060708090a0b0c0d0e0f101112131415161718191a1b1c",
    "1d1e1f2002040600020605030701010704010502000a0c60e316000000000006",
);
/// Compute 150,000 at 2,000; deposit_for_burn of 2 USDC to Injective (29), to ME_EVM, max fee 300, fast (1000).
pub(crate) const BURN_PLAIN: &str = concat!(
    "02000b11f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7e9b6062841bb977ad21de71e",
    "c961900633c26f21384e015b014a637a6149954740d2f27c461f29e9feba1ab8acd39496a9c65b0ae62a713f01f941a9",
    "93bf55eda9a202630d8c5324689243a37de28596703eefb003fc03d2461e6d7bd9581780c6fa7af3bedbad3a3d65f36a",
    "abc97431b1bbe4c2d2f6e0e47ca60203452f5d61076eaeeeb35d837e56b85fbca83355dea3141b9cfd5b90b3e8c6ee7c",
    "0a34942f00000000000000000000000000000000000000000000000000000000000000001bfce4adf36af058a0745d82",
    "e957051caec8d8b1be5d3f6c344f3d52ef2283c52dc7bd6bda3aee5863e2160422ee2c6ff3d6abb980a1b95900870438",
    "8776ad49510033fcc78003f0dfd5be6750749b84b9f4823b9cc83b6cb54f1adb0cee206e79bfcb198fc8054ecb12f285",
    "edfeb2966d3d0804a789a21d238d9b70d60ecf638e6b6a31521dba9ad08af06b6d8ce9aaacfa821ea7712cbb4b92694a",
    "6f0336fba65fc81ce19edcd2d2c340b02fa61be1d5badde1592833ddf92009d8cf685455a65fc81d0fefa8860cb3b83f",
    "089b0224be8a6687b7ae49f594c0b9b4d7e938930306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a",
    "40000000c14ed3febff31b8949c9d4112029bc5d3eff50dab32f41648bd613937333e1bf06ddf6e1d765a193d9cbe146",
    "ceeb79ac1cb485ed5f5b37913a8cf5857eff00a90102030405060708090a0b0c0d0e0f101112131415161718191a1b1c",
    "1d1e1f20030e000502f04902000e000903d0070000000000000d12000008020a050b070f0304010c0d1006090d60d73c",
    "3d2e723780b080841e00000000001d0000000000000000000000000000009858effd232b4033e47d90003d41ec34ecae",
    "da9400000000000000000000000000000000000000000000000000000000000000002c01000000000000e8030000",
);
/// Compute 150,000 at 2,000; deposit_for_burn_with_hook of 2 USDC to Injective through RECEIVER (recipient and caller), standard (2000), hook = gas drop for ME_EVM, max drop fee 200,000.
pub(crate) const BURN_DROP: &str = concat!(
    "02000b11f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7e9b6062841bb977ad21de71e",
    "c961900633c26f21384e015b014a637a6149954740d2f27c461f29e9feba1ab8acd39496a9c65b0ae62a713f01f941a9",
    "93bf55eda9a202630d8c5324689243a37de28596703eefb003fc03d2461e6d7bd9581780c6fa7af3bedbad3a3d65f36a",
    "abc97431b1bbe4c2d2f6e0e47ca60203452f5d61076eaeeeb35d837e56b85fbca83355dea3141b9cfd5b90b3e8c6ee7c",
    "0a34942f00000000000000000000000000000000000000000000000000000000000000001bfce4adf36af058a0745d82",
    "e957051caec8d8b1be5d3f6c344f3d52ef2283c52dc7bd6bda3aee5863e2160422ee2c6ff3d6abb980a1b95900870438",
    "8776ad49510033fcc78003f0dfd5be6750749b84b9f4823b9cc83b6cb54f1adb0cee206e79bfcb198fc8054ecb12f285",
    "edfeb2966d3d0804a789a21d238d9b70d60ecf638e6b6a31521dba9ad08af06b6d8ce9aaacfa821ea7712cbb4b92694a",
    "6f0336fba65fc81ce19edcd2d2c340b02fa61be1d5badde1592833ddf92009d8cf685455a65fc81d0fefa8860cb3b83f",
    "089b0224be8a6687b7ae49f594c0b9b4d7e938930306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a",
    "40000000c14ed3febff31b8949c9d4112029bc5d3eff50dab32f41648bd613937333e1bf06ddf6e1d765a193d9cbe146",
    "ceeb79ac1cb485ed5f5b37913a8cf5857eff00a90102030405060708090a0b0c0d0e0f101112131415161718191a1b1c",
    "1d1e1f20030e000502f04902000e000903d0070000000000000d12000008020a050b070f0304010c0d1006090dc4016f",
    "f53e83cc6cdf9b80841e00000000001d000000000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb2",
    "18cd4a000000000000000000000000ca5a96ecf72b3656ef7cf60bdaa42fcdb218cd4a2c01000000000000d007000060",
    "000000495542310000000000000000000000000000000000000000000000000000000000000000000000000000000098",
    "58effd232b4033e47d90003d41ec34ecaeda940000000000000000000000000000000000000000000000000000000000",
    "030d40",
);
/// reclaim_event_account: EVENT's rent back to OWNER (message 20 bytes of 0xab, attestation 65 of 0xcd).
pub(crate) const RECLAIM: &str = concat!(
    "01000104f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7e9b6062841bb977ad21de71e",
    "c961900633c26f21384e015b014a637a61499547076eaeeeb35d837e56b85fbca83355dea3141b9cfd5b90b3e8c6ee7c",
    "0a34942fa65fc81ce19edcd2d2c340b02fa61be1d5badde1592833ddf92009d8cf6854550102030405060708090a0b0c",
    "0d0e0f101112131415161718191a1b1c1d1e1f20010303000201655ec6b49f83ec0fae41000000cdcdcdcdcdcdcdcdcd",
    "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    "cdcdcdcdcdcdcdcd14000000abababababababababababababababababababab",
);
