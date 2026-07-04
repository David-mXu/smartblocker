//! Extension <-> companion wire protocol, mirroring
//! `src/shared/companion-protocol.ts` — change both together.
//!
//! Wire rules (same as the TS header):
//! - Every message carries `v` (PROTOCOL_VERSION). Unknown types are ignored,
//!   never a hard error — the framing layer decodes to `serde_json::Value`
//!   first and `parse_message` returns `None` for anything unrecognized.
//! - Lock state is synced by MERGING (`merge::merge_lock_states`); each side
//!   persists + re-broadcasts only when a merge CHANGED its state.
//! - Messages stay far below Chrome's 1MB native->browser limit
//!   (`framing::MAX_FRAME_BYTES`).

use crate::lock_math::LockState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Native messaging host name — must match the NM host manifest `name` and
/// the registry entries / manifest files written by the companion.
pub const NM_HOST_NAME: &str = "dev.davidxu.flowguard";

pub const PROTOCOL_VERSION: u32 = 1;

/// Heartbeat cadence while the port is open. The companion treats a gap of
/// ~2 misses (45s, `enforcer::HEARTBEAT_STALE_MS`) as "extension not
/// responding" during an active lock.
pub const HEARTBEAT_INTERVAL_MS: u64 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompanionBrowser {
    Chrome,
    Edge,
    Firefox,
}

/// Which hard enforcements the companion currently provides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionEnforcement {
    /// Blocklisted desktop apps are closed while a forced block is active.
    pub app_blocking: bool,
    /// Supported browsers running without a live extension get closed.
    pub watchdog: bool,
    /// Managed browser policy protects the extension from being disabled.
    /// Ships false until the extension has a store listing (needs update_url).
    pub policy_protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub companion_version: String,
    /// License stub — always true this milestone; real licensing is Phase 4b.
    pub pro: bool,
    pub enforcement: CompanionEnforcement,
    /// The companion's merged view of the lock state. Receivers merge it in.
    pub lock_state: LockState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CompanionMessage {
    /// extension -> companion: first message after the port opens.
    #[serde(rename_all = "camelCase")]
    Hello {
        v: u32,
        ext_version: String,
        browser: CompanionBrowser,
        extension_id: String,
    },
    /// Both directions: sent once after hello and whenever local state changes.
    #[serde(rename_all = "camelCase")]
    LockStateSync {
        v: u32,
        lock_state: LockState,
    },
    /// extension -> companion: liveness signal for the watchdog.
    Heartbeat {
        v: u32,
        now: i64,
    },
    /// companion -> extension: reply to hello + pushed on any status change.
    /// The nm-host relay synthesizes `running: false` variants when the
    /// daemon is unreachable, hence the optional degraded flag (a TS `?`
    /// property: omitted when absent, not null).
    #[serde(rename_all = "camelCase")]
    CompanionStatus {
        v: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        running: Option<bool>,
        status: CompanionStatus,
    },
    Error {
        v: u32,
        message: String,
    },
}

/// Decode an already-framed JSON value; `None` for unknown/malformed message
/// types (a peer with a higher `v` may send messages we skip — never a hard
/// error at this layer).
pub fn parse_message(value: &Value) -> Option<CompanionMessage> {
    serde_json::from_value(value.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_wire_shapes_match_ts() {
        let hello = CompanionMessage::Hello {
            v: PROTOCOL_VERSION,
            ext_version: "0.5.0".into(),
            browser: CompanionBrowser::Chrome,
            extension_id: "abcdef".into(),
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({
                "type": "hello",
                "v": 1,
                "extVersion": "0.5.0",
                "browser": "chrome",
                "extensionId": "abcdef"
            })
        );

        let sync = CompanionMessage::LockStateSync {
            v: 1,
            lock_state: LockState::default(),
        };
        assert_eq!(
            serde_json::to_value(&sync).unwrap(),
            json!({
                "type": "lockStateSync",
                "v": 1,
                "lockState": {
                    "timerUntil": null,
                    "passwordHash": null,
                    "frozenUntil": null,
                    "schedules": [],
                    "schedulesUpdatedAt": 0
                }
            })
        );

        let heartbeat = CompanionMessage::Heartbeat { v: 1, now: 1234 };
        assert_eq!(
            serde_json::to_value(&heartbeat).unwrap(),
            json!({ "type": "heartbeat", "v": 1, "now": 1234 })
        );

        let status = CompanionMessage::CompanionStatus {
            v: 1,
            running: None,
            status: CompanionStatus {
                companion_version: "0.1.0".into(),
                pro: true,
                enforcement: CompanionEnforcement {
                    app_blocking: true,
                    watchdog: true,
                    policy_protected: false,
                },
                lock_state: LockState::default(),
            },
        };
        let v = serde_json::to_value(&status).unwrap();
        assert_eq!(v["type"], "companionStatus");
        // `running?` mirrors a TS optional property: omitted when None.
        assert!(v.get("running").is_none());
        assert_eq!(v["status"]["companionVersion"], "0.1.0");
        assert_eq!(v["status"]["enforcement"]["policyProtected"], false);
    }

    #[test]
    fn parse_message_roundtrips_and_ignores_unknown_types() {
        let msg = CompanionMessage::Heartbeat { v: 1, now: 42 };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(parse_message(&value), Some(msg));

        // A higher-version peer's new message type is skipped, not an error.
        assert_eq!(
            parse_message(&json!({ "type": "quantumSync", "v": 2 })),
            None
        );
        assert_eq!(parse_message(&json!("not an object")), None);
        // Known type with a malformed body is also a soft skip.
        assert_eq!(
            parse_message(&json!({ "type": "heartbeat", "v": 1, "now": "soon" })),
            None
        );
    }

    #[test]
    fn synthesized_degraded_status_parses() {
        let value = json!({
            "type": "companionStatus",
            "v": 1,
            "running": false,
            "status": {
                "companionVersion": "0.1.0",
                "pro": true,
                "enforcement": { "appBlocking": false, "watchdog": false, "policyProtected": false },
                "lockState": { "timerUntil": null, "passwordHash": null, "frozenUntil": null, "schedules": [] }
            }
        });
        let Some(CompanionMessage::CompanionStatus {
            running, status, ..
        }) = parse_message(&value)
        else {
            panic!("expected companionStatus");
        };
        assert_eq!(running, Some(false));
        assert_eq!(status.lock_state, LockState::default());
    }
}
