//! Local IPC between the per-browser nm-host relays and the long-running
//! companion daemon. `GenericNamespaced` names on purpose: named pipes on
//! Windows and abstract-namespace sockets on Linux are reclaimed by the OS
//! when the process dies, so binding doubles as the single-instance lock
//! with no stale-socket-file cleanup, and `AddrInUse` reliably means "a live
//! daemon already owns this name". Frames reuse the NM codec (`framing`).

use std::io;

use interprocess::local_socket::traits::Stream as _;
#[cfg(target_os = "linux")]
use interprocess::local_socket::traits::StreamCommon as _;
use interprocess::local_socket::{GenericNamespaced, ListenerOptions, ToNsName};
// Re-exported so the bins never need interprocess as a direct dependency.
// `traits` carries accept()/incoming()/split() — import `traits::{Listener
// as _, Stream as _}` wherever those are called. The split halves are named
// by the daemon's per-connection reader/writer threads.
pub use interprocess::local_socket::{traits, Listener, RecvHalf, SendHalf, Stream};

/// Production socket name; tests and the e2e pass a unique one instead.
pub const DEFAULT_SOCKET_NAME: &str = "smartblocker-companion";

/// Bind the daemon's listener. `AddrInUse` = another daemon instance is live.
pub fn listen(name: &str) -> io::Result<Listener> {
    let ns = name.to_ns_name::<GenericNamespaced>()?;
    ListenerOptions::new().name(ns).create_sync()
}

pub fn connect(name: &str) -> io::Result<Stream> {
    let ns = name.to_ns_name::<GenericNamespaced>()?;
    Stream::connect(ns)
}

/// Our own effective uid, read from `/proc/self/status` (the `Uid:` line
/// carries real/effective/saved/fs uids — field 2 is the effective one, the
/// same notion `SO_PEERCRED` reports about a peer). Linux-only, like the
/// gate below: on this OS an abstract-namespace socket has no filesystem
/// permission layer, so without a uid check ANY local user could connect
/// (red-team #20, cross-user DoS/harassment). Parsing /proc keeps this
/// std-only — no libc dependency needed for the check.
#[cfg(target_os = "linux")]
pub fn own_euid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("Uid:"))?;
    line.split_whitespace().nth(2)?.parse().ok()
}

/// The connecting peer's effective uid (kernel-authenticated `SO_PEERCRED`
/// via `interprocess::local_socket::traits::StreamCommon::peer_creds`), or
/// None when the platform reports no euid.
#[cfg(target_os = "linux")]
pub fn peer_euid(stream: &Stream) -> Option<u32> {
    stream.peer_creds().ok()?.euid()
}

/// Same-uid admission gate for accepted connections (red-team #20). Fails
/// CLOSED only when BOTH uids are known and differ; when credentials are
/// unavailable (can't happen for a Linux stream socket in practice — the
/// kernel always answers SO_PEERCRED) the connection is admitted and the
/// pairing layer remains the trust boundary, same as before this gate.
#[cfg(target_os = "linux")]
pub fn same_user_peer(stream: &Stream, own_uid: Option<u32>) -> bool {
    let (Some(own), Some(peer)) = (own_uid, peer_euid(stream)) else {
        return true;
    };
    peer == own
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::{read_frame, write_frame};
    use interprocess::local_socket::traits::Listener as _;
    use serde_json::json;

    fn unique_name(tag: &str) -> String {
        format!("smartblocker-test-{tag}-{}", std::process::id())
    }

    #[test]
    fn roundtrips_a_frame_and_enforces_single_instance() {
        let name = unique_name("ipc");
        let listener = listen(&name).unwrap();

        // Second bind on the same name must fail while the first lives.
        assert!(listen(&name).is_err());

        let handle = std::thread::spawn({
            let name = name.clone();
            move || {
                let mut client = connect(&name).unwrap();
                write_frame(&mut client, &json!({ "ping": 1 })).unwrap();
                read_frame(&mut client).unwrap().unwrap()
            }
        });

        let mut server = listener.accept().unwrap();
        let got = read_frame(&mut server).unwrap().unwrap();
        assert_eq!(got, json!({ "ping": 1 }));
        write_frame(&mut server, &json!({ "pong": 2 })).unwrap();

        assert_eq!(handle.join().unwrap(), json!({ "pong": 2 }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn same_uid_peers_pass_the_admission_gate() {
        // Self-connection: kernel reports the SAME euid for both ends, so
        // the gate admits. (A cross-uid peer can only be manufactured with
        // setuid binaries — out of scope for a unit test; the mismatch arm
        // is `peer == own`, trivially false for differing u32s.)
        let name = unique_name("peercred");
        let listener = listen(&name).unwrap();
        let own = own_euid().expect("proc/self/status parses on Linux");
        let client = connect(&name).unwrap();
        std::thread::spawn(move || drop(client));
        let server = listener.accept().unwrap();
        assert!(same_user_peer(&server, Some(own)));
        // Unknown-own-uid (unmeasurable gate) admits, per the documented
        // fallback; a definitive mismatch would refuse.
        assert!(same_user_peer(&server, None));
    }
}
