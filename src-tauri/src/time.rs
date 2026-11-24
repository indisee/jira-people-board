//! Wall-clock helpers without a date crate.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn now_iso() -> String {
    iso_from_ms(now_ms() as i64)
}

/// Epoch milliseconds → "YYYY-MM-DDTHH:MM:SSZ" (UTC), via the civil-from-days algorithm.
pub fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(iso_from_ms(1_795_000_000_000), "2026-11-18T11:06:40Z");
        assert_eq!(iso_from_ms(-1000), "1969-12-31T23:59:59Z");
    }
}
