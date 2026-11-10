//! Local desktop application-usage analytics: **active foreground app time**
//! per **local day**, with a bounded, versioned, sanitized store.
//!
//! Privacy boundary: the durable state contains an app identifier derived
//! from the executable's file name plus a bounded display label, and
//! millisecond totals. It never contains a window title, a document name, a
//! URL, a command line, or a package identity. Everything stays in the
//! companion's local data dir; there is no network path.
//!
//! Semantics:
//! - One sample per [`USAGE_TICK_MS`]. Only the interval that ENDED at a
//!   sample is charged, and only when the sample reports recent input
//!   (`idle_ms < USAGE_IDLE_THRESHOLD_MS`) and the gap is bounded
//!   ([`USAGE_MAX_SAMPLE_GAP_MS`]). A daemon that was asleep therefore
//!   discards the whole gap instead of manufacturing active time.
//! - `activeMs` is time the foreground app was attributed while the user was
//!   active. `wallMs` is the sum of the same bounded awake intervals,
//!   including idle time, so the UI can say "2h active of 6h at the
//!   computer". They are deliberately separate.
//! - Intervals are split at the LOCAL next midnight, so a day boundary or a
//!   23/25-hour DST day never leaks time into the neighbouring day.
//! - A persisted checkpoint restores continuity across a quick daemon
//!   restart; a long shutdown is discarded by the same gap bound.
//!
//! The Windows probe is a thin `#[cfg(windows)]` module over
//! `GetForegroundWindow` + process image + `GetLastInputInfo`. Other
//! platforms report `available: false` rather than guessing. The tracker and
//! its clock math are platform-independent and testable on Linux.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Days, Local, LocalResult, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Store;

pub const USAGE_STATE_FILE: &str = "usage-state.json";
pub const USAGE_STATE_VERSION: u32 = 1;
/// Retained local calendar days, including today.
pub const USAGE_RETENTION_DAYS: u32 = 35;
/// Hard cap on distinct app labels per day, including the overflow bucket.
pub const USAGE_MAX_APPS_PER_DAY: usize = 80;
/// Hard cap on stored days; retention normally keeps this at 35, and the
/// cushion absorbs a backwards clock jump without unbounded file growth.
pub const USAGE_MAX_STORED_DAYS: usize = 40;
pub const USAGE_OTHER_APP_ID: &str = "other.apps";
pub const USAGE_OTHER_APP_LABEL: &str = "Other apps";
/// A sample older than this many milliseconds is treated as the machine
/// having slept / the daemon having been stopped, and the whole gap is
/// discarded. Deliberately much smaller than any real sleep.
pub const USAGE_MAX_SAMPLE_GAP_MS: u64 = 30_000;
/// The extension uses the same 30-second idle gate.
pub const USAGE_IDLE_THRESHOLD_MS: u64 = 30_000;
/// Foreground sampling cadence in the daemon loop.
pub const USAGE_TICK_MS: u64 = 5_000;
/// Batched disk writes keep a per-second tracker from hammering the store.
pub const USAGE_PERSIST_INTERVAL_MS: i64 = 15_000;
/// A 25-hour local day is the largest civil day a DST transition can
/// produce. Totals are clamped to it so a corrupt or hostile file cannot
/// claim multiple days of time in one day.
pub const USAGE_MAX_DAY_MS: u64 = 25 * 60 * 60 * 1_000;

const MAX_APP_ID_CHARS: usize = 80;
const MAX_APP_LABEL_CHARS: usize = 120;
const OTHER_BUCKET_MIN_ACTIVE: u64 = 0;

/// One app identity. `id` is the lowercase executable stem used for matching
/// (and for the friendly-name table); `label` is the original basename, so
/// "Code" stays readable in an export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageApp {
    pub id: String,
    pub label: String,
}

impl UsageApp {
    /// From a full executable path: basename without `.exe`, original case
    /// preserved in `label`, normalized in `id`. Splits on both separators so
    /// a Windows path is readable on a Linux test host too.
    pub fn from_exe_path(path: &Path) -> Option<Self> {
        let raw = path.to_string_lossy();
        let basename = raw.rsplit(['\\', '/']).find(|part| !part.is_empty())?;
        Self::from_label(basename)
    }

    pub fn from_label(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        let without_ext = trimmed
            .strip_suffix(".exe")
            .or_else(|| trimmed.strip_suffix(".EXE"))
            .unwrap_or(trimmed);
        let label: String = without_ext
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_APP_LABEL_CHARS)
            .collect();
        let id = clean_app_id(&label)?;
        Some(Self { id, label })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageAppBucket {
    pub label: String,
    pub active_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageDay {
    /// Bounded awake-time observation for this local day, idle included.
    pub wall_ms: u64,
    /// Keyed by normalized app id.
    pub apps: BTreeMap<String, UsageAppBucket>,
}

impl UsageDay {
    pub fn active_ms(&self) -> u64 {
        self.apps.values().fold(0u64, |sum, app| {
            sum.saturating_add(app.active_ms).min(USAGE_MAX_DAY_MS)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCheckpoint {
    pub at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<UsageApp>,
    /// The previous sample was foreground + not idle. Recovery may charge a
    /// bounded gap only when this is true.
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageState {
    pub version: u32,
    pub days: BTreeMap<String, UsageDay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<UsageCheckpoint>,
}

impl Default for UsageState {
    fn default() -> Self {
        Self {
            version: USAGE_STATE_VERSION,
            days: BTreeMap::new(),
            checkpoint: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub active_ms: u64,
    pub wall_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayTotal {
    pub date: String,
    pub active_ms: u64,
    pub wall_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAppTotal {
    pub id: String,
    pub label: String,
    pub active_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// False on platforms where the companion cannot see the foreground app.
    pub available: bool,
    pub platform: String,
    pub retention_days: u32,
    pub period_days: u32,
    pub generated_at_ms: i64,
    /// Newest first, one entry per local day in the selected period
    /// (including zero-usage days).
    pub days: Vec<UsageDayTotal>,
    pub totals: UsageTotals,
    /// Aggregated across the selected period, sorted by active time desc.
    pub apps: Vec<UsageAppTotal>,
    pub last_sample_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAppExport {
    pub id: String,
    pub label: String,
    pub active_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayExport {
    pub date: String,
    pub active_ms: u64,
    pub wall_ms: u64,
    pub apps: Vec<UsageAppExport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetricDefinitions {
    pub active_ms: String,
    pub wall_ms: String,
    pub app_identity: String,
    pub idle_and_sleep: String,
    pub retention: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageExport {
    pub version: u32,
    pub generated_at_ms: i64,
    pub retention_days: u32,
    pub period_days: u32,
    pub platform: String,
    pub metric_definitions: UsageMetricDefinitions,
    /// Newest first, bounded by the selected period.
    pub days: Vec<UsageDayExport>,
}

/// One foreground observation. `idle_ms` is milliseconds since the last
/// user input; a platform without the signal reports 0 and is unavailable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundSample {
    pub app: Option<UsageApp>,
    pub idle_ms: u64,
}

impl ForegroundSample {
    pub fn active() -> Self {
        Self {
            app: None,
            idle_ms: 0,
        }
    }

    pub fn with_app(app: UsageApp) -> Self {
        Self {
            app: Some(app),
            idle_ms: 0,
        }
    }
}

/// The focused, testable seam for foreground-process detection. Implementors
/// must be cheap: the daemon calls this every [`USAGE_TICK_MS`].
pub trait ForegroundProbe: Send {
    fn platform(&self) -> &'static str;
    fn available(&self) -> bool;
    fn sample(&mut self) -> ForegroundSample;
}

/// Non-Windows / headless fallback: honest unavailability beats guessing a
/// "foreground" process from a process table that has no focus concept.
pub struct UnavailableProbe;

impl ForegroundProbe for UnavailableProbe {
    fn platform(&self) -> &'static str {
        platform_name()
    }

    fn available(&self) -> bool {
        false
    }

    fn sample(&mut self) -> ForegroundSample {
        ForegroundSample::active()
    }
}

pub fn default_probe() -> Box<dyn ForegroundProbe> {
    #[cfg(windows)]
    {
        Box::new(windows_probe::WindowsProbe)
    }
    #[cfg(not(windows))]
    {
        Box::new(UnavailableProbe)
    }
}

pub fn platform_name() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// Local-day math (pure; generic over a TimeZone so tests can exercise DST)
// ---------------------------------------------------------------------------

fn resolve_datetime<Tz: TimeZone>(result: LocalResult<DateTime<Tz>>) -> Option<DateTime<Tz>> {
    match result {
        LocalResult::Single(dt) => Some(dt),
        // A repeated local time: either instant maps to the same local
        // clock reading. For a day boundary, earliest is the start of the
        // civil day.
        LocalResult::Ambiguous(earliest, _) => Some(earliest),
        LocalResult::None => None,
    }
}

pub fn local_date<Tz: TimeZone>(tz: &Tz, at_ms: i64) -> Option<NaiveDate> {
    resolve_datetime(tz.timestamp_millis_opt(at_ms)).map(|dt| dt.date_naive())
}

pub fn local_day_id<Tz: TimeZone>(tz: &Tz, at_ms: i64) -> Option<String> {
    local_date(tz, at_ms).map(|date| date.format("%Y-%m-%d").to_string())
}

/// The first valid instant of `date` in `tz`. DST can skip local midnight
/// (some zones spring forward at 00:00); scan forward to the first real
/// local time so a day always has a start.
fn day_start_ms<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> Option<i64> {
    let midnight = date.and_hms_opt(0, 0, 0)?;
    for minutes in (0..=180).step_by(15) {
        let local = midnight.checked_add_signed(chrono::Duration::minutes(minutes))?;
        if let Some(dt) = resolve_datetime(tz.from_local_datetime(&local)) {
            return Some(dt.timestamp_millis());
        }
    }
    None
}

/// Start of the local day AFTER the one containing `at_ms`.
pub fn next_local_midnight<Tz: TimeZone>(tz: &Tz, at_ms: i64) -> Option<i64> {
    let date = local_date(tz, at_ms)?;
    day_start_ms(tz, date.succ_opt()?)
}

/// Split `[start, end)` into (local date, duration) chunks. Handles 23/25h
/// DST days because each boundary is an explicit civil date, not +24h.
pub fn split_local_days<Tz: TimeZone>(
    tz: &Tz,
    start_ms: i64,
    end_ms: i64,
) -> Vec<(NaiveDate, u64)> {
    let mut chunks = Vec::new();
    if end_ms <= start_ms {
        return chunks;
    }
    let mut cursor = start_ms;
    // A bounded loop: 35 days is the retention scale, and a bad timezone
    // implementation must not spin forever.
    for _ in 0..(USAGE_MAX_STORED_DAYS + 2) {
        if cursor >= end_ms {
            break;
        }
        let Some(date) = local_date(tz, cursor) else {
            break;
        };
        let Some(boundary) = next_local_midnight(tz, cursor) else {
            break;
        };
        let chunk_end = boundary.min(end_ms);
        if chunk_end <= cursor {
            break;
        }
        chunks.push((date, (chunk_end - cursor) as u64));
        cursor = chunk_end;
    }
    chunks
}

fn period_start(today: NaiveDate, period_days: u32) -> NaiveDate {
    today
        .checked_sub_days(Days::new(u64::from(period_days.saturating_sub(1))))
        .unwrap_or(today)
}

fn normalize_period(period_days: u32) -> u32 {
    period_days.clamp(1, USAGE_RETENTION_DAYS)
}

fn parse_day(value: &str) -> Option<NaiveDate> {
    if value.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

// ---------------------------------------------------------------------------
// Sanitization + retention
// ---------------------------------------------------------------------------

fn clean_app_id(raw: &str) -> Option<String> {
    let id: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_APP_ID_CHARS)
        .collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn clean_label(raw: &str, fallback: &str) -> String {
    let label: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_APP_LABEL_CHARS)
        .collect();
    if label.is_empty() {
        fallback.to_string()
    } else {
        label
    }
}

/// Fold every app beyond the per-day cap into one explicit overflow bucket.
/// The top entries are kept by active time, so the UI's Top-N stays stable
/// even if a file was written by an older/buggier build.
fn bound_day_apps(apps: &mut BTreeMap<String, UsageAppBucket>) {
    if apps.len() <= USAGE_MAX_APPS_PER_DAY {
        return;
    }
    let mut entries: Vec<(String, UsageAppBucket)> = std::mem::take(apps).into_iter().collect();
    entries
        .sort_by(|(a_id, a), (b_id, b)| b.active_ms.cmp(&a.active_ms).then_with(|| a_id.cmp(b_id)));
    let mut kept = 0usize;
    let mut overflow = 0u64;
    for (id, bucket) in entries {
        if kept < USAGE_MAX_APPS_PER_DAY - 1 || id == USAGE_OTHER_APP_ID {
            if id == USAGE_OTHER_APP_ID {
                overflow = overflow.saturating_add(bucket.active_ms);
            } else {
                kept += 1;
                apps.insert(id, bucket);
            }
        } else {
            overflow = overflow.saturating_add(bucket.active_ms);
        }
    }
    if overflow > 0 || !apps.is_empty() {
        apps.insert(
            USAGE_OTHER_APP_ID.to_string(),
            UsageAppBucket {
                label: USAGE_OTHER_APP_LABEL.to_string(),
                active_ms: overflow.min(USAGE_MAX_DAY_MS),
            },
        );
    }
}

fn normalize_day(mut day: UsageDay) -> UsageDay {
    day.wall_ms = day.wall_ms.min(USAGE_MAX_DAY_MS);
    let mut remaining = day.wall_ms;
    for (id, bucket) in day.apps.iter_mut() {
        if id == USAGE_OTHER_APP_ID && bucket.label.trim().is_empty() {
            bucket.label = USAGE_OTHER_APP_LABEL.to_string();
        }
        bucket.active_ms = bucket.active_ms.min(remaining);
        remaining = remaining.saturating_sub(bucket.active_ms);
        if bucket.active_ms == 0 && id != USAGE_OTHER_APP_ID {
            // Keep a zero bucket if it was explicitly stored; it is tiny and
            // gives a stable row. The bound below still applies.
            bucket.active_ms = 0;
        }
    }
    bound_day_apps(&mut day.apps);
    day
}

/// Accept only the current version and a bounded, well-typed shape. Invalid
/// days/apps are dropped; valid values are clamped. A missing/corrupt store
/// therefore reads as "no usage yet", never a crash.
pub fn sanitize_usage_state(value: &Value) -> UsageState {
    let Some(object) = value.as_object() else {
        return UsageState::default();
    };
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(USAGE_STATE_VERSION)) {
        return UsageState::default();
    }

    let mut state = UsageState::default();
    if let Some(days) = object.get("days").and_then(Value::as_object) {
        for (raw_date, raw_day) in days {
            let Some(date) = parse_day(raw_date) else {
                continue;
            };
            let Some(day_object) = raw_day.as_object() else {
                continue;
            };
            let mut day = UsageDay {
                wall_ms: day_object
                    .get("wallMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(USAGE_MAX_DAY_MS),
                apps: BTreeMap::new(),
            };
            if let Some(apps) = day_object.get("apps").and_then(Value::as_object) {
                for (raw_id, raw_bucket) in apps {
                    let Some(id) = clean_app_id(raw_id) else {
                        continue;
                    };
                    let Some(bucket_object) = raw_bucket.as_object() else {
                        continue;
                    };
                    let active_ms = bucket_object
                        .get("activeMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .min(USAGE_MAX_DAY_MS);
                    let raw_label = bucket_object
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let label = clean_label(raw_label, &id);
                    let entry = day.apps.entry(id).or_insert(UsageAppBucket {
                        label,
                        active_ms: 0,
                    });
                    entry.active_ms = entry
                        .active_ms
                        .saturating_add(active_ms)
                        .min(USAGE_MAX_DAY_MS);
                }
            }
            state.days.insert(date.format("%Y-%m-%d").to_string(), day);
        }
    }

    if let Some(raw_checkpoint) = object.get("checkpoint").and_then(Value::as_object) {
        if let Some(at_ms) = raw_checkpoint.get("atMs").and_then(Value::as_i64) {
            if at_ms >= 0 {
                let app = raw_checkpoint
                    .get("app")
                    .and_then(Value::as_object)
                    .and_then(|app| {
                        let id = app.get("id").and_then(Value::as_str)?;
                        let label = app.get("label").and_then(Value::as_str).unwrap_or(id);
                        let id = clean_app_id(id)?;
                        Some(UsageApp {
                            id,
                            label: clean_label(label, &raw_id_fallback(label)),
                        })
                    });
                state.checkpoint = Some(UsageCheckpoint {
                    at_ms,
                    app,
                    active: raw_checkpoint
                        .get("active")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
        }
    }

    // Bound the number of days first (newest keys survive).
    while state.days.len() > USAGE_MAX_STORED_DAYS {
        let Some(first) = state.days.keys().next().cloned() else {
            break;
        };
        state.days.remove(&first);
    }
    for day in state.days.values_mut() {
        *day = normalize_day(std::mem::take(day));
    }
    state
}

fn raw_id_fallback(label: &str) -> String {
    clean_app_id(label).unwrap_or_else(|| "app".to_string())
}

/// Drop days older than the retention window. Future days (clock moved
/// backwards) stay until they become current; the file-size bound still
/// applies.
pub fn prune_usage_state(state: &mut UsageState, now_ms: i64) {
    let Some(today) = local_date(&Local, now_ms) else {
        return;
    };
    let oldest = period_start(today, USAGE_RETENTION_DAYS);
    state
        .days
        .retain(|day, _| parse_day(day).map(|date| date >= oldest).unwrap_or(false));
    while state.days.len() > USAGE_MAX_STORED_DAYS {
        let Some(first) = state.days.keys().next().cloned() else {
            break;
        };
        state.days.remove(&first);
    }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObserveOutcome {
    /// The durable state changed (a checkpoint or a total).
    pub changed: bool,
    /// Added active app time this sample.
    pub active_ms: u64,
}

pub struct UsageTracker {
    store: Store,
    state: UsageState,
    available: bool,
    platform: &'static str,
    dirty: bool,
    last_persist_at_ms: i64,
}

impl UsageTracker {
    pub fn load(store: Store, now_ms: i64, available: bool, platform: &'static str) -> Self {
        let state = store
            .load_usage_state()
            .map(|raw| sanitize_usage_state(&raw))
            .unwrap_or_default();
        let mut tracker = Self {
            store,
            state,
            available,
            platform,
            dirty: false,
            last_persist_at_ms: now_ms,
        };
        prune_usage_state(&mut tracker.state, now_ms);
        tracker
    }

    pub fn available(&self) -> bool {
        self.available
    }

    pub fn platform(&self) -> &'static str {
        self.platform
    }

    /// Charge the interval that ended at `now_ms` using the PREVIOUS
    /// checkpoint, then install this sample. `sample.idle_ms` decides whether
    /// the interval counts as active; the bounded gap discards sleep and long
    /// pauses. Returns whether durable state changed and how much active time
    /// this sample added.
    pub fn observe(&mut self, now_ms: i64, sample: &ForegroundSample) -> ObserveOutcome {
        if now_ms < 0 {
            return ObserveOutcome {
                changed: false,
                active_ms: 0,
            };
        }
        let mut added_active = 0u64;
        let mut changed = false;
        if let Some(previous) = self.state.checkpoint.clone() {
            if now_ms > previous.at_ms {
                let gap = (now_ms - previous.at_ms) as u64;
                if gap <= USAGE_MAX_SAMPLE_GAP_MS {
                    self.add_wall(previous.at_ms, now_ms);
                    changed = true;
                    if previous.active {
                        if let Some(app) = previous.app.as_ref() {
                            if sample.idle_ms < USAGE_IDLE_THRESHOLD_MS {
                                added_active = self.add_active(previous.at_ms, now_ms, app);
                            }
                        }
                    }
                }
            }
        }
        let active = sample.idle_ms < USAGE_IDLE_THRESHOLD_MS && sample.app.is_some();
        let next_checkpoint = UsageCheckpoint {
            at_ms: now_ms,
            app: sample.app.clone(),
            active,
        };
        if self.state.checkpoint.as_ref() != Some(&next_checkpoint) {
            self.state.checkpoint = Some(next_checkpoint);
            changed = true;
        }
        prune_usage_state(&mut self.state, now_ms);
        if changed {
            self.dirty = true;
        }
        ObserveOutcome {
            changed,
            active_ms: added_active,
        }
    }

    fn day_mut(&mut self, date: NaiveDate) -> &mut UsageDay {
        self.state
            .days
            .entry(date.format("%Y-%m-%d").to_string())
            .or_default()
    }

    fn add_wall(&mut self, start_ms: i64, end_ms: i64) {
        for (date, ms) in split_local_days(&Local, start_ms, end_ms) {
            let day = self.day_mut(date);
            day.wall_ms = day.wall_ms.saturating_add(ms).min(USAGE_MAX_DAY_MS);
        }
    }

    fn add_active(&mut self, start_ms: i64, end_ms: i64, app: &UsageApp) -> u64 {
        let mut total = 0u64;
        for (date, ms) in split_local_days(&Local, start_ms, end_ms) {
            let day = self.day_mut(date);
            let bucket = match day.apps.get_mut(&app.id) {
                Some(bucket) => bucket,
                None => {
                    if day.apps.len() >= USAGE_MAX_APPS_PER_DAY - 1
                        && !day.apps.contains_key(USAGE_OTHER_APP_ID)
                    {
                        day.apps
                            .entry(USAGE_OTHER_APP_ID.to_string())
                            .or_insert(UsageAppBucket {
                                label: USAGE_OTHER_APP_LABEL.to_string(),
                                active_ms: OTHER_BUCKET_MIN_ACTIVE,
                            });
                        day.apps.get_mut(USAGE_OTHER_APP_ID).unwrap()
                    } else if day.apps.len() >= USAGE_MAX_APPS_PER_DAY
                        && !day.apps.contains_key(&app.id)
                    {
                        day.apps.get_mut(USAGE_OTHER_APP_ID).unwrap()
                    } else {
                        day.apps.entry(app.id.clone()).or_insert(UsageAppBucket {
                            label: app.label.clone(),
                            active_ms: 0,
                        })
                    }
                }
            };
            bucket.active_ms = bucket.active_ms.saturating_add(ms).min(USAGE_MAX_DAY_MS);
            total = total.saturating_add(ms);
        }
        total
    }

    pub fn maybe_persist(&mut self, now_ms: i64) -> std::io::Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        // A backwards clock jump shouldn't suspend persistence until the old
        // timestamp catches up; an interval that "hasn't elapsed" is still a
        // safe moment to checkpoint.
        if now_ms >= self.last_persist_at_ms
            && now_ms - self.last_persist_at_ms < USAGE_PERSIST_INTERVAL_MS
        {
            return Ok(false);
        }
        self.flush()?;
        self.last_persist_at_ms = now_ms;
        Ok(true)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.store.save_usage_state(&self.state)?;
        self.dirty = false;
        Ok(())
    }

    pub fn summary(&self, now_ms: i64, period_days: u32) -> UsageSummary {
        summarize_usage_state(
            &self.state,
            now_ms,
            period_days,
            self.available,
            self.platform,
        )
    }

    pub fn export(&self, now_ms: i64, period_days: u32) -> UsageExport {
        export_usage_state(&self.state, now_ms, period_days, self.platform)
    }

    /// Safe clear: persist an empty state first, then reset memory and the
    /// checkpoint. A failed write therefore leaves the old totals visible and
    /// truthful (the UI reports the error), instead of showing zeros that the
    /// next daemon restart would undo. A cleared checkpoint also stops a
    /// restart from charging the pre-clear interval to an app.
    pub fn clear(&mut self, now_ms: i64) -> std::io::Result<()> {
        let cleared = UsageState::default();
        self.store.save_usage_state(&cleared)?;
        self.state = cleared;
        self.dirty = false;
        self.last_persist_at_ms = now_ms;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Summary + export (pure over a state)
// ---------------------------------------------------------------------------

fn period_days_list(today: NaiveDate, period_days: u32) -> Vec<NaiveDate> {
    let start = period_start(today, period_days);
    let mut days = Vec::with_capacity(period_days as usize);
    let mut date = start;
    for _ in 0..period_days {
        days.push(date);
        let Some(next) = date.succ_opt() else {
            break;
        };
        date = next;
    }
    days
}

pub fn summarize_usage_state(
    state: &UsageState,
    now_ms: i64,
    period_days: u32,
    available: bool,
    platform: &str,
) -> UsageSummary {
    let period_days = normalize_period(period_days);
    let today = local_date(&Local, now_ms).unwrap_or_else(|| Local::now().date_naive());
    let start = period_start(today, period_days);
    let mut latest = start;
    let mut totals = UsageTotals::default();
    let mut apps: BTreeMap<String, UsageAppTotal> = BTreeMap::new();

    for (raw_date, day) in &state.days {
        let Some(date) = parse_day(raw_date) else {
            continue;
        };
        // Future-dated rows (backwards clock) are retained but not counted
        // until their civil day arrives.
        if date < start || date > today {
            continue;
        }
        latest = latest.max(date);
        let active = day.active_ms();
        totals.active_ms = totals.active_ms.saturating_add(active);
        totals.wall_ms = totals.wall_ms.saturating_add(day.wall_ms);
        for (id, bucket) in &day.apps {
            let entry = apps.entry(id.clone()).or_insert_with(|| UsageAppTotal {
                id: id.clone(),
                label: bucket.label.clone(),
                active_ms: 0,
            });
            entry.active_ms = entry.active_ms.saturating_add(bucket.active_ms);
        }
    }

    // Newest first; every day in the period is represented so charts and
    // "7 days" comparisons do not shift their x-axis.
    let days = period_days_list(today, period_days)
        .into_iter()
        .rev()
        .map(|date| {
            let key = date.format("%Y-%m-%d").to_string();
            let day = state.days.get(&key);
            UsageDayTotal {
                date: key,
                active_ms: day.map(UsageDay::active_ms).unwrap_or(0),
                wall_ms: day.map(|d| d.wall_ms).unwrap_or(0),
            }
        })
        .collect();

    let mut app_totals: Vec<UsageAppTotal> = apps.into_values().collect();
    app_totals.sort_by(|a, b| {
        b.active_ms
            .cmp(&a.active_ms)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.id.cmp(&b.id))
    });

    let _ = latest;
    UsageSummary {
        available,
        platform: platform.to_string(),
        retention_days: USAGE_RETENTION_DAYS,
        period_days,
        generated_at_ms: now_ms,
        days,
        totals,
        apps: app_totals,
        last_sample_at_ms: state.checkpoint.as_ref().map(|c| c.at_ms),
    }
}

pub fn export_usage_state(
    state: &UsageState,
    now_ms: i64,
    period_days: u32,
    platform: &str,
) -> UsageExport {
    let period_days = normalize_period(period_days);
    let today = local_date(&Local, now_ms).unwrap_or_else(|| Local::now().date_naive());
    let start = period_start(today, period_days);
    let mut days: Vec<UsageDayExport> = state
        .days
        .iter()
        .filter_map(|(raw_date, day)| {
            let date = parse_day(raw_date)?;
            if date < start || date > today {
                return None;
            }
            let mut apps: Vec<UsageAppExport> = day
                .apps
                .iter()
                .map(|(id, bucket)| UsageAppExport {
                    id: id.clone(),
                    label: bucket.label.clone(),
                    active_ms: bucket.active_ms,
                })
                .collect();
            apps.sort_by(|a, b| {
                b.active_ms
                    .cmp(&a.active_ms)
                    .then_with(|| a.label.cmp(&b.label))
            });
            Some(UsageDayExport {
                date: raw_date.clone(),
                active_ms: day.active_ms(),
                wall_ms: day.wall_ms,
                apps,
            })
        })
        .collect();
    days.sort_by(|a, b| b.date.cmp(&a.date));

    UsageExport {
        version: USAGE_STATE_VERSION,
        generated_at_ms: now_ms,
        retention_days: USAGE_RETENTION_DAYS,
        period_days,
        platform: platform.to_string(),
        metric_definitions: UsageMetricDefinitions {
            active_ms:
                "Milliseconds attributed to the focused foreground app while the last user input was under 30 seconds old. Sampling is 5 seconds; gaps over 30 seconds (sleep, shutdown, daemon pause) are discarded."
                    .to_string(),
            wall_ms:
                "Sum of the same bounded awake sampling intervals, including idle time. Active time is always less than or equal to this."
                    .to_string(),
            app_identity:
                "The executable's file basename (no path, no window title, no document name, no URL), with a lowercase stem as the stable id."
                    .to_string(),
            idle_and_sleep:
                "No time is counted while the user is idle for 30 seconds or more, or across a sampling gap over 30 seconds. A quick daemon restart may recover at most one 30-second interval."
                    .to_string(),
            retention:
                "Local calendar days, including today; older days are pruned to the newest 35."
                    .to_string(),
        },
        days,
    }
}

/// Read-only helpers for the Tauri shell when the daemon is not running.
pub fn summary_from_store(
    store: &Store,
    now_ms: i64,
    period_days: u32,
    available: bool,
) -> UsageSummary {
    let state = store
        .load_usage_state()
        .map(|raw| sanitize_usage_state(&raw))
        .unwrap_or_default();
    summarize_usage_state(&state, now_ms, period_days, available, platform_name())
}

pub fn export_from_store(store: &Store, now_ms: i64, period_days: u32) -> UsageExport {
    let state = store
        .load_usage_state()
        .map(|raw| sanitize_usage_state(&raw))
        .unwrap_or_default();
    export_usage_state(&state, now_ms, period_days, platform_name())
}

pub fn clear_store(store: &Store, now_ms: i64) -> std::io::Result<()> {
    let mut tracker = UsageTracker::load(store.clone(), now_ms, true, platform_name());
    tracker.clear(now_ms)
}

// ---------------------------------------------------------------------------
// Windows foreground probe
// ---------------------------------------------------------------------------

/// `GetLastInputInfo` stores the low 32 bits of the tick count, while
/// `GetTickCount64` keeps growing. Compare in the same 32-bit domain and let
/// the subtraction wrap: the true idle span is always far below 49.7 days.
#[cfg(any(windows, test))]
fn idle_ms_from_ticks(now_tick: u64, last_input_tick: u32) -> u64 {
    u64::from((now_tick as u32).wrapping_sub(last_input_tick))
}

#[cfg(windows)]
mod windows_probe {
    //! Minimal focused-window probe. All unsafe calls are synchronous and
    //! scoped; no title text is read, so a document name can never enter the
    //! usage store.
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
    };

    use super::{idle_ms_from_ticks, ForegroundProbe, ForegroundSample, UsageApp};

    const UWP_FRAME_CLASS: &str = "ApplicationFrameWindow";
    const MAX_PATH_CHARS: usize = 32_768;

    pub struct WindowsProbe;

    unsafe extern "system" fn collect_child_pid(child: HWND, lparam: LPARAM) -> i32 {
        let pids = &mut *(lparam as *mut Vec<u32>);
        let mut pid = 0u32;
        GetWindowThreadProcessId(child, &mut pid);
        if pid != 0 {
            pids.push(pid);
        }
        1
    }

    unsafe fn window_class(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    unsafe fn exe_for_pid(pid: u32) -> Option<UsageApp> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = vec![0u16; MAX_PATH_CHARS];
        let mut size = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
        let _ = CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        let path = OsString::from_wide(&buf[..size as usize]);
        UsageApp::from_exe_path(std::path::Path::new(&path))
    }

    unsafe fn foreground_app() -> Option<UsageApp> {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut frame_pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut frame_pid);
        if frame_pid == 0 {
            return None;
        }
        let app = exe_for_pid(frame_pid);
        // Store apps draw inside ApplicationFrameHost; the frame process is
        // meaningless as an identity. Ask the frame's children for the real
        // app process, falling back to a direct lookup only if that fails.
        if window_class(hwnd) == UWP_FRAME_CLASS {
            let mut children: Vec<u32> = Vec::new();
            EnumChildWindows(
                hwnd,
                Some(collect_child_pid),
                &mut children as *mut Vec<u32> as LPARAM,
            );
            for pid in children.into_iter().filter(|pid| *pid != frame_pid) {
                if let Some(child_app) = exe_for_pid(pid) {
                    if child_app.id != "applicationframehost" {
                        return Some(child_app);
                    }
                }
            }
            if app.as_ref().is_some_and(|a| a.id == "applicationframehost") {
                return None;
            }
        }
        app.filter(|app| !is_session_plumbing(&app.id))
    }

    fn is_session_plumbing(id: &str) -> bool {
        matches!(
            id,
            "lockapp" | "logonui" | "winlogon" | "applicationframehost"
        )
    }

    fn idle_ms() -> u64 {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` lives across the synchronous call.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if ok == 0 {
            return 0;
        }
        let now = unsafe { GetTickCount64() };
        idle_ms_from_ticks(now, info.dwTime)
    }

    impl ForegroundProbe for WindowsProbe {
        fn platform(&self) -> &'static str {
            "windows"
        }

        fn available(&self) -> bool {
            true
        }

        fn sample(&mut self) -> ForegroundSample {
            // SAFETY: all calls are synchronous and operate on values owned
            // by this function; callbacks do not unwind.
            let app = unsafe { foreground_app() };
            ForegroundSample {
                app,
                idle_ms: idle_ms(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, FixedOffset, NaiveDateTime, NaiveTime};
    use serde_json::json;
    use tempfile::TempDir;

    fn store() -> (TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        (dir, store)
    }

    fn app(id: &str) -> UsageApp {
        UsageApp {
            id: id.to_string(),
            label: id.to_string(),
        }
    }

    fn sample(id: &str, idle_ms: u64) -> ForegroundSample {
        ForegroundSample {
            app: Some(app(id)),
            idle_ms,
        }
    }

    /// A DST zone with US-style transitions, independent of the test host's
    /// TZ. Implements the minimum `TimeZone` surface chrono needs.
    #[derive(Clone, Debug)]
    struct Eastern;

    fn est() -> FixedOffset {
        FixedOffset::west_opt(5 * 3600).unwrap()
    }
    fn edt() -> FixedOffset {
        FixedOffset::west_opt(4 * 3600).unwrap()
    }

    fn dst_bounds(year: i32) -> (NaiveDateTime, NaiveDateTime) {
        // 2026: DST starts Mar 8 02:00 EST (07:00 UTC), ends Nov 1 02:00
        // EDT (06:00 UTC). Fixed dates keep the test readable.
        (
            NaiveDate::from_ymd_opt(year, 3, 8)
                .unwrap()
                .and_hms_opt(7, 0, 0)
                .unwrap(),
            NaiveDate::from_ymd_opt(year, 11, 1)
                .unwrap()
                .and_hms_opt(6, 0, 0)
                .unwrap(),
        )
    }

    impl TimeZone for Eastern {
        type Offset = FixedOffset;

        fn from_offset(_: &Self::Offset) -> Self {
            Eastern
        }

        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<Self::Offset> {
            self.offset_from_local_datetime(&local.and_time(NaiveTime::MIN))
        }

        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<Self::Offset> {
            let mut candidates = Vec::new();
            for offset in [est(), edt()] {
                let utc = *local - offset;
                if self.offset_from_utc_datetime(&utc) == offset {
                    candidates.push(offset);
                }
            }
            // Earliest instant first (the larger UTC offset).
            candidates.sort_by_key(|o| std::cmp::Reverse(o.local_minus_utc()));
            match candidates.as_slice() {
                [] => LocalResult::None,
                [only] => LocalResult::Single(*only),
                [first, second, ..] => LocalResult::Ambiguous(*first, *second),
            }
        }

        fn offset_from_utc_date(&self, utc: &NaiveDate) -> Self::Offset {
            self.offset_from_utc_datetime(&utc.and_time(NaiveTime::MIN))
        }

        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> Self::Offset {
            let (start, end) = dst_bounds(utc.year());
            if *utc >= start && *utc < end {
                edt()
            } else {
                est()
            }
        }
    }

    fn local_ms(tz: &Eastern, y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        let naive = NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap();
        resolve_datetime(tz.from_local_datetime(&naive))
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn aggregation_attributes_interval_to_previous_app_and_skips_idle_tail() {
        let (_dir, store) = store();
        let mut tracker = UsageTracker::load(store, 0, true, "windows");
        let t0 = 1_700_000_000_000i64;
        tracker.observe(t0, &sample("code", 0));
        tracker.observe(t0 + 10_000, &sample("code", 0));
        tracker.observe(t0 + 20_000, &sample("chrome", 0));
        // Previous interval (chrome) ended with recent input, so it counts.
        tracker.observe(t0 + 30_000, &sample("chrome", 5_000));
        // The next interval ends fully idle: wall counts, app active does not.
        tracker.observe(t0 + 40_000, &sample("chrome", 40_000));

        let summary = tracker.summary(t0 + 40_000, 1);
        assert!(summary.available);
        assert_eq!(summary.totals.active_ms, 30_000);
        assert_eq!(summary.totals.wall_ms, 40_000);
        let apps: BTreeMap<_, _> = summary
            .apps
            .iter()
            .map(|a| (a.id.as_str(), a.active_ms))
            .collect();
        assert_eq!(apps["code"], 20_000);
        assert_eq!(apps["chrome"], 10_000);
    }

    #[test]
    fn idle_gap_and_sleep_gap_add_nothing() {
        let (_dir, store) = store();
        let mut tracker = UsageTracker::load(store, 0, true, "windows");
        let t0 = 1_700_000_000_000i64;
        tracker.observe(t0, &sample("steam", 0));
        tracker.observe(t0 + 5_000, &sample("steam", 40_000));
        let summary = tracker.summary(t0 + 5_000, 1);
        assert_eq!(summary.totals.active_ms, 0);
        assert_eq!(summary.totals.wall_ms, 5_000);

        // A sleep/stop gap over the bound discards even wall time.
        let before = summary.totals.wall_ms;
        tracker.observe(t0 + 5_000 + 8 * 60 * 60 * 1_000, &sample("steam", 0));
        let summary = tracker.summary(t0 + 5_000 + 8 * 60 * 60 * 1_000, 2);
        assert_eq!(summary.totals.active_ms, 0);
        assert_eq!(summary.totals.wall_ms, before);
    }

    #[test]
    fn midnight_rollover_splits_active_and_wall_time() {
        let (_dir, store) = store();
        let now = Local::now().timestamp_millis();
        let today = local_date(&Local, now).unwrap();
        let start = day_start_ms(&Local, today).unwrap();
        let next = day_start_ms(&Local, today.succ_opt().unwrap()).unwrap();
        let mut tracker = UsageTracker::load(store, next - 10_000, true, "windows");
        tracker.observe(next - 1_000, &sample("code", 0));
        tracker.observe(next + 2_000, &sample("code", 0));
        let state = &tracker.state;
        let before = state
            .days
            .get(&today.format("%Y-%m-%d").to_string())
            .unwrap();
        let after = state
            .days
            .get(&today.succ_opt().unwrap().format("%Y-%m-%d").to_string())
            .unwrap();
        assert_eq!(before.active_ms(), 1_000);
        assert_eq!(before.wall_ms, 1_000);
        assert_eq!(after.active_ms(), 2_000);
        assert_eq!(after.wall_ms, 2_000);
        assert!(next > start);
    }

    #[test]
    fn dst_day_boundaries_are_23_and_25_hours_not_24() {
        let tz = Eastern;
        // 2026-03-08 in this test zone is 23 hours long.
        let spring_start = day_start_ms(&tz, NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()).unwrap();
        let spring_next = day_start_ms(&tz, NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()).unwrap();
        assert_eq!(spring_next - spring_start, 23 * 60 * 60 * 1_000);

        // 2026-11-01 is 25 hours long.
        let fall_start = day_start_ms(&tz, NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()).unwrap();
        let fall_next = day_start_ms(&tz, NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()).unwrap();
        assert_eq!(fall_next - fall_start, 25 * 60 * 60 * 1_000);

        // Splitting across the fall-back boundary gives exactly one chunk
        // ending at the local day boundary, with no negative or duplicated
        // time.
        let before = local_ms(&tz, 2026, 11, 1, 23, 30);
        let after = local_ms(&tz, 2026, 11, 2, 0, 30);
        let chunks = split_local_days(&tz, before, after);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].0, NaiveDate::from_ymd_opt(2026, 11, 1).unwrap());
        assert_eq!(chunks[1].0, NaiveDate::from_ymd_opt(2026, 11, 2).unwrap());
        assert_eq!(chunks[0].1, 30 * 60 * 1_000);
        assert_eq!(chunks[1].1, 30 * 60 * 1_000);
    }

    #[test]
    fn spring_forward_gap_still_has_a_day_start() {
        let tz = Eastern;
        // 02:30 local does not exist on 2026-03-08; the fallback scan finds
        // the first real local instant after midnight.
        let start = day_start_ms(&tz, NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()).unwrap();
        assert_eq!(local_day_id(&tz, start).as_deref(), Some("2026-03-08"));
    }

    #[test]
    fn restart_recovery_is_bounded_and_quick_restart_continues() {
        let (_dir, store) = store();
        let t0 = 1_700_000_000_000i64;
        let mut first = UsageTracker::load(store.clone(), t0, true, "windows");
        first.observe(t0, &sample("slack", 0));
        first.flush().unwrap();

        // Quick restart: the persisted checkpoint is charged once.
        let mut second = UsageTracker::load(store.clone(), t0 + 5_000, true, "windows");
        second.observe(t0 + 5_000, &sample("slack", 0));
        second.flush().unwrap();
        let summary = second.summary(t0 + 5_000, 1);
        assert_eq!(summary.totals.active_ms, 5_000);
        assert_eq!(summary.totals.wall_ms, 5_000);

        // A restart after a long shutdown discards the gap.
        let mut third = UsageTracker::load(store, t0 + 3_600_000, true, "windows");
        third.observe(t0 + 3_600_000, &sample("slack", 0));
        let summary = third.summary(t0 + 3_600_000, 1);
        assert_eq!(summary.totals.active_ms, 5_000);
        assert_eq!(summary.totals.wall_ms, 5_000);
    }

    #[test]
    fn retention_keeps_35_local_days_and_export_is_bounded() {
        let now = Local::now().timestamp_millis();
        let today = local_date(&Local, now).unwrap();
        let mut state = UsageState::default();
        for offset in 0..45 {
            let date = today.checked_sub_days(Days::new(offset)).unwrap();
            state.days.insert(
                date.format("%Y-%m-%d").to_string(),
                UsageDay {
                    wall_ms: 60_000,
                    apps: BTreeMap::from([(
                        "code".to_string(),
                        UsageAppBucket {
                            label: "Code".to_string(),
                            active_ms: 30_000,
                        },
                    )]),
                },
            );
        }
        prune_usage_state(&mut state, now);
        assert_eq!(state.days.len(), USAGE_RETENTION_DAYS as usize);
        let oldest = period_start(today, USAGE_RETENTION_DAYS);
        for day in state.days.keys() {
            assert!(parse_day(day).unwrap() >= oldest);
        }
        let export = export_usage_state(&state, now, USAGE_RETENTION_DAYS, "windows");
        assert_eq!(export.days.len(), USAGE_RETENTION_DAYS as usize);
        assert_eq!(export.days[0].date, today.format("%Y-%m-%d").to_string());
        assert_eq!(export.days[0].active_ms, 30_000);
        assert_eq!(export.days[0].apps[0].id, "code");
    }

    #[test]
    fn per_day_apps_fold_into_other_and_state_stays_small() {
        let (_dir, store) = store();
        let now = Local::now().timestamp_millis();
        let today = local_date(&Local, now).unwrap();
        let start = day_start_ms(&Local, today).unwrap();
        let mut tracker = UsageTracker::load(store, now, true, "windows");
        tracker.observe(start, &sample("app-0", 0));
        let mut t = start;
        for i in 1..200 {
            t += 1_000;
            tracker.observe(t, &sample(&format!("app-{i}"), 0));
        }
        let day = tracker.state.days.values().next().unwrap();
        assert!(day.apps.len() <= USAGE_MAX_APPS_PER_DAY);
        assert!(day.apps.contains_key(USAGE_OTHER_APP_ID));
        let state = serde_json::to_vec(&tracker.state).unwrap();
        assert!(state.len() < 256 * 1024, "state was {} bytes", state.len());
        assert!(tracker.summary(t, 1).apps.len() <= USAGE_MAX_APPS_PER_DAY);
    }

    #[test]
    fn persistence_is_batched_and_flushes_after_a_backwards_clock_jump() {
        let (_dir, store) = store();
        let t0 = 1_700_000_000_000i64;
        let mut tracker = UsageTracker::load(store.clone(), t0, true, "windows");
        tracker.observe(t0, &sample("code", 0));
        assert!(!tracker.maybe_persist(t0 + 5_000).unwrap());
        assert!(tracker.maybe_persist(t0 + 15_000).unwrap());
        assert!(store.load_usage_state().is_some());

        tracker.observe(t0 + 20_000, &sample("code", 0));
        // Clock moved back 10s: the dirty checkpoint still lands rather than
        // waiting for wall time to catch up.
        assert!(tracker.maybe_persist(t0 + 10_000).unwrap());
        let state = sanitize_usage_state(&store.load_usage_state().unwrap());
        assert_eq!(state.checkpoint.unwrap().at_ms, t0 + 20_000);
    }

    #[test]
    fn failed_clear_keeps_the_old_totals_in_memory() {
        let (_dir, store) = store();
        let t0 = 1_700_000_000_000i64;
        let mut tracker = UsageTracker::load(store.clone(), t0, true, "windows");
        tracker.observe(t0, &sample("steam", 0));
        tracker.observe(t0 + 5_000, &sample("steam", 0));
        tracker.flush().unwrap();
        let before = tracker.summary(t0 + 5_000, 1).totals.active_ms;
        assert_eq!(before, 5_000);

        // Replace the data directory with a file so the atomic write fails.
        std::fs::remove_dir_all(store.dir()).unwrap();
        std::fs::write(store.dir(), b"not a directory").unwrap();
        assert!(tracker.clear(t0 + 6_000).is_err());
        // The UI/failed clear still sees the real totals, not a false zero.
        assert_eq!(tracker.summary(t0 + 6_000, 1).totals.active_ms, before);
    }

    #[test]
    fn clear_empties_memory_and_disk() {
        let (_dir, store) = store();
        let t0 = 1_700_000_000_000i64;
        let mut tracker = UsageTracker::load(store.clone(), t0, true, "windows");
        tracker.observe(t0, &sample("steam", 0));
        tracker.observe(t0 + 5_000, &sample("steam", 0));
        tracker.flush().unwrap();
        tracker.clear(t0 + 6_000).unwrap();
        assert!(tracker.summary(t0 + 6_000, 1).apps.is_empty());
        assert_eq!(tracker.summary(t0 + 6_000, 1).totals.active_ms, 0);
        let reloaded = UsageTracker::load(store, t0 + 6_000, true, "windows");
        assert!(reloaded.state.days.is_empty());
        assert!(reloaded.state.checkpoint.is_none());
        // A post-clear sample cannot resurrect the pre-clear interval.
        let mut after = reloaded;
        after.observe(t0 + 7_000, &sample("steam", 0));
        assert_eq!(after.summary(t0 + 7_000, 1).totals.active_ms, 0);
    }

    #[test]
    fn sanitizer_drops_garbage_versions_and_unbounded_values() {
        let value = json!({
            "version": 1,
            "days": {
                "2026-11-09": {
                    "wallMs": 999_999_999_999u64,
                    "apps": {
                        "Code": { "label": "Code", "activeMs": 1_500_000_000u64 },
                        "code": { "label": "", "activeMs": 2_000 },
                        "__proto__": { "label": "proto", "activeMs": 1 },
                        "": { "label": "empty", "activeMs": 1 }
                    }
                },
                "not-a-date": { "wallMs": 1, "apps": {} }
            },
            "checkpoint": { "atMs": 20, "app": { "id": "Code", "label": "Code" }, "active": true }
        });
        let state = sanitize_usage_state(&value);
        assert_eq!(state.days.len(), 1);
        let day = &state.days["2026-11-09"];
        assert_eq!(day.wall_ms, USAGE_MAX_DAY_MS);
        assert_eq!(day.apps["code"].active_ms, USAGE_MAX_DAY_MS - 1);
        assert!(day.apps.contains_key("__proto__"));
        assert!(!day.apps.contains_key(""));
        assert_eq!(state.checkpoint.unwrap().app.unwrap().id, "code");

        let wrong_version = json!({ "version": 999, "days": { "2026-11-09": {} } });
        assert!(sanitize_usage_state(&wrong_version).days.is_empty());
        assert!(sanitize_usage_state(&json!("nope")).days.is_empty());
    }

    #[test]
    fn missing_store_reads_as_empty_and_summary_has_every_period_day() {
        let (_dir, store) = store();
        let now = Local::now().timestamp_millis();
        let summary = summary_from_store(&store, now, 7, false);
        assert!(!summary.available);
        assert_eq!(summary.platform, platform_name());
        assert_eq!(summary.days.len(), 7);
        assert_eq!(summary.totals.active_ms, 0);
        assert!(summary.apps.is_empty());
        // Unknown period values normalize to the retention range.
        assert_eq!(summary_from_store(&store, now, 999, true).period_days, 35);
    }

    #[test]
    fn json_wire_shape_is_camel_case_and_privacy_safe() {
        let mut state = UsageState::default();
        let today = Local::now().date_naive();
        state.days.insert(
            today.format("%Y-%m-%d").to_string(),
            UsageDay {
                wall_ms: 60_000,
                apps: BTreeMap::from([(
                    "code".to_string(),
                    UsageAppBucket {
                        label: "Code".to_string(),
                        active_ms: 30_000,
                    },
                )]),
            },
        );
        let summary =
            summarize_usage_state(&state, Local::now().timestamp_millis(), 1, true, "windows");
        let value = serde_json::to_value(&summary).unwrap();
        assert_eq!(value["totals"]["activeMs"], 30_000);
        assert_eq!(value["apps"][0]["id"], "code");
        let export = serde_json::to_value(export_usage_state(
            &state,
            Local::now().timestamp_millis(),
            1,
            "windows",
        ))
        .unwrap();
        assert_eq!(export["version"], 1);
        assert_eq!(export["days"][0]["apps"][0]["activeMs"], 30_000);
        // No title/URL-shaped fields are part of the contract.
        let text = export.to_string();
        for forbidden in ["title", "url", "path", "document"] {
            assert!(!text.contains(&format!("\"{forbidden}\"")));
        }
    }

    #[test]
    fn app_identity_uses_basename_not_full_path() {
        let app =
            UsageApp::from_exe_path(Path::new(r"C:\Program Files\Microsoft VS Code\Code.exe"))
                .unwrap();
        assert_eq!(app.id, "code");
        assert_eq!(app.label, "Code");
        assert!(UsageApp::from_exe_path(Path::new("  ")).is_none());
        assert_eq!(UsageApp::from_label("Discord.exe").unwrap().id, "discord");
    }

    #[test]
    fn store_roundtrip_is_sanitized_and_atomic() {
        let (_dir, store) = store();
        let t0 = 1_700_000_000_000i64;
        let mut tracker = UsageTracker::load(store.clone(), t0, true, "windows");
        tracker.observe(t0, &sample("code", 0));
        tracker.observe(t0 + 5_000, &sample("code", 0));
        tracker.flush().unwrap();
        let raw = store.load_usage_state().unwrap();
        let state = sanitize_usage_state(&raw);
        assert_eq!(state.days.values().next().unwrap().active_ms(), 5_000);
        // Corrupt file -> empty, not a crash.
        std::fs::write(store.dir().join(USAGE_STATE_FILE), b"{ nope").unwrap();
        assert!(store.load_usage_state().is_none());
        assert!(summary_from_store(&store, t0 + 6_000, 1, true)
            .apps
            .is_empty());
    }

    #[test]
    fn unavailable_probe_reports_unavailable_on_linux() {
        let probe = default_probe();
        assert_eq!(probe.platform(), platform_name());
        #[cfg(not(windows))]
        assert!(!probe.available());
    }

    #[test]
    fn idle_tick_math_survives_the_32_bit_tick_rollover() {
        assert_eq!(idle_ms_from_ticks(10_000, 4_000), 6_000);
        // Uptime crossed the 49.7-day boundary 50 ticks ago, while the last
        // input was 100 ticks before it.
        let near_wrap = u32::MAX - 100;
        let just_after_wrap = u64::from(u32::MAX) + 1 + 50;
        assert_eq!(idle_ms_from_ticks(just_after_wrap, near_wrap), 151);
        // A genuinely old input stays large rather than becoming a small
        // "recent" value after the cast.
        assert_eq!(idle_ms_from_ticks(100, 200), u64::from(u32::MAX) - 99);
    }
}
