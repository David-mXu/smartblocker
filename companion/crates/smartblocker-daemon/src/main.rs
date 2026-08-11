//! Headless companion daemon + installer CLI. The Tauri shell (M7) embeds
//! the same `smartblocker_core::daemon`; this binary is the Linux/e2e face.
//!
//!   smartblocker-daemon run [--socket NAME] [--data-dir PATH]
//!                        [--extra-browser NAME]... [--dry-run-kills]
//!   smartblocker-daemon install [--host-path PATH]   # NM manifests + autostart
//!   smartblocker-daemon uninstall
//!   smartblocker-daemon status

use std::path::PathBuf;
use std::process::ExitCode;

use smartblocker_core::daemon::{describe_status, run_daemon, DaemonOptions, LogNotifier};
use smartblocker_core::ipc::DEFAULT_SOCKET_NAME;
use smartblocker_core::registration;
use smartblocker_core::store::Store;

fn store_from(data_dir: Option<PathBuf>) -> Store {
    match data_dir {
        Some(dir) => Store::new(dir),
        None => Store::at_default_dir().expect("no resolvable home directory"),
    }
}

fn home_dir() -> PathBuf {
    // Intentionally $HOME-based (not `directories`): NM manifests belong to
    // the invoking user's profile even under sudo -E style invocations.
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();

    let mut socket = DEFAULT_SOCKET_NAME.to_string();
    let mut data_dir: Option<PathBuf> = None;
    let mut extra_browsers: Vec<String> = Vec::new();
    let mut host_path: Option<PathBuf> = None;
    let mut dry_run_kills = false;
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
            other => {
                eprintln!("unknown flag: {other}");
                return ExitCode::FAILURE;
            }
        }
    }

    match command.as_str() {
        "run" => {
            let opts = DaemonOptions {
                socket_name: socket,
                store: store_from(data_dir),
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
        "install" => {
            let home = home_dir();
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
            let written = registration::install_linux(&home, &host).expect("write NM manifests");
            for path in &written {
                println!("wrote {}", path.display());
            }
            let autostart =
                registration::install_autostart_linux(&home, &me).expect("write autostart");
            println!("wrote {}", autostart.display());
            ExitCode::SUCCESS
        }
        "uninstall" => {
            let home = home_dir();
            for path in registration::uninstall_linux(&home) {
                println!("removed {}", path.display());
            }
            if registration::uninstall_autostart_linux(&home) {
                println!("removed autostart entry");
            }
            ExitCode::SUCCESS
        }
        "status" => {
            print!("{}", describe_status(&store_from(data_dir)));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: smartblocker-daemon <run|install|uninstall|status> [flags]");
            ExitCode::FAILURE
        }
    }
}
