//! The hard-enforcement state machine — pure: `tick(state, inputs)` returns
//! the next state plus actions for the caller to execute. Nothing in here
//! touches the system, the clock, or IO, which is what makes the Cold-Turkey
//! semantics testable.
//!
//! Invariants:
//! - Kill actions exist in EVERY armed phase — `lock_status.settings_locked`
//!   (timer, password, frozen, schedule window) — not just `force_blocking`
//!   (red-team #25, user-approved: an armed lock carries the same OS-level
//!   protection). `Phase::Idle` (no lock source) kills NOTHING. The status
//!   is derived by the caller from its own PERSISTED lock state — never
//!   from a live peer message alone.
//! - All timing decisions use the monotonic clock (`now_mono_ms`); the wall
//!   clock can be tampered with and is only ever quoted in logs.
//! - Kill-immunity binds to the RECORDED PID SET (own pid + pids verified at
//!   scan time to run our own executables from our install dir), never to a
//!   name: any other process whose exe stem matches a protected stem is a
//!   hostile decoy and is killed like a blocklisted app. Mere substring
//!   matches (`smartblocker-steam`) get no exemption either.

use std::collections::{HashMap, HashSet};

use crate::app_targets::{matches_process, ProcessIdentity};
use crate::browsers::{classify_process, BrowserClass};
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
    /// No lock source active — kills NOTHING.
    Idle,
    /// Settings locked (timer/password) but no forced blocking. Since
    /// red-team #25 (user-approved) this is an armed-but-not-forced
    /// ENFORCING mode: blocklisted apps, incompatible browsers, decoys, and
    /// unpaired dev-flag launches are closed exactly as in `Enforcing`.
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
    /// Process masquerading under a protected stem without being in the
    /// recorded PID set — a decoy probing for kill-immunity.
    DecoyImpersonation,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl EnforcerState {
    /// Exact time left on the same suspect track used by `tick` for its close
    /// decision. `None` means this browser is not in extension-loss grace;
    /// zero means the deadline has arrived but the process may still exist.
    pub fn grace_remaining_ms(&self, kind: CompanionBrowser, now_mono_ms: u64) -> Option<u64> {
        self.suspects.get(&kind).map(|track| {
            WATCHDOG_GRACE_MS.saturating_sub(now_mono_ms.saturating_sub(track.since_mono_ms))
        })
    }

    /// Whether every browser's exact grace-start track is unchanged. Passage
    /// of time does not alter tracks and therefore needs no revision bump.
    pub(crate) fn same_grace_tracks(&self, other: &Self) -> bool {
        self.suspects == other.suspects
    }

    /// Active grace tracks in the protocol's stable browser order.
    pub fn grace_browsers(&self) -> Vec<CompanionBrowser> {
        [
            CompanionBrowser::Chrome,
            CompanionBrowser::Edge,
            CompanionBrowser::Firefox,
        ]
        .into_iter()
        .filter(|kind| self.suspects.contains_key(kind))
        .collect()
    }
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

/// Exact exe stems of SmartBlocker's own binaries. A stem match is NOT what
/// grants immunity — it only marks a process as a CANDIDATE: genuine
/// companion processes get recorded (see below), and every other stem match
/// is treated as a decoy probe. Substring matching remains a gaping hole:
/// renaming `steam.exe` to `smartblocker-steam.exe` must NOT exempt it.
pub(crate) const PROTECTED_STEMS: &[&str] = &[
    "smartblocker-daemon",
    "smartblocker-companion",
    "smartblocker-nm-host",
];

/// The recorded PID set: the only pids (besides `own_pid`) granted
/// kill-immunity. Captured at daemon start (own pid, supervisor pid when the
/// watchdog spawned us) and REBUILT from every enforcing-phase process scan
/// by `procwatch::SysinfoSource` — dead pids and pid-reuse wash out each
/// refresh instead of silently extending immunity. Process-global by
/// necessity: `tick`'s input signature is owned by the daemon caller.
static RECORDED_PIDS: std::sync::LazyLock<std::sync::Mutex<HashSet<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

/// Record one pid as genuinely ours (own pid, watchdog/supervisor pid).
pub fn record_protected_pid(pid: u32) {
    RECORDED_PIDS.lock().unwrap().insert(pid);
}

/// Replace the recorded set with a freshly verified snapshot (called from
/// `SysinfoSource::snapshot` with the same list the tick is about to see).
pub fn install_protected_pids(set: HashSet<u32>) {
    *RECORDED_PIDS.lock().unwrap() = set;
}

/// Is `pid` in the recorded set?
pub fn is_protected_pid(pid: u32) -> bool {
    RECORDED_PIDS.lock().unwrap().contains(&pid)
}

/// Pure core of the refresh: `{own_pid}` plus every protected-stem process
/// whose exe lives in `own_dir` (lower-cased) — our daemon, watchdog
/// supervisor and nm-host relays all ship side by side, so the install dir
/// is the identity a renamed `/bin/sleep` can't fake. Procs whose exe path
/// is unreadable can't prove identity and are NOT adopted.
pub fn rebuilt_protected_pids(procs: &[ProcInfo], own_pid: u32, own_dir: &str) -> HashSet<u32> {
    let mut set = HashSet::from([own_pid]);
    for p in procs {
        if !PROTECTED_STEMS.contains(&p.name.as_str()) {
            continue;
        }
        let dir = p.exe.as_deref().and_then(|exe| {
            exe.rsplit_once(std::path::is_separator)
                .map(|(dir, _leaf)| dir)
        });
        if dir == Some(own_dir) {
            set.insert(p.pid);
        }
    }
    set
}

fn protected(p: &ProcInfo, own_pid: u32) -> bool {
    p.pid == own_pid || is_protected_pid(p.pid)
}

/// A decoy: wears a protected stem but is not in the recorded PID set.
/// Genuine companion processes land in the set at capture/refresh time, so
/// anything left over with our name is a probe for kill-immunity.
fn decoy(p: &ProcInfo, own_pid: u32) -> bool {
    PROTECTED_STEMS.contains(&p.name.as_str()) && !protected(p, own_pid)
}

fn browser_label(kind: CompanionBrowser) -> &'static str {
    match kind {
        CompanionBrowser::Chrome => "Chrome",
        CompanionBrowser::Edge => "Edge",
        CompanionBrowser::Firefox => "Firefox",
    }
}

pub fn tick(state: &EnforcerState, inp: &TickInputs) -> (EnforcerState, Vec<Action>) {
    if phase_of(inp.lock_status) == Phase::Idle {
        // NO lock source: nothing is armed, kill nothing — and clear every
        // grace timer and notify latch so the next lock starts a fresh
        // session (a kill must never fire off a countdown that began under
        // a previous lock).
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
        match classify_process(&p.name, &p.cmd, &inp.config.extra_incompatible_browsers) {
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

    // -- hostile decoys die immediately ------------------------------------
    // A process wearing one of OUR stems without being in the recorded PID
    // set is probing for kill-immunity. Same mechanics as a blocklisted app
    // (immediate kill, notification latched once per session), with its own
    // reason + events so the masquerade attempt stays visible in the log.
    next.notified_apps = state.notified_apps.clone();
    for p in inp.processes {
        if !decoy(p, inp.own_pid) {
            continue;
        }
        if next.notified_apps.insert(p.name.clone()) {
            actions.push(Action::Notify {
                title: "SmartBlocker".into(),
                body: format!(
                    "{} (pid {}) is pretending to be SmartBlocker; closing it.",
                    p.name, p.pid
                ),
            });
            actions.push(Action::LogEvent {
                kind: "decoy-immune",
                detail: format!("{} pid {} (wall {})", p.name, p.pid, inp.now_wall_ms),
            });
        }
        actions.push(Action::Kill {
            pid: p.pid,
            name: p.name.clone(),
            reason: KillReason::DecoyImpersonation,
        });
        actions.push(Action::LogEvent {
            kind: "decoy-killed",
            detail: format!("{} pid {} (wall {})", p.name, p.pid, inp.now_wall_ms),
        });
    }

    // -- blocklisted apps close immediately ---------------------------------
    for p in inp.processes {
        if protected(p, inp.own_pid) || decoy(p, inp.own_pid) {
            continue;
        }
        // Browsers are handled above; the app blocklist must not offer a
        // second, grace-free path to killing a browser.
        if !matches!(
            classify_process(&p.name, &p.cmd, &inp.config.extra_incompatible_browsers),
            BrowserClass::Unrelated
        ) {
            continue;
        }
        // Typed targets (package > path > exact stem) take precedence over
        // legacy contains rules; the process's exe metadata is what matches,
        // never a parent folder or an arbitrary pid.
        let identity = ProcessIdentity {
            stem: &p.name,
            exe_path: p.exe.as_deref(),
            package_family: p.package_family.as_deref(),
        };
        if !matches_process(
            &identity,
            &inp.config.app_blocklist,
            &inp.config.app_targets,
        ) {
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
            cmd: Vec::new(),
            exe: None,
            package_family: None,
        }
    }

    fn proc_cmd(pid: u32, name: &str, cmd: &[&str]) -> ProcInfo {
        ProcInfo {
            pid,
            name: name.into(),
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
            exe: None,
            package_family: None,
        }
    }

    fn proc_meta(pid: u32, name: &str, exe: Option<&str>, package: Option<&str>) -> ProcInfo {
        ProcInfo {
            pid,
            name: name.into(),
            cmd: Vec::new(),
            exe: exe.map(str::to_string),
            package_family: package.map(str::to_string),
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
    fn idle_means_no_kills_ever() {
        // Phase::Idle (no lock source) is the ONLY phase that kills nothing —
        // not even a blocklisted app that would die instantly while armed.
        let cfg = config(&["steam"], &[]);
        let procs = [proc(1, "steam"), proc(2, "brave"), proc(3, "chrome")];
        let (state, actions) = tick_at(
            &EnforcerState::default(),
            0,
            &idle_status(),
            &procs,
            &[],
            &cfg,
        );
        assert!(actions.is_empty());
        assert!(state.suspects.is_empty() && state.incompatibles.is_empty());
    }

    #[test]
    fn armed_phase_closes_blocklisted_apps_and_incompatibles() {
        // Red-team #25 (user-approved): a plain TIMER lock — settings_locked
        // but NOT force_blocking — carries the same OS-level protection as
        // a forced block. Immediate app kills, notice-then-close browsers.
        let cfg = config(&["steam"], &[]);
        let status = armed_status();
        let procs = [proc(30, "steamwebhelper"), proc(20, "brave")];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        // Blocklisted app dies on the very first armed tick, like Enforcing.
        assert_eq!(kills(&a1), vec![(30, KillReason::BlockedApp)]);
        // Both notices land on first sight: blocked-app and incompatible.
        assert_eq!(notifies(&a1), 2);

        // After the 10s notice the incompatible browser is closed too.
        let (_s2, a2) = tick_at(&s1, 11_001, &status, &[proc(20, "brave")], &[], &cfg);
        assert_eq!(kills(&a2), vec![(20, KillReason::IncompatibleBrowser)]);
    }

    #[test]
    fn armed_phase_runs_the_watchdog_and_kills_decoys() {
        // Red-team #25: while a timer/password lock is armed, a supported
        // browser with a dead/absent pairing follows the same notice+grace+
        // close watchdog path, and unrecorded protected-stem doppelgangers
        // are killed as decoys (no forced block required).
        let cfg = config(&[], &[]);
        let status = armed_status();
        let procs = [proc(10, "chrome"), proc(5041, "smartblocker-daemon")];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a1), vec![(5041, KillReason::DecoyImpersonation)]);
        assert_eq!(notifies(&a1), 2); // decoy notice + watchdog notice
        assert!(kills(&a1).iter().all(|(pid, _)| *pid != 10));

        // Watchdog grace expires mid-lock → chrome is closed.
        let (_s2, a2) = tick_at(&s1, 61_001, &status, &[proc(10, "chrome")], &[], &cfg);
        assert_eq!(kills(&a2), vec![(10, KillReason::Watchdog)]);
    }

    #[test]
    fn dev_flag_pair_is_tolerated_only_while_its_pairing_is_healthy() {
        // Red-team #23: the dev-extension launch pair
        // (--load-extension=<dir> + --disable-extensions-except=<dir>) is the
        // one tolerated flag class — and ONLY while a paired extension
        // connection of that browser kind is heartbeating. A dead/absent
        // pairing converts it into a full bypass attempt (watchdog kill).
        let cfg = config(&[], &[]);
        let status = forced_status();
        let dev = [
            "chromium",
            "--disable-extensions-except=/repo/dist/chrome",
            "--load-extension=/repo/dist/chrome",
        ];
        let procs = [proc_cmd(90, "chromium", &dev)];

        // Healthy paired connection: tolerated indefinitely (no actions ever).
        let healthy = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 900,
        }];
        let (s1, a1) = tick_at(
            &EnforcerState::default(),
            1_000,
            &status,
            &procs,
            &healthy,
            &cfg,
        );
        assert!(a1.is_empty());
        let healthy2 = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 110_000,
        }];
        let (_s2, a2) = tick_at(&s1, 120_000, &status, &procs, &healthy2, &cfg);
        assert!(
            a2.is_empty(),
            "healthy pairing keeps the dev pair tolerated"
        );

        // Dead pairing (no connection of that kind): full bypass attempt —
        // watchdog notice then close, exactly like a browser with no
        // extension at all.
        let (d1, da1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(notifies(&da1), 1);
        assert!(kills(&da1).is_empty());
        let (_d2, da2) = tick_at(&d1, 61_001, &status, &procs, &[], &cfg);
        assert_eq!(kills(&da2), vec![(90, KillReason::Watchdog)]);
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
        assert_eq!(s1.grace_browsers(), vec![CompanionBrowser::Chrome]);
        assert_eq!(
            s1.grace_remaining_ms(CompanionBrowser::Chrome, 1_000),
            Some(60_000)
        );
        assert_eq!(s1.grace_remaining_ms(CompanionBrowser::Edge, 1_000), None);

        // Mid-grace: silent. The public observation is exactly the track used
        // by the next close decision, not heartbeat-send arithmetic.
        let (s2, a2) = tick_at(&s1, 30_000, &status, &procs, &[], &cfg);
        assert!(a2.is_empty());
        assert_eq!(
            s2.grace_remaining_ms(CompanionBrowser::Chrome, 30_000),
            Some(31_000)
        );

        // Grace expired: every chrome pid killed and the observation clamps
        // at zero until a later tick no longer sees the browser process.
        let (s3, a3) = tick_at(&s2, 61_001, &status, &procs, &[], &cfg);
        assert_eq!(
            kills(&a3),
            vec![(10, KillReason::Watchdog), (11, KillReason::Watchdog)]
        );
        assert_eq!(
            s3.grace_remaining_ms(CompanionBrowser::Chrome, 61_001),
            Some(0)
        );
        assert_eq!(
            s3.grace_remaining_ms(CompanionBrowser::Chrome, 120_000),
            Some(0)
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
    fn typed_path_target_closes_only_the_exact_executable() {
        // A decoy/sibling under the same folder, the same stem at another
        // install, and the exact path: only the exact path dies.
        let targets =
            vec![crate::app_targets::AppTarget::exe_path(r"C:\Games\Steam\steam.exe").unwrap()];
        let cfg = CompanionConfig {
            app_targets: targets,
            ..CompanionConfig::default()
        };
        let procs = [
            proc_meta(30, "steam", Some(r"c:\games\steam\steam.exe"), None),
            proc_meta(31, "steam", Some(r"d:\games\steam\steam.exe"), None),
            proc_meta(
                32,
                "steamwebhelper",
                Some(r"c:\games\steam\steamwebhelper.exe"),
                None,
            ),
        ];
        let (_s, actions) = tick_at(
            &EnforcerState::default(),
            1_000,
            &forced_status(),
            &procs,
            &[],
            &cfg,
        );
        assert_eq!(kills(&actions), vec![(30, KillReason::BlockedApp)]);
        assert_eq!(notifies(&actions), 1);
    }

    #[test]
    fn typed_exact_stem_is_not_a_contains_match() {
        let cfg = CompanionConfig {
            app_targets: vec![crate::app_targets::AppTarget::exact_stem("steam").unwrap()],
            ..CompanionConfig::default()
        };
        let procs = [
            proc(30, "steam"),
            proc(31, "steamwebhelper"),
            proc(32, "smartblocker-steam"),
        ];
        let (_s, actions) = tick_at(
            &EnforcerState::default(),
            1_000,
            &forced_status(),
            &procs,
            &[],
            &cfg,
        );
        assert_eq!(kills(&actions), vec![(30, KillReason::BlockedApp)]);
    }

    #[test]
    fn typed_package_target_closes_only_that_package() {
        let cfg = CompanionConfig {
            app_targets: vec![crate::app_targets::AppTarget::msix_package(
                "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
            )
            .unwrap()],
            ..CompanionConfig::default()
        };
        let procs = [
            proc_meta(
                7301,
                "calculator",
                Some(r"c:\program files\windowsapps\calc\calculator.exe"),
                Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
            ),
            proc_meta(
                7302,
                "calculator",
                Some(r"c:\apps\other\calculator.exe"),
                Some("Contoso.Calculator_abc123"),
            ),
            proc_meta(
                7303,
                "calculator",
                Some(r"c:\apps\plain\calculator.exe"),
                None,
            ),
        ];
        let (_s, actions) = tick_at(
            &EnforcerState::default(),
            1_000,
            &forced_status(),
            &procs,
            &[],
            &cfg,
        );
        assert_eq!(kills(&actions), vec![(7301, KillReason::BlockedApp)]);
    }

    #[test]
    fn typed_targets_cannot_bypass_browser_classification_or_protection() {
        let cfg = CompanionConfig {
            app_targets: vec![
                crate::app_targets::AppTarget::exact_stem("chrome").unwrap(),
                crate::app_targets::AppTarget::exact_stem("smartblocker-daemon").unwrap(),
            ],
            ..CompanionConfig::default()
        };
        record_protected_pid(44);
        let procs = [
            // A typed target naming a browser must still go through the
            // watchdog (and here its heartbeat is healthy).
            proc(10, "chrome"),
            proc(44, "smartblocker-daemon"),
            // An unrecorded protected-stem decoy stays a decoy kill.
            proc(5042, "smartblocker-daemon"),
        ];
        let conns = [ConnInfo {
            browser: CompanionBrowser::Chrome,
            last_heartbeat_mono_ms: 500,
        }];
        let (_s, actions) = tick_at(
            &EnforcerState::default(),
            1_000,
            &forced_status(),
            &procs,
            &conns,
            &cfg,
        );
        assert_eq!(
            kills(&actions),
            vec![(5042, KillReason::DecoyImpersonation)]
        );
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
        // own pid (999) under a hostile name + our binaries by RECORDED pid.
        // A bare name match no longer exempts anything (decoy finding).
        record_protected_pid(40);
        record_protected_pid(41);
        let procs = [
            proc(999, "totally-a-game"),
            proc(40, "smartblocker-daemon"),
            proc(41, "smartblocker-nm-host"),
        ];
        let (_s, actions) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert!(kills(&actions).is_empty());
    }

    #[test]
    fn unrecorded_process_with_protected_stem_is_killed_as_a_decoy() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        // NOT recorded: a renamed /bin/sleep probing for kill-immunity.
        // (pid range kept clear of the pids recorded by other tests.)
        let procs = [proc(5041, "smartblocker-daemon")];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a1), vec![(5041, KillReason::DecoyImpersonation)]);
        assert_eq!(notifies(&a1), 1);
        assert!(
            a1.iter()
                .any(|a| matches!(a, Action::LogEvent { kind, .. } if *kind == "decoy-immune")),
            "first sighting logged as a failed immunity probe"
        );
        assert!(
            a1.iter()
                .any(|a| matches!(a, Action::LogEvent { kind, .. } if *kind == "decoy-killed")),
            "the kill itself is logged"
        );

        // Stubborn decoy: killed again next tick, but the probe is reported
        // once per session (notification latch), like the blocklist nag.
        let (_s2, a2) = tick_at(&s1, 4_000, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(5041, KillReason::DecoyImpersonation)]);
        assert_eq!(notifies(&a2), 0);
        assert!(!a2
            .iter()
            .any(|a| matches!(a, Action::LogEvent { kind, .. } if *kind == "decoy-immune")));
    }

    #[test]
    fn rebuilt_set_adopts_only_protected_stems_from_the_install_dir() {
        // own pid + the watchdog (same binary in our dir) + an nm-host relay
        // (sibling stem in our dir) belong; a decoy in /tmp wearing our name
        // and a same-name process with an unreadable exe path do not.
        let procs = [
            ProcInfo {
                pid: 6010,
                name: "smartblocker-daemon".into(),
                cmd: Vec::new(),
                package_family: None,
                exe: Some("/opt/smartblocker/smartblocker-daemon".into()),
            },
            ProcInfo {
                pid: 6011,
                name: "smartblocker-nm-host".into(),
                cmd: Vec::new(),
                package_family: None,
                exe: Some("/opt/smartblocker/smartblocker-nm-host".into()),
            },
            ProcInfo {
                pid: 6012,
                name: "smartblocker-daemon".into(),
                cmd: Vec::new(),
                package_family: None,
                exe: Some("/tmp/decoy/smartblocker-daemon".into()),
            },
            ProcInfo {
                pid: 6013,
                name: "smartblocker-daemon".into(),
                cmd: Vec::new(),
                package_family: None,
                exe: None,
            },
            proc(6014, "steam"),
        ];
        let set = rebuilt_protected_pids(&procs, 999, "/opt/smartblocker");
        assert_eq!(set, HashSet::from([999, 6010, 6011]));
    }

    #[test]
    fn renamed_browser_is_closed_via_engine_fingerprint() {
        // brave.exe renamed to surf.exe: no stem match, but Chromium child
        // flags give it away → incompatible path (notice, then close).
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc_cmd(50, "surf", &["surf", "--type=renderer"])];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(notifies(&a1), 1);
        assert!(kills(&a1).is_empty());

        let (_s2, a2) = tick_at(&s1, 11_001, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(50, KillReason::IncompatibleBrowser)]);
    }

    #[test]
    fn renamed_gecko_browser_is_closed_via_contentproc_flag() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc_cmd(
            51,
            "citrus",
            &["/opt/citrus/citrus", "-contentproc", "-prefsji"],
        )];

        let (s1, _a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        let (_s2, a2) = tick_at(&s1, 11_001, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(51, KillReason::IncompatibleBrowser)]);
    }

    #[test]
    fn electron_apps_are_not_fingerprinted_as_browsers() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        // VS Code by stem; a renamed Electron app caught only by app.asar.
        let procs = [
            proc_cmd(60, "code", &["/usr/share/code/code", "--type=renderer"]),
            proc_cmd(61, "writely", &["writely", "--type=renderer", "app.asar"]),
        ];
        // Past any grace: neither may ever be killed or flagged.
        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert!(a1.is_empty());
        let (_s2, a2) = tick_at(&s1, 30_000, &status, &procs, &[], &cfg);
        assert!(a2.is_empty());
    }

    #[test]
    fn supported_browser_with_bypass_flags_is_closed_as_incompatible() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc_cmd(70, "chrome", &["chrome", "--incognito"])];

        let (s1, a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(notifies(&a1), 1);
        assert!(kills(&a1).is_empty());

        let (_s2, a2) = tick_at(&s1, 11_001, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(70, KillReason::IncompatibleBrowser)]);
    }

    #[test]
    fn disable_extensions_launch_is_closed_as_incompatible() {
        let cfg = config(&[], &[]);
        let status = forced_status();
        let procs = [proc_cmd(71, "chrome", &["chrome", "--disable-extensions"])];

        let (s1, _a1) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        let (_s2, a2) = tick_at(&s1, 11_001, &status, &procs, &[], &cfg);
        assert_eq!(kills(&a2), vec![(71, KillReason::IncompatibleBrowser)]);
    }

    #[test]
    fn lookalike_names_get_no_self_exemption() {
        // The old substring exemption would have spared "smartblocker-steam",
        // and the old exact-stem exemption would have spared the unrecorded
        // "smartblocker-daemon" decoy. Neither survives now.
        let cfg = config(&["smartblocker", "steam"], &[]);
        let status = forced_status();
        let procs = [
            proc(80, "smartblocker-steam"),
            proc(81, "smartblocker-daemon"),
        ];
        let (_s, actions) = tick_at(&EnforcerState::default(), 1_000, &status, &procs, &[], &cfg);
        assert_eq!(
            kills(&actions),
            vec![
                (81, KillReason::DecoyImpersonation),
                (80, KillReason::BlockedApp)
            ]
        );
    }
}
