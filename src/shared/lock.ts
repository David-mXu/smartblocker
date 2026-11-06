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

// ---- Password hashing (red-team #21) ----
// v1 (legacy): a single unsalted SHA-256 of 'smartblocker-lock:'+pw.
// v2: PBKDF2-SHA256, 210k iterations (OWASP floor), 16-byte random
//     per-install salt, hex-encoded 256-bit output.
//
// Storage layout: the salt/iterations live in a SEPARATE storage key
// ('lockKdf'), deliberately OUTSIDE the merged 'lockState' CRDT — the desktop
// companion sanitizes passwordHash as ^[0-9a-f]{64}$ and merges it as an
// opaque string, so the hash itself must stay a bare 64-hex value with no
// embedded scheme marker. The scheme is therefore implied by lockKdf:
// lockKdf.v === 2 → passwordHash is v2; absent → legacy v1. Companion sync
// only ever forwards the 'lockState' key, so the salt can never leak into a
// lockStateSync frame or the daemon's merge.

/** Storage key for the KDF parameters (salt + iterations). Never synced. */
const KDF_STORAGE_KEY = 'lockKdf';
/** Minimum password length for NEW arms (legacy short passwords still unlock). */
export const MIN_PASSWORD_LENGTH = 8;
/** PBKDF2-SHA256 iteration count for v2 hashes (OWASP floor for SHA-256). */
export const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;

type LockKdfParams = { salt: string; iterations: number; v: number };

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf as ArrayBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomSaltHex(): string {
  const bytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Legacy v1 hash: a single unsalted SHA-256. Retained for verification of
 *  pre-upgrade locks (and mirrored by the companion security PoCs); new arms
 *  never use it. */
export async function hashPassword(pw: string): Promise<string> {
  const data = new TextEncoder().encode('smartblocker-lock:' + pw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/** v2 hash: PBKDF2-SHA256 over the same domain-separated password string.
 *  Pure WebCrypto — safe in the service worker, offscreen doc, and Node. */
export async function pbkdf2HashHex(
  pw: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('smartblocker-lock:' + pw),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
    key,
    256,
  );
  return toHex(bits);
}

async function getKdfParams(): Promise<LockKdfParams | null> {
  const stored = await api.storage.local.get(KDF_STORAGE_KEY);
  const k = stored[KDF_STORAGE_KEY] as Partial<LockKdfParams> | undefined;
  if (
    k &&
    k.v === 2 &&
    typeof k.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(k.salt) &&
    Number.isInteger(k.iterations) &&
    (k.iterations as number) >= 1
  ) {
    return { salt: k.salt, iterations: k.iterations as number, v: 2 };
  }
  return null;
}

/** Legacy → v2 rehash, run ONLY after a successful legacy verify: a fresh
 *  salt goes to lockKdf and the hash is re-armed with a fresh passwordTs so
 *  the upgrade wins the companion merge (one-way, silent). */
async function migrateToV2Hash(pw: string): Promise<void> {
  const kdf: LockKdfParams = {
    salt: randomSaltHex(),
    iterations: PBKDF2_ITERATIONS,
    v: 2,
  };
  await api.storage.local.set({ [KDF_STORAGE_KEY]: kdf });
  const state = await getLockState();
  await writeLockState({
    ...state,
    passwordHash: await pbkdf2HashHex(pw, kdf.salt, kdf.iterations),
    passwordTs: Date.now(),
  });
}

/** Verify a password against the armed hash WITHOUT unlocking. Tries the v2
 *  scheme first (when lockKdf is present), then the legacy hash — a legacy
 *  hash can still be armed on an upgraded install (never migrated yet, or
 *  re-adopted from an older peer via the opaque CRDT merge). A successful
 *  LEGACY verify migrates the stored hash to v2 in place. Wrong passwords
 *  never write anything. */
export async function verifyPassword(password: string): Promise<boolean> {
  const state = await getLockState();
  if (!state.passwordHash) return true;
  const pw = password.trim();
  const kdf = await getKdfParams();
  if (kdf && (await pbkdf2HashHex(pw, kdf.salt, kdf.iterations)) === state.passwordHash) {
    return true;
  }
  if ((await hashPassword(pw)) !== state.passwordHash) return false;
  await migrateToV2Hash(pw);
  return true;
}

/** Arm the indefinite password lock. Overwriting an armed hash would BE an
 *  unlock, so arming twice throws. New arms are always v2. */
export async function armPasswordLock(password: string): Promise<void> {
  const pw = password.trim();
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const state = await getLockState();
  if (state.passwordHash) throw new Error('A password lock is already armed.');
  // Write the salt BEFORE the hash: an interrupted arm that leaves only an
  // orphan salt behind is harmless (the next arm re-mints it), whereas a v2
  // hash whose salt never landed would verify as legacy and never unlock.
  const kdf: LockKdfParams = {
    salt: randomSaltHex(),
    iterations: PBKDF2_ITERATIONS,
    v: 2,
  };
  await api.storage.local.set({ [KDF_STORAGE_KEY]: kdf });
  await writeLockState({
    ...state,
    passwordHash: await pbkdf2HashHex(pw, kdf.salt, kdf.iterations),
    passwordTs: Date.now(),
  });
}

/** Clears ONLY the password source on a match — timer, Frozen Turkey, and
 *  schedule windows all survive a password unlock. */
export async function attemptPasswordUnlock(password: string): Promise<boolean> {
  const state = await getLockState();
  if (!state.passwordHash) return true;
  if (!(await verifyPassword(password))) return false;
  // Tombstone: the unlock must WIN the companion merge, so clearing the hash
  // stamps passwordTs — otherwise the peer's armed copy re-arms us on sync.
  // Re-read: a legacy→v2 migration inside verifyPassword just rewrote state.
  await writeLockState({ ...(await getLockState()), passwordHash: null, passwordTs: Date.now() });
  return true;
}

/** Replace the schedule rules. Refused while any lock is active — otherwise
 *  deleting a rule mid-window would cancel it. (Tighten-only diffing is v2.)
 *
 *  This is the ONLY legal schedule write path, so every rule is pinned here
 *  to the timezone it was authored in (red-team #26): rules missing
 *  `tzOffsetMinutes` are legacy or UI-fresh and get the device's CURRENT
 *  offset, after which changing the device timezone no longer moves their
 *  windows. A rule re-edited in a new timezone comes in with that zone's
 *  offset already set by the caller. Known residual: the pin is a FIXED
 *  offset (no IANA database on the Rust mirror's offline build), so a window
 *  drifts one hour from civil time across a DST change — see the field doc
 *  in lock-math.ts. */
export async function setSchedules(rules: ScheduleRule[]): Promise<void> {
  if ((await getLockStatus()).settingsLocked) {
    throw new Error('Schedules cannot be changed while SmartBlocker is locked.');
  }
  for (const r of rules) {
    const problem = validateScheduleRule(r);
    if (problem) throw new Error(`Invalid schedule: ${problem}`);
  }
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pinned = rules.map((r) => ({
    ...r,
    tzOffsetMinutes: r.tzOffsetMinutes ?? tzOffsetMinutes,
    tzName: r.tzName ?? (typeof tzName === 'string' ? tzName.slice(0, 64) : undefined),
  }));
  await writeLockState({
    ...(await getLockState()),
    schedules: pinned,
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
  const merged = mergeLockStates(current, sanitizeLockState(remote, now, MAX_LOCK_MS), now);
  const changed =
    JSON.stringify(merged) !==
    JSON.stringify({
      ...current,
      passwordTs: current.passwordTs ?? 0,
      schedulesUpdatedAt: current.schedulesUpdatedAt ?? 0,
    });
  if (changed) await writeLockState(merged);
  return changed;
}
