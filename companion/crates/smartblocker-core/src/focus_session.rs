//! Deferred "focus session" start with a 60-second undo — the desktop mirror
//! of `src/shared/focus-session.ts`. A focus session is a frozen lock
//! (`frozen_until`); the lock store and the merge are strictly monotonic, so
//! an "oops" undo can't cancel a lock. Instead the START is deferred:
//!
//! - [`start_pending_session`] writes `pending-session.json` (end time fixed
//!   at the click). Nothing touches `lock-state.json` yet.
//! - [`undo_pending_session`] deletes it — only before `commit_at_ms`.
//! - The daemon tick ([`claim_due_session`] → merge → [`finish_claim`])
//!   commits it once due, through the same merge + persist + broadcast path
//!   a `lockStateSync` uses, so every paired extension hears it.
//!
//! The pending record lives in the data dir (not the UI process), so the
//! commit survives closing the window.
//!
//! **Atomicity.** The file only ever moves forward:
//! `absent → pending` (no-clobber create: a second start can never replace a
//! live record) and `pending → claimed` (a rename). Undo and commit each
//! claim by RENAMING `pending-session.json` to their own claim name; the
//! source vanishes on the first rename, so exactly one of them wins. Undo
//! refuses once the record is due, and commit only claims a due record, so
//! the read-then-claim window can't commit a different record early (a
//! record can't be replaced, and a due one can't be undone).
//!
//! **Crash safety.** The commit claim (`pending-session.committing.json`) is
//! removed only AFTER the merged lock is persisted; a leftover claim is
//! re-committed on the next tick (the merge is idempotent).

use std::fmt;
use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use crate::lock_math::MAX_LOCK_MS;
use crate::store::Store;

/// Undo window, matching the extension's `FOCUS_UNDO_MS`.
pub const FOCUS_UNDO_MS: i64 = 60_000;

const PENDING_FILE: &str = "pending-session.json";
/// Commit claim: survives a crash between claim and persist (re-committed).
const COMMITTING_FILE: &str = "pending-session.committing.json";
/// Undo claim: deleted immediately after the rename wins.
const UNDOING_FILE: &str = "pending-session.undoing.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSession {
    /// Absolute end of the session (wall epoch ms), fixed at the click.
    pub until_ms: i64,
    /// When the undo window closes and the lock is written.
    pub commit_at_ms: i64,
    pub duration_ms: i64,
}

#[derive(Debug)]
pub enum FocusError {
    /// `minutes == 0`.
    InvalidDuration,
    /// A session is already waiting out its undo window; carries it so the
    /// UI can show the existing countdown.
    AlreadyPending(PendingSession),
    Io(io::Error),
}

impl fmt::Display for FocusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FocusError::InvalidDuration => write!(f, "Choose a duration of at least 1 minute."),
            FocusError::AlreadyPending(_) => write!(
                f,
                "A focus session is already starting — undo it first to pick a different length."
            ),
            FocusError::Io(e) => write!(f, "Couldn't save the focus session: {e}"),
        }
    }
}

impl std::error::Error for FocusError {}

/// Minutes → session length in ms, clamped to the fat-finger cap.
fn duration_ms(minutes: u64) -> i64 {
    i64::try_from(minutes)
        .unwrap_or(i64::MAX)
        .saturating_mul(60_000)
        .min(MAX_LOCK_MS)
}

/// The record in its undo window, if any (corrupt = none).
pub fn read_pending_session(store: &Store) -> Option<PendingSession> {
    store.read_json(PENDING_FILE)
}

/// Defer a focus session of `minutes` (end fixed now: `until = now +
/// minutes`, clamped by `MAX_LOCK_MS`). Refuses while another session is
/// still pending — the existing record is never replaced (see module docs).
pub fn start_pending_session(
    store: &Store,
    minutes: u64,
    now_ms: i64,
) -> Result<PendingSession, FocusError> {
    if minutes == 0 {
        return Err(FocusError::InvalidDuration);
    }
    let duration_ms = duration_ms(minutes);
    let session = PendingSession {
        until_ms: now_ms.saturating_add(duration_ms),
        commit_at_ms: now_ms.saturating_add(FOCUS_UNDO_MS),
        duration_ms,
    };
    // Two attempts: the second only after clearing an UNPARSEABLE leftover
    // (a torn/hand-mangled file must not wedge every future start).
    for _ in 0..2 {
        let tmp = store.temp_json(&session).map_err(FocusError::Io)?;
        match tmp.persist_noclobber(store.dir().join(PENDING_FILE)) {
            Ok(_) => return Ok(session),
            Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => {
                if let Some(existing) = read_pending_session(store) {
                    return Err(FocusError::AlreadyPending(existing));
                }
                remove_if_present(store, PENDING_FILE).map_err(FocusError::Io)?;
            }
            Err(e) => return Err(FocusError::Io(e.error)),
        }
    }
    Err(FocusError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "pending-session.json keeps reappearing",
    )))
}

/// Cancel a pending session inside its undo window. `false` = nothing to
/// undo: no record, the window has closed (`now >= commit_at_ms`, the
/// session is locked in even if the daemon hasn't ticked yet), or the
/// daemon's commit claim won the race.
pub fn undo_pending_session(store: &Store, now_ms: i64) -> bool {
    let Some(pending) = read_pending_session(store) else {
        return false;
    };
    if now_ms >= pending.commit_at_ms {
        return false;
    }
    let claimed = store.dir().join(UNDOING_FILE);
    match fs::rename(store.dir().join(PENDING_FILE), &claimed) {
        Ok(()) => {
            let _ = fs::remove_file(claimed);
            true
        }
        // NotFound = the commit claimed it first.
        Err(_) => false,
    }
}

/// Daemon side: atomically claim the session if its undo window has closed.
/// Also returns a commit claim left behind by a crash (idempotent re-commit).
/// After merging, the caller MUST call [`finish_claim`].
pub fn claim_due_session(store: &Store, now_ms: i64) -> Option<PendingSession> {
    let committing = store.dir().join(COMMITTING_FILE);
    if committing.exists() {
        match store.read_json::<PendingSession>(COMMITTING_FILE) {
            Some(leftover) => return Some(leftover),
            None => {
                let _ = fs::remove_file(&committing);
            }
        }
    }
    let pending_path = store.dir().join(PENDING_FILE);
    if !pending_path.exists() {
        return None;
    }
    let Some(pending) = read_pending_session(store) else {
        // Unparseable: drop it so it can't wedge starts (nothing to commit).
        let _ = fs::remove_file(&pending_path);
        return None;
    };
    if now_ms < pending.commit_at_ms {
        return None;
    }
    // Rename-to-claim; NotFound = undo won the race.
    fs::rename(&pending_path, &committing).ok()?;
    // Commit what was actually claimed (the record can't have been replaced
    // — module docs — but the claimed bytes are the source of truth).
    store.read_json(COMMITTING_FILE).or(Some(pending))
}

/// Drop the commit claim once the merged lock state is persisted.
pub fn finish_claim(store: &Store) {
    if let Err(e) = remove_if_present(store, COMMITTING_FILE) {
        eprintln!("[focus-session] failed to clear commit claim: {e}");
    }
}

fn remove_if_present(store: &Store, file: &str) -> io::Result<()> {
    match fs::remove_file(store.dir().join(file)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("data"));
        (dir, store)
    }

    #[test]
    fn start_fixes_end_time_and_undo_window_at_click() {
        let (_d, store) = temp_store();
        let s = start_pending_session(&store, 60, NOW).unwrap();
        assert_eq!(
            s,
            PendingSession {
                until_ms: NOW + 3_600_000,
                commit_at_ms: NOW + FOCUS_UNDO_MS,
                duration_ms: 3_600_000,
            }
        );
        assert_eq!(read_pending_session(&store), Some(s));
        // Lock state is untouched until commit.
        assert_eq!(store.load_lock_state(), Default::default());
    }

    #[test]
    fn duration_is_clamped_and_zero_refused() {
        let (_d, store) = temp_store();
        assert!(matches!(
            start_pending_session(&store, 0, NOW),
            Err(FocusError::InvalidDuration)
        ));
        let s = start_pending_session(&store, u64::MAX, NOW).unwrap();
        assert_eq!(s.duration_ms, MAX_LOCK_MS);
        assert_eq!(s.until_ms, NOW + MAX_LOCK_MS);
    }

    #[test]
    fn second_start_is_refused_and_keeps_the_original() {
        let (_d, store) = temp_store();
        let first = start_pending_session(&store, 60, NOW).unwrap();
        match start_pending_session(&store, 480, NOW + 5_000) {
            Err(FocusError::AlreadyPending(existing)) => assert_eq!(existing, first),
            other => panic!("expected AlreadyPending, got {other:?}"),
        }
        assert_eq!(read_pending_session(&store), Some(first));
    }

    #[test]
    fn corrupt_leftover_does_not_wedge_start() {
        let (_d, store) = temp_store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.dir().join(PENDING_FILE), b"{ torn").unwrap();
        assert!(read_pending_session(&store).is_none());
        let s = start_pending_session(&store, 30, NOW).unwrap();
        assert_eq!(read_pending_session(&store), Some(s));
    }

    #[test]
    fn undo_inside_window_removes_and_blocks_commit() {
        let (_d, store) = temp_store();
        start_pending_session(&store, 60, NOW).unwrap();
        assert!(undo_pending_session(&store, NOW + 59_999));
        assert!(read_pending_session(&store).is_none());
        assert!(claim_due_session(&store, NOW + 120_000).is_none());
        // Second undo: nothing left.
        assert!(!undo_pending_session(&store, NOW + 1));
        // No claim files left behind.
        let leftovers: Vec<_> = fs::read_dir(store.dir()).unwrap().collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn undo_is_refused_once_due_even_before_the_daemon_ticks() {
        let (_d, store) = temp_store();
        let s = start_pending_session(&store, 60, NOW).unwrap();
        assert!(!undo_pending_session(&store, s.commit_at_ms));
        // Still there for the daemon to commit.
        assert_eq!(read_pending_session(&store), Some(s));
    }

    #[test]
    fn claim_waits_for_the_window_then_wins_exactly_once() {
        let (_d, store) = temp_store();
        let s = start_pending_session(&store, 60, NOW).unwrap();
        assert!(claim_due_session(&store, s.commit_at_ms - 1).is_none());
        assert_eq!(claim_due_session(&store, s.commit_at_ms), Some(s));
        // Claimed: undo loses, the UI no longer sees it pending.
        assert!(!undo_pending_session(&store, NOW));
        assert!(read_pending_session(&store).is_none());
        finish_claim(&store);
        assert!(claim_due_session(&store, s.commit_at_ms + 10_000).is_none());
        // A fresh session may start after the claim resolves.
        assert!(start_pending_session(&store, 60, s.commit_at_ms + 10_000).is_ok());
    }

    #[test]
    fn crash_between_claim_and_finish_recommits() {
        let (_d, store) = temp_store();
        let s = start_pending_session(&store, 60, NOW).unwrap();
        assert_eq!(claim_due_session(&store, s.commit_at_ms), Some(s));
        // "Crash": finish_claim never ran. Next tick re-delivers it.
        assert_eq!(claim_due_session(&store, s.commit_at_ms + 1_000), Some(s));
        finish_claim(&store);
        assert!(claim_due_session(&store, s.commit_at_ms + 2_000).is_none());
    }

    #[test]
    fn undo_and_commit_race_has_exactly_one_winner() {
        // Hammer the rename-to-claim from two threads over many rounds:
        // never both, never neither (the window is wide open for undo since
        // `now` passed to undo is inside it, and commit's `now` is due).
        for _ in 0..200 {
            let (_d, store) = temp_store();
            let s = start_pending_session(&store, 60, NOW).unwrap();
            let dir = store.dir().to_path_buf();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let b2 = barrier.clone();
            let d2 = dir.clone();
            let undo = std::thread::spawn(move || {
                b2.wait();
                undo_pending_session(&Store::new(d2), NOW)
            });
            barrier.wait();
            let committed = claim_due_session(&Store::new(dir), s.commit_at_ms).is_some();
            let undone = undo.join().unwrap();
            assert!(committed ^ undone, "committed={committed} undone={undone}");
        }
    }

    #[test]
    fn corrupt_pending_file_is_dropped_by_the_daemon() {
        let (_d, store) = temp_store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.dir().join(PENDING_FILE), b"nope").unwrap();
        assert!(claim_due_session(&store, NOW).is_none());
        assert!(!store.dir().join(PENDING_FILE).exists());
    }

    #[test]
    fn json_shape_is_camel_case() {
        let v = serde_json::to_value(PendingSession {
            until_ms: 3,
            commit_at_ms: 2,
            duration_ms: 1,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "untilMs": 3, "commitAtMs": 2, "durationMs": 1 })
        );
    }
}
