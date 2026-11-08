// Pure extension-loss grace display math (Phase 5 batch 2, item 8).
// No browser APIs and no non-erasable TypeScript syntax: Node imports this
// file directly in scripts/grace-math-test.mjs.
//
// IMPORTANT: an extension-side heartbeat SEND is not a daemon observation.
// This module therefore never infers a close deadline from outgoing traffic.
// A grace observation must come from the enforcing peer. `graceRemainingMs`
// is the authoritative amount left when the extension observed that status;
// `observedAtMs` is on the extension's display clock. The current v2 protocol
// does not carry these observations yet (see the 2026-11-08 learning note).

export type ExtensionGraceState = 'connected' | 'grace' | 'expired' | 'unknown';

export interface ExtensionGraceObservation {
  /** The enforcing peer's explicitly observed state, not a local guess. */
  state: 'connected' | 'grace';
  /** Extension display-clock time at which this status was received. */
  observedAtMs: number;
  /** Last heartbeat the enforcing peer actually received, on the same display
   *  clock, or null when the peer does not expose it. Diagnostic input only:
   *  explicit peer state, never this timestamp, controls the deadline. */
  lastHeartbeatAtMs: number | null;
  /** Daemon-computed grace remaining at observedAtMs. Required for 'grace';
   *  ignored for 'connected'. Relative milliseconds avoid subtracting the
   *  daemon's monotonic clock from the extension's wall clock. */
  graceRemainingMs: number | null;
}

export interface ExtensionGraceResult {
  state: ExtensionGraceState;
  /** Exact display-model milliseconds left, clamped to [0, graceSeconds].
   *  Null for connected/unknown; zero once an observed grace has expired. */
  remainingMs: number | null;
}

export const UNKNOWN_EXTENSION_GRACE: ExtensionGraceResult = {
  state: 'unknown',
  remainingMs: null,
};

const CONNECTED_EXTENSION_GRACE: ExtensionGraceResult = {
  state: 'connected',
  remainingMs: null,
};

// setInterval is allowed to fire a fraction early/late. A tiny epsilon keeps
// an exact whole-second value from rounding up to the next second, without
// turning a positive sub-second remainder into zero prematurely.
export const GRACE_DISPLAY_EPSILON_SECONDS = 1e-9;

function finite(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Derive display state from an authoritative observation at `nowMs`.
 *  There is deliberately no fallback from lastHeartbeatAtMs + a guessed
 *  timeout: heartbeat-stale detection and grace start are daemon state. */
export function deriveExtensionGrace(
  nowMs: number,
  status: ExtensionGraceObservation | null,
  graceSeconds: number | null,
): ExtensionGraceResult {
  if (!finite(nowMs) || status === null || !finite(graceSeconds) || graceSeconds <= 0) {
    return UNKNOWN_EXTENSION_GRACE;
  }
  const graceMs = graceSeconds * 1000;
  if (!Number.isFinite(graceMs) || graceMs > Number.MAX_SAFE_INTEGER || !finite(status.observedAtMs)) {
    return UNKNOWN_EXTENSION_GRACE;
  }

  // Recovery arrives as a new connected observation; do not compare the
  // daemon's heartbeat history with a different local status-receipt clock.
  if (status.state === 'connected') return CONNECTED_EXTENSION_GRACE;
  if (!finite(status.graceRemainingMs)) return UNKNOWN_EXTENSION_GRACE;

  // Backward display-clock jumps cannot revive expired time or inflate the
  // countdown beyond the configured grace. Forward jumps merely consume it.
  const elapsedMs = nowMs - status.observedAtMs;
  const effectiveElapsedMs = elapsedMs <= 0 ? 0 : elapsedMs;
  const initialRemainingMs = Math.min(graceMs, Math.max(0, status.graceRemainingMs));
  const remainingMs =
    effectiveElapsedMs === Infinity
      ? 0
      : Math.min(graceMs, Math.max(0, initialRemainingMs - effectiveElapsedMs));
  if (!Number.isFinite(remainingMs)) return UNKNOWN_EXTENSION_GRACE;
  return {
    state: remainingMs <= 0 ? 'expired' : 'grace',
    remainingMs,
  };
}

/** Whole seconds for the one-second popup/options paint cadence. Never
 *  negative, NaN, or Infinity. Returns null when no countdown is available. */
export function extensionGraceDisplaySeconds(remainingMs: number | null): number | null {
  if (!finite(remainingMs)) return null;
  const clampedMs = Math.max(0, remainingMs);
  const seconds = Math.ceil(clampedMs / 1000 - GRACE_DISPLAY_EPSILON_SECONDS);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

/** User-facing copy. `unknown` is intentionally not given a number: the
 *  extension currently observes disconnection, not the daemon's grace track. */
export function extensionGraceText(result: ExtensionGraceResult): string {
  if (result.state === 'grace') {
    const seconds = extensionGraceDisplaySeconds(result.remainingMs);
    return seconds === null
      ? 'Extension lost. The browser-close grace is active, but its remaining time is unavailable.'
      : `Extension lost: browser may close in ${seconds}s unless it returns.`;
  }
  if (result.state === 'expired') {
    return 'Extension grace expired: the browser may close unless the extension returns.';
  }
  return 'Extension disconnected. If the desktop app is still enforcing your lock, its close grace may be running; the remaining time is unavailable.';
}
