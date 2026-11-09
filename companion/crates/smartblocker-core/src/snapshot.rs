//! `status-snapshot.json`: the daemon's heartbeat file for the desktop UI.
//! Every daemon tick (≈1s idle, ≈3s while locked) rewrites it atomically
//! with the daemon's identity and the browsers whose extension is connected
//! AND paired (authenticated hello) right now. The UI can't read the
//! daemon's in-memory connection registry, and an unauthenticated UI client
//! must never be able to learn which browsers are paired from IPC, so the
//! file in the (same-user) data dir is the channel.
//!
//! Readers treat a snapshot older than [`SNAPSHOT_STALE_MS`] as "companion
//! not running" — a killed daemon can't delete its own file.

use std::io;

use serde::{Deserialize, Serialize};

use crate::protocol::CompanionBrowser;
use crate::store::Store;

const SNAPSHOT_FILE: &str = "status-snapshot.json";

/// Age past which a snapshot means the daemon is gone (a few missed ticks
/// even at the slower 3s enforcing cadence).
pub const SNAPSHOT_STALE_MS: i64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    /// `chrome` | `edge` | `firefox`.
    pub kind: CompanionBrowser,
    pub ext_version: String,
    /// Wall-clock epoch ms of the connection's last frame (heartbeats every
    /// 20s while healthy).
    pub last_seen_ms: i64,
}

/// An active browser-close grace track. This is intentionally separate from
/// `browsers`: the relay can disappear exactly when the warning matters most.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGraceInfo {
    pub kind: CompanionBrowser,
    /// Wall-clock receipt/display anchor for this daemon observation.
    pub observed_at_ms: i64,
    pub grace_seconds: u64,
    pub grace_remaining_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub pid: u32,
    pub started_at_ms: i64,
    pub written_at_ms: i64,
    /// One entry per browser kind (the freshest connection wins when several
    /// profiles of the same browser are paired), sorted chrome/edge/firefox.
    pub browsers: Vec<BrowserInfo>,
    /// Enforcer-owned grace tracks, including browsers whose relay is gone.
    /// Missing in older snapshots, hence the additive default.
    #[serde(default)]
    pub browser_grace: Vec<BrowserGraceInfo>,
}

impl StatusSnapshot {
    /// Written within the last [`SNAPSHOT_STALE_MS`]. A snapshot dated far in
    /// the FUTURE (wall clock stepped back) is also treated as stale; the
    /// live daemon rewrites it within a tick.
    pub fn is_fresh(&self, now_ms: i64) -> bool {
        (now_ms - self.written_at_ms).abs() <= SNAPSHOT_STALE_MS
    }
}

/// Collapse per-connection browser records into one per kind (latest seen).
pub fn dedupe_browsers(mut all: Vec<BrowserInfo>) -> Vec<BrowserInfo> {
    all.sort_by(|a, b| {
        kind_order(a.kind)
            .cmp(&kind_order(b.kind))
            .then(b.last_seen_ms.cmp(&a.last_seen_ms))
    });
    all.dedup_by(|later, first| later.kind == first.kind);
    all
}

fn kind_order(kind: CompanionBrowser) -> u8 {
    match kind {
        CompanionBrowser::Chrome => 0,
        CompanionBrowser::Edge => 1,
        CompanionBrowser::Firefox => 2,
    }
}

/// Atomic (temp + rename) write.
pub fn write_snapshot(store: &Store, snapshot: &StatusSnapshot) -> io::Result<()> {
    store.write_json_atomic(SNAPSHOT_FILE, snapshot)
}

/// The last snapshot on disk regardless of age (missing/corrupt = None).
pub fn read_snapshot(store: &Store) -> Option<StatusSnapshot> {
    store.read_json(SNAPSHOT_FILE)
}

/// The snapshot only if a daemon wrote it recently — `None` = treat the
/// companion as not running.
pub fn read_live_snapshot(store: &Store, now_ms: i64) -> Option<StatusSnapshot> {
    read_snapshot(store).filter(|s| s.is_fresh(now_ms))
}

/// Desktop status must combine the latest persisted lock with the daemon's
/// latest tick. An unlock can happen between ticks; stale grace must disappear
/// immediately rather than survive until the enforcer clears its next track.
pub fn browser_grace_for_lock(
    snapshot: Option<&StatusSnapshot>,
    settings_locked: bool,
) -> Vec<BrowserGraceInfo> {
    if !settings_locked {
        return Vec::new();
    }
    snapshot
        .map(|snapshot| snapshot.browser_grace.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn info(kind: CompanionBrowser, v: &str, seen: i64) -> BrowserInfo {
        BrowserInfo {
            kind,
            ext_version: v.into(),
            last_seen_ms: seen,
        }
    }

    #[test]
    fn roundtrips_with_camel_case_shape() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let snap = StatusSnapshot {
            pid: 42,
            started_at_ms: NOW - 5_000,
            written_at_ms: NOW,
            browsers: vec![info(CompanionBrowser::Edge, "0.5.0", NOW - 1)],
            browser_grace: vec![BrowserGraceInfo {
                kind: CompanionBrowser::Edge,
                observed_at_ms: NOW,
                grace_seconds: 60,
                grace_remaining_ms: 42_000,
            }],
        };
        write_snapshot(&store, &snap).unwrap();
        assert_eq!(read_snapshot(&store), Some(snap.clone()));
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SNAPSHOT_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["startedAtMs"], NOW - 5_000);
        assert_eq!(raw["writtenAtMs"], NOW);
        assert_eq!(raw["browsers"][0]["kind"], "edge");
        assert_eq!(raw["browsers"][0]["extVersion"], "0.5.0");
        assert_eq!(raw["browsers"][0]["lastSeenMs"], NOW - 1);
        assert_eq!(raw["browserGrace"][0]["observedAtMs"], NOW);
        assert_eq!(raw["browserGrace"][0]["graceRemainingMs"], 42_000);

        assert_eq!(
            browser_grace_for_lock(Some(&snap), true),
            snap.browser_grace
        );
        assert!(
            browser_grace_for_lock(Some(&snap), false).is_empty(),
            "an unlock between enforcing ticks hides stale grace immediately"
        );
        assert!(browser_grace_for_lock(None, true).is_empty());
    }

    #[test]
    fn old_snapshot_without_grace_defaults_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SNAPSHOT_FILE),
            serde_json::to_vec(&serde_json::json!({
                "pid": 1,
                "startedAtMs": NOW,
                "writtenAtMs": NOW,
                "browsers": [],
            }))
            .unwrap(),
        )
        .unwrap();
        let snap = read_snapshot(&Store::new(dir.path())).unwrap();
        assert!(snap.browser_grace.is_empty());
    }

    #[test]
    fn staleness_window() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(
            read_live_snapshot(&store, NOW).is_none(),
            "missing = not running"
        );
        let snap = StatusSnapshot {
            pid: 1,
            started_at_ms: NOW,
            written_at_ms: NOW,
            browsers: vec![],
            browser_grace: vec![],
        };
        write_snapshot(&store, &snap).unwrap();
        assert!(read_live_snapshot(&store, NOW + SNAPSHOT_STALE_MS).is_some());
        assert!(read_live_snapshot(&store, NOW + SNAPSHOT_STALE_MS + 1).is_none());
        assert!(read_live_snapshot(&store, NOW - SNAPSHOT_STALE_MS - 1).is_none());
        // The raw reader still returns it (diagnostics).
        assert!(read_snapshot(&store).is_some());
    }

    #[test]
    fn corrupt_snapshot_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SNAPSHOT_FILE), b"{").unwrap();
        assert!(read_snapshot(&Store::new(dir.path())).is_none());
    }

    #[test]
    fn dedupe_keeps_freshest_per_kind_in_stable_order() {
        let out = dedupe_browsers(vec![
            info(CompanionBrowser::Firefox, "1", 10),
            info(CompanionBrowser::Chrome, "old", 5),
            info(CompanionBrowser::Chrome, "new", 9),
            info(CompanionBrowser::Edge, "e", 1),
        ]);
        assert_eq!(
            out,
            vec![
                info(CompanionBrowser::Chrome, "new", 9),
                info(CompanionBrowser::Edge, "e", 1),
                info(CompanionBrowser::Firefox, "1", 10),
            ]
        );
    }
}
