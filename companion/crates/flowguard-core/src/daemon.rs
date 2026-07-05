//! The long-running companion service: accepts nm-host relays over local
//! IPC, keeps the connection registry the watchdog reads, merges lock state
//! with every extension, and drives the enforcement loop. Runs identically
//! under the headless `flowguard-daemon` binary (Linux/e2e) and inside the
//! Tauri shell (Windows, M7) — only the `Notifier` differs.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::enforcer::{self, Action, ConnInfo, EnforcerState, TickInputs};
use crate::framing::{read_frame, write_frame};
use crate::ipc;
use crate::ipc::traits::{ListenerExt as _, Stream as _};
use crate::lock_math::{
    derive_lock_status, next_boundary, sanitize_lock_state, LockState, MAX_LOCK_MS,
};
use crate::merge::merge_lock_states;
use crate::procwatch::{ProcessSource, SysinfoSource};
use crate::protocol::{
    parse_message, CompanionBrowser, CompanionEnforcement, CompanionMessage, CompanionStatus,
    PROTOCOL_VERSION,
};
use crate::store::Store;

/// Poll cadence while a forced block is active (process snapshots are only
/// taken in this mode).
const ENFORCE_TICK_MS: u64 = 3_000;
/// Idle cadence: one cheap status derivation per second, no process refresh.
const IDLE_TICK_MS: u64 = 1_000;

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
    sender: Mutex<Box<dyn io::Write + Send>>,
    browser: Option<CompanionBrowser>,
    last_seen_mono_ms: u64,
}

struct Shared {
    store: Store,
    lock_state: Mutex<LockState>,
    conns: Mutex<HashMap<u64, Arc<ConnEntry>>>,
    started: Instant,
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

    /// Merge a peer's lock state in; persist + broadcast only on change
    /// (the loop-prevention guard — both sides converge and go quiet).
    fn merge_in(&self, remote: &LockState, from_conn: u64) {
        let sanitized = sanitize_lock_state(
            &serde_json::to_value(remote).unwrap_or(Value::Null),
            self.wall_ms(),
            MAX_LOCK_MS,
        );
        let merged = {
            let mut current = self.lock_state.lock().unwrap();
            let merged = merge_lock_states(&current, &sanitized);
            if merged == *current {
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
            Some(from_conn),
        );
    }

    fn broadcast(&self, msg: &CompanionMessage, skip: Option<u64>) {
        let value = serde_json::to_value(msg).expect("protocol types serialize");
        let conns = self.conns.lock().unwrap();
        for (id, entry) in conns.iter() {
            if Some(*id) == skip {
                continue;
            }
            let mut sender = entry.sender.lock().unwrap();
            // A dead relay is dropped by its own reader thread; ignore here.
            let _ = write_frame(&mut *sender, &value);
        }
    }

    fn log_event(&self, kind: &str, detail: &str) {
        let line = format!("{} {kind} {detail}\n", self.wall_ms());
        let path = self.store.dir().join("events.log");
        let _ = std::fs::create_dir_all(self.store.dir());
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| io::Write::write_all(&mut f, line.as_bytes()));
    }
}

/// Runs forever (accept loop on the calling thread). Returns only on a bind
/// error — `AddrInUse` means another daemon instance is already running.
pub fn run_daemon(opts: DaemonOptions) -> io::Result<()> {
    let listener = ipc::listen(&opts.socket_name)?;
    let initial = opts.store.load_lock_state();
    let shared = Arc::new(Shared {
        lock_state: Mutex::new(initial),
        store: opts.store,
        conns: Mutex::new(HashMap::new()),
        started: Instant::now(),
        version: env!("CARGO_PKG_VERSION"),
        extra_incompatible: opts.extra_incompatible,
        dry_run_kills: opts.dry_run_kills,
    });
    shared.log_event("daemon-start", &format!("socket {}", opts.socket_name));

    // Enforcement loop: cheap status derivation while idle, process
    // snapshots + enforcer ticks only while a forced block is active.
    {
        let shared = Arc::clone(&shared);
        let notifier = opts.notifier;
        std::thread::spawn(move || {
            let mut source = SysinfoSource::new();
            let mut state = EnforcerState::default();
            let own_pid = std::process::id();
            loop {
                let lock = shared.lock_state.lock().unwrap().clone();
                let status = derive_lock_status(&lock, shared.wall_ms());
                if !status.force_blocking {
                    state = EnforcerState::default();
                    std::thread::sleep(Duration::from_millis(IDLE_TICK_MS));
                    continue;
                }
                let processes = source.snapshot();
                let now_mono = shared.mono_ms();
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
                let mut config = shared.store.load_config();
                config
                    .extra_incompatible_browsers
                    .extend(shared.extra_incompatible.iter().cloned());
                let (next, actions) = enforcer::tick(
                    &state,
                    &TickInputs {
                        now_wall_ms: shared.wall_ms(),
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
    let mut next_id: u64 = 0;
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[daemon] accept failed: {e}");
                continue;
            }
        };
        next_id += 1;
        let id = next_id;
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || serve_connection(id, stream, shared));
    }
    Ok(())
}

fn serve_connection(id: u64, stream: ipc::Stream, shared: Arc<Shared>) {
    let (mut recv, send) = stream.split();
    let entry = Arc::new(ConnEntry {
        sender: Mutex::new(Box::new(send) as Box<dyn io::Write + Send>),
        browser: None,
        last_seen_mono_ms: shared.mono_ms(),
    });
    shared.conns.lock().unwrap().insert(id, Arc::clone(&entry));

    // Push status (which embeds our lock state) to every fresh connection.
    // Hello also gets a reply, but a relay RECONNECTING after a daemon
    // restart never re-hellos — without this push, state seeded while the
    // extension was attached would sit unsynced until the next local change.
    {
        let push = CompanionMessage::CompanionStatus {
            v: PROTOCOL_VERSION,
            running: Some(true),
            status: shared.status(),
        };
        let mut sender = entry.sender.lock().unwrap();
        let _ = write_frame(
            &mut *sender,
            &serde_json::to_value(&push).expect("protocol types serialize"),
        );
    }

    // Loop ends on clean EOF or a bad frame — relay gone (browser closed).
    while let Ok(Some(frame)) = read_frame(&mut recv) {
        // Any well-formed frame counts as liveness for the watchdog.
        touch(&shared, id, None);
        match parse_message(&frame) {
            Some(CompanionMessage::Hello {
                browser,
                ext_version,
                extension_id,
                ..
            }) => {
                touch(&shared, id, Some(browser));
                shared.log_event(
                    "hello",
                    &format!("{browser:?} ext {ext_version} id {extension_id}"),
                );
                let reply = CompanionMessage::CompanionStatus {
                    v: PROTOCOL_VERSION,
                    running: Some(true),
                    status: shared.status(),
                };
                if let Some(entry) = shared.conns.lock().unwrap().get(&id) {
                    let mut sender = entry.sender.lock().unwrap();
                    let _ = write_frame(
                        &mut *sender,
                        &serde_json::to_value(&reply).expect("protocol types serialize"),
                    );
                }
            }
            Some(CompanionMessage::LockStateSync { lock_state, .. }) => {
                shared.merge_in(&lock_state, id);
            }
            Some(CompanionMessage::Heartbeat { .. }) => {}
            // companionStatus/error are daemon->extension; unknown types are
            // a newer peer — both ignored (forward compatibility).
            Some(_) | None => {}
        }
    }

    shared.conns.lock().unwrap().remove(&id);
    shared.log_event("relay-disconnect", &format!("conn {id}"));
}

/// Update a connection's liveness (and browser kind once hello arrives).
/// Entries are replaced, not mutated: `ConnEntry` fields are read lock-free
/// by the enforcement loop via the map snapshot.
fn touch(shared: &Shared, id: u64, browser: Option<CompanionBrowser>) {
    let mut conns = shared.conns.lock().unwrap();
    if let Some(old) = conns.remove(&id) {
        let entry = Arc::new(ConnEntry {
            // The sender Mutex<Box<Write>> can't be cloned; steal it by
            // swapping in a sink — old entry is dropped right here.
            sender: Mutex::new(std::mem::replace(
                &mut *old.sender.lock().unwrap(),
                Box::new(io::sink()),
            )),
            browser: browser.or(old.browser),
            last_seen_mono_ms: shared.started.elapsed().as_millis() as u64,
        });
        conns.insert(id, entry);
    }
}

/// Convenience used by bins: `flowguard-daemon status`.
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
