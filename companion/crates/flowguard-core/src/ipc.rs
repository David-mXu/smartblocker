//! Local IPC between the per-browser nm-host relays and the long-running
//! companion daemon. `GenericNamespaced` names on purpose: named pipes on
//! Windows and abstract-namespace sockets on Linux are reclaimed by the OS
//! when the process dies, so binding doubles as the single-instance lock
//! with no stale-socket-file cleanup, and `AddrInUse` reliably means "a live
//! daemon already owns this name". Frames reuse the NM codec (`framing`).

use std::io;

use interprocess::local_socket::traits::Stream as _;
use interprocess::local_socket::{GenericNamespaced, ListenerOptions, ToNsName};
// Re-exported so the bins never need interprocess as a direct dependency.
// `traits` carries accept()/incoming()/split() — import `traits::{Listener
// as _, Stream as _}` wherever those are called.
pub use interprocess::local_socket::{traits, Listener, Stream};

/// Production socket name; tests and the e2e pass a unique one instead.
pub const DEFAULT_SOCKET_NAME: &str = "flowguard-companion";

/// Bind the daemon's listener. `AddrInUse` = another daemon instance is live.
pub fn listen(name: &str) -> io::Result<Listener> {
    let ns = name.to_ns_name::<GenericNamespaced>()?;
    ListenerOptions::new().name(ns).create_sync()
}

pub fn connect(name: &str) -> io::Result<Stream> {
    let ns = name.to_ns_name::<GenericNamespaced>()?;
    Stream::connect(ns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::{read_frame, write_frame};
    use interprocess::local_socket::traits::Listener as _;
    use serde_json::json;

    fn unique_name(tag: &str) -> String {
        format!("flowguard-test-{tag}-{}", std::process::id())
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
}
