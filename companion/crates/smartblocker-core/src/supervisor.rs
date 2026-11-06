//! Watchdog-supervisor linkage, daemon side. The pair watches each other:
//! the watchdog (`smartblocker-daemon watchdog`) spawns and revives the
//! daemon when the IPC socket dies, and the daemon — via this module —
//! revives the watchdog. Either one alone would die to a single `pkill`.
//!
//! The daemon learns its supervisor's pid from an ENV VAR the watchdog sets
//! on the `run` child it spawns. Env beats a raw parent-pid probe: the spawn
//! is detached (null stdio, reparented on Unix), so after re-parenting the
//! parent chain is ambiguous, while the var is an explicit handle carried
//! with the process image.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Env var the watchdog sets on the `run` child it spawns, carrying the
/// watchdog's own pid.
pub const WATCHDOG_PID_ENV: &str = "SMARTBLOCKER_WATCHDOG_PID";

/// The supervisor pid recorded at spawn time (None = nobody watches us —
/// plain `run`, where the daemon intentionally has no supervisor to revive).
pub fn watchdog_pid_from_env() -> Option<u32> {
    std::env::var(WATCHDOG_PID_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|pid| *pid > 0)
}

/// Forever-loop for a background thread: every `tick`, check the
/// supervisor's liveness; when it's gone, `respawn` a new watchdog, record
/// its pid in the enforcer's protected set (kill-immunity), and log the
/// revival to the data dir's events.log — a supervisor death is exactly the
/// signal a tamper investigation wants.
pub fn supervise_forever(
    initial_supervisor: u32,
    tick: Duration,
    mut respawn: impl FnMut() -> Option<u32>,
    events_dir: PathBuf,
) -> ! {
    let mut supervisor = initial_supervisor;
    loop {
        std::thread::sleep(tick);
        if crate::procwatch::pid_alive(supervisor) {
            continue;
        }
        let Some(new_pid) = respawn() else {
            continue; // spawn failed (binary gone?) — retry next tick
        };
        crate::enforcer::record_protected_pid(new_pid);
        log_event(
            &events_dir,
            &format!("supervisor {supervisor} gone, respawned as pid {new_pid}"),
        );
        supervisor = new_pid;
    }
}

/// One events.log line, in the daemon's `Shared::log_event` format
/// (`{wall_ms} {kind} {detail}`) so log consumers see one timeline.
fn log_event(dir: &Path, detail: &str) {
    use std::io::Write as _;
    let wall_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.log"))
        .and_then(|mut f| {
            f.write_all(format!("{wall_ms} supervisor-respawned {detail}\n").as_bytes())
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respawn_event_lands_in_the_standard_events_log_format() {
        let dir = tempfile::tempdir().unwrap();
        log_event(dir.path(), "supervisor 123 gone, respawned as pid 456");
        let content = std::fs::read_to_string(dir.path().join("events.log")).unwrap();
        let line = content.trim();
        // Same shape as daemon events: "<wall_ms> <kind> <detail>".
        assert!(line.contains(" supervisor-respawned supervisor 123 gone, respawned as pid 456"));
        assert!(line.split(' ').next().unwrap().parse::<u64>().is_ok());
    }
}
