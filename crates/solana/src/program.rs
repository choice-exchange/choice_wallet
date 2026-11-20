//! The programs the wallet names, and the instructions it reads. Anything else is
//! [`Instruction::Other`]: the wallet shows its program and accounts and says it can't read it.

use choice_wallet_core::base58;
use sha2::{Digest, Sha256};

use crate::message::{Account, Pubkey};

/// A program the wallet names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Program {
    /// Its address, base58.
    pub id: &'static str,
    /// How the review names it.
    pub name: &'static str,
}

impl Program {
    /// Its address.
    pub fn key(&self) -> Pubkey {
        base58::decode32(self.id).expect("pinned program IDs are valid")
    }
}

/// System: SOL transfers, new accounts, account owners.
pub const SYSTEM: Program = Program {
    id: "11111111111111111111111111111111",
    name: "System",
};
/// Compute Budget: the transaction's compute limit and priority fee.
pub const COMPUTE_BUDGET: Program = Program {
    id: "ComputeBudget111111111111111111111111111111",
    name: "Compute Budget",
};
/// SPL Token.
pub const TOKEN: Program = Program {
    id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    name: "Token",
};
/// SPL Token-2022 (the token program with extensions).
pub const TOKEN_2022: Program = Program {
    id: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    name: "Token-2022",
};
/// Associated Token Account: a wallet's account for one token, at an address derived from both.
pub const ASSOCIATED_TOKEN: Program = Program {
    id: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    name: "Associated Token Account",
};
/// Memo (v2), and its first version.
pub const MEMO: Program = Program {
    id: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    name: "Memo",
};
/// Memo v1.
pub const MEMO_V1: Program = Program {
    id: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
    name: "Memo",
};
/// Circle's CCTP V2 TokenMessengerMinter (the same ID on mainnet and devnet): burns start here.
pub const TOKEN_MESSENGER_MINTER: Program = Program {
    id: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    name: "Circle's bridge (CCTP)",
};
/// Circle's CCTP V2 MessageTransmitter: a burn's record, and its rent back.
pub const MESSAGE_TRANSMITTER: Program = Program {
    id: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
    name: "Circle's bridge (CCTP)",
};

/// Native staking: who may manage and withdraw a stake account, and withdrawals from it.
pub const STAKE: Program = Program {
    id: "Stake11111111111111111111111111111111111111",
    name: "Stake",
};

const READ: [Program; 10] = [
    SYSTEM,
    COMPUTE_BUDGET,
    TOKEN,
    TOKEN_2022,
    ASSOCIATED_TOKEN,
    MEMO,
    MEMO_V1,
    TOKEN_MESSENGER_MINTER,
    MESSAGE_TRANSMITTER,
    STAKE,
];

/// Programs the wallet names but doesn't read: their instructions show as unreadable, by name.
const NAMED: [Program; 7] = [
    Program {
        id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        name: "Jupiter",
    },
    Program {
        id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        name: "Orca Whirlpools",
    },
    Program {
        id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        name: "Raydium AMM",
    },
    Program {
        id: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        name: "Raydium CLMM",
    },
    Program {
        id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        name: "Meteora DLMM",
    },
    Program {
        id: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        name: "Metaplex Token Metadata",
    },
    Program {
        id: "AddressLookupTab1e1111111111111111111111111",
        name: "Address Lookup Table",
    },
];

/// How the review names a program, if the wallet knows it.
pub fn name(program: &Pubkey) -> Option<&'static str> {
    READ.iter()
        .chain(NAMED.iter())
        .find(|p| p.key() == *program)
        .map(|p| p.name)
}

/// Anchor's instruction discriminator: the first 8 bytes of `sha256("global:<name>")`.
pub fn anchor_discriminator(name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("global:{name}"));
    h[..8].try_into().expect("8 bytes")
}

/// A CCTP V2 burn on Solana (`deposit_for_burn` or `deposit_for_burn_with_hook`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CctpBurn {
    /// Whose USDC burns; signs.
    pub owner: Pubkey,
    /// Who pays the rent of the burn's record (the event account); signs.
    pub rent_payer: Pubkey,
    /// The token account the USDC comes from.
    pub token_account: Pubkey,
    /// The token burned.
    pub mint: Pubkey,
    /// The new account that records the burn (a fresh keypair; signs).
    pub event_account: Pubkey,
    /// Base units.
    pub amount: u64,
    /// The destination's CCTP domain.
    pub domain: u32,
    /// Who receives there, as 32 bytes.
    pub mint_recipient: [u8; 32],
    /// Who may submit the mint there; all zero for anyone.
    pub destination_caller: [u8; 32],
    /// The most Circle keeps.
    pub max_fee: u64,
    /// `minFinalityThreshold` (1000 fast, 2000 standard).
    pub min_finality: u32,
    /// `deposit_for_burn_with_hook`'s hook data; `None` for a plain burn.
    pub hook: Option<Vec<u8>>,
}

/// What one instruction does, as far as the wallet reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Instruction {
    /// Moves SOL.
    Transfer {
        /// Pays; signs.
        from: Pubkey,
        /// Receives.
        to: Pubkey,
        /// Lamports (10^-9 SOL).
        lamports: u64,
    },
    /// Creates and funds an account, owned by a program.
    CreateAccount {
        /// Pays; signs.
        from: Pubkey,
        /// The new account; signs.
        account: Pubkey,
        /// Lamports moved into it.
        lamports: u64,
        /// Its size in bytes.
        space: u64,
        /// The program that will own it.
        owner: Pubkey,
    },
    /// Puts `space` bytes of data on a system account. A system account carrying data can't
    /// send SOL or pay a fee again.
    Allocate {
        /// The account; signs.
        account: Pubkey,
        /// Bytes of data.
        space: u64,
    },
    /// Takes SOL out of a nonce account, to `to`. The System program accepts the nonce's
    /// authority from any of the instruction's signing accounts, so those are kept.
    NonceWithdraw {
        /// The nonce account.
        nonce: Pubkey,
        /// Receives.
        to: Pubkey,
        /// Lamports.
        lamports: u64,
        /// The instruction's signing accounts: one is the nonce's authority.
        signers: Vec<Pubkey>,
    },
    /// Hands a nonce account, and the SOL in it, to a new authority.
    NonceAuthorize {
        /// The nonce account.
        nonce: Pubkey,
        /// Its new authority.
        new_authority: Pubkey,
        /// The instruction's signing accounts: one is the current authority.
        signers: Vec<Pubkey>,
    },
    /// Hands an account to a program: the program can then take everything in it.
    Assign {
        /// The account; signs.
        account: Pubkey,
        /// Its new owner.
        owner: Pubkey,
    },
    /// Advances a durable nonce: the transaction stays valid until it's used.
    AdvanceNonce {
        /// The nonce account.
        nonce: Pubkey,
        /// Its authority; signs.
        authority: Pubkey,
    },
    /// The most compute the transaction may use.
    ComputeUnitLimit(u32),
    /// The priority fee, in micro-lamports per compute unit.
    ComputeUnitPrice(u64),
    /// Moves tokens between token accounts.
    TokenTransfer {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account they leave.
        source: Pubkey,
        /// The token account they arrive at.
        destination: Pubkey,
        /// The source's owner or delegate; signs.
        authority: Pubkey,
        /// Base units.
        amount: u64,
        /// The token, when the instruction names it (`TransferChecked`).
        mint: Option<Pubkey>,
        /// Its decimals, likewise.
        decimals: Option<u8>,
    },
    /// Lets a delegate move up to `amount` from a token account.
    TokenApprove {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account.
        source: Pubkey,
        /// Who may spend from it.
        delegate: Pubkey,
        /// Its owner; signs.
        owner: Pubkey,
        /// Base units.
        amount: u64,
        /// The token, when named (`ApproveChecked`).
        mint: Option<Pubkey>,
        /// Its decimals, likewise.
        decimals: Option<u8>,
    },
    /// Removes a token account's delegate.
    TokenRevoke {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account.
        source: Pubkey,
        /// Its owner; signs.
        owner: Pubkey,
    },
    /// Changes who controls a token account or a mint.
    TokenSetAuthority {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account or mint.
        account: Pubkey,
        /// Which authority: 0 mint, 1 freeze, 2 account owner, 3 close, others extensions'.
        kind: u8,
        /// The new authority; `None` removes it.
        new_authority: Option<Pubkey>,
        /// The current one; signs.
        current: Pubkey,
    },
    /// Closes a token account; its SOL (rent) goes to `destination`.
    TokenClose {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account.
        account: Pubkey,
        /// Who gets its SOL.
        destination: Pubkey,
        /// Its owner; signs.
        owner: Pubkey,
    },
    /// Destroys tokens.
    TokenBurn {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The token account.
        account: Pubkey,
        /// The token.
        mint: Pubkey,
        /// Its owner; signs.
        owner: Pubkey,
        /// Base units.
        amount: u64,
        /// Decimals, when named (`BurnChecked`).
        decimals: Option<u8>,
    },
    /// Updates a wrapped-SOL account's token balance to its SOL.
    TokenSyncNative {
        /// The account.
        account: Pubkey,
    },
    /// Opens a token account (`InitializeAccount`, 2 and 3).
    TokenInitializeAccount {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The account.
        account: Pubkey,
        /// The token.
        mint: Pubkey,
        /// Its owner.
        owner: Pubkey,
    },
    /// A token instruction the wallet doesn't read (an extension's, a mint's).
    TokenOther {
        /// SPL Token or Token-2022.
        program: Pubkey,
        /// The instruction's number.
        kind: u8,
    },
    /// Creates an associated token account.
    CreateTokenAccount {
        /// Pays its rent; signs.
        payer: Pubkey,
        /// The account created.
        account: Pubkey,
        /// The wallet it is for.
        owner: Pubkey,
        /// The token.
        mint: Pubkey,
        /// SPL Token or Token-2022.
        token_program: Pubkey,
        /// Does nothing if it exists (`CreateIdempotent`).
        idempotent: bool,
    },
    /// A memo.
    Memo(Vec<u8>),
    /// A CCTP burn.
    CctpBurn(Box<CctpBurn>),
    /// Takes back the rent of a burn's record, once Circle has attested it.
    CctpReclaim {
        /// Gets the rent; signs (it must be who paid it).
        payee: Pubkey,
        /// The record.
        event_account: Pubkey,
    },
    /// Changes who manages (`kind` 0, the staker) or withdraws from (`kind` 1, the
    /// withdrawer) a stake account: Stake's `Authorize` and `AuthorizeChecked`.
    StakeAuthorize {
        /// The stake account.
        stake: Pubkey,
        /// Its current staker or withdrawer; signs.
        authority: Pubkey,
        /// Who it becomes.
        new_authority: Pubkey,
        /// 0 staker, 1 withdrawer.
        kind: u32,
    },
    /// Takes SOL out of a stake account (Stake's `Withdraw`).
    StakeWithdraw {
        /// The stake account.
        stake: Pubkey,
        /// Who gets the SOL.
        to: Pubkey,
        /// Its withdrawer; signs.
        authority: Pubkey,
        /// Lamports.
        lamports: u64,
    },
    /// A known program's instruction whose data or accounts aren't what its layout says.
    Unreadable {
        /// The program.
        program: Pubkey,
        /// Why.
        reason: &'static str,
    },
    /// A program the wallet doesn't read, or an instruction of a known one it doesn't.
    Other {
        /// The program.
        program: Pubkey,
    },
}

fn u32_at(d: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(d.get(at..at + 4)?.try_into().ok()?))
}

fn u64_at(d: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(d.get(at..at + 8)?.try_into().ok()?))
}

fn key_at(d: &[u8], at: usize) -> Option<Pubkey> {
    d.get(at..at + 32)?.try_into().ok()
}

/// Read one instruction of `program` over `accounts` (resolved, in the instruction's order).
pub fn read(program: &Pubkey, accounts: &[Account], data: &[u8]) -> Instruction {
    let unreadable = |reason| Instruction::Unreadable {
        program: *program,
        reason,
    };
    let acct = |i: usize| accounts.get(i).map(|a| a.key);
    let p = *program;
    if p == SYSTEM.key() {
        system(accounts, data)
            .unwrap_or_else(|| unreadable("a System instruction that isn't laid out as its kind says"))
    } else if p == COMPUTE_BUDGET.key() {
        match (data.first(), data.len()) {
            (Some(2), 5) => Instruction::ComputeUnitLimit(u32_at(data, 1).expect("4 bytes")),
            (Some(3), 9) => Instruction::ComputeUnitPrice(u64_at(data, 1).expect("8 bytes")),
            (Some(1 | 4), 5) => Instruction::Other { program: p },
            _ => unreadable("a Compute Budget instruction the wallet can't read"),
        }
    } else if p == TOKEN.key() || p == TOKEN_2022.key() {
        token(&p, accounts, data)
            .unwrap_or_else(|| unreadable("a token instruction that isn't laid out as its kind says"))
    } else if p == ASSOCIATED_TOKEN.key() {
        let idempotent = match data {
            [] | [0] => false,
            [1] => true,
            [2] => return Instruction::Other { program: p },
            _ => return unreadable("an Associated Token Account instruction the wallet can't read"),
        };
        match (acct(0), acct(1), acct(2), acct(3), acct(5)) {
            (Some(payer), Some(account), Some(owner), Some(mint), Some(token_program)) => {
                Instruction::CreateTokenAccount {
                    payer,
                    account,
                    owner,
                    mint,
                    token_program,
                    idempotent,
                }
            }
            _ => unreadable("a token account creation without its accounts"),
        }
    } else if p == MEMO.key() || p == MEMO_V1.key() {
        Instruction::Memo(data.to_vec())
    } else if p == TOKEN_MESSENGER_MINTER.key() {
        cctp_burn(accounts, data).unwrap_or_else(|| {
            let burn = [
                anchor_discriminator("deposit_for_burn"),
                anchor_discriminator("deposit_for_burn_with_hook"),
            ];
            if data.len() >= 8 && burn.iter().any(|d| d[..] == data[..8]) {
                unreadable("a CCTP burn that isn't laid out as a burn")
            } else {
                Instruction::Other { program: p }
            }
        })
    } else if p == MESSAGE_TRANSMITTER.key() {
        if data.len() >= 8 && data[..8] == anchor_discriminator("reclaim_event_account") {
            match (acct(0), acct(2), two_vecs(&data[8..])) {
                (Some(payee), Some(event_account), true) => Instruction::CctpReclaim { payee, event_account },
                _ => unreadable("a CCTP rent reclaim that isn't laid out as one"),
            }
        } else {
            Instruction::Other { program: p }
        }
    } else if p == STAKE.key() {
        stake(accounts, data)
    } else {
        Instruction::Other { program: p }
    }
}

/// Stake's instructions that move control of a stake account or its SOL. The program reads
/// its data with trailing bytes allowed, so anything but the exact layout of these is
/// unreadable rather than guessed at; its other instructions are `Other`.
fn stake(accounts: &[Account], data: &[u8]) -> Instruction {
    let acct = |i: usize| accounts.get(i).map(|a| a.key);
    let unreadable = |reason| Instruction::Unreadable {
        program: STAKE.key(),
        reason,
    };
    match u32_at(data, 0) {
        // Authorize(new authority, kind): [stake, clock, authority, (custodian)].
        Some(1) => match (data.len(), acct(0), acct(2), key_at(data, 4), u32_at(data, 36)) {
            (40, Some(stake), Some(authority), Some(new_authority), Some(kind @ 0..=1)) => {
                Instruction::StakeAuthorize {
                    stake,
                    authority,
                    new_authority,
                    kind,
                }
            }
            _ => unreadable("a Stake Authorize that isn't laid out as one"),
        },
        // AuthorizeChecked(kind): [stake, clock, authority, new authority (signs), (custodian)].
        Some(10) => match (data.len(), acct(0), acct(2), acct(3), u32_at(data, 4)) {
            (8, Some(stake), Some(authority), Some(new_authority), Some(kind @ 0..=1)) => Instruction::StakeAuthorize {
                stake,
                authority,
                new_authority,
                kind,
            },
            _ => unreadable("a Stake AuthorizeChecked that isn't laid out as one"),
        },
        // Withdraw(lamports): [stake, to, clock, stake history, withdrawer, (custodian)].
        Some(4) => match (data.len(), acct(0), acct(1), acct(4), u64_at(data, 4)) {
            (12, Some(stake), Some(to), Some(authority), Some(lamports)) => Instruction::StakeWithdraw {
                stake,
                to,
                authority,
                lamports,
            },
            _ => unreadable("a Stake Withdraw that isn't laid out as one"),
        },
        _ => Instruction::Other { program: STAKE.key() },
    }
}

/// Borsh `(Vec<u8>, Vec<u8>)` filling `d` exactly.
fn two_vecs(d: &[u8]) -> bool {
    let Some(a) = u32_at(d, 0).map(|n| n as usize) else {
        return false;
    };
    let Some(b) = u32_at(d, 4 + a).map(|n| n as usize) else {
        return false;
    };
    d.len() == 8 + a + b
}

fn signers(accounts: &[Account]) -> Vec<Pubkey> {
    accounts.iter().filter(|a| a.signer).map(|a| a.key).collect()
}

/// System instructions are bincode: a u32 kind, then its fields. The program ignores bytes
/// past them, so a known kind of any other length is unreadable here rather than guessed at.
fn system(accounts: &[Account], d: &[u8]) -> Option<Instruction> {
    let acct = |i: usize| accounts.get(i).map(|a| a.key);
    let len = |n: usize| (d.len() == n).then_some(());
    Some(match u32_at(d, 0)? {
        0 => {
            len(52)?;
            Instruction::CreateAccount {
                from: acct(0)?,
                account: acct(1)?,
                lamports: u64_at(d, 4)?,
                space: u64_at(d, 12)?,
                owner: key_at(d, 20)?,
            }
        }
        1 => {
            len(36)?;
            Instruction::Assign {
                account: acct(0)?,
                owner: key_at(d, 4)?,
            }
        }
        2 => {
            len(12)?;
            Instruction::Transfer {
                from: acct(0)?,
                to: acct(1)?,
                lamports: u64_at(d, 4)?,
            }
        }
        // WithdrawNonceAccount: [nonce, to, recent blockhashes, rent, authority].
        5 => {
            len(12)?;
            Instruction::NonceWithdraw {
                nonce: acct(0)?,
                to: acct(1)?,
                lamports: u64_at(d, 4)?,
                signers: signers(accounts),
            }
        }
        // AuthorizeNonceAccount: [nonce, authority], the new authority in the data.
        7 => {
            len(36)?;
            Instruction::NonceAuthorize {
                nonce: acct(0)?,
                new_authority: key_at(d, 4)?,
                signers: signers(accounts),
            }
        }
        8 => {
            len(12)?;
            Instruction::Allocate {
                account: acct(0)?,
                space: u64_at(d, 4)?,
            }
        }
        4 => {
            len(4)?;
            Instruction::AdvanceNonce {
                nonce: acct(0)?,
                authority: acct(2)?,
            }
        }
        // AssignWithSeed: the account (derived from a signing base) to a program. Data: base,
        // a length-prefixed seed (u64 length), then the owner last.
        10 => {
            let seed = usize::try_from(u64_at(d, 36)?).ok()?;
            len(44usize.checked_add(seed)?.checked_add(32)?)?;
            Instruction::Assign {
                account: acct(0)?,
                owner: key_at(d, 44 + seed)?,
            }
        }
        // AllocateWithSeed (9) allocates a derived address, not a signing account.
        3 | 6 | 9 | 11 | 12 => Instruction::Other { program: SYSTEM.key() },
        _ => return None,
    })
}

fn token(program: &Pubkey, accounts: &[Account], d: &[u8]) -> Option<Instruction> {
    let acct = |i: usize| accounts.get(i).map(|a| a.key);
    let program = *program;
    let checked = |len: usize| d.len() == len;
    Some(match *d.first()? {
        3 if checked(9) => Instruction::TokenTransfer {
            program,
            source: acct(0)?,
            destination: acct(1)?,
            authority: acct(2)?,
            amount: u64_at(d, 1)?,
            mint: None,
            decimals: None,
        },
        12 if checked(10) => Instruction::TokenTransfer {
            program,
            source: acct(0)?,
            mint: Some(acct(1)?),
            destination: acct(2)?,
            authority: acct(3)?,
            amount: u64_at(d, 1)?,
            decimals: Some(d[9]),
        },
        4 if checked(9) => Instruction::TokenApprove {
            program,
            source: acct(0)?,
            delegate: acct(1)?,
            owner: acct(2)?,
            amount: u64_at(d, 1)?,
            mint: None,
            decimals: None,
        },
        13 if checked(10) => Instruction::TokenApprove {
            program,
            source: acct(0)?,
            mint: Some(acct(1)?),
            delegate: acct(2)?,
            owner: acct(3)?,
            amount: u64_at(d, 1)?,
            decimals: Some(d[9]),
        },
        5 if checked(1) => Instruction::TokenRevoke {
            program,
            source: acct(0)?,
            owner: acct(1)?,
        },
        6 => {
            let new_authority = match (d.get(2)?, d.len()) {
                (0, 3) => None,
                (1, 35) => Some(key_at(d, 3)?),
                _ => return None,
            };
            Instruction::TokenSetAuthority {
                program,
                account: acct(0)?,
                kind: d[1],
                new_authority,
                current: acct(1)?,
            }
        }
        9 if checked(1) => Instruction::TokenClose {
            program,
            account: acct(0)?,
            destination: acct(1)?,
            owner: acct(2)?,
        },
        8 if checked(9) => Instruction::TokenBurn {
            program,
            account: acct(0)?,
            mint: acct(1)?,
            owner: acct(2)?,
            amount: u64_at(d, 1)?,
            decimals: None,
        },
        15 if checked(10) => Instruction::TokenBurn {
            program,
            account: acct(0)?,
            mint: acct(1)?,
            owner: acct(2)?,
            amount: u64_at(d, 1)?,
            decimals: Some(d[9]),
        },
        17 if checked(1) => Instruction::TokenSyncNative { account: acct(0)? },
        1 if checked(1) => Instruction::TokenInitializeAccount {
            program,
            account: acct(0)?,
            mint: acct(1)?,
            owner: acct(2)?,
        },
        16 | 18 if checked(33) => Instruction::TokenInitializeAccount {
            program,
            account: acct(0)?,
            mint: acct(1)?,
            owner: key_at(d, 1)?,
        },
        3 | 4 | 5 | 8 | 9 | 12 | 13 | 15 | 17 => return None,
        kind => Instruction::TokenOther { program, kind },
    })
}

/// Burn arguments: u64 amount, u32 domain, [32] recipient, [32] caller, u64 max fee, u32
/// finality; then, with a hook, a u32-length-prefixed hook.
fn cctp_burn(accounts: &[Account], d: &[u8]) -> Option<Instruction> {
    let with_hook = if d.get(..8)? == anchor_discriminator("deposit_for_burn") {
        false
    } else if d[..8] == anchor_discriminator("deposit_for_burn_with_hook") {
        true
    } else {
        return None;
    };
    let hook = if with_hook {
        let n = u32_at(d, 96)? as usize;
        if d.len() != 100 + n {
            return None;
        }
        Some(d[100..].to_vec())
    } else {
        if d.len() != 96 {
            return None;
        }
        None
    };
    let acct = |i: usize| accounts.get(i).map(|a| a.key);
    Some(Instruction::CctpBurn(Box::new(CctpBurn {
        owner: acct(0)?,
        rent_payer: acct(1)?,
        token_account: acct(3)?,
        mint: acct(10)?,
        event_account: acct(11)?,
        amount: u64_at(d, 8)?,
        domain: u32_at(d, 16)?,
        mint_recipient: key_at(d, 20)?,
        destination_caller: key_at(d, 52)?,
        max_fee: u64_at(d, 84)?,
        min_finality: u32_at(d, 92)?,
        hook,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(key: Pubkey) -> Account {
        Account {
            key,
            signer: false,
            writable: false,
            table: None,
        }
    }

    #[test]
    fn program_ids_decode_and_anchor_discriminators() {
        for p in READ.iter().chain(NAMED.iter()) {
            assert_eq!(base58::encode(&p.key()), p.id);
        }
        // From Circle's IDL (and the bridge package, which computes them the same way).
        assert_eq!(
            anchor_discriminator("deposit_for_burn"),
            [215, 60, 61, 46, 114, 55, 128, 176]
        );
    }

    /// Run-2 C3: Stake's instructions that move a stake account's control or SOL are read;
    /// a form the program would still run but the wallet can't place is unreadable.
    #[test]
    fn stake_layouts() {
        let (stake, clock, me, them, history) = ([1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32], [5u8; 32]);
        let mut authorize = 1u32.to_le_bytes().to_vec();
        authorize.extend_from_slice(&them);
        authorize.extend_from_slice(&1u32.to_le_bytes());
        let accts = [acct(stake), acct(clock), acct(me)];
        assert_eq!(
            read(&STAKE.key(), &accts, &authorize),
            Instruction::StakeAuthorize {
                stake,
                authority: me,
                new_authority: them,
                kind: 1
            }
        );
        let mut checked = 10u32.to_le_bytes().to_vec();
        checked.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            read(
                &STAKE.key(),
                &[acct(stake), acct(clock), acct(me), acct(them)],
                &checked
            ),
            Instruction::StakeAuthorize {
                stake,
                authority: me,
                new_authority: them,
                kind: 0
            }
        );
        let mut withdraw = 4u32.to_le_bytes().to_vec();
        withdraw.extend_from_slice(&100_000_000_000u64.to_le_bytes());
        assert_eq!(
            read(
                &STAKE.key(),
                &[acct(stake), acct(them), acct(clock), acct(history), acct(me)],
                &withdraw
            ),
            Instruction::StakeWithdraw {
                stake,
                to: them,
                authority: me,
                lamports: 100_000_000_000
            }
        );
        // A trailing byte, a third kind, or a missing account: unreadable, never guessed.
        let mut longer = authorize.clone();
        longer.push(0);
        let mut third = authorize[..36].to_vec();
        third.extend_from_slice(&2u32.to_le_bytes());
        for (a, d) in [(&accts[..], &longer), (&accts[..], &third), (&accts[..2], &authorize)] {
            assert!(
                matches!(read(&STAKE.key(), a, d), Instruction::Unreadable { .. }),
                "{d:?}"
            );
        }
        // Delegating, deactivating and the rest are named but not read.
        assert_eq!(
            read(&STAKE.key(), &accts, &5u32.to_le_bytes()),
            Instruction::Other { program: STAKE.key() }
        );
        assert_eq!(name(&STAKE.key()), Some("Stake"));
    }

    /// Run-3: Allocate on a signing account, and the nonce instructions with their signers
    /// (the System program takes the nonce's authority from any of them).
    #[test]
    fn allocate_and_nonce_layouts() {
        let (n, to, auth) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let signer = |key: [u8; 32]| Account {
            key,
            signer: true,
            writable: true,
            table: None,
        };
        let mut alloc = 8u32.to_le_bytes().to_vec();
        alloc.extend_from_slice(&1u64.to_le_bytes());
        assert_eq!(
            read(&SYSTEM.key(), &[signer(n)], &alloc),
            Instruction::Allocate { account: n, space: 1 }
        );
        let mut withdraw = 5u32.to_le_bytes().to_vec();
        withdraw.extend_from_slice(&7u64.to_le_bytes());
        let accts = [
            acct(n),
            acct(to),
            acct([4; 32]),
            acct([5; 32]),
            acct([6; 32]),
            signer(auth),
        ];
        assert_eq!(
            read(&SYSTEM.key(), &accts, &withdraw),
            Instruction::NonceWithdraw {
                nonce: n,
                to,
                lamports: 7,
                signers: vec![auth]
            }
        );
        let mut authorize = 7u32.to_le_bytes().to_vec();
        authorize.extend_from_slice(&to);
        assert_eq!(
            read(&SYSTEM.key(), &[acct(n), signer(auth)], &authorize),
            Instruction::NonceAuthorize {
                nonce: n,
                new_authority: to,
                signers: vec![auth]
            }
        );
        // Any other length is unreadable.
        alloc.push(0);
        assert!(matches!(
            read(&SYSTEM.key(), &[signer(n)], &alloc),
            Instruction::Unreadable { .. }
        ));
    }

    #[test]
    fn system_and_token_layouts() {
        let (a, b, c) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let accts = [acct(a), acct(b), acct(c), acct([4; 32])];
        let mut assign = 1u32.to_le_bytes().to_vec();
        assign.extend_from_slice(&c);
        assert_eq!(
            read(&SYSTEM.key(), &accts, &assign),
            Instruction::Assign { account: a, owner: c }
        );
        // SetAuthority: account owner (2) to `c`, then removed.
        let mut set = vec![6, 2, 1];
        set.extend_from_slice(&c);
        assert_eq!(
            read(&TOKEN.key(), &accts, &set),
            Instruction::TokenSetAuthority {
                program: TOKEN.key(),
                account: a,
                kind: 2,
                new_authority: Some(c),
                current: b
            }
        );
        assert!(matches!(
            read(&TOKEN.key(), &accts, &[6, 3, 0]),
            Instruction::TokenSetAuthority {
                new_authority: None,
                kind: 3,
                ..
            }
        ));
        // Approve u64::MAX.
        let mut approve = vec![4];
        approve.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(
            matches!(read(&TOKEN_2022.key(), &accts, &approve), Instruction::TokenApprove { amount: u64::MAX, delegate, .. } if delegate == b)
        );
        // Wrong lengths are unreadable, not guessed at.
        assert!(matches!(
            read(&TOKEN.key(), &accts, &[3, 1]),
            Instruction::Unreadable { .. }
        ));
        assert!(matches!(
            read(&SYSTEM.key(), &accts, &[2, 0, 0, 0, 1]),
            Instruction::Unreadable { .. }
        ));
        assert!(matches!(
            read(&TOKEN.key(), &accts, &[6, 2, 1]),
            Instruction::Unreadable { .. }
        ));
        // Too few accounts for the layout.
        assert!(matches!(
            read(&TOKEN.key(), &accts[..1], &[9]),
            Instruction::Unreadable { .. }
        ));
        assert_eq!(
            read(&TOKEN.key(), &accts, &[7, 0]),
            Instruction::TokenOther {
                program: TOKEN.key(),
                kind: 7
            }
        );
        assert_eq!(
            read(&[9; 32], &accts, &[1, 2, 3]),
            Instruction::Other { program: [9; 32] }
        );
    }
}
