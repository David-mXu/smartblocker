// Pure lock/schedule time math — no browser APIs, no storage, no imports.
// Correctness of the whole lock system rests on these derivations being pure
// functions of (state, now): MV3 service workers sleep, so activeness is
// re-derived on every check instead of trusting timers. Keep this file free
// of non-erasable TS syntax (no enums, no parameter properties) so
// scripts/lock-math-test.mjs can import it directly under Node type stripping.

export interface ScheduleRule {
  id: string;
  /** Days the window STARTS on: 0–6, Sunday = 0 (matches Date.getDay()). */
  days: number[];
  /** Minutes since local midnight, 0..1439. */
  startMinutes: number;
  /** 0..1439. endMinutes < startMinutes = overnight window into the next day. */
  endMinutes: number;
}

/** Persisted shape (storage.local `lockState`). Sources are independent and
 *  compose — a frozen session and a schedule window can be active at once. */
export interface LockState {
  /** Timer lock: settings frozen until this epoch ms. */
  timerUntil: number | null;
  /** Password lock: salted SHA-256 hex. Non-null = armed (indefinite). */
  passwordHash: string | null;
  /** Frozen Turkey session end (epoch ms) — also forces blocking on. */
  frozenUntil: number | null;
  /** Recurring locked windows — active windows also force blocking on. */
  schedules: ScheduleRule[];
  /** When `schedules` was last replaced (epoch ms; absent = 0). Only used by
   *  mergeLockStates: schedule edits happen exclusively while unlocked, so
   *  last-writer-wins is safe — a plain union would resurrect deleted rules. */
  schedulesUpdatedAt?: number;
}

export interface LockStatus {
  /** Any source active: settings frozen, block-screen bypass hidden. */
  settingsLocked: boolean;
  /** Frozen Turkey or an in-window schedule: blocking runs even if the
   *  master toggle is off, and stored overrides are ignored. */
  forceBlocking: boolean;
  reasons: ('timer' | 'password' | 'frozen' | 'schedule')[];
  /** When the current lock fully ends; null = indefinite (password armed)
   *  or nothing active. */
  until: number | null;
}

export const EMPTY_LOCK_STATE: LockState = {
  timerUntil: null,
  passwordHash: null,
  frozenUntil: null,
  schedules: [],
};

/** Window length in ms; end < start wraps overnight. start === end is an
 *  invalid (empty) rule and yields 0. */
function windowDurationMs(r: ScheduleRule): number {
  return ((r.endMinutes - r.startMinutes + 1440) % 1440) * 60_000;
}

/** Local midnight of `date` shifted by whole days (DST-safe via Date math). */
function midnight(date: Date, dayOffset: number): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).getTime();
}

/** End (epoch ms) of the window under rule `r` containing `date`, or null.
 *  A containing window can only have started today or (overnight) yesterday. */
function ruleWindowEnd(r: ScheduleRule, date: Date): number | null {
  const t = date.getTime();
  const dur = windowDurationMs(r);
  if (dur <= 0) return null;
  for (const offset of [0, -1]) {
    const dayStart = midnight(date, offset);
    if (!r.days.includes(new Date(dayStart).getDay())) continue;
    const start = dayStart + r.startMinutes * 60_000;
    if (t >= start && t < start + dur) return start + dur;
  }
  return null;
}

/** End (epoch ms) of the latest-ending window containing `date`, or null. */
export function currentWindowEnd(rules: ScheduleRule[], date: Date): number | null {
  let max: number | null = null;
  for (const r of rules) {
    const end = ruleWindowEnd(r, date);
    if (end !== null && (max === null || end > max)) max = end;
  }
  return max;
}

export function isInScheduleWindow(rules: ScheduleRule[], date: Date): boolean {
  return currentWindowEnd(rules, date) !== null;
}

/** Next start-or-end instant strictly after `now` across all sources, or
 *  null when nothing is pending. Drives the promptness-only boundary alarm. */
export function nextBoundary(state: LockState, now: number): number | null {
  const candidates: number[] = [];
  if (state.timerUntil !== null && state.timerUntil > now) candidates.push(state.timerUntil);
  if (state.frozenUntil !== null && state.frozenUntil > now) candidates.push(state.frozenUntil);
  const nowDate = new Date(now);
  for (const r of state.schedules) {
    const dur = windowDurationMs(r);
    if (dur <= 0) continue;
    // From yesterday (an in-progress overnight window still has its end
    // ahead) through a full week ahead — covers week wraparound.
    for (let offset = -1; offset <= 7; offset++) {
      const dayStart = midnight(nowDate, offset);
      if (!r.days.includes(new Date(dayStart).getDay())) continue;
      const start = dayStart + r.startMinutes * 60_000;
      if (start > now) candidates.push(start);
      if (start + dur > now) candidates.push(start + dur);
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

export function deriveLockStatus(state: LockState, now: number): LockStatus {
  const reasons: LockStatus['reasons'] = [];
  const ends: number[] = [];
  if (state.timerUntil !== null && state.timerUntil > now) {
    reasons.push('timer');
    ends.push(state.timerUntil);
  }
  if (state.passwordHash) reasons.push('password');
  if (state.frozenUntil !== null && state.frozenUntil > now) {
    reasons.push('frozen');
    ends.push(state.frozenUntil);
  }
  const windowEnd = currentWindowEnd(state.schedules, new Date(now));
  if (windowEnd !== null) {
    reasons.push('schedule');
    ends.push(windowEnd);
  }
  return {
    settingsLocked: reasons.length > 0,
    forceBlocking: windowEnd !== null || reasons.includes('frozen'),
    reasons,
    until: state.passwordHash ? null : ends.length ? Math.max(...ends) : null,
  };
}

/** Merge two lock states monotonically (commutative, idempotent — the
 *  desktop companion and the extension each keep a copy and converge by
 *  merging, so neither side can shorten a lock by syncing). Mirrored by
 *  `merge.rs` in the companion; change both together, covered by the shared
 *  fixtures in companion/crates/smartblocker-core/tests/fixtures/lock-cases.json. */
export function mergeLockStates(a: LockState, b: LockState): LockState {
  const maxNullable = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.max(x, y);
  // Armed if either armed; on conflicting hashes pick the lexicographically
  // smaller so the merge stays commutative (either password then unlocks).
  const passwordHash =
    a.passwordHash === null
      ? b.passwordHash
      : b.passwordHash === null
        ? a.passwordHash
        : a.passwordHash < b.passwordHash
          ? a.passwordHash
          : b.passwordHash;
  const aTs = a.schedulesUpdatedAt ?? 0;
  const bTs = b.schedulesUpdatedAt ?? 0;
  let schedules: ScheduleRule[];
  if (aTs > bTs) schedules = a.schedules;
  else if (bTs > aTs) schedules = b.schedules;
  else {
    // Equal timestamps (typically both legacy 0): deterministic union by id.
    // A same-id content conflict picks the canonically smaller rule so the
    // union stays commutative regardless of argument order.
    const canon = (r: ScheduleRule) =>
      `${r.startMinutes}|${r.endMinutes}|${[...r.days].sort((x, y) => x - y).join(',')}`;
    const byId = new Map<string, ScheduleRule>();
    for (const r of [...a.schedules, ...b.schedules]) {
      const prev = byId.get(r.id);
      if (!prev || canon(r) < canon(prev)) byId.set(r.id, r);
    }
    schedules = [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }
  return {
    timerUntil: maxNullable(a.timerUntil, b.timerUntil),
    passwordHash,
    frozenUntil: maxNullable(a.frozenUntil, b.frozenUntil),
    schedules,
    schedulesUpdatedAt: Math.max(aTs, bTs),
  };
}

/** Coerce untrusted input (the companion talks over Native Messaging) into a
 *  well-formed LockState: wrong types dropped, invalid rules dropped, end
 *  timestamps clamped to `now` + maxLockMs so a bad peer cannot lock forever. */
export function sanitizeLockState(raw: unknown, now: number, maxLockMs: number): LockState {
  const o = (raw ?? {}) as Record<string, unknown>;
  const cap = now + maxLockMs;
  const until = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, cap) : null;
  const schedules = Array.isArray(o.schedules)
    ? (o.schedules as ScheduleRule[]).filter(
        (r) =>
          r !== null &&
          typeof r === 'object' &&
          typeof r.id === 'string' &&
          validateScheduleRule(r) === null,
      )
    : [];
  return {
    timerUntil: until(o.timerUntil),
    passwordHash:
      typeof o.passwordHash === 'string' && /^[0-9a-f]{64}$/.test(o.passwordHash)
        ? o.passwordHash
        : null,
    frozenUntil: until(o.frozenUntil),
    schedules,
    schedulesUpdatedAt:
      typeof o.schedulesUpdatedAt === 'number' &&
      Number.isFinite(o.schedulesUpdatedAt) &&
      o.schedulesUpdatedAt > 0
        ? Math.min(o.schedulesUpdatedAt, cap)
        : 0,
  };
}

/** Returns a human-readable problem, or null when the rule is valid. */
export function validateScheduleRule(r: ScheduleRule): string | null {
  if (!Array.isArray(r.days) || r.days.length === 0) return 'Pick at least one day.';
  if (r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Days must be 0–6.';
  const validMinute = (m: number) => Number.isInteger(m) && m >= 0 && m <= 1439;
  if (!validMinute(r.startMinutes) || !validMinute(r.endMinutes)) {
    return 'Times must fall within one day.';
  }
  if (r.startMinutes === r.endMinutes) return 'Start and end times must differ.';
  return null;
}
