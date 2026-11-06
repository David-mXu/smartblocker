//! SmartBlocker Companion — thin Tauri shell over `smartblocker_core::daemon`.
//! All enforcement logic lives in the core crate (Linux-tested); this file
//! only wires the tray, the window, notifications, and five commands.
//!
//! Lock mutations go over the same local IPC the browser relays use
//! (`lockStateSync` frames, no `hello`): the daemon merges + persists +
//! broadcasts, and — crucially — a UI client that never hellos is invisible
//! to the watchdog, so it can't mask a disabled extension.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use smartblocker_core::daemon::{spawn_daemon, DaemonOptions, Notifier};
use smartblocker_core::framing::write_frame;
use smartblocker_core::ipc::{self, traits::Stream as _, DEFAULT_SOCKET_NAME};
use smartblocker_core::lock_math::{derive_lock_status, LockState, MAX_LOCK_MS};
use smartblocker_core::protocol::PROTOCOL_VERSION;
use smartblocker_core::store::Store;
use smartblocker_core::{license, registration};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store() -> Result<Store, String> {
    Store::at_default_dir().ok_or_else(|| "no resolvable data directory".into())
}

fn force_blocking_now() -> bool {
    Store::at_default_dir()
        .map(|s| derive_lock_status(&s.load_lock_state(), now_ms()).force_blocking)
        .unwrap_or(false)
}

/// Send one lockStateSync frame to the embedded daemon over IPC. Merge-only
/// on the daemon side, so this can extend locks but never shorten them.
fn push_lock_state(state: &LockState) -> Result<(), String> {
    let mut stream = ipc::connect(DEFAULT_SOCKET_NAME)
        .map_err(|e| format!("companion daemon unreachable: {e}"))?;
    let frame = json!({ "v": PROTOCOL_VERSION, "type": "lockStateSync", "lockState": state });
    write_frame(&mut stream, &frame).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_status() -> Result<serde_json::Value, String> {
    let store = store()?;
    let lock_state = store.load_lock_state();
    let config = store.load_config();
    let policy_protected = config.policy_enforce && config.extension_update_url.is_some();
    Ok(json!({
        "lockState": lock_state,
        "status": derive_lock_status(&lock_state, now_ms()),
        "appBlocklist": config.app_blocklist,
        "pro": license::is_pro(&config),
        "policyEnforce": config.policy_enforce,
        "daemonRunning": ipc::connect(DEFAULT_SOCKET_NAME).is_ok(),
        "enforcement": {
            "appBlocking": true,
            "watchdog": true,
            "policyProtected": policy_protected,
        },
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[tauri::command]
fn start_timer_lock(minutes: u64) -> Result<(), String> {
    let until = now_ms() + (minutes as i64 * 60_000).min(MAX_LOCK_MS);
    push_lock_state(&LockState {
        timer_until: Some(until),
        ..LockState::default()
    })
}

#[tauri::command]
fn start_frozen_turkey(minutes: u64) -> Result<(), String> {
    let until = now_ms() + (minutes as i64 * 60_000).min(MAX_LOCK_MS);
    push_lock_state(&LockState {
        frozen_until: Some(until),
        ..LockState::default()
    })
}

#[tauri::command]
fn set_app_blocklist(apps: Vec<String>) -> Result<(), String> {
    let store = store()?;
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
    store.save_config(&config).map_err(|e| e.to_string())
}

#[tauri::command]
fn install_integration(app: tauri::AppHandle) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("no exe dir")?.to_path_buf();
    let nm_host = exe_dir.join(if cfg!(windows) {
        "smartblocker-nm-host.exe"
    } else {
        "smartblocker-nm-host"
    });
    if !nm_host.is_file() {
        return Err(format!(
            "smartblocker-nm-host not found next to the app ({})",
            nm_host.display()
        ));
    }

    #[cfg(windows)]
    registration::windows::install(&exe_dir, &nm_host).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let home = std::path::PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
        registration::install_linux(&home, &nm_host).map_err(|e| e.to_string())?;
    }

    let _ = app.autolaunch().enable();
    Ok("Native messaging registered for Chrome, Edge and Firefox; autostart enabled.".into())
}

struct TauriNotifier(tauri::AppHandle);

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_timer_lock,
            start_frozen_turkey,
            set_app_blocklist,
            install_integration
        ])
        .setup(|app| {
            // The embedded daemon IS the companion: same core, same socket
            // the nm-host relays dial. Single-instance via the IPC bind —
            // but if a daemon is ALREADY live on the socket (e.g. the
            // autostarted headless one), attach to it instead of spawning a
            // loser that immediately dies on AddrInUse.
            if ipc::connect(DEFAULT_SOCKET_NAME).is_err() {
                spawn_daemon(DaemonOptions {
                    socket_name: DEFAULT_SOCKET_NAME.to_string(),
                    store: Store::at_default_dir().expect("data dir"),
                    extra_incompatible: vec![],
                    notifier: Box::new(TauriNotifier(app.handle().clone())),
                    dry_run_kills: false,
                });
            }

            let show = MenuItem::with_id(app, "show", "Open SmartBlocker", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("smartblocker-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("SmartBlocker Companion")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        // The quit-guard: while a forced block runs, the
                        // companion refuses to die politely. (Task-manager
                        // kills still win — documented, soft-by-design.)
                        if force_blocking_now() {
                            let _ = app
                                .notification()
                                .builder()
                                .title("SmartBlocker")
                                .body("A locked block is active — the companion can't quit until it ends.")
                                .show();
                        } else {
                            app.exit(0);
                        }
                    }
                    _ => {}
                })
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
