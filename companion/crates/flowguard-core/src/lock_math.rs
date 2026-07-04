//! Pure lock/schedule time math, mirroring `src/shared/lock-math.ts` — change
//! both together. Parity is enforced by the shared golden fixtures in
//! `tests/fixtures/lock-cases.json` (timezone-free by design); schedule-window
//! math depends on local time and is covered by the unit tests below, which
//! pin `chrono::FixedOffset` zones instead of mutating the `TZ` env var
//! (process-global — would race parallel tests).
//!
//! Contract invariants shared with the TS side:
//! - expiry is strict `>` (a lock ending exactly `now` is inactive);
//! - `reasons` order is fixed: timer, password, frozen, schedule;
//! - overnight windows are expressed as `endMinutes < startMinutes`;
//! - an armed password makes `until` indefinite (`null`) regardless of timers.

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Fat-finger cap on timer/frozen durations — mirrors `MAX_LOCK_MS` in
/// `src/shared/lock.ts`; both sides clamp remote input with it.
pub const MAX_LOCK_MS: i64 = 30 * 24 * 3_600_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRule {
    pub id: String,
    /// Days the window STARTS on: 0–6, Sunday = 0 (matches JS `Date.getDay()`).
    pub days: Vec<u8>,
    /// Minutes since local midnight, 0..=1439.
    pub start_minutes: u16,
    /// 0..=1439. `end < start` = overnight window into the next day.
    pub end_minutes: u16,
}

/// Persisted shape (`lock-state.json` here, storage.local `lockState` in the
/// extension). Sources are independent and compose. Container-level
/// `#[serde(default)]` means a partially-corrupt file degrades field-by-field
/// instead of failing the whole load; the wire path re-sanitizes anyway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LockState {
    /// Timer lock: settings frozen until this epoch ms. `None` ⇔ TS `null`
    /// (serialized as an explicit `null`, never skipped — the TS side writes
    /// explicit nulls).
    pub timer_until: Option<i64>,
    /// Password lock: salted SHA-256 hex. `Some` = armed (indefinite).
    pub password_hash: Option<String>,
    /// Frozen Turkey session end (epoch ms) — also forces blocking on.
    pub frozen_until: Option<i64>,
    /// Recurring locked windows — active windows also force blocking on.
    pub schedules: Vec<ScheduleRule>,
    /// When `schedules` was last replaced (epoch ms; absent JSON = 0, but
    /// ALWAYS serialized). Only consulted by `merge_lock_states`.
    pub schedules_updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockReason {
    Timer,
    Password,
    Frozen,
    Schedule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    /// Any source active: settings frozen, block-screen bypass hidden.
    pub settings_locked: bool,
    /// Frozen Turkey or an in-window schedule: blocking runs even if the
    /// master toggle is off, and stored overrides are ignored.
    pub force_blocking: bool,
    pub reasons: Vec<LockReason>,
    /// When the current lock fully ends; `None` = indefinite (password armed)
    /// or nothing active.
    pub until: Option<i64>,
}

/// TS checks `if (state.passwordHash)` — JS truthiness, so an empty string is
/// NOT armed. `sanitize_lock_state` only ever admits 64-hex strings anyway.
fn password_armed(state: &LockState) -> bool {
    state
        .password_hash
        .as_deref()
        .is_some_and(|h| !h.is_empty())
}

/// A nullable end timestamp that is still in the future (strict `>`).
fn active(until: Option<i64>, now: i64) -> Option<i64> {
    until.filter(|&t| t > now)
}

/// Window length in ms; end < start wraps overnight. start == end is an
/// invalid (empty) rule and yields 0.
fn window_duration_ms(r: &ScheduleRule) -> i64 {
    (i64::from(r.end_minutes) - i64::from(r.start_minutes)).rem_euclid(1440) * 60_000
}

/// Local midnight (in `tz`) of the calendar day containing `now_ms`, shifted
/// by whole days. Mirrors the JS `new Date(y, m, d + offset)` construction:
/// an ambiguous local midnight (DST fall-back) resolves to the earlier
/// instant, a nonexistent one (spring-forward gap in zones that skip
/// midnight) rolls forward to the first valid local time.
fn local_midnight<Tz: TimeZone>(tz: &Tz, now_ms: i64, day_offset: i64) -> Option<DateTime<Tz>> {
    let local = DateTime::<Utc>::from_timestamp_millis(now_ms)?.with_timezone(tz);
    let day = local
        .date_naive()
        .checked_add_signed(Duration::days(day_offset))?;
    let mut naive = day.and_hms_opt(0, 0, 0)?;
    // Gap scan is bounded: no real zone skips more than a couple of hours.
    for _ in 0..(24 * 4) {
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => return Some(dt),
            chrono::LocalResult::Ambiguous(earlier, _) => return Some(earlier),
            chrono::LocalResult::None => naive += Duration::minutes(15),
        }
    }
    None
}

/// End (epoch ms) of the window under rule `r` containing `now_ms`, or None.
/// A containing window can only have started today or (overnight) yesterday.
fn rule_window_end<Tz: TimeZone>(r: &ScheduleRule, now_ms: i64, tz: &Tz) -> Option<i64> {
    let dur = window_duration_ms(r);
    if dur <= 0 {
        return None;
    }
    for offset in [0, -1] {
        let Some(day_start) = local_midnight(tz, now_ms, offset) else {
            continue;
        };
        // Weekday of the resolved midnight instant — mirrors
        // `new Date(dayStart).getDay()`.
        if !r
            .days
            .contains(&(day_start.weekday().num_days_from_sunday() as u8))
        {
            continue;
        }
        let start = day_start.timestamp_millis() + i64::from(r.start_minutes) * 60_000;
        if now_ms >= start && now_ms < start + dur {
            return Some(start + dur);
        }
    }
    None
}

/// End (epoch ms) of the latest-ending window containing `now_ms`, or None.
pub fn current_window_end_in<Tz: TimeZone>(
    rules: &[ScheduleRule],
    now_ms: i64,
    tz: &Tz,
) -> Option<i64> {
    rules
        .iter()
        .filter_map(|r| rule_window_end(r, now_ms, tz))
        .max()
}

pub fn is_in_schedule_window_in<Tz: TimeZone>(
    rules: &[ScheduleRule],
    now_ms: i64,
    tz: &Tz,
) -> bool {
    current_window_end_in(rules, now_ms, tz).is_some()
}

/// Next start-or-end instant strictly after `now` across all sources, or
/// None when nothing is pending. Drives the promptness-only boundary alarm.
pub fn next_boundary_in<Tz: TimeZone>(state: &LockState, now: i64, tz: &Tz) -> Option<i64> {
    let mut candidates: Vec<i64> = Vec::new();
    candidates.extend(active(state.timer_until, now));
    candidates.extend(active(state.frozen_until, now));
    for r in &state.schedules {
        let dur = window_duration_ms(r);
        if dur <= 0 {
            continue;
        }
        // From yesterday (an in-progress overnight window still has its end
        // ahead) through a full week ahead — covers week wraparound.
        for offset in -1..=7 {
            let Some(day_start) = local_midnight(tz, now, offset) else {
                continue;
            };
            if !r
                .days
                .contains(&(day_start.weekday().num_days_from_sunday() as u8))
            {
                continue;
            }
            let start = day_start.timestamp_millis() + i64::from(r.start_minutes) * 60_000;
            if start > now {
                candidates.push(start);
            }
            if start + dur > now {
                candidates.push(start + dur);
            }
        }
    }
    candidates.into_iter().min()
}

pub fn derive_lock_status_in<Tz: TimeZone>(state: &LockState, now: i64, tz: &Tz) -> LockStatus {
    let mut reasons = Vec::new();
    let mut ends = Vec::new();
    if let Some(t) = active(state.timer_until, now) {
        reasons.push(LockReason::Timer);
        ends.push(t);
    }
    if password_armed(state) {
        reasons.push(LockReason::Password);
    }
    if let Some(t) = active(state.frozen_until, now) {
        reasons.push(LockReason::Frozen);
        ends.push(t);
    }
    let window_end = current_window_end_in(&state.schedules, now, tz);
    if let Some(e) = window_end {
        reasons.push(LockReason::Schedule);
        ends.push(e);
    }
    LockStatus {
        settings_locked: !reasons.is_empty(),
        force_blocking: window_end.is_some() || reasons.contains(&LockReason::Frozen),
        until: if password_armed(state) {
            None
        } else {
            ends.into_iter().max()
        },
        reasons,
    }
}

// Production entry points evaluate schedules in the machine's local zone —
// same clock the user set the rules against.

pub fn derive_lock_status(state: &LockState, now: i64) -> LockStatus {
    derive_lock_status_in(state, now, &chrono::Local)
}

pub fn next_boundary(state: &LockState, now: i64) -> Option<i64> {
    next_boundary_in(state, now, &chrono::Local)
}

pub fn current_window_end(rules: &[ScheduleRule], now_ms: i64) -> Option<i64> {
    current_window_end_in(rules, now_ms, &chrono::Local)
}

/// Returns a human-readable problem, or None when the rule is valid.
/// Integrality/negativity is enforced by the field types (serde rejects
/// non-integers before wire input ever reaches this); ranges match the TS.
pub fn validate_schedule_rule(r: &ScheduleRule) -> Option<&'static str> {
    if r.days.is_empty() {
        return Some("Pick at least one day.");
    }
    if r.days.iter().any(|&d| d > 6) {
        return Some("Days must be 0–6.");
    }
    if r.start_minutes > 1439 || r.end_minutes > 1439 {
        return Some("Times must fall within one day.");
    }
    if r.start_minutes == r.end_minutes {
        return Some("Start and end times must differ.");
    }
    None
}

/// Coerce untrusted input (the extension talks over Native Messaging) into a
/// well-formed LockState: wrong types dropped, invalid rules dropped, end
/// timestamps clamped to `now + max_lock_ms` so a bad peer cannot lock
/// forever. Unlike the TS (which passes rule objects through by reference),
/// re-deserializing strips unknown extra properties from rules — the wire
/// shape is `ScheduleRule` either way.
pub fn sanitize_lock_state(raw: &Value, now: i64, max_lock_ms: i64) -> LockState {
    let cap = now + max_lock_ms;
    let until = |key: &str| -> Option<i64> {
        let n = raw.get(key)?.as_f64()?;
        // JSON numbers are always finite; TS additionally checks isFinite.
        if n > 0.0 {
            Some(n.min(cap as f64) as i64)
        } else {
            None
        }
    };
    let schedules = raw
        .get("schedules")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<ScheduleRule>(v.clone()).ok())
                .filter(|r| validate_schedule_rule(r).is_none())
                .collect()
        })
        .unwrap_or_default();
    LockState {
        timer_until: until("timerUntil"),
        password_hash: raw
            .get("passwordHash")
            .and_then(Value::as_str)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .map(str::to_owned),
        frozen_until: until("frozenUntil"),
        schedules,
        schedules_updated_at: raw
            .get("schedulesUpdatedAt")
            .and_then(Value::as_f64)
            .filter(|&n| n > 0.0)
            .map(|n| n.min(cap as f64) as u64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::json;

    fn rule(id: &str, days: &[u8], start: u16, end: u16) -> ScheduleRule {
        ScheduleRule {
            id: id.into(),
            days: days.to_vec(),
            start_minutes: start,
            end_minutes: end,
        }
    }

    /// Mon–Fri 09:00–17:00.
    fn workdays() -> ScheduleRule {
        rule("wd", &[1, 2, 3, 4, 5], 9 * 60, 17 * 60)
    }

    /// Mon 22:00 → Tue 06:00 (overnight).
    fn mon_overnight() -> ScheduleRule {
        rule("on", &[1], 22 * 60, 6 * 60)
    }

    /// Epoch ms of a local wall-clock instant in `tz`.
    /// Anchor week: 2026-07-06 is a Monday.
    fn at(tz: &FixedOffset, d: u32, h: u32, mi: u32) -> i64 {
        tz.with_ymd_and_hms(2026, 7, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    /// Zones under test: UTC-equivalent and a non-hour offset (IST +05:30) —
    /// window math must be identical in any fixed zone.
    fn zones() -> [FixedOffset; 2] {
        [
            FixedOffset::east_opt(0).unwrap(),
            FixedOffset::east_opt(5 * 3600 + 1800).unwrap(),
        ]
    }

    #[test]
    fn weekday_window_membership() {
        for tz in &zones() {
            let rules = [workdays()];
            // Wed noon inside; edges: start inclusive, end exclusive.
            assert!(is_in_schedule_window_in(&rules, at(tz, 8, 12, 0), tz));
            assert!(!is_in_schedule_window_in(&rules, at(tz, 8, 8, 59), tz));
            assert!(is_in_schedule_window_in(&rules, at(tz, 8, 9, 0), tz));
            assert!(!is_in_schedule_window_in(&rules, at(tz, 8, 17, 0), tz));
            // Saturday is not a listed day.
            assert!(!is_in_schedule_window_in(&rules, at(tz, 11, 12, 0), tz));
        }
    }

    #[test]
    fn overnight_window_membership() {
        for tz in &zones() {
            let rules = [mon_overnight()];
            assert!(is_in_schedule_window_in(&rules, at(tz, 6, 22, 0), tz));
            assert!(!is_in_schedule_window_in(&rules, at(tz, 6, 21, 59), tz));
            assert!(is_in_schedule_window_in(&rules, at(tz, 7, 5, 59), tz));
            assert!(!is_in_schedule_window_in(&rules, at(tz, 7, 6, 0), tz));
            // Sunday 23:00 — the window only STARTS on Mondays.
            assert!(!is_in_schedule_window_in(&rules, at(tz, 5, 23, 0), tz));
            assert_eq!(
                current_window_end_in(&rules, at(tz, 7, 3, 0), tz),
                Some(at(tz, 7, 6, 0))
            );
        }
    }

    #[test]
    fn empty_rule_never_matches() {
        for tz in &zones() {
            let rules = [rule("empty", &[1, 2, 3, 4, 5, 6, 0], 600, 600)];
            assert!(!is_in_schedule_window_in(&rules, at(tz, 8, 10, 0), tz));
            assert_eq!(
                next_boundary_in(&schedules_state(rules.to_vec()), 0, tz),
                None
            );
        }
    }

    fn schedules_state(schedules: Vec<ScheduleRule>) -> LockState {
        LockState {
            schedules,
            ..LockState::default()
        }
    }

    #[test]
    fn next_boundary_week_wraparound() {
        for tz in &zones() {
            let state = schedules_state(vec![workdays()]);
            // Sat evening → next Monday 09:00.
            assert_eq!(
                next_boundary_in(&state, at(tz, 4, 20, 0), tz),
                Some(at(tz, 6, 9, 0))
            );
            // Mid-window → that window's end.
            assert_eq!(
                next_boundary_in(&state, at(tz, 8, 12, 0), tz),
                Some(at(tz, 8, 17, 0))
            );
        }
    }

    #[test]
    fn next_boundary_overnight_started_yesterday() {
        for tz in &zones() {
            let state = schedules_state(vec![mon_overnight()]);
            assert_eq!(
                next_boundary_in(&state, at(tz, 7, 3, 0), tz),
                Some(at(tz, 7, 6, 0))
            );
        }
    }

    #[test]
    fn next_boundary_earliest_source_wins() {
        for tz in &zones() {
            let now = at(tz, 8, 12, 0);
            let state = LockState {
                timer_until: Some(now + 60_000),
                frozen_until: Some(now + 120_000),
                schedules: vec![workdays()],
                ..LockState::default()
            };
            assert_eq!(next_boundary_in(&state, now, tz), Some(now + 60_000));
        }
    }

    #[test]
    fn schedule_window_forces_blocking_with_window_end() {
        for tz in &zones() {
            let state = schedules_state(vec![workdays()]);
            let s = derive_lock_status_in(&state, at(tz, 8, 12, 0), tz);
            assert!(s.settings_locked);
            assert!(s.force_blocking);
            assert_eq!(s.reasons, vec![LockReason::Schedule]);
            assert_eq!(s.until, Some(at(tz, 8, 17, 0)));
        }
    }

    #[test]
    fn empty_password_hash_is_not_armed() {
        // Mirrors JS truthiness on `state.passwordHash`.
        let state = LockState {
            password_hash: Some(String::new()),
            ..LockState::default()
        };
        let s = derive_lock_status_in(&state, 0, &Utc);
        assert!(!s.settings_locked);
        assert_eq!(s.reasons, vec![]);
    }

    #[test]
    fn validate_schedule_rule_matches_ts() {
        assert_eq!(validate_schedule_rule(&workdays()), None);
        assert!(validate_schedule_rule(&rule("x", &[], 540, 1020)).is_some());
        assert!(validate_schedule_rule(&rule("x", &[7], 540, 1020)).is_some());
        assert!(validate_schedule_rule(&rule("x", &[1], 600, 600)).is_some());
        assert!(validate_schedule_rule(&rule("x", &[1], 540, 1440)).is_some());
    }

    #[test]
    fn lock_state_serializes_explicit_nulls_and_updated_at() {
        // The TS side writes explicit nulls; schedulesUpdatedAt is always
        // present on output even though absent input defaults to 0.
        assert_eq!(
            serde_json::to_value(LockState::default()).unwrap(),
            json!({
                "timerUntil": null,
                "passwordHash": null,
                "frozenUntil": null,
                "schedules": [],
                "schedulesUpdatedAt": 0
            })
        );
        let parsed: LockState = serde_json::from_value(json!({
            "timerUntil": null, "passwordHash": null, "frozenUntil": null, "schedules": []
        }))
        .unwrap();
        assert_eq!(parsed.schedules_updated_at, 0);
    }

    #[test]
    fn lock_status_serializes_camel_case_lowercase_reasons() {
        let s = LockStatus {
            settings_locked: true,
            force_blocking: true,
            reasons: vec![
                LockReason::Timer,
                LockReason::Password,
                LockReason::Frozen,
                LockReason::Schedule,
            ],
            until: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "settingsLocked": true,
                "forceBlocking": true,
                "reasons": ["timer", "password", "frozen", "schedule"],
                "until": null
            })
        );
    }

    #[test]
    fn sanitize_drops_rules_with_non_integer_or_negative_fields() {
        // TS drops these via Number.isInteger checks; here serde refuses the
        // deserialization — same outcome, rule dropped.
        let state = sanitize_lock_state(
            &json!({
                "schedules": [
                    { "id": "float", "days": [1.5], "startMinutes": 540, "endMinutes": 1020 },
                    { "id": "neg", "days": [1], "startMinutes": -5, "endMinutes": 1020 },
                    { "id": 42, "days": [1], "startMinutes": 540, "endMinutes": 1020 },
                    { "id": "ok", "days": [1], "startMinutes": 540, "endMinutes": 1020 }
                ]
            }),
            1_000_000,
            2_592_000_000,
        );
        assert_eq!(state.schedules.len(), 1);
        assert_eq!(state.schedules[0].id, "ok");
    }
}
