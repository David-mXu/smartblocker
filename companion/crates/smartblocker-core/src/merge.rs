//! Lock-state merge, mirroring `mergeLockStates` in `src/shared/lock-math.ts`
//! — change both together. Must stay commutative and idempotent (the
//! extension and the companion each keep a copy and converge by merging,
//! so syncing never locks the two sides into disagreement); the shared
//! fixtures assert both properties on every case. `now` is needed because
//! the schedule rule consults activeness. Password and timer/frozen sources
//! stay monotonic (merge can never SHORTEN them); timestamped operations are
//! deliberate exceptions: password, explicit-release gates, schedules and the
//! daemon-only partner arm/release propagate through last-writer-wins stamps.

use crate::lock_math::{
    armed_delay, armed_partner_generation, armed_random_text_length, current_category_window_end,
    derive_lock_status, CategoryScheduleRule, LockState, ScheduleRule,
};
use std::collections::{BTreeMap, BTreeSet};

/// `None` = -inf: a set timestamp always beats an unset one.
fn max_nullable(x: Option<i64>, y: Option<i64>) -> Option<i64> {
    match (x, y) {
        (None, y) => y,
        (x, None) => x,
        (Some(x), Some(y)) => Some(x.max(y)),
    }
}

/// UTF-8 hex gives both languages the same total ordering for IDs and raw
/// conflict material (JavaScript's native string order is UTF-16 instead).
fn utf8_hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Canonical rule identity for same-id conflicts. The tz pin is content: two
/// same-id rules pinned to different zones must converge to ONE rule on both
/// sides (equality compares full rules, so a skipped field would break the
/// commutativity the shared fixtures assert).
fn canon(r: &ScheduleRule) -> String {
    let mut days = r.days.clone();
    days.sort_unstable();
    let days = days.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
    let tz_off = r
        .tz_offset_minutes
        .map(|m| m.to_string())
        .unwrap_or_default();
    let tz_name = utf8_hex(r.tz_name.as_deref().unwrap_or_default());
    let lead = r
        .lead_minutes
        .filter(|m| (1..=1_440).contains(m))
        .map(|m| m.to_string())
        .unwrap_or_default();
    format!(
        "{}|{}|{days}|{tz_off}|{tz_name}|{lead}",
        r.start_minutes, r.end_minutes
    )
}

fn category_canon(r: &CategoryScheduleRule) -> String {
    let mut categories = r.categories.iter().map(|c| utf8_hex(c)).collect::<Vec<_>>();
    categories.sort();
    format!("{}|{}", canon(&r.schedule), categories.join(","))
}

fn scoped_rule_active(rule: &CategoryScheduleRule, now: i64) -> bool {
    current_category_window_end(std::slice::from_ref(rule), now).is_some()
}

/// Canonicalize combined scoped output and repair already-corrupt duplicate
/// direct state. Active duplicates beat inactive material, then UTF-8 canon
/// order decides. Unique inactive whole-list winners retain authored order.
fn canonical_scoped_rules(
    rules: &[CategoryScheduleRule],
    now: i64,
    force_canonical: bool,
) -> Vec<CategoryScheduleRule> {
    if !force_canonical {
        let mut ids = BTreeSet::new();
        if rules
            .iter()
            .all(|rule| ids.insert(rule.schedule.id.as_str()))
        {
            return rules.to_vec();
        }
    }
    let mut by_id: BTreeMap<String, (&CategoryScheduleRule, bool)> = BTreeMap::new();
    for rule in rules {
        let active = scoped_rule_active(rule, now);
        by_id
            .entry(rule.schedule.id.clone())
            .and_modify(|(prev, prev_active)| {
                let replace = (active && !*prev_active)
                    || (active == *prev_active && category_canon(rule) < category_canon(prev));
                if replace {
                    *prev = rule;
                    *prev_active = active;
                }
            })
            .or_insert((rule, active));
    }
    by_id.into_values().map(|(rule, _)| rule.clone()).collect()
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

    // Accountability partner: optional whole-operation LWW. An absent stamp
    // AND generation is an older peer with no vote, never a release. Newer
    // stamps win; ties keep a valid arm, then the deterministic smaller ID.
    let has_partner = |state: &LockState| {
        state.partner_arm_generation.is_some() || state.partner_arm_updated_at.is_some()
    };
    let a_has_partner = has_partner(a);
    let b_has_partner = has_partner(b);
    let include_partner = a_has_partner || b_has_partner;
    let a_partner_ts = a.partner_arm_updated_at.unwrap_or(0);
    let b_partner_ts = b.partner_arm_updated_at.unwrap_or(0);
    let a_partner = armed_partner_generation(a);
    let b_partner = armed_partner_generation(b);
    let partner_canon = |state: &LockState| {
        format!(
            "[{}]",
            state.partner_arm_generation.as_deref().unwrap_or("null")
        )
    };
    let mut partner_winner = a;
    if !a_has_partner {
        partner_winner = b;
    } else if !b_has_partner {
        partner_winner = a;
    } else if a_partner_ts != b_partner_ts {
        partner_winner = if a_partner_ts > b_partner_ts { a } else { b };
    } else if a_partner.is_some() != b_partner.is_some() {
        partner_winner = if a_partner.is_some() { a } else { b };
    } else if let (Some(a_generation), Some(b_generation)) = (a_partner, b_partner) {
        if a_generation != b_generation {
            partner_winner = if a_generation < b_generation { a } else { b };
        }
    } else if partner_canon(a) != partner_canon(b) {
        partner_winner = if partner_canon(a) < partner_canon(b) {
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

    // Scoped schedules: absent means an older peer with no vote, while an
    // explicit empty vector is a modern deletion. Legal edits are refused in
    // active scopes, so EVERY active rule from both peers must survive even if
    // both whole lists are protected. Select the normal protected/LWW winner,
    // then overlay active rules by ID. With no active rules, ordinary list
    // policy alone applies; unrelated timers do not retain the losing list's
    // inactive rules beyond the existing global-lock winner policy.
    let (category_schedules, category_schedules_updated_at) =
        match (&a.category_schedules, &b.category_schedules) {
            (None, None) => (None, 0),
            (Some(rules), None) => (
                Some(canonical_scoped_rules(rules, now, true)),
                a.category_schedules_updated_at,
            ),
            (None, Some(rules)) => (
                Some(canonical_scoped_rules(rules, now, true)),
                b.category_schedules_updated_at,
            ),
            (Some(a_rules), Some(b_rules)) => {
                let a_active = a_rules
                    .iter()
                    .filter(|rule| scoped_rule_active(rule, now))
                    .cloned()
                    .collect::<Vec<_>>();
                let b_active = b_rules
                    .iter()
                    .filter(|rule| scoped_rule_active(rule, now))
                    .cloned()
                    .collect::<Vec<_>>();
                let a_protected = a_locked || !a_active.is_empty();
                let b_protected = b_locked || !b_active.is_empty();
                let (mut selected, mut force_canonical, updated_at) = if a_protected != b_protected
                {
                    if a_protected {
                        (a_rules.clone(), true, a.category_schedules_updated_at)
                    } else {
                        (b_rules.clone(), true, b.category_schedules_updated_at)
                    }
                } else if a.category_schedules_updated_at != b.category_schedules_updated_at {
                    if a.category_schedules_updated_at > b.category_schedules_updated_at {
                        (a_rules.clone(), true, a.category_schedules_updated_at)
                    } else {
                        (b_rules.clone(), true, b.category_schedules_updated_at)
                    }
                } else {
                    (
                        a_rules.iter().chain(b_rules.iter()).cloned().collect(),
                        true,
                        a.category_schedules_updated_at,
                    )
                };
                if !a_active.is_empty() || !b_active.is_empty() {
                    selected.extend(a_active);
                    selected.extend(b_active);
                    force_canonical = true;
                }
                (
                    Some(canonical_scoped_rules(&selected, now, force_canonical)),
                    updated_at,
                )
            }
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
        category_schedules,
        category_schedules_updated_at,
        partner_arm_generation: if include_partner {
            partner_winner.partner_arm_generation.clone()
        } else {
            None
        },
        partner_arm_updated_at: if include_partner {
            Some(a_partner_ts.max(b_partner_ts))
        } else {
            None
        },
    }
}
