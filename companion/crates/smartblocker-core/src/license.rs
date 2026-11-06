//! Offline Pro licensing: self-contained SHA-256 + HMAC-SHA256 (no external
//! crypto crate, so the ~1s offline build stays intact) plus the license
//! token format and the `is_pro` gate.
//!
//! Token format: `SBPRO1.<payload_hex>.<hmac_hex>` where the payload is
//! `pro:<email-or-id>` bytes (perpetual) or `pro:<email-or-id>:<expiry>`
//! (expiry = epoch milliseconds >= 10^12, so a legacy id ending in a short
//! `:12345` suffix still reads as perpetual) and the tag is HMAC-SHA256 over
//! the payload keyed with the embedded product verification salt below. A
//! legacy `sb_pro_<payload_hex>_<hmac_hex>` spelling verifies too. The salt
//! lives in the binary, which is honest tamper-evidence for a $39 offline
//! check — anyone patching the binary itself was never gated by a key file
//! anyway.
//!
//! Gate posture (red-team #24 — fail CLOSED by default):
//! - MISSING/empty key → NOT Pro. The pre-store dev period is covered by
//!   `SBPRO_DEV_OPEN=1` in the daemon's environment ("dev-open"), an
//!   explicit escape hatch instead of a silent fail-open.
//! - Invalid key (malformed or bad tag) → NOT Pro.
//! - Valid key, unexpired (or perpetual) → Pro.
//! - EXPIRED key → Pro for `EXPIRED_GRACE_MS` after expiry (renewal
//!   friction shouldn't disarm a paying user's lock mid-lock), then NOT
//!   Pro. The daemon logs every posture transition (`license` events).

use crate::store::CompanionConfig;
use std::time::{SystemTime, UNIX_EPOCH};

/// Embedded product verification salt (HMAC key). "Public" by design: it
/// ships inside the binary, same as any offline license scheme.
const PRODUCT_SALT: &[u8] = b"smartblocker-pro-license-salt-v1-9f27c4ae";

/// Post-expiry grace: an expired-but-valid key keeps Pro for 7 days, then
/// the gate closes (red-team #24; renewal friction must not disarm a lock).
pub const EXPIRED_GRACE_MS: i64 = 7 * 24 * 3600 * 1000;

/// Expiry tails only parse as expiries at/above this value (epoch ms,
/// 2001-09-09): keeps a legacy id like `pro:order:12345` perpetual instead
/// of misreading its numeric suffix as an expiry.
const MIN_EXPIRY_TAIL_MS: i64 = 1_000_000_000_000;

/// Environment escape hatch covering the pre-store dev period
/// (red-team #24): `SBPRO_DEV_OPEN=1` treats a keyless install as Pro.
/// Anything a user types into config.json still has to verify.
pub const DEV_OPEN_ENV: &str = "SBPRO_DEV_OPEN";

fn dev_open() -> bool {
    std::env::var_os(DEV_OPEN_ENV).is_some_and(|v| v == "1")
}

// -- SHA-256 (FIPS 180-4) ---------------------------------------------------

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, slot) in w.iter_mut().take(16).enumerate() {
            *slot = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// HMAC-SHA256 (RFC 2104) with a 64-byte block size.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&sha256(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + msg.len());
    for b in block {
        inner.push(b ^ 0x36);
    }
    inner.extend_from_slice(msg);
    let inner_hash = sha256(&inner);
    let mut outer = Vec::with_capacity(64 + 32);
    for b in block {
        outer.push(b ^ 0x5c);
    }
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

// -- hex --------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

// -- license tokens ---------------------------------------------------------

fn license_payload(email_or_id: &str) -> Vec<u8> {
    format!("pro:{email_or_id}").into_bytes()
}

/// Mint a Pro token for `email_or_id`. This is the key-generator side the
/// payment webhook/tooling uses; the shipped verifier is `verify_license_key`.
pub fn generate_license_key(email_or_id: &str) -> String {
    mint(&license_payload(email_or_id))
}

/// Mint a Pro token that expires at `expiry_epoch_ms` (perpetual tokens use
/// `generate_license_key`; the grace window is applied at verification,
/// not baked into the key).
pub fn generate_expiring_license_key(email_or_id: &str, expiry_epoch_ms: i64) -> String {
    mint(format!("pro:{email_or_id}:{expiry_epoch_ms}").as_bytes())
}

fn mint(payload: &[u8]) -> String {
    let sig = hmac_sha256(PRODUCT_SALT, payload);
    format!("SBPRO1.{}.{}", hex_encode(payload), hex_encode(&sig))
}

/// Split a token into (payload_hex, hmac_hex), accepting both the
/// `SBPRO1.<...>.<...>` and legacy `sb_pro_<...>_<...>` spellings.
fn split_key(key: &str) -> Option<(&str, &str)> {
    let key = key.trim();
    if let Some(rest) = key.strip_prefix("SBPRO1.") {
        return rest.split_once('.');
    }
    if let Some(rest) = key.strip_prefix("sb_pro_") {
        // Hex never contains '_' so the last separator is unambiguous.
        return rest.rsplit_once('_');
    }
    None
}

/// Verify the HMAC tag and return the decoded payload on success; any
/// malformed or wrongly-signed token yields None (fail-closed).
pub fn verify_and_payload(key: &str) -> Option<String> {
    let (payload_hex, sig_hex) = split_key(key)?;
    let (Some(payload), Some(sig)) = (hex_decode(payload_hex), hex_decode(sig_hex)) else {
        return None;
    };
    if payload.is_empty() || sig.len() != 32 {
        return None;
    }
    let expect = hmac_sha256(PRODUCT_SALT, &payload);
    let ok = sig
        .iter()
        .zip(expect.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0;
    ok.then_some(String::from_utf8(payload).ok()?)
}

/// Offline verification: well-formed token AND a valid HMAC tag for the
/// embedded product salt. Constant-time compare on the tag. Signature-only —
/// expiry semantics live in the gate (`check_at`) so verification answers
/// exactly one question: did we issue this token?
pub fn verify_license_key(key: &str) -> bool {
    verify_and_payload(key).is_some()
}

/// Parse the expiry epoch milliseconds out of a verified
/// `pro:<id>:<expiry_ms>` payload. `rfind(':')` keeps ids that themselves
/// contain colons valid, and the `MIN_EXPIRY_TAIL_MS` floor (≈ Sep 2001)
/// distinguishes a real expiry from a legacy id tail — a legacy `pro:<id>`
/// key (or an id ending in `:12345`) stays perpetual while any plausible
/// date parses as a date.
pub fn payload_expiry(payload: &str) -> Option<i64> {
    let tail = &payload[payload.rfind(':')? + 1..];
    let ms: i64 = tail.parse().ok()?;
    (ms >= MIN_EXPIRY_TAIL_MS).then_some(ms)
}

/// Gate result: the Pro verdict plus a stable posture label the daemon logs
/// on every transition (`license` events).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LicenseCheck {
    pub pro: bool,
    pub posture: &'static str,
}

/// The time-aware gate. Fail-CLOSED (red-team #24): missing, malformed or
/// wrongly-signed keys are NOT Pro. `dev_open` is the resolved
/// `SBPRO_DEV_OPEN=1` escape hatch; it covers only the keyless/invalid case
/// — an expired key still reads as expired so posture logs stay truthful.
pub fn check_at(key: Option<&str>, now_wall_ms: i64, dev_open: bool) -> LicenseCheck {
    let non_empty = key.map(str::trim).filter(|k| !k.is_empty());
    let Some(payload) = non_empty.and_then(verify_and_payload) else {
        return if dev_open {
            LicenseCheck {
                pro: true,
                posture: "dev-open",
            }
        } else if non_empty.is_some() {
            LicenseCheck {
                pro: false,
                posture: "free-invalid",
            }
        } else {
            LicenseCheck {
                pro: false,
                posture: "free-no-key",
            }
        };
    };
    match payload_expiry(&payload) {
        None => LicenseCheck {
            pro: true,
            posture: "pro",
        },
        Some(expiry) if now_wall_ms < expiry => LicenseCheck {
            pro: true,
            posture: "pro",
        },
        Some(expiry) if now_wall_ms < expiry.saturating_add(EXPIRED_GRACE_MS) => LicenseCheck {
            pro: true,
            posture: "pro-grace",
        },
        Some(_) => LicenseCheck {
            pro: false,
            posture: "free-expired",
        },
    }
}

/// The gate over a whole config, with the env escape hatch resolved here.
pub fn check(config: &CompanionConfig, now_wall_ms: i64) -> LicenseCheck {
    check_at(config.license_key.as_deref(), now_wall_ms, dev_open())
}

/// The Pro gate. Fail-closed wrapper over `check` at the current wall time.
pub fn is_pro(config: &CompanionConfig) -> bool {
    check(config, now_wall_ms()).pro
}

fn now_wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        // FIPS 180-4 example vector.
        assert_eq!(
            hex_encode(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex_encode(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_style_vector() {
        // Well-known published vector (key "key", quick brown fox).
        assert_eq!(
            hex_encode(&hmac_sha256(
                b"key",
                b"The quick brown fox jumps over the lazy dog"
            )),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn generated_keys_verify() {
        for id in ["user@example.com", "order_12345", ""] {
            assert!(
                verify_license_key(&generate_license_key(id)),
                "key for {id:?} must verify"
            );
        }
    }

    #[test]
    fn legacy_sb_pro_spelling_verifies() {
        let payload = license_payload("user@example.com");
        let sig = hmac_sha256(PRODUCT_SALT, &payload);
        let legacy = format!("sb_pro_{}_{}", hex_encode(&payload), hex_encode(&sig));
        assert!(verify_license_key(&legacy));
    }

    #[test]
    fn tampered_payload_fails() {
        let key = generate_license_key("user@example.com");
        // Flip one hex digit of the first payload byte ('70' -> '71').
        let mutated = key.replacen("70", "71", 1);
        assert!(!verify_license_key(&mutated));
    }

    #[test]
    fn foreign_signature_fails() {
        let payload = license_payload("user@example.com");
        let wrong_sig = hmac_sha256(b"somebody-elses-key", &payload);
        let forged = format!("SBPRO1.{}.{}", hex_encode(&payload), hex_encode(&wrong_sig));
        assert!(!verify_license_key(&forged));
    }

    #[test]
    fn malformed_tokens_fail() {
        assert!(!verify_license_key(""));
        assert!(!verify_license_key("SBPRO1"));
        assert!(!verify_license_key("SBPRO1.zzzz.aaaa"));
        assert!(!verify_license_key("SBPRO1.70726f3a.")); // missing sig
        assert!(!verify_license_key("SBPRO1..abcd"));
        assert!(!verify_license_key("pro.70726f3a61.aa"));
        // Trimmed surrounding whitespace still verifies.
        let key = generate_license_key("user@example.com");
        assert!(verify_license_key(&format!("  {key}\n")));
    }

    #[test]
    fn gate_is_fail_closed_without_a_valid_key() {
        // Red-team #24: missing/empty/garbage keys are NOT Pro by default.
        let now = 2_000_000_000_000;
        for key in [None, Some("  "), Some("SBPRO1.deadbeef.deadbeef")] {
            assert!(!check_at(key, now, false).pro, "{key:?} must not be Pro");
        }
        assert_eq!(check_at(None, now, false).posture, "free-no-key");
        assert_eq!(check_at(Some("  "), now, false).posture, "free-no-key");
        assert_eq!(
            check_at(Some("SBPRO1.deadbeef.deadbeef"), now, false).posture,
            "free-invalid"
        );
        // The dev escape hatch covers the keyless/invalid case.
        let open = check_at(None, now, true);
        assert!(open.pro);
        assert_eq!(open.posture, "dev-open");
        assert!(check_at(Some("SBPRO1.deadbeef.deadbeef"), now, true).pro);
    }

    #[test]
    fn gate_applies_expiry_with_a_renewal_grace_window() {
        let expiry = 2_000_000_000_000i64;
        let key = generate_expiring_license_key("user@example.com", expiry);
        // Before expiry: Pro.
        assert_eq!(
            check_at(Some(key.as_str()), expiry - 1, false).posture,
            "pro"
        );
        // Inside the grace window: still Pro, visibly so.
        let grace = check_at(Some(key.as_str()), expiry + EXPIRED_GRACE_MS - 1, false);
        assert!(grace.pro);
        assert_eq!(grace.posture, "pro-grace");
        // Past grace: free, and dev-open does NOT resurrect an expired key.
        let expired = check_at(Some(key.as_str()), expiry + EXPIRED_GRACE_MS, false);
        assert!(!expired.pro);
        assert_eq!(expired.posture, "free-expired");
        assert_eq!(
            check_at(Some(key.as_str()), expiry + EXPIRED_GRACE_MS, true).posture,
            "free-expired"
        );
        // Perpetual keys never expire.
        let perpetual = generate_license_key("user@example.com");
        assert!(check_at(Some(perpetual.as_str()), i64::MAX, false).pro);
    }

    #[test]
    fn payload_expiry_distinguishes_dates_from_legacy_id_tails() {
        assert_eq!(payload_expiry("pro:user@example.com"), None);
        // A short numeric tail on a legacy id is NOT an expiry.
        assert_eq!(payload_expiry("pro:order:12345"), None);
        // The 2001-09-09 boundary is inclusive...
        assert_eq!(payload_expiry("pro:order:999999999999"), None);
        assert_eq!(
            payload_expiry("pro:order:1000000000000"),
            Some(1_000_000_000_000)
        );
        // ...and rfind keeps colon-bearing ids intact.
        assert_eq!(
            payload_expiry("pro:a:b:2000000000000"),
            Some(2_000_000_000_000)
        );
    }
}
