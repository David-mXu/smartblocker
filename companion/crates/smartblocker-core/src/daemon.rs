//! The long-running companion service: accepts nm-host relays over local
//! IPC, keeps the connection registry the watchdog reads, merges lock state
//! with every extension, and drives the enforcement loop. Runs identically
//! under the headless `smartblocker-daemon` binary (Linux/e2e) and inside the
//! Tauri shell (Windows, M7) — only the `Notifier` differs.

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::enforcer::{self, Action, ConnInfo, EnforcerState, TickInputs};
use crate::focus_session;
use crate::framing::{encode_frame, read_frame};
use crate::ipc;
use crate::ipc::traits::{ListenerExt as _, RecvHalf as _, SendHalf as _, Stream as _};
use crate::lock_math::{
    derive_lock_status, next_boundary, sanitize_lock_state, LockState, MAX_LOCK_MS,
};
use crate::merge::merge_lock_states;
use crate::procwatch::{ProcessSource, SysinfoSource};
use crate::protocol::{
    parse_message, CompanionBrowser, CompanionEnforcement, CompanionMessage, CompanionStatus,
    PROTOCOL_VERSION,
};
use crate::snapshot::{self, BrowserInfo, StatusSnapshot};
use crate::store::{CompanionConfig, Store};

/// Poll cadence while ANY lock is armed (process snapshots are taken in
/// this mode: armed-phase enforcement, red-team #25).
const ENFORCE_TICK_MS: u64 = 3_000;
/// Idle cadence: one cheap status derivation per second, no process refresh.
const IDLE_TICK_MS: u64 = 1_000;
/// Minimum unexplained wall-clock lead over the monotonic clock before the
/// daemon treats it as a deliberate forward clock jump and shifts lock
/// deadlines to preserve the remaining lock duration.
const CLOCK_JUMP_TOLERANCE_MS: i64 = 60_000;

/// Max concurrent IPC connections (red-team #20): beyond this a fresh
/// connection is refused + logged. One per browser port plus the odd UI
/// probe is the honest workload; the bound stops fd/thread exhaustion.
const MAX_CONNS: usize = 64;
/// Per-connection OUTBOUND queue depth in frames (red-team #20). Broadcasts
/// only ever `try_send` under the registry lock (never write to a socket
/// there), so a peer that never reads can stall neither the broadcast nor
/// the accept loop; a full queue evicts the connection (with a log line).
const OUTBOUND_QUEUE_CAP: usize = 32;
/// Unauthenticated connections that send nothing for this long are reaped
/// (red-team #20): defense against anonymous-connection squatting. Paired
/// (authenticated) connections are exempt — they own a heartbeat cadence
/// already. A quiet local UI keeps its connection with the companion-internal
/// `ping` frame.
const UNAUTH_IDLE_REAP_MS: u64 = 60_000;
/// Receive tick for connection reader threads: timeouts wake the loop once
/// per second so idle-reap + eviction checks always make progress.
const CONN_RECV_TICK_MS: u64 = 1_000;
/// Send timeout on a connection's writer half: an unreachable/deaf peer
/// fails the write instead of wedging the writer thread mid-frame.
const CONN_SEND_TIMEOUT_MS: u64 = 5_000;

pub trait Notifier: Send + 'static {
    fn notify(&self, title: &str, body: &str);
}

/// Default notifier: stderr + `events.log` in the data dir. Desktop toasts
/// arrive with the Tauri shell (M7).
pub struct LogNotifier;

impl Notifier for LogNotifier {
    fn notify(&self, title: &str, body: &str) {
        eprintln!("[notify] {title}: {body}");
    }
}

pub struct DaemonOptions {
    pub socket_name: String,
    pub store: Store,
    /// Extra incompatible-browser stems merged over config.json (e2e hook).
    pub extra_incompatible: Vec<String>,
    pub notifier: Box<dyn Notifier>,
    /// Suppress kill actions, only log them — e2e uses this to assert the
    /// watchdog verdict without shooting the test's own browser.
    pub dry_run_kills: bool,
}

struct ConnEntry {
    /// Bounded per-connection outbound queue (frames pre-encoded once per
    /// redaction class). The reader thread's writer half drains it; when it
    /// fills (slow/deaf consumer) the connection is evicted + logged.
    outbound: SyncSender<Arc<Vec<u8>>>,
    /// Set when the queue overflows; the reader thread closes the connection
    /// down on its next receive tick.
    evict: Arc<AtomicBool>,
    /// Browser kind — set ONLY on an authenticated hello, so a forged
    /// connection's heartbeats can never pacify the watchdog.
    browser: Option<CompanionBrowser>,
    /// Extension version from the authenticated hello (status snapshot).
    ext_version: Option<String>,
    /// Presented a pairing token the daemon recognizes. Unauthenticated
    /// connections (the Tauri UI writes lock extensions this way, and any
    /// other local process can connect) get a redacted status, their
    /// password fields stripped on merge, and no browser registration.
    authed: bool,
    last_seen_mono_ms: u64,
}

/// One serialized frame in both redaction classes: (full, redacted).
type EncodedPair = (Arc<Vec<u8>>, Arc<Vec<u8>>);

struct Shared {
    store: Store,
    lock_state: Mutex<LockState>,
    conns: Mutex<HashMap<u64, Arc<ConnEntry>>>,
    started: Instant,
    /// Wall clock at daemon start (status snapshot `startedAtMs`).
    started_wall_ms: i64,
    version: &'static str,
    extra_incompatible: Vec<String>,
    dry_run_kills: bool,
}

impl Shared {
    fn mono_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn wall_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn status(&self) -> CompanionStatus {
        let config = self.store.load_config();
        CompanionStatus {
            companion_version: self.version.to_string(),
            pro: crate::license::is_pro(&config),
            enforcement: CompanionEnforcement {
                app_blocking: true,
                watchdog: true,
                // Requires a store-hosted update_url (Phase 3) AND a managed
                // device — see policy notes in the roadmap.
                policy_protected: config.policy_enforce && config.extension_update_url.is_some(),
            },
            lock_state: self.lock_state.lock().unwrap().clone(),
        }
    }

    /// Strip password information out of a daemon->client frame. The client
    /// copy the Tauri UI / extension UIs display needs timer/frozen/schedule
    /// detail; the password hash and its tombstone stamp stay daemon-side.
    /// `password_ts: 0` keeps the redacted state MERGE-SAFE: an
    /// unauthenticated reader that reflects it back presents "no opinion" on
    /// the password, so it can neither reveal nor impersonate an arm/unlock
    /// tombstone.
    fn redact_message(msg: &CompanionMessage) -> CompanionMessage {
        let mut msg = msg.clone();
        match &mut msg {
            CompanionMessage::LockStateSync { lock_state, .. } => {
                lock_state.password_hash = None;
                lock_state.password_ts = 0;
            }
            CompanionMessage::CompanionStatus { status, .. } => {
                status.lock_state.password_hash = None;
                status.lock_state.password_ts = 0;
            }
            _ => {}
        }
        msg
    }

    /// Authenticate a connection from its `hello.pairing` token. A presented
    /// known token auths; an UNKNOWN token is adopted (TOFU) only while
    /// unlocked — while locked, the pairing set is frozen like every other
    /// setting, so a mid-lock attacker can't self-pair. Multiple browser
    /// profiles each hold their own token; the set is bounded.
    fn authenticate(&self, pairing: Option<&str>) -> bool {
        let mut config = self.store.load_config();
        if let Some(token) = pairing {
            if config.pairing_tokens.iter().any(|t| t == token) {
                return true;
            }
        }
        let locked =
            derive_lock_status(&self.lock_state.lock().unwrap(), self.wall_ms()).settings_locked;
        if locked {
            return false;
        }
        if let Some(token) = pairing {
            config.pairing_tokens.push(token.to_string());
            while config.pairing_tokens.len() > crate::store::MAX_PAIRING_TOKENS {
                config.pairing_tokens.remove(0);
            }
            if let Err(e) = self.store.save_config(&config) {
                eprintln!("[daemon] failed to persist pairing token: {e}");
            } else {
                self.log_event("pair", "adopted a new browser pairing token");
            }
            return true;
        }
        false
    }

    /// Merge a peer's lock state in; persist + broadcast only on change
    /// (the loop-prevention guard — both sides converge and go quiet).
    /// `authed` = the sender presented a valid pairing token: ordering
    /// metadata and its ordered fields are honored only from authenticated
    /// peers. An anonymous local process may still EXTEND timer/frozen locks
    /// (strictening-only, honest clients like the Tauri UI need that) but can
    /// never arm/change/clear password, schedule, break, delay or random-text
    /// operations.
    fn merge_in(&self, remote: &LockState, from_conn: u64, authed: bool) {
        self.merge_from(remote, Some(from_conn), authed);
    }

    /// Daemon-originated lock write (the focus-session commit): the same
    /// sanitize + merge + persist + broadcast path a peer's `lockStateSync`
    /// takes, with no sender to skip/reply to. Treated as UNAUTHENTICATED,
    /// so it can only extend timer/frozen — every ordered operation is pinned
    /// to ours. Broadcasts to every connection only if the merge changed state
    /// (the loop-free rule).
    fn merge_local(&self, state: &LockState) {
        self.merge_from(state, None, false);
    }

    fn merge_from(&self, remote: &LockState, from_conn: Option<u64>, authed: bool) {
        let mut sanitized = sanitize_lock_state(
            &serde_json::to_value(remote).unwrap_or(Value::Null),
            self.wall_ms(),
            MAX_LOCK_MS,
        );
        let merged = {
            let mut current = self.lock_state.lock().unwrap();
            if !authed {
                sanitized.password_hash = current.password_hash.clone();
                sanitized.password_ts = current.password_ts;
                // Every ordered operation has a forgeable stamp — the same
                // class of write as the password. Pinning these fields to the
                // daemon's own makes anonymous operation arm/change/release
                // attempts collapse to the current state before the merge.
                sanitized.break_started_at = current.break_started_at;
                sanitized.break_not_before = current.break_not_before;
                sanitized.break_ends_at = current.break_ends_at;
                sanitized.break_updated_at = current.break_updated_at;
                sanitized.delay_until = current.delay_until;
                sanitized.delay_duration_ms = current.delay_duration_ms;
                sanitized.delay_updated_at = current.delay_updated_at;
                sanitized.random_text_len = current.random_text_len;
                sanitized.random_text_updated_at = current.random_text_updated_at;
                sanitized.schedules = current.schedules.clone();
                sanitized.schedules_updated_at = current.schedules_updated_at;
            }
            let merged = merge_lock_states(&current, &sanitized, self.wall_ms());
            if merged == *current {
                // No change for us — but if the peer's state is WEAKER than
                // ours (`sanitized != current`), its storage.local was wiped
                // (DevTools) or rolled back. Push our (stronger) state back
                // directly so the browser re-locks immediately. A peer simply
                // echoing our state triggers no reply, so there's no loop.
                if let (Some(from_conn), true) = (from_conn, sanitized != *current) {
                    self.reply_to(
                        from_conn,
                        &CompanionMessage::LockStateSync {
                            v: PROTOCOL_VERSION,
                            lock_state: merged,
                        },
                    );
                }
                return;
            }
            *current = merged.clone();
            merged
        };
        if let Err(e) = self.store.save_lock_state(&merged) {
            eprintln!("[daemon] failed to persist lock state: {e}");
        }
        self.broadcast(
            &CompanionMessage::LockStateSync {
                v: PROTOCOL_VERSION,
                lock_state: merged,
            },
            from_conn,
        );
    }

    /// Serialize a message once per redaction class (full for paired
    /// connections, redacted otherwise). Protocol frames live far below the
    /// 1MB cap; an encode error loses the broadcast, never crashes the loop.
    fn encode_message(msg: &CompanionMessage) -> Option<EncodedPair> {
        let encode = |m: &CompanionMessage| {
            serde_json::to_value(m)
                .ok()
                .and_then(|v| encode_frame(&v).ok())
                .map(Arc::new)
        };
        Some((encode(msg)?, encode(&Self::redact_message(msg))?))
    }

    /// Queue one frame for every connected peer except `skip`. NEVER writes
    /// to a socket while holding the registry lock (red-team #20): a
    /// `try_send` on a bounded channel is the whole write path, so a peer
    /// that never reads stalls nothing. A connection whose queue is full is
    /// marked for eviction and dropped from the registry, with an event log
    /// line per eviction.
    fn broadcast(&self, msg: &CompanionMessage, skip: Option<u64>) {
        let Some((full, redacted)) = Self::encode_message(msg) else {
            return;
        };
        let mut evicted: Vec<u64> = Vec::new();
        {
            let mut conns = self.conns.lock().unwrap();
            for (id, entry) in conns.iter() {
                if Some(*id) == skip {
                    continue;
                }
                let bytes = if entry.authed {
                    Arc::clone(&full)
                } else {
                    Arc::clone(&redacted)
                };
                // Full queue = slow consumer. The entry is removed from the
                // registry here; its reader thread does the socket teardown.
                if entry.outbound.try_send(bytes).is_err() {
                    entry.evict.store(true, Ordering::SeqCst);
                    evicted.push(*id);
                }
            }
            for id in &evicted {
                conns.remove(id);
            }
        }
        for id in evicted {
            self.log_event(
                "conn-evicted",
                &format!("conn {id}: outbound queue full (slow consumer)"),
            );
        }
    }

    /// Queue one frame for a single connection (greeting pushes, reverse-sync
    /// replies, pong answers). The password fields are redacted when the
    /// connection isn't authenticated; the same slow-consumer eviction as
    /// `broadcast` applies.
    fn reply_to(&self, conn_id: u64, msg: &CompanionMessage) {
        let Some((full, redacted)) = Self::encode_message(msg) else {
            return;
        };
        let mut evict = false;
        {
            let conns = self.conns.lock().unwrap();
            if let Some(entry) = conns.get(&conn_id) {
                let bytes = if entry.authed { full } else { redacted };
                if entry.outbound.try_send(bytes).is_err() {
                    entry.evict.store(true, Ordering::SeqCst);
                    evict = true;
                }
            }
        }
        if evict {
            self.conns.lock().unwrap().remove(&conn_id);
            self.log_event(
                "conn-evicted",
                &format!("conn {conn_id}: outbound queue full (slow consumer)"),
            );
        }
    }

    fn log_event(&self, kind: &str, detail: &str) {
        let line = format!("{} {kind} {detail}\n", self.wall_ms());
        let path = self.store.dir().join(crate::activity::EVENTS_FILE);
        let _ = std::fs::create_dir_all(self.store.dir());
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| io::Write::write_all(&mut f, line.as_bytes()));
    }
}

/// Commit a pending focus session whose undo window has closed (see
/// `focus_session`): claim it atomically, merge `frozen_until` through the
/// lockStateSync path (persist + broadcast-on-change), THEN drop the claim —
/// a crash in between re-commits idempotently next tick. Returns whether a
/// session was committed.
fn commit_due_focus_session(shared: &Shared, now_wall_ms: i64) -> bool {
    let Some(session) = focus_session::claim_due_session(&shared.store, now_wall_ms) else {
        return false;
    };
    // An end already in the past (daemon was down through the whole
    // session) has nothing left to lock.
    if session.until_ms > now_wall_ms {
        shared.merge_local(&LockState {
            frozen_until: Some(session.until_ms),
            ..LockState::default()
        });
    }
    focus_session::finish_claim(&shared.store);
    shared.log_event(
        "focus-session-start",
        &format!("until {}", session.until_ms),
    );
    true
}

/// The status snapshot from the live connection registry: only browsers
/// registered by an AUTHENTICATED hello (`browser` is set only there).
fn build_snapshot(shared: &Shared, now_wall_ms: i64) -> StatusSnapshot {
    let now_mono = shared.mono_ms();
    let browsers = {
        let conns = shared.conns.lock().unwrap();
        conns
            .values()
            .filter(|e| e.authed)
            .filter_map(|e| {
                e.browser.map(|kind| BrowserInfo {
                    kind,
                    ext_version: e.ext_version.clone().unwrap_or_default(),
                    last_seen_ms: now_wall_ms - now_mono.saturating_sub(e.last_seen_mono_ms) as i64,
                })
            })
            .collect()
    };
    StatusSnapshot {
        pid: std::process::id(),
        started_at_ms: shared.started_wall_ms,
        written_at_ms: now_wall_ms,
        browsers: snapshot::dedupe_browsers(browsers),
    }
}

fn write_status_snapshot(shared: &Shared, now_wall_ms: i64) {
    if let Err(e) = snapshot::write_snapshot(&shared.store, &build_snapshot(shared, now_wall_ms)) {
        eprintln!("[daemon] failed to write status snapshot: {e}");
    }
}

/// Persisted cumulative-drift anchor (red-team #10). Per-node diagnostic —
/// NOT part of the merged lock state (peers must never merge each other's
/// clocks) — persisted as `clock-anchor.json` beside `lock-state.json` so a
/// daemon RESTART does not forgive a slow ratchet. Exists strictly while a
/// lock is active: created on the first locked tick, re-based after every
/// compensation, deleted the moment nothing is locked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClockAnchor {
    /// Wall clock (epoch ms) at (re-)base time.
    wall0: i64,
    /// Monotonic elapsed ms at (re-)base time. Relative to the daemon's own
    /// start — a daemon restart moves mono BACKWARDS against the anchor,
    /// which is exactly the re-anchor signature `clock_anchor_step` checks.
    mono0: i64,
}

const CLOCK_ANCHOR_FILE: &str = "clock-anchor.json";

fn anchor_path(store: &Store) -> PathBuf {
    store.dir().join(CLOCK_ANCHOR_FILE)
}

fn load_clock_anchor(store: &Store) -> Option<ClockAnchor> {
    std::fs::read(anchor_path(store))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Atomic temp-file + rename (same pattern as store.rs), best-effort: losing
/// the file on a crash re-anchors silently next tick, never a false shift.
fn save_clock_anchor(store: &Store, anchor: &ClockAnchor) {
    let write = || -> io::Result<()> {
        std::fs::create_dir_all(store.dir())?;
        let mut tmp = tempfile::NamedTempFile::new_in(store.dir())?;
        serde_json::to_writer(&mut tmp, anchor)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        io::Write::write_all(&mut tmp, b"\n")?;
        io::Write::flush(&mut tmp)?;
        tmp.persist(anchor_path(store)).map_err(|e| e.error)?;
        Ok(())
    };
    if let Err(e) = write() {
        eprintln!("[daemon] failed to persist clock anchor: {e}");
    }
}

fn clear_clock_anchor(store: &Store) {
    match std::fs::remove_file(anchor_path(store)) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("[daemon] failed to clear clock anchor: {e}"),
    }
}

/// The action the cumulative-drift guard takes on a locked tick. Pure —
/// unit-tested directly; the enforcement loop turns it into persistence and
/// deadline shifting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClockAnchorStep {
    /// No anchor yet (lock just started): base one at this instant.
    Create,
    /// Mono moved backwards vs the anchor — the daemon restarted (its
    /// monotonic uptime zeroed). Drift accumulated while the daemon was
    /// dead is unattributable (deadlines are wall-based, so a lock whose
    /// time ran out while unwatched stays expired); the only safe move is
    /// a silent re-anchor.
    Reanchor,
    /// Cumulative unexplained forward drift exceeded the tolerance: shift
    /// active deadlines by the FULL amount (ms), then re-base the anchor so
    /// the guard doesn't double-fire on the next tick.
    Compensate(i64),
    /// Within tolerance — sub-threshold drift simply keeps accumulating.
    Quiet,
}

fn clock_anchor_step(
    anchor: Option<&ClockAnchor>,
    now_wall_ms: i64,
    now_mono_ms: i64,
) -> ClockAnchorStep {
    match anchor {
        None => ClockAnchorStep::Create,
        Some(a) if now_mono_ms < a.mono0 => ClockAnchorStep::Reanchor,
        Some(a) => {
            let unexplained = (now_wall_ms - a.wall0) - (now_mono_ms - a.mono0);
            if unexplained > CLOCK_JUMP_TOLERANCE_MS {
                ClockAnchorStep::Compensate(unexplained)
            } else {
                ClockAnchorStep::Quiet
            }
        }
    }
}

/// Shift every still-active duration-lock deadline forward by `shift_ms`
/// (fail-safe direction; only deadlines unexpired AT `reference_wall_ms`
/// move — long-expired ones stay put, shifting could resurrect them), then
/// persist, broadcast, and log. Schedules are NOT shifted: they are
/// wall-clock windows by definition (each pinned to its own tz offset).
fn apply_clock_compensation(
    shared: &Shared,
    reference_wall_ms: i64,
    shift_ms: i64,
    kind: &str,
    detail: &str,
) {
    let shifted = {
        let mut current = shared.lock_state.lock().unwrap();
        let mut next = current.clone();
        for slot in [&mut next.timer_until, &mut next.frozen_until] {
            if matches!(*slot, Some(t) if t > reference_wall_ms) {
                *slot = slot.map(|t| t + shift_ms);
            }
        }
        *current = next.clone();
        next
    };
    if let Err(e) = shared.store.save_lock_state(&shifted) {
        eprintln!("[daemon] failed to persist clock-compensated lock state: {e}");
    }
    shared.broadcast(
        &CompanionMessage::LockStateSync {
            v: PROTOCOL_VERSION,
            lock_state: shifted,
        },
        None,
    );
    shared.log_event(kind, detail);
}

/// Detector 1 — the loud PER-TICK jump guard (pre-#10 behavior, kept).
/// Called each locked tick against the previous tick's (wall, mono). When
/// the wall clock races ahead of the monotonic clock by more than a minute
/// in one step, someone jumped the system clock forward to run the lock out
/// — every ACTIVE lock deadline shifts forward by the same skew, preserving
/// the real remaining duration. Returns the compensated skew (the loop
/// re-bases the cumulative anchor by it), or None when within tolerance.
fn compensate_clock_tamper(
    shared: &Shared,
    prev_wall_ms: i64,
    prev_mono_ms: u64,
    now_wall_ms: i64,
    now_mono_ms: u64,
) -> Option<i64> {
    let wall_delta = now_wall_ms - prev_wall_ms;
    let mono_delta = now_mono_ms.saturating_sub(prev_mono_ms) as i64;
    if wall_delta <= mono_delta + CLOCK_JUMP_TOLERANCE_MS {
        return None;
    }
    let skew = wall_delta - mono_delta;
    apply_clock_compensation(
        shared,
        // "Active" = not yet expired at the previous (pre-jump) check.
        prev_wall_ms,
        skew,
        "clock-tamper-compensated",
        &format!("wall clock jumped {skew}ms ahead of monotonic; lock deadlines shifted"),
    );
    Some(skew)
}

/// Mid-lock `config.json` self-healing. While locked, the data dir is the
/// user's last tamper surface: if the blocklist on disk lost any entry the
/// daemon saw when the lock began, put it back and persist. New entries the
/// user ADDS are learned (locks are strictening-only). Returns the config
/// the tick should use.
fn heal_config(shared: &Shared, locked_apps: &mut Vec<String>) -> CompanionConfig {
    let mut config = shared.store.load_config();
    let mut restored: Vec<String> = Vec::new();
    for entry in locked_apps.iter() {
        if !config
            .app_blocklist
            .iter()
            .any(|e| e.eq_ignore_ascii_case(entry))
        {
            config.app_blocklist.push(entry.clone());
            restored.push(entry.clone());
        }
    }
    if !restored.is_empty() {
        if let Err(e) = shared.store.save_config(&config) {
            eprintln!("[daemon] failed to restore tampered config: {e}");
        }
        shared.log_event("config-tamper-restored", &restored.join(", "));
    }
    for entry in &config.app_blocklist {
        if !locked_apps.iter().any(|e| e.eq_ignore_ascii_case(entry)) {
            locked_apps.push(entry.clone());
        }
    }
    config
}

/// Mid-lock `config.json` self-healing for the license key (red-team #24):
/// `is_pro` fails CLOSED on a missing key, so an un-pinned key means one
/// config.json edit disarms Pro mid-lock. The key is PINNED at lock start
/// (outer None = not pinned yet, inner None = no key was configured) and a
/// mid-lock edit that drops or swaps it is restored with the same
/// `config-tamper-restored` event as the blocklist heal. A key first
/// observed mid-lock when none was pinned is LEARNED (mirrors blocklist
/// additions — installing a license is strictening); swapping an already
/// pinned key waits for unlock, like every other settings change.
fn heal_license_key(
    shared: &Shared,
    license_pin: &mut Option<Option<String>>,
    config: &mut CompanionConfig,
) {
    match license_pin.clone() {
        None => *license_pin = Some(config.license_key.clone()),
        Some(None) => {
            if config.license_key.is_some() {
                *license_pin = Some(config.license_key.clone());
            }
        }
        Some(Some(pinned)) => {
            if config.license_key.as_deref() != Some(pinned.as_str()) {
                config.license_key = Some(pinned);
                if let Err(e) = shared.store.save_config(config) {
                    eprintln!("[daemon] failed to restore tampered config: {e}");
                }
                shared.log_event("config-tamper-restored", "licenseKey");
            }
        }
    }
}

/// Mid-lock `lock-state.json` self-healing: if the copy on disk is weaker
/// than the daemon's in-memory state, re-persist the stronger one.
fn heal_lock_file(shared: &Shared, lock: &LockState, now_wall_ms: i64) {
    let disk = shared.store.load_lock_state();
    if merge_lock_states(&disk, lock, now_wall_ms) != disk {
        if let Err(e) = shared.store.save_lock_state(lock) {
            eprintln!("[daemon] failed to restore tampered lock-state.json: {e}");
        }
        shared.log_event(
            "lock-file-restored",
            "disk copy was weaker than the daemon's in-memory state",
        );
    }
}

/// Runs forever (accept loop on the calling thread). Returns only on a bind
/// error — `AddrInUse` means another daemon instance is already running.
pub fn run_daemon(opts: DaemonOptions) -> io::Result<()> {
    let listener = ipc::listen(&opts.socket_name)?;
    let initial = opts.store.load_lock_state();
    let initial_config = opts.store.load_config();
    // Best-effort managed-browser policy hardening (off until policy_enforce
    // + a real update_url are configured; no-op on non-Windows).
    let _ = crate::policy::apply_configured_policies(&initial_config);
    let shared = Arc::new(Shared {
        lock_state: Mutex::new(initial),
        store: opts.store,
        conns: Mutex::new(HashMap::new()),
        started: Instant::now(),
        started_wall_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        version: env!("CARGO_PKG_VERSION"),
        extra_incompatible: opts.extra_incompatible,
        dry_run_kills: opts.dry_run_kills,
    });
    shared.log_event("daemon-start", &format!("socket {}", opts.socket_name));

    // Enforcement loop: cheap status + license-posture derivation while
    // idle, process snapshots + enforcer ticks whenever ANY lock is armed.
    {
        let shared = Arc::clone(&shared);
        let notifier = opts.notifier;
        std::thread::spawn(move || {
            let mut source = SysinfoSource::new();
            let mut state = EnforcerState::default();
            let own_pid = std::process::id();
            // (wall, mono) of the last tick that ran LOCKED — the baseline
            // for the loud per-tick clock-jump detector. None while unlocked.
            let mut prev_tick: Option<(i64, u64)> = None;
            // Cumulative unexplained-drift anchor (red-team #10): survives a
            // daemon restart via clock-anchor.json so a slow sub-tolerance
            // ratchet (+55s every few seconds — invisible to the per-tick
            // guard) still catches up. None while unlocked.
            let mut clock_anchor: Option<ClockAnchor> = load_clock_anchor(&shared.store);
            // Blocklist entries observed while the current lock session has
            // been active; the reference for config-tamper restoration.
            let mut locked_apps: Vec<String> = Vec::new();
            // License key pinned at lock start (red-team #24): None = not
            // pinned yet, Some = the key (or no-key posture) the lock began
            // with. Restored by the heal below if edited mid-lock.
            let mut license_pin: Option<Option<String>> = None;
            // Last logged license posture; the fail-closed gate's transitions
            // (dev-open/pro/grace/expired…) go to events.log as they happen.
            let mut last_posture: Option<&'static str> = None;
            loop {
                let now_wall = shared.wall_ms();
                let now_mono = shared.mono_ms();
                // Desktop-UI plumbing, every tick (idle or locked): commit a
                // focus session whose undo window closed (BEFORE deriving the
                // status, so this very tick enforces it), then refresh the
                // status snapshot the UI polls.
                commit_due_focus_session(&shared, now_wall);
                write_status_snapshot(&shared, now_wall);
                let lock = shared.lock_state.lock().unwrap().clone();
                let status = derive_lock_status(&lock, now_wall);
                let locked = status.settings_locked || status.force_blocking;
                // License posture event (red-team #24): logged at start and
                // on every transition — expiry-grace boundaries included.
                let posture = crate::license::check(&shared.store.load_config(), now_wall).posture;
                if last_posture != Some(posture) {
                    shared.log_event("license", posture);
                    last_posture = Some(posture);
                }
                if !locked {
                    prev_tick = None;
                    if clock_anchor.is_some() {
                        clock_anchor = None;
                        clear_clock_anchor(&shared.store);
                    }
                    locked_apps.clear();
                    license_pin = None;
                    state = EnforcerState::default();
                    std::thread::sleep(Duration::from_millis(IDLE_TICK_MS));
                    continue;
                }
                if let Some((prev_wall, prev_mono)) = prev_tick {
                    // Detector 1: loud per-tick forward jump.
                    if let Some(skew) =
                        compensate_clock_tamper(&shared, prev_wall, prev_mono, now_wall, now_mono)
                    {
                        // Re-base the cumulative anchor by the same skew so
                        // detector 2 doesn't count this jump a second time.
                        if let Some(a) = &mut clock_anchor {
                            a.wall0 += skew;
                            save_clock_anchor(&shared.store, a);
                        }
                    }
                }
                prev_tick = Some((now_wall, now_mono));
                // Detector 2: cumulative unexplained drift since lock start.
                // Sub-tolerance nudges accumulate until they cross the same
                // 60s tolerance, then ALL active deadlines shift by the full
                // amount and the anchor re-bases.
                match clock_anchor_step(clock_anchor.as_ref(), now_wall, now_mono as i64) {
                    ClockAnchorStep::Create | ClockAnchorStep::Reanchor => {
                        let fresh = ClockAnchor {
                            wall0: now_wall,
                            mono0: now_mono as i64,
                        };
                        clock_anchor = Some(fresh);
                        save_clock_anchor(&shared.store, &fresh);
                    }
                    ClockAnchorStep::Compensate(unexplained) => {
                        apply_clock_compensation(
                            &shared,
                            now_wall,
                            unexplained,
                            "clock-drift-compensated",
                            &format!(
                                "cumulative clock drift of {unexplained}ms since lock start; lock deadlines shifted"
                            ),
                        );
                        if let Some(a) = &mut clock_anchor {
                            a.wall0 += unexplained;
                            save_clock_anchor(&shared.store, a);
                        }
                    }
                    ClockAnchorStep::Quiet => {}
                }
                // Self-healing runs whenever locked (armed or enforcing):
                // the data dir must not be a mid-lock tamper surface.
                heal_lock_file(&shared, &lock, now_wall);
                let mut config = heal_config(&shared, &mut locked_apps);
                heal_license_key(&shared, &mut license_pin, &mut config);
                // Armed-phase enforcement (red-team #25): the enforcer runs
                // for EVERY armed phase (timer, password, frozen, schedule
                // window), not just force_blocking — user-approved. Phase::
                // Idle is the only phase that kills nothing.
                let processes = source.snapshot();
                let connections: Vec<ConnInfo> = {
                    let conns = shared.conns.lock().unwrap();
                    conns
                        .values()
                        .filter_map(|e| {
                            e.browser.map(|browser| ConnInfo {
                                browser,
                                last_heartbeat_mono_ms: e.last_seen_mono_ms,
                            })
                        })
                        .collect()
                };
                config
                    .extra_incompatible_browsers
                    .extend(shared.extra_incompatible.iter().cloned());
                let (next, actions) = enforcer::tick(
                    &state,
                    &TickInputs {
                        now_wall_ms: now_wall,
                        now_mono_ms: now_mono,
                        lock_status: &status,
                        processes: &processes,
                        connections: &connections,
                        config: &config,
                        own_pid,
                    },
                );
                state = next;
                for action in actions {
                    match action {
                        Action::Kill { pid, name, reason } => {
                            if shared.dry_run_kills {
                                shared.log_event(
                                    "kill-dry-run",
                                    &format!("{name} pid {pid} ({reason:?})"),
                                );
                            } else if source.kill(pid) {
                                shared.log_event("kill", &format!("{name} pid {pid} ({reason:?})"));
                            }
                        }
                        Action::Notify { title, body } => {
                            shared.log_event("notify", &body);
                            notifier.notify(&title, &body);
                        }
                        Action::LogEvent { kind, detail } => shared.log_event(kind, &detail),
                    }
                }
                std::thread::sleep(Duration::from_millis(ENFORCE_TICK_MS));
            }
        });
    }

    // Accept loop: one reader thread per nm-host relay.
    #[cfg(target_os = "linux")]
    let own_uid = ipc::own_euid();
    let mut next_id: u64 = 0;
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[daemon] accept failed: {e}");
                continue;
            }
        };
        // Same-user admission (red-team #20): the Linux abstract-namespace
        // socket has no filesystem permission layer, so the kernel peer
        // credential (SO_PEERCRED euid) must match ours — cross-user
        // connects are refused + logged before any frame is read.
        #[cfg(target_os = "linux")]
        if !ipc::same_user_peer(&stream, own_uid) {
            shared.log_event(
                "conn-rejected",
                "cross-uid peer refused by the same-user gate",
            );
            continue;
        }
        next_id += 1;
        let id = next_id;
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || serve_connection(id, stream, shared));
    }
    Ok(())
}

/// Drain one connection's bounded outbound queue to its socket. A send
/// timeout bounds any single frame write, so a deaf peer kills the writer
/// (and the queue then fills, tripping eviction) instead of wedging a
/// thread per connection.
fn writer_loop(mut send: ipc::SendHalf, rx: mpsc::Receiver<Arc<Vec<u8>>>) {
    if send
        .set_timeout(Some(Duration::from_millis(CONN_SEND_TIMEOUT_MS)))
        .is_err()
    {
        eprintln!("[daemon] failed to set send timeout");
    }
    while let Ok(frame) = rx.recv() {
        if send.write_all(&frame).and_then(|_| send.flush()).is_err() {
            break;
        }
    }
}

fn serve_connection(id: u64, stream: ipc::Stream, shared: Arc<Shared>) {
    let (mut recv, send) = stream.split();
    let (tx, rx) = mpsc::sync_channel::<Arc<Vec<u8>>>(OUTBOUND_QUEUE_CAP);
    let entry = Arc::new(ConnEntry {
        outbound: tx,
        evict: Arc::new(AtomicBool::new(false)),
        browser: None,
        ext_version: None,
        authed: false,
        last_seen_mono_ms: shared.mono_ms(),
    });
    {
        // Registry cap, checked and applied atomically (red-team #20):
        // refusing AFTER accept means the connection floods one bounded
        // thread spawn, never unbounded registry/resource growth.
        let mut conns = shared.conns.lock().unwrap();
        if conns.len() >= MAX_CONNS {
            drop(conns);
            shared.log_event(
                "conn-refused",
                &format!("conn {id}: registry cap ({MAX_CONNS}) reached"),
            );
            return; // halves + queue drop here; the peer sees a clean close
        }
        conns.insert(id, Arc::clone(&entry));
    }
    std::thread::spawn(move || writer_loop(send, rx));

    // Push status (which embeds our lock state) to every fresh connection —
    // REDACTED: the connection has not presented a pairing token yet. Hello
    // also gets a reply, but a relay RECONNECTING after a daemon restart
    // never re-hellos (the nm-host replays its cached hello frame instead) —
    // without this push, state seeded while the extension was attached would
    // sit unsynced until the next local change.
    shared.reply_to(
        id,
        &CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: shared.status(),
        },
    );

    // 1s receive tick: timeouts wake the loop for the idle-reap + eviction
    // checks below; EOF or a bad frame ends the connection (relay gone).
    if recv
        .set_timeout(Some(Duration::from_millis(CONN_RECV_TICK_MS)))
        .is_err()
    {
        eprintln!("[daemon] failed to set receive timeout");
    }
    let mut authed = false;
    // "Meaningful" = any frame that ISN'T a companion-internal ping: the
    // watchdog supervisor's liveness probes (connect → ping → pong → close,
    // every 2s) and bare connect-probes must not spam relay-disconnect lines.
    let mut meaningful = false;
    let mut last_activity = shared.mono_ms();
    loop {
        // Evicted by a broadcast (slow consumer) → already removed + logged.
        // Drop the sender so the writer thread ends too.
        {
            let conns = shared.conns.lock().unwrap();
            match conns.get(&id) {
                None => return,
                Some(e) if e.evict.load(Ordering::SeqCst) => return,
                _ => {}
            }
        }
        // Idle-reap: an unauthenticated connection that never says anything
        // (squatter) is closed after the timeout. Authenticated connections
        // are exempt; a quiet local UI stays alive by pinging.
        if !authed && shared.mono_ms().saturating_sub(last_activity) > UNAUTH_IDLE_REAP_MS {
            shared.conns.lock().unwrap().remove(&id);
            shared.log_event(
                "conn-idle-reaped",
                &format!("conn {id}: unauthenticated + idle > {UNAUTH_IDLE_REAP_MS}ms"),
            );
            return;
        }
        let frame = match read_frame(&mut recv) {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // clean EOF
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue; // receive tick — reap/evict checks next iteration
            }
            Err(_) => break, // truncated/malformed frame: peer is gone/broken
        };
        last_activity = shared.mono_ms();
        // Any well-formed frame counts as liveness for the watchdog — but
        // only an AUTHENTICATED connection's browser registration feeds the
        // health check, so a forged hello can't pacify it.
        touch(&shared, id);
        match parse_message(&frame) {
            Some(CompanionMessage::Hello {
                browser,
                ext_version,
                extension_id,
                pairing,
                ..
            }) => {
                meaningful = true;
                if shared.authenticate(pairing.as_deref()) {
                    authed = true;
                    mark_authed(&shared, id, browser, &ext_version);
                    shared.log_event(
                        "hello",
                        &format!("{browser:?} ext {ext_version} id {extension_id}"),
                    );
                    // Full (unredacted) status: the paired extension merges
                    // it, including password arm/unlock tombstones.
                    shared.reply_to(
                        id,
                        &CompanionMessage::CompanionStatus {
                            v: PROTOCOL_VERSION,
                            running: Some(true),
                            status: shared.status(),
                        },
                    );
                } else {
                    // No browser registration, no lock disclosure. The hello
                    // is still logged — a rejected pairing while locked is
                    // exactly the signal a tamper investigation wants.
                    shared.log_event(
                        "hello-rejected",
                        &format!("{browser:?} ext {ext_version} id {extension_id}"),
                    );
                    shared.reply_to(
                        id,
                        &CompanionMessage::Error {
                            v: PROTOCOL_VERSION,
                            message: "pairing rejected: unknown or locked".to_string(),
                        },
                    );
                }
            }
            Some(CompanionMessage::LockStateSync { lock_state, .. }) => {
                meaningful = true;
                let authed = shared
                    .conns
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|e| e.authed);
                shared.merge_in(&lock_state, id, authed);
            }
            Some(CompanionMessage::Heartbeat { .. }) => meaningful = true,
            Some(CompanionMessage::Ping { .. }) => {
                // Companion-internal liveness probe (watchdog supervisor,
                // keepalive UIs): answer with identity-of-instance so a
                // socket squatter accepting connects can't fake a daemon.
                shared.reply_to(
                    id,
                    &CompanionMessage::Pong {
                        v: PROTOCOL_VERSION,
                        pid: std::process::id(),
                        mono_ms: shared.mono_ms(),
                    },
                );
            }
            // companionStatus/error/pong are daemon->extension; unknown types
            // are a newer peer — both ignored (forward compatibility).
            Some(_) | None => {}
        }
    }

    // The disconnect line is only for connections that carried real traffic;
    // probe-only and idle-reaped connections log their own kinds (or stay
    // silent) above.
    if shared.conns.lock().unwrap().remove(&id).is_some() && meaningful {
        shared.log_event("relay-disconnect", &format!("conn {id}"));
    }
}

/// Replace a connection's registry entry (liveness, browser kind, auth).
/// Entries are replaced, not mutated: `ConnEntry` fields are read lock-free
/// by the enforcement loop via the map snapshot. The queue + eviction flag
/// carry over (they ARE the connection), identity fields advance.
fn replace_conn(
    shared: &Shared,
    id: u64,
    browser: Option<(CompanionBrowser, String)>,
    authed: Option<bool>,
) {
    let mut conns = shared.conns.lock().unwrap();
    if let Some(old) = conns.remove(&id) {
        let (browser, ext_version) = match browser {
            Some((kind, version)) => (Some(kind), Some(version)),
            None => (old.browser, old.ext_version.clone()),
        };
        let entry = Arc::new(ConnEntry {
            outbound: old.outbound.clone(),
            evict: Arc::clone(&old.evict),
            browser,
            ext_version,
            authed: authed.unwrap_or(old.authed),
            last_seen_mono_ms: shared.started.elapsed().as_millis() as u64,
        });
        conns.insert(id, entry);
    }
}

/// Update a connection's liveness only (`auth` is sticky once granted).
fn touch(shared: &Shared, id: u64) {
    replace_conn(shared, id, None, None);
}

/// Mark a connection authenticated + register its browser kind (once per
/// hello — re-hellos re-mark the same state).
fn mark_authed(shared: &Shared, id: u64, browser: CompanionBrowser, ext_version: &str) {
    replace_conn(
        shared,
        id,
        Some((browser, ext_version.to_string())),
        Some(true),
    );
}

/// The watchdog supervisor's daemon-vs-squatter liveness probe (red-team #7
/// residual): connect and PING; only a protocol PONG counts as "the daemon
/// is alive". A squatter that grabbed the socket name (accepting connects,
/// answering nothing or garbage) fails here even though a bare connect
/// succeeds — that's the case the watchdog must respawn for. Every leg is
/// timeout-bounded, so the probe can never wedge the supervisor loop.
/// Returns (pid, mono-ms-since-daemon-start) on success.
pub fn probe_ping(socket_name: &str, leg_timeout: Duration) -> Option<(u32, u64)> {
    let mut stream = ipc::connect(socket_name).ok()?;
    stream.set_recv_timeout(Some(leg_timeout)).ok()?;
    stream.set_send_timeout(Some(leg_timeout)).ok()?;
    let ping = serde_json::to_value(CompanionMessage::Ping {
        v: PROTOCOL_VERSION,
    })
    .ok()?;
    crate::framing::write_frame(&mut stream, &ping).ok()?;
    // Total budget ≈ 4 legs: the connect-greeting may lead the pong, and a
    // squatter drip-feeding garbage gets slack without ever stalling us.
    let deadline = Instant::now() + leg_timeout.saturating_mul(4);
    while Instant::now() < deadline {
        match read_frame(&mut stream) {
            Ok(Some(frame)) => {
                if let Some(CompanionMessage::Pong { pid, mono_ms, .. }) = parse_message(&frame) {
                    return Some((pid, mono_ms));
                }
                // greetings/redacted statuses etc. are skipped
            }
            _ => return None, // EOF, bad frame, or leg timeout
        }
    }
    None
}

/// Convenience used by bins: `smartblocker-daemon status`.
pub fn describe_status(store: &Store) -> String {
    let state = store.load_lock_state();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let status = derive_lock_status(&state, now);
    let boundary = next_boundary(&state, now);
    format!(
        "settingsLocked: {}\nforceBlocking: {}\nreasons: {:?}\nuntil: {:?}\nnextBoundary: {:?}\n",
        status.settings_locked, status.force_blocking, status.reasons, status.until, boundary
    )
}

static DAEMON_RUNNING: AtomicBool = AtomicBool::new(false);

/// Test/embedding helper: run the daemon on a background thread exactly once
/// per process (the Tauri shell uses this in M7).
pub fn spawn_daemon(opts: DaemonOptions) -> bool {
    if DAEMON_RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::spawn(move || {
        if let Err(e) = run_daemon(opts) {
            eprintln!("[daemon] exited: {e}");
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::traits::Listener as _;
    use crate::lock_math::ScheduleRule;
    use serde_json::json;

    /// Receiving end of a test connection's bounded outbound queue — what
    /// the writer thread would have drained to the socket.
    struct Outbox(mpsc::Receiver<Arc<Vec<u8>>>);

    fn test_shared() -> (tempfile::TempDir, Arc<Shared>) {
        let dir = tempfile::tempdir().unwrap();
        let shared = Arc::new(Shared {
            store: Store::new(dir.path()),
            lock_state: Mutex::new(LockState::default()),
            conns: Mutex::new(HashMap::new()),
            started: Instant::now(),
            started_wall_ms: 0,
            version: "test",
            extra_incompatible: vec![],
            dry_run_kills: true,
        });
        (dir, shared)
    }

    fn add_conn(shared: &Shared, id: u64, authed: bool) -> Outbox {
        let (tx, rx) = mpsc::sync_channel(OUTBOUND_QUEUE_CAP);
        shared.conns.lock().unwrap().insert(
            id,
            Arc::new(ConnEntry {
                outbound: tx,
                evict: Arc::new(AtomicBool::new(false)),
                browser: None,
                ext_version: None,
                authed,
                last_seen_mono_ms: 0,
            }),
        );
        Outbox(rx)
    }

    fn frames_in(outbox: &Outbox) -> Vec<Value> {
        let mut frames = Vec::new();
        while let Ok(bytes) = outbox.0.try_recv() {
            let mut slice = &bytes[..];
            if let Ok(Some(v)) = read_frame(&mut slice) {
                frames.push(v);
            }
        }
        frames
    }

    fn sync_msg(state: &LockState) -> CompanionMessage {
        CompanionMessage::LockStateSync {
            v: PROTOCOL_VERSION,
            lock_state: state.clone(),
        }
    }

    fn protected_operation_state(stamp: u64) -> LockState {
        let at = stamp as i64;
        LockState {
            break_started_at: Some(at),
            break_not_before: None,
            break_ends_at: Some(at + 60_000),
            break_updated_at: stamp,
            delay_until: Some(0),
            delay_duration_ms: Some(60_000),
            delay_updated_at: stamp,
            random_text_len: Some(64),
            random_text_updated_at: stamp,
            ..LockState::default()
        }
    }

    #[test]
    fn wiped_peer_state_is_relocked_via_direct_reply() {
        let (_dir, shared) = test_shared();
        let strong = LockState {
            frozen_until: Some(shared.wall_ms() + 3_600_000),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = strong.clone();
        shared.store.save_lock_state(&strong).unwrap();
        let cap = add_conn(&shared, 7, true);

        // Peer (browser) lost its storage — sends an empty state. Our merge
        // doesn't change, but the peer must be re-locked immediately.
        shared.merge_in(&LockState::default(), 7, true);

        assert_eq!(*shared.lock_state.lock().unwrap(), strong);
        let frames = frames_in(&cap);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "lockStateSync");
        assert_eq!(
            frames[0]["lockState"]["frozenUntil"],
            json!(strong.frozen_until)
        );
    }

    #[test]
    fn exact_echo_of_our_state_draws_no_reply() {
        let (_dir, shared) = test_shared();
        let strong = LockState {
            frozen_until: Some(shared.wall_ms() + 3_600_000),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = strong.clone();
        let cap = add_conn(&shared, 7, true);

        // Converged peer echoing our state: replying would ping-pong forever.
        shared.merge_in(&strong, 7, true);
        assert!(frames_in(&cap).is_empty());
    }

    #[test]
    fn stronger_peer_state_is_merged_persisted_and_broadcast() {
        let (_dir, shared) = test_shared();
        let sender = add_conn(&shared, 7, true);
        let bystander = add_conn(&shared, 8, true);
        let strong = LockState {
            timer_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };

        shared.merge_in(&strong, 7, true);

        assert_eq!(*shared.lock_state.lock().unwrap(), strong);
        assert_eq!(shared.store.load_lock_state(), strong);
        // The sender was skipped (it already knows); everyone else hears it.
        assert!(frames_in(&sender).is_empty());
        let frames = frames_in(&bystander);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "lockStateSync");
    }

    #[test]
    fn clock_jump_compensation_shifts_active_deadlines() {
        let (_dir, shared) = test_shared();
        let cap = add_conn(&shared, 9, true);
        let prev_wall = shared.wall_ms();
        let lock = LockState {
            timer_until: Some(prev_wall + 600_000),
            frozen_until: Some(prev_wall + 3_600_000),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = lock;

        // 2s of real time passes, wall clock leaps 2 hours.
        assert!(
            compensate_clock_tamper(&shared, prev_wall, 1_000, prev_wall + 7_200_000, 3_000)
                .is_some()
        );
        let skew = 7_200_000 - 2_000;
        let now = shared.lock_state.lock().unwrap().clone();
        assert_eq!(now.timer_until, Some(prev_wall + 600_000 + skew));
        assert_eq!(now.frozen_until, Some(prev_wall + 3_600_000 + skew));
        // Persisted and broadcast to every connection (no skip).
        assert_eq!(shared.store.load_lock_state(), now);
        let frames = frames_in(&cap);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["lockState"]["timerUntil"], json!(now.timer_until));
    }

    #[test]
    fn clock_jump_leaves_expired_deadlines_alone() {
        let (_dir, shared) = test_shared();
        let prev_wall = shared.wall_ms();
        *shared.lock_state.lock().unwrap() = LockState {
            timer_until: Some(prev_wall - 5_000), // already over
            frozen_until: Some(prev_wall + 600_000),
            ..LockState::default()
        };
        assert!(
            compensate_clock_tamper(&shared, prev_wall, 0, prev_wall + 3_600_000, 1_000).is_some()
        );
        let skew = 3_600_000 - 1_000;
        let now = shared.lock_state.lock().unwrap().clone();
        assert_eq!(now.timer_until, Some(prev_wall - 5_000));
        assert_eq!(now.frozen_until, Some(prev_wall + 600_000 + skew));
    }

    #[test]
    fn small_clock_drift_is_not_compensated() {
        let (_dir, shared) = test_shared();
        let cap = add_conn(&shared, 9, true);
        let prev_wall = shared.wall_ms();
        let lock = LockState {
            timer_until: Some(prev_wall + 600_000),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = lock.clone();

        // Wall runs 50s ahead of monotonic — under the 60s tolerance.
        assert!(
            compensate_clock_tamper(&shared, prev_wall, 0, prev_wall + 52_000, 2_000).is_none()
        );
        assert_eq!(*shared.lock_state.lock().unwrap(), lock);
        assert!(frames_in(&cap).is_empty());
    }

    #[test]
    fn cumulative_anchor_catches_the_sub_tolerance_ratchet() {
        // Red-team #10: +55s wall nudges against +5s monotonic ticks sit
        // under the per-tick 60s tolerance forever — but they accumulate,
        // and the anchor must fire once the CUMULATIVE unexplained drift
        // crosses the same tolerance.
        let base_wall = 1_800_000_000_000_i64;
        let anchor = ClockAnchor {
            wall0: base_wall,
            mono0: 0,
        };
        // Tick 1: 55_000 wall − 5_000 mono = 50_000 unexplained → quiet.
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 55_000, 5_000),
            ClockAnchorStep::Quiet
        );
        // Tick 2: 110_000 − 10_000 = 100_000 unexplained → full-drift shift.
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 110_000, 10_000),
            ClockAnchorStep::Compensate(100_000)
        );
    }

    #[test]
    fn cumulative_anchor_rebases_without_double_firing() {
        // The loop re-bases (wall0 += shifted) after every compensation; the
        // next ordinary tick must then read as quiet — otherwise the guard
        // shifts the same drift over and over.
        let base_wall = 1_800_000_000_000_i64;
        let mut anchor = ClockAnchor {
            wall0: base_wall,
            mono0: 0,
        };
        let step = clock_anchor_step(Some(&anchor), base_wall + 110_000, 10_000);
        let ClockAnchorStep::Compensate(unexplained) = step else {
            panic!("expected compensation, got {step:?}");
        };
        anchor.wall0 += unexplained;
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 115_000, 15_000),
            ClockAnchorStep::Quiet
        );
    }

    #[test]
    fn clock_anchor_step_boundaries() {
        let base_wall = 1_800_000_000_000_i64;
        // No anchor → create one (lock just started).
        assert_eq!(
            clock_anchor_step(None, base_wall, 5_000),
            ClockAnchorStep::Create
        );
        let anchor = ClockAnchor {
            wall0: base_wall,
            mono0: 500_000,
        };
        // Mono BACKWARDS vs the anchor = the daemon restarted (its monotonic
        // uptime zeroed) → silent re-anchor, never a false compensation.
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 9_999_000, 5_000),
            ClockAnchorStep::Reanchor
        );
        // Exactly at the tolerance is still tolerated; 1ms over is not.
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 560_000, anchor.mono0 + 500_000),
            ClockAnchorStep::Quiet
        );
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall + 560_001, anchor.mono0 + 500_000),
            ClockAnchorStep::Compensate(60_001)
        );
        // Backward drift is never compensated (fail-safe direction).
        assert_eq!(
            clock_anchor_step(Some(&anchor), base_wall - 7_200_000, anchor.mono0 + 1_000),
            ClockAnchorStep::Quiet
        );
    }

    #[test]
    fn clock_anchor_persists_across_store_reopens_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert_eq!(load_clock_anchor(&store), None);
        let anchor = ClockAnchor {
            wall0: 1_800_000_000_000,
            mono0: 42_000,
        };
        save_clock_anchor(&store, &anchor);
        // A reopened store (= daemon restart on the same data dir) sees the
        // anchor: accumulated drift survives the restart.
        let reopened = Store::new(dir.path());
        assert_eq!(load_clock_anchor(&reopened), Some(anchor));
        // Garbage on disk fails safe to "no anchor" (same policy as the
        // other stores: corrupt files load as defaults, never a crash).
        std::fs::write(dir.path().join(CLOCK_ANCHOR_FILE), b"{ nope").unwrap();
        assert_eq!(load_clock_anchor(&reopened), None);
        save_clock_anchor(&store, &anchor);
        clear_clock_anchor(&store);
        assert_eq!(load_clock_anchor(&reopened), None);
        // Clearing a missing anchor is not an error.
        clear_clock_anchor(&store);
    }

    #[test]
    fn cumulative_compensation_shifts_only_deadlines_active_at_now() {
        // Unlike the per-tick guard (activity reference = previous tick), the
        // cumulative guard measures against the current wall clock: a
        // deadline the ratchet already "expired" is gone for good; only the
        // still-live one is shifted back out of reach.
        let (_dir, shared) = test_shared();
        let cap = add_conn(&shared, 9, true);
        let now_wall = shared.wall_ms();
        *shared.lock_state.lock().unwrap() = LockState {
            timer_until: Some(now_wall - 5_000), // already over
            frozen_until: Some(now_wall + 600_000),
            ..LockState::default()
        };
        // Sanity: the persisted anchor file must not be touched by shifting —
        // it is the LOOP's job to re-base after calling this.
        apply_clock_compensation(
            &shared,
            now_wall,
            100_000,
            "clock-drift-compensated",
            "test",
        );
        let now = shared.lock_state.lock().unwrap().clone();
        assert_eq!(now.timer_until, Some(now_wall - 5_000));
        assert_eq!(now.frozen_until, Some(now_wall + 700_000));
        assert_eq!(shared.store.load_lock_state(), now);
        let frames = frames_in(&cap);
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0]["lockState"]["frozenUntil"],
            json!(now.frozen_until)
        );
    }

    #[test]
    fn unauthenticated_merge_cannot_touch_the_password() {
        let (_dir, shared) = test_shared();
        let attacker = add_conn(&shared, 7, false);

        // Anonymous writer arms a password: stripped before the merge, so
        // the daemon's password stays unset — even with a fresh tombstone
        // stamp that would win an authenticated merge.
        let arm = LockState {
            password_hash: Some("a".repeat(64)),
            password_ts: shared.wall_ms() as u64,
            ..LockState::default()
        };
        shared.merge_in(&arm, 7, false);
        assert_eq!(shared.lock_state.lock().unwrap().password_hash, None);
        assert_eq!(shared.lock_state.lock().unwrap().password_ts, 0);

        // ...and once a password IS armed, an anonymous writer can't clear
        // or replace it either (strip = substitute the daemon's own fields).
        *shared.lock_state.lock().unwrap() = LockState {
            password_hash: Some("f".repeat(64)),
            password_ts: 100,
            ..LockState::default()
        };
        shared.merge_in(
            &LockState {
                password_hash: None,
                password_ts: 9_999_999,
                ..LockState::default()
            },
            7,
            false,
        );
        assert_eq!(
            shared.lock_state.lock().unwrap().password_hash,
            Some("f".repeat(64))
        );
        assert_eq!(shared.lock_state.lock().unwrap().password_ts, 100);
        // ...and an anonymous schedule rewrite is refused the same way
        // (a forged schedulesUpdatedAt can't wipe the list mid-lock).
        // NOTE: clone first — a `..shared.lock_state.lock()...clone()` base
        // inside the assignment would re-take the mutex the LHS guard holds.
        let base = shared.lock_state.lock().unwrap().clone();
        *shared.lock_state.lock().unwrap() = LockState {
            schedules: vec![ScheduleRule {
                id: "keep".into(),
                days: vec![1, 2, 3, 4, 5],
                start_minutes: 540,
                end_minutes: 1020,
                tz_offset_minutes: None,
                tz_name: None,
            }],
            schedules_updated_at: 100,
            ..base
        };
        shared.merge_in(
            &LockState {
                schedules: vec![],
                schedules_updated_at: 9_999_999,
                ..LockState::default()
            },
            7,
            false,
        );
        assert_eq!(shared.lock_state.lock().unwrap().schedules.len(), 1);
        assert_eq!(shared.lock_state.lock().unwrap().schedules[0].id, "keep");

        // Timer/frozen still merge from anonymous writers (strictening-only).
        shared.merge_in(
            &LockState {
                frozen_until: Some(shared.wall_ms() + 60_000),
                ..LockState::default()
            },
            7,
            false,
        );
        assert!(shared.lock_state.lock().unwrap().frozen_until.is_some());
        shared.merge_in(
            &LockState {
                timer_until: Some(shared.wall_ms() + 60_000),
                ..LockState::default()
            },
            7,
            false,
        );
        assert!(shared.lock_state.lock().unwrap().timer_until.is_some());
        drop(attacker);
    }

    #[test]
    fn unauthenticated_merge_cannot_arm_break_or_explicit_release_gates() {
        let (_dir, shared) = test_shared();
        let _attacker = add_conn(&shared, 7, false);
        let forged = protected_operation_state(shared.wall_ms() as u64);

        shared.merge_in(&forged, 7, false);

        assert_eq!(*shared.lock_state.lock().unwrap(), LockState::default());
    }

    #[test]
    fn unauthenticated_merge_cannot_change_break_or_explicit_release_gates() {
        let (_dir, shared) = test_shared();
        let _attacker = add_conn(&shared, 7, false);
        let original = protected_operation_state(100);
        *shared.lock_state.lock().unwrap() = original.clone();
        let now = shared.wall_ms();
        let mut forged = protected_operation_state(now as u64);
        forged.break_not_before = Some(now + 1_000);
        forged.delay_until = Some(now + 120_000);
        forged.delay_duration_ms = Some(120_000);
        forged.random_text_len = Some(5_000);

        shared.merge_in(&forged, 7, false);

        assert_eq!(*shared.lock_state.lock().unwrap(), original);
    }

    #[test]
    fn unauthenticated_merge_cannot_clear_break_or_explicit_release_gates() {
        let (_dir, shared) = test_shared();
        let _attacker = add_conn(&shared, 7, false);
        let original = protected_operation_state(100);
        *shared.lock_state.lock().unwrap() = original.clone();
        let stamp = shared.wall_ms() as u64;
        let forged_release = LockState {
            break_updated_at: stamp,
            delay_updated_at: stamp,
            random_text_updated_at: stamp,
            ..LockState::default()
        };

        shared.merge_in(&forged_release, 7, false);

        assert_eq!(*shared.lock_state.lock().unwrap(), original);
    }

    #[test]
    fn authenticated_merge_can_release_break_and_explicit_release_gates() {
        let (_dir, shared) = test_shared();
        let _paired = add_conn(&shared, 7, true);
        *shared.lock_state.lock().unwrap() = protected_operation_state(100);
        let stamp = shared.wall_ms() as u64;
        let release = LockState {
            break_updated_at: stamp,
            delay_updated_at: stamp,
            random_text_updated_at: stamp,
            ..LockState::default()
        };

        shared.merge_in(&release, 7, true);

        assert_eq!(*shared.lock_state.lock().unwrap(), release);
    }

    #[test]
    fn unauthenticated_bystanders_receive_redacted_broadcasts() {
        let (_dir, shared) = test_shared();
        let anon = add_conn(&shared, 7, false);
        let paired = add_conn(&shared, 8, true);
        *shared.lock_state.lock().unwrap() = LockState {
            password_hash: Some("f".repeat(64)),
            password_ts: 100,
            ..LockState::default()
        };

        let stronger = LockState {
            frozen_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };
        // Merge from a THIRD (offline) peer via the authed conn's frame so
        // both bystanders get the broadcast.
        shared.merge_in(
            &LockState {
                frozen_until: stronger.frozen_until,
                password_hash: Some("f".repeat(64)),
                password_ts: 100,
                ..LockState::default()
            },
            999, // not connected: everyone hears the broadcast
            true,
        );

        let paired_frames = frames_in(&paired);
        assert_eq!(paired_frames.len(), 1);
        assert_eq!(
            paired_frames[0]["lockState"]["passwordHash"],
            json!("f".repeat(64))
        );

        let anon_frames = frames_in(&anon);
        assert_eq!(anon_frames.len(), 1);
        assert_eq!(anon_frames[0]["lockState"]["passwordHash"], json!(null));
        assert_eq!(anon_frames[0]["lockState"]["passwordTs"], json!(0));
        // Non-password fields are NOT redacted — UIs need them.
        assert_eq!(
            anon_frames[0]["lockState"]["frozenUntil"],
            json!(stronger.frozen_until)
        );
    }

    #[test]
    fn pairing_is_tofu_and_frozen_while_locked() {
        let (_dir, shared) = test_shared();
        // Unlocked: the first presented token is adopted (and persisted).
        assert!(shared.authenticate(Some("token-a")));
        assert_eq!(
            shared.store.load_config().pairing_tokens,
            vec!["token-a".to_string()]
        );
        // The same token auths again; no token does not.
        assert!(shared.authenticate(Some("token-a")));
        assert!(!shared.authenticate(None));

        // Locked: unknown tokens are refused, known ones still auth.
        *shared.lock_state.lock().unwrap() = LockState {
            frozen_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };
        assert!(!shared.authenticate(Some("token-b")));
        assert!(shared.authenticate(Some("token-a")));
        assert_eq!(
            shared.store.load_config().pairing_tokens,
            vec!["token-a".to_string()]
        );
    }

    #[test]
    fn config_heal_restores_dropped_entries_and_learns_additions() {
        let (_dir, shared) = test_shared();
        let config = CompanionConfig {
            app_blocklist: vec!["steam".into()],
            ..CompanionConfig::default()
        };
        shared.store.save_config(&config).unwrap();

        // First locked tick: nothing to restore, learning happens.
        let mut locked_apps = Vec::new();
        let healed = heal_config(&shared, &mut locked_apps);
        assert_eq!(healed.app_blocklist, vec!["steam".to_string()]);
        assert_eq!(locked_apps, vec!["steam".to_string()]);

        // User wipes the blocklist on disk mid-lock: restored immediately.
        shared
            .store
            .save_config(&CompanionConfig::default())
            .unwrap();
        let healed = heal_config(&shared, &mut locked_apps);
        assert_eq!(healed.app_blocklist, vec!["steam".to_string()]);
        assert_eq!(
            shared.store.load_config().app_blocklist,
            vec!["steam".to_string()]
        );

        // Additions are learned (locks are strictening-only)...
        let added = CompanionConfig {
            app_blocklist: vec!["steam".into(), "epicgames".into()],
            ..CompanionConfig::default()
        };
        shared.store.save_config(&added).unwrap();
        heal_config(&shared, &mut locked_apps);
        assert_eq!(
            locked_apps,
            vec!["steam".to_string(), "epicgames".to_string()]
        );

        // ...so a later swap restores the previously learned entry too.
        let swapped = CompanionConfig {
            app_blocklist: vec!["epicgames".into()],
            ..CompanionConfig::default()
        };
        shared.store.save_config(&swapped).unwrap();
        let healed = heal_config(&shared, &mut locked_apps);
        assert_eq!(
            healed.app_blocklist,
            vec!["epicgames".to_string(), "steam".to_string()]
        );
    }

    #[test]
    fn lock_file_heal_repersist_only_when_disk_is_weaker() {
        let (_dir, shared) = test_shared();
        let strong = LockState {
            frozen_until: Some(shared.wall_ms() + 3_600_000),
            ..LockState::default()
        };
        shared.store.save_lock_state(&strong).unwrap();

        // Disk weaker than memory → re-persist the stronger memory state.
        shared.store.save_lock_state(&LockState::default()).unwrap();
        heal_lock_file(&shared, &strong, shared.wall_ms());
        assert_eq!(shared.store.load_lock_state(), strong);

        // Disk stronger than memory → leave the disk copy untouched.
        let stronger = LockState {
            frozen_until: strong.frozen_until,
            timer_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };
        shared.store.save_lock_state(&stronger).unwrap();
        heal_lock_file(&shared, &strong, shared.wall_ms());
        assert_eq!(shared.store.load_lock_state(), stronger);
    }

    #[test]
    fn slow_consumer_is_evicted_and_broadcasts_never_block() {
        // Red-team #20: a connection that never drains its outbound queue
        // must not stall the broadcast (try_send is the whole write path) —
        // it is evicted at the cap, logged, and skipped from then on.
        let (dir, shared) = test_shared();
        let _slow = add_conn(&shared, 7, true); // never drained
        let healthy = add_conn(&shared, 8, true);

        // Cap + 5 broadcasts: filling a 32-deep queue five times over must
        // return immediately every time (a blocking write path would hang
        // this very test thread). The healthy conn is drained each pass —
        // exactly what its writer thread does for a live socket.
        let mut received: Vec<Value> = Vec::new();
        for i in 0..(OUTBOUND_QUEUE_CAP + 5) {
            shared.broadcast(
                &sync_msg(&LockState {
                    timer_until: Some(i as i64),
                    ..LockState::default()
                }),
                None,
            );
            received.extend(frames_in(&healthy));
        }
        let conns = shared.conns.lock().unwrap();
        assert!(conns.get(&7).is_none(), "slow consumer evicted");
        assert!(conns.get(&8).is_some(), "healthy conn unaffected");
        drop(conns);
        // The healthy conn received every one of them.
        received.extend(frames_in(&healthy));
        assert_eq!(received.len(), OUTBOUND_QUEUE_CAP + 5);
        let log = std::fs::read_to_string(dir.path().join("events.log")).unwrap();
        assert!(log.contains("conn-evicted"), "eviction logged: {log}");
    }

    #[test]
    fn reply_to_a_full_queue_also_evicts() {
        let (_dir, shared) = test_shared();
        let slow = add_conn(&shared, 7, true);
        let msg = sync_msg(&LockState::default());
        for _ in 0..OUTBOUND_QUEUE_CAP {
            shared.reply_to(7, &msg);
        }
        assert!(shared.conns.lock().unwrap().contains_key(&7));
        shared.reply_to(7, &msg); // one past the cap → evict
        assert!(!shared.conns.lock().unwrap().contains_key(&7));
        drop(slow);
    }

    #[test]
    fn ping_probe_is_answered_and_probe_disconnects_stay_silent() {
        // Red-team #7 residual: the watchdog probes via ping/pong; the probe
        // connection (greeting in, ping out, close) must not generate a
        // relay-disconnect line when it goes away.
        let (dir, shared) = test_shared();
        let name = format!("smartblocker-test-ping-{}", std::process::id());
        let listener = ipc::listen(&name).unwrap();
        let server = std::thread::spawn({
            let shared = Arc::clone(&shared);
            move || serve_connection(1, listener.accept().unwrap(), shared)
        });

        let mut client = ipc::connect(&name).unwrap();
        client
            .set_recv_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        // The connect-greeting arrives first (redacted, pre-auth).
        let greeting = read_frame(&mut client).unwrap().unwrap();
        assert_eq!(greeting["type"], "companionStatus");
        crate::framing::write_frame(&mut client, &json!({ "type": "ping", "v": 2 })).unwrap();
        let pong = read_frame(&mut client).unwrap().unwrap();
        assert_eq!(pong["type"], "pong");
        assert_eq!(pong["pid"], json!(std::process::id()));
        assert!(pong["monoMs"].is_number());
        drop(client);
        server.join().unwrap();

        // events.log is created lazily — no file at all proves silence too.
        let log = std::fs::read_to_string(dir.path().join("events.log")).unwrap_or_default();
        assert!(
            !log.contains("relay-disconnect"),
            "probe-only connection must not log a disconnect: {log}"
        );
    }

    #[test]
    fn meaningful_connections_still_log_their_disconnect() {
        let (dir, shared) = test_shared();
        let name = format!("smartblocker-test-disc-{}", std::process::id());
        let listener = ipc::listen(&name).unwrap();
        let server = std::thread::spawn({
            let shared = Arc::clone(&shared);
            move || serve_connection(2, listener.accept().unwrap(), shared)
        });
        let mut client = ipc::connect(&name).unwrap();
        client
            .set_recv_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let _greeting = read_frame(&mut client).unwrap().unwrap();
        crate::framing::write_frame(
            &mut client,
            &json!({
                "type": "hello", "v": 2, "extVersion": "0.6.0",
                "browser": "chrome", "extensionId": "x", "pairing": "tok"
            }),
        )
        .unwrap();
        let reply = read_frame(&mut client).unwrap().unwrap();
        assert_eq!(reply["type"], "companionStatus"); // TOFU adopted (unlocked)
        drop(client);
        server.join().unwrap();
        let log = std::fs::read_to_string(dir.path().join("events.log")).unwrap();
        assert!(log.contains("relay-disconnect"), "real relay logged: {log}");
    }

    #[test]
    fn connections_past_the_registry_cap_are_refused() {
        let (_dir, shared) = test_shared();
        let _keep: Vec<Outbox> = (0..MAX_CONNS)
            .map(|i| add_conn(&shared, (1000 + i) as u64, true))
            .collect();
        let name = format!("smartblocker-test-cap-{}", std::process::id());
        let listener = ipc::listen(&name).unwrap();
        let server = std::thread::spawn({
            let shared = Arc::clone(&shared);
            move || serve_connection(3, listener.accept().unwrap(), shared)
        });
        let mut client = ipc::connect(&name).unwrap();
        // Refused: registry stays at the cap, the refusal is logged, and the
        // client gets no greeting (the conn never entered the registry).
        server.join().unwrap(); // the refusal path returns without reading
        assert_eq!(shared.conns.lock().unwrap().len(), MAX_CONNS);
        client
            .set_recv_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        assert!(
            read_frame(&mut client).ok().flatten().is_none(),
            "refused conn: no greeting"
        );
        drop(client);
        let log = std::fs::read_to_string(_dir.path().join("events.log")).unwrap();
        assert!(log.contains("conn-refused"), "cap refusal logged: {log}");
    }

    #[test]
    fn license_key_is_pinned_mid_lock_and_restored_after_tamper() {
        // Red-team #24: fail-closed `is_pro` makes the key enforcement-
        // critical; the heal pins it at lock start like the blocklist.
        let (_dir, shared) = test_shared();
        let key = crate::license::generate_license_key("user@example.com");
        shared
            .store
            .save_config(&CompanionConfig {
                license_key: Some(key.clone()),
                ..CompanionConfig::default()
            })
            .unwrap();

        let mut pin = None;
        // First locked tick pins the key, nothing to restore.
        let mut config = heal_config(&shared, &mut Vec::new());
        heal_license_key(&shared, &mut pin, &mut config);
        assert_eq!(pin, Some(Some(key.clone())));

        // Mid-lock tamper (key dropped): restored + persisted + logged.
        shared
            .store
            .save_config(&CompanionConfig::default())
            .unwrap();
        let mut config = heal_config(&shared, &mut Vec::new());
        heal_license_key(&shared, &mut pin, &mut config);
        assert_eq!(config.license_key.as_deref(), Some(key.as_str()));
        assert_eq!(
            shared.store.load_config().license_key.as_deref(),
            Some(key.as_str())
        );
        let log = std::fs::read_to_string(_dir.path().join("events.log")).unwrap();
        assert!(
            log.contains("config-tamper-restored"),
            "restore logged: {log}"
        );
        assert!(log.contains("licenseKey"), "restore names the field: {log}");

        // Swapping (not just dropping) the pinned key is restored the same way.
        let other = crate::license::generate_license_key("mallory@example.com");
        shared
            .store
            .save_config(&CompanionConfig {
                license_key: Some(other),
                ..CompanionConfig::default()
            })
            .unwrap();
        let mut config = heal_config(&shared, &mut Vec::new());
        heal_license_key(&shared, &mut pin, &mut config);
        assert_eq!(config.license_key.as_deref(), Some(key.as_str()));
    }

    #[test]
    fn license_key_first_installed_mid_lock_is_learned_not_restored() {
        // No key at lock start (pinned as None): installing one mid-lock is
        // strictening and learned (mirrors blocklist additions).
        let (_dir, shared) = test_shared();
        let mut pin = None;
        let mut config = heal_config(&shared, &mut Vec::new());
        heal_license_key(&shared, &mut pin, &mut config);
        assert_eq!(pin, Some(None));

        let key = crate::license::generate_license_key("user@example.com");
        shared
            .store
            .save_config(&CompanionConfig {
                license_key: Some(key.clone()),
                ..CompanionConfig::default()
            })
            .unwrap();
        let mut config = heal_config(&shared, &mut Vec::new());
        heal_license_key(&shared, &mut pin, &mut config);
        assert_eq!(pin, Some(Some(key.clone())));
        assert_eq!(config.license_key.as_deref(), Some(key.as_str()));
        // Nothing was "restored" for the license.
        let log = std::fs::read_to_string(_dir.path().join("events.log")).unwrap_or_default();
        assert!(!log.contains("licenseKey"), "no restore event: {log}");
    }

    #[test]
    fn due_focus_session_commits_through_the_sync_path() {
        let (_dir, shared) = test_shared();
        let paired = add_conn(&shared, 1, true);
        let ui = add_conn(&shared, 2, false);
        let now = shared.wall_ms();
        let pending = focus_session::start_pending_session(&shared.store, 60, now).unwrap();

        // Inside the undo window: nothing happens.
        assert!(!commit_due_focus_session(&shared, now + 1_000));
        assert_eq!(*shared.lock_state.lock().unwrap(), LockState::default());
        assert!(frames_in(&paired).is_empty());

        // Due: merged in memory, persisted, broadcast to EVERY connection
        // (no sender to skip), redacted for the unauthenticated one.
        assert!(commit_due_focus_session(&shared, pending.commit_at_ms));
        let expected = Some(pending.until_ms);
        assert_eq!(shared.lock_state.lock().unwrap().frozen_until, expected);
        assert_eq!(shared.store.load_lock_state().frozen_until, expected);
        for outbox in [&paired, &ui] {
            let frames = frames_in(outbox);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["type"], "lockStateSync");
            assert_eq!(frames[0]["lockState"]["frozenUntil"], json!(expected));
        }
        // Claim resolved: the pending record is gone and no re-commit.
        assert!(focus_session::read_pending_session(&shared.store).is_none());
        assert!(!commit_due_focus_session(
            &shared,
            pending.commit_at_ms + 5_000
        ));
        let log = std::fs::read_to_string(_dir.path().join("events.log")).unwrap();
        assert!(log.contains("focus-session-start until"), "{log}");
    }

    #[test]
    fn focus_commit_that_changes_nothing_is_not_broadcast() {
        // Loop-free rule: an already-longer frozen lock absorbs the commit.
        let (_dir, shared) = test_shared();
        let now = shared.wall_ms();
        let longer = LockState {
            frozen_until: Some(now + 10 * 3_600_000),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = longer.clone();
        let paired = add_conn(&shared, 1, true);
        let pending = focus_session::start_pending_session(&shared.store, 60, now).unwrap();
        assert!(commit_due_focus_session(&shared, pending.commit_at_ms));
        assert_eq!(*shared.lock_state.lock().unwrap(), longer);
        assert!(frames_in(&paired).is_empty());
    }

    #[test]
    fn focus_commit_cannot_touch_password_or_schedules() {
        let (_dir, shared) = test_shared();
        let now = shared.wall_ms();
        let armed = LockState {
            password_hash: Some("ab".repeat(32)),
            password_ts: 7,
            schedules_updated_at: 3,
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = armed.clone();
        let pending = focus_session::start_pending_session(&shared.store, 30, now).unwrap();
        assert!(commit_due_focus_session(&shared, pending.commit_at_ms));
        let after = shared.lock_state.lock().unwrap().clone();
        assert_eq!(after.password_hash, armed.password_hash);
        assert_eq!(after.password_ts, 7);
        assert_eq!(after.schedules_updated_at, 3);
        assert_eq!(after.frozen_until, Some(pending.until_ms));
    }

    #[test]
    fn focus_session_ended_while_daemon_was_down_commits_nothing() {
        let (_dir, shared) = test_shared();
        let now = shared.wall_ms();
        let pending = focus_session::start_pending_session(&shared.store, 1, now).unwrap();
        // Daemon comes back after the session's end time.
        assert!(commit_due_focus_session(&shared, pending.until_ms + 1));
        assert_eq!(*shared.lock_state.lock().unwrap(), LockState::default());
        assert!(focus_session::read_pending_session(&shared.store).is_none());
    }

    #[test]
    fn snapshot_lists_only_authenticated_browsers() {
        let (_dir, shared) = test_shared();
        let _paired = add_conn(&shared, 1, true);
        let _forged = add_conn(&shared, 2, false);
        let _ui = add_conn(&shared, 3, false);
        mark_authed(&shared, 1, CompanionBrowser::Edge, "0.5.0");
        // A forged (unauthenticated) connection that somehow carries a
        // browser kind must still not appear.
        replace_conn(
            &shared,
            2,
            Some((CompanionBrowser::Chrome, "9.9.9".into())),
            Some(false),
        );
        let now = shared.wall_ms();
        write_status_snapshot(&shared, now);
        let snap = snapshot::read_live_snapshot(&shared.store, now).unwrap();
        assert_eq!(snap.pid, std::process::id());
        assert_eq!(snap.written_at_ms, now);
        assert_eq!(snap.browsers.len(), 1);
        let edge = &snap.browsers[0];
        assert_eq!(edge.kind, CompanionBrowser::Edge);
        assert_eq!(edge.ext_version, "0.5.0");
        assert!(edge.last_seen_ms <= now && now - edge.last_seen_ms < 5_000);
        // A heartbeat (touch) keeps the version; it isn't lost on replace.
        touch(&shared, 1);
        let snap = build_snapshot(&shared, now);
        assert_eq!(snap.browsers[0].ext_version, "0.5.0");
        // Disconnect → gone from the next snapshot.
        shared.conns.lock().unwrap().remove(&1);
        assert!(build_snapshot(&shared, now).browsers.is_empty());
    }
}
