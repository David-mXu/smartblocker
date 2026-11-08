//! SmartBlocker Companion — thin Tauri shell over `smartblocker_core`. All
//! enforcement and desktop-UI logic lives in the core crate (Linux-tested);
//! this file only wires the tray, the window, notifications, and the command
//! contract in `src/desktop/api.ts`.
//!
//! Lock mutations go over the same local IPC the browser relays use
//! (`lockStateSync` frames, no `hello`): the daemon merges + persists +
//! broadcasts, and — crucially — a UI client that never hellos is invisible
//! to the watchdog, so it can't mask a disabled extension.
//!
//! **Test mode** exists only in debug builds with `SMARTBLOCKER_TEST_MODE=1`
//! (see [`test_mode_data_dir`]): separate data dir and socket, kills logged
//! instead of executed, no toasts, and no registry, policy or autostart
//! writes. The rest of the app runs exactly as shipped.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use smartblocker_core::activity::{self, ActivityEvent};
use smartblocker_core::apps::{self, RunningApp};
use smartblocker_core::daemon::{run_daemon, DaemonOptions, LogNotifier, Notifier};
use smartblocker_core::focus_session::{self, PendingSession};
use smartblocker_core::framing::write_frame;
use smartblocker_core::ipc::{self, DEFAULT_SOCKET_NAME};
use smartblocker_core::license::{self, LicenseInfo};
use smartblocker_core::lock_math::{
    current_window_end, derive_lock_status, LockReason, LockState, MAX_LOCK_MS,
};
use smartblocker_core::protocol::PROTOCOL_VERSION;
use smartblocker_core::snapshot::{self, BrowserInfo};
use smartblocker_core::store::Store;

use smartblocker_core::registration;

const NOT_RUNNING: &str = "The companion isn't running. Start it, then try again.";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Everything that differs between a normal run and test mode. Resolved once
/// at startup, so the shell and its embedded daemon can't disagree about
/// which store or socket they use.
struct AppCtx {
    test_mode: bool,
    socket_name: String,
    data_dir: PathBuf,
    /// A shell-owned daemon thread exists (or is binding). Cleared when the
    /// thread gives up, so `start_companion` can retry a lost bind.
    embedded_daemon: Arc<AtomicBool>,
}

impl AppCtx {
    fn resolve() -> Self {
        let embedded_daemon = Arc::new(AtomicBool::new(false));
        if let Some(data_dir) = test_mode_data_dir() {
            return Self {
                test_mode: true,
                socket_name: "smartblocker-test".into(),
                data_dir,
                embedded_daemon,
            };
        }
        // Deliberately not `from_env_or_default`: an environment variable
        // must not be able to point a real install at an empty lock store.
        let store = Store::at_default_dir().expect("no resolvable data directory");
        Self {
            test_mode: false,
            socket_name: DEFAULT_SOCKET_NAME.into(),
            data_dir: store.dir().to_path_buf(),
            embedded_daemon,
        }
    }

    fn store(&self) -> Store {
        Store::new(&self.data_dir)
    }
}

/// The scratch data dir when test mode is on, else `None`. Compiled to a
/// constant `None` in release builds: a shipped binary has no way in, even
/// with the environment variable set.
#[cfg(debug_assertions)]
fn test_mode_data_dir() -> Option<PathBuf> {
    if std::env::var("SMARTBLOCKER_TEST_MODE").as_deref() != Ok("1") {
        return None;
    }
    let dir = std::env::var_os(smartblocker_core::store::DATA_DIR_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("smartblocker-test"));
    // A mistyped override must not turn a test run loose on the real store.
    if let Some(real) = Store::at_default_dir() {
        let canon = |p: &std::path::Path| {
            std::fs::canonicalize(p)
                .unwrap_or_else(|_| p.to_path_buf())
                .to_string_lossy()
                .to_lowercase()
        };
        assert!(
            canon(real.dir()) != canon(&dir),
            "test mode refuses to use the real data directory"
        );
    }
    std::fs::create_dir_all(&dir).expect("create test-mode data dir");
    Some(dir)
}

#[cfg(not(debug_assertions))]
fn test_mode_data_dir() -> Option<PathBuf> {
    None
}

/// A desktop toast, or a log line in test mode ("Edge will be closed" toasts
/// from a test instance would alarm the user).
fn toast(app: &AppHandle, ctx: &AppCtx, body: &str) {
    if ctx.test_mode {
        eprintln!("[test-mode toast suppressed] {body}");
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("SmartBlocker")
        .body(body)
        .show();
}

struct TauriNotifier(AppHandle);

impl Notifier for TauriNotifier {
    fn notify(&self, title: &str, body: &str) {
        let _ = self
            .0
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
}

/// Spawn the embedded daemon unless something already answers on the socket
/// (e.g. the autostarted headless one). Idempotent.
fn ensure_daemon(app: &AppHandle, ctx: &AppCtx) -> Result<(), String> {
    if ipc::connect(&ctx.socket_name).is_ok() {
        return Ok(());
    }
    if ctx.test_mode {
        force_test_mode_policy_off(&ctx.store())?;
    }
    if ctx.embedded_daemon.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let notifier: Box<dyn Notifier> = if ctx.test_mode {
        Box::new(LogNotifier)
    } else {
        Box::new(TauriNotifier(app.clone()))
    };
    let opts = DaemonOptions {
        socket_name: ctx.socket_name.clone(),
        store: ctx.store(),
        extra_incompatible: vec![],
        notifier,
        dry_run_kills: ctx.test_mode,
    };
    // `run_daemon` directly, not `spawn_daemon`: that helper latches
    // once-per-process, so a lost bind could never be retried. A return
    // means the bind failed before any enforcement thread started.
    let running = Arc::clone(&ctx.embedded_daemon);
    std::thread::spawn(move || {
        if let Err(e) = run_daemon(opts) {
            eprintln!("[daemon] exited: {e}");
        }
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// `run_daemon` applies managed-browser policies to the registry when the
/// config asks for it, so a test store must never ask.
fn force_test_mode_policy_off(store: &Store) -> Result<(), String> {
    let mut config = store.load_config();
    if config.policy_enforce || config.extension_update_url.is_some() {
        config.policy_enforce = false;
        config.extension_update_url = None;
        store.save_config(&config).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Send one lockStateSync frame to the embedded daemon over IPC. Merge-only
/// on the daemon side, so this can extend locks but never shorten them.
fn push_lock_state(ctx: &AppCtx, state: &LockState) -> Result<(), String> {
    let mut stream = ipc::connect(&ctx.socket_name).map_err(|_| NOT_RUNNING.to_string())?;
    let frame = json!({ "v": PROTOCOL_VERSION, "type": "lockStateSync", "lockState": state });
    write_frame(&mut stream, &frame)
        .map_err(|_| "Couldn't reach the companion. Try again.".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInfo {
    running: bool,
    pid: Option<u32>,
    started_at_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockInfo {
    settings_locked: bool,
    force_blocking: bool,
    reasons: Vec<LockReason>,
    until: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    version: &'static str,
    test_mode: bool,
    data_dir: String,
    daemon: DaemonInfo,
    lock: LockInfo,
    pending_session: Option<PendingSession>,
    browsers: Vec<BrowserInfo>,
    app_blocklist: Vec<String>,
    license: LicenseInfo,
    policy_protected: bool,
    autostart: bool,
}

fn lock_info(state: &LockState, now: i64) -> LockInfo {
    let status = derive_lock_status(state, now);
    // `status.until` means "when does every lock end", which is None whenever
    // a password is armed. The UI wants the latest timed end regardless.
    let until = [
        state.timer_until,
        state.frozen_until,
        current_window_end(&state.schedules, now),
    ]
    .into_iter()
    .flatten()
    .filter(|t| *t > now)
    .max();
    LockInfo {
        settings_locked: status.settings_locked,
        force_blocking: status.force_blocking,
        reasons: status.reasons,
        until,
    }
}

// Every command below is `async`, which moves it off the main thread: the
// process list and file reads would otherwise stall the window.

#[tauri::command(async)]
fn get_status(app: AppHandle, ctx: State<'_, AppCtx>) -> Result<DesktopStatus, String> {
    let store = ctx.store();
    let now = now_ms();
    let config = store.load_config();
    let live = snapshot::read_live_snapshot(&store, now);
    Ok(DesktopStatus {
        version: env!("CARGO_PKG_VERSION"),
        test_mode: ctx.test_mode,
        data_dir: store.dir().display().to_string(),
        daemon: DaemonInfo {
            running: live.is_some(),
            pid: live.as_ref().map(|s| s.pid),
            started_at_ms: live.as_ref().map(|s| s.started_at_ms),
        },
        lock: lock_info(&store.load_lock_state(), now),
        pending_session: focus_session::read_pending_session(&store),
        browsers: live.map(|s| s.browsers).unwrap_or_default(),
        license: license::license_info(&config, now),
        policy_protected: config.policy_enforce && config.extension_update_url.is_some(),
        app_blocklist: config.app_blocklist,
        autostart: !ctx.test_mode && app.autolaunch().is_enabled().unwrap_or(false),
    })
}

fn begin_focus_session(ctx: &AppCtx, minutes: u64) -> Result<PendingSession, String> {
    let store = ctx.store();
    let now = now_ms();
    if snapshot::read_live_snapshot(&store, now).is_none() {
        return Err(NOT_RUNNING.into());
    }
    focus_session::start_pending_session(&store, minutes, now).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn start_focus_session(ctx: State<'_, AppCtx>, minutes: u64) -> Result<PendingSession, String> {
    begin_focus_session(&ctx, minutes)
}

#[tauri::command(async)]
fn undo_focus_session(ctx: State<'_, AppCtx>) -> Result<bool, String> {
    Ok(focus_session::undo_pending_session(&ctx.store(), now_ms()))
}

#[tauri::command(async)]
fn start_timer_lock(ctx: State<'_, AppCtx>, minutes: u64) -> Result<(), String> {
    if minutes == 0 {
        return Err("Choose a duration of at least 1 minute.".into());
    }
    let duration = i64::try_from(minutes)
        .unwrap_or(i64::MAX)
        .saturating_mul(60_000)
        .min(MAX_LOCK_MS);
    push_lock_state(
        &ctx,
        &LockState {
            timer_until: Some(now_ms().saturating_add(duration)),
            ..LockState::default()
        },
    )
}

#[tauri::command(async)]
fn set_app_blocklist(ctx: State<'_, AppCtx>, apps: Vec<String>) -> Result<(), String> {
    let store = ctx.store();
    let mut config = store.load_config();
    let status = derive_lock_status(&store.load_lock_state(), now_ms());
    // Locked = strictening only: additions fine, removals refused (the
    // whole point of the lock is that weakening waits it out).
    if status.settings_locked {
        let kept_all = config
            .app_blocklist
            .iter()
            .all(|old| apps.iter().any(|new| new.eq_ignore_ascii_case(old)));
        if !kept_all {
            return Err("Locked: apps can be added but not removed until the lock ends.".into());
        }
    }
    config.app_blocklist = apps;
    store
        .save_config(&config)
        .map_err(|e| format!("Couldn't save your blocked apps: {e}"))
}

#[tauri::command(async)]
fn list_running_apps() -> Result<Vec<RunningApp>, String> {
    Ok(apps::list_running_apps())
}

#[tauri::command(async)]
fn get_recent_activity(ctx: State<'_, AppCtx>, limit: usize) -> Result<Vec<ActivityEvent>, String> {
    Ok(activity::read_recent_events(&ctx.store(), limit))
}

#[tauri::command(async)]
fn set_license_key(ctx: State<'_, AppCtx>, key: String) -> Result<LicenseInfo, String> {
    license::set_license_key(&ctx.store(), &key, now_ms())
}

#[tauri::command(async)]
fn start_companion(app: AppHandle, ctx: State<'_, AppCtx>) -> Result<(), String> {
    ensure_daemon(&app, &ctx)
}

#[tauri::command(async)]
fn install_integration(app: AppHandle, ctx: State<'_, AppCtx>) -> Result<String, String> {
    if ctx.test_mode {
        return Ok("Test mode: browser connection and startup settings were left alone.".into());
    }
    const FAILED: &str = "Couldn't repair the browser connection";
    let exe = std::env::current_exe().map_err(|e| format!("{FAILED}: {e}"))?;
    let exe_dir = exe.parent().ok_or(FAILED)?.to_path_buf();
    let nm_host = exe_dir.join(if cfg!(windows) {
        "smartblocker-nm-host.exe"
    } else {
        "smartblocker-nm-host"
    });
    if !nm_host.is_file() {
        return Err(format!(
            "{FAILED}: a required file is missing. Reinstall SmartBlocker."
        ));
    }

    #[cfg(windows)]
    registration::windows::install(&exe_dir, &nm_host).map_err(|e| format!("{FAILED}: {e}"))?;
    #[cfg(not(windows))]
    {
        let home = PathBuf::from(std::env::var("HOME").map_err(|e| format!("{FAILED}: {e}"))?);
        registration::install_linux(&home, &nm_host).map_err(|e| format!("{FAILED}: {e}"))?;
    }

    if app.autolaunch().enable().is_err() {
        return Ok("Browser connection repaired, but SmartBlocker couldn't set itself to start with your computer.".into());
    }
    Ok("Browser connection repaired for Chrome, Edge and Firefox. SmartBlocker will start with your computer.".into())
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    let ctx = app.state::<AppCtx>();
    match id {
        "show" => show_main_window(app),
        "focus" => match begin_focus_session(&ctx, 60) {
            // Opened on purpose: the undo countdown lives in the window.
            Ok(_) => {
                show_main_window(app);
                toast(
                    app,
                    &ctx,
                    "Focus session starts in 1 minute. Open SmartBlocker to undo.",
                );
            }
            Err(e) => toast(app, &ctx, &e),
        },
        "quit" => {
            // The quit-guard: while a forced block runs, the companion
            // refuses to die politely. (Task-manager kills still win —
            // documented, soft-by-design.)
            let locked =
                derive_lock_status(&ctx.store().load_lock_state(), now_ms()).force_blocking;
            if locked {
                toast(
                    app,
                    &ctx,
                    "A locked block is active — the companion can't quit until it ends.",
                );
            } else {
                app.exit(0);
            }
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppCtx::resolve())
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_focus_session,
            undo_focus_session,
            start_timer_lock,
            set_app_blocklist,
            list_running_apps,
            get_recent_activity,
            set_license_key,
            install_integration,
            start_companion
        ])
        .setup(|app| {
            // The embedded daemon IS the companion: same core, same socket
            // the nm-host relays dial. Single-instance via the IPC bind.
            let ctx = app.state::<AppCtx>();
            if let Err(e) = ensure_daemon(app.handle(), &ctx) {
                eprintln!("[shell] companion not started: {e}");
            }
            if ctx.test_mode {
                eprintln!(
                    "[shell] TEST MODE: data dir {}, socket {}, kills are dry runs",
                    ctx.data_dir.display(),
                    ctx.socket_name
                );
            }

            let show = MenuItem::with_id(app, "show", "Open SmartBlocker", true, None::<&str>)?;
            let focus = MenuItem::with_id(
                app,
                "focus",
                "Start 1-hour focus session",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &focus, &quit])?;
            TrayIconBuilder::with_id("smartblocker-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("SmartBlocker")
                .menu(&menu)
                .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray; actual exit only via the
            // tray Quit (which enforces the lock guard above).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SmartBlocker Companion");
}
