//! Pure per-category allowance/opening/Pomodoro accounting and the bounded
//! authority-command boundary. Mirrors `src/shared/allowance-math.ts` and
//! `src/shared/allowance-state.ts`; change all three together.
//!
//! The owner supplies epoch milliseconds and a local `YYYY-MM-DD` day key.
//! This module deliberately has no clock, timezone, storage, daemon, or IPC
//! dependency. Every transition returns a cloned next value and never mutates
//! its input. Persisted ledgers stay raw at the authority boundary until an
//! observation, matching the TypeScript reducer's sanitization boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

pub const ALLOWANCE_LEDGER_VERSION: u64 = 1;
pub const ALLOWANCE_STATE_VERSION: u64 = 1;
pub const MAX_ALLOWANCE_TIMESTAMP_MS: u64 = 9_007_199_254_740_991;
pub const MAX_ALLOWANCE_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
pub const MAX_DAILY_OPENINGS: u64 = 10_000;
pub const MAX_ALLOWANCE_CATEGORIES: usize = 64;
pub const MAX_ALLOWANCE_RECEIPTS: usize = 64;
pub const DEFAULT_OPENING_INACTIVITY_MS: u64 = 120_000;
pub const DEFAULT_OPENING_MAX_LIFETIME_MS: u64 = 30 * 60 * 1_000;
/// Bounded productive-work reward defaults: 5 focused minutes -> 1 minute.
pub const DEFAULT_REWARD_WORK_MS: u64 = 5 * 60 * 1_000;
pub const DEFAULT_REWARD_AWARD_MS: u64 = 60 * 1_000;
pub const MIN_REWARD_RATIO_MS: u64 = 60 * 1_000;
const EMPTY_DAY_KEY: &str = "1970-01-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AllowanceGrantKind {
    Allowance,
    Opening,
    Pomodoro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllowanceGrantStatus {
    Pending,
    Active,
    Ended,
    IdleClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllowanceGrantEndReason {
    WaitingCancelled,
    EarlyCancelled,
    Expired,
    Idle,
    Explicit,
    MaxLifetime,
}

/// JavaScript-number command/config input. Reducers validate and normalize it
/// before it reaches any persisted `u64` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct AllowanceConfig {
    pub daily_allowance_ms: f64,
    pub daily_openings: f64,
    pub waiting_base_ms: f64,
    pub waiting_step_ms: f64,
    pub waiting_max_ms: f64,
    pub reward_cap_ms: f64,
    pub reward_earning: bool,
    pub reward_work_ms: f64,
    pub reward_award_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_inactivity_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_max_lifetime_ms: Option<f64>,
}

impl Default for AllowanceConfig {
    fn default() -> Self {
        Self {
            daily_allowance_ms: 0.0,
            daily_openings: 0.0,
            waiting_base_ms: 0.0,
            waiting_step_ms: 0.0,
            waiting_max_ms: 0.0,
            reward_cap_ms: 0.0,
            reward_earning: false,
            reward_work_ms: DEFAULT_REWARD_WORK_MS as f64,
            reward_award_ms: DEFAULT_REWARD_AWARD_MS as f64,
            opening_inactivity_ms: None,
            opening_max_lifetime_ms: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedAllowanceConfig {
    pub daily_allowance_ms: u64,
    pub daily_openings: u64,
    pub waiting_base_ms: u64,
    pub waiting_step_ms: u64,
    pub waiting_max_ms: u64,
    pub reward_cap_ms: u64,
    pub reward_earning: bool,
    pub reward_work_ms: u64,
    pub reward_award_ms: u64,
    pub opening_inactivity_ms: u64,
    pub opening_max_lifetime_ms: u64,
}

pub const DEFAULT_ALLOWANCE_CONFIG: NormalizedAllowanceConfig = NormalizedAllowanceConfig {
    daily_allowance_ms: 0,
    daily_openings: 0,
    waiting_base_ms: 0,
    waiting_step_ms: 0,
    waiting_max_ms: 0,
    reward_cap_ms: 0,
    reward_earning: false,
    reward_work_ms: DEFAULT_REWARD_WORK_MS,
    reward_award_ms: DEFAULT_REWARD_AWARD_MS,
    opening_inactivity_ms: DEFAULT_OPENING_INACTIVITY_MS,
    opening_max_lifetime_ms: DEFAULT_OPENING_MAX_LIFETIME_MS,
};

impl Default for NormalizedAllowanceConfig {
    fn default() -> Self {
        DEFAULT_ALLOWANCE_CONFIG
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceGrant {
    pub id: String,
    pub kind: AllowanceGrantKind,
    pub status: AllowanceGrantStatus,
    pub requested_at_ms: u64,
    pub not_before_ms: u64,
    pub ends_at_ms: u64,
    pub duration_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub end_reason: Option<AllowanceGrantEndReason>,
    pub charged_ms: u64,
    pub refunded_ms: u64,
    pub last_activity_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceLedger {
    pub version: u64,
    pub day_key: String,
    pub spent_ms: u64,
    pub earned_reward_ms: u64,
    pub openings_used: u64,
    pub waiting_escalation: u64,
    pub last_observed_at_ms: u64,
    pub grant: Option<AllowanceGrant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowanceObservation {
    pub now_ms: f64,
    pub day_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowanceGrantAction {
    pub grant_id: String,
    pub now_ms: f64,
    pub day_key: String,
}

impl AllowanceGrantAction {
    fn observation(&self) -> AllowanceObservation {
        AllowanceObservation {
            now_ms: self.now_ms,
            day_key: self.day_key.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowanceRequest {
    pub grant_id: String,
    pub now_ms: f64,
    pub day_key: String,
    pub duration_ms: f64,
}

impl AllowanceRequest {
    fn observation(&self) -> AllowanceObservation {
        AllowanceObservation {
            now_ms: self.now_ms,
            day_key: self.day_key.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RewardAddition {
    pub now_ms: f64,
    pub day_key: String,
    pub earned_ms: f64,
}

impl RewardAddition {
    fn observation(&self) -> AllowanceObservation {
        AllowanceObservation {
            now_ms: self.now_ms,
            day_key: self.day_key.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllowanceRefusalReason {
    InvalidTime,
    InvalidDay,
    ClockRollback,
    DayRollback,
    InvalidGrantId,
    InvalidDuration,
    InvalidReward,
    TimeOverflow,
    Overlap,
    AllowanceExhausted,
    NoOpenings,
    GrantNotFound,
    WrongGrantKind,
    GrantEnded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceResult {
    pub ok: bool,
    pub ledger: AllowanceLedger,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<AllowanceGrant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<AllowanceRefusalReason>,
}

impl AllowanceResult {
    fn success(ledger: AllowanceLedger) -> Self {
        Self {
            ok: true,
            grant: ledger.grant.clone(),
            ledger,
            reason: None,
        }
    }

    fn refusal(ledger: AllowanceLedger, reason: AllowanceRefusalReason) -> Self {
        Self {
            ok: false,
            ledger,
            grant: None,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedAllowance {
    pub day_key: String,
    pub now_ms: u64,
    pub total_allowance_ms: u64,
    pub consumed_ms: u64,
    pub active_elapsed_ms: u64,
    pub reserved_ms: u64,
    pub remaining_ms: u64,
    pub available_ms: u64,
    pub earned_reward_ms: u64,
    pub openings_used: u64,
    pub openings_remaining: u64,
    pub waiting_escalation: u64,
    pub next_waiting_delay_ms: u64,
    pub grant: Option<AllowanceGrant>,
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|v| v.is_finite())
}

fn raw_timestamp(value: Option<&Value>) -> Option<u64> {
    finite_number(value).and_then(timestamp)
}

fn timestamp(value: f64) -> Option<u64> {
    (value.is_finite()
        && value.fract() == 0.0
        && value >= 0.0
        && value <= MAX_ALLOWANCE_TIMESTAMP_MS as f64)
        .then_some(value as u64)
}

fn bounded_integer(value: Option<f64>, maximum: u64, fallback: u64) -> u64 {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return fallback;
    };
    if value <= 0.0 {
        0
    } else if value >= maximum as f64 {
        maximum
    } else {
        value.floor() as u64
    }
}

fn clean_duration(value: Option<f64>, fallback: u64) -> u64 {
    bounded_integer(value, MAX_ALLOWANCE_DURATION_MS, fallback)
}

fn clean_opening_duration(value: Option<f64>, fallback: u64) -> u64 {
    match value {
        Some(value) if value.is_finite() && value > 0.0 => clean_duration(Some(value), 0).max(1),
        _ => fallback,
    }
}

fn clean_reward_duration(value: Option<f64>, fallback: u64) -> u64 {
    match value {
        Some(value) if value.is_finite() && value > 0.0 => {
            bounded_integer(Some(value), MAX_ALLOWANCE_DURATION_MS, fallback)
                .max(MIN_REWARD_RATIO_MS)
        }
        _ => fallback,
    }
}

fn normalize_config_values(
    values: [Option<f64>; 10],
    reward_earning: bool,
) -> NormalizedAllowanceConfig {
    let reward_work_ms = clean_reward_duration(values[6], DEFAULT_REWARD_WORK_MS);
    let reward_award_ms =
        clean_reward_duration(values[7], DEFAULT_REWARD_AWARD_MS).min(reward_work_ms);
    NormalizedAllowanceConfig {
        daily_allowance_ms: clean_duration(values[0], 0),
        daily_openings: bounded_integer(values[1], MAX_DAILY_OPENINGS, 0),
        waiting_base_ms: clean_duration(values[2], 0),
        waiting_step_ms: clean_duration(values[3], 0),
        waiting_max_ms: clean_duration(values[4], 0),
        reward_cap_ms: clean_duration(values[5], 0),
        reward_earning,
        reward_work_ms,
        reward_award_ms,
        opening_inactivity_ms: clean_opening_duration(values[8], DEFAULT_OPENING_INACTIVITY_MS),
        opening_max_lifetime_ms: clean_opening_duration(values[9], DEFAULT_OPENING_MAX_LIFETIME_MS),
    }
}

/// Source accepted by the math API: raw persistence (`Value`), command config,
/// or an already normalized config. This keeps malformed persistence handling
/// available without forcing valid callers through JSON serialization.
pub trait AllowanceConfigSource {
    fn normalized(&self) -> NormalizedAllowanceConfig;
}

impl AllowanceConfigSource for Value {
    fn normalized(&self) -> NormalizedAllowanceConfig {
        const KEYS: [&str; 10] = [
            "dailyAllowanceMs",
            "dailyOpenings",
            "waitingBaseMs",
            "waitingStepMs",
            "waitingMaxMs",
            "rewardCapMs",
            "rewardWorkMs",
            "rewardAwardMs",
            "openingInactivityMs",
            "openingMaxLifetimeMs",
        ];
        let object = self.as_object();
        let values = KEYS.map(|key| object.and_then(|record| finite_number(record.get(key))));
        let reward_earning = object
            .and_then(|record| record.get("rewardEarning"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        normalize_config_values(values, reward_earning)
    }
}

impl AllowanceConfigSource for AllowanceConfig {
    fn normalized(&self) -> NormalizedAllowanceConfig {
        normalize_config_values(
            [
                Some(self.daily_allowance_ms),
                Some(self.daily_openings),
                Some(self.waiting_base_ms),
                Some(self.waiting_step_ms),
                Some(self.waiting_max_ms),
                Some(self.reward_cap_ms),
                Some(self.reward_work_ms),
                Some(self.reward_award_ms),
                self.opening_inactivity_ms,
                self.opening_max_lifetime_ms,
            ],
            self.reward_earning,
        )
    }
}

impl AllowanceConfigSource for NormalizedAllowanceConfig {
    fn normalized(&self) -> NormalizedAllowanceConfig {
        normalize_config_values(
            [
                Some(self.daily_allowance_ms as f64),
                Some(self.daily_openings as f64),
                Some(self.waiting_base_ms as f64),
                Some(self.waiting_step_ms as f64),
                Some(self.waiting_max_ms as f64),
                Some(self.reward_cap_ms as f64),
                Some(self.reward_work_ms as f64),
                Some(self.reward_award_ms as f64),
                Some(self.opening_inactivity_ms as f64),
                Some(self.opening_max_lifetime_ms as f64),
            ],
            self.reward_earning,
        )
    }
}

pub fn normalize_allowance_config<C: AllowanceConfigSource + ?Sized>(
    raw: &C,
) -> NormalizedAllowanceConfig {
    raw.normalized()
}

fn waiting_delay(config: &NormalizedAllowanceConfig, escalation: u64) -> u64 {
    let stepped = if config.waiting_step_ms > 0
        && escalation > MAX_ALLOWANCE_DURATION_MS / config.waiting_step_ms
    {
        MAX_ALLOWANCE_DURATION_MS
    } else {
        escalation.saturating_mul(config.waiting_step_ms)
    };
    config
        .waiting_max_ms
        .min(config.waiting_base_ms.saturating_add(stepped))
}

fn fresh_ledger(day_key: &str, last_observed_at_ms: u64) -> AllowanceLedger {
    AllowanceLedger {
        version: ALLOWANCE_LEDGER_VERSION,
        day_key: day_key.to_owned(),
        spent_ms: 0,
        earned_reward_ms: 0,
        openings_used: 0,
        waiting_escalation: 0,
        last_observed_at_ms,
        grant: None,
    }
}

pub fn create_empty_allowance_ledger(at: &AllowanceObservation) -> AllowanceLedger {
    let day_key = valid_day_key(&at.day_key).then_some(at.day_key.as_str());
    fresh_ledger(
        day_key.unwrap_or(EMPTY_DAY_KEY),
        timestamp(at.now_ms).unwrap_or(0),
    )
}

fn valid_day_shape(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn valid_day_key(value: &str) -> bool {
    if !valid_day_shape(value) {
        return false;
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day <= lengths[(month - 1) as usize]
}

fn javascript_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn javascript_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn javascript_trim(value: &str) -> &str {
    value.trim_matches(javascript_whitespace)
}

fn valid_grant_id(value: &str) -> bool {
    let length = javascript_len(value);
    length > 0 && length <= 128 && !javascript_trim(value).is_empty()
}

fn valid_kind(value: &str) -> Option<AllowanceGrantKind> {
    match value {
        "allowance" => Some(AllowanceGrantKind::Allowance),
        "opening" => Some(AllowanceGrantKind::Opening),
        "pomodoro" => Some(AllowanceGrantKind::Pomodoro),
        _ => None,
    }
}

fn valid_end_reason(value: &str) -> Option<AllowanceGrantEndReason> {
    match value {
        "waiting-cancelled" => Some(AllowanceGrantEndReason::WaitingCancelled),
        "early-cancelled" => Some(AllowanceGrantEndReason::EarlyCancelled),
        "expired" => Some(AllowanceGrantEndReason::Expired),
        "idle" => Some(AllowanceGrantEndReason::Idle),
        "explicit" => Some(AllowanceGrantEndReason::Explicit),
        "max-lifetime" => Some(AllowanceGrantEndReason::MaxLifetime),
        _ => None,
    }
}

fn sanitize_allowance_add(left: u64, right: u64) -> u64 {
    left.saturating_add(right).min(MAX_ALLOWANCE_TIMESTAMP_MS)
}

fn safe_add(left: u64, right: u64) -> Option<u64> {
    left.checked_add(right)
        .filter(|v| *v <= MAX_ALLOWANCE_TIMESTAMP_MS)
}

fn sanitize_grant(raw: &Value, now_ms: u64) -> Option<AllowanceGrant> {
    let record = raw.as_object()?;
    let id = record.get("id")?.as_str()?;
    if !valid_grant_id(id) {
        return None;
    }
    let kind = valid_kind(record.get("kind")?.as_str()?)?;
    let raw_status = record.get("status")?.as_str()?;
    let valid_status = raw_status == "ended"
        || match kind {
            AllowanceGrantKind::Allowance => matches!(raw_status, "pending" | "active"),
            AllowanceGrantKind::Opening => matches!(raw_status, "active" | "idle-closed"),
            AllowanceGrantKind::Pomodoro => raw_status == "active",
        };
    if !valid_status {
        return None;
    }
    let not_before_ms = raw_timestamp(record.get("notBeforeMs"))?;
    let ends_at_ms = raw_timestamp(record.get("endsAtMs"))?;
    let duration_ms = ends_at_ms.checked_sub(not_before_ms)?;
    if duration_ms == 0 || duration_ms > MAX_ALLOWANCE_DURATION_MS {
        return None;
    }
    let requested_at_ms = raw_timestamp(record.get("requestedAtMs"))
        .map_or(not_before_ms, |value| value.min(not_before_ms));
    let last_activity_at_ms = (kind == AllowanceGrantKind::Opening).then(|| {
        let activity = raw_timestamp(record.get("lastActivityAtMs"))
            .map_or(not_before_ms, |value| value.min(now_ms));
        activity.max(not_before_ms).min(ends_at_ms)
    });
    let ended = matches!(raw_status, "ended" | "idle-closed");
    let status = if ended {
        if raw_status == "idle-closed" && kind == AllowanceGrantKind::Opening {
            AllowanceGrantStatus::IdleClosed
        } else {
            AllowanceGrantStatus::Ended
        }
    } else if kind == AllowanceGrantKind::Allowance && now_ms < not_before_ms {
        AllowanceGrantStatus::Pending
    } else {
        AllowanceGrantStatus::Active
    };
    let end_reason = if ended {
        Some(if status == AllowanceGrantStatus::IdleClosed {
            AllowanceGrantEndReason::Idle
        } else {
            record
                .get("endReason")
                .and_then(Value::as_str)
                .and_then(valid_end_reason)
                .unwrap_or(AllowanceGrantEndReason::Expired)
        })
    } else {
        None
    };
    let ended_at_ms = ended.then(|| {
        raw_timestamp(record.get("endedAtMs"))
            .unwrap_or(ends_at_ms)
            .max(requested_at_ms)
            .min(ends_at_ms)
    });
    let charged_ms = if kind == AllowanceGrantKind::Allowance && ended {
        match end_reason {
            Some(AllowanceGrantEndReason::Expired) => duration_ms,
            Some(AllowanceGrantEndReason::WaitingCancelled) => 0,
            _ => bounded_integer(finite_number(record.get("chargedMs")), duration_ms, 0),
        }
    } else {
        0
    };
    Some(AllowanceGrant {
        id: id.to_owned(),
        kind,
        status,
        requested_at_ms,
        not_before_ms,
        ends_at_ms,
        duration_ms,
        ended_at_ms,
        end_reason,
        charged_ms,
        refunded_ms: if kind == AllowanceGrantKind::Allowance && ended {
            duration_ms - charged_ms
        } else {
            0
        },
        last_activity_at_ms,
    })
}

fn value_of<S: Serialize + ?Sized>(raw: &S) -> Value {
    serde_json::to_value(raw).unwrap_or(Value::Null)
}

fn normalize_ledger_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    at: &AllowanceObservation,
) -> AllowanceLedger {
    let supplied_now = timestamp(at.now_ms);
    let supplied_day = valid_day_key(&at.day_key).then_some(at.day_key.as_str());
    let Some(record) = raw.as_object() else {
        return fresh_ledger(
            supplied_day.unwrap_or(EMPTY_DAY_KEY),
            supplied_now.unwrap_or(0),
        );
    };
    let Some(stored_day) = record
        .get("dayKey")
        .and_then(Value::as_str)
        .filter(|value| valid_day_key(value))
    else {
        return fresh_ledger(
            supplied_day.unwrap_or(EMPTY_DAY_KEY),
            supplied_now.unwrap_or(0),
        );
    };
    let prior_observed = bounded_integer(
        finite_number(record.get("lastObservedAtMs")),
        MAX_ALLOWANCE_TIMESTAMP_MS,
        0,
    );
    let may_advance_day = supplied_now.is_some_and(|now| now >= prior_observed);
    let day_key = match supplied_day {
        Some(day) if day > stored_day && may_advance_day => day,
        _ => stored_day,
    };
    let now_ms = supplied_now.map_or(prior_observed, |now| now.max(prior_observed));
    if day_key != stored_day {
        return fresh_ledger(day_key, now_ms);
    }

    let mut ledger = AllowanceLedger {
        version: ALLOWANCE_LEDGER_VERSION,
        day_key: day_key.to_owned(),
        spent_ms: bounded_integer(
            finite_number(record.get("spentMs")),
            MAX_ALLOWANCE_TIMESTAMP_MS,
            0,
        ),
        // Finite is not necessarily safe: unsafe persisted rewards earn zero.
        earned_reward_ms: raw_timestamp(record.get("earnedRewardMs"))
            .map_or(0, |value| value.min(config.reward_cap_ms)),
        openings_used: bounded_integer(
            finite_number(record.get("openingsUsed")),
            MAX_ALLOWANCE_TIMESTAMP_MS,
            0,
        ),
        waiting_escalation: bounded_integer(
            finite_number(record.get("waitingEscalation")),
            MAX_ALLOWANCE_TIMESTAMP_MS,
            0,
        ),
        last_observed_at_ms: now_ms,
        grant: record
            .get("grant")
            .and_then(|grant| sanitize_grant(grant, now_ms)),
    };

    let Some(mut grant) = ledger.grant.clone() else {
        return ledger;
    };
    if matches!(
        grant.status,
        AllowanceGrantStatus::Ended | AllowanceGrantStatus::IdleClosed
    ) {
        return ledger;
    }

    match grant.kind {
        AllowanceGrantKind::Allowance => {
            if now_ms >= grant.ends_at_ms {
                ledger.spent_ms = sanitize_allowance_add(ledger.spent_ms, grant.duration_ms);
                grant.status = AllowanceGrantStatus::Ended;
                grant.ended_at_ms = Some(grant.ends_at_ms);
                grant.end_reason = Some(AllowanceGrantEndReason::Expired);
                grant.charged_ms = grant.duration_ms;
                grant.refunded_ms = 0;
            } else if now_ms >= grant.not_before_ms && grant.status != AllowanceGrantStatus::Active
            {
                grant.status = AllowanceGrantStatus::Active;
            }
        }
        AllowanceGrantKind::Pomodoro => {
            if now_ms >= grant.ends_at_ms {
                grant.status = AllowanceGrantStatus::Ended;
                grant.ended_at_ms = Some(grant.ends_at_ms);
                grant.end_reason = Some(AllowanceGrantEndReason::Expired);
            }
        }
        AllowanceGrantKind::Opening => {
            let activity_at = grant.last_activity_at_ms.unwrap_or(grant.not_before_ms);
            if now_ms >= grant.ends_at_ms {
                grant.status = AllowanceGrantStatus::Ended;
                grant.ended_at_ms = Some(grant.ends_at_ms);
                grant.end_reason = Some(AllowanceGrantEndReason::MaxLifetime);
            } else if now_ms >= activity_at && now_ms - activity_at >= config.opening_inactivity_ms
            {
                grant.status = AllowanceGrantStatus::IdleClosed;
                grant.ended_at_ms = Some(activity_at + config.opening_inactivity_ms);
                grant.end_reason = Some(AllowanceGrantEndReason::Idle);
            }
        }
    }
    ledger.grant = Some(grant);
    ledger
}

pub fn normalize_allowance_ledger<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    raw_config: &C,
    at: &AllowanceObservation,
) -> AllowanceLedger {
    normalize_ledger_with_config(&value_of(raw), &raw_config.normalized(), at)
}

fn derive_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    at: &AllowanceObservation,
) -> DerivedAllowance {
    let ledger = normalize_ledger_with_config(raw, config, at);
    let total_allowance_ms = config.daily_allowance_ms + ledger.earned_reward_ms;
    let mut active_elapsed_ms = 0;
    let mut reserved_ms = 0;
    if let Some(grant) = ledger
        .grant
        .as_ref()
        .filter(|grant| grant.kind == AllowanceGrantKind::Allowance)
    {
        match grant.status {
            AllowanceGrantStatus::Active => {
                active_elapsed_ms = grant.duration_ms.min(
                    ledger
                        .last_observed_at_ms
                        .saturating_sub(grant.not_before_ms),
                );
                reserved_ms = grant.ends_at_ms - ledger.last_observed_at_ms;
            }
            AllowanceGrantStatus::Pending => reserved_ms = grant.duration_ms,
            _ => {}
        }
    }
    let consumed_ms = sanitize_allowance_add(ledger.spent_ms, active_elapsed_ms);
    let remaining_ms = total_allowance_ms.saturating_sub(consumed_ms);
    DerivedAllowance {
        day_key: ledger.day_key.clone(),
        now_ms: ledger.last_observed_at_ms,
        total_allowance_ms,
        consumed_ms,
        active_elapsed_ms,
        reserved_ms,
        remaining_ms,
        available_ms: remaining_ms.saturating_sub(reserved_ms),
        earned_reward_ms: ledger.earned_reward_ms,
        openings_used: ledger.openings_used,
        openings_remaining: config.daily_openings.saturating_sub(ledger.openings_used),
        waiting_escalation: ledger.waiting_escalation,
        next_waiting_delay_ms: waiting_delay(config, ledger.waiting_escalation),
        grant: ledger.grant.clone(),
    }
}

pub fn derive_allowance<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    at: &AllowanceObservation,
) -> DerivedAllowance {
    derive_with_config(&value_of(raw), &config.normalized(), at)
}

struct Prepared {
    config: NormalizedAllowanceConfig,
    ledger: AllowanceLedger,
    refusal: Option<AllowanceRefusalReason>,
}

fn prepare(raw: &Value, config: &NormalizedAllowanceConfig, at: &AllowanceObservation) -> Prepared {
    let ledger = normalize_ledger_with_config(raw, config, at);
    let refusal = if timestamp(at.now_ms).is_none() {
        Some(AllowanceRefusalReason::InvalidTime)
    } else if !valid_day_key(&at.day_key) {
        Some(AllowanceRefusalReason::InvalidDay)
    } else if at.day_key < ledger.day_key {
        Some(AllowanceRefusalReason::DayRollback)
    } else if timestamp(at.now_ms).is_some_and(|now| now < ledger.last_observed_at_ms) {
        Some(AllowanceRefusalReason::ClockRollback)
    } else {
        None
    };
    Prepared {
        config: *config,
        ledger,
        refusal,
    }
}

fn live_grant(ledger: &AllowanceLedger) -> Option<&AllowanceGrant> {
    ledger.grant.as_ref().filter(|grant| {
        !matches!(
            grant.status,
            AllowanceGrantStatus::Ended | AllowanceGrantStatus::IdleClosed
        )
    })
}

fn find_grant(
    ledger: &AllowanceLedger,
    action: &AllowanceGrantAction,
    kind: AllowanceGrantKind,
) -> Result<AllowanceGrant, AllowanceRefusalReason> {
    if !valid_grant_id(&action.grant_id) {
        return Err(AllowanceRefusalReason::InvalidGrantId);
    }
    let Some(grant) = ledger.grant.as_ref() else {
        return Err(AllowanceRefusalReason::GrantNotFound);
    };
    if grant.id != action.grant_id {
        return Err(AllowanceRefusalReason::GrantNotFound);
    }
    if grant.kind != kind {
        return Err(AllowanceRefusalReason::WrongGrantKind);
    }
    if matches!(
        grant.status,
        AllowanceGrantStatus::Ended | AllowanceGrantStatus::IdleClosed
    ) {
        return Err(AllowanceRefusalReason::GrantEnded);
    }
    Ok(grant.clone())
}

fn request_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    request: &AllowanceRequest,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &request.observation());
    let Prepared {
        config,
        mut ledger,
        refusal,
    } = prepared;
    if let Some(reason) = refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    if !valid_grant_id(&request.grant_id) {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidGrantId);
    }
    let Some(requested_duration) = timestamp(request.duration_ms).filter(|value| *value > 0) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidDuration);
    };
    if live_grant(&ledger).is_some() {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::Overlap);
    }
    let ledger_value = value_of(&ledger);
    let available_ms =
        derive_with_config(&ledger_value, &config, &request.observation()).available_ms;
    if available_ms == 0 {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::AllowanceExhausted);
    }
    let duration_ms = requested_duration
        .min(available_ms)
        .min(MAX_ALLOWANCE_DURATION_MS);
    let now_ms = timestamp(request.now_ms).expect("prepare validated request time");
    let delay_ms = waiting_delay(&config, ledger.waiting_escalation);
    let Some(not_before_ms) = safe_add(now_ms, delay_ms) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::TimeOverflow);
    };
    let Some(ends_at_ms) = safe_add(not_before_ms, duration_ms) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::TimeOverflow);
    };
    ledger.waiting_escalation = bounded_integer(
        Some(ledger.waiting_escalation as f64 + 1.0),
        MAX_ALLOWANCE_TIMESTAMP_MS,
        0,
    );
    ledger.grant = Some(AllowanceGrant {
        id: request.grant_id.clone(),
        kind: AllowanceGrantKind::Allowance,
        status: if delay_ms == 0 {
            AllowanceGrantStatus::Active
        } else {
            AllowanceGrantStatus::Pending
        },
        requested_at_ms: now_ms,
        not_before_ms,
        ends_at_ms,
        duration_ms,
        ended_at_ms: None,
        end_reason: None,
        charged_ms: 0,
        refunded_ms: 0,
        last_activity_at_ms: None,
    });
    AllowanceResult::success(ledger)
}

pub fn request_allowance<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    request: &AllowanceRequest,
) -> AllowanceResult {
    request_with_config(&value_of(raw), &config.normalized(), request)
}

fn cancel_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &action.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    let found = match find_grant(&ledger, action, AllowanceGrantKind::Allowance) {
        Ok(grant) => grant,
        Err(reason) => return AllowanceResult::refusal(ledger, reason),
    };
    let now_ms = timestamp(action.now_ms).expect("prepare validated action time");
    let elapsed_ms = if found.status == AllowanceGrantStatus::Active {
        found
            .duration_ms
            .min(now_ms.saturating_sub(found.not_before_ms))
    } else {
        0
    };
    ledger.spent_ms = sanitize_allowance_add(ledger.spent_ms, elapsed_ms);
    ledger.grant = Some(AllowanceGrant {
        status: AllowanceGrantStatus::Ended,
        ended_at_ms: Some(now_ms),
        end_reason: Some(if found.status == AllowanceGrantStatus::Pending {
            AllowanceGrantEndReason::WaitingCancelled
        } else {
            AllowanceGrantEndReason::EarlyCancelled
        }),
        charged_ms: elapsed_ms,
        refunded_ms: found.duration_ms - elapsed_ms,
        ..found
    });
    // Deliberately no escalation decrement and no waiting-clock adjustment.
    AllowanceResult::success(ledger)
}

pub fn cancel_allowance_grant<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    cancel_with_config(&value_of(raw), &config.normalized(), action)
}

fn reward_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    addition: &RewardAddition,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &addition.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    let Some(earned_ms) = timestamp(addition.earned_ms).filter(|value| *value > 0) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidReward);
    };
    let credited_ms = earned_ms.min(
        prepared
            .config
            .reward_cap_ms
            .saturating_sub(ledger.earned_reward_ms),
    );
    ledger.earned_reward_ms += credited_ms;
    AllowanceResult::success(ledger)
}

pub fn add_reward<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    addition: &RewardAddition,
) -> AllowanceResult {
    reward_with_config(&value_of(raw), &config.normalized(), addition)
}

fn opening_start_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &action.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    if !valid_grant_id(&action.grant_id) {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidGrantId);
    }
    if live_grant(&ledger).is_some() {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::Overlap);
    }
    if ledger.openings_used >= prepared.config.daily_openings {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::NoOpenings);
    }
    let now_ms = timestamp(action.now_ms).expect("prepare validated action time");
    let duration_ms = prepared.config.opening_max_lifetime_ms;
    let Some(ends_at_ms) = safe_add(now_ms, duration_ms) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::TimeOverflow);
    };
    ledger.openings_used += 1;
    ledger.grant = Some(AllowanceGrant {
        id: action.grant_id.clone(),
        kind: AllowanceGrantKind::Opening,
        status: AllowanceGrantStatus::Active,
        requested_at_ms: now_ms,
        not_before_ms: now_ms,
        ends_at_ms,
        duration_ms,
        ended_at_ms: None,
        end_reason: None,
        charged_ms: 0,
        refunded_ms: 0,
        last_activity_at_ms: Some(now_ms),
    });
    // No allowance spent/reserved and no waiting escalation.
    AllowanceResult::success(ledger)
}

pub fn start_opening<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    opening_start_with_config(&value_of(raw), &config.normalized(), action)
}

fn opening_activity_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &action.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    let found = match find_grant(&ledger, action, AllowanceGrantKind::Opening) {
        Ok(grant) => grant,
        Err(reason) => return AllowanceResult::refusal(ledger, reason),
    };
    let now_ms = timestamp(action.now_ms).expect("prepare validated action time");
    ledger.grant = Some(AllowanceGrant {
        last_activity_at_ms: Some(found.last_activity_at_ms.unwrap_or(0).max(now_ms)),
        ..found
    });
    AllowanceResult::success(ledger)
}

pub fn record_opening_activity<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    opening_activity_with_config(&value_of(raw), &config.normalized(), action)
}

fn opening_close_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &action.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    let found = match find_grant(&ledger, action, AllowanceGrantKind::Opening) {
        Ok(grant) => grant,
        Err(reason) => return AllowanceResult::refusal(ledger, reason),
    };
    let now_ms = timestamp(action.now_ms).expect("prepare validated action time");
    ledger.grant = Some(AllowanceGrant {
        status: AllowanceGrantStatus::Ended,
        ended_at_ms: Some(now_ms),
        end_reason: Some(AllowanceGrantEndReason::Explicit),
        ..found
    });
    // Explicit close consumes the opening just as idle/max-lifetime close does.
    AllowanceResult::success(ledger)
}

pub fn close_opening<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    action: &AllowanceGrantAction,
) -> AllowanceResult {
    opening_close_with_config(&value_of(raw), &config.normalized(), action)
}

fn pomodoro_start_with_config(
    raw: &Value,
    config: &NormalizedAllowanceConfig,
    request: &AllowanceRequest,
) -> AllowanceResult {
    let prepared = prepare(raw, config, &request.observation());
    let mut ledger = prepared.ledger;
    if let Some(reason) = prepared.refusal {
        return AllowanceResult::refusal(ledger, reason);
    }
    if !valid_grant_id(&request.grant_id) {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidGrantId);
    }
    let Some(requested_duration) = timestamp(request.duration_ms).filter(|value| *value > 0) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::InvalidDuration);
    };
    if live_grant(&ledger).is_some() {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::Overlap);
    }
    let duration_ms = requested_duration.min(MAX_ALLOWANCE_DURATION_MS);
    let now_ms = timestamp(request.now_ms).expect("prepare validated request time");
    let Some(ends_at_ms) = safe_add(now_ms, duration_ms) else {
        return AllowanceResult::refusal(ledger, AllowanceRefusalReason::TimeOverflow);
    };
    ledger.grant = Some(AllowanceGrant {
        id: request.grant_id.clone(),
        kind: AllowanceGrantKind::Pomodoro,
        status: AllowanceGrantStatus::Active,
        requested_at_ms: now_ms,
        not_before_ms: now_ms,
        ends_at_ms,
        duration_ms,
        ended_at_ms: None,
        end_reason: None,
        charged_ms: 0,
        refunded_ms: 0,
        last_activity_at_ms: None,
    });
    // Programmed fixed-end relief spends neither pool nor opening count.
    AllowanceResult::success(ledger)
}

pub fn start_pomodoro<L: Serialize + ?Sized, C: AllowanceConfigSource + ?Sized>(
    raw: &L,
    config: &C,
    request: &AllowanceRequest,
) -> AllowanceResult {
    pomodoro_start_with_config(&value_of(raw), &config.normalized(), request)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceCategoryState {
    pub config: NormalizedAllowanceConfig,
    /// Raw persisted ledger. The TS authority clone intentionally postpones
    /// ledger sanitization until an observation, so configure/refusals and
    /// duplicate retries cannot advance or repair history on their own.
    pub ledger: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceOperationReceipt {
    pub operation_id: String,
    pub fingerprint: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceAuthorityState {
    pub version: u64,
    pub revision: u64,
    pub categories: BTreeMap<String, AllowanceCategoryState>,
    #[serde(default)]
    pub receipts: Vec<AllowanceOperationReceipt>,
}

impl AllowanceAuthorityState {
    /// Typed view of one category's current ledger at a caller observation.
    pub fn category_ledger(
        &self,
        category: &str,
        at: &AllowanceObservation,
    ) -> Option<AllowanceLedger> {
        let current = self.categories.get(category)?;
        Some(normalize_ledger_with_config(
            &current.ledger,
            &current.config,
            at,
        ))
    }
}

pub fn empty_allowance_authority_state() -> AllowanceAuthorityState {
    empty_allowance_authority_state_at_revision(0)
}

pub fn empty_allowance_authority_state_at_revision(revision: u64) -> AllowanceAuthorityState {
    AllowanceAuthorityState {
        version: ALLOWANCE_STATE_VERSION,
        revision: if revision <= MAX_ALLOWANCE_TIMESTAMP_MS {
            revision
        } else {
            0
        },
        categories: BTreeMap::new(),
        receipts: Vec::new(),
    }
}

pub fn valid_allowance_category(value: &str) -> bool {
    let length = javascript_len(value);
    length > 0 && length <= 64 && javascript_trim(value) == value
}

fn valid_operation_id(value: &str) -> bool {
    (32..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn normalize_category(value: &Value) -> Option<AllowanceCategoryState> {
    let record = value.as_object()?;
    let ledger = record.get("ledger")?.as_object()?;
    let day_key = ledger.get("dayKey")?.as_str()?;
    // Deliberately only the shape here. Real Gregorian validation happens in
    // the allowance primitive at observation, exactly as in allowance-state.ts.
    if !valid_day_shape(day_key) {
        return None;
    }
    Some(AllowanceCategoryState {
        config: normalize_allowance_config(record.get("config").unwrap_or(&Value::Null)),
        ledger: Value::Object(ledger.clone()),
    })
}

pub fn normalize_allowance_authority_state(raw: &Value) -> Option<AllowanceAuthorityState> {
    let record = raw.as_object()?;
    if raw_timestamp(record.get("version"))? != ALLOWANCE_STATE_VERSION {
        return None;
    }
    let revision = raw_timestamp(record.get("revision"))?;
    let raw_categories = record.get("categories")?.as_object()?;
    if raw_categories.len() > MAX_ALLOWANCE_CATEGORIES {
        return None;
    }
    let mut categories = BTreeMap::new();
    for (category, value) in raw_categories {
        if !valid_allowance_category(category) {
            return None;
        }
        categories.insert(category.clone(), normalize_category(value)?);
    }
    let raw_receipts: &[Value] = match record.get("receipts") {
        None => &[],
        Some(Value::Array(values)) => values,
        _ => return None,
    };
    if raw_receipts.len() > MAX_ALLOWANCE_RECEIPTS {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut receipts = Vec::with_capacity(raw_receipts.len());
    for value in raw_receipts {
        let receipt = value.as_object()?;
        let operation_id = receipt.get("operationId")?.as_str()?;
        let fingerprint = receipt.get("fingerprint")?.as_str()?;
        let receipt_revision = raw_timestamp(receipt.get("revision"))?;
        if !valid_operation_id(operation_id)
            || fingerprint.is_empty()
            || javascript_len(fingerprint) > 4_096
            || receipt_revision == 0
            || receipt_revision > revision
            || !seen.insert(operation_id.to_owned())
        {
            return None;
        }
        receipts.push(AllowanceOperationReceipt {
            operation_id: operation_id.to_owned(),
            fingerprint: fingerprint.to_owned(),
            revision: receipt_revision,
        });
    }
    Some(AllowanceAuthorityState {
        version: ALLOWANCE_STATE_VERSION,
        revision,
        categories,
        receipts,
    })
}

pub fn clone_allowance_authority_state(state: &AllowanceAuthorityState) -> AllowanceAuthorityState {
    state.clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllowanceCommandKind {
    Configure,
    Request,
    Cancel,
    Reward,
    OpeningStart,
    OpeningActivity,
    OpeningClose,
    PomodoroStart,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AllowanceCommand {
    Configure {
        operation_id: String,
        category: String,
        config: AllowanceConfig,
    },
    Request {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
        duration_ms: f64,
    },
    Cancel {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
    },
    Reward {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
        earned_ms: f64,
    },
    OpeningStart {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
    },
    OpeningActivity {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
    },
    OpeningClose {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
    },
    PomodoroStart {
        operation_id: String,
        category: String,
        grant_id: String,
        now_ms: f64,
        day_key: String,
        duration_ms: f64,
    },
}

impl AllowanceCommand {
    pub fn kind(&self) -> AllowanceCommandKind {
        match self {
            Self::Configure { .. } => AllowanceCommandKind::Configure,
            Self::Request { .. } => AllowanceCommandKind::Request,
            Self::Cancel { .. } => AllowanceCommandKind::Cancel,
            Self::Reward { .. } => AllowanceCommandKind::Reward,
            Self::OpeningStart { .. } => AllowanceCommandKind::OpeningStart,
            Self::OpeningActivity { .. } => AllowanceCommandKind::OpeningActivity,
            Self::OpeningClose { .. } => AllowanceCommandKind::OpeningClose,
            Self::PomodoroStart { .. } => AllowanceCommandKind::PomodoroStart,
        }
    }

    pub fn operation_id(&self) -> &str {
        match self {
            Self::Configure { operation_id, .. }
            | Self::Request { operation_id, .. }
            | Self::Cancel { operation_id, .. }
            | Self::Reward { operation_id, .. }
            | Self::OpeningStart { operation_id, .. }
            | Self::OpeningActivity { operation_id, .. }
            | Self::OpeningClose { operation_id, .. }
            | Self::PomodoroStart { operation_id, .. } => operation_id,
        }
    }

    pub fn category(&self) -> &str {
        match self {
            Self::Configure { category, .. }
            | Self::Request { category, .. }
            | Self::Cancel { category, .. }
            | Self::Reward { category, .. }
            | Self::OpeningStart { category, .. }
            | Self::OpeningActivity { category, .. }
            | Self::OpeningClose { category, .. }
            | Self::PomodoroStart { category, .. } => category,
        }
    }

    fn observation_fields(&self) -> Option<(&str, f64, &str)> {
        match self {
            Self::Configure { .. } => None,
            Self::Request {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::Cancel {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::Reward {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::OpeningStart {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::OpeningActivity {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::OpeningClose {
                grant_id,
                now_ms,
                day_key,
                ..
            }
            | Self::PomodoroStart {
                grant_id,
                now_ms,
                day_key,
                ..
            } => Some((grant_id, *now_ms, day_key)),
        }
    }

    fn duration_ms(&self) -> Option<f64> {
        match self {
            Self::Request { duration_ms, .. } | Self::PomodoroStart { duration_ms, .. } => {
                Some(*duration_ms)
            }
            _ => None,
        }
    }

    fn earned_ms(&self) -> Option<f64> {
        match self {
            Self::Reward { earned_ms, .. } => Some(*earned_ms),
            _ => None,
        }
    }
}

fn fingerprint_number(value: Option<f64>) -> String {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return "null".to_owned();
    };
    if value.fract() == 0.0 && value >= 0.0 && value <= u64::MAX as f64 {
        return (value as u64).to_string();
    }
    if value.fract() == 0.0 && value < 0.0 && value >= i64::MIN as f64 {
        return (value as i64).to_string();
    }
    Number::from_f64(value).map_or_else(|| "null".to_owned(), |number| number.to_string())
}

/// Compact stable JSON array, with fields and normalized-config property order
/// identical to `JSON.stringify` in allowance-state.ts.
fn fingerprint_allowance_command(command: &AllowanceCommand) -> String {
    let observation = command.observation_fields();
    let fields = [
        serde_json::to_string(&command.kind()).expect("command kind is serializable"),
        serde_json::to_string(command.operation_id()).expect("operation ID is serializable"),
        serde_json::to_string(command.category()).expect("category is serializable"),
        observation.map_or_else(
            || "null".to_owned(),
            |(id, _, _)| serde_json::to_string(id).expect("grant ID is serializable"),
        ),
        fingerprint_number(observation.map(|(_, now, _)| now)),
        observation.map_or_else(
            || "null".to_owned(),
            |(_, _, day)| serde_json::to_string(day).expect("day key is serializable"),
        ),
        fingerprint_number(command.duration_ms()),
        fingerprint_number(command.earned_ms()),
        match command {
            AllowanceCommand::Configure { config, .. } => {
                serde_json::to_string(&config.normalized())
                    .expect("normalized config is serializable")
            }
            _ => "null".to_owned(),
        },
    ];
    format!("[{}]", fields.join(","))
}

pub fn allowance_operation_key(command: &AllowanceCommand) -> Option<String> {
    let (_, _, day_key) = command.observation_fields()?;
    valid_operation_id(command.operation_id()).then(|| {
        format!(
            "{}:{}:{}",
            command.category(),
            day_key,
            command.operation_id()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AllowanceCommandRefusal {
    InvalidTime,
    InvalidDay,
    ClockRollback,
    DayRollback,
    InvalidGrantId,
    InvalidDuration,
    InvalidReward,
    TimeOverflow,
    Overlap,
    AllowanceExhausted,
    NoOpenings,
    GrantNotFound,
    WrongGrantKind,
    GrantEnded,
    InvalidOperation,
    InvalidCategory,
    CategoryLimit,
    Version,
    Revision,
    DuplicateOperation,
    Locked,
    Persistence,
}

impl From<AllowanceRefusalReason> for AllowanceCommandRefusal {
    fn from(value: AllowanceRefusalReason) -> Self {
        match value {
            AllowanceRefusalReason::InvalidTime => Self::InvalidTime,
            AllowanceRefusalReason::InvalidDay => Self::InvalidDay,
            AllowanceRefusalReason::ClockRollback => Self::ClockRollback,
            AllowanceRefusalReason::DayRollback => Self::DayRollback,
            AllowanceRefusalReason::InvalidGrantId => Self::InvalidGrantId,
            AllowanceRefusalReason::InvalidDuration => Self::InvalidDuration,
            AllowanceRefusalReason::InvalidReward => Self::InvalidReward,
            AllowanceRefusalReason::TimeOverflow => Self::TimeOverflow,
            AllowanceRefusalReason::Overlap => Self::Overlap,
            AllowanceRefusalReason::AllowanceExhausted => Self::AllowanceExhausted,
            AllowanceRefusalReason::NoOpenings => Self::NoOpenings,
            AllowanceRefusalReason::GrantNotFound => Self::GrantNotFound,
            AllowanceRefusalReason::WrongGrantKind => Self::WrongGrantKind,
            AllowanceRefusalReason::GrantEnded => Self::GrantEnded,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceCommandResult {
    pub ok: bool,
    pub state: AllowanceAuthorityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<AllowanceCommandKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<AllowanceGrant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<AllowanceCommandRefusal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<bool>,
}

impl AllowanceCommandResult {
    fn success(
        state: AllowanceAuthorityState,
        command: &AllowanceCommand,
        grant: Option<AllowanceGrant>,
        duplicate: bool,
    ) -> Self {
        Self {
            ok: true,
            state,
            kind: Some(command.kind()),
            category: Some(command.category().to_owned()),
            grant,
            reason: None,
            duplicate: duplicate.then_some(true),
        }
    }

    fn refusal(state: AllowanceAuthorityState, reason: AllowanceCommandRefusal) -> Self {
        Self {
            ok: false,
            state,
            kind: None,
            category: None,
            grant: None,
            reason: Some(reason),
            duplicate: None,
        }
    }
}

pub fn apply_allowance_command<S: Serialize + ?Sized>(
    raw_state: &S,
    command: &AllowanceCommand,
    expected_revision: Option<u64>,
) -> AllowanceCommandResult {
    let raw_state = value_of(raw_state);
    let Some(mut state) = normalize_allowance_authority_state(&raw_state) else {
        return AllowanceCommandResult::refusal(
            empty_allowance_authority_state(),
            AllowanceCommandRefusal::Version,
        );
    };
    if !valid_operation_id(command.operation_id()) {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation);
    }
    if !valid_allowance_category(command.category()) {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidCategory);
    }
    let fingerprint = fingerprint_allowance_command(command);
    if let Some(prior) = state
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == command.operation_id())
    {
        if prior.fingerprint != fingerprint {
            return AllowanceCommandResult::refusal(
                state,
                AllowanceCommandRefusal::DuplicateOperation,
            );
        }
        return AllowanceCommandResult::success(state, command, None, true);
    }
    if expected_revision.is_some_and(|expected| expected != state.revision) {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::Revision);
    }
    if allowance_operation_key(command).is_none()
        && command.kind() != AllowanceCommandKind::Configure
    {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation);
    }

    if let AllowanceCommand::Configure { config, .. } = command {
        let existing = state.categories.get(command.category());
        if existing.is_none() && state.categories.len() >= MAX_ALLOWANCE_CATEGORIES {
            return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::CategoryLimit);
        }
        // Configuration never observes time or advances ledger history.
        let ledger = existing.map_or_else(
            || {
                value_of(&create_empty_allowance_ledger(&AllowanceObservation {
                    now_ms: 0.0,
                    day_key: EMPTY_DAY_KEY.to_owned(),
                }))
            },
            |current| current.ledger.clone(),
        );
        state.categories.insert(
            command.category().to_owned(),
            AllowanceCategoryState {
                config: config.normalized(),
                ledger,
            },
        );
        return AllowanceCommandResult::success(state, command, None, false);
    }

    let Some(current) = state.categories.get(command.category()).cloned() else {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidCategory);
    };
    let Some((grant_id, now_ms, day_key)) = command.observation_fields() else {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation);
    };
    let at = AllowanceObservation {
        now_ms,
        day_key: day_key.to_owned(),
    };
    let action = AllowanceGrantAction {
        grant_id: grant_id.to_owned(),
        now_ms,
        day_key: day_key.to_owned(),
    };
    let normalized_ledger = value_of(&normalize_ledger_with_config(
        &current.ledger,
        &current.config,
        &at,
    ));
    let result = match command {
        AllowanceCommand::Request { duration_ms, .. } => request_with_config(
            &normalized_ledger,
            &current.config,
            &AllowanceRequest {
                duration_ms: *duration_ms,
                ..action.clone().into_request()
            },
        ),
        AllowanceCommand::Cancel { .. } => {
            cancel_with_config(&normalized_ledger, &current.config, &action)
        }
        AllowanceCommand::Reward { earned_ms, .. } => reward_with_config(
            &normalized_ledger,
            &current.config,
            &RewardAddition {
                now_ms,
                day_key: day_key.to_owned(),
                earned_ms: *earned_ms,
            },
        ),
        AllowanceCommand::OpeningStart { .. } => {
            opening_start_with_config(&normalized_ledger, &current.config, &action)
        }
        AllowanceCommand::OpeningActivity { .. } => {
            opening_activity_with_config(&normalized_ledger, &current.config, &action)
        }
        AllowanceCommand::OpeningClose { .. } => {
            opening_close_with_config(&normalized_ledger, &current.config, &action)
        }
        AllowanceCommand::PomodoroStart { duration_ms, .. } => pomodoro_start_with_config(
            &normalized_ledger,
            &current.config,
            &AllowanceRequest {
                duration_ms: *duration_ms,
                ..action.clone().into_request()
            },
        ),
        AllowanceCommand::Configure { .. } => unreachable!("configure returned above"),
    };
    if !result.ok {
        return AllowanceCommandResult::refusal(
            state,
            result.reason.expect("refusal has reason").into(),
        );
    }
    state.categories.insert(
        command.category().to_owned(),
        AllowanceCategoryState {
            config: current.config,
            ledger: value_of(&result.ledger),
        },
    );
    AllowanceCommandResult::success(state, command, result.grant, false)
}

impl AllowanceGrantAction {
    fn into_request(self) -> AllowanceRequest {
        AllowanceRequest {
            grant_id: self.grant_id,
            now_ms: self.now_ms,
            day_key: self.day_key,
            duration_ms: 0.0,
        }
    }
}

/// JSON admission helper for untyped IPC/fallback callers. Unknown/malformed
/// command kinds are explicit refusals rather than deserialization panics.
pub fn apply_allowance_command_value(
    raw_state: &Value,
    command: &Value,
    expected_revision: Option<u64>,
) -> AllowanceCommandResult {
    let Some(state) = normalize_allowance_authority_state(raw_state) else {
        return AllowanceCommandResult::refusal(
            empty_allowance_authority_state(),
            AllowanceCommandRefusal::Version,
        );
    };
    let Some(operation_id) = command.get("operationId").and_then(Value::as_str) else {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation);
    };
    if !valid_operation_id(operation_id) {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation);
    }
    let Some(category) = command.get("category").and_then(Value::as_str) else {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidCategory);
    };
    if !valid_allowance_category(category) {
        return AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidCategory);
    }
    match serde_json::from_value::<AllowanceCommand>(command.clone()) {
        Ok(command) => apply_allowance_command(&state, &command, expected_revision),
        Err(_) => AllowanceCommandResult::refusal(state, AllowanceCommandRefusal::InvalidOperation),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllowanceRevisionError;

impl fmt::Display for AllowanceRevisionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "Allowance revisions must increase within the JavaScript safe-integer range.",
        )
    }
}

impl Error for AllowanceRevisionError {}

pub fn commit_allowance_command_revision(
    state: &AllowanceAuthorityState,
    revision: u64,
    command: Option<&AllowanceCommand>,
) -> Result<AllowanceAuthorityState, AllowanceRevisionError> {
    if revision > MAX_ALLOWANCE_TIMESTAMP_MS || revision <= state.revision {
        return Err(AllowanceRevisionError);
    }
    let mut next = state.clone();
    next.revision = revision;
    if let Some(command) = command {
        next.receipts.push(AllowanceOperationReceipt {
            operation_id: command.operation_id().to_owned(),
            fingerprint: fingerprint_allowance_command(command),
            revision,
        });
        if next.receipts.len() > MAX_ALLOWANCE_RECEIPTS {
            let remove = next.receipts.len() - MAX_ALLOWANCE_RECEIPTS;
            next.receipts.drain(..remove);
        }
    }
    Ok(next)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceCategoryView {
    pub config: NormalizedAllowanceConfig,
    pub ledger: AllowanceLedger,
}

pub fn derive_allowance_category<S: Serialize + ?Sized>(
    raw_state: &S,
    category: &str,
    at: &AllowanceObservation,
) -> Option<AllowanceCategoryView> {
    let state = normalize_allowance_authority_state(&value_of(raw_state))?;
    let current = state.categories.get(category)?;
    Some(AllowanceCategoryView {
        config: current.config,
        ledger: normalize_ledger_with_config(&current.ledger, &current.config, at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: f64 = 1_800_000_000_000.0;
    const DAY: &str = "2026-11-08";
    const NEXT_DAY: &str = "2026-11-09";
    const MINUTE: u64 = 60_000;
    const CATEGORY: &str = "video games";

    fn config() -> NormalizedAllowanceConfig {
        normalize_allowance_config(&json!({
            "dailyAllowanceMs": 10 * MINUTE,
            "dailyOpenings": 2,
            "waitingBaseMs": 5_000,
            "waitingStepMs": 2_000,
            "waitingMaxMs": 9_000,
            "rewardCapMs": 3 * MINUTE,
        }))
    }

    fn immediate() -> NormalizedAllowanceConfig {
        NormalizedAllowanceConfig {
            waiting_base_ms: 0,
            waiting_step_ms: 0,
            waiting_max_ms: 0,
            ..config()
        }
    }

    fn at(now_ms: f64) -> AllowanceObservation {
        observation(now_ms, DAY)
    }

    fn observation(now_ms: f64, day_key: &str) -> AllowanceObservation {
        AllowanceObservation {
            now_ms,
            day_key: day_key.to_owned(),
        }
    }

    fn action_at(grant_id: &str, now_ms: f64, day_key: &str) -> AllowanceGrantAction {
        AllowanceGrantAction {
            grant_id: grant_id.to_owned(),
            now_ms,
            day_key: day_key.to_owned(),
        }
    }

    fn action(grant_id: &str, now_ms: f64) -> AllowanceGrantAction {
        action_at(grant_id, now_ms, DAY)
    }

    fn request_at(
        grant_id: &str,
        now_ms: f64,
        duration_ms: f64,
        day_key: &str,
    ) -> AllowanceRequest {
        AllowanceRequest {
            grant_id: grant_id.to_owned(),
            now_ms,
            day_key: day_key.to_owned(),
            duration_ms,
        }
    }

    fn request(grant_id: &str, now_ms: f64, duration_ms: u64) -> AllowanceRequest {
        request_at(grant_id, now_ms, duration_ms as f64, DAY)
    }

    fn reward(now_ms: f64, earned_ms: f64) -> RewardAddition {
        RewardAddition {
            now_ms,
            day_key: DAY.to_owned(),
            earned_ms,
        }
    }

    fn empty() -> AllowanceLedger {
        create_empty_allowance_ledger(&at(T0))
    }

    fn ok(result: AllowanceResult) -> AllowanceLedger {
        assert!(result.ok, "unexpected refusal: {:?}", result.reason);
        result.ledger
    }

    fn refused(result: AllowanceResult, reason: AllowanceRefusalReason) -> AllowanceLedger {
        assert!(!result.ok);
        assert_eq!(result.reason, Some(reason));
        result.ledger
    }

    fn grant(ledger: &AllowanceLedger) -> &AllowanceGrant {
        ledger.grant.as_ref().expect("grant")
    }

    #[test]
    fn configuration_is_clamped_and_opening_defaults_are_safe() {
        let clean = normalize_allowance_config(&json!({
            "dailyAllowanceMs": -1,
            "dailyOpenings": 12.9,
            "waitingBaseMs": "not a number",
            "waitingStepMs": null,
            "waitingMaxMs": f64::MAX,
            "rewardCapMs": -100,
            "openingInactivityMs": null,
            "openingMaxLifetimeMs": 0,
        }));
        assert_eq!(
            clean,
            NormalizedAllowanceConfig {
                daily_allowance_ms: 0,
                daily_openings: 12,
                waiting_base_ms: 0,
                waiting_step_ms: 0,
                waiting_max_ms: MAX_ALLOWANCE_DURATION_MS,
                reward_cap_ms: 0,
                reward_earning: false,
                reward_work_ms: DEFAULT_REWARD_WORK_MS,
                reward_award_ms: DEFAULT_REWARD_AWARD_MS,
                opening_inactivity_ms: DEFAULT_OPENING_INACTIVITY_MS,
                opening_max_lifetime_ms: DEFAULT_OPENING_MAX_LIFETIME_MS,
            }
        );
        assert_eq!(
            normalize_allowance_config(&json!({"openingInactivityMs": 0.5})).opening_inactivity_ms,
            1
        );
        assert_eq!(
            normalize_allowance_config(&json!({"openingMaxLifetimeMs": f64::MAX}))
                .opening_max_lifetime_ms,
            MAX_ALLOWANCE_DURATION_MS
        );
        assert!(
            !normalize_allowance_config(&json!({"rewardEarning": "true"})).reward_earning,
            "only a real boolean opts into reward earning"
        );
        let reward = normalize_allowance_config(&json!({
            "rewardEarning": true,
            "rewardWorkMs": 30_000,
            "rewardAwardMs": 10 * MINUTE,
        }));
        assert!(reward.reward_earning);
        assert_eq!(
            reward.reward_work_ms, MIN_REWARD_RATIO_MS,
            "work below one minute clamps up"
        );
        assert_eq!(
            reward.reward_award_ms, MIN_REWARD_RATIO_MS,
            "award never exceeds work"
        );
        let bounded_reward = normalize_allowance_config(&json!({
            "rewardWorkMs": f64::MAX,
            "rewardAwardMs": 0,
        }));
        assert_eq!(bounded_reward.reward_work_ms, MAX_ALLOWANCE_DURATION_MS);
        assert_eq!(
            bounded_reward.reward_award_ms, DEFAULT_REWARD_AWARD_MS,
            "an invalid award uses its default and then clamps to work"
        );
        assert!(valid_day_key("2024-02-29"));
        assert!(!valid_day_key("2023-02-29"));
        assert!(!valid_day_key("1900-02-29"));
        assert!(valid_day_key("2000-02-29"));
        assert!(!valid_day_key("2026-02-30"));
        // ECMAScript trims BOM but (unlike Rust) not NEL.
        assert!(!valid_allowance_category("\u{feff}video games"));
        assert!(valid_allowance_category("\u{0085}video games"));
    }

    #[test]
    fn first_request_reserves_pool_and_later_requests_escalate_linearly() {
        let result = request_allowance(&empty(), &config(), &request("a1", T0, 30 * MINUTE));
        assert_eq!(
            result.grant.as_ref().unwrap().status,
            AllowanceGrantStatus::Pending
        );
        let ledger = ok(result);
        assert_eq!(grant(&ledger).not_before_ms, T0 as u64 + 5_000);
        assert_eq!(grant(&ledger).ends_at_ms, T0 as u64 + 5_000 + 10 * MINUTE);
        assert_eq!(grant(&ledger).duration_ms, 10 * MINUTE);
        assert_eq!(ledger.waiting_escalation, 1);
        let derived = derive_allowance(&ledger, &config(), &at(T0));
        assert_eq!(derived.reserved_ms, 10 * MINUTE);
        assert_eq!(derived.available_ms, 0);
        assert_eq!(derived.next_waiting_delay_ms, 7_000);

        let mut ledger = empty();
        for (index, expected) in [5_000, 7_000, 9_000, 9_000].into_iter().enumerate() {
            let id = format!("e{index}");
            let started_at = T0 + index as f64 * 1_000.0;
            let result = request_allowance(&ledger, &config(), &request(&id, started_at, MINUTE));
            assert_eq!(
                result.grant.as_ref().unwrap().not_before_ms - started_at as u64,
                expected
            );
            ledger = ok(result);
            ledger = ok(cancel_allowance_grant(
                &ledger,
                &config(),
                &action(&id, started_at),
            ));
            assert_eq!(ledger.spent_ms, 0);
            assert_eq!(ledger.waiting_escalation, index as u64 + 1);
        }
        assert_eq!(
            derive_allowance(&ledger, &config(), &at(T0 + 10_000.0)).next_waiting_delay_ms,
            9_000
        );
    }

    #[test]
    fn waiting_cancel_releases_reservation_without_deescalating() {
        let mut ledger = ok(request_allowance(
            &empty(),
            &config(),
            &request("wait", T0, MINUTE),
        ));
        ledger = ok(cancel_allowance_grant(
            &ledger,
            &config(),
            &action("wait", T0 + 4_999.0),
        ));
        assert_eq!(ledger.spent_ms, 0);
        assert_eq!(ledger.waiting_escalation, 1);
        assert_eq!(
            grant(&ledger).end_reason,
            Some(AllowanceGrantEndReason::WaitingCancelled)
        );
        assert_eq!(grant(&ledger).charged_ms, 0);
        assert_eq!(grant(&ledger).refunded_ms, MINUTE);
        let derived = derive_allowance(&ledger, &config(), &at(T0 + 4_999.0));
        assert_eq!(derived.consumed_ms, 0);
        assert_eq!(derived.reserved_ms, 0);
        assert_eq!(derived.available_ms, 10 * MINUTE);
    }

    #[test]
    fn active_allowance_charges_wall_clock_and_early_cancel_refunds_unused() {
        let requested = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("active", T0, 8 * MINUTE),
        ));
        let before = derive_allowance(&requested, &immediate(), &at(T0));
        assert_eq!(
            before.grant.as_ref().unwrap().status,
            AllowanceGrantStatus::Active
        );
        assert_eq!(before.consumed_ms, 0);
        assert_eq!(before.reserved_ms, 8 * MINUTE);
        let later = derive_allowance(&requested, &immediate(), &at(T0 + (3 * MINUTE) as f64));
        assert_eq!(later.active_elapsed_ms, 3 * MINUTE);
        assert_eq!(later.consumed_ms, 3 * MINUTE);
        assert_eq!(later.remaining_ms, 7 * MINUTE);
        assert_eq!(later.reserved_ms, 5 * MINUTE);
        assert_eq!(later.available_ms, 2 * MINUTE);

        let snapshot = requested.clone();
        let cancelled = ok(cancel_allowance_grant(
            &requested,
            &immediate(),
            &action("active", T0 + (3 * MINUTE) as f64),
        ));
        assert_eq!(requested, snapshot);
        assert_eq!(cancelled.spent_ms, 3 * MINUTE);
        assert_eq!(
            grant(&cancelled).end_reason,
            Some(AllowanceGrantEndReason::EarlyCancelled)
        );
        assert_eq!(grant(&cancelled).charged_ms, 3 * MINUTE);
        assert_eq!(grant(&cancelled).refunded_ms, 5 * MINUTE);
        assert_eq!(cancelled.waiting_escalation, 1);
        assert_eq!(
            derive_allowance(&cancelled, &immediate(), &at(T0 + (3 * MINUTE) as f64)).available_ms,
            7 * MINUTE
        );
    }

    #[test]
    fn fixed_expiry_settles_exactly_once_even_across_pending_wait() {
        let requested = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("expiry", T0, 2 * MINUTE),
        ));
        let expired =
            normalize_allowance_ledger(&requested, &immediate(), &at(T0 + (2 * MINUTE) as f64));
        assert_eq!(expired.spent_ms, 2 * MINUTE);
        assert_eq!(grant(&expired).status, AllowanceGrantStatus::Ended);
        assert_eq!(
            grant(&expired).end_reason,
            Some(AllowanceGrantEndReason::Expired)
        );
        assert_eq!(grant(&expired).charged_ms, 2 * MINUTE);
        assert_eq!(grant(&expired).ended_at_ms, Some(T0 as u64 + 2 * MINUTE));
        let again =
            normalize_allowance_ledger(&expired, &immediate(), &at(T0 + (30 * MINUTE) as f64));
        assert_eq!(again.spent_ms, expired.spent_ms);
        assert_eq!(again.grant, expired.grant);
        assert_eq!(again.last_observed_at_ms, T0 as u64 + 30 * MINUTE);

        let pending = ok(request_allowance(
            &empty(),
            &config(),
            &request("pending-expiry", T0, MINUTE),
        ));
        let jumped =
            normalize_allowance_ledger(&pending, &config(), &at(T0 + (20 * MINUTE) as f64));
        assert_eq!(jumped.spent_ms, MINUTE);
        assert_eq!(grant(&jumped).ended_at_ms, Some(T0 as u64 + 5_000 + MINUTE));
        assert_eq!(
            normalize_allowance_ledger(&jumped, &config(), &at(T0 + (21 * MINUTE) as f64)).spent_ms,
            MINUTE
        );
    }

    #[test]
    fn exhaustion_and_overlap_refuse_without_consuming_or_escalating() {
        let no_pool = NormalizedAllowanceConfig {
            daily_allowance_ms: 0,
            reward_cap_ms: 0,
            ..immediate()
        };
        refused(
            request_allowance(&empty(), &no_pool, &request("none", T0, MINUTE)),
            AllowanceRefusalReason::AllowanceExhausted,
        );
        let mut ledger = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("all", T0, 10 * MINUTE),
        ));
        refused(
            request_allowance(&ledger, &immediate(), &request("second", T0 + 1.0, MINUTE)),
            AllowanceRefusalReason::Overlap,
        );
        refused(
            start_opening(&ledger, &immediate(), &action("opening", T0 + 1.0)),
            AllowanceRefusalReason::Overlap,
        );
        refused(
            start_pomodoro(
                &ledger,
                &immediate(),
                &request("pomodoro", T0 + 1.0, MINUTE),
            ),
            AllowanceRefusalReason::Overlap,
        );
        assert_eq!(ledger.waiting_escalation, 1);
        assert_eq!(ledger.openings_used, 0);
        ledger = normalize_allowance_ledger(&ledger, &immediate(), &at(T0 + (10 * MINUTE) as f64));
        let refused_ledger = refused(
            request_allowance(
                &ledger,
                &immediate(),
                &request("after-all", T0 + (10 * MINUTE + 1) as f64, MINUTE),
            ),
            AllowanceRefusalReason::AllowanceExhausted,
        );
        assert_eq!(refused_ledger.waiting_escalation, 1);
        assert_eq!(grant(&refused_ledger).id, "all");
    }

    #[test]
    fn invalid_actions_return_explicit_refusals() {
        let ledger = empty();
        for duration in [0.0, -1.0, f64::NAN, f64::INFINITY, 1.5] {
            refused(
                request_allowance(&ledger, &config(), &request_at("bad", T0, duration, DAY)),
                AllowanceRefusalReason::InvalidDuration,
            );
        }
        refused(
            request_allowance(&ledger, &config(), &request("bad", f64::NAN, MINUTE)),
            AllowanceRefusalReason::InvalidTime,
        );
        refused(
            request_allowance(&ledger, &config(), &request("bad", -1.0, MINUTE)),
            AllowanceRefusalReason::InvalidTime,
        );
        refused(
            request_allowance(
                &ledger,
                &config(),
                &request_at("bad", T0, MINUTE as f64, "2026-02-30"),
            ),
            AllowanceRefusalReason::InvalidDay,
        );
        refused(
            request_allowance(&ledger, &config(), &request(" ", T0, MINUTE)),
            AllowanceRefusalReason::InvalidGrantId,
        );
        assert_eq!(
            refused(
                add_reward(&ledger, &config(), &reward(T0, f64::NAN)),
                AllowanceRefusalReason::InvalidReward,
            ),
            ledger
        );
    }

    #[test]
    fn safe_time_ceiling_never_overflows_or_consumes_counts() {
        let near_max = MAX_ALLOWANCE_TIMESTAMP_MS - 1_000;
        let initial = create_empty_allowance_ledger(&at(near_max as f64));
        refused(
            request_allowance(
                &initial,
                &config(),
                &request("overflow", near_max as f64, MINUTE),
            ),
            AllowanceRefusalReason::TimeOverflow,
        );
        refused(
            start_opening(&initial, &config(), &action("overflow", near_max as f64)),
            AllowanceRefusalReason::TimeOverflow,
        );
        refused(
            start_pomodoro(
                &initial,
                &immediate(),
                &request("overflow", near_max as f64, 2_000),
            ),
            AllowanceRefusalReason::TimeOverflow,
        );
        for derived in [
            derive_allowance(&initial, &config(), &at(MAX_ALLOWANCE_TIMESTAMP_MS as f64)),
            derive_allowance(&initial, &config(), &at(f64::MAX)),
        ] {
            assert!(derived.consumed_ms <= MAX_ALLOWANCE_TIMESTAMP_MS);
            assert!(derived.next_waiting_delay_ms <= MAX_ALLOWANCE_DURATION_MS);
            assert_eq!(derived.available_ms, 10 * MINUTE);
        }
    }

    #[test]
    fn rollover_requires_valid_nonrollback_observation() {
        let mut ledger = ok(add_reward(
            &empty(),
            &config(),
            &reward(T0, (2 * MINUTE) as f64),
        ));
        ledger = ok(request_allowance(
            &ledger,
            &immediate(),
            &request("old-day", T0, 4 * MINUTE),
        ));
        ledger.openings_used = 2;
        let rolled =
            normalize_allowance_ledger(&ledger, &immediate(), &observation(T0 + 1_000.0, NEXT_DAY));
        assert_eq!(rolled.day_key, NEXT_DAY);
        assert_eq!(rolled.spent_ms, 0);
        assert_eq!(rolled.earned_reward_ms, 0);
        assert_eq!(rolled.openings_used, 0);
        assert_eq!(rolled.waiting_escalation, 0);
        assert!(rolled.grant.is_none());

        refused(
            request_allowance(
                &ledger,
                &immediate(),
                &request_at("back-day", T0 + MINUTE as f64, MINUTE as f64, "2026-11-07"),
            ),
            AllowanceRefusalReason::DayRollback,
        );
        refused(
            add_reward(&ledger, &immediate(), &reward(T0 - 1.0, MINUTE as f64)),
            AllowanceRefusalReason::ClockRollback,
        );
        for ambiguous in [
            observation(T0 - 1.0, NEXT_DAY),
            observation(f64::NAN, NEXT_DAY),
            observation(T0 - MINUTE as f64, "2026-11-07"),
        ] {
            let not_reset = normalize_allowance_ledger(&ledger, &immediate(), &ambiguous);
            assert_eq!(not_reset.day_key, DAY);
            assert_eq!(not_reset.earned_reward_ms, 2 * MINUTE);
            assert_eq!(not_reset.waiting_escalation, 1);
            assert_eq!(not_reset.last_observed_at_ms, T0 as u64);
        }
        assert_eq!(
            derive_allowance(&ledger, &immediate(), &at(T0 - MINUTE as f64)).consumed_ms,
            0
        );
    }

    #[test]
    fn rewards_are_capped_and_reset_next_day() {
        let mut ledger = ok(add_reward(
            &empty(),
            &config(),
            &reward(T0, (2 * MINUTE) as f64),
        ));
        assert_eq!(ledger.earned_reward_ms, 2 * MINUTE);
        assert_eq!(
            derive_allowance(&ledger, &config(), &at(T0)).total_allowance_ms,
            12 * MINUTE
        );
        ledger = ok(add_reward(
            &ledger,
            &config(),
            &reward(T0 + 1.0, (2 * MINUTE) as f64),
        ));
        assert_eq!(ledger.earned_reward_ms, 3 * MINUTE);
        assert_eq!(
            derive_allowance(&ledger, &config(), &at(T0 + 1.0)).total_allowance_ms,
            13 * MINUTE
        );
        let rolled =
            normalize_allowance_ledger(&ledger, &config(), &observation(T0 + 2.0, NEXT_DAY));
        assert_eq!(rolled.earned_reward_ms, 0);
        assert_eq!(
            derive_allowance(&rolled, &config(), &observation(T0 + 2.0, NEXT_DAY))
                .total_allowance_ms,
            10 * MINUTE
        );
    }

    #[test]
    fn opening_start_and_explicit_close_consume_only_daily_count() {
        let result = start_opening(&empty(), &config(), &action("open", T0));
        assert_eq!(
            result.grant.as_ref().unwrap().kind,
            AllowanceGrantKind::Opening
        );
        let ledger = ok(result);
        assert_eq!(grant(&ledger).last_activity_at_ms, Some(T0 as u64));
        assert_eq!(
            grant(&ledger).ends_at_ms,
            T0 as u64 + DEFAULT_OPENING_MAX_LIFETIME_MS
        );
        assert_eq!(ledger.openings_used, 1);
        assert_eq!(ledger.spent_ms, 0);
        assert_eq!(ledger.waiting_escalation, 0);
        let derived = derive_allowance(&ledger, &config(), &at(T0 + MINUTE as f64));
        assert_eq!(derived.available_ms, 10 * MINUTE);
        assert_eq!(derived.openings_remaining, 1);

        let one_opening = NormalizedAllowanceConfig {
            daily_openings: 1,
            ..config()
        };
        let mut ledger = ok(start_opening(&empty(), &one_opening, &action("only", T0)));
        ledger = ok(close_opening(
            &ledger,
            &one_opening,
            &action("only", T0 + 10_000.0),
        ));
        assert_eq!(
            grant(&ledger).end_reason,
            Some(AllowanceGrantEndReason::Explicit)
        );
        refused(
            start_opening(&ledger, &one_opening, &action("next", T0 + 20_000.0)),
            AllowanceRefusalReason::NoOpenings,
        );
        let next_day = normalize_allowance_ledger(
            &ledger,
            &one_opening,
            &observation(T0 + 20_001.0, NEXT_DAY),
        );
        assert_eq!(next_day.openings_used, 0);
        assert_eq!(next_day.waiting_escalation, 0);
    }

    #[test]
    fn opening_activity_is_monotonic_and_idle_closes_at_exact_edge() {
        let mut ledger = ok(start_opening(&empty(), &config(), &action("idle", T0)));
        ledger = ok(record_opening_activity(
            &ledger,
            &config(),
            &action("idle", T0 + 60_000.0),
        ));
        assert_eq!(grant(&ledger).last_activity_at_ms, Some(T0 as u64 + 60_000));
        refused(
            record_opening_activity(&ledger, &config(), &action("idle", T0 + 30_000.0)),
            AllowanceRefusalReason::ClockRollback,
        );
        let just_before =
            normalize_allowance_ledger(&ledger, &config(), &at(T0 + 60_000.0 + 119_999.0));
        assert_eq!(grant(&just_before).status, AllowanceGrantStatus::Active);
        let closed = normalize_allowance_ledger(&just_before, &config(), &at(T0 + 180_000.0));
        assert_eq!(grant(&closed).status, AllowanceGrantStatus::IdleClosed);
        assert_eq!(
            grant(&closed).end_reason,
            Some(AllowanceGrantEndReason::Idle)
        );
        assert_eq!(grant(&closed).ended_at_ms, Some(T0 as u64 + 180_000));
        assert_eq!(closed.openings_used, 1);
        assert_eq!(closed.spent_ms, 0);
        refused(
            close_opening(&closed, &config(), &action("idle", T0 + 180_001.0)),
            AllowanceRefusalReason::GrantEnded,
        );
    }

    #[test]
    fn opening_max_lifetime_wins_over_continual_activity() {
        let config = NormalizedAllowanceConfig {
            opening_inactivity_ms: 1_000,
            opening_max_lifetime_ms: 5_000,
            ..config()
        };
        let mut ledger = ok(start_opening(&empty(), &config, &action("ceiling", T0)));
        for elapsed in [900, 1_800, 2_700, 3_600, 4_500] {
            ledger = ok(record_opening_activity(
                &ledger,
                &config,
                &action("ceiling", T0 + elapsed as f64),
            ));
        }
        let capped = normalize_allowance_ledger(&ledger, &config, &at(T0 + 5_000.0));
        assert_eq!(grant(&capped).status, AllowanceGrantStatus::Ended);
        assert_eq!(
            grant(&capped).end_reason,
            Some(AllowanceGrantEndReason::MaxLifetime)
        );
        assert_eq!(grant(&capped).ended_at_ms, Some(T0 as u64 + 5_000));
        assert_eq!(capped.spent_ms, 0);
        refused(
            record_opening_activity(&capped, &config, &action("ceiling", T0 + 5_001.0)),
            AllowanceRefusalReason::GrantEnded,
        );
    }

    #[test]
    fn openings_and_pomodoros_are_free_but_pomodoro_has_fixed_cap() {
        let no_pool = NormalizedAllowanceConfig {
            daily_allowance_ms: 0,
            reward_cap_ms: 0,
            ..config()
        };
        let opening = ok(start_opening(
            &empty(),
            &no_pool,
            &action("free-opening", T0),
        ));
        assert_eq!(opening.openings_used, 1);
        assert_eq!(opening.spent_ms, 0);
        assert_eq!(opening.waiting_escalation, 0);
        assert_eq!(
            derive_allowance(&opening, &no_pool, &at(T0 + MINUTE as f64)).available_ms,
            0
        );

        let result = start_pomodoro(
            &empty(),
            &config(),
            &request("pom", T0, MAX_ALLOWANCE_DURATION_MS * 2),
        );
        assert_eq!(
            result.grant.as_ref().unwrap().duration_ms,
            MAX_ALLOWANCE_DURATION_MS
        );
        let ledger = ok(result);
        assert_eq!(ledger.spent_ms, 0);
        assert_eq!(ledger.openings_used, 0);
        assert_eq!(ledger.waiting_escalation, 0);
        assert_eq!(
            derive_allowance(&ledger, &config(), &at(T0 + MINUTE as f64)).available_ms,
            10 * MINUTE
        );
        let ended = normalize_allowance_ledger(
            &ledger,
            &config(),
            &at(T0 + MAX_ALLOWANCE_DURATION_MS as f64),
        );
        assert_eq!(
            grant(&ended).end_reason,
            Some(AllowanceGrantEndReason::Expired)
        );
        assert_eq!(ended.spent_ms, 0);
        assert_eq!(ended.openings_used, 0);
        assert_eq!(ended.waiting_escalation, 0);
    }

    #[test]
    fn malformed_persistence_neutralizes_unsafe_numbers_and_statuses() {
        let raw = json!({
            "version": ALLOWANCE_LEDGER_VERSION,
            "dayKey": DAY,
            "spentMs": "NaN",
            "earnedRewardMs": f64::MAX,
            "openingsUsed": -10,
            "waitingEscalation": 3.8,
            "lastObservedAtMs": null,
            "grant": {
                "id": "broken",
                "kind": "allowance",
                "status": "active",
                "notBeforeMs": null,
                "endsAtMs": f64::MAX,
            }
        });
        let ledger = normalize_allowance_ledger(&raw, &config(), &at(f64::NAN));
        assert_eq!(ledger.spent_ms, 0);
        assert_eq!(ledger.earned_reward_ms, 0);
        assert_eq!(ledger.openings_used, 0);
        assert_eq!(ledger.waiting_escalation, 3);
        assert_eq!(ledger.last_observed_at_ms, 0);
        assert!(ledger.grant.is_none());

        for earned in [f64::MAX, (MAX_ALLOWANCE_TIMESTAMP_MS + 1) as f64] {
            let mut raw = value_of(&empty());
            raw["earnedRewardMs"] = json!(earned);
            let normalized = normalize_allowance_ledger(&raw, &config(), &at(T0));
            assert_eq!(normalized.earned_reward_ms, 0);
            assert_eq!(
                derive_allowance(&raw, &config(), &at(T0)).total_allowance_ms,
                10 * MINUTE
            );
        }
    }

    #[test]
    fn unknown_or_mismatched_statuses_never_resettle_charged_allowance() {
        let requested = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("settled", T0, MINUTE),
        ));
        let settled = normalize_allowance_ledger(&requested, &immediate(), &at(T0 + MINUTE as f64));
        for status in [
            json!("expired"),
            json!("unknown"),
            Value::Null,
            json!(42),
            json!("idle-closed"),
        ] {
            let mut malformed = value_of(&settled);
            malformed["grant"]["status"] = status;
            let normalized =
                normalize_allowance_ledger(&malformed, &immediate(), &at(T0 + (2 * MINUTE) as f64));
            assert_eq!(normalized.spent_ms, MINUTE);
            assert!(normalized.grant.is_none());
        }
        for (kind, status) in [
            ("opening", "pending"),
            ("pomodoro", "pending"),
            ("pomodoro", "idle-closed"),
        ] {
            let mut raw = value_of(&requested);
            raw["grant"]["kind"] = json!(kind);
            raw["grant"]["status"] = json!(status);
            assert!(normalize_allowance_ledger(&raw, &immediate(), &at(T0))
                .grant
                .is_none());
        }
    }

    #[test]
    fn corrupt_future_grant_saturates_without_negative_or_unsafe_values() {
        let raw = json!({
            "dayKey": DAY,
            "spentMs": MAX_ALLOWANCE_TIMESTAMP_MS,
            "earnedRewardMs": MAX_ALLOWANCE_TIMESTAMP_MS,
            "openingsUsed": MAX_ALLOWANCE_TIMESTAMP_MS,
            "waitingEscalation": MAX_ALLOWANCE_TIMESTAMP_MS,
            "lastObservedAtMs": MAX_ALLOWANCE_TIMESTAMP_MS - 5_000,
            "grant": {
                "id": "future",
                "kind": "allowance",
                "status": "pending",
                "requestedAtMs": MAX_ALLOWANCE_TIMESTAMP_MS - 5_000,
                "notBeforeMs": MAX_ALLOWANCE_TIMESTAMP_MS - 4_000,
                "endsAtMs": MAX_ALLOWANCE_TIMESTAMP_MS,
                "chargedMs": 0
            }
        });
        let ledger =
            normalize_allowance_ledger(&raw, &config(), &at(MAX_ALLOWANCE_TIMESTAMP_MS as f64));
        assert_eq!(grant(&ledger).status, AllowanceGrantStatus::Ended);
        assert_eq!(ledger.spent_ms, MAX_ALLOWANCE_TIMESTAMP_MS);
        let derived = derive_allowance(&ledger, &config(), &at(MAX_ALLOWANCE_TIMESTAMP_MS as f64));
        assert!(derived.consumed_ms <= MAX_ALLOWANCE_TIMESTAMP_MS);
        assert!(derived.next_waiting_delay_ms <= MAX_ALLOWANCE_DURATION_MS);
        assert_eq!(derived.available_ms, 0);
    }

    #[test]
    fn transitions_are_immutable_and_normalization_idempotent() {
        let initial = empty();
        let snapshot = value_of(&initial);
        let requested = request_allowance(&initial, &config(), &request("immutable", T0, MINUTE));
        assert_eq!(value_of(&initial), snapshot);
        let active = ok(requested);
        let active_snapshot = active.clone();
        assert!(cancel_allowance_grant(&active, &config(), &action("immutable", T0)).ok);
        assert_eq!(active, active_snapshot);
        let opening = ok(start_opening(&empty(), &config(), &action("open", T0)));
        let opening_snapshot = opening.clone();
        assert!(record_opening_activity(&opening, &config(), &action("open", T0 + 1_000.0)).ok);
        assert!(close_opening(&opening, &config(), &action("open", T0 + 2_000.0)).ok);
        assert_eq!(opening, opening_snapshot);
        let original = empty();
        assert!(add_reward(&original, &config(), &reward(T0, MINUTE as f64)).ok);
        assert_eq!(original.earned_reward_ms, 0);

        let allowance = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("once", T0, MINUTE),
        ));
        let once =
            normalize_allowance_ledger(&allowance, &immediate(), &at(T0 + (2 * MINUTE) as f64));
        assert_eq!(
            normalize_allowance_ledger(&once, &immediate(), &at(T0 + (2 * MINUTE) as f64)),
            once
        );
        let opening = ok(start_opening(&empty(), &config(), &action("idle-once", T0)));
        let once = normalize_allowance_ledger(
            &opening,
            &config(),
            &at(T0 + DEFAULT_OPENING_INACTIVITY_MS as f64),
        );
        assert_eq!(
            normalize_allowance_ledger(
                &once,
                &config(),
                &at(T0 + DEFAULT_OPENING_INACTIVITY_MS as f64),
            ),
            once
        );
    }

    #[test]
    fn grant_ids_and_kind_checks_prevent_duplicate_settlement() {
        let mut ledger = ok(request_allowance(
            &empty(),
            &immediate(),
            &request("right", T0, 2 * MINUTE),
        ));
        refused(
            cancel_allowance_grant(&ledger, &immediate(), &action("wrong", T0 + 1.0)),
            AllowanceRefusalReason::GrantNotFound,
        );
        refused(
            close_opening(&ledger, &immediate(), &action("right", T0 + 1.0)),
            AllowanceRefusalReason::WrongGrantKind,
        );
        ledger = ok(cancel_allowance_grant(
            &ledger,
            &immediate(),
            &action("right", T0 + MINUTE as f64),
        ));
        assert_eq!(ledger.spent_ms, MINUTE);
        refused(
            cancel_allowance_grant(
                &ledger,
                &immediate(),
                &action("right", T0 + MINUTE as f64 + 1.0),
            ),
            AllowanceRefusalReason::GrantEnded,
        );
        assert_eq!(ledger.spent_ms, MINUTE);
    }

    fn operation_id(number: u64) -> String {
        format!("{number:032x}")
    }

    fn authority_config() -> AllowanceConfig {
        AllowanceConfig {
            daily_allowance_ms: (10 * MINUTE) as f64,
            daily_openings: 1.0,
            waiting_base_ms: 0.0,
            waiting_step_ms: 0.0,
            waiting_max_ms: 0.0,
            reward_cap_ms: (3 * MINUTE) as f64,
            reward_earning: false,
            reward_work_ms: DEFAULT_REWARD_WORK_MS as f64,
            reward_award_ms: DEFAULT_REWARD_AWARD_MS as f64,
            opening_inactivity_ms: None,
            opening_max_lifetime_ms: None,
        }
    }

    fn configure_command_at(number: u64, category: &str) -> AllowanceCommand {
        AllowanceCommand::Configure {
            operation_id: operation_id(number),
            category: category.to_owned(),
            config: authority_config(),
        }
    }

    fn configure_command(number: u64) -> AllowanceCommand {
        configure_command_at(number, CATEGORY)
    }

    fn request_command_at(
        number: u64,
        category: &str,
        grant_id: &str,
        now_ms: f64,
        day_key: &str,
        duration_ms: f64,
    ) -> AllowanceCommand {
        AllowanceCommand::Request {
            operation_id: operation_id(number),
            category: category.to_owned(),
            grant_id: grant_id.to_owned(),
            now_ms,
            day_key: day_key.to_owned(),
            duration_ms,
        }
    }

    fn request_command(number: u64, duration_ms: u64) -> AllowanceCommand {
        request_command_at(
            number,
            CATEGORY,
            &format!("g{number}"),
            T0,
            DAY,
            duration_ms as f64,
        )
    }

    fn reward_command_at(
        number: u64,
        now_ms: f64,
        day_key: &str,
        earned_ms: u64,
    ) -> AllowanceCommand {
        AllowanceCommand::Reward {
            operation_id: operation_id(number),
            category: CATEGORY.to_owned(),
            grant_id: format!("g{number}"),
            now_ms,
            day_key: day_key.to_owned(),
            earned_ms: earned_ms as f64,
        }
    }

    fn opening_command(
        kind: AllowanceCommandKind,
        number: u64,
        grant_id: &str,
        now_ms: f64,
    ) -> AllowanceCommand {
        let operation_id = operation_id(number);
        let category = CATEGORY.to_owned();
        let grant_id = grant_id.to_owned();
        let day_key = DAY.to_owned();
        match kind {
            AllowanceCommandKind::OpeningStart => AllowanceCommand::OpeningStart {
                operation_id,
                category,
                grant_id,
                now_ms,
                day_key,
            },
            AllowanceCommandKind::OpeningActivity => AllowanceCommand::OpeningActivity {
                operation_id,
                category,
                grant_id,
                now_ms,
                day_key,
            },
            AllowanceCommandKind::OpeningClose => AllowanceCommand::OpeningClose {
                operation_id,
                category,
                grant_id,
                now_ms,
                day_key,
            },
            _ => panic!("not an opening command"),
        }
    }

    fn command_ok(result: AllowanceCommandResult) -> AllowanceCommandResult {
        assert!(result.ok, "unexpected command refusal: {:?}", result.reason);
        result
    }

    fn command_rejected(
        result: AllowanceCommandResult,
        reason: AllowanceCommandRefusal,
    ) -> AllowanceCommandResult {
        assert!(!result.ok);
        assert_eq!(result.reason, Some(reason));
        result
    }

    fn configured() -> AllowanceAuthorityState {
        let command = configure_command(1);
        let result = command_ok(apply_allowance_command(
            &empty_allowance_authority_state(),
            &command,
            None,
        ));
        commit_allowance_command_revision(&result.state, 1, Some(&command)).unwrap()
    }

    fn accepted(
        state: &AllowanceAuthorityState,
        command: &AllowanceCommand,
    ) -> AllowanceAuthorityState {
        let result = command_ok(apply_allowance_command(
            state,
            command,
            Some(state.revision),
        ));
        commit_allowance_command_revision(&result.state, state.revision + 1, Some(command)).unwrap()
    }

    fn current_ledger(state: &AllowanceAuthorityState, category: &str) -> AllowanceLedger {
        serde_json::from_value(state.categories[category].ledger.clone()).unwrap()
    }

    #[test]
    fn configure_creates_template_without_advancing_history() {
        let state = configured();
        assert_eq!(state.revision, 1);
        let ledger = current_ledger(&state, CATEGORY);
        assert_eq!(ledger.spent_ms, 0);
        assert_eq!(ledger.day_key, EMPTY_DAY_KEY);
        let update = configure_command(2);
        let result = command_ok(apply_allowance_command(&state, &update, Some(1)));
        assert_eq!(result.state.revision, 1);
        assert_eq!(
            result.state.categories[CATEGORY].config.daily_allowance_ms,
            10 * MINUTE
        );
        assert_eq!(
            result.state.categories[CATEGORY].ledger,
            state.categories[CATEGORY].ledger
        );
    }

    #[test]
    fn stale_bases_and_bad_identities_refuse_immutably() {
        let state = configured();
        let snapshot = state.clone();
        let command = request_command(2, MINUTE);
        command_rejected(
            apply_allowance_command(&state, &command, Some(0)),
            AllowanceCommandRefusal::Revision,
        );
        let mut raw = value_of(&command);
        raw["operationId"] = json!("bad");
        command_rejected(
            apply_allowance_command_value(&value_of(&state), &raw, None),
            AllowanceCommandRefusal::InvalidOperation,
        );
        raw = value_of(&command);
        raw["category"] = json!(" ");
        command_rejected(
            apply_allowance_command_value(&value_of(&state), &raw, None),
            AllowanceCommandRefusal::InvalidCategory,
        );
        assert_eq!(state, snapshot);
    }

    #[test]
    fn request_commit_assigns_one_higher_safe_revision() {
        let state = configured();
        let command = request_command(2, 2 * MINUTE);
        let next = accepted(&state, &command);
        assert_eq!(next.revision, 2);
        assert_eq!(
            current_ledger(&next, CATEGORY).grant.unwrap().status,
            AllowanceGrantStatus::Active
        );
        assert!(commit_allowance_command_revision(&next, 2, None).is_err());
        assert!(
            commit_allowance_command_revision(&next, MAX_ALLOWANCE_TIMESTAMP_MS + 1, None).is_err()
        );
        let unchanged = next.clone();
        let without_receipt = commit_allowance_command_revision(&next, 3, None).unwrap();
        assert_eq!(without_receipt.receipts, next.receipts);
        assert_eq!(next, unchanged);
    }

    #[test]
    fn matching_duplicate_ignores_stale_base_and_mismatch_refuses() {
        let mut state = configured();
        let request = request_command(2, 2 * MINUTE);
        state = accepted(&state, &request);
        let reward = reward_command_at(3, T0, DAY, MINUTE);
        state = accepted(&state, &reward);
        let retry = command_ok(apply_allowance_command(&state, &request, Some(999)));
        assert_eq!(retry.duplicate, Some(true));
        assert_eq!(retry.state.revision, 3);
        assert_eq!(retry.state.receipts.len(), 3);
        assert_eq!(current_ledger(&retry.state, CATEGORY).waiting_escalation, 1);
        assert!(retry.grant.is_none());
        command_rejected(
            apply_allowance_command(&state, &request_command(2, 3 * MINUTE), None),
            AllowanceCommandRefusal::DuplicateOperation,
        );
    }

    #[test]
    fn categories_share_revision_but_not_pools() {
        let mut state = configured();
        state = accepted(&state, &configure_command_at(2, "social media"));
        state = accepted(&state, &request_command(3, 4 * MINUTE));
        state = accepted(
            &state,
            &request_command_at(4, "social media", "g4", T0, DAY, (5 * MINUTE) as f64),
        );
        assert_eq!(state.revision, 4);
        assert_eq!(
            current_ledger(&state, CATEGORY).grant.unwrap().duration_ms,
            4 * MINUTE
        );
        assert_eq!(
            current_ledger(&state, "social media")
                .grant
                .unwrap()
                .duration_ms,
            5 * MINUTE
        );
        assert_eq!(current_ledger(&state, "social media").spent_ms, 0);
    }

    #[test]
    fn authority_cancel_reward_and_rollback_match_math() {
        let mut state = configured();
        state = accepted(&state, &request_command(2, 5 * MINUTE));
        let cancel = AllowanceCommand::Cancel {
            operation_id: operation_id(3),
            category: CATEGORY.to_owned(),
            grant_id: "g2".to_owned(),
            now_ms: T0 + MINUTE as f64,
            day_key: DAY.to_owned(),
        };
        state = accepted(&state, &cancel);
        let current = current_ledger(&state, CATEGORY);
        assert_eq!(current.spent_ms, MINUTE);
        assert_eq!(current.grant.unwrap().refunded_ms, 4 * MINUTE);
        assert_eq!(current.waiting_escalation, 1);

        let mut state = configured();
        state = accepted(&state, &reward_command_at(2, T0, DAY, 5 * MINUTE));
        assert_eq!(
            current_ledger(&state, CATEGORY).earned_reward_ms,
            3 * MINUTE
        );
        command_rejected(
            apply_allowance_command(&state, &reward_command_at(3, T0 - 1.0, DAY, MINUTE), None),
            AllowanceCommandRefusal::ClockRollback,
        );
        command_rejected(
            apply_allowance_command(
                &state,
                &reward_command_at(3, T0, "2026-11-07", MINUTE),
                None,
            ),
            AllowanceCommandRefusal::DayRollback,
        );
    }

    #[test]
    fn authority_accepts_reward_earning_config_and_reward_commands() {
        let mut config = authority_config();
        config.daily_allowance_ms = 0.0;
        config.daily_openings = 0.0;
        config.reward_cap_ms = MINUTE as f64;
        config.reward_earning = true;
        config.reward_work_ms = (5 * MINUTE) as f64;
        config.reward_award_ms = (2 * MINUTE) as f64;
        let configure = AllowanceCommand::Configure {
            operation_id: operation_id(2),
            category: CATEGORY.to_owned(),
            config,
        };
        let mut state = accepted(&empty_allowance_authority_state(), &configure);
        let stored = &state.categories.get(CATEGORY).expect("category").config;
        assert!(stored.reward_earning);
        assert_eq!(stored.reward_work_ms, 5 * MINUTE);
        assert_eq!(stored.reward_award_ms, 2 * MINUTE);

        state = accepted(&state, &reward_command_at(3, T0, DAY, 2 * MINUTE));
        assert_eq!(
            current_ledger(&state, CATEGORY).earned_reward_ms,
            MINUTE,
            "the authority's daily reward cap still bounds the credit"
        );
    }

    #[test]
    fn authority_opening_commands_use_count_and_monotonic_activity() {
        let mut state = configured();
        state = accepted(
            &state,
            &opening_command(AllowanceCommandKind::OpeningStart, 2, "g2", T0),
        );
        state = accepted(
            &state,
            &opening_command(
                AllowanceCommandKind::OpeningActivity,
                3,
                "g2",
                T0 + 30_000.0,
            ),
        );
        let current = current_ledger(&state, CATEGORY);
        assert_eq!(current.openings_used, 1);
        assert_eq!(
            current.grant.as_ref().unwrap().last_activity_at_ms,
            Some(T0 as u64 + 30_000)
        );
        assert_eq!(current.spent_ms, 0);
        assert_eq!(current.waiting_escalation, 0);
        command_rejected(
            apply_allowance_command(
                &state,
                &opening_command(AllowanceCommandKind::OpeningStart, 4, "g4", T0 + 31_000.0),
                None,
            ),
            AllowanceCommandRefusal::Overlap,
        );
        state = accepted(
            &state,
            &opening_command(AllowanceCommandKind::OpeningClose, 4, "g2", T0 + 31_000.0),
        );
        command_rejected(
            apply_allowance_command(
                &state,
                &opening_command(AllowanceCommandKind::OpeningStart, 5, "g5", T0 + 32_000.0),
                None,
            ),
            AllowanceCommandRefusal::NoOpenings,
        );
    }

    #[test]
    fn authority_pomodoro_observation_settles_without_counters() {
        let mut state = configured();
        let pomodoro = AllowanceCommand::PomodoroStart {
            operation_id: operation_id(2),
            category: CATEGORY.to_owned(),
            grant_id: "g2".to_owned(),
            now_ms: T0,
            day_key: DAY.to_owned(),
            duration_ms: (5 * MINUTE) as f64,
        };
        state = accepted(&state, &pomodoro);
        let derived =
            derive_allowance_category(&state, CATEGORY, &at(T0 + (5 * MINUTE) as f64)).unwrap();
        assert_eq!(
            derived.ledger.grant.unwrap().status,
            AllowanceGrantStatus::Ended
        );
        assert_eq!(derived.ledger.spent_ms, 0);
        assert_eq!(derived.ledger.openings_used, 0);
        assert_eq!(derived.ledger.waiting_escalation, 0);
        // Derivation is an observation view, not an implicit authority write.
        assert_ne!(
            current_ledger(&state, CATEGORY).grant.unwrap().status,
            AllowanceGrantStatus::Ended
        );
    }

    #[test]
    fn unknown_and_wrong_action_kinds_are_explicit_refusals() {
        let mut state = configured();
        state = accepted(&state, &request_command(2, MINUTE));
        command_rejected(
            apply_allowance_command(
                &state,
                &opening_command(AllowanceCommandKind::OpeningClose, 3, "g2", T0),
                None,
            ),
            AllowanceCommandRefusal::WrongGrantKind,
        );
        let unknown = json!({
            "kind": "unknown",
            "operationId": operation_id(3),
            "category": CATEGORY,
            "grantId": "g3",
            "nowMs": T0,
            "dayKey": DAY
        });
        command_rejected(
            apply_allowance_command_value(&value_of(&state), &unknown, None),
            AllowanceCommandRefusal::InvalidOperation,
        );
    }

    #[test]
    fn category_cap_and_bad_authority_version_never_fabricate_transitions() {
        let mut state = empty_allowance_authority_state();
        for number in 1..=MAX_ALLOWANCE_CATEGORIES as u64 {
            state = accepted(
                &state,
                &configure_command_at(number, &format!("c{}", number - 1)),
            );
        }
        let snapshot = state.clone();
        command_rejected(
            apply_allowance_command(&state, &configure_command_at(999, "overflow"), None),
            AllowanceCommandRefusal::CategoryLimit,
        );
        assert_eq!(state, snapshot);
        let result = command_rejected(
            apply_allowance_command(
                &json!({"version": 999, "revision": 0, "categories": {}}),
                &configure_command(1),
                None,
            ),
            AllowanceCommandRefusal::Version,
        );
        assert_eq!(result.state, empty_allowance_authority_state());
    }

    #[test]
    fn malformed_authority_top_level_and_receipts_are_neutral_errors() {
        let valid = configured();
        let receipts = value_of(&valid)["receipts"].clone();
        let mut invalid_states = vec![
            Value::Null,
            json!({"version": 1, "revision": -1, "categories": {}}),
            json!({"version": 1, "revision": MAX_ALLOWANCE_TIMESTAMP_MS + 1, "categories": {}}),
            json!({"version": 1, "revision": 0.5, "categories": {}}),
            json!({"version": 1, "revision": 0, "categories": []}),
            json!({"version": 1, "revision": 0, "categories": {" ": {"config": {}, "ledger": {"dayKey": DAY}}}}),
            json!({"version": 1, "revision": 0, "categories": {"ok": null}}),
            json!({"version": 1, "revision": 0, "categories": {"ok": {"config": {}, "ledger": {"dayKey": "2026-1-01"}}}}),
            json!({"version": 1, "revision": 0, "categories": {}, "receipts": null}),
        ];
        let mut too_many = json!({"version": 1, "revision": 0, "categories": {}});
        for index in 0..=MAX_ALLOWANCE_CATEGORIES {
            too_many["categories"][format!("c{index}")] = json!({
                "config": {},
                "ledger": {"dayKey": DAY}
            });
        }
        invalid_states.push(too_many);
        for invalid in invalid_states {
            assert!(
                normalize_allowance_authority_state(&invalid).is_none(),
                "{invalid}"
            );
        }

        let duplicate_receipt = json!([receipts[0].clone(), receipts[0].clone()]);
        let bad_receipt_lists = [
            json!([{"operationId": "bad", "fingerprint": "x", "revision": 1}]),
            json!([{"operationId": operation_id(1), "fingerprint": "", "revision": 1}]),
            json!([{"operationId": operation_id(1), "fingerprint": "x", "revision": 0}]),
            json!([{"operationId": operation_id(1), "fingerprint": "x", "revision": 2}]),
            duplicate_receipt,
            json!(vec![receipts[0].clone(); MAX_ALLOWANCE_RECEIPTS + 1]),
        ];
        for bad_receipts in bad_receipt_lists {
            let mut invalid = value_of(&valid);
            invalid["receipts"] = bad_receipts;
            assert!(normalize_allowance_authority_state(&invalid).is_none());
        }
        let mut no_receipts = value_of(&valid);
        no_receipts.as_object_mut().unwrap().remove("receipts");
        assert!(normalize_allowance_authority_state(&no_receipts)
            .unwrap()
            .receipts
            .is_empty());
    }

    #[test]
    fn accepted_receipt_log_is_atomic_capped_and_duplicate_safe() {
        let mut state = empty_allowance_authority_state();
        for number in 1..=65 {
            state = accepted(&state, &configure_command(number));
        }
        assert_eq!(state.revision, 65);
        assert_eq!(state.receipts.len(), 64);
        assert_eq!(
            state.receipts.first().unwrap().operation_id,
            operation_id(2)
        );
        assert_eq!(
            state.receipts.last().unwrap().operation_id,
            operation_id(65)
        );
        assert_eq!(state.receipts.last().unwrap().revision, 65);
        let snapshot = state.clone();
        let retry = command_ok(apply_allowance_command(
            &state,
            &configure_command(65),
            Some(0),
        ));
        assert_eq!(retry.duplicate, Some(true));
        assert_eq!(retry.state, snapshot);
    }

    #[test]
    fn raw_category_history_survives_configure_and_duplicate_retry() {
        let raw_ledger = json!({
            "version": 1,
            "dayKey": "2026-02-30",
            "spentMs": "not-yet-sanitized",
            "customPersistedField": {"preserved": true}
        });
        let raw = json!({
            "version": 1,
            "revision": 0,
            "categories": {
                CATEGORY: {"config": {}, "ledger": raw_ledger.clone()}
            }
        });
        let command = configure_command(1);
        let configured = command_ok(apply_allowance_command(&raw, &command, Some(0)));
        assert_eq!(configured.state.categories[CATEGORY].ledger, raw_ledger);
        let committed =
            commit_allowance_command_revision(&configured.state, 1, Some(&command)).unwrap();
        let retry = command_ok(apply_allowance_command(&committed, &command, Some(999)));
        assert_eq!(retry.state.categories[CATEGORY].ledger, raw_ledger);
        assert_eq!(retry.state.revision, 1);
    }

    #[test]
    fn command_serde_is_camel_case_and_closed_to_unknown_fields() {
        let raw = json!({
            "kind": "request",
            "operationId": operation_id(2),
            "category": CATEGORY,
            "grantId": "g2",
            "nowMs": T0,
            "dayKey": DAY,
            "durationMs": MINUTE as f64
        });
        let command = serde_json::from_value::<AllowanceCommand>(raw.clone()).unwrap();
        assert_eq!(command, request_command(2, MINUTE));
        assert_eq!(value_of(&command), raw);
        let mut extra = raw;
        extra["unexpected"] = json!(true);
        assert!(serde_json::from_value::<AllowanceCommand>(extra).is_err());
    }

    #[test]
    fn typescript_fingerprint_and_public_state_goldens_match_exactly() {
        // Captured by executing the source-of-truth TS reducer under Node v24.
        let configure = configure_command(1);
        assert_eq!(
            fingerprint_allowance_command(&configure),
            "[\"configure\",\"00000000000000000000000000000001\",\"video games\",null,null,null,null,null,{\"dailyAllowanceMs\":600000,\"dailyOpenings\":1,\"waitingBaseMs\":0,\"waitingStepMs\":0,\"waitingMaxMs\":0,\"rewardCapMs\":180000,\"rewardEarning\":false,\"rewardWorkMs\":300000,\"rewardAwardMs\":60000,\"openingInactivityMs\":120000,\"openingMaxLifetimeMs\":1800000}]"
        );
        let applied = command_ok(apply_allowance_command(
            &empty_allowance_authority_state(),
            &configure,
            None,
        ));
        let state = commit_allowance_command_revision(&applied.state, 1, Some(&configure)).unwrap();
        assert_eq!(
            value_of(&state),
            json!({
                "version": 1,
                "revision": 1,
                "categories": {
                    CATEGORY: {
                        "config": {
                            "dailyAllowanceMs": 600000,
                            "dailyOpenings": 1,
                            "waitingBaseMs": 0,
                            "waitingStepMs": 0,
                            "waitingMaxMs": 0,
                            "rewardCapMs": 180000,
                            "rewardEarning": false,
                            "rewardWorkMs": 300000,
                            "rewardAwardMs": 60000,
                            "openingInactivityMs": 120000,
                            "openingMaxLifetimeMs": 1800000
                        },
                        "ledger": {
                            "version": 1,
                            "dayKey": "1970-01-01",
                            "spentMs": 0,
                            "earnedRewardMs": 0,
                            "openingsUsed": 0,
                            "waitingEscalation": 0,
                            "lastObservedAtMs": 0,
                            "grant": null
                        }
                    }
                },
                "receipts": [{
                    "operationId": operation_id(1),
                    "fingerprint": fingerprint_allowance_command(&configure),
                    "revision": 1
                }]
            })
        );
        let request = request_command(2, 2 * MINUTE);
        assert_eq!(
            fingerprint_allowance_command(&request),
            "[\"request\",\"00000000000000000000000000000002\",\"video games\",\"g2\",1800000000000,\"2026-11-08\",120000,null,null]"
        );
    }
}
