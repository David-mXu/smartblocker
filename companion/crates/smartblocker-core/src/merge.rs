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

use crate::lock_math::{derive_lock_status, LockState, ScheduleRule};
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

    LockState {
        timer_until: max_nullable(a.timer_until, b.timer_until),
        password_hash,
        password_ts: a.password_ts.max(b.password_ts),
        frozen_until: max_nullable(a.frozen_until, b.frozen_until),
        schedules,
        schedules_updated_at,
    }
}
