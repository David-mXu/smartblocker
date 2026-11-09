// Pure policy for daemon-owned ordinary blocking synchronization. Keeping the
// revision/echo decisions separate from Native Messaging makes their loop and
// reconnect behavior directly testable without a browser singleton.
import type { CompanionBlockingState } from './companion-protocol';

export function parseCompanionBlockingState(value: unknown): CompanionBlockingState | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as { enabled?: unknown; revision?: unknown };
  if (
    typeof candidate.enabled !== 'boolean' ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    return null;
  }
  return { enabled: candidate.enabled, revision: candidate.revision as number };
}

/** A lower revision cannot replace a newer observation on the same daemon
 * connection. The authority is reset on real disconnect/daemon loss. */
export function shouldAcceptBlockingAuthority(
  current: CompanionBlockingState | null | undefined,
  incoming: CompanionBlockingState,
): boolean {
  return (
    current == null ||
    incoming.revision > current.revision ||
    (incoming.revision === current.revision && incoming.enabled === current.enabled)
  );
}

/** Only an actual local difference is a user intent. In particular, applying
 * the daemon's value to storage must not create another command. */
export function shouldSendBlockingIntent(
  authority: CompanionBlockingState | null | undefined,
  enabled: boolean,
): boolean {
  return authority !== undefined && (authority === null || authority.enabled !== enabled);
}

export function blockingBaseRevision(
  authority: CompanionBlockingState | null | undefined,
): number {
  return authority?.revision ?? 0;
}

/** Semantic comparison for an async read boundary. Duplicate deliveries of
 * the same authority must not cancel a pending local intent; disconnect
 * (undefined) and uninitialized (null) remain distinct states. */
export function sameBlockingAuthority(
  a: CompanionBlockingState | null | undefined,
  b: CompanionBlockingState | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  return a.enabled === b.enabled && a.revision === b.revision;
}

export interface BlockingIntent {
  enabled: boolean;
  baseRevision: number;
}

export interface BlockingAuthorityResolution {
  /** This observation answers an intent based on an older daemon revision. */
  resolvedInFlight: boolean;
  /** The local value most recently reported by a genuine settings write. */
  pendingLocalValue: boolean | null;
  /** False while a newer local decision must not be overwritten by authority. */
  applyToStorage: boolean;
}

/** One-connection local-intent ledger. At most one base-revision intent may be
 * outstanding; newer local values remain queued until authority replies, then
 * are deliberately rebased. Daemon-applied storage echoes never call
 * `noteLocal`, which is what distinguishes them from new user decisions. */
export class BlockingIntentLedger {
  private desired: boolean | null = null;
  private localGeneration = 0;
  private desiredGeneration = 0;
  private inFlight: (BlockingIntent & { desiredGeneration: number }) | null = null;

  get hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  get pendingLocalValue(): boolean | null {
    return this.desired;
  }

  noteLocal(enabled: boolean): void {
    this.desired = enabled;
    this.desiredGeneration = ++this.localGeneration;
  }

  /** Atomically claim the send slot before Native Messaging is called. */
  prepare(authority: CompanionBlockingState | null, enabled: boolean): BlockingIntent | null {
    if (this.inFlight || !shouldSendBlockingIntent(authority, enabled)) return null;
    const intent = { enabled, baseRevision: blockingBaseRevision(authority) };
    this.inFlight = { ...intent, desiredGeneration: this.desiredGeneration };
    return intent;
  }

  resolve(incoming: CompanionBlockingState): BlockingAuthorityResolution {
    const resolvedInFlight =
      this.inFlight !== null &&
      (incoming.revision > this.inFlight.baseRevision ||
        (incoming.revision === this.inFlight.baseRevision &&
          incoming.enabled === this.inFlight.enabled));
    if (resolvedInFlight) this.inFlight = null;
    if (this.desired === incoming.enabled && (!this.inFlight || resolvedInFlight)) {
      this.desired = null;
    }
    return {
      resolvedInFlight,
      pendingLocalValue: this.desired,
      applyToStorage: this.desired === null || this.desired === incoming.enabled,
    };
  }

  /** An error contains no new base revision, so do not invent one or retry in
   * a tight loop. Discard only the rejected local value; a genuine newer
   * settings event has a later generation and remains pending. */
  failInFlight(): void {
    if (
      this.inFlight &&
      this.desired !== null &&
      this.desiredGeneration === this.inFlight.desiredGeneration
    ) {
      this.desired = null;
    }
    this.inFlight = null;
  }

  reset(): void {
    this.desired = null;
    this.desiredGeneration = 0;
    this.localGeneration = 0;
    this.inFlight = null;
  }
}
