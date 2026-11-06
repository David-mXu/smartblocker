//! Golden cross-language fixtures for the lock-state contract — the SAME
//! file drives scripts/lock-math-test.mjs on the TS side. A case failing
//! here or there means the two lock implementations have drifted apart.
//! Cases are timezone-free by design (timer/frozen/password only); the
//! boundary/status runners still pass an explicit `Utc` so the suite cannot
//! depend on the host zone.

use serde::Deserialize;
use serde_json::Value;
use smartblocker_core::lock_math::{
    derive_lock_status_in, next_boundary_in, sanitize_lock_state, LockState, LockStatus,
};
use smartblocker_core::merge::merge_lock_states;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    merge_lock_states: Vec<MergeCase>,
    derive_lock_status: Vec<StatusCase>,
    next_boundary: Vec<BoundaryCase>,
    sanitize_lock_state: Vec<SanitizeCase>,
}

#[derive(Deserialize)]
struct MergeCase {
    name: String,
    a: LockState,
    b: LockState,
    /// Wall clock for activeness checks inside the schedule rule. Defaults
    /// to 0: with fixture timestamps in the small thousands, timer/frozen
    /// sources read as active and password arms read as locked — see _note.
    #[serde(default)]
    now: i64,
    expect: LockState,
}

#[derive(Deserialize)]
struct StatusCase {
    name: String,
    state: LockState,
    now: i64,
    expect: LockStatus,
}

#[derive(Deserialize)]
struct BoundaryCase {
    name: String,
    state: LockState,
    now: i64,
    expect: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizeCase {
    name: String,
    raw: Value,
    now: i64,
    max_lock_ms: i64,
    expect: LockState,
}

fn fixtures() -> Fixtures {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/lock-cases.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture file"))
        .expect("fixture parse")
}

#[test]
fn fixture_merge_cases() {
    for c in fixtures().merge_lock_states {
        assert_eq!(
            merge_lock_states(&c.a, &c.b, c.now),
            c.expect,
            "merge: {}",
            c.name
        );
        // The merge is a convergence step between two independent stores —
        // it must be commutative and idempotent or the sides never settle.
        assert_eq!(
            merge_lock_states(&c.b, &c.a, c.now),
            c.expect,
            "merge commutativity: {}",
            c.name
        );
        assert_eq!(
            merge_lock_states(&c.expect, &c.expect, c.now),
            c.expect,
            "merge idempotence: {}",
            c.name
        );
    }
}

#[test]
fn fixture_status_cases() {
    for c in fixtures().derive_lock_status {
        assert_eq!(
            derive_lock_status_in(&c.state, c.now, &chrono::Utc),
            c.expect,
            "status: {}",
            c.name
        );
    }
}

#[test]
fn fixture_boundary_cases() {
    for c in fixtures().next_boundary {
        assert_eq!(
            next_boundary_in(&c.state, c.now, &chrono::Utc),
            c.expect,
            "boundary: {}",
            c.name
        );
    }
}

#[test]
fn fixture_sanitize_cases() {
    for c in fixtures().sanitize_lock_state {
        assert_eq!(
            sanitize_lock_state(&c.raw, c.now, c.max_lock_ms),
            c.expect,
            "sanitize: {}",
            c.name
        );
    }
}
