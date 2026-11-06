// Extension <-> desktop companion protocol, spoken over Native Messaging
// (browser <-> smartblocker-nm-host) and relayed verbatim to the companion
// daemon. Mirrored by companion/crates/smartblocker-core/src/protocol.rs —
// change both together. Keep this file erasable-syntax-only (types + plain
// consts) so Node scripts can import it under type stripping.
//
// Wire rules:
// - Every message carries `v` (PROTOCOL_VERSION). Unknown types are ignored;
//   a peer with a higher `v` may send messages we skip — never a hard error.
// - Lock state is synced by MERGING (mergeLockStates in lock-math.ts):
//   commutative, idempotent, monotonic. Each side persists + re-broadcasts
//   only when a merge CHANGED its state — that guard is what prevents
//   sync loops, and it is mandatory on both sides.
// - Messages stay far below Chrome's 1MB native->browser limit.
// - `ping`/`pong` exist too, but only BETWEEN the daemon and its own
//   supervisor watchdog (liveness probe, never sent by/to the extension), so
//   they are declared on the Rust side only — see protocol.rs.
import type { LockState } from './lock-math';

/** Native messaging host name — must match the NM host manifest `name` and
 *  the registry entries / manifest files written by the companion. */
export const NM_HOST_NAME = 'dev.davidxu.smartblocker';

/** v2: hello gains `pairing` (daemon authenticates the channel — see the
 *  daemon's pairing notes) and LockState gains `passwordTs`. Unknown fields
 *  are ignored by older peers, but only v2+ daemons get full lock sync. */
export const PROTOCOL_VERSION = 2;

/** Heartbeat cadence while the port is open. The companion treats a gap of
 *  ~2 misses (45s) as "extension not responding" during an active lock. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export type CompanionBrowser = 'chrome' | 'edge' | 'firefox';

/** Which hard enforcements the companion currently provides. */
export interface CompanionEnforcement {
  /** Blocklisted desktop apps are closed while a forced block is active. */
  appBlocking: boolean;
  /** Supported browsers running without a live extension get closed. */
  watchdog: boolean;
  /** Managed browser policy protects the extension from being disabled.
   *  Ships false until the extension has a store listing (needs update_url). */
  policyProtected: boolean;
}

export interface CompanionStatus {
  companionVersion: string;
  /** License stub — always true this milestone; real licensing is Phase 4b. */
  pro: boolean;
  enforcement: CompanionEnforcement;
  /** The companion's merged view of the lock state. Receivers merge it in. */
  lockState: LockState;
}

export type CompanionMessage =
  // extension -> companion: first message after the port opens. `pairing` is
  // the bearer token authenticating this browser profile to the daemon
  // (TOFU — persisted by both sides; re-pairing is refused while locked).
  // Without it the daemon redacts password state and ignores heartbeats.
  | {
      v: number;
      type: 'hello';
      extVersion: string;
      browser: CompanionBrowser;
      extensionId: string;
      pairing?: string;
    }
  // Both directions: sent once after hello and whenever local state changes.
  | { v: number; type: 'lockStateSync'; lockState: LockState }
  // extension -> companion: liveness signal for the watchdog.
  | { v: number; type: 'heartbeat'; now: number }
  // companion -> extension: reply to hello + pushed on any status change.
  // The nm-host relay synthesizes { running: false } variants when the
  // daemon is unreachable, hence the optional degraded flag.
  | { v: number; type: 'companionStatus'; running?: boolean; status: CompanionStatus }
  | { v: number; type: 'error'; message: string };

/** What the background caches for UI consumers (options page section). */
export interface CompanionSnapshot {
  state: 'not-installed' | 'connecting' | 'connected' | 'disconnected';
  /** Last companionStatus received, if any. */
  status: CompanionStatus | null;
  lastConnectedAt: number | null;
}
