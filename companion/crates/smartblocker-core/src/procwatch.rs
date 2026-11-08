//! Process observation behind a trait so the enforcement loop and its tests
//! never touch the real system. The daemon polls a `SysinfoSource`; tests
//! script a `FakeSource`.

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Lowercased exe file stem. Derived from `exe()` because on Linux
    /// `Process::name()` truncates to 15 chars ("chromium-browser" would
    /// never match its stem); `name()` is only the fallback when the exe
    /// path is unreadable (e.g. zombie or permission-denied).
    pub name: String,
    /// Lowercased command-line arguments: the fingerprint data behind
    /// bypass-flag detection (`--incognito`, `--disable-extensions`) and
    /// anti-rename engine detection (`--type=renderer`, `-contentproc`).
    /// Empty for tests that don't exercise the command line.
    pub cmd: Vec<String>,
    /// Lowercased full exe path when readable. The enforcer's recorded-PID
    /// immunity binds to this (exe under the companion's install dir), so a
    /// process merely RENAMED to a protected stem can't inherit trust.
    pub exe: Option<String>,
}

pub trait ProcessSource {
    fn snapshot(&mut self) -> Vec<ProcInfo>;
    /// Best-effort terminate (SIGKILL / TerminateProcess via sysinfo).
    fn kill(&mut self, pid: u32) -> bool;
}

pub struct SysinfoSource {
    sys: System,
    /// Lowercased dir of OUR OWN executable: the identity anchor for the
    /// enforcer's recorded-PID set (our daemon/watchdog/nm-host all ship in
    /// the same dir; every same-stem process elsewhere is a decoy).
    own_dir: Option<String>,
}

impl SysinfoSource {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let own_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.to_string_lossy().to_lowercase()));
        Self {
            sys: System::new(),
            own_dir,
        }
    }
}

impl ProcessSource for SysinfoSource {
    fn snapshot(&mut self) -> Vec<ProcInfo> {
        // Selective refresh: we only consume pid + exe/name + cmdline.
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet),
        );
        let procs: Vec<ProcInfo> = self
            .sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcInfo {
                pid: pid.as_u32(),
                name: stem_of(p),
                cmd: p
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .collect(),
                exe: p.exe().map(|path| path.to_string_lossy().to_lowercase()),
            })
            .collect();
        // Keep kill-immunity fresh from the same data the enforcer tick will
        // judge: the daemon only snapshots while enforcing, so the set is
        // rebuilt right where it is used (dead pids and pid-reuse drop out
        // on every refresh, and late-spawned nm-host relays are adopted).
        if let Some(dir) = &self.own_dir {
            crate::enforcer::install_protected_pids(crate::enforcer::rebuilt_protected_pids(
                &procs,
                std::process::id(),
                dir,
            ));
        }
        procs
    }

    fn kill(&mut self, pid: u32) -> bool {
        self.sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.kill())
            .unwrap_or(false)
    }
}

fn stem_of(p: &sysinfo::Process) -> String {
    p.exe()
        .and_then(|path| path.file_stem())
        .map(|s| normalize_exe_stem(&s.to_string_lossy()))
        .unwrap_or_else(|| normalize_exe_stem(&p.name().to_string_lossy()))
}

/// Canonical app name: lowercase, no `.exe`, and no self-updater version
/// suffix (`agy.exe.1793826601058390500` → `agy`). The running-apps picker
/// and the enforcer share this, so a name the user picks keeps matching
/// after the app updates itself.
pub fn normalize_exe_stem(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    if let Some(i) = lower.find(".exe.") {
        let rest = &lower[i + ".exe.".len()..];
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return lower[..i].to_string();
        }
    }
    lower
        .strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(lower)
}

/// Cheap liveness probe for one pid (the supervisor thread's "is my
/// watchdog still there?" check — no full process refresh).
pub fn pid_alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    sys.process(pid).is_some()
}

/// Scriptable source for tests (enforcer scenarios, M5 daemon tests, e2e
/// dry-runs). Snapshots are consumed in order; the last one repeats.
pub struct FakeSource {
    snapshots: Vec<Vec<ProcInfo>>,
    cursor: usize,
    pub killed: Vec<u32>,
}

impl FakeSource {
    pub fn new(snapshots: Vec<Vec<ProcInfo>>) -> Self {
        Self {
            snapshots,
            cursor: 0,
            killed: Vec::new(),
        }
    }
}

impl ProcessSource for FakeSource {
    fn snapshot(&mut self) -> Vec<ProcInfo> {
        let snap = self
            .snapshots
            .get(self.cursor)
            .or_else(|| self.snapshots.last())
            .cloned()
            .unwrap_or_default();
        if self.cursor + 1 < self.snapshots.len() {
            self.cursor += 1;
        }
        snap
    }

    fn kill(&mut self, pid: u32) -> bool {
        self.killed.push(pid);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_source_replays_then_repeats_last_snapshot() {
        let a = vec![ProcInfo {
            pid: 1,
            name: "chrome".into(),
            cmd: Vec::new(),
            exe: None,
        }];
        let b = vec![ProcInfo {
            pid: 2,
            name: "steam".into(),
            cmd: Vec::new(),
            exe: None,
        }];
        let mut src = FakeSource::new(vec![a.clone(), b.clone()]);
        assert_eq!(src.snapshot(), a);
        assert_eq!(src.snapshot(), b);
        assert_eq!(src.snapshot(), b);
        assert!(src.kill(2));
        assert_eq!(src.killed, vec![2]);
    }

    // Documents the Linux hazard that forces exe()-based naming: a process
    // named by the kernel comm field is truncated to 15 chars, so matching
    // "chromium-browser" against name() alone can never work.
    #[test]
    fn fifteen_char_truncated_comm_would_not_match_a_browser_stem() {
        let truncated = &"chromium-browser"[..15];
        assert_eq!(truncated, "chromium-browse");
        assert_ne!(truncated, "chromium-browser");
    }

    #[test]
    fn sysinfo_source_reports_own_process() {
        let mut src = SysinfoSource::new();
        let me = std::process::id();
        let procs = src.snapshot();
        assert!(procs.iter().any(|p| p.pid == me));
    }

    #[test]
    fn pid_alive_knows_the_current_process_and_a_dead_one() {
        assert!(pid_alive(std::process::id()));
        // pid 0 is never a userspace process.
        assert!(!pid_alive(0));
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::normalize_exe_stem;

    #[test]
    fn strips_exe_and_self_updater_suffixes() {
        assert_eq!(normalize_exe_stem("Steam.exe"), "steam");
        assert_eq!(normalize_exe_stem("  Discord "), "discord");
        assert_eq!(normalize_exe_stem("agy.exe.1793826601058390500"), "agy");
        assert_eq!(normalize_exe_stem("app.exe.1.2.3"), "app");
    }

    #[test]
    fn leaves_other_dotted_names_alone() {
        assert_eq!(normalize_exe_stem("my.exe.helper"), "my.exe.helper");
        assert_eq!(normalize_exe_stem("node.js"), "node.js");
        assert_eq!(normalize_exe_stem("app.exe."), "app.exe.");
    }
}
