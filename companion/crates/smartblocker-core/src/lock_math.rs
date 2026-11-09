//! Pure lock/schedule time math, mirroring `src/shared/lock-math.ts` — change
//! both together. Parity is enforced by the shared golden fixtures in
//! `tests/fixtures/lock-cases.json` (timezone-free by design); schedule-window
//! math depends on local time and is covered by the unit tests below, which
//! pin `chrono::FixedOffset` zones instead of mutating the `TZ` env var
//! (process-global — would race parallel tests).
//!
//! Contract invariants shared with the TS side:
//! - expiry is strict `>` (a lock ending exactly `now` is inactive);
//! - `reasons` order is fixed: timer, password, delay, random-text, frozen,
//!   schedule, partner;
//! - overnight windows are expressed as `endMinutes < startMinutes`;
//! - armed password/delay/random-text/partner gates make `until` indefinite.

use chrono::{DateTime, Datelike, Duration, FixedOffset, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Fat-finger cap on timer/frozen durations — mirrors `MAX_LOCK_MS` in
/// `src/shared/lock.ts`; both sides clamp remote input with it.
pub const MAX_LOCK_MS: i64 = 30 * 24 * 3_600_000;
pub const MAX_BREAK_MS: i64 = 24 * 3_600_000;
pub const MIN_DELAY_LOCK_MS: i64 = 60_000;
pub const MAX_DELAY_LOCK_MS: i64 = 40 * 24 * 3_600_000;
pub const MIN_RANDOM_TEXT_LOCK_LENGTH: u16 = 1;
pub const MAX_RANDOM_TEXT_LOCK_LENGTH: u16 = 5_000;
const MAX_SAFE_TIMESTAMP_MS: u64 = 9_007_199_254_740_991;

fn is_zero(value: &u64) -> bool {
    *value == 0
}

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
    /// Timezone the window times are pinned to: minutes EAST of UTC (e.g.
    /// 330 = UTC+05:30), captured when the rule was written (the extension's
    /// `lock.ts` setSchedules — the only legal schedule write path). `Some`:
    /// the rule evaluates against this FIXED offset, so changing the device
    /// timezone cannot sidestep a window (red-team #26). `None` (absent
    /// JSON, via serde's Option default): legacy rule, evaluated in the
    /// device's CURRENT timezone — the companion backfills on resave.
    ///
    /// KNOWN RESIDUAL — a fixed offset cannot encode DST: a rule pinned
    /// while the zone is on standard time fires one hour off (relative to
    /// civil time) after a daylight-saving change, forever. Deliberate: this
    /// crate builds OFFLINE and no IANA tz database (chrono-tz/tzdb/jiff)
    /// is vendored — `FixedOffset` is the only offline option. A one-hour
    /// civil drift beats a one-line tz bypass; the window still fires at the
    /// same absolute times daily. IANA name kept separately for display.
    #[serde(default)]
    pub tz_offset_minutes: Option<i32>,
    /// IANA name of the pinned zone (e.g. "America/New_York"), display-only
    /// — evaluation uses ONLY `tz_offset_minutes`.
    #[serde(default)]
    pub tz_name: Option<String>,
}

/// Additive category-scoped schedule shape. Flattening preserves the exact
/// ScheduleRule JSON fields and adds `categories`; this is deliberately not a
/// LockState.schedules replacement or a nested wire object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryScheduleRule {
    #[serde(flatten)]
    pub schedule: ScheduleRule,
    /// Exact classifier labels. Empty is invalid and never means all.
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryScheduleScores {
    pub labels: Vec<String>,
    pub scores: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryScheduleVerdict {
    pub label: String,
    pub score: f64,
    #[serde(default)]
    pub all: Option<CategoryScheduleScores>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CategoryScheduleEffect {
    ActiveBlock,
    InactiveRescue,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryScheduleGateResult {
    pub blocked: bool,
    /// The schedule branch that owned the decision, not necessarily a change.
    pub effect: CategoryScheduleEffect,
    /// Complete active set for active-block, or matching inactive set for rescue.
    pub categories: Vec<String>,
}

/// Persisted shape (`lock-state.json` here, storage.local `lockState` in the
/// extension). Sources are independent and compose. Container-level
/// `#[serde(default)]` means a partially-corrupt file degrades field-by-field
/// instead of failing the whole load; the wire path re-sanitizes anyway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LockState {
    /// Break request timestamp. All three nullable break timestamps form one
    /// LWW operation with break_updated_at (mirrors lock-math.ts).
    pub break_started_at: Option<i64>,
    /// Delayed activation; None = immediate.
    pub break_not_before: Option<i64>,
    /// Classifier-driven blocking resumes at this strict end boundary.
    pub break_ends_at: Option<i64>,
    /// Operation stamp; a newer all-None operation is a cancellation tombstone.
    pub break_updated_at: u64,
    /// Timer lock: settings frozen until this epoch ms. `None` ⇔ TS `null`
    /// (serialized as an explicit `null`, never skipped — the TS side writes
    /// explicit nulls).
    pub timer_until: Option<i64>,
    /// Password lock: salted SHA-256 hex. `Some` = armed (indefinite).
    pub password_hash: Option<String>,
    /// Arm/unlock stamp (epoch ms; absent JSON = 0, legacy). Arm stamps on
    /// set, unlock stamps on clear — merge picks the greater stamp, so a
    /// fresh "unlocked" tombstone beats an older armed hash and password
    /// unlocks propagate instead of being re-armed by the peer's copy.
    /// Clamped to `now` on sanitize (it orders the merge; a forged future
    /// stamp would outrank every honest write).
    pub password_ts: u64,
    /// Delay gate: None = unarmed/released, Some(0) = armed waiting, positive
    /// = unlock deadline. Readiness never clears the gate by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_until: Option<i64>,
    /// Wait fixed at arm time, retained across waiting/countdown transitions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_duration_ms: Option<i64>,
    /// Whole-gate LWW stamp. Zero is omitted to preserve legacy wire shapes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub delay_updated_at: u64,
    /// Random-text length; Some = armed, None = released or never configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub random_text_len: Option<u16>,
    /// Whole-gate LWW stamp, also binds challenges to one arm generation.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub random_text_updated_at: u64,
    /// Frozen Turkey session end (epoch ms) — also forces blocking on.
    pub frozen_until: Option<i64>,
    /// Recurring locked windows — active windows also force blocking on.
    pub schedules: Vec<ScheduleRule>,
    /// When `schedules` was last replaced (epoch ms; absent JSON = 0, but
    /// ALWAYS serialized). Only consulted by `merge_lock_states`. Clamped to
    /// `now` on sanitize: a forged future stamp would hold the list hostage
    /// under last-writer-wins.
    pub schedules_updated_at: u64,
    /// Additive category-scoped windows. `None` = an older peer with no
    /// capability; `Some(vec![])` = an intentional modern deletion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_schedules: Option<Vec<CategoryScheduleRule>>,
    /// Scoped-list LWW stamp, independent of legacy global schedules.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub category_schedules_updated_at: u64,
    /// Accountability-partner arm: 32 random bytes as 64 lowercase hex chars.
    /// None is a release when the additive operation is present; both fields
    /// absent means an older peer with no vote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner_arm_generation: Option<String>,
    /// Optional LWW stamp. Option preserves a present zero-valued vote while
    /// allowing legacy states to omit every partner field exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner_arm_updated_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockReason {
    Timer,
    Password,
    Delay,
    #[serde(rename = "random-text")]
    RandomText,
    Frozen,
    Schedule,
    Partner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    /// Separate from every lock-enforcement field; daemon enforcement never
    /// consults this relaxation signal.
    pub break_active: bool,
    pub break_started_at: Option<i64>,
    pub break_not_before: Option<i64>,
    pub break_ends_at: Option<i64>,
    /// Any source active: settings frozen, block-screen bypass hidden.
    pub settings_locked: bool,
    /// Frozen Turkey or an in-window schedule: blocking runs even if the
    /// master toggle is off, and stored overrides are ignored.
    pub force_blocking: bool,
    pub reasons: Vec<LockReason>,
    /// When the current lock fully ends; `None` = indefinite (password,
    /// partner, or an explicit-release delay/random-text gate armed) or
    /// nothing active.
    pub until: Option<i64>,
    /// New-gate status is omitted for legacy and released states, matching the
    /// extension's optional properties and preserving exact legacy results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ready: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub random_text_len: Option<u16>,
}

/// TS checks `if (state.passwordHash)` — JS truthiness, so an empty string is
/// NOT armed. `sanitize_lock_state` only ever admits 64-hex strings anyway.
fn password_armed(state: &LockState) -> bool {
    state
        .password_hash
        .as_deref()
        .is_some_and(|h| !h.is_empty())
}

/// Waiting, counting down, and ready are all armed delay operations.
pub(crate) fn armed_delay(state: &LockState) -> Option<(i64, i64)> {
    let until = state.delay_until?;
    let duration = state.delay_duration_ms?;
    if until < 0 || !(MIN_DELAY_LOCK_MS..=MAX_DELAY_LOCK_MS).contains(&duration) {
        return None;
    }
    Some((until, duration))
}

pub(crate) fn armed_random_text_length(state: &LockState) -> Option<u16> {
    state
        .random_text_len
        .filter(|len| (MIN_RANDOM_TEXT_LOCK_LENGTH..=MAX_RANDOM_TEXT_LOCK_LENGTH).contains(len))
}

pub(crate) fn armed_partner_generation(state: &LockState) -> Option<&str> {
    state
        .partner_arm_generation
        .as_deref()
        .filter(|generation| {
            generation.len() == 64
                && generation
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// A nullable end timestamp that is still in the future (strict `>`).
fn active(until: Option<i64>, now: i64) -> Option<i64> {
    until.filter(|&t| t > now)
}

/// Validated full break interval, including a pending delayed start. Invalid
/// or partial shapes are inert. Mirrors breakInterval in lock-math.ts.
fn break_interval(state: &LockState) -> Option<(i64, i64)> {
    let requested_at = state.break_started_at?;
    let ends_at = state.break_ends_at?;
    if requested_at <= 0 || ends_at <= 0 {
        return None;
    }
    if let Some(not_before) = state.break_not_before {
        if not_before <= 0 || not_before < requested_at {
            return None;
        }
    }
    let start = state.break_not_before.unwrap_or(requested_at);
    if ends_at <= start || ends_at - start > MAX_BREAK_MS {
        return None;
    }
    Some((start, ends_at))
}

/// Wall-clock-derived [start, re-block) interval; no timer/task owns truth.
pub fn active_break_interval(state: &LockState, now: i64) -> Option<(i64, i64)> {
    break_interval(state).filter(|&(start, end)| now >= start && now < end)
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

/// A rule pinned to `tz_offset_minutes` evaluates in that fixed zone;
/// `None`/out-of-machinable-range falls back to the caller's zone (legacy /
/// device-current — sanitize drops out-of-RANGE pins before this ever sees
/// them). Mirrors the pinned branch of `ruleDayStart` in lock-math.ts.
fn pinned_offset(r: &ScheduleRule) -> Option<FixedOffset> {
    r.tz_offset_minutes
        .and_then(|m| m.checked_mul(60))
        .and_then(FixedOffset::east_opt)
}

/// End (epoch ms) of the window under rule `r` containing `now_ms`, or None.
/// A containing window can only have started today or (overnight) yesterday
/// (today/yesterday in the rule's OWN tz frame when pinned: a pinned rule
/// ignores `tz`, so a device-zone change can't sidestep it, red-team #26).
fn rule_window_end<Tz: TimeZone>(r: &ScheduleRule, now_ms: i64, tz: &Tz) -> Option<i64> {
    // Heterogeneous dispatch: pinned rules use their own FixedOffset (no
    // DST — see the field's doc comment), legacy rules use the caller's zone.
    match pinned_offset(r) {
        Some(off) => rule_window_end_tz(r, now_ms, &off),
        None => rule_window_end_tz(r, now_ms, tz),
    }
}

fn rule_window_end_tz<Tz: TimeZone>(r: &ScheduleRule, now_ms: i64, tz: &Tz) -> Option<i64> {
    let dur = window_duration_ms(r);
    if dur <= 0 {
        return None;
    }
    for offset in [0, -1] {
        let Some(day_start) = local_midnight(tz, now_ms, offset) else {
            continue;
        };
        // Weekday of the resolved midnight instant — mirrors
        // `new Date(dayStart).getDay()` / the UTC-frame read in ruleDayStart.
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

pub fn current_category_window_end_in<Tz: TimeZone>(
    rules: &[CategoryScheduleRule],
    now_ms: i64,
    tz: &Tz,
) -> Option<i64> {
    rules
        .iter()
        .filter_map(|r| rule_window_end(&r.schedule, now_ms, tz))
        .max()
}

pub fn current_category_window_end(rules: &[CategoryScheduleRule], now_ms: i64) -> Option<i64> {
    current_category_window_end_in(rules, now_ms, &chrono::Local)
}

/// Next start-or-end instant strictly after `now` across all sources, or
/// None when nothing is pending. Drives the promptness-only boundary alarm.
pub fn next_boundary_in<Tz: TimeZone>(state: &LockState, now: i64, tz: &Tz) -> Option<i64> {
    let mut candidates: Vec<i64> = Vec::new();
    if let Some((start, end)) = break_interval(state) {
        if start > now {
            candidates.push(start);
        }
        if end > now {
            candidates.push(end);
        }
    }
    candidates.extend(active(state.timer_until, now));
    if let Some((until, _)) = armed_delay(state).filter(|(until, _)| *until > now) {
        candidates.push(until);
    }
    candidates.extend(active(state.frozen_until, now));
    let scoped_rules = state
        .category_schedules
        .iter()
        .flatten()
        .map(|r| &r.schedule);
    for r in state.schedules.iter().chain(scoped_rules) {
        // Per-rule zone dispatch — mirrors rule_window_end: a pinned rule's
        // boundaries are computed in its OWN fixed offset, legacy rules in
        // the caller's zone, so a mixed list works after a device tz change.
        match pinned_offset(r) {
            Some(off) => rule_boundaries_tz(r, now, &off, &mut candidates),
            None => rule_boundaries_tz(r, now, tz, &mut candidates),
        }
    }
    candidates.into_iter().min()
}

/// Push a rule's candidate boundary instants (mirrors the per-rule loop of
/// `nextBoundary` in lock-math.ts): from yesterday through a week ahead.
fn rule_boundaries_tz<Tz: TimeZone>(r: &ScheduleRule, now: i64, tz: &Tz, out: &mut Vec<i64>) {
    let dur = window_duration_ms(r);
    if dur <= 0 {
        return;
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
            out.push(start);
        }
        if start + dur > now {
            out.push(start + dur);
        }
    }
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
    let delay = armed_delay(state);
    if delay.is_some() {
        reasons.push(LockReason::Delay);
    }
    let random_text_len = armed_random_text_length(state);
    if random_text_len.is_some() {
        reasons.push(LockReason::RandomText);
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
    let partner_arm = armed_partner_generation(state);
    if partner_arm.is_some() {
        reasons.push(LockReason::Partner);
    }
    LockStatus {
        break_active: active_break_interval(state, now).is_some(),
        break_started_at: state.break_started_at,
        break_not_before: state.break_not_before,
        break_ends_at: state.break_ends_at,
        settings_locked: !reasons.is_empty(),
        force_blocking: window_end.is_some() || reasons.contains(&LockReason::Frozen),
        until: if password_armed(state)
            || delay.is_some()
            || random_text_len.is_some()
            || partner_arm.is_some()
        {
            None
        } else {
            ends.into_iter().max()
        },
        delay_until: delay.map(|(until, _)| until),
        delay_duration_ms: delay.map(|(_, duration)| duration),
        delay_ready: delay.map(|(until, _)| until > 0 && now >= until),
        random_text_len,
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

fn unique_category_labels(rules: &[&CategoryScheduleRule]) -> Vec<String> {
    let mut categories = Vec::new();
    for rule in rules {
        for category in &rule.categories {
            if !categories.contains(category) {
                categories.push(category.clone());
            }
        }
    }
    categories
}

/// Mirrors effectiveBlockScore + shouldBlockClassifierVerdict for this gate.
/// Only the top label selects rules; top-2 mass preserves confidence policy.
fn should_block_category_classifier_verdict(
    verdict: &CategoryScheduleVerdict,
    blocked_labels: &[String],
    block_threshold: f64,
) -> bool {
    if !blocked_labels.contains(&verdict.label) {
        return false;
    }
    let mut effective_score = verdict.score;
    if verdict.label.starts_with("neutral: ") {
        effective_score = 0.0;
    } else if let Some(all) = &verdict.all {
        if all.labels.len() >= 2 && all.scores.len() >= 2 && blocked_labels.contains(&all.labels[1])
        {
            effective_score = (all.scores[0] + all.scores[1]).min(1.0);
        }
    }
    effective_score >= block_threshold
}

/// Apply scoped schedules to a normal classifier decision. Deterministic
/// rules, global forced locks, master/break/allowance state, and classifier
/// errors remain caller responsibilities. Active matching rules take
/// precedence, even below threshold; otherwise a configured rule rescues the
/// normal classifier block. Labels absent from every rule remain unchanged.
pub fn evaluate_category_schedule_gate_in<Tz: TimeZone>(
    verdict: &CategoryScheduleVerdict,
    normally_blocked: bool,
    block_threshold: f64,
    rules: &[CategoryScheduleRule],
    now_ms: i64,
    tz: &Tz,
) -> CategoryScheduleGateResult {
    let configured_rules: Vec<_> = rules
        .iter()
        .filter(|rule| rule.categories.contains(&verdict.label))
        .collect();
    if configured_rules.is_empty() {
        return CategoryScheduleGateResult {
            blocked: normally_blocked,
            effect: CategoryScheduleEffect::None,
            categories: Vec::new(),
        };
    }

    // Reuse the established window engine, including pinned offsets and
    // overnight start-day behavior, rather than creating a second time path.
    let active_rules: Vec<_> = rules
        .iter()
        .filter(|rule| {
            current_window_end_in(std::slice::from_ref(&rule.schedule), now_ms, tz).is_some()
        })
        .collect();
    if active_rules
        .iter()
        .any(|rule| rule.categories.contains(&verdict.label))
    {
        let categories = unique_category_labels(&active_rules);
        let active_blocked =
            should_block_category_classifier_verdict(verdict, &categories, block_threshold);
        return CategoryScheduleGateResult {
            blocked: normally_blocked || active_blocked,
            effect: CategoryScheduleEffect::ActiveBlock,
            categories,
        };
    }

    CategoryScheduleGateResult {
        blocked: false,
        effect: CategoryScheduleEffect::InactiveRescue,
        categories: unique_category_labels(&configured_rules),
    }
}

pub fn evaluate_category_schedule_gate(
    verdict: &CategoryScheduleVerdict,
    normally_blocked: bool,
    block_threshold: f64,
    rules: &[CategoryScheduleRule],
    now_ms: i64,
) -> CategoryScheduleGateResult {
    evaluate_category_schedule_gate_in(
        verdict,
        normally_blocked,
        block_threshold,
        rules,
        now_ms,
        &chrono::Local,
    )
}

/// Returns a human-readable problem, or None when the rule is valid.
/// Integrality/negativity is enforced by the field types (serde rejects
/// non-integers before wire input ever reaches this); ranges match the TS.
/// The tz-pin bounds are the real-world extrema (UTC−12:00 … UTC+14:00),
/// mirrored by `validateScheduleRule` in lock-math.ts — both sanitize paths
/// drop rules failing ANY of these checks.
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
    if let Some(m) = r.tz_offset_minutes {
        if !(-720..=840).contains(&m) {
            return Some("Timezone offset must be between UTC−12:00 and UTC+14:00.");
        }
    }
    // JavaScript's String.length counts UTF-16 code units, not UTF-8 bytes.
    if r.tz_name
        .as_deref()
        .is_some_and(|n| n.encode_utf16().count() > 64)
    {
        return Some("Timezone name must be a short string.");
    }
    None
}

/// Category checks run after the exact base-window validator. JavaScript's
/// string length counts UTF-16 code units, so encode_utf16 preserves that
/// boundary for non-ASCII labels as well as the ordinary ASCII case.
pub fn validate_category_schedule_rule(r: &CategoryScheduleRule) -> Option<&'static str> {
    if let Some(problem) = validate_schedule_rule(&r.schedule) {
        return Some(problem);
    }
    if r.categories.is_empty() {
        return Some("Pick at least one category.");
    }
    if r.categories.len() > 64 {
        return Some("Choose no more than 64 categories.");
    }
    for (index, category) in r.categories.iter().enumerate() {
        if category.is_empty() || category.encode_utf16().count() > 64 {
            return Some("Categories must be nonempty strings of at most 64 characters.");
        }
        if category.trim() != category {
            return Some("Categories cannot have leading or trailing whitespace.");
        }
        if r.categories[..index].contains(category) {
            return Some("Categories must be unique.");
        }
    }
    None
}

/// Coerce untrusted input (the extension talks over Native Messaging) into a
/// well-formed LockState: wrong types dropped, invalid rules dropped, end
/// timestamps clamped to `now + max_lock_ms` so a bad peer cannot lock
/// forever. The two metadata stamps (`passwordTs`, `schedulesUpdatedAt`) are
/// clamped to `now` — they order last-writer-wins merges, so a forged FUTURE
/// stamp must never be admitted: it would outrank every honest write until
/// that date arrived. Unlike the TS (which passes rule objects through by
/// reference), re-deserializing strips unknown extra properties from rules —
/// the wire shape is `ScheduleRule` either way.
pub fn sanitize_lock_state(raw: &Value, now: i64, max_lock_ms: i64) -> LockState {
    let cap = now + max_lock_ms;
    // Merge-ordering metadata: never admit a stamp from the future.
    let stamp = |key: &str| -> u64 {
        // Match Number.isSafeInteger: fractions never truncate into a valid
        // merge-ordering stamp, and unsafe JSON integers stay neutral too.
        let now = u64::try_from(now).unwrap_or(0).min(MAX_SAFE_TIMESTAMP_MS);
        raw.get(key)
            .and_then(Value::as_f64)
            .filter(|n| {
                n.is_finite() && *n > 0.0 && n.fract() == 0.0 && *n <= MAX_SAFE_TIMESTAMP_MS as f64
            })
            .map(|n| n.min(now as f64) as u64)
            .unwrap_or(0)
    };
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
    let category_schedules = raw
        .get("categorySchedules")
        .and_then(Value::as_array)
        .and_then(|arr| {
            // All-or-neutral: a malformed scoped list is not an empty delete.
            arr.iter()
                .map(|value| {
                    serde_json::from_value::<CategoryScheduleRule>(value.clone())
                        .ok()
                        .filter(|rule| validate_category_schedule_rule(rule).is_none())
                })
                .collect::<Option<Vec<_>>>()
                .and_then(|rules| {
                    // Duplicate identities make canonical merge results depend
                    // on list position; reject the whole additive update.
                    let mut ids = std::collections::BTreeSet::new();
                    if rules
                        .iter()
                        .all(|rule| ids.insert(rule.schedule.id.clone()))
                    {
                        Some(rules)
                    } else {
                        None
                    }
                })
        });
    let break_cap = now + MAX_BREAK_MS;
    let break_timestamp = |key: &str| -> Option<i64> {
        let n = raw.get(key)?.as_f64()?;
        if n > 0.0 {
            Some(n.min(break_cap as f64) as i64)
        } else {
            None
        }
    };
    let started_at = match stamp("breakStartedAt") {
        0 => None,
        n => Some(n as i64),
    };
    let not_before = break_timestamp("breakNotBefore");
    let ends_at = break_timestamp("breakEndsAt");
    let break_candidate = LockState {
        break_started_at: started_at,
        break_not_before: not_before,
        break_ends_at: ends_at,
        ..LockState::default()
    };
    let valid_break = break_interval(&break_candidate).is_some();

    // New gates are all-or-neutral: malformed active shapes are dropped, never
    // turned into newer release tombstones. Stamp-only is a valid release
    // because serialization omits null gate fields on the wire.
    let has_delay = ["delayUntil", "delayDurationMs", "delayUpdatedAt"]
        .iter()
        .any(|key| raw.get(key).is_some());
    let delay_duration = raw
        .get("delayDurationMs")
        .and_then(Value::as_i64)
        .filter(|n| (MIN_DELAY_LOCK_MS..=MAX_DELAY_LOCK_MS).contains(n));
    let delay_released = raw.get("delayUntil").is_none_or(Value::is_null)
        && raw.get("delayDurationMs").is_none_or(Value::is_null);
    let (delay_until, delay_duration_ms, delay_updated_at) = if !has_delay {
        (None, None, 0)
    } else if delay_released {
        (None, None, stamp("delayUpdatedAt"))
    } else if let Some(duration) = delay_duration {
        match raw.get("delayUntil").and_then(Value::as_f64) {
            Some(0.0) => (Some(0), Some(duration), stamp("delayUpdatedAt")),
            Some(n) if n > 0.0 => (
                Some(n.min((now + MAX_DELAY_LOCK_MS) as f64) as i64),
                Some(duration),
                stamp("delayUpdatedAt"),
            ),
            _ => (None, None, 0),
        }
    } else {
        (None, None, 0)
    };

    let has_random = ["randomTextLen", "randomTextUpdatedAt"]
        .iter()
        .any(|key| raw.get(key).is_some());
    let random_released = raw.get("randomTextLen").is_none_or(Value::is_null);
    let random_len = raw
        .get("randomTextLen")
        .and_then(Value::as_u64)
        .filter(|n| {
            *n >= u64::from(MIN_RANDOM_TEXT_LOCK_LENGTH)
                && *n <= u64::from(MAX_RANDOM_TEXT_LOCK_LENGTH)
        })
        .map(|n| n as u16);
    let (random_text_len, random_text_updated_at) = if !has_random {
        (None, 0)
    } else if random_released {
        (None, stamp("randomTextUpdatedAt"))
    } else if random_len.is_some() {
        (random_len, stamp("randomTextUpdatedAt"))
    } else {
        (None, 0)
    };

    let has_partner = ["partnerArmGeneration", "partnerArmUpdatedAt"]
        .iter()
        .any(|key| raw.get(key).is_some());
    let partner_released = raw.get("partnerArmGeneration").is_none_or(Value::is_null);
    let partner_generation = raw
        .get("partnerArmGeneration")
        .and_then(Value::as_str)
        .filter(|generation| {
            generation.len() == 64
                && generation
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        });
    let (partner_arm_generation, partner_arm_updated_at) = if !has_partner {
        (None, None)
    } else if partner_released {
        (None, Some(stamp("partnerArmUpdatedAt")))
    } else if let Some(generation) = partner_generation {
        (
            Some(generation.to_owned()),
            Some(stamp("partnerArmUpdatedAt")),
        )
    } else {
        // A malformed active arm is neutral, never a fresh release tombstone.
        (None, None)
    };

    LockState {
        break_started_at: if valid_break { started_at } else { None },
        break_not_before: if valid_break { not_before } else { None },
        break_ends_at: if valid_break { ends_at } else { None },
        break_updated_at: stamp("breakUpdatedAt"),
        timer_until: until("timerUntil"),
        password_hash: raw
            .get("passwordHash")
            .and_then(Value::as_str)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            .map(str::to_owned),
        password_ts: stamp("passwordTs"),
        delay_until,
        delay_duration_ms,
        delay_updated_at,
        random_text_len,
        random_text_updated_at,
        frozen_until: until("frozenUntil"),
        schedules,
        schedules_updated_at: stamp("schedulesUpdatedAt"),
        category_schedules_updated_at: if category_schedules.is_some() {
            stamp("categorySchedulesUpdatedAt")
        } else {
            0
        },
        category_schedules,
        partner_arm_generation,
        partner_arm_updated_at,
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
            tz_offset_minutes: None,
            tz_name: None,
        }
    }

    /// Same rule pinned to a fixed offset (minutes EAST of UTC).
    fn pinned(id: &str, days: &[u8], start: u16, end: u16, off: i32) -> ScheduleRule {
        ScheduleRule {
            tz_offset_minutes: Some(off),
            tz_name: Some("Test/Zone".into()),
            ..rule(id, days, start, end)
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
    fn pinned_rule_evaluates_in_its_own_offset_not_the_machines() {
        // Red-team #26: a rule pinned at creation must not move when the
        // device timezone changes. Simulate by evaluating against a host
        // zone (UTC) that differs from the rule's pinned offset (IST,
        // UTC+05:30 — itself a no-DST zone, so no residual applies to it).
        let utc = FixedOffset::east_opt(0).unwrap();
        let ist_rule = pinned("wd-ist", &[1, 2, 3, 4, 5], 9 * 60, 17 * 60, 330);
        let rules = std::slice::from_ref(&ist_rule);
        // Wed 12:00 UTC = 17:30 in UTC+05:30: outside the pinned window...
        let now = at(&utc, 8, 12, 0);
        assert!(!is_in_schedule_window_in(rules, now, &utc));
        // ...but a legacy (unpinned) copy of the same rule IS active — it
        // follows the machine's current zone, the pre-#26 behavior.
        assert!(is_in_schedule_window_in(&[workdays()], now, &utc));
        // Wed 11:00 UTC = 16:30 IST: inside the pinned window, ending at
        // 17:00 IST = 11:30 UTC (the pinned zone's civil time).
        let inside = at(&utc, 8, 11, 0);
        assert!(is_in_schedule_window_in(rules, inside, &utc));
        assert_eq!(
            current_window_end_in(rules, inside, &utc),
            Some(at(&utc, 8, 11, 30))
        );
        // A pinned rule ignores the host zone entirely: same answer when the
        // machine zone happens to match the pin.
        let ist = FixedOffset::east_opt(5 * 3600 + 1800).unwrap();
        assert!(is_in_schedule_window_in(rules, inside, &ist));
    }

    #[test]
    fn fixed_offset_pin_documents_the_dst_residual() {
        // The SAME civil schedule authored on winter (-300 min) vs summer
        // (-240 min) time: a fixed offset cannot follow the DST change, so
        // the two pins fire exactly one hour apart — forever. This test pins
        // the residual down deliberately; see the field docs.
        let utc = FixedOffset::east_opt(0).unwrap();
        let winter = pinned("et-win", &[1, 2, 3, 4, 5], 9 * 60, 10 * 60, -300);
        let summer = pinned("et-sum", &[1, 2, 3, 4, 5], 9 * 60, 10 * 60, -240);
        // Wed 13:30 UTC: the summer pin's 09:00 window is 30 minutes in
        // (13:00 UTC); the winter pin's window opens at 14:00 UTC.
        let now = at(&utc, 8, 13, 30);
        assert!(!is_in_schedule_window_in(&[winter], now, &utc));
        assert!(is_in_schedule_window_in(&[summer], now, &utc));
    }

    #[test]
    fn next_boundary_uses_the_rules_own_offset() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let ist_rule = pinned("wd-ist", &[1, 2, 3, 4, 5], 9 * 60, 17 * 60, 330);
        let state = schedules_state(vec![ist_rule]);
        // Wed 12:00 UTC = 17:30 IST (today's window over): next boundary is
        // Thursday 09:00 IST = 03:30 UTC, not anything in the host zone.
        assert_eq!(
            next_boundary_in(&state, at(&utc, 8, 12, 0), &utc),
            Some(at(&utc, 9, 3, 30))
        );
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
        // tz pins: real-world extrema accepted, beyond rejected (mirrors TS).
        assert_eq!(
            validate_schedule_rule(&pinned("x", &[1], 540, 1020, -720)),
            None
        );
        assert_eq!(
            validate_schedule_rule(&pinned("x", &[1], 540, 1020, 840)),
            None
        );
        assert!(validate_schedule_rule(&pinned("x", &[1], 540, 1020, -721)).is_some());
        assert!(validate_schedule_rule(&pinned("x", &[1], 540, 1020, 841)).is_some());
        // tz name is display-only but bounded.
        let mut long_name = pinned("x", &[1], 540, 1020, 0);
        long_name.tz_name = Some("z".repeat(65));
        assert!(validate_schedule_rule(&long_name).is_some());
    }

    #[test]
    fn schedule_rule_tz_fields_default_absent_and_roundtrip() {
        // Legacy JSON (no tz fields at all) deserializes unpinned, then
        // serializes with explicit nulls — the TS side passes rule objects
        // through by reference either way.
        let parsed: ScheduleRule = serde_json::from_value(json!({
            "id": "r", "days": [1], "startMinutes": 540, "endMinutes": 1020
        }))
        .unwrap();
        assert_eq!(parsed.tz_offset_minutes, None);
        assert_eq!(parsed.tz_name, None);
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            json!({
                "id": "r", "days": [1], "startMinutes": 540, "endMinutes": 1020,
                "tzOffsetMinutes": null, "tzName": null
            })
        );
        assert_eq!(
            serde_json::to_value(pinned("r", &[1], 540, 1020, 330)).unwrap(),
            json!({
                "id": "r", "days": [1], "startMinutes": 540, "endMinutes": 1020,
                "tzOffsetMinutes": 330, "tzName": "Test/Zone"
            })
        );
    }

    #[test]
    fn lock_state_serializes_explicit_nulls_and_updated_at() {
        // The TS side writes explicit nulls; the stamps are always present on
        // output even though absent input defaults to 0.
        assert_eq!(
            serde_json::to_value(LockState::default()).unwrap(),
            json!({
                "timerUntil": null,
                "passwordHash": null,
                "passwordTs": 0,
                "breakStartedAt": null,
                "breakNotBefore": null,
                "breakEndsAt": null,
                "breakUpdatedAt": 0,
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
            break_active: false,
            break_started_at: None,
            break_not_before: None,
            break_ends_at: None,
            settings_locked: true,
            force_blocking: true,
            reasons: vec![
                LockReason::Timer,
                LockReason::Password,
                LockReason::Frozen,
                LockReason::Schedule,
            ],
            until: None,
            delay_until: None,
            delay_duration_ms: None,
            delay_ready: None,
            random_text_len: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "breakActive": false,
                "breakStartedAt": null,
                "breakNotBefore": null,
                "breakEndsAt": null,
                "settingsLocked": true,
                "forceBlocking": true,
                "reasons": ["timer", "password", "frozen", "schedule"],
                "until": null
            })
        );
    }

    #[test]
    fn sanitize_drops_rules_with_out_of_range_tz_pins() {
        // Out-of-range pins and non-integer offsets are untrusted garbage:
        // the rule is dropped, mirroring the TS validate-before-keep filter.
        let state = sanitize_lock_state(
            &json!({
                "schedules": [
                    { "id": "ok", "days": [1], "startMinutes": 540, "endMinutes": 1020, "tzOffsetMinutes": -300, "tzName": "America/New_York" },
                    { "id": "too-far", "days": [1], "startMinutes": 540, "endMinutes": 1020, "tzOffsetMinutes": 9999 },
                    { "id": "float", "days": [1], "startMinutes": 540, "endMinutes": 1020, "tzOffsetMinutes": 330.5 },
                    { "id": "bad-name", "days": [1], "startMinutes": 540, "endMinutes": 1020, "tzName": 42 }
                ]
            }),
            1_000_000,
            2_592_000_000,
        );
        assert_eq!(state.schedules.len(), 1);
        assert_eq!(state.schedules[0].id, "ok");
        assert_eq!(state.schedules[0].tz_offset_minutes, Some(-300));
        assert_eq!(
            state.schedules[0].tz_name.as_deref(),
            Some("America/New_York")
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

    fn scoped(schedule: ScheduleRule, categories: &[&str]) -> CategoryScheduleRule {
        CategoryScheduleRule {
            schedule,
            categories: categories
                .iter()
                .map(|category| (*category).into())
                .collect(),
        }
    }

    fn category_verdict(label: &str, score: f64) -> CategoryScheduleVerdict {
        CategoryScheduleVerdict {
            label: label.into(),
            score,
            all: None,
        }
    }

    #[test]
    fn category_schedule_validation_matches_ts() {
        let valid = scoped(workdays(), &["video games"]);
        assert_eq!(validate_category_schedule_rule(&valid), None);
        assert_eq!(validate_schedule_rule(&valid.schedule), None);
        assert_eq!(
            validate_category_schedule_rule(&scoped(workdays(), &[])),
            Some("Pick at least one category.")
        );

        let maximum: Vec<String> = (0..64).map(|index| format!("category {index}")).collect();
        let mut maximum_rule = CategoryScheduleRule {
            schedule: workdays(),
            categories: maximum,
        };
        assert_eq!(validate_category_schedule_rule(&maximum_rule), None);
        maximum_rule.categories.push("overflow".into());
        assert_eq!(
            validate_category_schedule_rule(&maximum_rule),
            Some("Choose no more than 64 categories.")
        );

        assert_eq!(
            validate_category_schedule_rule(&scoped(workdays(), &["a".repeat(64).as_str()])),
            None
        );
        assert_eq!(
            validate_category_schedule_rule(&scoped(workdays(), &["a".repeat(65).as_str()])),
            Some("Categories must be nonempty strings of at most 64 characters.")
        );
        assert!(validate_category_schedule_rule(&scoped(workdays(), &[""])).is_some());
        for category in [" games", "games ", "   ", "\tgames"] {
            assert_eq!(
                validate_category_schedule_rule(&scoped(workdays(), &[category])),
                Some("Categories cannot have leading or trailing whitespace.")
            );
        }
        assert_eq!(
            validate_category_schedule_rule(&scoped(workdays(), &["games", "games"])),
            Some("Categories must be unique.")
        );
        assert_eq!(
            validate_category_schedule_rule(&scoped(workdays(), &["games", "Games"])),
            None
        );

        let mut invalid_base = scoped(workdays(), &[]);
        invalid_base.schedule.days.clear();
        assert_eq!(
            validate_category_schedule_rule(&invalid_base),
            Some("Pick at least one day.")
        );
    }

    #[test]
    fn category_schedule_rule_flattens_exact_schedule_json() {
        let scoped = scoped(
            pinned("scoped", &[1, 2, 3], 540, 1020, 330),
            &["video games", "online shopping"],
        );
        let wire = json!({
            "id": "scoped",
            "days": [1, 2, 3],
            "startMinutes": 540,
            "endMinutes": 1020,
            "tzOffsetMinutes": 330,
            "tzName": "Test/Zone",
            "categories": ["video games", "online shopping"]
        });
        assert_eq!(serde_json::to_value(&scoped).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<CategoryScheduleRule>(wire).unwrap(),
            scoped
        );
        assert!(serde_json::to_value(&scoped)
            .unwrap()
            .get("schedule")
            .is_none());
    }

    #[test]
    fn category_schedule_active_precedence_and_inactive_rescue() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let active = scoped(workdays(), &["video games"]);
        let inactive = scoped(
            rule("inactive", &[1, 2, 3, 4, 5], 13 * 60, 14 * 60),
            &["video games"],
        );
        let rules = vec![inactive, active];
        let now = at(&utc, 8, 12, 0);

        let active_result = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.9),
            false,
            0.5,
            &rules,
            now,
            &utc,
        );
        assert!(active_result.blocked);
        assert_eq!(active_result.effect, CategoryScheduleEffect::ActiveBlock);
        assert_eq!(active_result.categories, vec!["video games"]);

        // Active same-category precedence applies even when confidence cannot
        // block: this must not fall through to the other rule as a rescue.
        let low_confidence = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.4),
            false,
            0.5,
            &rules,
            now,
            &utc,
        );
        assert!(!low_confidence.blocked);
        assert_eq!(low_confidence.effect, CategoryScheduleEffect::ActiveBlock);

        let normal_block = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.4),
            true,
            0.5,
            &rules,
            now,
            &utc,
        );
        assert!(normal_block.blocked);
        assert_eq!(normal_block.effect, CategoryScheduleEffect::ActiveBlock);

        let rescue = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.9),
            true,
            0.5,
            &rules,
            at(&utc, 8, 18, 0),
            &utc,
        );
        assert!(!rescue.blocked);
        assert_eq!(rescue.effect, CategoryScheduleEffect::InactiveRescue);
        assert_eq!(rescue.categories, vec!["video games"]);
    }

    #[test]
    fn category_schedule_uses_complete_active_set_for_top_two_mass() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let mut split = category_verdict("video games", 0.4);
        split.all = Some(CategoryScheduleScores {
            labels: vec![
                "video games".into(),
                "online shopping".into(),
                "music".into(),
            ],
            scores: vec![0.4, 0.3, 0.3],
        });
        let games = scoped(workdays(), &["video games"]);
        let shopping = scoped(
            rule("shopping", &[1, 2, 3, 4, 5], 540, 1020),
            &["online shopping"],
        );
        let rules = vec![games.clone(), shopping];
        let now = at(&utc, 8, 12, 0);
        let combined = evaluate_category_schedule_gate_in(&split, false, 0.6, &rules, now, &utc);
        assert!(combined.blocked);
        assert_eq!(combined.categories, vec!["video games", "online shopping"]);

        // The top label is still active, but an inactive runner-up is not in
        // the complete ACTIVE set, so its probability mass cannot be added.
        let inactive_shopping = scoped(
            rule("shopping", &[1, 2, 3, 4, 5], 13 * 60, 14 * 60),
            &["online shopping"],
        );
        let top_one_only = evaluate_category_schedule_gate_in(
            &split,
            false,
            0.6,
            &[games, inactive_shopping],
            now,
            &utc,
        );
        assert!(!top_one_only.blocked);
        assert_eq!(top_one_only.effect, CategoryScheduleEffect::ActiveBlock);
        assert_eq!(top_one_only.categories, vec!["video games"]);

        let unrelated = evaluate_category_schedule_gate_in(
            &category_verdict("music", 0.99),
            true,
            0.5,
            &rules,
            now,
            &utc,
        );
        assert_eq!(
            unrelated,
            CategoryScheduleGateResult {
                blocked: true,
                effect: CategoryScheduleEffect::None,
                categories: vec![],
            }
        );
    }

    #[test]
    fn category_schedule_reuses_overnight_and_pinned_windows() {
        let utc = FixedOffset::east_opt(0).unwrap();
        let overnight = scoped(mon_overnight(), &["video games"]);
        let active = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.9),
            false,
            0.5,
            std::slice::from_ref(&overnight),
            at(&utc, 7, 3, 0),
            &utc,
        );
        assert!(active.blocked);
        let ended = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.9),
            true,
            0.5,
            &[overnight],
            at(&utc, 7, 6, 0),
            &utc,
        );
        assert_eq!(ended.effect, CategoryScheduleEffect::InactiveRescue);
        assert!(!ended.blocked);

        let ist = scoped(
            pinned("ist", &[1, 2, 3, 4, 5], 540, 1020, 330),
            &["video games"],
        );
        // Wed 11:00 UTC = 16:30 IST, inside the pinned 09:00–17:00 rule.
        let pinned_result = evaluate_category_schedule_gate_in(
            &category_verdict("video games", 0.9),
            false,
            0.5,
            &[ist],
            at(&utc, 8, 11, 0),
            &utc,
        );
        assert!(pinned_result.blocked);
    }
}
