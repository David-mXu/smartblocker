// Lock state store + the ONLY legal transitions. Lives in its own storage key
// (NOT inside Settings) so setSettings can reject writes while locked without
// the lock being patchable through the same door. Transitions are monotonic:
// extending is always allowed, shortening/cancelling never — the single
// exception is a correct password unlock, which clears the password source
// only (a running Frozen Turkey or schedule window survives it).
//
// This is a SOFT lock: raw storage writes from devtools or uninstalling the
// extension bypass it. Accepted — the Phase 4 desktop companion reads this
// same key over Native Messaging and becomes the hard enforcer.
//
// Import direction: settings.ts imports lock.ts, NEVER the reverse.
import { api } from './api';
import {
  EMPTY_LOCK_STATE,
  deriveLockStatus,
  mergeLockStates,
  sanitizeLockState,
  validateScheduleRule,
} from './lock-math';
import type { LockState, LockStatus, ScheduleRule } from './lock-math';

const STORAGE_KEY = 'lockState';

/** Fat-finger cap on timer/frozen durations. */
export const MAX_LOCK_MS = 30 * 24 * 3_600_000;

let cache: LockState | null = null;

// Invalidate when any context (options page, popup) writes lock state, so a
// long-lived service worker / offscreen doc sees changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

export async function getLockState(): Promise<LockState> {
  if (cache) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = { ...EMPTY_LOCK_STATE, ...(stored[STORAGE_KEY] as Partial<LockState> | undefined) };
  return cache;
}

async function writeLockState(next: LockState): Promise<void> {
  cache = next;
  await api.storage.local.set({ [STORAGE_KEY]: next });
}

export async function getLockStatus(now = Date.now()): Promise<LockStatus> {
  return deriveLockStatus(await getLockState(), now);
}

function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Lock duration must be positive.');
  }
  return Math.min(durationMs, MAX_LOCK_MS);
}

/** Lock settings for a duration. Repeat calls only ever extend. */
export async function startTimerLock(durationMs: number): Promise<LockStatus> {
  const state = await getLockState();
  const until = Math.max(state.timerUntil ?? 0, Date.now() + clampDuration(durationMs));
  await writeLockState({ ...state, timerUntil: until });
  return getLockStatus();
}

/** Force blocking ON for a duration — uncancellable by construction: no
 *  function in this module ever shortens frozenUntil. */
export async function startFrozenTurkey(durationMs: number): Promise<LockStatus> {
  const state = await getLockState();
  const until = Math.max(state.frozenUntil ?? 0, Date.now() + clampDuration(durationMs));
  await writeLockState({ ...state, frozenUntil: until });
  return getLockStatus();
}

export async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode('smartblocker-lock:' + pw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Arm the indefinite password lock. Overwriting an armed hash would BE an
 *  unlock, so arming twice throws. */
export async function armPasswordLock(password: string): Promise<void> {
  const pw = password.trim();
  if (pw.length < 4) throw new Error('Password must be at least 4 characters.');
  const state = await getLockState();
  if (state.passwordHash) throw new Error('A password lock is already armed.');
  await writeLockState({ ...state, passwordHash: await hashPassword(pw) });
}

/** Clears ONLY the password source on a match — timer, Frozen Turkey, and
 *  schedule windows all survive a password unlock. */
export async function attemptPasswordUnlock(password: string): Promise<boolean> {
  const state = await getLockState();
  if (!state.passwordHash) return true;
  if ((await hashPassword(password.trim())) !== state.passwordHash) return false;
  await writeLockState({ ...state, passwordHash: null });
  return true;
}

/** Replace the schedule rules. Refused while any lock is active — otherwise
 *  deleting a rule mid-window would cancel it. (Tighten-only diffing is v2.) */
export async function setSchedules(rules: ScheduleRule[]): Promise<void> {
  if ((await getLockStatus()).settingsLocked) {
    throw new Error('Schedules cannot be changed while SmartBlocker is locked.');
  }
  for (const r of rules) {
    const problem = validateScheduleRule(r);
    if (problem) throw new Error(`Invalid schedule: ${problem}`);
  }
  await writeLockState({
    ...(await getLockState()),
    schedules: rules,
    schedulesUpdatedAt: Date.now(),
  });
}

/** Fold the desktop companion's copy of the lock state into ours. Merge-only
 *  (monotonic — this can extend locks, never shorten them), with the remote
 *  input sanitized: it arrives over Native Messaging from another process.
 *  Returns whether our stored state changed; callers only re-broadcast on
 *  true, which is what keeps the extension↔companion sync from looping. */
export async function mergeRemoteLockState(remote: unknown): Promise<boolean> {
  const now = Date.now();
  const current = { ...EMPTY_LOCK_STATE, ...(await getLockState()) };
  const merged = mergeLockStates(current, sanitizeLockState(remote, now, MAX_LOCK_MS));
  const changed =
    JSON.stringify(merged) !==
    JSON.stringify({ ...current, schedulesUpdatedAt: current.schedulesUpdatedAt ?? 0 });
  if (changed) await writeLockState(merged);
  return changed;
}
