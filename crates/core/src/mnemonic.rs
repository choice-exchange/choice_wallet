//! BIP-39 recovery phrases (English word list).

use core::fmt;

use bip39::Language;
use zeroize::Zeroizing;

use crate::{Error, random};

/// A BIP-39 English recovery phrase. The words and entropy are wiped on drop.
pub struct Mnemonic(bip39::Mnemonic);

impl Mnemonic {
    /// Generate a new phrase of 12 or 24 words from system randomness.
    pub fn generate(word_count: usize) -> Result<Self, Error> {
        let len = match word_count {
            12 => 16,
            24 => 32,
            n => return Err(Error::WordCount(n)),
        };
        let mut entropy = Zeroizing::new([0u8; 32]);
        random::fill(&mut entropy[..len])?;
        Self::from_entropy(&entropy[..len])
    }

    /// Rebuild a phrase from its entropy (16 to 32 bytes, a multiple of 4).
    pub fn from_entropy(entropy: &[u8]) -> Result<Self, Error> {
        bip39::Mnemonic::from_entropy_in(Language::English, entropy)
            .map(Self)
            .map_err(|_| Error::InvalidMnemonic)
    }

    /// Parse a phrase the user typed or pasted. Case and extra whitespace are
    /// ignored. Accepts 12, 15, 18, 21 or 24 words with a valid checksum.
    ///
    /// The caller's `phrase` buffer is the caller's to wipe. In the extension
    /// it is a JS string, which can't be wiped; keep its lifetime short.
    pub fn parse(phrase: &str) -> Result<Self, Error> {
        // Sized up front so the buffer never reallocates and leaves an
        // unwiped copy behind (the English list is ASCII, so lowercasing
        // can't grow it; anything else fails the word-list check anyway).
        let mut normalized = Zeroizing::new(String::with_capacity(phrase.len()));
        for word in phrase.split_whitespace() {
            if !normalized.is_empty() {
                normalized.push(' ');
            }
            for c in word.chars() {
                normalized.push(c.to_ascii_lowercase());
            }
        }
        bip39::Mnemonic::parse_in_normalized(Language::English, &normalized)
            .map(Self)
            .map_err(|_| Error::InvalidMnemonic)
    }

    /// Number of words.
    pub fn word_count(&self) -> usize {
        self.0.word_count()
    }

    /// The phrase as text, for the one-time backup screen only.
    pub fn phrase(&self) -> Zeroizing<String> {
        let len = self.0.words().map(str::len).sum::<usize>() + self.word_count() - 1;
        let mut out = Zeroizing::new(String::with_capacity(len));
        for (i, word) in self.0.words().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(word);
        }
        out
    }

    /// The raw entropy, which is what the keystore stores.
    pub(crate) fn entropy(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.0.to_entropy())
    }

    /// The 64-byte BIP-39 seed. v1 has no BIP-39 passphrase support.
    pub fn to_seed(&self) -> Zeroizing<[u8; 64]> {
        Zeroizing::new(self.0.to_seed_normalized(""))
    }
}

impl fmt::Debug for Mnemonic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Mnemonic(<redacted>, {} words)", self.word_count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn bip39_spec_vector_seed() {
        // BIP-39 reference vector (Trezor vectors use passphrase "TREZOR";
        // this is the widely used empty-passphrase seed for the same phrase).
        let m = Mnemonic::parse(ABANDON).unwrap();
        assert_eq!(
            hex::encode(&m.to_seed()[..]),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
    }

    #[test]
    fn parse_ignores_case_and_spacing() {
        let messy =
            "  Abandon ABANDON abandon\tabandon abandon abandon abandon abandon abandon abandon abandon   about\n";
        assert_eq!(Mnemonic::parse(messy).unwrap().phrase().as_str(), ABANDON);
    }

    #[test]
    fn parse_rejects_bad_checksum_and_unknown_words() {
        let bad_checksum = ABANDON.replace("about", "abandon");
        assert_eq!(Mnemonic::parse(&bad_checksum).unwrap_err(), Error::InvalidMnemonic);
        assert_eq!(
            Mnemonic::parse(&ABANDON.replace("about", "aboutt")).unwrap_err(),
            Error::InvalidMnemonic
        );
        assert_eq!(Mnemonic::parse("abandon about").unwrap_err(), Error::InvalidMnemonic);
    }

    #[test]
    fn generate_round_trips_through_entropy() {
        for words in [12, 24] {
            let m = Mnemonic::generate(words).unwrap();
            assert_eq!(m.word_count(), words);
            let again = Mnemonic::from_entropy(&m.entropy()).unwrap();
            assert_eq!(m.phrase().as_str(), again.phrase().as_str());
        }
        assert_eq!(Mnemonic::generate(18).unwrap_err(), Error::WordCount(18));
    }

    #[test]
    fn debug_never_prints_words() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let s = format!("{m:?}");
        assert!(!s.contains("abandon"), "{s}");
    }
}
