//! A Solana message: the bytes a transaction's signatures cover. Two versions exist: legacy
//! (every account listed) and v0 (some accounts named by index into on-chain address lookup
//! tables). Parsed strictly: anything the runtime would refuse, or that could be read two
//! ways, is refused here too.

/// An account key, a program ID or a blockhash: 32 bytes.
pub type Pubkey = [u8; 32];

/// Why bytes aren't a message the vault reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageError(pub &'static str);

impl std::fmt::Display for MessageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for MessageError {}

/// The message format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    /// Every account in the message.
    Legacy,
    /// Version 0: accounts may come from address lookup tables.
    V0,
}

/// How many of the listed accounts sign, and which are read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// The first this many keys sign; the first of them pays the fee.
    pub required_signatures: u8,
    /// The last this many signers are read-only.
    pub readonly_signed: u8,
    /// The last this many non-signers are read-only.
    pub readonly_unsigned: u8,
}

/// One instruction, accounts by index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledInstruction {
    /// The program, an index into the message's own keys.
    pub program: u8,
    /// Its accounts, indexes into all the message's accounts (lookup tables' included).
    pub accounts: Vec<u8>,
    /// Its data, which only the program knows how to read.
    pub data: Vec<u8>,
}

/// A v0 message's use of one address lookup table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lookup {
    /// The table's address.
    pub table: Pubkey,
    /// Entries loaded writable.
    pub writable: Vec<u8>,
    /// Entries loaded read-only.
    pub readonly: Vec<u8>,
}

/// A parsed message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Legacy or v0.
    pub version: Version,
    /// Signers and read-only counts.
    pub header: Header,
    /// The accounts listed in the message itself, signers first.
    pub keys: Vec<Pubkey>,
    /// A recent blockhash (the message expires with it), or a durable nonce's value.
    pub blockhash: Pubkey,
    /// The instructions, in order.
    pub instructions: Vec<CompiledInstruction>,
    /// The lookup tables a v0 message loads accounts from.
    pub lookups: Vec<Lookup>,
}

/// One account of a message, resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Account {
    /// Its address.
    pub key: Pubkey,
    /// It signs the message.
    pub signer: bool,
    /// The transaction may change it.
    pub writable: bool,
    /// Loaded from a lookup table (the table, the entry): the vault knows the address only
    /// as the host read the table.
    pub table: Option<(Pubkey, u8)>,
}

/// Solana's limit on a transaction's accounts.
const MAX_ACCOUNTS: usize = 256;

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], MessageError> {
        let (head, rest) = self
            .0
            .split_at_checked(n)
            .ok_or(MessageError("the message ends early"))?;
        self.0 = rest;
        Ok(head)
    }

    fn byte(&mut self) -> Result<u8, MessageError> {
        Ok(self.take(1)?[0])
    }

    fn key(&mut self) -> Result<Pubkey, MessageError> {
        Ok(self.take(32)?.try_into().expect("32 bytes"))
    }

    /// Solana's compact-u16: 7 bits a byte, low first, at most 3 bytes, no padding.
    fn short_vec(&mut self) -> Result<usize, MessageError> {
        let mut value = 0usize;
        for i in 0..3 {
            let b = self.byte()?;
            value |= usize::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                if i > 0 && b == 0 {
                    return Err(MessageError("a length isn't minimally encoded"));
                }
                if i == 2 && b > 3 {
                    return Err(MessageError("a length is out of range"));
                }
                return Ok(value);
            }
        }
        Err(MessageError("a length is out of range"))
    }

    fn bytes(&mut self) -> Result<Vec<u8>, MessageError> {
        let n = self.short_vec()?;
        Ok(self.take(n)?.to_vec())
    }
}

/// Solana's compact-u16 encoding of `n`.
pub fn short_vec(n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut v = n;
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

/// Parse and check a message.
pub fn parse(bytes: &[u8]) -> Result<Message, MessageError> {
    let mut r = Reader(bytes);
    let first = *bytes.first().ok_or(MessageError("empty"))?;
    let version = if first & 0x80 == 0 {
        Version::Legacy
    } else if first == 0x80 {
        r.byte()?;
        Version::V0
    } else {
        return Err(MessageError("an unknown message version"));
    };
    let header = Header {
        required_signatures: r.byte()?,
        readonly_signed: r.byte()?,
        readonly_unsigned: r.byte()?,
    };
    let n = r.short_vec()?;
    let keys = (0..n).map(|_| r.key()).collect::<Result<Vec<_>, _>>()?;
    let blockhash = r.key()?;
    let n = r.short_vec()?;
    let instructions = (0..n)
        .map(|_| {
            Ok(CompiledInstruction {
                program: r.byte()?,
                accounts: r.bytes()?,
                data: r.bytes()?,
            })
        })
        .collect::<Result<Vec<_>, MessageError>>()?;
    let lookups = match version {
        Version::Legacy => Vec::new(),
        Version::V0 => {
            let n = r.short_vec()?;
            (0..n)
                .map(|_| {
                    Ok(Lookup {
                        table: r.key()?,
                        writable: r.bytes()?,
                        readonly: r.bytes()?,
                    })
                })
                .collect::<Result<Vec<_>, MessageError>>()?
        }
    };
    if !r.0.is_empty() {
        return Err(MessageError("bytes after the message"));
    }
    let m = Message {
        version,
        header,
        keys,
        blockhash,
        instructions,
        lookups,
    };
    m.check()?;
    Ok(m)
}

impl Message {
    /// The runtime's checks on a message's shape (`Message::sanitize`), and no account
    /// listed twice.
    fn check(&self) -> Result<(), MessageError> {
        let h = self.header;
        let listed = self.keys.len();
        if h.required_signatures == 0 {
            return Err(MessageError("nobody signs it"));
        }
        if h.readonly_signed >= h.required_signatures {
            return Err(MessageError("the fee payer is read-only"));
        }
        if usize::from(h.required_signatures) + usize::from(h.readonly_unsigned) > listed {
            return Err(MessageError("the header counts more accounts than it lists"));
        }
        let loaded: usize = self.lookups.iter().map(|l| l.writable.len() + l.readonly.len()).sum();
        if listed + loaded > MAX_ACCOUNTS {
            return Err(MessageError("too many accounts"));
        }
        if self
            .lookups
            .iter()
            .any(|l| l.writable.is_empty() && l.readonly.is_empty())
        {
            return Err(MessageError("a lookup table that loads nothing"));
        }
        for (i, k) in self.keys.iter().enumerate() {
            if self.keys[..i].contains(k) {
                return Err(MessageError("an account is listed twice"));
            }
        }
        for ix in &self.instructions {
            let p = usize::from(ix.program);
            // Programs must be listed in the message itself, and the fee payer can't be one.
            if p == 0 || p >= listed {
                return Err(MessageError("an instruction's program isn't a listed account"));
            }
            if ix.accounts.iter().any(|&a| usize::from(a) >= listed + loaded) {
                return Err(MessageError("an instruction names an account that isn't there"));
            }
        }
        Ok(())
    }

    /// The accounts that sign, the fee payer first.
    pub fn signers(&self) -> &[Pubkey] {
        &self.keys[..usize::from(self.header.required_signatures)]
    }

    /// The fee payer.
    pub fn fee_payer(&self) -> &Pubkey {
        &self.keys[0]
    }

    /// Whether listed account `i` is writable, by the header.
    fn listed_writable(&self, i: usize) -> bool {
        let h = self.header;
        let signers = usize::from(h.required_signatures);
        if i < signers {
            i < signers - usize::from(h.readonly_signed)
        } else {
            i < self.keys.len() - usize::from(h.readonly_unsigned)
        }
    }

    /// Every account, listed ones first, then each table's writable entries, then each
    /// table's read-only ones (the runtime's order). `tables` gives each table's entries as
    /// the host read them; an entry the message uses but the table lacks is an error.
    pub fn accounts(&self, tables: &[(Pubkey, Vec<Pubkey>)]) -> Result<Vec<Account>, MessageError> {
        let signers = usize::from(self.header.required_signatures);
        let mut out: Vec<Account> = self
            .keys
            .iter()
            .enumerate()
            .map(|(i, &key)| Account {
                key,
                signer: i < signers,
                writable: self.listed_writable(i),
                table: None,
            })
            .collect();
        let entry = |l: &Lookup, at: u8| -> Result<Pubkey, MessageError> {
            let (_, entries) = tables
                .iter()
                .find(|(t, _)| *t == l.table)
                .ok_or(MessageError("a lookup table the host didn't read"))?;
            entries
                .get(usize::from(at))
                .copied()
                .ok_or(MessageError("a lookup table entry that doesn't exist"))
        };
        for writable in [true, false] {
            for l in &self.lookups {
                for &at in if writable { &l.writable } else { &l.readonly } {
                    out.push(Account {
                        key: entry(l, at)?,
                        signer: false,
                        writable,
                        table: Some((l.table, at)),
                    });
                }
            }
        }
        for (i, a) in out.iter().enumerate() {
            if out[..i].iter().any(|b| b.key == a.key) {
                return Err(MessageError("an account is loaded twice"));
            }
        }
        Ok(out)
    }

    /// Whether the message leads with `AdvanceNonceAccount`: it then never expires, but waits
    /// valid until its nonce is used.
    pub fn durable_nonce(&self) -> bool {
        self.instructions.first().is_some_and(|ix| {
            self.keys[usize::from(ix.program)] == crate::program::SYSTEM.key()
                && ix.data.len() == 4
                && ix.data[..4] == 4u32.to_le_bytes()
        })
    }
}

/// A transaction on the wire: its signatures (one per signer, all zero where unsigned), then
/// its message. Returns the signatures and the message bytes.
pub fn split_transaction(wire: &[u8]) -> Result<(Vec<[u8; 64]>, &[u8]), MessageError> {
    let mut r = Reader(wire);
    let n = r.short_vec()?;
    let sigs = (0..n)
        .map(|_| Ok(r.take(64)?.try_into().expect("64 bytes")))
        .collect::<Result<Vec<_>, MessageError>>()?;
    Ok((sigs, r.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors::*;

    #[test]
    fn legacy_transfer() {
        let m = parse(&hex::decode(SOL_TRANSFER).unwrap()).unwrap();
        assert_eq!(m.version, Version::Legacy);
        assert_eq!(m.signers(), &[key(OWNER)]);
        assert_eq!(m.blockhash, BLOCKHASH);
        assert_eq!(m.instructions.len(), 3);
        let a = m.accounts(&[]).unwrap();
        // Owner (signer, writable), recipient (writable), then the two programs (read-only).
        assert_eq!(
            a[0],
            Account {
                key: key(OWNER),
                signer: true,
                writable: true,
                table: None
            }
        );
        assert_eq!(a.iter().filter(|a| a.writable).count(), 2);
        assert!(!m.durable_nonce());
    }

    #[test]
    fn v0_loads_accounts_from_its_table() {
        let m = parse(&hex::decode(V0_TABLE).unwrap()).unwrap();
        assert_eq!(m.version, Version::V0);
        assert_eq!(m.lookups.len(), 1);
        let table = (key(TABLE), vec![key(RENT), key(OTHER), key(USDC)]);
        let a = m.accounts(&[table]).unwrap();
        let other = a.iter().find(|a| a.key == key(OTHER)).unwrap();
        assert!(other.writable && other.table == Some((key(TABLE), 1)));
        let usdc = a.iter().find(|a| a.key == key(USDC)).unwrap();
        assert!(!usdc.writable && usdc.table == Some((key(TABLE), 2)));
        // Without the table's entries, or with a short table, there is nothing to show.
        assert!(m.accounts(&[]).is_err());
        assert!(m.accounts(&[(key(TABLE), vec![key(RENT)])]).is_err());
    }

    #[test]
    fn refuses_what_the_runtime_would() {
        let good = hex::decode(SOL_TRANSFER).unwrap();
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(parse(&trailing).is_err());
        assert!(parse(&good[..good.len() - 1]).is_err());
        let mut nobody = good.clone();
        nobody[0] = 0;
        assert!(parse(&nobody).is_err());
        let mut readonly_payer = good.clone();
        readonly_payer[1] = 1;
        assert!(parse(&readonly_payer).is_err());
        let mut v1 = good.clone();
        v1.insert(0, 0x81);
        assert!(parse(&v1).is_err());
        // The same account twice.
        let m = parse(&good).unwrap();
        let mut twice = good.clone();
        let at = 4 + 32; // after the header, the key count and the first key
        twice[at..at + 32].copy_from_slice(&m.keys[0]);
        assert!(parse(&twice).is_err());
    }

    #[test]
    fn compact_u16() {
        for (n, enc) in [
            (0, &[0u8][..]),
            (0x7f, &[0x7f]),
            (0x80, &[0x80, 0x01]),
            (0x3fff, &[0xff, 0x7f]),
            (0x4000, &[0x80, 0x80, 0x01]),
            (0xffff, &[0xff, 0xff, 0x03]),
        ] {
            assert_eq!(short_vec(n), enc);
            assert_eq!(Reader(enc).short_vec().unwrap(), n);
        }
        for bad in [&[0x80, 0x00][..], &[0xff, 0xff, 0x04], &[0x80, 0x80, 0x80, 0x01]] {
            assert!(Reader(bad).short_vec().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn wire_transactions_split() {
        let msg = hex::decode(SOL_TRANSFER).unwrap();
        let wire = [&[1u8][..], &[7u8; 64], &msg].concat();
        let (sigs, m) = split_transaction(&wire).unwrap();
        assert_eq!((sigs, m), (vec![[7u8; 64]], &msg[..]));
    }
}
