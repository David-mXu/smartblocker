//! The browser-facing half of the bridge. Browsers spawn one of these per
//! `connectNative` port and speak length-prefixed JSON over stdio; we relay
//! frames verbatim to the daemon over local IPC. Dies with its browser (the
//! browser closes stdin) — the daemon is the process that outlives everyone.
//!
//! When the daemon is unreachable we synthesize `companionStatus { running:
//! false }` so the extension can show "installed but not running", keep
//! draining stdin (a blocked pipe would wedge the browser side), and retry.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flowguard_core::framing::{read_frame, write_frame};
use flowguard_core::ipc::{self, traits::Stream as _};
use flowguard_core::lock_math::LockState;
use flowguard_core::protocol::{
    CompanionEnforcement, CompanionMessage, CompanionStatus, PROTOCOL_VERSION,
};

const RECONNECT_DELAY: Duration = Duration::from_secs(2);

fn socket_name() -> String {
    // Test hook: the e2e points relays at a scratch daemon.
    std::env::var("FLOWGUARD_SOCKET").unwrap_or_else(|_| ipc::DEFAULT_SOCKET_NAME.to_string())
}

fn unavailable_status() -> serde_json::Value {
    serde_json::to_value(CompanionMessage::CompanionStatus {
        v: PROTOCOL_VERSION,
        running: Some(false),
        status: CompanionStatus {
            companion_version: env!("CARGO_PKG_VERSION").to_string(),
            pro: false,
            enforcement: CompanionEnforcement {
                app_blocking: false,
                watchdog: false,
                policy_protected: false,
            },
            // EMPTY merges as a no-op on the extension side.
            lock_state: LockState::default(),
        },
    })
    .expect("protocol types serialize")
}

fn main() {
    let socket = socket_name();
    let stdout: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(io::stdout())));

    // Single stdin pump for the whole process lifetime: frames flow into a
    // channel; channel disconnect = browser closed the port = exit.
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        while let Ok(Some(frame)) = read_frame(&mut stdin) {
            if tx.send(frame).is_err() {
                return;
            }
        }
        // EOF / bad frame: dropping tx disconnects the channel.
    });

    let mut announced_down = false;
    // The browser sends hello exactly once per port, but the daemon may
    // restart mid-port; replaying the cached hello on every (re)connect is
    // what restores the daemon's browser registry (otherwise the watchdog
    // sees an anonymous connection and suspects the browser).
    let mut hello: Option<serde_json::Value> = None;
    loop {
        match ipc::connect(&socket) {
            Ok(stream) => {
                announced_down = false;
                relay(stream, &rx, &stdout, &mut hello);
                // IPC dropped (daemon restart) — fall through to reconnect.
            }
            Err(_) => {
                if !announced_down {
                    announced_down = true;
                    let _ = write_frame(&mut *stdout.lock().unwrap(), &unavailable_status());
                }
                // Keep draining the browser while down; exit on port close.
                match rx.recv_timeout(RECONNECT_DELAY) {
                    Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    }
}

/// Pump frames both ways until either side drops. Returns to trigger an IPC
/// reconnect; exits the process when the browser side is gone.
fn relay(
    stream: ipc::Stream,
    rx: &mpsc::Receiver<serde_json::Value>,
    stdout: &Arc<Mutex<Box<dyn Write + Send>>>,
    hello: &mut Option<serde_json::Value>,
) {
    let (recv, mut send) = stream.split();
    let alive = Arc::new(AtomicBool::new(true));

    if let Some(cached) = hello.as_ref() {
        if write_frame(&mut send, cached).is_err() {
            return;
        }
    }

    // daemon -> browser
    let pump = {
        let stdout = Arc::clone(stdout);
        let alive = Arc::clone(&alive);
        std::thread::spawn(move || {
            let mut recv = recv;
            // Ends on clean EOF or a bad frame (daemon restart).
            while let Ok(Some(frame)) = read_frame(&mut recv) {
                if write_frame(&mut *stdout.lock().unwrap(), &frame).is_err() {
                    std::process::exit(0); // browser gone
                }
            }
            alive.store(false, Ordering::SeqCst);
        })
    };

    // browser -> daemon
    while alive.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                if frame.get("type").and_then(|t| t.as_str()) == Some("hello") {
                    *hello = Some(frame.clone());
                }
                if write_frame(&mut send, &frame).is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::process::exit(0),
        }
    }
    drop(send); // unblocks the daemon's reader; pump ends on its own
    let _ = pump.join();
}
