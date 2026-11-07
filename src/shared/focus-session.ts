import { api } from './api';
import { startFrozenTurkey } from './lock';

/**
 * Focus session start with a 60-second undo window (user decision 2026-11-07).
 *
 * A "Focus session" is the user-facing name for Frozen Turkey (lock.ts
 * `frozenUntil`): blocking forced on, settings locked, uncancellable. To allow
 * an "oops" undo WITHOUT ever shortening a lock — the lock store and the
 * companion's merge are strictly monotonic (lock-math.ts / merge.rs) — the
 * session is DEFERRED, not cancelled:
 *
 *   start()  → stores `pendingFocusSession` { until, commitAt } and a one-shot
 *              alarm at commitAt. Nothing is written to lockState yet, so
 *              nothing syncs to the companion.
 *   undo()   → deletes the pending record + alarm (only ever possible before
 *              commit, because commit deletes the record first).
 *   commit   → background alarm (or any surface that notices it's due) calls
 *              startFrozenTurkey(until - now). The END time is fixed at the
 *              click, so "Locked until 3:40 PM" stays true.
 *
 * Commit is idempotent (startFrozenTurkey only extends), so the alarm, the
 * SW-startup check and a popup reopen may all race safely.
 */

export const FOCUS_UNDO_MS = 60_000;
export const FOCUS_COMMIT_ALARM = 'focus-session-commit';
const KEY = 'pendingFocusSession';

export interface PendingFocusSession {
  /** Absolute end time of the session (fixed at click time). */
  until: number;
  /** When the undo window closes and the lock is written. */
  commitAt: number;
  durationMs: number;
}

export async function getPendingFocusSession(): Promise<PendingFocusSession | null> {
  const got = await api.storage.local.get(KEY);
  return (got[KEY] as PendingFocusSession | undefined) ?? null;
}

export async function startFocusSession(durationMs: number, now = Date.now()): Promise<PendingFocusSession> {
  const pending: PendingFocusSession = {
    until: now + durationMs,
    commitAt: now + FOCUS_UNDO_MS,
    durationMs,
  };
  await api.storage.local.set({ [KEY]: pending });
  try {
    await api.alarms.create(FOCUS_COMMIT_ALARM, { when: pending.commitAt });
  } catch {
    /* alarms unavailable — the SW-startup / popup due-check still commits */
  }
  return pending;
}

/** Cancel a not-yet-committed session. Returns false if it already committed. */
export async function undoFocusSession(): Promise<boolean> {
  const pending = await getPendingFocusSession();
  if (!pending) return false;
  await api.storage.local.remove(KEY);
  try {
    await api.alarms.clear(FOCUS_COMMIT_ALARM);
  } catch {
    /* ignore */
  }
  return true;
}

/** Commit the pending session if its undo window has closed. */
export async function commitFocusSessionIfDue(now = Date.now()): Promise<boolean> {
  const pending = await getPendingFocusSession();
  if (!pending || now < pending.commitAt) return false;
  await api.storage.local.remove(KEY);
  const remaining = pending.until - now;
  if (remaining > 0) await startFrozenTurkey(remaining);
  return true;
}

/** Background wiring — call synchronously at SW top level (constraint #4). */
export function initFocusSessionCommitter(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FOCUS_COMMIT_ALARM) void commitFocusSessionIfDue();
  });
  // SW (re)start: commit anything that came due while we were asleep, and
  // re-arm the alarm for a session still inside its window.
  void (async () => {
    if (await commitFocusSessionIfDue()) return;
    const pending = await getPendingFocusSession();
    if (pending) {
      try {
        await api.alarms.create(FOCUS_COMMIT_ALARM, { when: pending.commitAt });
      } catch {
        /* ignore */
      }
    }
  })();
}
