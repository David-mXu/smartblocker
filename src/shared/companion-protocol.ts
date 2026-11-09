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
import type { ObservedExtensionGrace } from './grace-math';
import type { AllowanceAuthorityState } from './allowance-state';
import type { AllowanceProtocolMessage } from './allowance-protocol';

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

export interface CompanionExtensionLoss {
  state: 'connected' | 'grace';
  graceSeconds: number;
  /** Daemon-relative milliseconds at this status observation; null when healthy. */
  graceRemainingMs: number | null;
}

/** Daemon-owned ordinary blocking state. Revisions order user intents across
 * browsers; absence means uninitialized (or an older daemon), not disabled. */
export interface CompanionBlockingState {
  enabled: boolean;
  revision: number;
}

/** Public-only accountability-partner state. Private Ed25519 signing keys are
 *  held offline and are never part of this wire shape. */
export interface PartnerPublicKey {
  publicKey: string;
  addedAtMs: number;
  activeAtMs: number;
  /** Current-runtime activation clocks plus durable two-dimensional proof.
   * Optional only for legacy deserialization; migrated daemon status has them. */
  addedMonoMs?: number;
  activeMonoMs?: number;
  activationObservedAtMs?: number;
  activationObservedMonoMs?: number;
}

export interface PendingPartnerOperation {
  installationId: string;
  armGeneration: string;
  operationId: string;
  nonce: string;
  expiresAtMs: number;
  /** Daemon-runtime monotonic expiry. Restart deletes unsigned operations. */
  expiresMonoMs?: number;
}

export interface SpentPartnerCode {
  operationId: string;
  signature: string;
  expiresAtMs: number;
}

export interface PartnerState {
  version: number;
  installationId: string;
  publicKeys: PartnerPublicKey[];
  pendingOperations: PendingPartnerOperation[];
  spentCodes: SpentPartnerCode[];
  lastObservedAtMs: number;
  lastObservedMonoMs?: number;
}

export interface CompanionStatus {
  companionVersion: string;
  /** License stub — always true this milestone; real licensing is Phase 4b. */
  pro: boolean;
  enforcement: CompanionEnforcement;
  /** The companion's merged view of the lock state. Receivers merge it in. */
  lockState: LockState;
  /** Ordinary blocking authority; independent of forced/timer lock state. */
  blocking?: CompanionBlockingState;
  /** Authenticated-recipient-only daemon observation. Older peers omit it. */
  extensionLoss?: CompanionExtensionLoss;
  /** Public partner authorization material; redacted for unpaired recipients. */
  partner?: PartnerState;
  /** Item10 authority. Absence means uninitialized/unsupported, never a request
   * to clear offline spending or pretend it is a synchronized zero balance. */
  allowance?: AllowanceAuthorityState;
  /** Native app association carried by the daemon's config. Optional for
   *  older daemons; the extension then leaves its profile association alone. */
  appBlocklist?: string[];
  /** Companion wall-clock stamp of the last accepted association change.
   *  0 means never synchronized. */
  appBlocklistUpdatedAt?: number;
}

const PARTNER_OPERATION_KEYS = [
  'installationId',
  'armGeneration',
  'operationId',
  'nonce',
  'expiresAtMs',
  'expiresMonoMs',
] as const;
const CANONICAL_256_BIT_HEX = /^[0-9a-f]{64}$/;

/** Validate the exact operation carried by CommandResult.message. Never select
 * `.at(-1)` from status: another client may have appended a concurrent B. */
export function partnerOperationFromResult(
  rawMessage: unknown,
  status: CompanionStatus | null | undefined,
): PendingPartnerOperation {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof rawMessage === 'string' ? rawMessage : '');
  } catch {
    throw new Error('The daemon returned no parseable pending operation.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The daemon returned an invalid pending operation.');
  }
  const candidate = raw as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== PARTNER_OPERATION_KEYS.length ||
    !PARTNER_OPERATION_KEYS.every((key) => keys.includes(key)) ||
    !['installationId', 'armGeneration', 'operationId', 'nonce'].every((key) =>
      typeof candidate[key] === 'string' && CANONICAL_256_BIT_HEX.test(candidate[key]),
    ) ||
    !Number.isSafeInteger(candidate.expiresAtMs) ||
    (candidate.expiresAtMs as number) <= 0 ||
    !Number.isSafeInteger(candidate.expiresMonoMs) ||
    (candidate.expiresMonoMs as number) < 0
  ) {
    throw new Error('The daemon returned an invalid pending operation.');
  }
  const partner = status?.partner;
  if (!partner || partner.installationId !== candidate.installationId) {
    throw new Error('The returned operation does not match this pending operation result.');
  }
  const operation = candidate as unknown as PendingPartnerOperation;
  const exact = partner.pendingOperations.some((entry) =>
    PARTNER_OPERATION_KEYS.every((key) => entry[key] === operation[key]),
  );
  if (!exact) {
    throw new Error('The returned operation does not match this pending operation result.');
  }
  return operation;
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
  // Authenticated extension -> companion: a new local intent based on the last
  // observed daemon revision. Stale intents are answered with current state.
  | { v: number; type: 'blockingStateUpdate'; enabled: boolean; baseRevision: number }
  // Companion -> extension: authoritative state, not a browser command.
  | { v: number; type: 'blockingStateSync'; blocking: CompanionBlockingState }
  // Authenticated extension -> companion: the active profile's app
  // association. The daemon applies additions while locked, never removals,
  // and answers with an authoritative status so the two sides converge.
  | {
      v: number;
      type: 'appBlocklistUpdate';
      appBlocklist: string[];
      appBlocklistUpdatedAt: number;
    }
  // Same-user CLI -> companion. Only these commands may originate partner
  // arm/release; lockStateSync has those fields pinned by the daemon.
  | { v: number; type: 'addKey'; publicKey: string }
  | { v: number; type: 'arm' }
  | { v: number; type: 'beginOperation' }
  | { v: number; type: 'redeem'; token: string }
  // extension -> companion: liveness signal for the watchdog.
  | { v: number; type: 'heartbeat'; now: number }
  // companion -> extension: reply to hello + pushed on any status change.
  // The nm-host relay synthesizes { running: false } variants when the
  // daemon is unreachable, hence the optional degraded flag.
  | { v: number; type: 'companionStatus'; running?: boolean; status: CompanionStatus }
  | { v: number; type: 'commandResult'; ok: boolean; message: string; status: CompanionStatus }
  | AllowanceProtocolMessage
  | { v: number; type: 'error'; message: string };

/** What the background caches for UI consumers (options page section). */
export interface CompanionSnapshot {
  state: 'not-installed' | 'connecting' | 'connected' | 'disconnected';
  /** Last companionStatus received, if any. */
  status: CompanionStatus | null;
  /** Receipt-clock-stamped, validated observation; cleared on disconnect. */
  extensionLoss: ObservedExtensionGrace | null;
  lastConnectedAt: number | null;
}
