//! The long-running companion service: accepts nm-host relays over local
//! IPC, keeps the connection registry the watchdog reads, merges lock state
//! with every extension, and drives the enforcement loop. Runs identically
//! under the headless `smartblocker-daemon` binary (Linux/e2e) and inside the
//! Tauri shell (Windows, M7) — only the `Notifier` differs.

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::allowance::{
    self, AllowanceAuthorityState, AllowanceCommandKind, AllowanceCommandRefusal,
};
use crate::enforcer::{self, Action, ConnInfo, EnforcerState, TickInputs};
use crate::focus_session;
use crate::framing::{encode_frame, read_frame};
use crate::ipc;
use crate::ipc::traits::{ListenerExt as _, RecvHalf as _, SendHalf as _, Stream as _};
use crate::lock_math::{
    armed_partner_generation, derive_lock_status, next_boundary, sanitize_lock_state, LockState,
    MAX_LOCK_MS,
};
use crate::merge::merge_lock_states;
use crate::partner::{self, PartnerState, PendingPartnerOperation, MAX_OPERATION_LIFETIME_MS};
use crate::procwatch::{ProcessSource, SysinfoSource};
use crate::protocol::{
    parse_message, BlockAction, BlockingState, CompanionBrowser, CompanionEnforcement,
    CompanionMessage, CompanionStatus, ExtensionLossState, ExtensionLossStatus,
    MAX_JS_SAFE_INTEGER, PROTOCOL_VERSION,
};
use crate::snapshot::{self, BrowserGraceInfo, BrowserInfo, StatusSnapshot};
use crate::store::{CompanionConfig, Store};

/// Poll cadence while ANY lock is armed (process snapshots are taken in
/// this mode: armed-phase enforcement, red-team #25).
const ENFORCE_TICK_MS: u64 = 3_000;
/// Idle cadence: one cheap status derivation per second, no process refresh.
const IDLE_TICK_MS: u64 = 1_000;
/// While grace is active, refresh its authoritative remainder at least this
/// often. The UI interpolates locally between these daemon observations.
const GRACE_STATUS_REFRESH_MS: u64 = 10_000;
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
    /// Per-recipient high-water mark for personalized observations. Carried
    /// across registry replacements so re-hello cannot rewind message order.
    last_extension_loss_sequence: Arc<AtomicU64>,
}

/// One serialized frame in both redaction classes: (full, redacted).
type EncodedPair = (Arc<Vec<u8>>, Arc<Vec<u8>>);

struct Shared {
    store: Store,
    lock_state: Mutex<LockState>,
    /// Test-only, per-instance one-shot pause before a lock-state disk save.
    /// The lock-state mutex remains held while this gate waits.
    #[cfg(test)]
    lock_state_save_gate: Mutex<Option<(SyncSender<()>, mpsc::Receiver<()>)>>,
    /// Public-only partner trust state. Command decisions acquire lock_state
    /// before this mutex so arm/current-operation checks are one atomic view.
    partner: Mutex<PartnerState>,
    /// Test-only pause after A's begin has persisted but before its status is
    /// captured, allowing B to prove exact result identity under concurrency.
    #[cfg(test)]
    partner_result_gate: Mutex<Option<(SyncSender<()>, mpsc::Receiver<()>)>>,
    /// Absence distinguishes an uninitialized daemon from an initialized rev-0
    /// ledger. Lock configuration decisions acquire lock_state first too.
    allowance: Mutex<Option<AllowanceAuthorityState>>,
    /// `None` means no browser or CLI has initialized ordinary blocking yet.
    /// Lock ordering is always lock_state -> blocking for coherent decisions.
    blocking: Mutex<Option<BlockingState>>,
    conns: Mutex<HashMap<u64, Arc<ConnEntry>>>,
    /// Written only by the enforcement loop after each tick; status replies
    /// and desktop snapshots read the same suspect tracks as close decisions.
    enforcer_state: Mutex<EnforcerState>,
    /// Advances only when grace tracks begin, clear, or restart. Captured with
    /// a personalized status and checked again at its ordered queue handoff.
    extension_loss_revision: AtomicU64,
    /// Ordered under enforcer_state with the remainder capture, so a larger
    /// sequence always represents a chronologically newer observation.
    next_extension_loss_sequence: AtomicU64,
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

    /// Persist one lock-state value while the caller holds `lock_state`.
    /// Keeping the mutation and save in that critical section prevents an
    /// older writer from landing on disk after a newer writer's acknowledgement.
    fn persist_lock_state_serialized(&self, state: &LockState) -> io::Result<()> {
        #[cfg(test)]
        {
            // Taking the entry makes this a one-shot pause for exactly one
            // test-controlled writer; later writers proceed without waiting.
            let gate = self.lock_state_save_gate.lock().unwrap().take();
            if let Some((save_started, resume)) = gate {
                let _ = save_started.send(());
                let _ = resume.recv();
            }
        }
        self.store.save_lock_state(state)
    }

    fn status(&self) -> CompanionStatus {
        let config = self.store.load_config();
        // Keep the same lock order as every lock/enable/partner mutation so a
        // command acknowledgement is one coherent view of all three slices.
        let lock = self.lock_state.lock().unwrap();
        let blocking = *self.blocking.lock().unwrap();
        let partner = self.partner.lock().unwrap().clone();
        let allowance = self.allowance.lock().unwrap().clone();
        let lock_state = lock.clone();
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
            lock_state,
            blocking,
            // Anonymous greetings and degraded relay statuses carry no
            // recipient-specific enforcement observation.
            extension_loss: None,
            partner: Some(partner),
            allowance,
        }
    }

    fn status_for_browser(&self, browser: CompanionBrowser) -> (CompanionStatus, u64, u64) {
        loop {
            // Seqlock-style capture: a grace-track writer holds enforcer_state
            // while changing both the tracks and this revision. If it won the
            // race before our lock, retry; if it wins afterward, queue handoff
            // rejects this captured revision instead of reviving stale grace.
            let before = self.extension_loss_revision.load(Ordering::SeqCst);
            let (grace_remaining_ms, sequence) = {
                let state = self.enforcer_state.lock().unwrap();
                let remaining = state.grace_remaining_ms(browser, self.mono_ms());
                // Allocation shares the capture lock: two observations cannot
                // acquire sequence and monotonic time in opposite orders.
                let sequence = self
                    .next_extension_loss_sequence
                    .fetch_add(1, Ordering::SeqCst)
                    + 1;
                (remaining, sequence)
            };
            let after = self.extension_loss_revision.load(Ordering::SeqCst);
            if before != after {
                continue;
            }
            let mut status = self.status();
            status.extension_loss = Some(ExtensionLossStatus {
                state: if grace_remaining_ms.is_some() {
                    ExtensionLossState::Grace
                } else {
                    ExtensionLossState::Connected
                },
                grace_seconds: enforcer::WATCHDOG_GRACE_MS / 1000,
                grace_remaining_ms,
            });
            return (status, after, sequence);
        }
    }

    fn set_enforcer_state(&self, next: EnforcerState) {
        let mut current = self.enforcer_state.lock().unwrap();
        let grace_tracks_changed = !current.same_grace_tracks(&next);
        *current = next;
        if grace_tracks_changed {
            self.extension_loss_revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Push each authenticated extension only its own browser's observation.
    /// Recipients are collected before sending, so registry and outbound
    /// locks never nest with enforcer-state access.
    fn broadcast_extension_loss(&self) {
        let recipients: Vec<(u64, CompanionBrowser)> = {
            let conns = self.conns.lock().unwrap();
            conns
                .iter()
                .filter_map(|(id, entry)| {
                    if entry.authed {
                        entry.browser.map(|browser| (*id, browser))
                    } else {
                        None
                    }
                })
                .collect()
        };
        for (id, browser) in recipients {
            let (status, revision, sequence) = self.status_for_browser(browser);
            self.reply_to_browser(
                id,
                browser,
                revision,
                sequence,
                &CompanionMessage::CompanionStatus {
                    v: PROTOCOL_VERSION,
                    running: Some(true),
                    status,
                },
            );
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
                lock_state.partner_arm_generation = None;
                lock_state.partner_arm_updated_at = None;
            }
            CompanionMessage::CompanionStatus { status, .. }
            | CompanionMessage::CommandResult { status, .. } => {
                status.lock_state.password_hash = None;
                status.lock_state.password_ts = 0;
                status.lock_state.partner_arm_generation = None;
                status.lock_state.partner_arm_updated_at = None;
                status.partner = None;
                // Allowance pools and pending grants are authorization details
                // reserved for paired recipients, just like partner operations.
                status.allowance = None;
                // Defense in depth: even accidental use of a personalized
                // status on an anonymous connection cannot disclose a deadline.
                status.extension_loss = None;
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
            // Partner authorization is daemon-command-only on BOTH trust
            // classes. A paired browser can relay ordinary unlock tombstones,
            // but it cannot originate a partner arm or release by lock sync.
            sanitized.partner_arm_generation = current.partner_arm_generation.clone();
            sanitized.partner_arm_updated_at = current.partner_arm_updated_at;
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
            if let Err(e) = self.persist_lock_state_serialized(&merged) {
                eprintln!("[daemon] failed to persist lock state: {e}");
            }
            merged
        };
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
        self.reply_to_inner(conn_id, msg, None);
    }

    /// Personalized observations must still match the intended authenticated
    /// browser when they enter the queue, not merely when recipients were
    /// collected. Authenticated browser identity is immutable, so this check
    /// closes the re-hello/registration race without holding a registry lock
    /// while reading enforcer state. The captured grace revision is also
    /// revalidated so an old hello cannot follow a newer recovery broadcast.
    fn reply_to_browser(
        &self,
        conn_id: u64,
        browser: CompanionBrowser,
        revision: u64,
        sequence: u64,
        msg: &CompanionMessage,
    ) {
        self.reply_to_inner(conn_id, msg, Some((browser, revision, sequence)));
    }

    fn reply_to_inner(
        &self,
        conn_id: u64,
        msg: &CompanionMessage,
        expected_observation: Option<(CompanionBrowser, u64, u64)>,
    ) {
        let Some((full, redacted)) = Self::encode_message(msg) else {
            return;
        };
        let mut evict = false;
        {
            let conns = self.conns.lock().unwrap();
            if let Some(entry) = conns.get(&conn_id) {
                let recipient_matches = match expected_observation {
                    Some((browser, revision, sequence)) => {
                        entry.authed
                            && entry.browser == Some(browser)
                            && self.extension_loss_revision.load(Ordering::SeqCst) == revision
                            && entry.last_extension_loss_sequence.load(Ordering::SeqCst) < sequence
                    }
                    None => true,
                };
                if !recipient_matches {
                    return;
                }
                let bytes = if entry.authed { full } else { redacted };
                if entry.outbound.try_send(bytes).is_err() {
                    entry.evict.store(true, Ordering::SeqCst);
                    evict = true;
                } else if let Some((_, _, sequence)) = expected_observation {
                    // The registry lock serializes queue handoff. Advancing the
                    // mark only after a successful send makes an older capture
                    // unable to rewind this recipient's observation order.
                    entry
                        .last_extension_loss_sequence
                        .store(sequence, Ordering::SeqCst);
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

    fn next_blocking(
        current: Option<BlockingState>,
        enabled: bool,
    ) -> Result<BlockingState, String> {
        let revision = current
            .map(|state| state.revision)
            .unwrap_or(0)
            .checked_add(1)
            .filter(|revision| *revision <= MAX_JS_SAFE_INTEGER)
            .ok_or_else(|| {
                "blocking revision exhausted at JavaScript's maximum safe integer".to_string()
            })?;
        Ok(BlockingState { enabled, revision })
    }

    fn blocking_sync(blocking: BlockingState) -> CompanionMessage {
        CompanionMessage::BlockingStateSync {
            v: PROTOCOL_VERSION,
            blocking,
        }
    }

    /// Apply one authenticated browser's new intent. The base revision is an
    /// optimistic-concurrency token: a browser that has not observed a newer
    /// cross-browser/CLI decision cannot overwrite it. Every path answers the
    /// sender with current authority when one exists.
    fn update_browser_blocking(
        &self,
        conn_id: u64,
        enabled: bool,
        base_revision: u64,
        authed: bool,
    ) {
        if !authed {
            self.reply_to(
                conn_id,
                &CompanionMessage::Error {
                    v: PROTOCOL_VERSION,
                    message: "blocking updates require an authenticated browser".to_string(),
                },
            );
            return;
        }

        let (current, next, changed, error) = {
            let lock = self.lock_state.lock().unwrap();
            let mut current = self.blocking.lock().unwrap();
            let existing = *current;
            let revision = existing.map(|state| state.revision).unwrap_or(0);
            if base_revision != revision {
                (existing, existing, false, None)
            } else if !enabled && derive_lock_status(&lock, self.wall_ms()).settings_locked {
                (
                    existing,
                    existing,
                    false,
                    Some("a lock is active".to_string()),
                )
            } else if existing.is_some_and(|state| state.enabled == enabled) {
                // This also terminates a daemon-originated storage echo: one
                // authoritative reply, no broadcast and no new revision.
                (existing, existing, false, None)
            } else {
                match Self::next_blocking(existing, enabled) {
                    Ok(candidate) => {
                        if let Err(e) = self.store.save_blocking_state(&candidate) {
                            (
                                existing,
                                existing,
                                false,
                                Some(format!("couldn't persist blocking state: {e}")),
                            )
                        } else {
                            *current = Some(candidate);
                            (existing, Some(candidate), true, None)
                        }
                    }
                    Err(e) => (existing, existing, false, Some(e)),
                }
            }
        };

        if changed {
            self.broadcast(&Self::blocking_sync(next.unwrap()), Some(conn_id));
            self.log_event(
                "blocking-sync",
                &format!(
                    "enabled={} revision={} (browser conn {conn_id})",
                    next.unwrap().enabled,
                    next.unwrap().revision
                ),
            );
        }
        let authority = next.or(current);
        if let Some(error) = error {
            self.reply_to(
                conn_id,
                &CompanionMessage::Error {
                    v: PROTOCOL_VERSION,
                    message: format!("blocking update refused: {error}"),
                },
            );
        }
        if let Some(state) = authority {
            self.reply_to(conn_id, &Self::blocking_sync(state));
        } else if base_revision != 0 {
            // There is no BlockingStateSync representation for uninitialized;
            // a fresh status is the truthful answer to an impossible base. A
            // registered browser must retain its own ordered grace observation.
            let browser = self
                .conns
                .lock()
                .unwrap()
                .get(&conn_id)
                .filter(|entry| entry.authed)
                .and_then(|entry| entry.browser);
            if let Some(browser) = browser {
                let (status, revision, sequence) = self.status_for_browser(browser);
                self.reply_to_browser(
                    conn_id,
                    browser,
                    revision,
                    sequence,
                    &CompanionMessage::CompanionStatus {
                        v: PROTOCOL_VERSION,
                        running: Some(true),
                        status,
                    },
                );
            } else {
                self.reply_to(
                    conn_id,
                    &CompanionMessage::CompanionStatus {
                        v: PROTOCOL_VERSION,
                        running: Some(true),
                        status: self.status(),
                    },
                );
            }
        }
    }

    fn command_result(&self, conn_id: u64, ok: bool, message: String) {
        self.reply_to(
            conn_id,
            &CompanionMessage::CommandResult {
                v: PROTOCOL_VERSION,
                ok,
                message,
                status: self.status(),
            },
        );
    }

    /// Local CLI soft-block command. The CLI is intentionally same-user but
    /// unpaired, so this path is separate from authenticated browser updates.
    fn block_command(&self, conn_id: u64, action: BlockAction) {
        let (_previous, next, changed, ok, message) = {
            let lock = self.lock_state.lock().unwrap();
            let mut current = self.blocking.lock().unwrap();
            let existing = *current;
            let enabled_now = existing.map(|state| state.enabled).unwrap_or(true);
            let requested = match action {
                BlockAction::Start => true,
                BlockAction::Stop => false,
                BlockAction::Toggle => !enabled_now,
            };
            if !requested && derive_lock_status(&lock, self.wall_ms()).settings_locked {
                (
                    existing,
                    existing,
                    false,
                    false,
                    "a lock is active; blocking cannot be disabled".to_string(),
                )
            } else if existing.is_some_and(|state| state.enabled == requested) {
                (
                    existing,
                    existing,
                    false,
                    true,
                    format!(
                        "blocking is already {}",
                        if requested { "on" } else { "off" }
                    ),
                )
            } else {
                match Self::next_blocking(existing, requested) {
                    Ok(candidate) => {
                        if let Err(e) = self.store.save_blocking_state(&candidate) {
                            (
                                existing,
                                existing,
                                false,
                                false,
                                format!("couldn't persist blocking state: {e}"),
                            )
                        } else {
                            *current = Some(candidate);
                            (
                                existing,
                                Some(candidate),
                                true,
                                true,
                                format!(
                                    "blocking is {} (revision {})",
                                    if requested { "on" } else { "off" },
                                    candidate.revision
                                ),
                            )
                        }
                    }
                    Err(e) => (existing, existing, false, false, e),
                }
            }
        };
        if changed {
            let state = next.unwrap();
            self.broadcast(&Self::blocking_sync(state), Some(conn_id));
            self.log_event(
                "block-command",
                &format!("enabled={} revision={}", state.enabled, state.revision),
            );
        } else if !ok {
            self.log_event("block-command-refused", &message);
        }
        self.command_result(conn_id, ok, message);
    }

    /// Enable ordinary blocking and start/extend a timer. Persistence succeeds
    /// before either in-memory value changes or an acknowledgement is sent. If
    /// the second file write fails, restore the first file best-effort rather
    /// than claiming an atomic transaction the two-file format cannot provide.
    fn lock_command(&self, conn_id: u64, duration_ms: u64) {
        if duration_ms == 0 || duration_ms > MAX_LOCK_MS as u64 {
            self.command_result(
                conn_id,
                false,
                format!("lock duration must be between 1 ms and {} ms", MAX_LOCK_MS),
            );
            return;
        }
        let now = self.wall_ms();
        let (next_lock, next_blocking, lock_changed, blocking_changed, error) = {
            let mut current_lock = self.lock_state.lock().unwrap();
            let mut current_blocking = self.blocking.lock().unwrap();
            let old_lock = current_lock.clone();
            let old_blocking = *current_blocking;
            let candidate_end = match now.checked_add(duration_ms as i64) {
                Some(end) => end,
                None => {
                    drop(current_blocking);
                    drop(current_lock);
                    self.command_result(conn_id, false, "lock deadline overflow".to_string());
                    return;
                }
            };
            let timer_until = old_lock.timer_until.unwrap_or(0).max(candidate_end);
            let candidate_lock = LockState {
                timer_until: Some(timer_until),
                ..old_lock.clone()
            };
            let lock_changed = candidate_lock != old_lock;
            let candidate_blocking = if old_blocking.is_some_and(|state| state.enabled) {
                Ok(old_blocking)
            } else {
                Self::next_blocking(old_blocking, true).map(Some)
            };
            let candidate_blocking = match candidate_blocking {
                Ok(state) => state,
                Err(e) => {
                    drop(current_blocking);
                    drop(current_lock);
                    self.command_result(conn_id, false, e);
                    return;
                }
            };
            let blocking_changed = candidate_blocking != old_blocking;
            let mut error = None;
            if lock_changed {
                if let Err(e) = self.persist_lock_state_serialized(&candidate_lock) {
                    error = Some(format!("couldn't persist timer lock: {e}"));
                }
            }
            if error.is_none() && blocking_changed {
                if let Err(e) = self.store.save_blocking_state(&candidate_blocking.unwrap()) {
                    error = Some(format!("couldn't persist blocking state: {e}"));
                    if lock_changed {
                        if let Err(rollback) = self.persist_lock_state_serialized(&old_lock) {
                            error = Some(format!(
                                "{}; timer-file rollback also failed: {rollback}",
                                error.unwrap()
                            ));
                        }
                    }
                }
            }
            if error.is_none() {
                *current_lock = candidate_lock.clone();
                *current_blocking = candidate_blocking;
            }
            (
                candidate_lock,
                candidate_blocking,
                lock_changed && error.is_none(),
                blocking_changed && error.is_none(),
                error,
            )
        };

        if let Some(error) = error {
            self.log_event("lock-command-failed", &error);
            self.command_result(conn_id, false, error);
            return;
        }
        if lock_changed {
            self.broadcast(
                &CompanionMessage::LockStateSync {
                    v: PROTOCOL_VERSION,
                    lock_state: next_lock.clone(),
                },
                Some(conn_id),
            );
        }
        if blocking_changed {
            self.broadcast(&Self::blocking_sync(next_blocking.unwrap()), Some(conn_id));
        }
        self.log_event(
            "lock-command",
            &format!("timerUntil={:?}", next_lock.timer_until),
        );
        self.command_result(
            conn_id,
            true,
            format!(
                "blocking is on; timer lock ends at {:?}",
                next_lock.timer_until
            ),
        );
    }

    fn authenticated_connection(&self, conn_id: u64) -> bool {
        self.conns
            .lock()
            .unwrap()
            .get(&conn_id)
            .is_some_and(|entry| entry.authed)
    }

    fn broadcast_allowance_authority(&self, state: &AllowanceAuthorityState, skip: Option<u64>) {
        let recipients = self
            .conns
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, entry)| (entry.authed && Some(*id) != skip).then_some(*id))
            .collect::<Vec<_>>();
        for id in recipients {
            self.reply_to(
                id,
                &CompanionMessage::AllowanceStateSync {
                    v: PROTOCOL_VERSION,
                    allowance: state.clone(),
                },
            );
        }
    }

    fn allowance_bootstrap(&self, conn_id: u64, raw: &Value) {
        if !self.authenticated_connection(conn_id) {
            self.reply_to(
                conn_id,
                &CompanionMessage::Error {
                    v: PROTOCOL_VERSION,
                    message: "allowance bootstrap requires an authenticated browser".into(),
                },
            );
            return;
        }
        let Some(incoming) = allowance::normalize_allowance_authority_state(raw) else {
            self.log_event("allowance-bootstrap-refused", "malformed recovery snapshot");
            return;
        };
        let mut current = self.allowance.lock().unwrap();
        if let Some(existing) = current.clone() {
            // Bootstraps never roll authority backwards. Otherwise a browser
            // may recover newer offline usage forward and then initialize it.
            if existing.revision >= incoming.revision {
                self.broadcast_allowance_authority(&existing, None);
                return;
            }
        }
        match self.store.save_allowance_state(&incoming) {
            Ok(()) => {
                *current = Some(incoming.clone());
                self.broadcast_allowance_authority(&incoming, None);
                self.log_event(
                    "allowance-bootstrap",
                    &format!(
                        "offline authority restored at revision {}",
                        incoming.revision
                    ),
                );
            }
            Err(error) => {
                self.log_event(
                    "allowance-bootstrap-refused",
                    &format!("persistence: {error}"),
                );
                self.reply_to(
                    conn_id,
                    &CompanionMessage::Error {
                        v: PROTOCOL_VERSION,
                        message: format!("couldn't persist allowance recovery: {error}"),
                    },
                );
            }
        }
    }

    fn allowance_command_intent(&self, conn_id: u64, command: &Value, base_revision: u64) {
        if !self.authenticated_connection(conn_id) {
            self.reply_to(
                conn_id,
                &CompanionMessage::Error {
                    v: PROTOCOL_VERSION,
                    message: "allowance commands require an authenticated browser".into(),
                },
            );
            return;
        }
        let operation_id = command
            .get("operationId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match serde_json::from_value::<allowance::AllowanceCommand>(command.clone()) {
            Ok(_) => {}
            Err(error) => {
                self.reply_to(
                    conn_id,
                    &CompanionMessage::AllowanceCommandResult {
                        v: PROTOCOL_VERSION,
                        ok: false,
                        operation_id,
                        allowance: self
                            .allowance
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(allowance::empty_allowance_authority_state),
                        reason: Some(AllowanceCommandRefusal::InvalidOperation),
                        duplicate: None,
                    },
                );
                self.log_event("allowance-command-refused", &error.to_string());
                return;
            }
        }
        let typed = serde_json::from_value::<allowance::AllowanceCommand>(command.clone()).unwrap();
        let locked = typed.kind() == AllowanceCommandKind::Configure
            && derive_lock_status(&self.lock_state.lock().unwrap(), self.wall_ms()).settings_locked;
        let (result_state, ok, reason, duplicate) = {
            let mut current = self.allowance.lock().unwrap();
            let existing = current
                .clone()
                .unwrap_or_else(allowance::empty_allowance_authority_state);
            let raw = serde_json::to_value(&existing).unwrap_or(Value::Null);
            let applied =
                allowance::apply_allowance_command_value(&raw, command, Some(base_revision));
            if locked {
                (existing, false, Some(AllowanceCommandRefusal::Locked), None)
            } else if !applied.ok {
                (existing, false, applied.reason, None)
            } else if applied.duplicate == Some(true) {
                (existing, true, None, Some(true))
            } else {
                let next_revision = existing.revision + 1;
                // Deserialize once more through the typed API for revision
                // commit; raw admission above already rejected unknown shapes.
                match allowance::commit_allowance_command_revision(
                    &applied.state,
                    next_revision,
                    Some(&typed),
                ) {
                    Ok(next) => match self.store.save_allowance_state(&next) {
                        Ok(()) => {
                            *current = Some(next.clone());
                            (next, true, None, None)
                        }
                        Err(error) => {
                            self.log_event(
                                "allowance-command-refused",
                                &format!("persistence: {error}"),
                            );
                            (
                                existing,
                                false,
                                Some(AllowanceCommandRefusal::Persistence),
                                None,
                            )
                        }
                    },
                    Err(_) => (
                        existing,
                        false,
                        Some(AllowanceCommandRefusal::Revision),
                        None,
                    ),
                }
            }
        };
        self.reply_to(
            conn_id,
            &CompanionMessage::AllowanceCommandResult {
                v: PROTOCOL_VERSION,
                ok,
                operation_id,
                allowance: result_state.clone(),
                reason,
                duplicate,
            },
        );
        if ok && duplicate.is_none() {
            self.broadcast_allowance_authority(&result_state, Some(conn_id));
        }
    }

    /// Select only the additive partner fields through the shared LWW merge,
    /// then restore the exact original lock. Canonicalization of unrelated
    /// legacy data can therefore never smuggle another lock edit into a
    /// partner command. This helper is never exposed to lockStateSync peers.
    fn merged_partner_lock(
        current: &LockState,
        generation: Option<String>,
        stamp: u64,
        now: i64,
    ) -> LockState {
        let candidate = LockState {
            partner_arm_generation: generation,
            partner_arm_updated_at: Some(stamp),
            ..current.clone()
        };
        let merged = merge_lock_states(current, &candidate, now);
        LockState {
            partner_arm_generation: merged.partner_arm_generation,
            partner_arm_updated_at: merged.partner_arm_updated_at,
            ..current.clone()
        }
    }

    fn broadcast_partner_status(&self) {
        self.broadcast(
            &CompanionMessage::CompanionStatus {
                v: PROTOCOL_VERSION,
                running: Some(true),
                status: self.status(),
            },
            None,
        );
    }

    /// Persist only substantive idle observations, not a highwater write every
    /// second. This is what turns a completed elapsed 24h wait into durable
    /// proof even when the user issues no command at that exact instant.
    fn observe_partner_at(&self, now: i64, now_mono: u64) {
        let changed = {
            let mut current = self.partner.lock().unwrap();
            match partner::observe_at(&current, now, now_mono) {
                Ok(next)
                    if next.public_keys != current.public_keys
                        || next.pending_operations != current.pending_operations
                        || next.spent_codes != current.spent_codes =>
                {
                    match self.store.save_partner_state(&next) {
                        Ok(()) => {
                            *current = next;
                            true
                        }
                        Err(error) => {
                            eprintln!(
                                "[daemon] failed to persist partner clock observation: {error}"
                            );
                            false
                        }
                    }
                }
                _ => false,
            }
        };
        if changed {
            self.broadcast_partner_status();
        }
    }

    #[cfg(test)]
    fn pause_partner_result_if_requested(&self) {
        let gate = self.partner_result_gate.lock().unwrap().take();
        if let Some((save_started, resume)) = gate {
            let _ = save_started.send(());
            let _ = resume.recv();
        }
    }

    fn partner_add_key(&self, conn_id: u64, public_key: &str) {
        self.partner_add_key_at(conn_id, public_key, self.wall_ms(), self.mono_ms());
    }

    fn partner_add_key_at(&self, conn_id: u64, public_key: &str, now: i64, now_mono: u64) {
        let result: Result<(bool, String), String> = {
            // Lock ordering is intentional even though adding a key is allowed
            // during any lock: it cannot race an arm/redeem decision.
            let _lock = self.lock_state.lock().unwrap();
            let mut current = self.partner.lock().unwrap();
            match partner::add_public_key_at(&current, public_key, now, now_mono) {
                Err(error) => Err(error.to_string()),
                Ok(next) => {
                    let changed = next != *current;
                    let activates_at = next
                        .public_keys
                        .iter()
                        .find(|key| key.public_key == public_key)
                        .map(|key| key.active_at_ms);
                    match self.store.save_partner_state(&next) {
                        Err(error) => Err(format!("couldn't persist partner public key: {error}")),
                        Ok(()) => {
                            *current = next;
                            Ok((
                                changed,
                                if changed {
                                    format!(
                                        "partner public key saved; active at {}",
                                        activates_at.unwrap_or(now)
                                    )
                                } else {
                                    "partner public key is already registered".to_string()
                                },
                            ))
                        }
                    }
                }
            }
        };
        match result {
            Ok((changed, message)) => {
                if changed {
                    self.broadcast_partner_status();
                    self.log_event("partner-key", "public key transition persisted");
                }
                self.command_result(conn_id, true, message);
            }
            Err(message) => {
                self.log_event("partner-key-refused", &message);
                self.command_result(conn_id, false, message);
            }
        }
    }

    fn partner_arm(&self, conn_id: u64) {
        self.partner_arm_at(conn_id, self.wall_ms(), self.mono_ms());
    }

    fn partner_arm_at(&self, conn_id: u64, now: i64, now_mono: u64) {
        let stamp = match u64::try_from(now) {
            Ok(stamp) => stamp,
            Err(_) => {
                self.command_result(conn_id, false, "invalid partner arm time".to_string());
                return;
            }
        };
        let result: Result<(LockState, String), String> = {
            let mut lock = self.lock_state.lock().unwrap();
            let mut partner_state = self.partner.lock().unwrap();
            if derive_lock_status(&lock, now).settings_locked {
                Err("another settings lock is active; partner arm refused".to_string())
            } else {
                match partner::observe_at(&partner_state, now, now_mono) {
                    Err(_) => {
                        Err("an active accountability-partner public key is required".to_string())
                    }
                    Ok(observed) if !partner::has_active_key_at(&observed, now, now_mono) => {
                        Err("an active accountability-partner public key is required".to_string())
                    }
                    Ok(observed) => {
                        // Activation is genuinely observed here, so make that
                        // proof durable before the arm can be acknowledged.
                        if let Err(error) = self.store.save_partner_state(&observed) {
                            Err(format!(
                                "couldn't persist partner activation proof: {error}"
                            ))
                        } else {
                            *partner_state = observed.clone();
                            match partner::random_id() {
                                Err(error) => Err(error.to_string()),
                                Ok(generation) => {
                                    if lock.partner_arm_generation.as_deref()
                                        == Some(generation.as_str())
                                        || observed
                                            .pending_operations
                                            .iter()
                                            .any(|operation| operation.arm_generation == generation)
                                    {
                                        Err("random partner arm generation collided; retry arm"
                                            .to_string())
                                    } else {
                                        let next = Self::merged_partner_lock(
                                            &lock,
                                            Some(generation.clone()),
                                            stamp,
                                            now,
                                        );
                                        if armed_partner_generation(&next)
                                            != Some(generation.as_str())
                                        {
                                            Err("partner arm merge did not select the new generation"
                                                .to_string())
                                        } else {
                                            match self.persist_lock_state_serialized(&next) {
                                                Err(error) => Err(format!(
                                                    "couldn't persist partner arm: {error}"
                                                )),
                                                Ok(()) => {
                                                    *lock = next.clone();
                                                    Ok((next, generation))
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
        match result {
            Ok((next, generation)) => {
                self.broadcast(
                    &CompanionMessage::LockStateSync {
                        v: PROTOCOL_VERSION,
                        lock_state: next,
                    },
                    None,
                );
                self.log_event("partner-arm", &format!("generation {generation}"));
                self.command_result(conn_id, true, format!("partner arm saved: {generation}"));
            }
            Err(message) => {
                self.log_event("partner-arm-refused", &message);
                self.command_result(conn_id, false, message);
            }
        }
    }

    fn partner_begin(&self, conn_id: u64) {
        self.partner_begin_at(conn_id, self.wall_ms(), self.mono_ms());
    }

    fn partner_begin_at(&self, conn_id: u64, now: i64, now_mono: u64) {
        let result = (|| -> Result<PendingPartnerOperation, String> {
            let lock = self.lock_state.lock().unwrap();
            let mut current = self.partner.lock().unwrap();
            let Some(generation) = armed_partner_generation(&lock).map(str::to_owned) else {
                Err("no current partner arm; beginOperation refused".to_string())?
            };
            let operation_id = match partner::random_id() {
                Ok(id) => id,
                Err(error) => Err(error.to_string())?,
            };
            let nonce = match partner::random_id() {
                Ok(nonce) => nonce,
                Err(error) => Err(error.to_string())?,
            };
            let Some(expires_at_ms) = now.checked_add(MAX_OPERATION_LIFETIME_MS) else {
                Err("partner operation time overflow".to_string())?
            };
            match partner::begin_operation_at(
                &current,
                &generation,
                &operation_id,
                &nonce,
                now,
                now_mono,
                expires_at_ms,
            ) {
                Err(error) => Err(error.to_string()),
                Ok(next) => {
                    let operation = next
                        .pending_operations
                        .iter()
                        .find(|operation| operation.operation_id == operation_id)
                        .cloned()
                        .ok_or_else(|| "new partner operation is missing".to_string())?;
                    match self.store.save_partner_state(&next) {
                        Err(error) => Err(format!("couldn't persist partner operation: {error}")),
                        Ok(()) => {
                            *current = next;
                            Ok(operation)
                        }
                    }
                }
            }
        })();
        match result {
            Ok(operation) => {
                #[cfg(test)]
                self.pause_partner_result_if_requested();
                match serde_json::to_string(&operation) {
                    Ok(json) => {
                        self.broadcast_partner_status();
                        self.log_event(
                            "partner-begin",
                            &format!("operation {} persisted", operation.operation_id),
                        );
                        self.command_result(conn_id, true, json);
                    }
                    Err(error) => {
                        // This structure is infallibly JSON-serializable; retain
                        // a truthful persisted-state error if that ever changes.
                        self.command_result(
                            conn_id,
                            false,
                            format!(
                                "partner operation persisted but could not be encoded: {error}"
                            ),
                        );
                    }
                }
            }
            Err(message) => {
                self.log_event("partner-begin-refused", &message);
                self.command_result(conn_id, false, message);
            }
        }
    }

    fn partner_redeem(&self, conn_id: u64, token: &str) {
        self.partner_redeem_at(conn_id, token, self.wall_ms(), self.mono_ms());
    }

    fn partner_redeem_at(&self, conn_id: u64, token: &str, now: i64, now_mono: u64) {
        let result = (|| -> Result<(LockState, String), String> {
            let mut lock = self.lock_state.lock().unwrap();
            let mut current = self.partner.lock().unwrap();
            let authorization = match partner::redeem_operation_at(&current, token, now, now_mono) {
                Ok(authorization) => authorization,
                Err(error) => Err(error.to_string())?,
            };
            if armed_partner_generation(&lock) != Some(authorization.arm_generation.as_str()) {
                Err("signed partner arm is no longer current; release refused".to_string())?;
            }
            let now_stamp = match u64::try_from(now) {
                Ok(stamp) => stamp,
                Err(_) => Err("invalid partner release time".to_string())?,
            };
            let previous_stamp = lock.partner_arm_updated_at.unwrap_or(0);
            let release_stamp = now_stamp.max(previous_stamp.saturating_add(1));
            if release_stamp <= previous_stamp {
                Err("partner release stamp is exhausted".to_string())?;
            }
            let next = Self::merged_partner_lock(&lock, None, release_stamp, now);
            if next.partner_arm_generation.is_some() {
                Err("partner release merge kept an arm generation".to_string())?;
            }

            // The replay memo is durable BEFORE any release. If this write
            // fails, neither slice changes and no success can be reported.
            if let Err(error) = self.store.save_partner_state(&authorization.state) {
                Err(format!("couldn't persist partner replay memo: {error}"))?;
            }
            *current = authorization.state.clone();

            // A second-file failure leaves the arm intact and the replay memo
            // consumed. That is deliberately fail-closed, not a transaction or
            // a false success; a fresh operation is required after repair.
            if let Err(error) = self.persist_lock_state_serialized(&next) {
                Err(format!(
                    "replay memo saved, but couldn't persist partner release: {error}"
                ))?;
            }
            *lock = next.clone();
            Ok((next, authorization.operation_id))
        })();
        match result {
            Ok((next, operation_id)) => {
                self.broadcast(
                    &CompanionMessage::LockStateSync {
                        v: PROTOCOL_VERSION,
                        lock_state: next,
                    },
                    Some(conn_id),
                );
                self.broadcast_partner_status();
                self.log_event(
                    "partner-redeem",
                    &format!("operation {operation_id} released its current arm"),
                );
                self.command_result(
                    conn_id,
                    true,
                    format!("partner arm released exactly once: {operation_id}"),
                );
            }
            Err(message) => {
                self.log_event("partner-redeem-refused", &message);
                self.command_result(conn_id, false, message);
            }
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
fn build_snapshot(shared: &Shared, now_wall_ms: i64, now_mono_ms: u64) -> StatusSnapshot {
    let browser_grace = {
        let state = shared.enforcer_state.lock().unwrap();
        state
            .grace_browsers()
            .into_iter()
            .filter_map(|kind| {
                state
                    .grace_remaining_ms(kind, now_mono_ms)
                    .map(|grace_remaining_ms| BrowserGraceInfo {
                        kind,
                        observed_at_ms: now_wall_ms,
                        grace_seconds: enforcer::WATCHDOG_GRACE_MS / 1000,
                        grace_remaining_ms,
                    })
            })
            .collect()
    };
    let browsers = {
        let conns = shared.conns.lock().unwrap();
        conns
            .values()
            .filter(|e| e.authed)
            .filter_map(|e| {
                e.browser.map(|kind| BrowserInfo {
                    kind,
                    ext_version: e.ext_version.clone().unwrap_or_default(),
                    last_seen_ms: now_wall_ms
                        - now_mono_ms.saturating_sub(e.last_seen_mono_ms) as i64,
                })
            })
            .collect()
    };
    StatusSnapshot {
        pid: std::process::id(),
        started_at_ms: shared.started_wall_ms,
        written_at_ms: now_wall_ms,
        browsers: snapshot::dedupe_browsers(browsers),
        browser_grace,
    }
}

fn write_status_snapshot(shared: &Shared, now_wall_ms: i64, now_mono_ms: u64) {
    if let Err(e) = snapshot::write_snapshot(
        &shared.store,
        &build_snapshot(shared, now_wall_ms, now_mono_ms),
    ) {
        eprintln!("[daemon] failed to write status snapshot: {e}");
    }
}

/// Publish transitions immediately (including recovery/lock end), then refresh
/// active grace every ten seconds without producing healthy-status traffic.
fn sync_extension_loss_statuses(
    shared: &Shared,
    last_grace_browsers: &mut Vec<CompanionBrowser>,
    last_push_mono_ms: &mut u64,
    now_mono_ms: u64,
) {
    let current = shared.enforcer_state.lock().unwrap().grace_browsers();
    let changed = current != *last_grace_browsers;
    let refresh_due = !current.is_empty()
        && now_mono_ms.saturating_sub(*last_push_mono_ms) >= GRACE_STATUS_REFRESH_MS;
    if !changed && !refresh_due {
        return;
    }
    shared.broadcast_extension_loss();
    *last_grace_browsers = current;
    *last_push_mono_ms = now_mono_ms;
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
        if let Err(e) = shared.persist_lock_state_serialized(&next) {
            eprintln!("[daemon] failed to persist clock-compensated lock state: {e}");
        }
        next
    };
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
/// than the daemon's current in-memory state, re-persist the stronger one.
/// Capturing memory and healing disk share the writer serialization guard, so
/// neither a stale caller clone nor a concurrent writer can be persisted here.
fn heal_lock_file(shared: &Shared, now_wall_ms: i64) {
    let restored = {
        let lock = shared.lock_state.lock().unwrap();
        let disk = shared.store.load_lock_state();
        if merge_lock_states(&disk, &lock, now_wall_ms) != disk {
            if let Err(e) = shared.persist_lock_state_serialized(&lock) {
                eprintln!("[daemon] failed to restore tampered lock-state.json: {e}");
            }
            true
        } else {
            false
        }
    };
    if restored {
        shared.log_event(
            "lock-file-restored",
            "disk copy was weaker than the daemon's in-memory state",
        );
    }
}

/// Load and migrate public partner trust state, or create a fresh installation
/// only when no file exists. Every startup clears unsigned pending operations
/// and persists a current-runtime monotonic rehydration BEFORE commands bind.
fn load_or_initialize_partner_state(
    store: &Store,
    now: i64,
    now_mono: u64,
) -> io::Result<PartnerState> {
    let existing = store.load_partner_state_for_migration();
    if existing.is_none() && store.partner_state_file_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "partner-state.json is corrupt; refusing to replace partner trust state",
        ));
    }
    let state = match existing {
        Some(state) => state,
        None => {
            let installation_id = partner::random_id().map_err(|error| {
                io::Error::other(format!("cannot initialize partner state: {error}"))
            })?;
            PartnerState::new(&installation_id).map_err(|error| {
                io::Error::other(format!("cannot initialize partner state: {error}"))
            })?
        }
    };
    let rehydrated = partner::rehydrate(&state, now, now_mono)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    // This save also upgrades legacy files and drops unsigned operations before
    // a listener can accept any command. Present corruption never gets here.
    store.save_partner_state(&rehydrated)?;
    Ok(rehydrated)
}

/// Runs forever (accept loop on the calling thread). Returns only on a bind
/// error — `AddrInUse` means another daemon instance is already running.
pub fn run_daemon(opts: DaemonOptions) -> io::Result<()> {
    let started = Instant::now();
    let started_wall_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let initial_partner = load_or_initialize_partner_state(&opts.store, started_wall_ms, 0)?;
    let listener = ipc::listen(&opts.socket_name)?;
    let initial = opts.store.load_lock_state();
    let initial_blocking = opts.store.load_blocking_state();
    let initial_allowance = opts.store.load_allowance_state();
    let initial_config = opts.store.load_config();
    if initial_allowance.is_none() && opts.store.allowance_state_file_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "allowance-state.json is corrupt; refusing to mint a fresh daily pool",
        ));
    }
    // Best-effort managed-browser policy hardening (off until policy_enforce
    // + a real update_url are configured; no-op on non-Windows).
    let _ = crate::policy::apply_configured_policies(&initial_config);
    let shared = Arc::new(Shared {
        lock_state: Mutex::new(initial),
        #[cfg(test)]
        lock_state_save_gate: Mutex::new(None),
        partner: Mutex::new(initial_partner),
        #[cfg(test)]
        partner_result_gate: Mutex::new(None),
        allowance: Mutex::new(initial_allowance),
        store: opts.store,
        blocking: Mutex::new(initial_blocking),
        conns: Mutex::new(HashMap::new()),
        enforcer_state: Mutex::new(EnforcerState::default()),
        extension_loss_revision: AtomicU64::new(0),
        next_extension_loss_sequence: AtomicU64::new(0),
        started,
        started_wall_ms,
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
            let mut last_grace_browsers: Vec<CompanionBrowser> = Vec::new();
            let mut last_grace_push_mono_ms = 0;
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
                shared.observe_partner_at(now_wall, now_mono);
                // Commit a focus session whose undo window closed BEFORE
                // deriving status, so this very tick enforces it. Snapshots
                // are written after the resulting enforcer state is updated.
                commit_due_focus_session(&shared, now_wall);
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
                    shared.set_enforcer_state(EnforcerState::default());
                    write_status_snapshot(&shared, now_wall, now_mono);
                    sync_extension_loss_statuses(
                        &shared,
                        &mut last_grace_browsers,
                        &mut last_grace_push_mono_ms,
                        now_mono,
                    );
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
                heal_lock_file(&shared, now_wall);
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
                let previous = shared.enforcer_state.lock().unwrap().clone();
                let (next, actions) = enforcer::tick(
                    &previous,
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
                shared.set_enforcer_state(next);
                // Both consumers observe the same post-tick state and mono
                // timestamp that produced the close actions below.
                write_status_snapshot(&shared, now_wall, now_mono);
                sync_extension_loss_statuses(
                    &shared,
                    &mut last_grace_browsers,
                    &mut last_grace_push_mono_ms,
                    now_mono,
                );
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
        last_extension_loss_sequence: Arc::new(AtomicU64::new(0)),
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
                // A pairing token authenticates this connection, not a freely
                // chosen browser identity. Once paired, its identity cannot
                // be switched by a re-hello to read another browser's grace.
                let browser_conflict = shared.conns.lock().unwrap().get(&id).is_some_and(|entry| {
                    entry.authed
                        && entry
                            .browser
                            .is_some_and(|registered| registered != browser)
                });
                if browser_conflict {
                    shared.log_event(
                        "hello-browser-rejected",
                        &format!("{browser:?} ext {ext_version} id {extension_id}"),
                    );
                    shared.reply_to(
                        id,
                        &CompanionMessage::Error {
                            v: PROTOCOL_VERSION,
                            message:
                                "browser identity cannot change on an authenticated connection"
                                    .to_string(),
                        },
                    );
                } else if shared.authenticate(pairing.as_deref()) {
                    if !mark_authed(&shared, id, browser, &ext_version) {
                        // Defense in depth for a future mutation path: never
                        // issue a personalized reply after a failed binding.
                        shared.log_event("hello-browser-rejected", "binding changed during hello");
                        shared.reply_to(
                            id,
                            &CompanionMessage::Error {
                                v: PROTOCOL_VERSION,
                                message: "browser identity binding failed".to_string(),
                            },
                        );
                        continue;
                    }
                    authed = true;
                    shared.log_event(
                        "hello",
                        &format!("{browser:?} ext {ext_version} id {extension_id}"),
                    );
                    // Full (unredacted) status: the paired extension merges
                    // it, including password arm/unlock tombstones.
                    let (status, revision, sequence) = shared.status_for_browser(browser);
                    shared.reply_to_browser(
                        id,
                        browser,
                        revision,
                        sequence,
                        &CompanionMessage::CompanionStatus {
                            v: PROTOCOL_VERSION,
                            running: Some(true),
                            status,
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
            Some(CompanionMessage::BlockingStateUpdate {
                enabled,
                base_revision,
                ..
            }) => {
                meaningful = true;
                let authed = shared
                    .conns
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|e| e.authed);
                shared.update_browser_blocking(id, enabled, base_revision, authed);
            }
            // CLI commands ride the same same-user IPC admission as relays.
            // They cannot change an active lock's enable value or shorten it.
            Some(CompanionMessage::BlockCommand { action, .. }) => {
                meaningful = true;
                shared.block_command(id, action);
            }
            Some(CompanionMessage::LockCommand { duration_ms, .. }) => {
                meaningful = true;
                shared.lock_command(id, duration_ms);
            }
            Some(CompanionMessage::PartnerAddKey { public_key, .. }) => {
                meaningful = true;
                shared.partner_add_key(id, &public_key);
            }
            Some(CompanionMessage::PartnerArm { .. }) => {
                meaningful = true;
                shared.partner_arm(id);
            }
            Some(CompanionMessage::PartnerBeginOperation { .. }) => {
                meaningful = true;
                shared.partner_begin(id);
            }
            Some(CompanionMessage::PartnerRedeem { token, .. }) => {
                meaningful = true;
                shared.partner_redeem(id, &token);
            }
            Some(CompanionMessage::AllowanceBootstrap { allowance, .. }) => {
                meaningful = true;
                shared.allowance_bootstrap(id, &allowance);
            }
            Some(CompanionMessage::AllowanceCommand {
                command,
                base_revision,
                ..
            }) => {
                meaningful = true;
                shared.allowance_command_intent(id, &command, base_revision);
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
            last_extension_loss_sequence: Arc::clone(&old.last_extension_loss_sequence),
        });
        conns.insert(id, entry);
    }
}

/// Update a connection's liveness only (`auth` is sticky once granted).
fn touch(shared: &Shared, id: u64) {
    replace_conn(shared, id, None, None);
}

/// Mark a connection authenticated + register its browser kind. Re-hellos
/// may refresh the version but cannot change an authenticated identity.
/// Returns false instead of overwriting a conflicting registered browser.
fn mark_authed(shared: &Shared, id: u64, browser: CompanionBrowser, ext_version: &str) -> bool {
    let conflict = shared.conns.lock().unwrap().get(&id).is_some_and(|entry| {
        entry.authed
            && entry
                .browser
                .is_some_and(|registered| registered != browser)
    });
    if conflict {
        return false;
    }
    replace_conn(
        shared,
        id,
        Some((browser, ext_version.to_string())),
        Some(true),
    );
    true
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

/// Blocking CLI client for `block` and `lock`. A reply is accepted only after
/// the daemon has applied and durably written the requested operation (or
/// returned the unchanged authoritative state with a refusal).
pub fn send_command(
    socket_name: &str,
    command: &CompanionMessage,
    leg_timeout: Duration,
) -> io::Result<CompanionMessage> {
    if !matches!(
        command,
        CompanionMessage::BlockCommand { .. }
            | CompanionMessage::LockCommand { .. }
            | CompanionMessage::PartnerAddKey { .. }
            | CompanionMessage::PartnerArm { .. }
            | CompanionMessage::PartnerBeginOperation { .. }
            | CompanionMessage::PartnerRedeem { .. }
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a daemon CLI command",
        ));
    }
    let mut stream = ipc::connect(socket_name)?;
    stream.set_recv_timeout(Some(leg_timeout))?;
    stream.set_send_timeout(Some(leg_timeout))?;
    crate::framing::write_frame(&mut stream, &serde_json::to_value(command)?)?;
    let deadline = Instant::now() + leg_timeout.saturating_mul(4);
    while Instant::now() < deadline {
        match read_frame(&mut stream) {
            Ok(Some(frame)) => match parse_message(&frame) {
                Some(result @ CompanionMessage::CommandResult { .. }) => return Ok(result),
                Some(CompanionMessage::Error { message, .. }) => {
                    return Err(io::Error::other(message));
                }
                // Initial status/grace or unrelated pushed state can precede
                // the command result; none of those is an acknowledgement.
                _ => {}
            },
            Ok(None) => return Err(io::Error::other("daemon closed the command connection")),
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "timed out waiting for daemon command acknowledgement",
    ))
}

/// Offline-only partner signing bridge for the headless CLI crate. Keeping
/// secret-key decoding here avoids adding ed25519-dalek as a second direct CLI
/// dependency; this function performs no socket or daemon state access.
pub fn sign_partner_operation_offline(
    operation_json: &str,
    expires_at_ms: i64,
    private_key_hex: &str,
) -> Result<String, String> {
    let operation: PendingPartnerOperation = serde_json::from_str(operation_json)
        .map_err(|error| format!("invalid partner operation JSON: {error}"))?;
    if private_key_hex.len() != 64
        || !private_key_hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("private key must be exactly 64 lowercase hex characters".to_string());
    }
    let mut secret = [0u8; 32];
    for (index, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&private_key_hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| "invalid private key hex".to_string())?;
    }
    let signing = ed25519_dalek::SigningKey::from_bytes(&secret);
    partner::sign_operation(&operation, expires_at_ms, &signing).map_err(|error| error.to_string())
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
    let blocking = store.load_blocking_state();
    format!(
        "blockingEnabled: {}\nblockingRevision: {}\nsettingsLocked: {}\nforceBlocking: {}\nreasons: {:?}\nuntil: {:?}\nnextBoundary: {:?}\n",
        blocking.map(|state| if state.enabled { "on" } else { "off" }).unwrap_or("uninitialized"),
        blocking.map(|state| state.revision.to_string()).unwrap_or_else(|| "0".to_string()),
        status.settings_locked,
        status.force_blocking,
        status.reasons,
        status.until,
        boundary
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
        let store = Store::new(dir.path());
        let partner =
            partner::rehydrate(&PartnerState::new(&"01".repeat(32)).unwrap(), 0, 0).unwrap();
        store.save_partner_state(&partner).unwrap();
        let shared = Arc::new(Shared {
            store,
            lock_state: Mutex::new(LockState::default()),
            lock_state_save_gate: Mutex::new(None),
            partner: Mutex::new(partner),
            partner_result_gate: Mutex::new(None),
            allowance: Mutex::new(None),
            blocking: Mutex::new(None),
            conns: Mutex::new(HashMap::new()),
            enforcer_state: Mutex::new(EnforcerState::default()),
            extension_loss_revision: AtomicU64::new(0),
            next_extension_loss_sequence: AtomicU64::new(0),
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
                last_extension_loss_sequence: Arc::new(AtomicU64::new(0)),
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

    fn state_with_chrome_grace(since_mono_ms: u64) -> EnforcerState {
        let lock = LockState {
            frozen_until: Some(2_000_000),
            ..LockState::default()
        };
        let lock_status = derive_lock_status(&lock, 1_000_000);
        let processes = [crate::procwatch::ProcInfo {
            pid: 987_654,
            name: "chrome".into(),
            cmd: vec![],
            exe: None,
        }];
        let (state, _) = enforcer::tick(
            &EnforcerState::default(),
            &TickInputs {
                now_wall_ms: 1_000_000,
                now_mono_ms: since_mono_ms,
                lock_status: &lock_status,
                processes: &processes,
                connections: &[],
                config: &crate::store::CompanionConfig::default(),
                own_pid: 999,
            },
        );
        state
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

    fn test_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn test_signing() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
    }

    fn test_public(signing: &ed25519_dalek::SigningKey) -> String {
        test_hex(&signing.verifying_key().to_bytes())
    }

    fn latest_command_result(outbox: &Outbox) -> Value {
        frames_in(outbox)
            .into_iter()
            .rev()
            .find(|frame| frame["type"] == "commandResult")
            .expect("partner command result")
    }

    // Artificial wall fixtures must never be paired with the process clock.
    // This explicit monotonic fixture is old enough to backdate a full delay.
    const TEST_MONO: u64 = 100_000_000;

    fn add_immediately_active_key(
        shared: &Shared,
        conn_id: u64,
        outbox: &Outbox,
        signing: &ed25519_dalek::SigningKey,
        now: i64,
    ) {
        shared.partner_add_key_at(
            conn_id,
            &test_public(signing),
            now - partner::PARTNER_ACTIVATION_DELAY_MS,
            TEST_MONO - partner::PARTNER_ACTIVATION_DELAY_MS as u64,
        );
        assert_eq!(latest_command_result(outbox)["ok"], true);
        assert!(partner::has_active_key_at(
            &shared.partner.lock().unwrap(),
            now,
            TEST_MONO,
        ));
    }

    fn latest_pending_operation(shared: &Shared) -> PendingPartnerOperation {
        shared
            .partner
            .lock()
            .unwrap()
            .pending_operations
            .last()
            .cloned()
            .expect("persisted pending partner operation")
    }

    fn signed_test_code(
        operation: &PendingPartnerOperation,
        expires_at_ms: i64,
        signing: &ed25519_dalek::SigningKey,
    ) -> String {
        sign_partner_operation_offline(
            &serde_json::to_string(operation).unwrap(),
            expires_at_ms,
            &test_hex(&signing.to_bytes()),
        )
        .expect("real offline Ed25519 token")
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
    fn paused_merge_cannot_overwrite_a_newer_acknowledged_cli_lock() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 1, false);
        let older = LockState {
            timer_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };
        let older_timer = older.timer_until.unwrap();

        // Pause the older merge after its in-memory mutation but immediately
        // before its disk write, with the lock-state mutex still held.
        let (save_started_tx, save_started_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::sync_channel(0);
        *shared.lock_state_save_gate.lock().unwrap() = Some((save_started_tx, resume_rx));
        let merge_shared = Arc::clone(&shared);
        let merge = std::thread::spawn(move || merge_shared.merge_local(&older));
        save_started_rx.recv().unwrap();

        let (cli_started_tx, cli_started_rx) = mpsc::sync_channel(1);
        let cli_shared = Arc::clone(&shared);
        let command = std::thread::spawn(move || {
            cli_started_tx.send(()).unwrap();
            cli_shared.lock_command(1, 240_000);
        });
        cli_started_rx.recv().unwrap();
        assert!(matches!(
            shared.lock_state.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));

        resume_tx.send(()).unwrap();
        merge.join().unwrap();
        command.join().unwrap();

        let frames = frames_in(&cli);
        let ack = frames
            .iter()
            .find(|frame| frame["type"] == "commandResult")
            .expect("CLI command acknowledgement");
        assert_eq!(ack["ok"], true);
        let acked_timer = ack["status"]["lockState"]["timerUntil"].as_i64().unwrap();
        assert!(acked_timer > older_timer);
        assert_eq!(
            shared.lock_state.lock().unwrap().timer_until,
            Some(acked_timer)
        );
        assert_eq!(
            shared.store.load_lock_state().timer_until,
            Some(acked_timer),
            "the older merge write must not land after the newer acknowledgement"
        );
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
                lead_minutes: None,
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
        *shared.lock_state.lock().unwrap() = strong.clone();
        shared.store.save_lock_state(&strong).unwrap();

        // Disk weaker than memory → re-persist the stronger memory state.
        shared.store.save_lock_state(&LockState::default()).unwrap();
        heal_lock_file(&shared, shared.wall_ms());
        assert_eq!(shared.store.load_lock_state(), strong);

        // Disk stronger than memory → leave the disk copy untouched.
        let stronger = LockState {
            frozen_until: strong.frozen_until,
            timer_until: Some(shared.wall_ms() + 60_000),
            ..LockState::default()
        };
        shared.store.save_lock_state(&stronger).unwrap();
        heal_lock_file(&shared, shared.wall_ms());
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
    fn grace_observations_are_recipient_specific_and_authenticated() {
        let (_dir, shared) = test_shared();
        let chrome = add_conn(&shared, 1, true);
        let edge = add_conn(&shared, 2, true);
        let anonymous = add_conn(&shared, 3, false);
        mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0");
        mark_authed(&shared, 2, CompanionBrowser::Edge, "0.5.0");
        replace_conn(
            &shared,
            3,
            Some((CompanionBrowser::Firefox, "9.9.9".into())),
            Some(false),
        );
        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));

        shared.broadcast_extension_loss();

        let chrome_frames = frames_in(&chrome);
        let edge_frames = frames_in(&edge);
        assert_eq!(chrome_frames.len(), 1);
        assert_eq!(edge_frames.len(), 1);
        assert_eq!(
            chrome_frames[0]["status"]["extensionLoss"]["state"],
            "grace"
        );
        assert!(chrome_frames[0]["status"]["extensionLoss"]["graceRemainingMs"].is_number());
        assert_eq!(
            edge_frames[0]["status"]["extensionLoss"]["state"],
            "connected"
        );
        assert!(edge_frames[0]["status"]["extensionLoss"]["graceRemainingMs"].is_null());
        assert!(frames_in(&anonymous).is_empty(), "no anonymous broadcast");

        // Even direct accidental reuse of a personalized status is stripped
        // by the existing redacted serialization class.
        shared.reply_to(
            3,
            &CompanionMessage::CompanionStatus {
                v: PROTOCOL_VERSION,
                running: Some(true),
                status: shared.status_for_browser(CompanionBrowser::Chrome).0,
            },
        );
        let anonymous_frames = frames_in(&anonymous);
        assert_eq!(anonymous_frames.len(), 1);
        assert!(anonymous_frames[0]["status"].get("extensionLoss").is_none());
    }

    #[test]
    fn authenticated_rehello_cannot_change_browser_identity() {
        let (_dir, shared) = test_shared();
        let _relay = add_conn(&shared, 1, true);
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0"));
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.1"));
        assert!(!mark_authed(&shared, 1, CompanionBrowser::Edge, "9.9.9"));
        let entry = shared.conns.lock().unwrap().get(&1).unwrap().clone();
        assert_eq!(entry.browser, Some(CompanionBrowser::Chrome));
        assert_eq!(entry.ext_version.as_deref(), Some("0.5.1"));
    }

    #[test]
    fn personalized_send_rechecks_browser_at_queue_handoff() {
        let (_dir, shared) = test_shared();
        let relay = add_conn(&shared, 1, true);
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0"));
        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));
        let (status, revision, sequence) = shared.status_for_browser(CompanionBrowser::Chrome);
        let observation = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status,
        };

        // Simulate a registration change after recipient collection and status
        // construction. Its old personal observation must not enter the queue.
        replace_conn(
            &shared,
            1,
            Some((CompanionBrowser::Edge, "0.5.0".into())),
            Some(true),
        );
        shared.reply_to_browser(
            1,
            CompanionBrowser::Chrome,
            revision,
            sequence,
            &observation,
        );
        assert!(frames_in(&relay).is_empty());

        // The deliberately changed registration can receive its own state,
        // proving that the old observation was dropped rather than the peer.
        let (edge_status, edge_revision, edge_sequence) =
            shared.status_for_browser(CompanionBrowser::Edge);
        let edge_observation = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: edge_status,
        };
        shared.reply_to_browser(
            1,
            CompanionBrowser::Edge,
            edge_revision,
            edge_sequence,
            &edge_observation,
        );
        let edge_frames = frames_in(&relay);
        assert_eq!(edge_frames.len(), 1);
        assert_eq!(
            edge_frames[0]["status"]["extensionLoss"]["state"],
            "connected"
        );
    }

    #[test]
    fn stale_grace_hello_cannot_overwrite_connected_recovery() {
        let (_dir, shared) = test_shared();
        let relay = add_conn(&shared, 1, true);
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0"));
        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));

        // A hello captures the old state, then recovery publishes before its
        // queue handoff. The captured revision must make that stale frame a
        // no-op; otherwise no future healthy refresh would correct it.
        let (stale_status, stale_revision, stale_sequence) =
            shared.status_for_browser(CompanionBrowser::Chrome);
        let stale_hello = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: stale_status,
        };
        shared.set_enforcer_state(EnforcerState::default());
        shared.broadcast_extension_loss();
        shared.reply_to_browser(
            1,
            CompanionBrowser::Chrome,
            stale_revision,
            stale_sequence,
            &stale_hello,
        );

        let frames = frames_in(&relay);
        assert_eq!(frames.len(), 1, "only the recovery frame is delivered");
        assert_eq!(frames[0]["status"]["extensionLoss"]["state"], "connected");
        assert!(frames[0]["status"]["extensionLoss"]["graceRemainingMs"].is_null());
    }

    #[test]
    fn older_same_track_observation_cannot_overwrite_newer_one() {
        let (_dir, shared) = test_shared();
        let relay = add_conn(&shared, 1, true);
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0"));
        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));

        // Same track means the same revision, even when both captures happen
        // in one millisecond. Their capture sequences still impose an order.
        let (older_status, older_revision, older_sequence) =
            shared.status_for_browser(CompanionBrowser::Chrome);
        let (newer_status, newer_revision, newer_sequence) =
            shared.status_for_browser(CompanionBrowser::Chrome);
        assert_eq!(older_revision, newer_revision);
        assert!(older_sequence < newer_sequence);
        let older = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: older_status,
        };
        let newer = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: newer_status,
        };

        // Model newer hello -> older paused broadcast at queue handoff.
        shared.reply_to_browser(
            1,
            CompanionBrowser::Chrome,
            newer_revision,
            newer_sequence,
            &newer,
        );
        shared.reply_to_browser(
            1,
            CompanionBrowser::Chrome,
            older_revision,
            older_sequence,
            &older,
        );
        let frames = frames_in(&relay);
        assert_eq!(frames, vec![serde_json::to_value(&newer).unwrap()]);

        // Entry replacement on every heartbeat/re-hello must not reset the
        // high-water mark and allow the old capture back in afterward.
        replace_conn(&shared, 1, None, None);
        shared.reply_to_browser(
            1,
            CompanionBrowser::Chrome,
            older_revision,
            older_sequence,
            &older,
        );
        assert!(frames_in(&relay).is_empty());
    }

    #[test]
    fn grace_statuses_publish_on_transitions_and_every_ten_seconds() {
        let (_dir, shared) = test_shared();
        let chrome = add_conn(&shared, 1, true);
        mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0");
        let mut last_browsers = Vec::new();
        let mut last_push = 0;

        sync_extension_loss_statuses(&shared, &mut last_browsers, &mut last_push, 1_000);
        assert!(frames_in(&chrome).is_empty(), "healthy state stays quiet");

        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));
        sync_extension_loss_statuses(&shared, &mut last_browsers, &mut last_push, 2_000);
        assert_eq!(frames_in(&chrome).len(), 1, "grace begins immediately");
        sync_extension_loss_statuses(&shared, &mut last_browsers, &mut last_push, 11_999);
        assert!(frames_in(&chrome).is_empty(), "no per-tick status churn");
        sync_extension_loss_statuses(&shared, &mut last_browsers, &mut last_push, 12_000);
        assert_eq!(frames_in(&chrome).len(), 1, "ten-second grace refresh");

        shared.set_enforcer_state(EnforcerState::default());
        sync_extension_loss_statuses(&shared, &mut last_browsers, &mut last_push, 13_000);
        let recovery = frames_in(&chrome);
        assert_eq!(recovery.len(), 1, "recovered, or lock ended");
        assert_eq!(recovery[0]["status"]["extensionLoss"]["state"], "connected");
    }

    #[test]
    fn desktop_grace_survives_browser_relay_loss() {
        let (_dir, shared) = test_shared();
        let _relay = add_conn(&shared, 1, true);
        mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0");
        shared.set_enforcer_state(state_with_chrome_grace(1_000));
        let now = shared.wall_ms();

        let connected = build_snapshot(&shared, now, 30_000);
        assert_eq!(connected.browsers.len(), 1);
        assert_eq!(connected.browser_grace.len(), 1);
        assert_eq!(connected.browser_grace[0].observed_at_ms, now);
        assert_eq!(connected.browser_grace[0].grace_remaining_ms, 31_000);

        shared.conns.lock().unwrap().remove(&1);
        let disconnected = build_snapshot(&shared, now + 1_000, 31_000);
        assert!(disconnected.browsers.is_empty());
        assert_eq!(disconnected.browser_grace.len(), 1);
        assert_eq!(disconnected.browser_grace[0].grace_remaining_ms, 30_000);
    }

    #[test]
    fn fresh_stale_blocking_intent_preserves_browser_grace_status() {
        let (_dir, shared) = test_shared();
        let relay = add_conn(&shared, 1, true);
        assert!(mark_authed(&shared, 1, CompanionBrowser::Chrome, "0.5.0"));
        shared.set_enforcer_state(state_with_chrome_grace(shared.mono_ms()));

        // No ordinary blocking state exists, so a nonzero base is stale. Its
        // corrective CompanionStatus must still be personalized for Chrome.
        shared.update_browser_blocking(1, true, 7, true);

        assert_eq!(*shared.blocking.lock().unwrap(), None);
        assert_eq!(shared.store.load_blocking_state(), None);
        let frames = frames_in(&relay);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "companionStatus");
        assert!(frames[0]["status"].get("blocking").is_none());
        assert_eq!(frames[0]["status"]["extensionLoss"]["state"], "grace");
        assert!(frames[0]["status"]["extensionLoss"]["graceRemainingMs"].is_number());
    }

    #[test]
    fn browser_blocking_updates_are_authenticated_revision_checked_and_persistent() {
        let (_dir, shared) = test_shared();
        let chrome = add_conn(&shared, 1, true);
        let edge = add_conn(&shared, 2, true);

        // A fresh daemon adopts the first authenticated browser's explicit
        // value, persists it, broadcasts it, and answers the sender.
        shared.update_browser_blocking(1, true, 0, true);
        let first = BlockingState {
            enabled: true,
            revision: 1,
        };
        assert_eq!(shared.store.load_blocking_state(), Some(first));
        let chrome_frames = frames_in(&chrome);
        let edge_frames = frames_in(&edge);
        assert_eq!(chrome_frames.len(), 1);
        assert_eq!(edge_frames.len(), 1);
        assert_eq!(chrome_frames[0]["blocking"]["revision"], 1);
        assert_eq!(edge_frames[0]["blocking"]["enabled"], true);

        // The second browser can make a new decision only from the authority
        // it actually observed. This is a real cross-browser change, not a
        // last-writer-wins overwrite based on delivery timing.
        shared.update_browser_blocking(2, false, 1, true);
        let second = BlockingState {
            enabled: false,
            revision: 2,
        };
        assert_eq!(shared.store.load_blocking_state(), Some(second));
        assert_eq!(frames_in(&chrome)[0]["blocking"]["enabled"], false);
        assert_eq!(frames_in(&edge)[0]["blocking"]["enabled"], false);

        // Chrome's delayed start based on revision 1 cannot undo Edge's
        // revision 2. It receives current authority and nobody else changes.
        shared.update_browser_blocking(1, true, 1, true);
        let stale_answer = frames_in(&chrome);
        assert_eq!(stale_answer.len(), 1);
        assert_eq!(stale_answer[0]["type"], "blockingStateSync");
        assert_eq!(stale_answer[0]["blocking"]["enabled"], false);
        assert_eq!(stale_answer[0]["blocking"]["revision"], 2);
        assert!(frames_in(&edge).is_empty());
        assert_eq!(shared.store.load_blocking_state(), Some(second));

        // Re-reporting the daemon-applied value is exactly one authoritative
        // reply, with no revision increment and no broadcast: the echo ends.
        shared.update_browser_blocking(2, false, 2, true);
        assert_eq!(frames_in(&edge).len(), 1);
        assert!(frames_in(&chrome).is_empty());
        assert_eq!(shared.store.load_blocking_state(), Some(second));

        // The same payload on an unauthenticated local connection is refused
        // without changing state or notifying either authenticated browser.
        let forged = add_conn(&shared, 3, false);
        shared.update_browser_blocking(3, true, 2, false);
        let forged_frames = frames_in(&forged);
        assert_eq!(forged_frames.len(), 1);
        assert_eq!(forged_frames[0]["type"], "error");
        assert!(frames_in(&chrome).is_empty());
        assert!(frames_in(&edge).is_empty());
        assert_eq!(shared.store.load_blocking_state(), Some(second));
    }

    #[test]
    fn browser_and_cli_disable_paths_are_all_refused_during_a_lock() {
        let (_dir, shared) = test_shared();
        let enabled = BlockingState {
            enabled: true,
            revision: 4,
        };
        shared.store.save_blocking_state(&enabled).unwrap();
        *shared.blocking.lock().unwrap() = Some(enabled);
        let locked = LockState {
            timer_until: Some(shared.wall_ms() + 600_000),
            ..LockState::default()
        };
        shared.store.save_lock_state(&locked).unwrap();
        *shared.lock_state.lock().unwrap() = locked.clone();
        let browser = add_conn(&shared, 1, true);
        let cli = add_conn(&shared, 2, false);

        shared.update_browser_blocking(1, false, 4, true);
        let browser_frames = frames_in(&browser);
        assert_eq!(browser_frames.len(), 2);
        assert_eq!(browser_frames[0]["type"], "error");
        assert_eq!(browser_frames[1]["blocking"]["enabled"], true);
        assert_eq!(browser_frames[1]["blocking"]["revision"], 4);

        for action in [BlockAction::Stop, BlockAction::Toggle] {
            shared.block_command(2, action);
            let result = frames_in(&cli);
            assert_eq!(result.len(), 1);
            assert_eq!(result[0]["type"], "commandResult");
            assert_eq!(result[0]["ok"], false);
            assert!(result[0]["message"]
                .as_str()
                .unwrap()
                .contains("lock is active"));
            assert_eq!(result[0]["status"]["blocking"]["enabled"], true);
            assert_eq!(result[0]["status"]["blocking"]["revision"], 4);
        }

        // Start is deliberately still legal while locked, but an already-on
        // value is an idempotent acknowledgement, not a fresh revision.
        shared.block_command(2, BlockAction::Start);
        let start = frames_in(&cli);
        assert_eq!(start[0]["ok"], true);
        assert!(start[0]["message"].as_str().unwrap().contains("already on"));
        assert_eq!(*shared.lock_state.lock().unwrap(), locked);
        assert_eq!(shared.store.load_blocking_state(), Some(enabled));
        assert!(frames_in(&browser).is_empty());
    }

    #[test]
    fn block_commands_only_revise_persisted_value_changes() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 1, false);
        let extension = add_conn(&shared, 2, true);

        shared.block_command(1, BlockAction::Start);
        let start = frames_in(&cli);
        assert_eq!(start[0]["ok"], true);
        assert_eq!(start[0]["status"]["blocking"]["revision"], 1);
        assert_eq!(frames_in(&extension)[0]["blocking"]["enabled"], true);
        assert_eq!(
            shared.store.load_blocking_state(),
            Some(BlockingState {
                enabled: true,
                revision: 1,
            })
        );

        shared.block_command(1, BlockAction::Start);
        let repeated = frames_in(&cli);
        assert_eq!(repeated[0]["ok"], true);
        assert_eq!(repeated[0]["status"]["blocking"]["revision"], 1);
        assert!(frames_in(&extension).is_empty());

        shared.block_command(1, BlockAction::Toggle);
        let stopped = frames_in(&cli);
        assert_eq!(stopped[0]["ok"], true);
        assert_eq!(stopped[0]["status"]["blocking"]["enabled"], false);
        assert_eq!(stopped[0]["status"]["blocking"]["revision"], 2);
        assert_eq!(frames_in(&extension)[0]["blocking"]["enabled"], false);
        assert_eq!(
            shared.store.load_blocking_state(),
            Some(BlockingState {
                enabled: false,
                revision: 2,
            })
        );

        shared.block_command(1, BlockAction::Stop);
        let already = frames_in(&cli);
        assert_eq!(already[0]["ok"], true);
        assert_eq!(already[0]["status"]["blocking"]["revision"], 2);
        assert!(frames_in(&extension).is_empty());
    }

    #[test]
    fn blocking_revision_accepts_js_max_and_refuses_further_mutation() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 1, false);
        let extension = add_conn(&shared, 2, true);
        let before_max = BlockingState {
            enabled: false,
            revision: MAX_JS_SAFE_INTEGER - 1,
        };
        *shared.blocking.lock().unwrap() = Some(before_max);
        shared.store.save_blocking_state(&before_max).unwrap();

        shared.block_command(1, BlockAction::Start);
        let at_max = BlockingState {
            enabled: true,
            revision: MAX_JS_SAFE_INTEGER,
        };
        assert_eq!(*shared.blocking.lock().unwrap(), Some(at_max));
        assert_eq!(shared.store.load_blocking_state(), Some(at_max));
        let accepted = frames_in(&cli);
        assert_eq!(accepted[0]["ok"], true);
        assert_eq!(
            accepted[0]["status"]["blocking"]["revision"],
            json!(MAX_JS_SAFE_INTEGER)
        );
        assert_eq!(frames_in(&extension).len(), 1);

        shared.block_command(1, BlockAction::Toggle);
        let exhausted = frames_in(&cli);
        assert_eq!(exhausted.len(), 1);
        assert_eq!(exhausted[0]["ok"], false);
        assert!(exhausted[0]["message"]
            .as_str()
            .unwrap()
            .contains("JavaScript's maximum safe integer"));
        assert_eq!(*shared.blocking.lock().unwrap(), Some(at_max));
        assert_eq!(shared.store.load_blocking_state(), Some(at_max));
        assert!(frames_in(&extension).is_empty());
    }

    #[test]
    fn lock_command_enables_blocking_and_extends_but_never_shortens() {
        let (_dir, shared) = test_shared();
        let disabled = BlockingState {
            enabled: false,
            revision: 9,
        };
        shared.store.save_blocking_state(&disabled).unwrap();
        *shared.blocking.lock().unwrap() = Some(disabled);
        let cli = add_conn(&shared, 1, false);
        let extension = add_conn(&shared, 2, true);

        shared.lock_command(1, 120_000);
        let first_frames = frames_in(&cli);
        assert_eq!(first_frames[0]["ok"], true);
        let first_end = shared.lock_state.lock().unwrap().timer_until.unwrap();
        assert!(first_end >= shared.wall_ms() + 119_000);
        let enabled = BlockingState {
            enabled: true,
            revision: 10,
        };
        assert_eq!(shared.store.load_blocking_state(), Some(enabled));
        assert_eq!(
            shared.store.load_lock_state().timer_until,
            Some(first_end),
            "the command replied only after its timer was durable"
        );
        let broadcasts = frames_in(&extension);
        assert_eq!(broadcasts.len(), 2);
        assert!(broadcasts
            .iter()
            .any(|frame| frame["type"] == "lockStateSync"));
        assert!(broadcasts
            .iter()
            .any(|frame| frame["type"] == "blockingStateSync"));

        // A tiny subsequent request is not a shorten/cancel side door.
        shared.lock_command(1, 1);
        let shorter = frames_in(&cli);
        assert_eq!(shorter[0]["ok"], true);
        assert_eq!(
            shared.lock_state.lock().unwrap().timer_until,
            Some(first_end)
        );
        assert_eq!(shared.store.load_blocking_state(), Some(enabled));
        assert!(frames_in(&extension).is_empty());

        shared.lock_command(1, 240_000);
        let extended = frames_in(&cli);
        assert_eq!(extended[0]["ok"], true);
        let later_end = shared.lock_state.lock().unwrap().timer_until.unwrap();
        assert!(later_end > first_end);
        assert_eq!(shared.store.load_lock_state().timer_until, Some(later_end));
        assert_eq!(shared.store.load_blocking_state(), Some(enabled));
        let extension_frames = frames_in(&extension);
        assert_eq!(extension_frames.len(), 1, "only the timer changed");
        assert_eq!(extension_frames[0]["type"], "lockStateSync");

        for invalid in [0, MAX_LOCK_MS as u64 + 1] {
            shared.lock_command(1, invalid);
            let refused = frames_in(&cli);
            assert_eq!(refused[0]["ok"], false);
            assert_eq!(
                shared.lock_state.lock().unwrap().timer_until,
                Some(later_end)
            );
            assert_eq!(shared.store.load_blocking_state(), Some(enabled));
        }
    }

    #[test]
    fn command_persistence_failures_are_not_acknowledged_as_success() {
        let (dir, shared) = test_shared();
        let cli = add_conn(&shared, 1, false);
        let extension = add_conn(&shared, 2, true);
        // Rename-over-directory fails on the supported Unix path without
        // relying on permission bits (which a root test runner would bypass).
        std::fs::create_dir(dir.path().join("blocking-state.json")).unwrap();

        shared.block_command(1, BlockAction::Start);
        let failed = frames_in(&cli);
        assert_eq!(failed[0]["ok"], false);
        assert!(failed[0]["message"]
            .as_str()
            .unwrap()
            .contains("couldn't persist"));
        assert_eq!(*shared.blocking.lock().unwrap(), None);
        assert!(frames_in(&extension).is_empty());

        // The two-file lock operation writes the timer first. A blocking-file
        // failure must restore that timer file and leave memory unchanged.
        shared.lock_command(1, 60_000);
        let failed = frames_in(&cli);
        assert_eq!(failed[0]["ok"], false);
        assert!(failed[0]["message"]
            .as_str()
            .unwrap()
            .contains("couldn't persist"));
        assert_eq!(*shared.lock_state.lock().unwrap(), LockState::default());
        assert_eq!(shared.store.load_lock_state(), LockState::default());
        assert_eq!(*shared.blocking.lock().unwrap(), None);
        assert!(frames_in(&extension).is_empty());
    }

    #[test]
    fn real_offline_sign_redeem_persists_replay_and_preserves_every_other_lock() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 90, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 90, &cli, &signing, now);

        let blocking = BlockingState {
            enabled: false,
            revision: 4,
        };
        *shared.blocking.lock().unwrap() = Some(blocking);
        shared.store.save_blocking_state(&blocking).unwrap();
        shared.partner_arm_at(90, now, TEST_MONO);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        assert!(!derive_lock_status(&shared.lock_state.lock().unwrap(), now).force_blocking);
        assert_eq!(*shared.blocking.lock().unwrap(), Some(blocking));

        shared.partner_begin_at(90, now + 1, TEST_MONO + 1);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        let operation = latest_pending_operation(&shared);
        assert_eq!(
            shared
                .store
                .load_partner_state()
                .unwrap()
                .pending_operations,
            vec![operation.clone()]
        );
        assert!(operation.expires_at_ms - (now + 1) <= MAX_OPERATION_LIFETIME_MS);

        // A real signature by a different Ed25519 key cannot consume/release.
        let wrong = signed_test_code(
            &operation,
            operation.expires_at_ms,
            &ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]),
        );
        let armed_before_wrong = shared.lock_state.lock().unwrap().clone();
        shared.partner_redeem_at(90, &wrong, now + 2, TEST_MONO + 2);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(*shared.lock_state.lock().unwrap(), armed_before_wrong);
        assert_eq!(latest_pending_operation(&shared), operation);

        // Other lock sources can coexist after the initial partner arm. Make a
        // deliberately full compound lock to prove exact field preservation.
        let schedule = ScheduleRule {
            id: "keep-global".into(),
            days: vec![1],
            start_minutes: 540,
            end_minutes: 1020,
            lead_minutes: None,
            tz_offset_minutes: Some(0),
            tz_name: Some("UTC".into()),
        };
        let category = crate::lock_math::CategoryScheduleRule {
            schedule: ScheduleRule {
                id: "keep-category".into(),
                ..schedule.clone()
            },
            categories: vec!["video games".into()],
        };
        let armed = shared.lock_state.lock().unwrap().clone();
        let before = LockState {
            break_started_at: Some(now - 1_000),
            break_not_before: Some(now - 500),
            break_ends_at: Some(now + 60_000),
            break_updated_at: (now - 1_000) as u64,
            timer_until: Some(now + 600_000),
            password_hash: Some("ab".repeat(32)),
            password_ts: (now - 100) as u64,
            delay_until: Some(0),
            delay_duration_ms: Some(60_000),
            delay_updated_at: (now - 200) as u64,
            random_text_len: Some(25),
            random_text_updated_at: (now - 300) as u64,
            frozen_until: Some(now + 700_000),
            schedules: vec![schedule],
            schedules_updated_at: (now - 400) as u64,
            category_schedules: Some(vec![category]),
            category_schedules_updated_at: (now - 500) as u64,
            ..armed
        };
        shared.store.save_lock_state(&before).unwrap();
        *shared.lock_state.lock().unwrap() = before.clone();

        let code = signed_test_code(&operation, operation.expires_at_ms, &signing);
        shared.partner_redeem_at(90, &code, now + 3, TEST_MONO + 3);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        let after = shared.lock_state.lock().unwrap().clone();
        assert!(after.partner_arm_generation.is_none());
        assert!(after.partner_arm_updated_at.unwrap() > before.partner_arm_updated_at.unwrap());
        let mut expected = before.clone();
        expected.partner_arm_generation = None;
        expected.partner_arm_updated_at = after.partner_arm_updated_at;
        assert_eq!(after, expected, "only the partner operation changed");
        assert_eq!(shared.store.load_lock_state(), after);
        assert_eq!(*shared.blocking.lock().unwrap(), Some(blocking));
        assert_eq!(shared.store.load_blocking_state(), Some(blocking));

        // Reopening the persisted partner state preserves the spent memo and
        // removes the consumed pending operation: this is the restart boundary.
        let reopened_partner =
            load_or_initialize_partner_state(&shared.store, now + 4, TEST_MONO + 4).unwrap();
        assert_eq!(reopened_partner.pending_operations, vec![]);
        assert_eq!(reopened_partner.spent_codes.len(), 1);
        assert_eq!(
            reopened_partner.spent_codes[0].operation_id,
            operation.operation_id
        );
    }

    #[test]
    fn replay_cannot_release_a_later_arm_and_key_rotation_does_not_change_it() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 91, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 91, &cli, &signing, now);
        shared.partner_arm_at(91, now, TEST_MONO);
        latest_command_result(&cli);
        let first_generation = shared
            .lock_state
            .lock()
            .unwrap()
            .partner_arm_generation
            .clone()
            .unwrap();
        shared.partner_begin_at(91, now + 1, TEST_MONO + 1);
        latest_command_result(&cli);
        let operation = latest_pending_operation(&shared);
        let code = signed_test_code(&operation, operation.expires_at_ms, &signing);
        shared.partner_redeem_at(91, &code, now + 2, TEST_MONO + 2);
        assert_eq!(latest_command_result(&cli)["ok"], true);

        shared.partner_arm_at(91, now + 3, TEST_MONO + 3);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        let second_generation = shared
            .lock_state
            .lock()
            .unwrap()
            .partner_arm_generation
            .clone()
            .unwrap();
        assert_ne!(first_generation, second_generation);
        shared.partner_redeem_at(91, &code, now + 4, TEST_MONO + 4);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(
            shared.lock_state.lock().unwrap().partner_arm_generation,
            Some(second_generation.clone())
        );

        // Adding/rotating trust material is independent of the existing arm.
        let other = ed25519_dalek::SigningKey::from_bytes(&[11u8; 32]);
        shared.partner_add_key_at(91, &test_public(&other), now + 5, TEST_MONO + 5);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        assert_eq!(
            shared.lock_state.lock().unwrap().partner_arm_generation,
            Some(second_generation)
        );
        assert_eq!(
            shared.store.load_partner_state().unwrap().public_keys.len(),
            2
        );
    }

    #[test]
    fn partner_key_delay_arm_guards_and_both_sync_classes_fail_closed() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 92, false);
        let signing = test_signing();
        let now = shared.wall_ms();

        // Even a paired raw lockStateSync cannot invent an arm.
        for authed in [false, true] {
            shared.merge_in(
                &LockState {
                    partner_arm_generation: Some("ee".repeat(32)),
                    partner_arm_updated_at: Some(now as u64),
                    ..LockState::default()
                },
                999,
                authed,
            );
            assert_eq!(
                shared.lock_state.lock().unwrap().partner_arm_generation,
                None
            );
        }

        shared.partner_add_key_at(92, &test_public(&signing), now, TEST_MONO);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        shared.partner_arm_at(
            92,
            now + partner::PARTNER_ACTIVATION_DELAY_MS - 1,
            TEST_MONO + partner::PARTNER_ACTIVATION_DELAY_MS as u64 - 1,
        );
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert!(shared
            .lock_state
            .lock()
            .unwrap()
            .partner_arm_generation
            .is_none());
        shared.partner_begin_at(92, now + 1, TEST_MONO + 1);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert!(shared.partner.lock().unwrap().pending_operations.is_empty());

        // Exactly twenty-four hours is active; an existing arm also makes any
        // subsequent arm attempt a refusal, not a generation replacement.
        shared.partner_arm_at(
            92,
            now + partner::PARTNER_ACTIVATION_DELAY_MS,
            TEST_MONO + partner::PARTNER_ACTIVATION_DELAY_MS as u64,
        );
        assert_eq!(latest_command_result(&cli)["ok"], true);
        let generation = shared
            .lock_state
            .lock()
            .unwrap()
            .partner_arm_generation
            .clone();
        shared.partner_arm_at(
            92,
            now + partner::PARTNER_ACTIVATION_DELAY_MS + 1,
            TEST_MONO + partner::PARTNER_ACTIVATION_DELAY_MS as u64 + 1,
        );
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(
            shared.lock_state.lock().unwrap().partner_arm_generation,
            generation
        );

        // Fresh daemon: a non-partner timer independently blocks initial arm.
        let (_other_dir, other) = test_shared();
        let other_cli = add_conn(&other, 1, false);
        add_immediately_active_key(&other, 1, &other_cli, &signing, now);
        *other.lock_state.lock().unwrap() = LockState {
            timer_until: Some(now + 60_000),
            ..LockState::default()
        };
        other.partner_arm_at(1, now + 1, TEST_MONO + 1);
        assert_eq!(latest_command_result(&other_cli)["ok"], false);
        assert!(other
            .lock_state
            .lock()
            .unwrap()
            .partner_arm_generation
            .is_none());
    }

    #[test]
    fn elapsed_expiry_cannot_be_undone_by_runtime_wall_rollback() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 97, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 97, &cli, &signing, now);
        shared.partner_arm_at(97, now, TEST_MONO);
        latest_command_result(&cli);
        shared.partner_begin_at(97, now + 1, TEST_MONO + 1);
        latest_command_result(&cli);
        let operation = latest_pending_operation(&shared);
        let code = signed_test_code(&operation, operation.expires_at_ms, &signing);
        let expired_mono = operation.expires_mono_ms.unwrap();

        // The first observation has a later wall reading. Neither failed call
        // mutates state, so the explicitly rolled-back second wall reading is
        // still unexpired in wall time but long spent in monotonic time.
        shared.partner_redeem_at(97, &code, now + 30_000, expired_mono);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        shared.partner_redeem_at(97, &code, now + 2, expired_mono);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(
            shared.lock_state.lock().unwrap().partner_arm_generation,
            Some(operation.arm_generation)
        );
    }

    #[test]
    fn begin_result_identifies_a_even_when_b_precedes_its_status_capture() {
        let (_dir, shared) = test_shared();
        let first_client = add_conn(&shared, 98, true);
        let second_client = add_conn(&shared, 99, true);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 98, &first_client, &signing, now);
        shared.partner_arm_at(98, now, TEST_MONO);
        latest_command_result(&first_client);
        frames_in(&second_client);

        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::channel();
        *shared.partner_result_gate.lock().unwrap() = Some((started_tx, resume_rx));
        let first_shared = Arc::clone(&shared);
        let first_thread = std::thread::spawn(move || {
            first_shared.partner_begin_at(98, now + 1, TEST_MONO + 1);
        });
        started_rx.recv().unwrap();
        shared.partner_begin_at(99, now + 2, TEST_MONO + 2);
        let second_result = latest_command_result(&second_client);
        let second_operation: PendingPartnerOperation =
            serde_json::from_str(second_result["message"].as_str().unwrap()).unwrap();
        let expected_first = shared
            .partner
            .lock()
            .unwrap()
            .pending_operations
            .iter()
            .find(|operation| operation.operation_id != second_operation.operation_id)
            .cloned()
            .unwrap();
        resume_tx.send(()).unwrap();
        first_thread.join().unwrap();

        let first_result = latest_command_result(&first_client);
        let first_operation: PendingPartnerOperation =
            serde_json::from_str(first_result["message"].as_str().unwrap()).unwrap();
        assert_eq!(first_operation, expected_first);
        assert_ne!(first_operation.operation_id, second_operation.operation_id);
        let status_operations = first_result["status"]["partner"]["pendingOperations"]
            .as_array()
            .unwrap();
        assert!(
            status_operations.len() >= 2,
            "B is intentionally in A's status"
        );
        let exact_a = serde_json::to_value(&first_operation).unwrap();
        assert!(status_operations.contains(&exact_a));
        assert!(status_operations.contains(&serde_json::to_value(&second_operation).unwrap()));
        let reported_a: PendingPartnerOperation =
            serde_json::from_str(first_result["message"].as_str().unwrap()).unwrap();
        assert_eq!(reported_a.operation_id, first_operation.operation_id);
    }

    #[test]
    fn authenticated_and_anonymous_sync_cannot_release_partner_arm() {
        let (_dir, shared) = test_shared();
        let cli = add_conn(&shared, 93, false);
        let paired = add_conn(&shared, 94, true);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 93, &cli, &signing, now);
        shared.partner_arm_at(93, now, TEST_MONO);
        latest_command_result(&cli);
        frames_in(&paired);
        let armed = shared.lock_state.lock().unwrap().clone();

        for authed in [false, true] {
            shared.merge_in(
                &LockState {
                    partner_arm_generation: None,
                    partner_arm_updated_at: Some((now + 100_000) as u64),
                    ..LockState::default()
                },
                if authed { 94 } else { 93 },
                authed,
            );
            assert_eq!(*shared.lock_state.lock().unwrap(), armed);
        }
    }

    #[test]
    fn partner_write_failures_do_not_acknowledge_or_release() {
        let (dir, shared) = test_shared();
        let cli = add_conn(&shared, 95, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 95, &cli, &signing, now);
        shared.partner_arm_at(95, now, TEST_MONO);
        latest_command_result(&cli);
        let armed = shared.lock_state.lock().unwrap().clone();
        let path = dir.path().join("partner-state.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        shared.partner_add_key_at(
            95,
            &test_public(&ed25519_dalek::SigningKey::from_bytes(&[13u8; 32])),
            now + 1,
            TEST_MONO + 1,
        );
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(shared.partner.lock().unwrap().public_keys.len(), 1);
        shared.partner_begin_at(95, now + 1, TEST_MONO + 1);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert!(shared.partner.lock().unwrap().pending_operations.is_empty());
        assert_eq!(*shared.lock_state.lock().unwrap(), armed);

        std::fs::remove_dir(&path).unwrap();
        let durable = shared.partner.lock().unwrap().clone();
        shared.store.save_partner_state(&durable).unwrap();
        shared.partner_begin_at(95, now + 2, TEST_MONO + 2);
        assert_eq!(latest_command_result(&cli)["ok"], true);
        let operation = latest_pending_operation(&shared);
        let code = signed_test_code(&operation, operation.expires_at_ms, &signing);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        shared.partner_redeem_at(95, &code, now + 3, TEST_MONO + 3);
        assert_eq!(latest_command_result(&cli)["ok"], false);
        assert_eq!(*shared.lock_state.lock().unwrap(), armed);
        assert_eq!(latest_pending_operation(&shared), operation);
        assert!(shared.partner.lock().unwrap().spent_codes.is_empty());
    }

    #[test]
    fn lock_write_failure_after_replay_memo_keeps_arm_and_reports_failure() {
        let (dir, shared) = test_shared();
        let cli = add_conn(&shared, 96, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 96, &cli, &signing, now);
        shared.partner_arm_at(96, now, TEST_MONO);
        latest_command_result(&cli);
        shared.partner_begin_at(96, now + 1, TEST_MONO + 1);
        latest_command_result(&cli);
        let operation = latest_pending_operation(&shared);
        let code = signed_test_code(&operation, operation.expires_at_ms, &signing);
        let armed = shared.lock_state.lock().unwrap().clone();
        let path = dir.path().join("lock-state.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        shared.partner_redeem_at(96, &code, now + 2, TEST_MONO + 2);
        let result = latest_command_result(&cli);
        assert_eq!(result["ok"], false);
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("replay memo saved"));
        assert_eq!(*shared.lock_state.lock().unwrap(), armed);
        let consumed = shared.store.load_partner_state().unwrap();
        assert!(consumed.pending_operations.is_empty());
        assert_eq!(consumed.spent_codes.len(), 1);
        assert_eq!(shared.partner.lock().unwrap().spent_codes.len(), 1);
    }

    #[test]
    fn startup_persists_fail_closed_legacy_migration_before_commands() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let installation = "01".repeat(32);
        let now = 2 * partner::PARTNER_ACTIVATION_DELAY_MS;
        let legacy = json!({
            "version": 1,
            "installationId": installation,
            "publicKeys": [{
                "publicKey": test_public(&test_signing()),
                "addedAtMs": 0,
                "activeAtMs": partner::PARTNER_ACTIVATION_DELAY_MS,
            }],
            "pendingOperations": [{
                "installationId": "01".repeat(32),
                "armGeneration": "02".repeat(32),
                "operationId": "03".repeat(32),
                "nonce": "04".repeat(32),
                "expiresAtMs": now + 60_000,
            }],
            "spentCodes": [{
                "operationId": "05".repeat(32),
                "signature": "00".repeat(64),
                "expiresAtMs": now + 60_000,
            }],
            "lastObservedAtMs": 0,
        });
        std::fs::write(
            dir.path().join("partner-state.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let migrated = load_or_initialize_partner_state(&store, now, 44).unwrap();
        assert!(migrated.pending_operations.is_empty());
        assert_eq!(migrated.spent_codes.len(), 1);
        assert_eq!(migrated.last_observed_mono_ms, Some(44));
        assert_eq!(migrated.public_keys[0].added_at_ms, now);
        assert_eq!(
            migrated.public_keys[0].active_at_ms,
            now + partner::PARTNER_ACTIVATION_DELAY_MS
        );
        assert_eq!(migrated.public_keys[0].added_mono_ms, Some(44));
        assert_eq!(
            migrated.public_keys[0].active_mono_ms,
            Some(44 + partner::PARTNER_ACTIVATION_DELAY_MS as u64)
        );
        assert_eq!(store.load_partner_state(), Some(migrated));

        // A wall-only legacy observation is not allowed to become active just
        // because its old activeAtMs is far in the past.
        let disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("partner-state.json")).unwrap())
                .unwrap();
        assert!(disk["publicKeys"][0]
            .get("activationObservedAtMs")
            .is_none());
        assert!(disk["publicKeys"][0]
            .get("activationObservedMonoMs")
            .is_none());
    }

    #[test]
    fn initialization_is_persistent_corruption_fails_closed_and_status_is_redacted() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let initialized = load_or_initialize_partner_state(&store, 100, 10).unwrap();
        assert!(initialized.public_keys.is_empty());
        assert_eq!(store.load_partner_state(), Some(initialized.clone()));
        assert_eq!(
            load_or_initialize_partner_state(&store, 100, 10).unwrap(),
            initialized
        );
        std::fs::write(dir.path().join("partner-state.json"), b"{ corrupt").unwrap();
        assert!(load_or_initialize_partner_state(&store, 101, 11).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("partner-state.json")).unwrap(),
            b"{ corrupt"
        );

        let (_state_dir, shared) = test_shared();
        let paired = add_conn(&shared, 1, true);
        let anonymous = add_conn(&shared, 2, false);
        let signing = test_signing();
        let now = shared.wall_ms();
        add_immediately_active_key(&shared, 1, &paired, &signing, now);
        shared.partner_arm_at(1, now, TEST_MONO);
        latest_command_result(&paired);
        let status = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: shared.status(),
        };
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains(&test_hex(&signing.to_bytes())));
        shared.reply_to(1, &status);
        shared.reply_to(2, &status);
        let full = frames_in(&paired);
        let redacted = frames_in(&anonymous);
        assert_eq!(
            full[0]["status"]["partner"]["publicKeys"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(full[0]["status"]["lockState"]["partnerArmGeneration"].is_string());
        assert!(redacted[0]["status"].get("partner").is_none());
        assert!(redacted[0]["status"]["lockState"]
            .get("partnerArmGeneration")
            .is_none());
        assert!(redacted[0]["status"]["lockState"]
            .get("partnerArmUpdatedAt")
            .is_none());
    }

    fn latest_allowance_command_result(outbox: &Outbox) -> Value {
        let frames = frames_in(outbox);
        let last = frames.last().unwrap().clone();
        assert_eq!(last["type"], "allowanceCommandResult");
        last
    }

    fn configure_test_allowance(operation_id: &str) -> Value {
        json!({
            "kind": "configure",
            "operationId": operation_id,
            "category": "video games",
            "config": {
                "dailyAllowanceMs": 600_000,
                "dailyOpenings": 1,
                "waitingBaseMs": 0,
                "waitingStepMs": 0,
                "waitingMaxMs": 0,
                "rewardCapMs": 60_000
            }
        })
    }

    fn test_operation_id(byte: u8) -> String {
        format!("{byte:02x}").repeat(16)
    }

    #[test]
    fn allowance_commands_persist_exact_revisions_deduplicate_and_recover() {
        let (_dir, shared) = test_shared();
        let outbox = add_conn(&shared, 201, true);
        let first = configure_test_allowance(&test_operation_id(1));
        shared.allowance_command_intent(201, &first, 0);
        assert_eq!(
            latest_allowance_command_result(&outbox)["allowance"]["revision"],
            1
        );
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 1);

        // Exact replay is acknowledged but does NOT write another revision even
        // if the caller's pre-recorded base is now stale.
        shared.allowance_command_intent(201, &first, 0);
        assert_eq!(latest_allowance_command_result(&outbox)["duplicate"], true);
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 1);

        let second = configure_test_allowance(&test_operation_id(2));
        shared.allowance_command_intent(201, &second, 1);
        assert_eq!(
            latest_allowance_command_result(&outbox)["allowance"]["revision"],
            2
        );
        shared.allowance_command_intent(201, &second, 0);
        assert_eq!(latest_allowance_command_result(&outbox)["duplicate"], true);
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 2);

        let stale = configure_test_allowance(&test_operation_id(3));
        shared.allowance_command_intent(201, &stale, 1);
        let refused = latest_allowance_command_result(&outbox);
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["reason"], "revision");
        assert_eq!(refused["allowance"]["revision"], 2);
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 2);
        assert_eq!(
            shared.store.load_allowance_state().unwrap().receipts.len(),
            2
        );
    }

    #[test]
    fn locked_configuration_preserves_every_lock_and_the_uninitialized_pool() {
        let (_dir, shared) = test_shared();
        let outbox = add_conn(&shared, 202, true);
        let now = shared.wall_ms();
        let other = LockState {
            timer_until: Some(now + 60_000),
            password_hash: Some("ab".repeat(32)),
            frozen_until: Some(now + 120_000),
            partner_arm_generation: Some("cd".repeat(32)),
            partner_arm_updated_at: Some(now as u64),
            ..LockState::default()
        };
        *shared.lock_state.lock().unwrap() = other.clone();
        *shared.blocking.lock().unwrap() = Some(BlockingState {
            enabled: true,
            revision: 7,
        });
        shared.allowance_command_intent(202, &configure_test_allowance(&test_operation_id(1)), 0);
        assert_eq!(latest_allowance_command_result(&outbox)["reason"], "locked");
        assert!(shared.allowance.lock().unwrap().is_none());
        assert!(!shared.store.allowance_state_file_exists().unwrap());
        assert_eq!(*shared.lock_state.lock().unwrap(), other);
        assert_eq!(
            *shared.blocking.lock().unwrap(),
            Some(BlockingState {
                enabled: true,
                revision: 7,
            })
        );
    }

    #[test]
    fn bootstrap_is_authenticated_once_only_and_present_corruption_stops_startup() {
        let (dir, shared) = test_shared();
        let anonymous = add_conn(&shared, 203, false);
        let paired = add_conn(&shared, 204, true);
        let snapshot = serde_json::to_value(allowance::AllowanceAuthorityState {
            revision: 3,
            ..allowance::empty_allowance_authority_state()
        })
        .unwrap();
        shared.allowance_bootstrap(203, &snapshot);
        assert_eq!(frames_in(&anonymous).last().unwrap()["type"], "error");
        assert_eq!(*shared.allowance.lock().unwrap(), None);

        shared.allowance_bootstrap(204, &snapshot);
        assert_eq!(
            shared.allowance.lock().unwrap().as_ref().unwrap().revision,
            3
        );
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 3);
        let last = frames_in(&paired);
        assert_eq!(last.last().unwrap()["type"], "allowanceStateSync");
        assert_eq!(last.last().unwrap()["allowance"]["revision"], 3);
        shared.allowance_bootstrap(
            204,
            &serde_json::to_value(allowance::AllowanceAuthorityState {
                revision: 2,
                ..allowance::empty_allowance_authority_state()
            })
            .unwrap(),
        );
        assert_eq!(
            shared.allowance.lock().unwrap().as_ref().unwrap().revision,
            3
        );
        shared.allowance_bootstrap(
            204,
            &serde_json::to_value(allowance::AllowanceAuthorityState {
                revision: 99,
                ..allowance::empty_allowance_authority_state()
            })
            .unwrap(),
        );
        assert_eq!(
            shared.allowance.lock().unwrap().as_ref().unwrap().revision,
            99
        );
        assert_eq!(shared.store.load_allowance_state().unwrap().revision, 99);

        let store = Store::new(dir.path());
        std::fs::write(store.dir().join("allowance-state.json"), b"{ invalid").unwrap();
        assert!(store.allowance_state_file_exists().unwrap());
        assert_eq!(store.load_allowance_state(), None);
    }

    #[test]
    fn allowance_write_failure_is_truthful_and_does_not_publish_success() {
        let (_dir, shared) = test_shared();
        let outbox = add_conn(&shared, 205, true);
        let path = shared.store.dir().join("allowance-state.json");
        std::fs::create_dir(&path).unwrap();
        shared.allowance_command_intent(205, &configure_test_allowance(&test_operation_id(1)), 0);
        let reply = latest_allowance_command_result(&outbox);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["reason"], "persistence");
        assert_eq!(reply["allowance"]["revision"], 0);
        let current = shared.allowance.lock().unwrap().clone();
        assert!(current.is_none());
        assert!(!path.is_file());

        // Recovery is possible after removing the induced write barrier.
        std::fs::remove_dir(&path).unwrap();
        shared.allowance_command_intent(205, &configure_test_allowance(&test_operation_id(1)), 0);
        assert_eq!(
            latest_allowance_command_result(&outbox)["allowance"]["revision"],
            1
        );
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
        let now_mono = shared.mono_ms();
        write_status_snapshot(&shared, now, now_mono);
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
        let snap = build_snapshot(&shared, now, now_mono);
        assert_eq!(snap.browsers[0].ext_version, "0.5.0");
        // Disconnect → gone from the next snapshot.
        shared.conns.lock().unwrap().remove(&1);
        assert!(build_snapshot(&shared, now, now_mono).browsers.is_empty());
    }
}
