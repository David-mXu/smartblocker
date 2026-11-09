//! Headless companion daemon + installer CLI. The Tauri shell (M7) embeds
//! the same `smartblocker_core::daemon`; this binary is the Linux/e2e face.
//!
//!   smartblocker-daemon run [--socket NAME] [--data-dir PATH]
//!                        [--extra-browser NAME]... [--dry-run-kills]
//!                        [--watchdog]
//!   smartblocker-daemon watchdog [--socket NAME] [--data-dir PATH]
//!   smartblocker-daemon install [--host-path PATH]   # NM manifests + autostart
//!   smartblocker-daemon uninstall
//!   smartblocker-daemon status
//!   smartblocker-daemon block start|stop|toggle [--socket NAME]
//!   smartblocker-daemon lock MINUTES [--socket NAME]
//!   smartblocker-daemon partner add-key HEX|arm|begin|redeem TOKEN
//!   smartblocker-daemon partner-keygen                 # offline, prints once
//!   smartblocker-daemon partner-sign OPERATION_JSON EXPIRES_MS PRIVATE_KEY_HEX

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use smartblocker_core::daemon::{self, describe_status, run_daemon, DaemonOptions, LogNotifier};
use smartblocker_core::enforcer;
use smartblocker_core::ipc::DEFAULT_SOCKET_NAME;
use smartblocker_core::lock_math::derive_lock_status;
use smartblocker_core::partner::generate_signing_material;
use smartblocker_core::protocol::{BlockAction, CompanionMessage, PROTOCOL_VERSION};
use smartblocker_core::registration;
use smartblocker_core::store::Store;
use smartblocker_core::supervisor;

/// Watchdog poll cadence: with a forced block active the daemon's absence is
/// detected within ~2s and it is respawned.
const WATCHDOG_TICK: Duration = Duration::from_secs(2);
/// Per-leg timeout of the watchdog's PING/PONG probe: long enough to never
/// false-positive on a loaded daemon, short enough that a squatter costs at
/// most one extra watchdog tick.
const PROBE_LEG_TIMEOUT: Duration = Duration::from_millis(500);
const COMMAND_LEG_TIMEOUT: Duration = Duration::from_secs(2);

fn print_command_result(result: std::io::Result<CompanionMessage>) -> ExitCode {
    match result {
        Ok(CompanionMessage::CommandResult { ok, message, .. }) => {
            if ok {
                println!("{message}");
                ExitCode::SUCCESS
            } else {
                eprintln!("error: {message}");
                ExitCode::FAILURE
            }
        }
        Ok(other) => {
            eprintln!("error: unexpected daemon reply: {other:?}");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_from(data_dir: Option<PathBuf>) -> Store {
    match data_dir {
        Some(dir) => Store::new(dir),
        None => Store::at_default_dir().expect("no resolvable home directory"),
    }
}

#[cfg(not(windows))]
fn home_dir() -> PathBuf {
    // Intentionally $HOME-based (not `directories`): NM manifests belong to
    // the invoking user's profile even under sudo -E style invocations.
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}

/// Spawn `smartblocker-daemon run` (or `watchdog`) as a detached background
/// child of this same binary, preserving socket + data-dir wiring. The
/// respawn deliberately drops run-only flags like `--dry-run-kills` and
/// `--extra-browser` — those belong to the e2e harness, not a production
/// revival. A spawned `run` child gets our pid via env so IT can revive US
/// if we die (mutual watch). Returns the child pid.
fn spawn_background_child(subcommand: &str, socket: &str, data_dir: Option<&Path>) -> Option<u32> {
    let Ok(exe) = std::env::current_exe() else {
        eprintln!("[smartblocker-daemon] current_exe unavailable; cannot spawn {subcommand}");
        return None;
    };
    let mut cmd = Command::new(exe);
    cmd.arg(subcommand).arg("--socket").arg(socket);
    if let Some(dir) = data_dir {
        cmd.arg("--data-dir").arg(dir);
    }
    if subcommand == "run" {
        cmd.env(supervisor::WATCHDOG_PID_ENV, std::process::id().to_string());
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|child| child.id())
        .ok()
}

/// Paired watchdog: ensures the daemon exists. Autostart launches THIS
/// subcommand — it spawns the daemon at login and revives it whenever the
/// socket is unreachable. Runs forever; cheap (one probe per 2s tick).
///
/// Liveness is a protocol PING/PONG, not a bare connect (red-team #7): a
/// squatter that bound the socket name and accepts-but-never-answers also
/// fails the probe, so the watchdog respawns — the respawned daemon then
/// exits AddrInUse while the squatter holds the name and binds cleanly the
/// moment the squatter dies.
fn run_watchdog(socket: &str, data_dir: Option<PathBuf>) -> ! {
    loop {
        if daemon::probe_ping(socket, PROBE_LEG_TIMEOUT).is_none() {
            let _ = spawn_background_child("run", socket, data_dir.as_deref());
        }
        std::thread::sleep(WATCHDOG_TICK);
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    // Peel off only declared positionals; all remaining words retain the
    // existing run/install flag parsing. Offline commands never use `socket`.
    let partner_action = if command == "partner" {
        args.next()
    } else {
        None
    };
    let positional_count = match command.as_str() {
        "block" | "lock" => 1,
        "partner-sign" => 3,
        "partner" if matches!(partner_action.as_deref(), Some("add-key" | "redeem")) => 1,
        _ => 0,
    };
    let positionals: Vec<String> = args.by_ref().take(positional_count).collect();
    let operand = positionals.first().cloned();

    let mut socket = DEFAULT_SOCKET_NAME.to_string();
    let mut data_dir: Option<PathBuf> = None;
    let mut extra_browsers: Vec<String> = Vec::new();
    let mut host_path: Option<PathBuf> = None;
    let mut dry_run_kills = false;
    let mut with_watchdog = false;
    while let Some(flag) = args.next() {
        let mut value = |name: &str| {
            args.next()
                .unwrap_or_else(|| panic!("{name} needs a value"))
        };
        match flag.as_str() {
            "--socket" => socket = value("--socket"),
            "--data-dir" => data_dir = Some(PathBuf::from(value("--data-dir"))),
            "--extra-browser" => extra_browsers.push(value("--extra-browser")),
            "--host-path" => host_path = Some(PathBuf::from(value("--host-path"))),
            "--dry-run-kills" => dry_run_kills = true,
            "--watchdog" => with_watchdog = true,
            other => {
                eprintln!("unknown flag: {other}");
                return ExitCode::FAILURE;
            }
        }
    }

    match command.as_str() {
        "run" => {
            // Kill-immunity starts here: own pid is always in the recorded
            // set; the process scan each enforcing tick adopts the watchdog
            // + nm-host relays running from our install dir.
            enforcer::record_protected_pid(std::process::id());
            let no_watchdog = std::env::var_os("SMARTBLOCKER_NO_WATCHDOG").is_some();
            // Supervisor linkage (mutual respawn): `--watchdog` spawns the
            // paired watchdog; when WE were spawned by a watchdog it passed
            // its pid via env. Either way, keep the supervisor alive. Plain
            // `run` (tests/e2e) keeps its old bare process tree.
            let supervisor_pid = if no_watchdog {
                None
            } else {
                let spawned = with_watchdog
                    .then(|| spawn_background_child("watchdog", &socket, data_dir.as_deref()))
                    .flatten();
                spawned.or_else(supervisor::watchdog_pid_from_env)
            };
            let data = data_dir.clone();
            let store = store_from(data_dir);
            let events_dir = store.dir().to_path_buf();
            if let Some(pid) = supervisor_pid {
                enforcer::record_protected_pid(pid);
                let sock = socket.clone();
                std::thread::spawn(move || {
                    supervisor::supervise_forever(
                        pid,
                        WATCHDOG_TICK,
                        move || spawn_background_child("watchdog", &sock, data.as_deref()),
                        events_dir,
                    );
                });
            }
            let opts = DaemonOptions {
                socket_name: socket,
                store,
                extra_incompatible: extra_browsers,
                notifier: Box::new(LogNotifier),
                dry_run_kills,
            };
            eprintln!("[smartblocker-daemon] listening on '{}'", opts.socket_name);
            match run_daemon(opts) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("[smartblocker-daemon] {e} (another instance running?)");
                    ExitCode::FAILURE
                }
            }
        }
        "watchdog" => run_watchdog(&socket, data_dir),
        "install" => {
            // Default layout: nm-host sits next to this binary.
            let me = std::env::current_exe().expect("current_exe");
            let host = host_path.unwrap_or_else(|| {
                me.parent().unwrap().join(if cfg!(windows) {
                    "smartblocker-nm-host.exe"
                } else {
                    "smartblocker-nm-host"
                })
            });
            if !host.is_file() {
                eprintln!("nm-host binary not found at {}", host.display());
                return ExitCode::FAILURE;
            }
            #[cfg(windows)]
            {
                let manifest_dir = me.parent().expect("exe dir").to_path_buf();
                if let Err(e) = registration::windows::install(&manifest_dir, &host) {
                    eprintln!("failed to register native messaging hosts: {e}");
                    return ExitCode::FAILURE;
                }
                if let Err(e) = registration::windows::install_autostart(&me) {
                    eprintln!("failed to register autostart: {e}");
                    return ExitCode::FAILURE;
                }
                println!("registered native messaging hosts + autostart");
            }
            #[cfg(not(windows))]
            {
                let home = home_dir();
                let written =
                    registration::install_linux(&home, &host).expect("write NM manifests");
                for path in &written {
                    println!("wrote {}", path.display());
                }
                let autostart =
                    registration::install_autostart_linux(&home, &me).expect("write autostart");
                println!("wrote {}", autostart.display());
            }
            ExitCode::SUCCESS
        }
        "uninstall" => {
            // Uninstall guard: ANY active lock (timer/password/schedule
            // armed, not only a forced block) must survive even the user's
            // own uninstall attempt — #22: a plain countdown was escapable
            // by unregistering the daemon (clock-checked against persisted
            // state).
            let store = store_from(data_dir);
            if derive_lock_status(&store.load_lock_state(), now_ms()).settings_locked {
                eprintln!("error: a lock is active — uninstall is refused until it ends.");
                return ExitCode::FAILURE;
            }
            #[cfg(windows)]
            {
                if let Err(e) = registration::windows::uninstall() {
                    eprintln!("failed to remove registrations: {e}");
                    return ExitCode::FAILURE;
                }
                println!("removed native messaging registrations + autostart");
            }
            #[cfg(not(windows))]
            {
                let home = home_dir();
                for path in registration::uninstall_linux(&home) {
                    println!("removed {}", path.display());
                }
                if registration::uninstall_autostart_linux(&home) {
                    println!("removed autostart entry");
                }
            }
            ExitCode::SUCCESS
        }
        "block" => {
            let action = match operand.as_deref() {
                Some("start") => BlockAction::Start,
                Some("stop") => BlockAction::Stop,
                Some("toggle") => BlockAction::Toggle,
                _ => {
                    eprintln!(
                        "usage: smartblocker-daemon block <start|stop|toggle> [--socket NAME]"
                    );
                    return ExitCode::FAILURE;
                }
            };
            print_command_result(daemon::send_command(
                &socket,
                &CompanionMessage::BlockCommand {
                    v: PROTOCOL_VERSION,
                    action,
                },
                COMMAND_LEG_TIMEOUT,
            ))
        }
        "lock" => {
            let Some(minutes) = operand
                .as_deref()
                .and_then(|value| value.parse::<u64>().ok())
            else {
                eprintln!("error: lock needs a positive whole number of minutes");
                return ExitCode::FAILURE;
            };
            let Some(duration_ms) = minutes.checked_mul(60_000).filter(|_| minutes > 0) else {
                eprintln!("error: lock needs a positive whole number of minutes");
                return ExitCode::FAILURE;
            };
            print_command_result(daemon::send_command(
                &socket,
                &CompanionMessage::LockCommand {
                    v: PROTOCOL_VERSION,
                    duration_ms,
                },
                COMMAND_LEG_TIMEOUT,
            ))
        }
        "partner" => {
            let command = match (partner_action.as_deref(), operand) {
                (Some("add-key"), Some(public_key)) => CompanionMessage::PartnerAddKey {
                    v: PROTOCOL_VERSION,
                    public_key,
                },
                (Some("arm"), None) => CompanionMessage::PartnerArm {
                    v: PROTOCOL_VERSION,
                },
                (Some("begin"), None) => CompanionMessage::PartnerBeginOperation {
                    v: PROTOCOL_VERSION,
                },
                (Some("redeem"), Some(token)) => CompanionMessage::PartnerRedeem {
                    v: PROTOCOL_VERSION,
                    token,
                },
                _ => {
                    eprintln!(
                        "usage: smartblocker-daemon partner <add-key HEX|arm|begin|redeem TOKEN> [--socket NAME]"
                    );
                    return ExitCode::FAILURE;
                }
            };
            print_command_result(daemon::send_command(&socket, &command, COMMAND_LEG_TIMEOUT))
        }
        "partner-keygen" => match generate_signing_material() {
            Ok((private_key, public_key)) => {
                // Explicit one-time CLI output only. The secret is never sent
                // to the daemon, persisted by core, or included in event logs.
                println!("PRIVATE_KEY_HEX={private_key}");
                println!("PUBLIC_KEY_HEX={public_key}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("error: partner key generation failed: {error}");
                ExitCode::FAILURE
            }
        },
        "partner-sign" => {
            let [operation_json, expires, private_key] = positionals.as_slice() else {
                eprintln!(
                    "usage: smartblocker-daemon partner-sign OPERATION_JSON EXPIRES_MS PRIVATE_KEY_HEX"
                );
                return ExitCode::FAILURE;
            };
            let expires_at_ms = match expires.parse::<i64>() {
                Ok(value) => value,
                Err(_) => {
                    eprintln!("error: EXPIRES_MS must be a whole epoch-millisecond number");
                    return ExitCode::FAILURE;
                }
            };
            match daemon::sign_partner_operation_offline(operation_json, expires_at_ms, private_key)
            {
                Ok(token) => {
                    println!("{token}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("error: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        "status" => {
            print!("{}", describe_status(&store_from(data_dir)));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: smartblocker-daemon <run|watchdog|install|uninstall|status|block|lock|partner|partner-keygen|partner-sign> [flags]");
            ExitCode::FAILURE
        }
    }
}
