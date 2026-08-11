//! The hard-enforcement state machine — pure: `tick(state, inputs)` returns
//! the next state plus actions for the caller to execute. Nothing in here
//! touches the system, the clock, or IO, which is what makes the Cold-Turkey
//! semantics testable.
//!
//! Invariants:
//! - Kill actions exist ONLY while `lock_status.force_blocking` is true, and
//!   that status is derived by the caller from its own PERSISTED lock state —
//!   never from a live peer message alone.
//! - All timing decisions use the monotonic clock (`now_mono_ms`); the wall
//!   clock can be tampered with and is only ever quoted in logs.
//! - SmartBlocker's own processes (self pid, anything named `smartblocker*`) are
//!   never killed, even if the user blocklists them.

use std::collections::{HashMap, HashSet};

use crate::browsers::{classify, BrowserClass};
use crate::lock_math::LockStatus;
use crate::procwatch::ProcInfo;
use crate::protocol::CompanionBrowser;
use crate::store::CompanionConfig;

/// Heartbeat gap after which a connected browser counts as not responding
/// (~2 missed 20s heartbeats, with slack for SW wake latency).
pub const HEARTBEAT_GAP_MS: u64 = 45_000;
/// Warning period between "extension not responding" and closing the browser.
/// Must comfortably exceed the extension's 30s keepalive-alarm cadence, or a
/// reaped-but-recovering service worker would get its browser shot.
pub const WATCHDOG_GRACE_MS: u64 = 60_000;
/// Notice period before an incompatible browser is closed.
pub const INCOMPATIBLE_GRACE_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No lock source active.
    Idle,
    /// Settings locked (timer/password) but no forced blocking — the
    /// companion persists and reports, and must not kill anything.
    Armed,
    /// Forced blocking (frozen turkey / schedule window): enforcing.
    Enforcing,
}

/// A live extension connection as seen by the daemon's connection registry.
#[derive(Debug, Clone)]
pub struct ConnInfo {
    pub browser: CompanionBrowser,
    pub last_heartbeat_mono_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillReason {
    /// Supported browser running with no responsive extension during a lock.
    Watchdog,
    /// Browser SmartBlocker has no extension for, running during a lock.
    IncompatibleBrowser,
    /// User-blocklisted application.
    BlockedApp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Kill {
        pid: u32,
        name: String,
        reason: KillReason,
    },
    Notify {
        title: String,
        body: String,
    },
    LogEvent {
        kind: &'static str,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy)]
struct SuspectTrack {
    since_mono_ms: u64,
}

#[derive(Debug, Clone, Copy)]
struct IncompatibleTrack {
    since_mono_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct EnforcerState {
    suspects: HashMap<CompanionBrowser, SuspectTrack>,
    incompatibles: HashMap<String, IncompatibleTrack>,
    /// App names already notified this enforcement session (kills repeat
    /// every tick while the process lives; nagging must not).
    notified_apps: HashSet<String>,
}

pub struct TickInputs<'a> {
    pub now_wall_ms: i64,
    pub now_mono_ms: u64,
    pub lock_status: &'a LockStatus,
    pub processes: &'a [ProcInfo],
    pub connections: &'a [ConnInfo],
    pub config: &'a CompanionConfig,
    pub own_pid: u32,
}

pub fn phase_of(status: &LockStatus) -> Phase {
    if status.force_blocking {
        Phase::Enforcing
    } else if status.settings_locked {
        Phase::Armed
    } else {
        Phase::Idle
    }
}

fn protected(p: &ProcInfo, own_pid: u32) -> bool {
    p.pid == own_pid || p.name.contains("smartblocker")
}

fn browser_label(kind: CompanionBrowser) -> &'static str {
    match kind {
        CompanionBrowser::Chrome => "Chrome",
        CompanionBrowser::Edge => "Edge",
        CompanionBrowser::Firefox => "Firefox",
    }
}

pub fn tick(state: &EnforcerState, inp: &TickInputs) -> (EnforcerState, Vec<Action>) {
    if phase_of(inp.lock_status) != Phase::Enforcing {
        // Leaving enforcement clears every grace timer and notify latch: the
        // next lock starts a fresh session (a kill must never fire off a
        // countdown that began under a previous lock).
        return (EnforcerState::default(), Vec::new());
    }

    let mut next = EnforcerState::default();
    let mut actions = Vec::new();

    // -- group the live processes ------------------------------------------
    let mut by_browser: HashMap<CompanionBrowser, Vec<&ProcInfo>> = HashMap::new();
    let mut incompatible_now: HashMap<String, Vec<&ProcInfo>> = HashMap::new();
    for p in inp.processes {
        if protected(p, inp.own_pid) {
            continue;
        }
        match classify(&p.name, &inp.config.extra_incompatible_browsers) {
            BrowserClass::Supported(kind) => by_browser.entry(kind).or_default().push(p),
            BrowserClass::Incompatible => {
                incompatible_now.entry(p.name.clone()).or_default().push(p)
            }
            BrowserClass::Unrelated => {}
        }
    }

    // -- watchdog: supported browsers must have a responsive extension ------
    for (kind, procs) in &by_browser {
        let responsive = inp.connections.iter().any(|c| {
            c.browser == *kind
                && inp.now_mono_ms.saturating_sub(c.last_heartbeat_mono_ms) < HEARTBEAT_GAP_MS
        });
        if responsive {
            continue; // healthy — drops any previous suspect track
        }
        let since = state
            .suspects
            .get(kind)
            .map(|t| t.since_mono_ms)
            .unwrap_or(inp.now_mono_ms);
        if !state.suspects.contains_key(kind) {
            actions.push(Action::Notify {
                title: "SmartBlocker".into(),
                body: format!(
                    "The SmartBlocker extension is not responding in {}. Re-enable it or the browser will be closed in {}s.",
                    browser_label(*kind),
                    WATCHDOG_GRACE_MS / 1000
                ),
            });
        }
        if inp.now_mono_ms.saturating_sub(since) >= WATCHDOG_GRACE_MS {
            for p in procs {
                actions.push(Action::Kill {
                    pid: p.pid,
                    name: p.name.clone(),
                    reason: KillReason::Watchdog,
                });
            }
            actions.push(Action::LogEvent {
                kind: "watchdog-close",
                detail: format!("{} (wall {})", browser_label(*kind), inp.now_wall_ms),
            });
        }
        next.suspects.insert(
            *kind,
            SuspectTrack {
                since_mono_ms: since,
            },
        );
    }

    // -- incompatible browsers get a short notice, then close ---------------
    for (name, procs) in &incompatible_now {
        let since = state
            .incompatibles
            .get(name)
            .map(|t| t.since_mono_ms)
            .unwrap_or(inp.now_mono_ms);
        if !state.incompatibles.contains_key(name) {
            actions.push(Action::Notify {
                title: "SmartBlocker".into(),
                body: format!(
                    "{name} is not compatible with SmartBlocker and will be closed while this block is active."
                ),
            });
        }
        if inp.now_mono_ms.saturating_sub(since) >= INCOMPATIBLE_GRACE_MS {
            for p in procs {
                actions.push(Action::Kill {
                    pid: p.pid,
                    name: p.name.clone(),
                    reason: KillReason::IncompatibleBrowser,
                });
            }
            actions.push(Action::LogEvent {
                kind: "incompatible-browser-close",
                detail: format!("{name} (wall {})", inp.now_wall_ms),
            });
        }
        next.incompatibles.insert(
            name.clone(),
            IncompatibleTrack {
                since_mono_ms: since,
            },
        );
    }

    // -- blocklisted apps close immediately ---------------------------------
    next.notified_apps = state.notified_apps.clone();
    for p in inp.processes {
        if protected(p, inp.own_pid) {
            continue;
        }
        // Browsers are handled above; the app blocklist must not offer a
        // second, grace-free path to killing a browser.
        if !matches!(
            classify(&p.name, &inp.config.extra_incompatible_browsers),
            BrowserClass::Unrelated
        ) {
            continue;
        }
        let matched = inp
            .config
            .app_blocklist
            .iter()
            .any(|entry| !entry.is_empty() && p.name.contains(&entry.to_lowercase()));
        if !matched {
            continue;
        }
        if next.notified_apps.insert(p.name.clone()) {
            actions.push(Action::Notify {
                title: "SmartBlocker".into(),
                body: format!("{} is blocked while this session is active.", p.name),
            });
        }
        actions.push(Action::Kill {
            pid: p.pid,
            name: p.name.clone(),
            reason: KillReason::BlockedApp,
        });
    }

    (next, actions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock_math::{derive_lock_status, LockState};

    fn proc(pid: u32, name: &str) -> ProcInfo {
        ProcInfo {
            pid,
            name: name.into(),
        }
    }

    fn config(blocklist: &[&str], extra: &[&str]) -> CompanionConfig {
        CompanionConfig {
            app_blocklist: blocklist.iter().map(|s| s.to_string()).collect(),
            extra_incompatible_browsers: extra.iter().map(|s| s.to_string()).collect(),
            ..CompanionConfig::default()
        }
    }

    fn forced_status() -> LockStatus {
        let state = LockState {
            frozen_until: Some(2_000_000),
            ..LockState::default()
        };
        derive_lock_status(&state, 1_000_000)
    }

    fn armed_status() -> LockStatus {
        let state = LockState {
            timer_until: Some(2_000_000),
            ..LockState::default()
        };
        derive_lock_status(&state, 1_000_000)
    }

    fn idle_status() -> LockStatus {
        derive_lock_status(&LockState::default(), 1_000_000)
    }

    fn tick_at(
        state: &EnforcerState,
        mono: u64,
        status: &LockStatus,
        processes: &[ProcInfo],
        connections: &[ConnInfo],
        config: &CompanionConfig,
    ) -> (EnforcerState, Vec<Action>) {
        tick(
            state,
            &TickInputs {
                now_wall_ms: 1_000_000,
                now_mono_ms: mono,
                lock_status: status,
                processes,
                connections,
                config,
                own_pid: 999,
            },
        )
    }

    fn kills(actions: &[Action]) -> Vec<(u32, KillReason)> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Kill { pid, reason, .. } => Some((*pid, *reason)),
                _ => None,
            })
            .collect()
    }

    fn notifies(actions: &[Action]) -> usize {
        actions
            .iter()
            .filter(|a| matches!(a, Action::Notify { .. }))
            .count()
    }

    #[test]
    fn no_force_blocking_means_no_kills_ever() {
        let cfg = config(&["steam"], &[]);
        let procs = [proc(1, "steam"), proc(2, "brave"), proc(3, "chrome")];
        for status in [idle_status(), armed_status()] {
            let (state, actions) =
                tick_at(&EnforcerState::default(), 0, &status, &procs, &[], &cfg);
            assert!(actions.is_empty());
            assert!(state.suspects.is_empty() && state.incompatibles.is_empty());
        }
    }

    #[test]
    fn watchdog_notifies_then_kills_after_grace() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc(10, "chrome"), proc(11, "chrome")];

        // First sight: notify once, no kill.
        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(notifies(&a1), 1);
        assert!(kills(&a1).is_empty());

        // Mid-grace: silent.
        let (s2, a2) = tick_at(&s1, 30_000, &status, &procs, &[], &cfg);
        assert!(a2.is_empty());

        // Grace expired: every chrome pid killed.
        let (_s3, a3) = tick_at(&s2, 61_001, &status, &procs, &[], &cfg);
        assert_eq!(
            kills(&a3),
            vec![(10, KillReason::Watchdog), (11, KillReason::Watchdog)]
        );
    }

    #[test]
    fn stale_heartbeat_counts_as_unresponsive() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc(10, "firefox")];
        let conns = [ConnInfo {
            browser: CompanionBrowser::Firefox,
            last_heartbeat_mono_ms: 0,
        }];
        // now=50s, heartbeat at 0 → gap 50s >= 45s → suspect.
        let (state, actions) = tick_at(
            &EnforcerState::default(),
            50_000,
            &status,
            &procs,
            &conns,
            &cfg,
        );
        assert_eq!(notifies(&actions), 1);
        assert!(state.suspects.contains_key(&CompanionBrowser::Firefox));
    }

    #[test]
    fn fresh_heartbeat_keeps_the_browser_healthy_and_clears_suspicion() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc(10, "chrome")];

        let (suspect, _) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        // Extension reconnects (SW woken by the keepalive alarm).
        let conns = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 29_000,
        }];
        let (healthy, actions) = tick_at(&suspect, 30_000, &status, &procs, &conns, &cfg);
        assert!(actions.is_empty());
        assert!(healthy.suspects.is_empty());

        // Even far past the old grace deadline, no kill: the track restarted.
        let conns2 = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 70_000,
        }];
        let (_s, a2) = tick_at(&healthy, 90_000, &status, &procs, &conns2, &cfg);
        assert!(kills(&a2).is_empty());
    }

    #[test]
    fn lock_expiring_mid_grace_cancels_the_countdown() {
        let cfg = config(&[], &[]);
        let procs = [proc(10, "chrome")];

        let (suspect, _) = tick_at(
            &EnforcerState::default(),
            1_000,
            &forced_status(),
            &procs,
            &[],
            &cfg,
        );
        // Lock ends before the grace elapses → full reset, no kill.
        let (reset, actions) = tick_at(&suspect, 40_000, &idle_status(), &procs, &[], &cfg);
        assert!(actions.is_empty());
        assert!(reset.suspects.is_empty());

        // Lock re-armed much later: countdown starts fresh (notify again, no kill).
        let (_s, a2) = tick_at(&reset, 120_000, &forced_status(), &procs, &[], &cfg);
        assert_eq!(notifies(&a2), 1);
        assert!(kills(&a2).is_empty());
    }

    #[test]
    fn incompatible_browser_gets_notice_then_closed() {
        let cfg = config(&[], &["fakebrowser"]);
        let status = forced_status();
        let procs = [proc(20, "brave"), proc(21, "fakebrowser")];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(notifies(&a1), 2);
        assert!(kills(&a1).is_empty());

        let (_s2, a2) = tick_at(&s1, 11_001, &status, &procs, &[], &cfg);
        let killed = kills(&a2);
        assert!(killed.contains(&(20, KillReason::IncompatibleBrowser)));
        assert!(killed.contains(&(21, KillReason::IncompatibleBrowser)));
    }

    #[test]
    fn blocked_app_dies_immediately_but_notifies_once() {
        let cfg = config(&["Steam"], &[]);
        let status = forced_status();
        // Case-insensitive substring: config "Steam" matches "steamwebhelper".
        let procs = [proc(30, "steamwebhelper")];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a1), vec![(30, KillReason::BlockedApp)]);
        assert_eq!(notifies(&a1), 1);

        // Still running next tick: killed again, not nagged again.
        let (_s2, a2) = tick_at(&s1, 4_000, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(30, KillReason::BlockedApp)]);
        assert_eq!(notifies(&a2), 0);
    }

    #[test]
    fn blocklist_cannot_bypass_the_watchdog_grace_for_browsers() {
        // "chrome" in the app blocklist must NOT kill chrome instantly — the
        // watchdog owns browser lifecycles (with grace + notification).
        let cfg = config(&["chrome"], &[]);
        let status = forced_status();
        let procs = [proc(10, "chrome")];
        let conns = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 500,
        }];
        let (_s, actions) = tick_at(
            &EnforcerState::default(),
            1_000,
            &status,
            &procs,
            &conns,
            &cfg,
        );
        assert!(kills(&actions).is_empty());
    }

    #[test]
    fn smartblocker_processes_are_never_killed() {
        let cfg = config(&["smartblocker", "daemon"], &[]);
        let status = forced_status();
        // own pid (999) under a hostile name + our binaries by name.
        let procs = [
            proc(999, "totally-a-game"),
            proc(40, "smartblocker-daemon"),
            proc(41, "smartblocker-nm-host"),
        ];
        let (_s, actions) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert!(kills(&actions).is_empty());
    }
}
