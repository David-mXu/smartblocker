//! Monotonic lock-state merge, mirroring `mergeLockStates` in
//! `src/shared/lock-math.ts` — change both together. Must stay commutative
//! and idempotent (the extension and the companion each keep a copy and
//! converge by merging, so neither side can shorten a lock by syncing);
//! the shared fixtures assert both properties on every case.

use crate::lock_math::{LockState, ScheduleRule};
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
/// `${startMinutes}|${endMinutes}|${sortedDays.join(',')}` and keeps the
/// lexicographically smaller string. ASCII-only, so Rust byte order and JS
/// code-unit order agree.
fn canon(r: &ScheduleRule) -> String {
    let mut days = r.days.clone();
    days.sort_unstable();
    let days = days.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
    format!("{}|{}|{}", r.start_minutes, r.end_minutes, days)
}

pub fn merge_lock_states(a: &LockState, b: &LockState) -> LockState {
    // Armed if either armed; on conflicting hashes pick the lexicographically
    // smaller so the merge stays commutative (either password then unlocks).
    let password_hash = match (&a.password_hash, &b.password_hash) {
        (None, other) => other.clone(),
        (other, None) => other.clone(),
        (Some(x), Some(y)) => Some(if x <= y { x.clone() } else { y.clone() }),
    };
    let (a_ts, b_ts) = (a.schedules_updated_at, b.schedules_updated_at);
    // Schedule edits happen exclusively while unlocked, so last-writer-wins
    // is safe — a plain union would resurrect deleted rules.
    let schedules = if a_ts > b_ts {
        a.schedules.clone()
    } else if b_ts > a_ts {
        b.schedules.clone()
    } else {
        // Equal timestamps (typically both legacy 0): deterministic union by
        // id (BTreeMap = sorted by id); same-id conflicts keep the
        // canonically smaller rule regardless of argument order.
        let mut by_id: BTreeMap<&str, &ScheduleRule> = BTreeMap::new();
        for r in a.schedules.iter().chain(&b.schedules) {
            match by_id.get(r.id.as_str()) {
                Some(prev) if canon(r) >= canon(prev) => {}
                _ => {
                    by_id.insert(&r.id, r);
                }
            }
        }
        by_id.into_values().cloned().collect()
    };
    LockState {
        timer_until: max_nullable(a.timer_until, b.timer_until),
        password_hash,
        frozen_until: max_nullable(a.frozen_until, b.frozen_until),
        schedules,
        schedules_updated_at: a_ts.max(b_ts),
    }
}
