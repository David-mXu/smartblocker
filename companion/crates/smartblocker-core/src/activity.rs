//! Recent-activity feed for the desktop UI: a bounded TAIL read of the
//! daemon's append-only `events.log` (`<wall_ms> <kind> <detail>` lines).
//! The log grows forever, so the reader never loads more than
//! [`TAIL_BYTES`]; a line cut by the window start is dropped, and malformed
//! lines are skipped rather than failing the feed.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};

use crate::store::Store;

/// The daemon's event log in the data dir (written by `daemon::log_event`).
pub const EVENTS_FILE: &str = "events.log";

/// Upper bound on bytes read per call.
pub const TAIL_BYTES: u64 = 64 * 1024;

/// Hard cap on `limit` (the tail window holds far fewer lines anyway).
pub const MAX_EVENTS: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub ts_ms: i64,
    /// Raw daemon kind (`kill`, `pair`, `daemon-start`, `license`, …).
    pub kind: String,
    /// Raw detail text; may be empty.
    pub detail: String,
}

/// Parse one `<ms> <kind> <detail>` line. `None` for anything else.
pub fn parse_event_line(line: &str) -> Option<ActivityEvent> {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut parts = line.splitn(3, ' ');
    let ts = parts.next()?;
    if ts.is_empty() || !ts.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ts_ms: i64 = ts.parse().ok()?;
    let kind = parts.next()?;
    if kind.is_empty() {
        return None;
    }
    Some(ActivityEvent {
        ts_ms,
        kind: kind.to_string(),
        detail: parts.next().unwrap_or("").trim_end().to_string(),
    })
}

/// Up to `limit` newest events, newest first. Missing log = empty feed.
pub fn read_recent_events(store: &Store, limit: usize) -> Vec<ActivityEvent> {
    let limit = limit.min(MAX_EVENTS);
    if limit == 0 {
        return Vec::new();
    }
    let Ok(text) = read_tail(&store.dir().join(EVENTS_FILE)) else {
        return Vec::new();
    };
    text.lines()
        .rev()
        .filter_map(parse_event_line)
        .take(limit)
        .collect()
}

/// The last ≤ `TAIL_BYTES` of the file as lossy UTF-8, starting at a line
/// boundary (the partial first line is discarded when we seeked mid-file).
fn read_tail(path: &std::path::Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(TAIL_BYTES).read_to_end(&mut buf)?;
    let mut slice = &buf[..];
    if start > 0 {
        match slice.iter().position(|&b| b == b'\n') {
            Some(nl) => slice = &slice[nl + 1..],
            None => slice = &[],
        }
    }
    Ok(String::from_utf8_lossy(slice).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn store_with_log(contents: &[u8]) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(EVENTS_FILE), contents).unwrap();
        let store = Store::new(dir.path());
        (dir, store)
    }

    #[test]
    fn parses_daemon_lines() {
        assert_eq!(
            parse_event_line("1720000000000 kill steam pid 42 (BlockedApp)"),
            Some(ActivityEvent {
                ts_ms: 1_720_000_000_000,
                kind: "kill".into(),
                detail: "steam pid 42 (BlockedApp)".into(),
            })
        );
        // `log_event` with an empty detail leaves a trailing space.
        assert_eq!(
            parse_event_line("5 daemon-start \r"),
            Some(ActivityEvent {
                ts_ms: 5,
                kind: "daemon-start".into(),
                detail: String::new(),
            })
        );
        assert_eq!(parse_event_line("7 pair").unwrap().detail, "");
        for bad in [
            "",
            "kill steam",
            "-5 kill x",
            "12a kill x",
            " 5 kill",
            "5  x",
            "5",
        ] {
            assert!(parse_event_line(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn newest_first_limited_and_skips_garbage() {
        let (_d, store) = store_with_log(
            b"1 daemon-start socket x\ngarbage line\n2 pair adopted\n\n3 kill steam pid 9 (BlockedApp)\n",
        );
        let all = read_recent_events(&store, 10);
        assert_eq!(
            all.iter().map(|e| e.ts_ms).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        let two = read_recent_events(&store, 2);
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].kind, "kill");
        assert!(read_recent_events(&store, 0).is_empty());
    }

    #[test]
    fn missing_log_is_an_empty_feed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_recent_events(&Store::new(dir.path()), 50).is_empty());
    }

    #[test]
    fn tail_read_is_bounded_and_drops_the_cut_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(EVENTS_FILE);
        let mut f = File::create(&path).unwrap();
        // ~200 KiB of history: far more than the tail window.
        let mut n = 0i64;
        let mut written = 0u64;
        while written < 200 * 1024 {
            let line = format!("{n} notify filler event number {n} padding padding\n");
            f.write_all(line.as_bytes()).unwrap();
            written += line.len() as u64;
            n += 1;
        }
        drop(f);
        let store = Store::new(dir.path());
        let events = read_recent_events(&store, MAX_EVENTS);
        assert_eq!(events[0].ts_ms, n - 1, "newest line first");
        // Only lines inside the 64 KiB window, every one intact.
        let bytes: usize = events
            .iter()
            .map(|e| format!("{} {} {}\n", e.ts_ms, e.kind, e.detail).len())
            .sum();
        assert!(bytes as u64 <= TAIL_BYTES);
        for e in &events {
            assert_eq!(
                e.detail,
                format!("filler event number {} padding padding", e.ts_ms)
            );
        }
        // Contiguous run ending at the newest line.
        let oldest = events.last().unwrap().ts_ms;
        assert_eq!(events.len() as i64, n - oldest);
    }

    #[test]
    fn invalid_utf8_is_tolerated() {
        let (_d, store) = store_with_log(b"1 notify caf\xff\n2 pair ok\n");
        let events = read_recent_events(&store, 10);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].detail, "caf\u{fffd}");
    }
}
