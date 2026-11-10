// Lock state store + the ONLY legal transitions. Lives in its own storage key
// (NOT inside Settings) so setSettings can reject writes while locked without
// the lock being patchable through the same door. Timer/frozen transitions are
// monotonic: extending is always allowed, shortening/cancelling never. Explicit
// releases clear only their own password/delay/random-text source; a running
// Frozen Turkey, schedule window, break operation, and every other gate survive.
//
// This is a SOFT lock: raw storage writes from devtools or uninstalling the
// extension bypass it. Accepted — the Phase 4 desktop companion reads this
// same key over Native Messaging and becomes the hard enforcer.
//
// Import direction: settings.ts imports lock.ts, NEVER the reverse.
import { api } from './api';
import {
  EMPTY_LOCK_STATE,
  armedDelayLock,
  armedRandomTextLength,
  clampDelayLockDuration,
  currentWindowEnd,
  deriveLockStatus,
  makeBreakOperation,
  mergeLockStates,
  sanitizeLockState,
  validateCategoryScheduleRule,
  validateScheduleRule,
} from './lock-math';
import type {
  CategoryScheduleRule,
  LockState,
  LockStatus,
  ScheduleRule,
} from './lock-math';

const STORAGE_KEY = 'lockState';
/** Last partner arm/release confirmed by the daemon. Kept separate from the
 * generic lock state so a raw `lockState` write (DevTools, a stale peer) can
 * change the generation without also forging the authorization. The daemon is
 * the only origin of these fields. */
const PARTNER_ARM_KEY = 'partnerArmState';
interface PartnerArmPin {
  generation: string | null;
  updatedAt: number;
}

/** Fat-finger cap on timer/frozen durations. */
export const MAX_LOCK_MS = 30 * 24 * 3_600_000;

let cache: LockState | null = null;

function parsePartnerArmPin(raw: unknown): PartnerArmPin | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { generation?: unknown; updatedAt?: unknown };
  const generation = value.generation;
  const updatedAt = value.updatedAt;
  if (
    generation !== null &&
    !(typeof generation === 'string' && /^[0-9a-f]{64}$/.test(generation))
  ) {
    return null;
  }
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    return null;
  }
  return { generation, updatedAt };
}

async function getPartnerArmPin(): Promise<PartnerArmPin | null> {
  const stored = await api.storage.local.get(PARTNER_ARM_KEY);
  return parsePartnerArmPin(stored[PARTNER_ARM_KEY]);
}

// Invalidate when any context (options page, popup) writes lock state, so a
// long-lived service worker / offscreen doc sees changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[STORAGE_KEY] || changes[PARTNER_ARM_KEY])) cache = null;
});

export async function getLockState(): Promise<LockState> {
  if (cache) return cache;
  const stored = await api.storage.local.get([STORAGE_KEY, PARTNER_ARM_KEY]);
  const state: LockState = { ...EMPTY_LOCK_STATE, ...(stored[STORAGE_KEY] as Partial<LockState> | undefined) };
  const pin = parsePartnerArmPin(stored[PARTNER_ARM_KEY]);
  if (pin) {
    state.partnerArmGeneration = pin.generation;
    state.partnerArmUpdatedAt = pin.updatedAt;
  }
  cache = state;
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

function gateNow(): number {
  const now = Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error('The system clock is unavailable.');
  return now;
}

/** Arm a delay gate without starting its countdown. The chosen wait is stored
 *  separately so it cannot be shortened by a later UI reload. */
export async function armDelayLock(durationMs: number): Promise<void> {
  const delayDurationMs = clampDelayLockDuration(durationMs);
  const state = await getLockState();
  if (armedDelayLock(state)) throw new Error('A delay lock is already armed.');
  await writeLockState({
    ...state,
    delayUntil: 0,
    delayDurationMs,
    delayUpdatedAt: gateNow(),
  });
}

/** Begin the one countdown for this arm operation. This changes no timerUntil
 *  or other independent gate and is legal only from the armed-waiting state. */
export async function startDelayUnlock(): Promise<LockStatus> {
  const now = gateNow();
  const state = await getLockState();
  const delay = armedDelayLock(state);
  if (!delay) throw new Error('A delay lock is not armed.');
  if (delay.until !== 0) throw new Error('The unlock countdown has already started.');
  await writeLockState({
    ...state,
    delayUntil: now + delay.durationMs,
    delayUpdatedAt: now,
  });
  return getLockStatus(now);
}

/** Cancel only the pending release attempt. The delay gate stays armed and
 *  must be started again; no independent lock or break field is touched. */
export async function cancelDelayUnlock(): Promise<LockStatus> {
  const now = gateNow();
  const state = await getLockState();
  const delay = armedDelayLock(state);
  if (!delay || delay.until === 0) throw new Error('No unlock countdown is running.');
  await writeLockState({ ...state, delayUntil: 0, delayUpdatedAt: now });
  return getLockStatus(now);
}

/** Background-only completion. Wall time is re-read on every call: reaching
 *  readiness does not by itself clear the gate and a stale alarm cannot win. */
export async function completeDelayUnlock(): Promise<LockStatus> {
  const now = gateNow();
  const state = await getLockState();
  const delay = armedDelayLock(state);
  if (!delay || delay.until === 0) throw new Error('No unlock countdown is running.');
  if (now < delay.until) throw new Error('The unlock delay has not elapsed yet.');
  await writeLockState({
    ...state,
    delayUntil: null,
    delayDurationMs: null,
    delayUpdatedAt: now,
  });
  return getLockStatus(now);
}

export async function armRandomTextLock(length: number): Promise<void> {
  const candidate: LockState = { ...EMPTY_LOCK_STATE, randomTextLen: length };
  const randomTextLen = armedRandomTextLength(candidate);
  if (randomTextLen === null) throw new Error('Random text length must be between 1 and 5,000.');
  const state = await getLockState();
  if (armedRandomTextLength(state) !== null) {
    throw new Error('A random-text lock is already armed.');
  }
  await writeLockState({
    ...state,
    randomTextLen,
    randomTextUpdatedAt: gateNow(),
  });
}

/** Release only the exact arm generation for which the background verified a
 *  challenge. Re-reading and comparing the stamp closes challenge/arm races. */
export async function releaseRandomTextLock(expectedArmStamp: number): Promise<LockStatus> {
  const now = gateNow();
  const state = await getLockState();
  if (
    armedRandomTextLength(state) === null ||
    !Number.isFinite(expectedArmStamp) ||
    (state.randomTextUpdatedAt ?? 0) !== expectedArmStamp
  ) {
    throw new Error('This unlock text belongs to an older lock. Request a fresh one.');
  }
  await writeLockState({ ...state, randomTextLen: null, randomTextUpdatedAt: now });
  return getLockStatus(now);
}

/** Force blocking ON for a duration — uncancellable by construction: no
 *  function in this module ever shortens frozenUntil. */
export async function startFrozenTurkey(durationMs: number): Promise<LockStatus> {
  const state = await getLockState();
  const until = Math.max(state.frozenUntil ?? 0, Date.now() + clampDuration(durationMs));
  await writeLockState({ ...state, frozenUntil: until });
  return getLockStatus();
}

/** Schedule a break without shortening any lock. delayMs > 0 creates a
 *  pending operation; wall-time derivation activates it at breakNotBefore. */
export async function startBreak(delayMs: number, durationMs: number): Promise<LockStatus> {
  const now = Date.now();
  const state = await getLockState();
  const status = deriveLockStatus(state, now);
  if (!status.settingsLocked) throw new Error('A break requires an active lock.');
  if (status.breakEndsAt !== null && status.breakEndsAt > now) {
    throw new Error('A break is already pending or active.');
  }
  await writeLockState({ ...state, ...makeBreakOperation(now, delayMs, durationMs) });
  return getLockStatus(now);
}

/** Re-block early by cancelling only the break operation. The fresh stamp is
 *  a tombstone: an older peer cannot restore the relaxed interval on merge. */
export async function cancelBreak(): Promise<LockStatus> {
  const state = await getLockState();
  await writeLockState({
    ...state,
    breakStartedAt: null,
    breakNotBefore: null,
    breakEndsAt: null,
    breakUpdatedAt: Date.now(),
  });
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

/** Replace only category-scoped windows. These never become settings locks or
 * global force-blocking reasons, but an active scope still cannot be deleted
 * as a shortcut around its selected-category block. */
export async function setCategorySchedules(rules: CategoryScheduleRule[]): Promise<void> {
  const now = Date.now();
  const state = await getLockState();
  if (deriveLockStatus(state, now).settingsLocked) {
    throw new Error('Schedules cannot be changed while SmartBlocker is locked.');
  }
  if (currentWindowEnd(state.categorySchedules ?? [], new Date(now)) !== null) {
    throw new Error('Category schedules cannot be changed while a category window is active.');
  }
  const ids = new Set<string>();
  for (const r of rules) {
    const problem = validateCategoryScheduleRule(r);
    if (problem) throw new Error(`Invalid category schedule: ${problem}`);
    if (ids.has(r.id)) throw new Error('Category schedule IDs must be unique.');
    ids.add(r.id);
  }
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pinned = rules.map((r) => ({
    ...r,
    tzOffsetMinutes: r.tzOffsetMinutes ?? tzOffsetMinutes,
    tzName: r.tzName ?? (typeof tzName === 'string' ? tzName.slice(0, 64) : undefined),
  }));
  await writeLockState({
    ...state,
    categorySchedules: pinned,
    categorySchedulesUpdatedAt: now,
  });
}

/** Fold the desktop companion's copy of the lock state into ours. Merge-only
 *  (monotonic — this can extend locks, never shorten them), with the remote
 *  input sanitized: it arrives over Native Messaging from another process.
 *  Returns whether our stored state changed; callers only re-broadcast on
 *  true, which is what keeps the extension↔companion sync from looping. */
/** Compare persisted values, not JavaScript property insertion order. Peers
 *  rebroadcast whenever merge reports a change, so treating reordered objects
 *  as different would cause redundant writes and sync loops. Array order stays
 *  significant (schedule order is part of the merge result). */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested) => {
      if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return nested;
      return Object.fromEntries(
        Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }) ?? ''
  );
}

export async function mergeRemoteLockState(remote: unknown): Promise<boolean> {
  const now = Date.now();
  const current = { ...EMPTY_LOCK_STATE, ...(await getLockState()) };
  const sanitizedRemote = sanitizeLockState(remote, now, MAX_LOCK_MS);
  const merged = mergeLockStates(current, sanitizedRemote, now);
  // The daemon originates every partner arm/release, so its fields win over a
  // forged or stale local LWW stamp. Without this, a raw
  // `{partnerArmGeneration: null}` write would unlock settings locally while
  // the daemon stayed armed, and a legitimate release could be outranked by a
  // future local stamp.
  const hasPartner =
    sanitizedRemote.partnerArmGeneration !== undefined ||
    sanitizedRemote.partnerArmUpdatedAt !== undefined;
  if (hasPartner) {
    merged.partnerArmGeneration = sanitizedRemote.partnerArmGeneration ?? null;
    merged.partnerArmUpdatedAt = sanitizedRemote.partnerArmUpdatedAt ?? 0;
  }
  const raw = await api.storage.local.get(STORAGE_KEY);
  const rawState = raw[STORAGE_KEY] as Partial<LockState> | undefined;
  const rawGeneration = rawState?.partnerArmGeneration ?? null;
  const rawUpdatedAt = rawState?.partnerArmUpdatedAt ?? 0;
  const partnerRepair = hasPartner && (
    rawGeneration !== (merged.partnerArmGeneration ?? null) ||
    rawUpdatedAt !== (merged.partnerArmUpdatedAt ?? 0)
  );
  const changed =
    partnerRepair ||
    canonicalJson(merged) !==
      canonicalJson({
        ...current,
        breakUpdatedAt: current.breakUpdatedAt ?? 0,
        passwordTs: current.passwordTs ?? 0,
        schedulesUpdatedAt: current.schedulesUpdatedAt ?? 0,
      });
  const pin = hasPartner
    ? {
        generation: merged.partnerArmGeneration ?? null,
        updatedAt: merged.partnerArmUpdatedAt ?? 0,
      }
    : null;
  const existingPin = pin ? await getPartnerArmPin() : null;
  const pinChanged = pin !== null && (
    !existingPin ||
    existingPin.generation !== pin.generation ||
    existingPin.updatedAt !== pin.updatedAt
  );
  if (changed || pinChanged) {
    cache = merged;
    const payload: Record<string, unknown> = { [STORAGE_KEY]: merged };
    if (pin) payload[PARTNER_ARM_KEY] = pin;
    await api.storage.local.set(payload);
  }
  return changed || pinChanged;
}
