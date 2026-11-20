//! Short forms for the approval screen's sentences.

/// `inj1d7…z8h8`, `0x1671…5A33`: the first 6 and last 4 characters.
pub(crate) fn short(addr: &str) -> String {
    let chars: Vec<char> = addr.chars().collect();
    if chars.len() <= 12 {
        return addr.to_owned();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// The last part of a message type URL: `/cosmos.bank.v1beta1.MsgSend` → `MsgSend`. A site
/// writes the type URL of a message the wallet can't read, so it is cut to 64 characters.
pub(crate) fn msg_name(type_url: &str) -> String {
    clip(type_url.rsplit('.').next().unwrap_or(type_url), 64)
}

/// At most `max` characters of `s`, with `…` when cut: for names a site writes.
pub(crate) fn clip(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

/// A sentence as the approval screen may draw it. A site can put control, format (bidi
/// overrides, zero-width) or line-separator characters in a name the sentence quotes, to
/// hide or reorder its words: each is written as `⟨U+202E⟩`, as the UI's `visible()` does.
pub(crate) fn shown(s: &str) -> String {
    if !s.chars().any(hidden) {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        if hidden(c) {
            out.push_str(&format!("⟨U+{:04X}⟩", u32::from(c)));
        } else {
            out.push(c);
        }
    }
    out
}

/// Unicode categories Cc, Cf, Zl and Zp (Unicode 16): what `visible()` matches with
/// `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`.
fn hidden(c: char) -> bool {
    c.is_control()
        || matches!(
            u32::from(c),
            0x00AD
                | 0x0600..=0x0605
                | 0x061C
                | 0x06DD
                | 0x070F
                | 0x0890..=0x0891
                | 0x08E2
                | 0x180E
                | 0x200B..=0x200F
                | 0x2028..=0x202E
                | 0x2060..=0x2064
                | 0x2066..=0x206F
                | 0xFEFF
                | 0xFFF9..=0xFFFB
                | 0x110BD
                | 0x110CD
                | 0x13430..=0x1343F
                | 0x1BCA0..=0x1BCA3
                | 0x1D173..=0x1D17A
                | 0xE0001
                | 0xE0020..=0xE007F
        )
}

/// A Unix time as a UTC date, `2026-11-08`.
pub(crate) fn date(unix_seconds: i64) -> String {
    // Howard Hinnant's days-to-civil algorithm.
    let z = unix_seconds.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_forms() {
        assert_eq!(short("inj1d7ky6xxfzg6rh7r05uzfxexafepy4wwqp4z8h8"), "inj1d7…z8h8");
        assert_eq!(short("0x1671aB0f9a1c4C3a8F4E8e0C5d5Bf2B0bE7F5A33"), "0x1671…5A33");
        assert_eq!(short("inj1short"), "inj1short");
        assert_eq!(msg_name("/cosmos.bank.v1beta1.MsgSend"), "MsgSend");
        assert_eq!(
            msg_name(&format!("/x.{}", "M".repeat(70))),
            format!("{}…", "M".repeat(64))
        );
        assert_eq!(clip("Uniswap", 40), "Uniswap");
        assert_eq!(clip("abcdef", 3), "abc…");
    }

    #[test]
    fn hidden_characters_are_named() {
        assert_eq!(shown("Signs for Uniswap."), "Signs for Uniswap.");
        assert_eq!(shown("for Uni\u{202e}paws."), "for Uni⟨U+202E⟩paws.");
        assert_eq!(shown("a\nb\u{200b}c\u{2029}"), "a⟨U+000A⟩b⟨U+200B⟩c⟨U+2029⟩");
        assert_eq!(shown("tag\u{E0041}"), "tag⟨U+E0041⟩");
        // Our own punctuation stays.
        assert_eq!(shown("inj1d7…z8h8 · ALL"), "inj1d7…z8h8 · ALL");
    }

    #[test]
    fn dates() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400), "2000-02-29");
        assert_eq!(date(1_794_096_000), "2026-11-08");
        assert_eq!(date(-86_400), "1969-12-31");
    }
}
