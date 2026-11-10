//! Solana transactions as Choice Wallet reads them: the message format ([`message`]),
//! program-derived addresses ([`pda`]) and the instructions of the programs it names
//! ([`program`]). [`read`] puts them together: what a message does, who signs it and what it
//! may cost.
//!
//! Nothing here trusts the host. The one thing the vault can't check itself is a v0 message's
//! lookup tables: their entries come from the host's RPC, so every account read from one is
//! marked as such ([`message::Account::table`]).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod message;
pub mod pda;
pub mod program;

use message::{Account, Message, MessageError, Pubkey};
use program::Instruction;

/// Every signature costs this many lamports.
pub const LAMPORTS_PER_SIGNATURE: u64 = 5_000;
/// Compute units an instruction may use when the message sets no limit.
const DEFAULT_UNITS_PER_INSTRUCTION: u64 = 200_000;
/// A transaction's most compute units.
const MAX_UNITS: u64 = 1_400_000;

/// One instruction, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// The program it calls.
    pub program: Pubkey,
    /// Its accounts, resolved, in its order.
    pub accounts: Vec<Account>,
    /// What it does, as far as the wallet reads it.
    pub instruction: Instruction,
    /// Its raw data, for an instruction the wallet doesn't read.
    pub data: Vec<u8>,
}

/// What a transaction may cost its fee payer, in lamports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fee {
    /// 5,000 per signature.
    pub base: u64,
    /// The priority fee: the compute limit times its price (rounded up).
    pub priority: u64,
    /// The compute limit the message sets, if it does.
    pub unit_limit: Option<u32>,
    /// The price per compute unit, in micro-lamports, if set.
    pub unit_price: Option<u64>,
}

impl Fee {
    /// Base plus priority.
    pub fn total(&self) -> u64 {
        self.base.saturating_add(self.priority)
    }
}

/// A message, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    /// The message.
    pub message: Message,
    /// All its accounts, resolved.
    pub accounts: Vec<Account>,
    /// Its instructions.
    pub steps: Vec<Step>,
    /// What it costs.
    pub fee: Fee,
    /// It never expires: it leads with a durable nonce's advance.
    pub durable_nonce: bool,
}

impl Read {
    /// Whether `key` signs it.
    pub fn signs(&self, key: &Pubkey) -> bool {
        self.message.signers().contains(key)
    }

    /// Accounts from lookup tables, which the vault knows only as the host read them.
    pub fn from_tables(&self) -> bool {
        self.accounts.iter().any(|a| a.table.is_some())
    }
}

/// Read a message's bytes. `tables` gives the entries of each lookup table a v0 message
/// uses, as the host read them.
pub fn read(bytes: &[u8], tables: &[(Pubkey, Vec<Pubkey>)]) -> Result<Read, MessageError> {
    let message = message::parse(bytes)?;
    let accounts = message.accounts(tables)?;
    let steps: Vec<Step> = message
        .instructions
        .iter()
        .map(|ix| {
            let program = message.keys[usize::from(ix.program)];
            let accts: Vec<Account> = ix.accounts.iter().map(|&i| accounts[usize::from(i)]).collect();
            Step {
                instruction: program::read(&program, &accts, &ix.data),
                program,
                accounts: accts,
                data: ix.data.clone(),
            }
        })
        .collect();
    let mut limit = None;
    let mut price = None;
    for s in &steps {
        let twice = match s.instruction {
            Instruction::ComputeUnitLimit(n) => limit.replace(n).is_some(),
            Instruction::ComputeUnitPrice(p) => price.replace(p).is_some(),
            _ => false,
        };
        // The runtime refuses a transaction that sets either twice.
        if twice {
            return Err(MessageError("the compute budget is set twice"));
        }
    }
    let budgeted = steps
        .iter()
        .filter(|s| s.program != program::COMPUTE_BUDGET.key())
        .count() as u64;
    let units = limit.map_or((budgeted * DEFAULT_UNITS_PER_INSTRUCTION).min(MAX_UNITS), u64::from);
    let priority = price.map_or(0, |p| {
        let micro = u128::from(units) * u128::from(p);
        u64::try_from(micro.div_ceil(1_000_000)).unwrap_or(u64::MAX)
    });
    let fee = Fee {
        base: LAMPORTS_PER_SIGNATURE * u64::from(message.header.required_signatures),
        priority,
        unit_limit: limit,
        unit_price: price,
    };
    let durable_nonce = message.durable_nonce();
    Ok(Read {
        message,
        accounts,
        steps,
        fee,
        durable_nonce,
    })
}

#[cfg(test)]
mod vectors;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::program::{CctpBurn, TOKEN};
    use crate::vectors::*;

    fn word(evm: &str) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(&hex::decode(&evm[2..]).unwrap());
        w
    }

    #[test]
    fn sol_transfer_and_its_fee() {
        let r = read(&hex::decode(SOL_TRANSFER).unwrap(), &[]).unwrap();
        assert!(r.signs(&key(OWNER)) && !r.signs(&key(OTHER)));
        let i: Vec<_> = r.steps.iter().map(|s| &s.instruction).collect();
        assert_eq!(*i[0], Instruction::ComputeUnitLimit(200_000));
        assert_eq!(*i[1], Instruction::ComputeUnitPrice(1_000));
        assert_eq!(
            *i[2],
            Instruction::Transfer {
                from: key(OWNER),
                to: key(OTHER),
                lamports: 10_000_000
            }
        );
        // 200,000 units at 1,000 micro-lamports: 200 lamports, plus 5,000 for the signature.
        assert_eq!(r.fee.total(), 5_200);
        assert!(!r.from_tables() && !r.durable_nonce);
    }

    #[test]
    fn v0_transfer_reads_its_recipient_from_the_table() {
        let tables = [(key(TABLE), vec![key(RENT), key(OTHER), key(USDC)])];
        let r = read(&hex::decode(V0_TABLE).unwrap(), &tables).unwrap();
        assert_eq!(
            r.steps[0].instruction,
            Instruction::Transfer {
                from: key(OWNER),
                to: key(OTHER),
                lamports: 5_000
            }
        );
        assert_eq!(r.steps[0].accounts[1].table, Some((key(TABLE), 1)));
        assert_eq!(r.steps[1].instruction, Instruction::Memo(b"hi".to_vec()));
        assert!(r.from_tables());
        // No price set: no priority fee.
        assert_eq!(r.fee.total(), 5_000);
    }

    #[test]
    fn usdc_transfer_with_the_recipients_account() {
        let r = read(&hex::decode(USDC_TRANSFER).unwrap(), &[]).unwrap();
        assert_eq!(
            r.steps[0].instruction,
            Instruction::CreateTokenAccount {
                payer: key(OWNER),
                account: key(ATA_OTHER_USDC),
                owner: key(OTHER),
                mint: key(USDC),
                token_program: TOKEN.key(),
                idempotent: true,
            }
        );
        assert_eq!(
            r.steps[1].instruction,
            Instruction::TokenTransfer {
                program: TOKEN.key(),
                source: key(ATA_OWNER_USDC),
                destination: key(ATA_OTHER_USDC),
                authority: key(OWNER),
                amount: 1_500_000,
                mint: Some(key(USDC)),
                decimals: Some(6),
            }
        );
    }

    #[test]
    fn cctp_burns_to_injective() {
        let plain = read(&hex::decode(BURN_PLAIN).unwrap(), &[]).unwrap();
        // The owner and the burn's record both sign.
        assert_eq!(plain.message.signers(), &[key(OWNER), key(EVENT)]);
        assert_eq!(plain.fee.total(), 2 * 5_000 + 300);
        let Instruction::CctpBurn(b) = &plain.steps[2].instruction else {
            panic!("{:?}", plain.steps[2].instruction)
        };
        assert_eq!(
            **b,
            CctpBurn {
                owner: key(OWNER),
                rent_payer: key(OWNER),
                token_account: key(ATA_OWNER_USDC),
                mint: key(USDC),
                event_account: key(EVENT),
                amount: 2_000_000,
                domain: 29,
                mint_recipient: word(ME_EVM),
                destination_caller: [0; 32],
                max_fee: 300,
                min_finality: 1000,
                hook: None,
            }
        );
        let drop = read(&hex::decode(BURN_DROP).unwrap(), &[]).unwrap();
        let Instruction::CctpBurn(b) = &drop.steps[2].instruction else {
            panic!()
        };
        assert_eq!(
            (b.mint_recipient, b.destination_caller, b.min_finality),
            (word(RECEIVER), word(RECEIVER), 2000)
        );
        let hook = b.hook.as_ref().unwrap();
        assert_eq!(
            (hook.len(), &hook[..4], &hook[44..64]),
            (96, &b"IUB1"[..], &word(ME_EVM)[12..])
        );
    }

    #[test]
    fn rent_reclaim() {
        let r = read(&hex::decode(RECLAIM).unwrap(), &[]).unwrap();
        assert_eq!(
            r.steps[0].instruction,
            Instruction::CctpReclaim {
                payee: key(OWNER),
                event_account: key(EVENT)
            }
        );
    }

    #[test]
    fn a_compute_budget_set_twice_is_refused() {
        let bytes = hex::decode(SOL_TRANSFER).unwrap();
        let mut m = message::parse(&bytes).unwrap();
        m.instructions.insert(1, m.instructions[0].clone());
        // Re-serialize by hand: header, keys, blockhash, instructions.
        let mut out = vec![
            m.header.required_signatures,
            m.header.readonly_signed,
            m.header.readonly_unsigned,
        ];
        out.extend(message::short_vec(m.keys.len()));
        for k in &m.keys {
            out.extend_from_slice(k);
        }
        out.extend_from_slice(&m.blockhash);
        out.extend(message::short_vec(m.instructions.len()));
        for ix in &m.instructions {
            out.push(ix.program);
            out.extend(message::short_vec(ix.accounts.len()));
            out.extend_from_slice(&ix.accounts);
            out.extend(message::short_vec(ix.data.len()));
            out.extend_from_slice(&ix.data);
        }
        assert!(read(&out, &[]).is_err());
    }
}
