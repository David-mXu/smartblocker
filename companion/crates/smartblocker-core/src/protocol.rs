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

use crate::allowance::{AllowanceAuthorityState, AllowanceCommandRefusal};
use crate::lock_math::LockState;
use crate::partner::PartnerState;
use crate::usage::{UsageExport, UsageSummary};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Native messaging host name — must match the NM host manifest `name` and
/// the registry entries / manifest files written by the companion.
pub const NM_HOST_NAME: &str = "dev.davidxu.smartblocker";

/// v2: hello gains `pairing` (daemon authenticates the channel — see
/// `daemon::authenticate`) and LockState gains `passwordTs`. Unknown fields
/// are ignored by older peers, but only v2+ daemons get full lock sync.
pub const PROTOCOL_VERSION: u32 = 2;

/// Heartbeat cadence while the port is open. The companion treats a gap of
/// ~2 misses (45s, `enforcer::HEARTBEAT_STALE_MS`) as "extension not
/// responding" during an active lock.
pub const HEARTBEAT_INTERVAL_MS: u64 = 20_000;

/// Largest integer JavaScript can represent without losing integer precision.
/// Blocking revisions stay within this shared wire-format boundary.
pub const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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

/// The enforcing peer's view of one authenticated browser's extension health.
/// Remaining time is relative to this status observation; monotonic daemon
/// timestamps never cross the wire for display-clock arithmetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionLossState {
    Connected,
    Grace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionLossStatus {
    pub state: ExtensionLossState,
    pub grace_seconds: u64,
    /// Present only while this browser has an active enforcer suspect track.
    pub grace_remaining_ms: Option<u64>,
}

/// Daemon-owned ordinary blocking state. The revision orders cross-browser
/// writes and makes a daemon-originated settings echo distinguishable from a
/// new user intent. `None` on `CompanionStatus` means not initialized yet (or
/// an older daemon), never "disabled".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingState {
    pub enabled: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockAction {
    Start,
    Stop,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub companion_version: String,
    /// The license gate's verdict (`license::is_pro`): real offline
    /// verification, fail-closed on a missing/invalid key, with the
    /// documented `SBPRO_DEV_OPEN=1` pre-store escape hatch + expiry grace.
    pub pro: bool,
    pub enforcement: CompanionEnforcement,
    /// The companion's merged view of the lock state. Receivers merge it in.
    pub lock_state: LockState,
    /// Ordinary blocking authority, absent until a browser or CLI initializes
    /// it. This additive v2 field is independent of forced/timer lock state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<BlockingState>,
    /// Recipient-specific and present only for an authenticated extension.
    /// Older peers safely ignore this additive v2 field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_loss: Option<ExtensionLossStatus>,
    /// Public accountability-partner authorization material only. Private
    /// signing keys never enter PartnerState or any daemon status/event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner: Option<PartnerState>,
    /// Item10 authority; absence is uninitialized or unsupported, never cleared
    /// offline spending or a fabricated synchronized zero balance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowance: Option<AllowanceAuthorityState>,
    /// The daemon's enforced native app association. Additive v2 fields:
    /// older extensions ignore them; older daemons omit them (the extension
    /// then leaves every profile association untouched).
    #[serde(default)]
    pub app_blocklist: Vec<String>,
    /// Wall-clock stamp; 0 = never synchronized (not an instruction to wipe).
    #[serde(default)]
    pub app_blocklist_updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CompanionMessage {
    /// extension -> companion: first message after the port opens. `pairing`
    /// is the bearer token authenticating this browser profile to the daemon
    /// (TOFU — persisted by both sides; re-pairing is refused while locked).
    /// Without it the daemon redacts password state, strips password writes,
    /// and ignores heartbeats for watchdog purposes.
    #[serde(rename_all = "camelCase")]
    Hello {
        v: u32,
        ext_version: String,
        browser: CompanionBrowser,
        extension_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pairing: Option<String>,
    },
    /// Both directions: sent once after hello and whenever local state changes.
    #[serde(rename_all = "camelCase")]
    LockStateSync {
        v: u32,
        lock_state: LockState,
    },
    /// Authenticated extension -> companion: a NEW local user intent based on
    /// the last daemon revision observed by that browser. Stale-base updates
    /// are rejected rather than overwriting a newer cross-browser decision.
    #[serde(rename_all = "camelCase")]
    BlockingStateUpdate {
        v: u32,
        enabled: bool,
        base_revision: u64,
    },
    /// Companion -> extension: authoritative ordinary blocking state. This is
    /// never a browser command; browsers send `BlockingStateUpdate` instead.
    BlockingStateSync {
        v: u32,
        blocking: BlockingState,
    },
    /// Authenticated extension -> companion: the active profile's app
    /// association. The daemon applies additions while locked (removals wait)
    /// and answers with an authoritative status, so both sides converge.
    #[serde(rename_all = "camelCase")]
    AppBlocklistUpdate {
        v: u32,
        app_blocklist: Vec<String>,
        app_blocklist_updated_at: i64,
    },
    /// Same-user local CLI -> companion. Ordinary disable operations are
    /// refused while ANY lock is active; start remains legal.
    BlockCommand {
        v: u32,
        action: BlockAction,
    },
    /// Same-user local CLI -> companion: enable ordinary blocking and start or
    /// extend a timer lock. There is deliberately no shorten/cancel command.
    #[serde(rename_all = "camelCase")]
    LockCommand {
        v: u32,
        duration_ms: u64,
    },
    /// Same-user local CLI -> companion: register a partner public key. The
    /// pure partner module supplies the mandatory activation delay.
    #[serde(rename = "addKey", rename_all = "camelCase")]
    PartnerAddKey {
        v: u32,
        public_key: String,
    },
    /// Same-user local CLI -> companion: arm a fresh partner generation while
    /// otherwise unlocked. Raw lockStateSync can never perform this mutation.
    #[serde(rename = "arm")]
    PartnerArm {
        v: u32,
    },
    /// Same-user local CLI -> companion: mint and persist an offline signing
    /// challenge bound to the current arm generation.
    #[serde(rename = "beginOperation")]
    PartnerBeginOperation {
        v: u32,
    },
    /// Same-user local CLI -> companion: consume a signed one-time release.
    #[serde(rename = "redeem", rename_all = "camelCase")]
    PartnerRedeem {
        v: u32,
        token: String,
    },
    /// One-shot offline migration, accepted ONLY with no initialized authority.
    #[serde(rename_all = "camelCase")]
    AllowanceBootstrap {
        v: u32,
        allowance: Value,
    },
    /// Authenticated browser command based on the last observed revision.
    #[serde(rename_all = "camelCase")]
    AllowanceCommand {
        v: u32,
        command: Value,
        base_revision: u64,
    },
    /// Authoritative item10 state (also a bootstrap recovery observation).
    #[serde(rename_all = "camelCase")]
    AllowanceStateSync {
        v: u32,
        allowance: AllowanceAuthorityState,
    },
    /// Truthful per-operation outcome, never a response before persistence.
    #[serde(rename_all = "camelCase")]
    AllowanceCommandResult {
        v: u32,
        ok: bool,
        operation_id: String,
        allowance: AllowanceAuthorityState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<AllowanceCommandRefusal>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duplicate: Option<bool>,
    },
    /// Companion -> local CLI: the operation's truthful outcome plus the same
    /// authoritative status given to other clients (redacted when unpaired).
    #[serde(rename_all = "camelCase")]
    CommandResult {
        v: u32,
        ok: bool,
        message: String,
        status: CompanionStatus,
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
    /// COMPANION-INTERNAL liveness probe (the watchdog supervisor's
    /// daemon-squat check, and the idle keepalive for long-lived unauthenticated
    /// local UI connections). Deliberately NOT mirrored as a sendable type in
    /// `src/shared/companion-protocol.ts`: the extension never sends it and
    /// must never need to — it expires stale on the extension side like any
    /// unknown type. Answered with `Pong`; a socket squatter that accepts
    /// TCP-style connects but can't answer is detected by the watchdog.
    Ping {
        v: u32,
    },
    /// companion-internal answer to `Ping`: the daemon's pid + monotonic ms
    /// since ITS start — both liveness and identity-of-instance, so a
    /// respawned daemon is distinguishable from a stale answer.
    #[serde(rename_all = "camelCase")]
    Pong {
        v: u32,
        pid: u32,
        mono_ms: u64,
    },
    /// The desktop UI's local usage query. Companion-internal (the extension
    /// never sends it), unauthenticated like every UI command, and answered
    /// only by the daemon that owns the in-memory tracker. `requestId` lets a
    /// client ignore status broadcasts that arrive before the reply.
    #[serde(rename_all = "camelCase")]
    UsageCommand {
        v: u32,
        request_id: String,
        action: UsageAction,
        #[serde(default)]
        period_days: u32,
    },
    /// Truthful usage result: `summary` for Summary/Clear, `export` for
    /// Export. A failed clear reports `ok: false`; never claims a durable
    /// reset that didn't land.
    #[serde(rename_all = "camelCase")]
    UsageResult {
        v: u32,
        request_id: String,
        ok: bool,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<UsageSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        export: Option<UsageExport>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageAction {
    Summary,
    Export,
    Clear,
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
            pairing: None,
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({
                "type": "hello",
                "v": 2,
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
                    "breakStartedAt": null,
                    "breakNotBefore": null,
                    "breakEndsAt": null,
                    "breakUpdatedAt": 0,
                    "timerUntil": null,
                    "passwordHash": null,
                    "passwordTs": 0,
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

        for (message, wire) in [
            (
                CompanionMessage::PartnerAddKey {
                    v: 2,
                    public_key: "ab".repeat(32),
                },
                json!({ "type": "addKey", "v": 2, "publicKey": "ab".repeat(32) }),
            ),
            (
                CompanionMessage::PartnerArm { v: 2 },
                json!({ "type": "arm", "v": 2 }),
            ),
            (
                CompanionMessage::PartnerBeginOperation { v: 2 },
                json!({ "type": "beginOperation", "v": 2 }),
            ),
            (
                CompanionMessage::PartnerRedeem {
                    v: 2,
                    token: "SBP1.payload.signature".into(),
                },
                json!({ "type": "redeem", "v": 2, "token": "SBP1.payload.signature" }),
            ),
        ] {
            assert_eq!(serde_json::to_value(&message).unwrap(), wire);
            assert_eq!(parse_message(&wire), Some(message));
        }

        // A paired hello carries the bearer token; without it the field is
        // omitted entirely (older peers ignore it either way).
        let paired = CompanionMessage::Hello {
            v: PROTOCOL_VERSION,
            ext_version: "0.5.0".into(),
            browser: CompanionBrowser::Chrome,
            extension_id: "abcdef".into(),
            pairing: Some("tok".into()),
        };
        assert_eq!(
            serde_json::to_value(&paired).unwrap()["pairing"],
            json!("tok")
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
                blocking: None,
                extension_loss: None,
                partner: None,
                allowance: None,
                app_blocklist: vec!["steam".into()],
                app_blocklist_updated_at: 42,
            },
        };
        let v = serde_json::to_value(&status).unwrap();
        assert_eq!(v["type"], "companionStatus");
        // `running?` mirrors a TS optional property: omitted when None.
        assert!(v.get("running").is_none());
        assert_eq!(v["status"]["companionVersion"], "0.1.0");
        assert_eq!(v["status"]["enforcement"]["policyProtected"], false);
        assert_eq!(v["status"]["appBlocklist"], json!(["steam"]));
        assert_eq!(v["status"]["appBlocklistUpdatedAt"], 42);
        assert!(v["status"].get("extensionLoss").is_none());

        let update = CompanionMessage::AppBlocklistUpdate {
            v: PROTOCOL_VERSION,
            app_blocklist: vec!["steam".into(), "discord".into()],
            app_blocklist_updated_at: 43,
        };
        let wire = serde_json::to_value(&update).unwrap();
        assert_eq!(
            wire,
            json!({
                "type": "appBlocklistUpdate",
                "v": 2,
                "appBlocklist": ["steam", "discord"],
                "appBlocklistUpdatedAt": 43,
            })
        );
        assert_eq!(parse_message(&wire), Some(update));

        let mut personalized = status.clone();
        let CompanionMessage::CompanionStatus { status, .. } = &mut personalized else {
            unreachable!()
        };
        status.extension_loss = Some(ExtensionLossStatus {
            state: ExtensionLossState::Grace,
            grace_seconds: 60,
            grace_remaining_ms: Some(42_000),
        });
        let value = serde_json::to_value(&personalized).unwrap();
        assert_eq!(
            value["status"]["extensionLoss"],
            json!({
                "state": "grace",
                "graceSeconds": 60,
                "graceRemainingMs": 42_000,
            })
        );
        assert_eq!(parse_message(&value), Some(personalized));
    }

    #[test]
    fn old_status_without_extension_loss_still_parses() {
        let value = json!({
            "type": "companionStatus",
            "v": 2,
            "status": {
                "companionVersion": "0.5.0",
                "pro": true,
                "enforcement": {
                    "appBlocking": true,
                    "watchdog": true,
                    "policyProtected": false
                },
                "lockState": LockState::default(),
            }
        });
        let Some(CompanionMessage::CompanionStatus { status, .. }) = parse_message(&value) else {
            panic!("old status should parse")
        };
        assert_eq!(status.extension_loss, None);
        // Additive app fields absent from an older daemon read as "no opinion".
        assert!(status.app_blocklist.is_empty());
        assert_eq!(status.app_blocklist_updated_at, 0);
    }

    #[test]
    fn explicit_release_gates_roundtrip_and_keep_compact_release_tombstones() {
        let armed = LockState {
            delay_until: Some(0),
            delay_duration_ms: Some(60_000),
            delay_updated_at: 100,
            random_text_len: Some(5_000),
            random_text_updated_at: 100,
            ..LockState::default()
        };
        let armed_sync = CompanionMessage::LockStateSync {
            v: PROTOCOL_VERSION,
            lock_state: armed,
        };
        let value = serde_json::to_value(&armed_sync).unwrap();
        assert_eq!(value["lockState"]["delayUntil"], json!(0));
        assert_eq!(value["lockState"]["delayDurationMs"], json!(60_000));
        assert_eq!(value["lockState"]["delayUpdatedAt"], json!(100));
        assert_eq!(value["lockState"]["randomTextLen"], json!(5_000));
        assert_eq!(value["lockState"]["randomTextUpdatedAt"], json!(100));
        assert_eq!(parse_message(&value), Some(armed_sync));

        // Rust omits null Option fields. The stamp-only result is deliberate:
        // TS sanitization recognizes it as a release, retaining the metadata
        // that prevents an older peer from re-arming either gate.
        let released = CompanionMessage::LockStateSync {
            v: PROTOCOL_VERSION,
            lock_state: LockState {
                delay_updated_at: 200,
                random_text_updated_at: 300,
                ..LockState::default()
            },
        };
        let value = serde_json::to_value(&released).unwrap();
        assert_eq!(value["lockState"]["delayUpdatedAt"], json!(200));
        assert_eq!(value["lockState"]["randomTextUpdatedAt"], json!(300));
        for key in ["delayUntil", "delayDurationMs", "randomTextLen"] {
            assert!(
                value["lockState"].get(key).is_none(),
                "{key} was serialized"
            );
        }
        assert_eq!(parse_message(&value), Some(released.clone()));

        // Extension-side releases contain explicit nulls; both wire spellings
        // deserialize to the same released Rust state.
        let explicit_nulls = json!({
            "type": "lockStateSync",
            "v": 2,
            "lockState": {
                "delayUntil": null,
                "delayDurationMs": null,
                "delayUpdatedAt": 200,
                "randomTextLen": null,
                "randomTextUpdatedAt": 300
            }
        });
        assert_eq!(parse_message(&explicit_nulls), Some(released));
    }

    #[test]
    fn ping_pong_wire_shapes_are_the_companion_internal_probe() {
        // The watchdog liveness probe (red-team #7 residual): tiny frames,
        // pong carries identity-of-instance (pid + daemon-start mono).
        let ping = CompanionMessage::Ping {
            v: PROTOCOL_VERSION,
        };
        assert_eq!(
            serde_json::to_value(&ping).unwrap(),
            json!({ "type": "ping", "v": 2 })
        );
        let pong = CompanionMessage::Pong {
            v: PROTOCOL_VERSION,
            pid: 4321,
            mono_ms: 99,
        };
        let value = serde_json::to_value(&pong).unwrap();
        assert_eq!(
            value,
            json!({ "type": "pong", "v": 2, "pid": 4321, "monoMs": 99 })
        );
        assert_eq!(parse_message(&value), Some(pong));
    }

    #[test]
    fn usage_messages_are_companion_internal_and_camel_case() {
        let command = CompanionMessage::UsageCommand {
            v: PROTOCOL_VERSION,
            request_id: "r1".into(),
            action: UsageAction::Summary,
            period_days: 7,
        };
        assert_eq!(
            serde_json::to_value(&command).unwrap(),
            json!({
                "type": "usageCommand",
                "v": 2,
                "requestId": "r1",
                "action": "summary",
                "periodDays": 7,
            })
        );
        assert_eq!(
            parse_message(&serde_json::to_value(&command).unwrap()),
            Some(command)
        );

        let export = crate::usage::UsageExport {
            version: 1,
            generated_at_ms: 5,
            retention_days: 35,
            period_days: 7,
            platform: "windows".into(),
            metric_definitions: crate::usage::UsageMetricDefinitions {
                active_ms: "a".into(),
                wall_ms: "w".into(),
                app_identity: "id".into(),
                idle_and_sleep: "i".into(),
                retention: "r".into(),
            },
            days: vec![],
        };
        let result = CompanionMessage::UsageResult {
            v: PROTOCOL_VERSION,
            request_id: "r1".into(),
            ok: true,
            message: "ok".into(),
            summary: None,
            export: Some(export),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["type"], "usageResult");
        assert_eq!(value["requestId"], "r1");
        assert_eq!(value["export"]["retentionDays"], 35);
        assert!(value.get("summary").is_none());
        assert_eq!(parse_message(&value), Some(result));
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
