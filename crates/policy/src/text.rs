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

/// The last part of a message type URL: `/cosmos.bank.v1beta1.MsgSend` → `MsgSend`.
pub(crate) fn msg_name(type_url: &str) -> &str {
    type_url.rsplit('.').next().unwrap_or(type_url)
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
    }

    #[test]
    fn dates() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400), "2000-02-29");
        assert_eq!(date(1_794_096_000), "2026-11-08");
        assert_eq!(date(-86_400), "1969-12-31");
    }
}
