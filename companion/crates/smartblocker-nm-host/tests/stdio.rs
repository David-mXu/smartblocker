//! End-to-end over the real binary: spawn smartblocker-nm-host, speak genuine
//! browser-side NM framing on its stdio, with a live in-process daemon on a
//! scratch socket. This is the same wire path Chrome uses, minus Chrome.

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use smartblocker_core::daemon::{spawn_daemon, DaemonOptions, LogNotifier};
use smartblocker_core::framing::{read_frame, write_frame};
use smartblocker_core::store::Store;

fn unique(tag: &str) -> String {
    format!("smartblocker-stdio-test-{tag}-{}", std::process::id())
}

fn spawn_host(socket: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_smartblocker-nm-host"))
        .env("SMARTBLOCKER_SOCKET", socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn nm-host")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn relays_hello_and_lock_sync_to_a_live_daemon() {
    let socket = unique("live");
    let data_dir = tempfile::tempdir().unwrap();
    assert!(spawn_daemon(DaemonOptions {
        socket_name: socket.clone(),
        store: Store::new(data_dir.path()),
        extra_incompatible: vec![],
        notifier: Box::new(LogNotifier),
        dry_run_kills: true,
    }));
    // Give the listener a beat to bind before the relay dials it.
    std::thread::sleep(Duration::from_millis(200));

    let mut host = spawn_host(&socket);
    let mut stdin = host.stdin.take().unwrap();
    let mut stdout = host.stdout.take().unwrap();

    write_frame(
        &mut stdin,
        &json!({
            "v": 1, "type": "hello", "extVersion": "0.5.0",
            "browser": "chrome", "extensionId": "test-ext-id"
        }),
    )
    .unwrap();

    // Hello is answered with a live companionStatus.
    let reply = read_frame(&mut stdout).unwrap().expect("status frame");
    assert_eq!(reply["type"], "companionStatus");
    assert_eq!(reply["running"], json!(true));
    assert_eq!(reply["status"]["pro"], json!(true));
    assert_eq!(reply["status"]["enforcement"]["watchdog"], json!(true));

    // A frozen-turkey sync must land in the daemon's persisted state.
    let frozen_until = now_ms() + 60_000;
    write_frame(
        &mut stdin,
        &json!({
            "v": 1, "type": "lockStateSync",
            "lockState": {
                "timerUntil": null, "passwordHash": null,
                "frozenUntil": frozen_until, "schedules": [], "schedulesUpdatedAt": 0
            }
        }),
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let path = data_dir.path().join("lock-state.json");
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let state: Value = serde_json::from_str(&text).unwrap();
            if state["frozenUntil"] == json!(frozen_until) {
                break;
            }
        }
        assert!(Instant::now() < deadline, "lock state never persisted");
        std::thread::sleep(Duration::from_millis(50));
    }

    // Browser closes the port: relay must exit on its own.
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = host.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "nm-host did not exit on stdin close"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn synthesizes_not_running_status_when_daemon_is_down() {
    let socket = unique("down"); // nothing listens here
    let mut host = spawn_host(&socket);
    let stdin = host.stdin.take().unwrap();
    let mut stdout = host.stdout.take().unwrap();

    let frame = read_frame(&mut stdout)
        .unwrap()
        .expect("synthesized status");
    assert_eq!(frame["type"], "companionStatus");
    assert_eq!(frame["running"], json!(false));
    assert_eq!(frame["status"]["enforcement"]["watchdog"], json!(false));

    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if host.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "nm-host did not exit on stdin close"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
