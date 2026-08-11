//! Length-prefixed JSON frame codec: 4-byte u32 length + UTF-8 JSON body.
//! Used verbatim for BOTH browser Native Messaging stdio and the local
//! daemon<->nm-host IPC, so the relay can forward frames without re-encoding.
//!
//! Byte order: Chrome's NM length prefix is NATIVE byte order, not spec'd
//! little-endian. Every target we ship (x86_64, aarch64) is little-endian,
//! so this codec is fixed to LE — a big-endian port would need a swap here
//! AND in the browser-facing relay together.

use serde_json::Value;
use std::io::{self, ErrorKind, Read, Write};

/// Chrome's native->browser message ceiling; oversize frames are rejected
/// before the body allocation so a bad peer can't balloon memory.
pub const MAX_FRAME_BYTES: u32 = 1024 * 1024;

/// Read one frame. `Ok(None)` = clean EOF (peer closed between frames);
/// EOF mid-frame is an `UnexpectedEof` error. Malformed JSON and oversize
/// lengths are `InvalidData` — the caller decides whether to drop the peer.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Value>> {
    let mut len_buf = [0u8; 4];
    if !fill_or_clean_eof(r, &mut len_buf)? {
        return Ok(None);
    }
    let len = u32::from_le_bytes(len_buf);
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("frame length {len} exceeds {MAX_FRAME_BYTES}-byte limit"),
        ));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e))
}

/// `read_exact`, except a clean EOF before the FIRST byte returns false.
/// Handles partial delivery (short reads) and `Interrupted`.
fn fill_or_clean_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

pub fn write_frame<W: Write>(w: &mut W, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    if body.len() > MAX_FRAME_BYTES as usize {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "frame body of {} bytes exceeds {MAX_FRAME_BYTES}-byte limit",
                body.len()
            ),
        ));
    }
    w.write_all(&(body.len() as u32).to_le_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Delivers at most one byte per read — models pipe fragmentation.
    struct TrickleReader {
        data: Vec<u8>,
        pos: usize,
    }

    impl Read for TrickleReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.pos >= self.data.len() || buf.is_empty() {
                return Ok(0);
            }
            buf[0] = self.data[self.pos];
            self.pos += 1;
            Ok(1)
        }
    }

    #[test]
    fn roundtrip() {
        let msg = json!({ "type": "heartbeat", "v": 1, "now": 123456789 });
        let mut wire = Vec::new();
        write_frame(&mut wire, &msg).unwrap();
        write_frame(&mut wire, &json!(null)).unwrap();
        let mut cursor = io::Cursor::new(wire);
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(msg));
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(json!(null)));
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn split_delivery_reassembles() {
        let msg = json!({ "nested": { "list": [1, 2, 3] } });
        let mut wire = Vec::new();
        write_frame(&mut wire, &msg).unwrap();
        let mut r = TrickleReader { data: wire, pos: 0 };
        assert_eq!(read_frame(&mut r).unwrap(), Some(msg));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn oversize_frame_rejected_on_read() {
        let mut wire = Vec::from((MAX_FRAME_BYTES + 1).to_le_bytes());
        wire.extend_from_slice(b"{}");
        let mut cursor = io::Cursor::new(wire);
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn oversize_frame_rejected_on_write() {
        let big = json!("x".repeat(MAX_FRAME_BYTES as usize + 1));
        let err = write_frame(&mut Vec::new(), &big).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn clean_eof_vs_truncated_frame() {
        // Zero bytes = clean EOF.
        let mut empty = io::Cursor::new(Vec::new());
        assert_eq!(read_frame(&mut empty).unwrap(), None);
        // EOF inside the length header is an error.
        let mut partial_header = io::Cursor::new(vec![5u8, 0]);
        assert_eq!(
            read_frame(&mut partial_header).unwrap_err().kind(),
            ErrorKind::UnexpectedEof
        );
        // EOF inside the body is an error.
        let mut partial_body = Vec::from(10u32.to_le_bytes());
        partial_body.extend_from_slice(b"{}");
        let mut cursor = io::Cursor::new(partial_body);
        assert_eq!(
            read_frame(&mut cursor).unwrap_err().kind(),
            ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn malformed_json_is_invalid_data() {
        let mut wire = Vec::from(3u32.to_le_bytes());
        wire.extend_from_slice(b"{,}");
        let mut cursor = io::Cursor::new(wire);
        assert_eq!(
            read_frame(&mut cursor).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
    }
}
