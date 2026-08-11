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
}

pub trait ProcessSource {
    fn snapshot(&mut self) -> Vec<ProcInfo>;
    /// Best-effort terminate (SIGKILL / TerminateProcess via sysinfo).
    fn kill(&mut self, pid: u32) -> bool;
}

pub struct SysinfoSource {
    sys: System,
}

impl SysinfoSource {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { sys: System::new() }
    }
}

impl ProcessSource for SysinfoSource {
    fn snapshot(&mut self) -> Vec<ProcInfo> {
        // Selective refresh: we only consume pid + exe/name.
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        self.sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcInfo {
                pid: pid.as_u32(),
                name: stem_of(p),
            })
            .collect()
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
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| p.name().to_string_lossy().to_lowercase())
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
        }];
        let b = vec![ProcInfo {
            pid: 2,
            name: "steam".into(),
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
}
