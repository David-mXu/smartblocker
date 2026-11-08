//! Lock-state merge, mirroring `mergeLockStates` in `src/shared/lock-math.ts`
//! — change both together. Must stay commutative and idempotent (the
//! extension and the companion each keep a copy and converge by merging,
//! so syncing never locks the two sides into disagreement); the shared
//! fixtures assert both properties on every case. `now` is needed because
//! the schedule rule consults activeness. Password and timer/frozen sources
//! stay monotonic (merge can never SHORTEN them); the password arm/unlock
//! and the schedule list are the two deliberate exceptions: unlocks and
//! schedule edits must propagate, so those two carry timestamps and the
//! newer write wins.

use crate::lock_math::{
    armed_delay, armed_random_text_length, derive_lock_status, LockState, ScheduleRule,
};
use std::collections::BTreeMap;

/// `None` = -inf: a set timestamp always beats an unset one.
fn max_nullable(x: Option<i64>, y: Option<i64>) -> Option<i64> {
    match (x, y) {
        (None, y) => y,
        (x, None) => x,
        (Some(x), Some(y)) => Some(x.max(y)),
    }
}

/// Canonical rule identity for same-id conflicts: the TS builds
/// `${startMinutes}|${endMinutes}|${sortedDays.join(',')}|${tzOff ?? ''}|${tzName ?? ''}`
/// and keeps the lexicographically smaller string. ASCII-only, so Rust byte
/// order and JS code-unit order agree. The tz pin is content: two same-id
/// rules pinned to different zones must converge to ONE rule on both sides
/// (equality compares full rules, so a skipped field would break the
/// commutativity the shared fixtures assert).
fn canon(r: &ScheduleRule) -> String {
    let mut days = r.days.clone();
    days.sort_unstable();
    let days = days.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
    let tz_off = r
        .tz_offset_minutes
        .map(|m| m.to_string())
        .unwrap_or_default();
    let tz_name = r.tz_name.as_deref().unwrap_or_default();
    format!(
        "{}|{}|{days}|{tz_off}|{tz_name}",
        r.start_minutes, r.end_minutes
    )
}

fn delay_canon(s: &LockState) -> String {
    let until = s
        .delay_until
        .map_or_else(|| "null".into(), |n| n.to_string());
    let duration = s
        .delay_duration_ms
        .map_or_else(|| "null".into(), |n| n.to_string());
    format!("[{until},{duration}]")
}

fn random_canon(s: &LockState) -> String {
    s.random_text_len
        .map_or_else(|| "[null]".into(), |len| format!("[{len}]"))
}

pub fn merge_lock_states(a: &LockState, b: &LockState, now: i64) -> LockState {
    // Password: timestamped arm/unlock (tombstone CRDT). The greater stamp
    // wins — a fresh unlock (`None`) beats an older arm, and re-arming later
    // beats the old tombstone. At a stamp tie an armed hash beats an empty
    // one (fail-safe; note an empty-string hash is NOT armed — see
    // `password_armed` — but the string compare here is just as total), and
    // two armed hashes keep the lexicographically smaller so legacy
    // (stamp-less, 0) peers still converge deterministically.
    let password_hash = if a.password_ts != b.password_ts {
        if a.password_ts > b.password_ts {
            a.password_hash.clone()
        } else {
            b.password_hash.clone()
        }
    } else if a.password_hash == b.password_hash {
        a.password_hash.clone()
    } else {
        match (&a.password_hash, &b.password_hash) {
            (Some(x), Some(y)) => Some(x.min(y).clone()),
            (x, y) => x.clone().or_else(|| y.clone()),
        }
    };

    // Delay: whole-gate LWW. Equal stamps fail closed — armed beats released,
    // waiting/reset beats a countdown, then later deadline/longer duration.
    let a_delay = armed_delay(a);
    let b_delay = armed_delay(b);
    let mut delay_winner = a;
    if a.delay_updated_at != b.delay_updated_at {
        delay_winner = if a.delay_updated_at > b.delay_updated_at {
            a
        } else {
            b
        };
    } else if a_delay.is_some() != b_delay.is_some() {
        delay_winner = if a_delay.is_some() { a } else { b };
    } else if let (Some((a_until, a_duration)), Some((b_until, b_duration))) = (a_delay, b_delay) {
        if (a_until == 0) != (b_until == 0) {
            delay_winner = if a_until == 0 { a } else { b };
        } else if a_until != b_until {
            delay_winner = if a_until > b_until { a } else { b };
        } else if a_duration != b_duration {
            delay_winner = if a_duration > b_duration { a } else { b };
        }
    }
    if a.delay_updated_at == b.delay_updated_at && delay_canon(a) != delay_canon(b) {
        // Apply the canonical fallback only when no earlier fail-closed rule
        // selected a winner; this mirrors the TS total ordering exactly.
        let selected = if a_delay.is_some() != b_delay.is_some() {
            true
        } else if let (Some((a_until, a_duration)), Some((b_until, b_duration))) =
            (a_delay, b_delay)
        {
            (a_until == 0) != (b_until == 0) || a_until != b_until || a_duration != b_duration
        } else {
            false
        };
        if !selected {
            delay_winner = if delay_canon(a) < delay_canon(b) {
                a
            } else {
                b
            };
        }
    }

    // Random text: newer whole operation wins; ties keep armed, then longest.
    let a_random = armed_random_text_length(a);
    let b_random = armed_random_text_length(b);
    let mut random_winner = a;
    if a.random_text_updated_at != b.random_text_updated_at {
        random_winner = if a.random_text_updated_at > b.random_text_updated_at {
            a
        } else {
            b
        };
    } else if a_random.is_some() != b_random.is_some() {
        random_winner = if a_random.is_some() { a } else { b };
    } else if let (Some(a_len), Some(b_len)) = (a_random, b_random) {
        if a_len != b_len {
            random_winner = if a_len > b_len { a } else { b };
        }
    } else if random_canon(a) != random_canon(b) {
        random_winner = if random_canon(a) < random_canon(b) {
            a
        } else {
            b
        };
    }

    // Schedules: edits are refused while locked (lock.ts setSchedules /
    // `derive_lock_status`), so the only way a peer's list changes mid-lock
    // is a forged/wiped write. If exactly one side is locked, the LOCKED
    // side's list wins — a browser whose storage.local was wiped (DevTools)
    // is no longer locked by its own state, loses to the daemon's intact
    // copy, and re-syncs it right back. The rule is symmetric, so the merge
    // stays commutative. Otherwise the newer stamp wins entirely (deletion
    // must not resurrect rules), with a deterministic union for legacy
    // equal-stamp convergence.
    let a_locked = derive_lock_status(a, now).settings_locked;
    let b_locked = derive_lock_status(b, now).settings_locked;
    let (schedules, schedules_updated_at) = if a_locked != b_locked {
        let winner = if a_locked { a } else { b };
        (winner.schedules.clone(), winner.schedules_updated_at)
    } else if a.schedules_updated_at != b.schedules_updated_at {
        let winner = if a.schedules_updated_at > b.schedules_updated_at {
            a
        } else {
            b
        };
        (
            winner.schedules.clone(),
            a.schedules_updated_at.max(b.schedules_updated_at),
        )
    } else {
        // Equal timestamps (typically both legacy 0): deterministic union by
        // id (BTreeMap iteration = JS's string-key sort).
        let mut by_id = BTreeMap::new();
        for r in a.schedules.iter().chain(b.schedules.iter()) {
            by_id
                .entry(r.id.clone())
                .and_modify(|prev: &mut ScheduleRule| {
                    if canon(r) < canon(prev) {
                        *prev = r.clone();
                    }
                })
                .or_insert_with(|| r.clone());
        }
        (by_id.into_values().collect(), a.schedules_updated_at)
    };

    // Break: select the whole operation by its LWW stamp, never max individual
    // timestamps. Newer cancellation beats a stale relaxed interval. Ties fail
    // closed: empty wins, then earlier re-block, later activation, later request.
    let a_break_ts = a.break_updated_at;
    let b_break_ts = b.break_updated_at;
    let empty_break = |s: &LockState| {
        s.break_started_at.is_none() && s.break_not_before.is_none() && s.break_ends_at.is_none()
    };
    let mut break_winner = a;
    if a_break_ts != b_break_ts {
        break_winner = if a_break_ts > b_break_ts { a } else { b };
    } else if empty_break(a) != empty_break(b) {
        break_winner = if empty_break(a) { a } else { b };
    } else if a.break_ends_at != b.break_ends_at {
        break_winner = if a.break_ends_at.unwrap_or(9_007_199_254_740_991)
            < b.break_ends_at.unwrap_or(9_007_199_254_740_991)
        {
            a
        } else {
            b
        };
    } else if a.break_not_before != b.break_not_before {
        break_winner = if a.break_not_before.unwrap_or(0) > b.break_not_before.unwrap_or(0) {
            a
        } else {
            b
        };
    } else if a.break_started_at != b.break_started_at {
        break_winner = if a.break_started_at.unwrap_or(0) > b.break_started_at.unwrap_or(0) {
            a
        } else {
            b
        };
    }

    LockState {
        break_started_at: break_winner.break_started_at,
        break_not_before: break_winner.break_not_before,
        break_ends_at: break_winner.break_ends_at,
        break_updated_at: a_break_ts.max(b_break_ts),
        timer_until: max_nullable(a.timer_until, b.timer_until),
        password_hash,
        password_ts: a.password_ts.max(b.password_ts),
        delay_until: delay_winner.delay_until,
        delay_duration_ms: delay_winner.delay_duration_ms,
        delay_updated_at: a.delay_updated_at.max(b.delay_updated_at),
        random_text_len: random_winner.random_text_len,
        random_text_updated_at: a.random_text_updated_at.max(b.random_text_updated_at),
        frozen_until: max_nullable(a.frozen_until, b.frozen_until),
        schedules,
        schedules_updated_at,
    }
}
