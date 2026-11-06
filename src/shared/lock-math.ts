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
  /** Timezone the window times are pinned to: minutes EAST of UTC (e.g. 330
   *  = UTC+05:30), captured when the rule was written (lock.ts setSchedules).
   *  Present: the rule evaluates against this FIXED offset, so changing the
   *  device timezone cannot sidestep a window (red-team #26). Absent:
   *  legacy rule — evaluates in the device's CURRENT timezone (old
   *  behavior); setSchedules backfills the current offset for those.
   *
   *  KNOWN RESIDUAL — a fixed offset cannot encode DST: a rule pinned while
   *  the zone is on standard time fires one hour off (relative to civil
   *  time) after a daylight-saving change, forever. This is deliberate: the
   *  Rust mirror builds offline with no IANA tz database vendored, and a
   *  one-hour civil drift beats a one-line timezone bypass. The window still
   *  fires at the same absolute times every day, which is the property a
   *  block schedule actually needs. */
  tzOffsetMinutes?: number | null;
  /** IANA name of the pinned zone (e.g. "America/New_York"), display-only —
   *  evaluation uses ONLY tzOffsetMinutes. */
  tzName?: string;
}

/** Persisted shape (storage.local `lockState`). Sources are independent and
 *  compose — a frozen session and a schedule window can be active at once. */
export interface LockState {
  /** Timer lock: settings frozen until this epoch ms. */
  timerUntil: number | null;
  /** Password lock: salted SHA-256 hex. Non-null = armed (indefinite). */
  passwordHash: string | null;
  /** Arm/unlock stamp (epoch ms; absent = 0, legacy). Arm stamps on set and
   *  unlock stamps on clear, so a fresh "unlocked" tombstone beats an older
   *  armed hash in the merge — password unlocks propagate to the companion
   *  instead of being re-armed by its copy a heartbeat later. */
  passwordTs?: number;
  /** Frozen Turkey session end (epoch ms) — also forces blocking on. */
  frozenUntil: number | null;
  /** Recurring locked windows — active windows also force blocking on. */
  schedules: ScheduleRule[];
  /** When `schedules` was last replaced (epoch ms; absent = 0). Only used by
   *  mergeLockStates: schedule edits happen exclusively while unlocked, so
   *  last-writer-wins is safe — a plain union would resurrect deleted rules.
   *  Sanitized to `<= now`: a forged future stamp would hold the list
   *  hostage, rejecting every honest write for days. */
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

/** Epoch ms of the window-day midnight `dayOffset` days from the day
 *  containing `nowMs`, PLUS the weekday that midnight lands on — computed in
 *  the rule's own timezone frame. A rule pinned to `tzOffsetMinutes`
 *  evaluates against that fixed offset, so its "wall clock" is
 *  `nowMs + offset` read in the UTC frame (immune to device tz changes; no
 *  DST — see the field doc). A legacy (unpinned) rule uses the device's
 *  CURRENT zone, the behavior predating red-team fix #26. Mirrors
 *  `local_midnight`+`pinned_offset` dispatch in lock_math.rs. */
function ruleDayStart(
  r: ScheduleRule,
  nowMs: number,
  dayOffset: number,
): { start: number; weekday: number } {
  if (typeof r.tzOffsetMinutes === 'number' && Number.isInteger(r.tzOffsetMinutes)) {
    const offMs = r.tzOffsetMinutes * 60_000;
    // Rule-local wall instant, read in the UTC frame.
    const local = new Date(nowMs + offMs);
    const frame = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset);
    return { start: frame - offMs, weekday: new Date(frame).getUTCDay() };
  }
  const dayStart = midnight(new Date(nowMs), dayOffset);
  return { start: dayStart, weekday: new Date(dayStart).getDay() };
}

/** End (epoch ms) of the window under rule `r` containing `nowMs`, or null.
 *  A containing window can only have started today or (overnight) yesterday
 *  (today/yesterday in the RULE's own tz frame when pinned). */
function ruleWindowEnd(r: ScheduleRule, nowMs: number): number | null {
  const dur = windowDurationMs(r);
  if (dur <= 0) return null;
  for (const offset of [0, -1]) {
    const day = ruleDayStart(r, nowMs, offset);
    if (!r.days.includes(day.weekday)) continue;
    const start = day.start + r.startMinutes * 60_000;
    if (nowMs >= start && nowMs < start + dur) return start + dur;
  }
  return null;
}

/** End (epoch ms) of the latest-ending window containing `date`, or null. */
export function currentWindowEnd(rules: ScheduleRule[], date: Date): number | null {
  const nowMs = date.getTime();
  let max: number | null = null;
  for (const r of rules) {
    const end = ruleWindowEnd(r, nowMs);
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
  for (const r of state.schedules) {
    const dur = windowDurationMs(r);
    if (dur <= 0) continue;
    // From yesterday (an in-progress overnight window still has its end
    // ahead) through a full week ahead — covers week wraparound. Days are
    // counted in the rule's own tz frame (pinned offset or device zone).
    for (let offset = -1; offset <= 7; offset++) {
      const day = ruleDayStart(r, now, offset);
      if (!r.days.includes(day.weekday)) continue;
      const start = day.start + r.startMinutes * 60_000;
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

/** Merge two lock states (commutative, idempotent — the desktop companion
 *  and the extension each keep a copy and converge by merging, so syncing
 *  never locks the two sides into disagreement). `now` is needed because the
 *  schedule rule consults activeness. Password and timer/frozen sources stay
 *  monotonic (merge can never SHORTEN them); the password arm/unlock and the
 *  schedule list are the two deliberate exceptions: unlocks and schedule
 *  edits must propagate, so those two carry timestamps and the newer write
 *  wins. Mirrored by `merge.rs` in the companion; change both together,
 *  covered by the shared fixtures in
 *  companion/crates/smartblocker-core/tests/fixtures/lock-cases.json. */
export function mergeLockStates(a: LockState, b: LockState, now: number): LockState {
  const maxNullable = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.max(x, y);

  // Password: timestamped arm/unlock (tombstone CRDT). The greater stamp
  // wins — a fresh unlock (hash null) beats an older arm, and re-arming
  // later beats the old tombstone. At a stamp tie an armed hash beats an
  // empty one (fail-safe), and two armed hashes keep the lexicographically
  // smaller so legacy (stamp-less, 0) peers still converge deterministically.
  const aPwTs = a.passwordTs ?? 0;
  const bPwTs = b.passwordTs ?? 0;
  let passwordHash: string | null;
  if (aPwTs !== bPwTs) {
    passwordHash = (aPwTs > bPwTs ? a : b).passwordHash;
  } else if (a.passwordHash === b.passwordHash) {
    passwordHash = a.passwordHash;
  } else if (a.passwordHash === null || b.passwordHash === null) {
    passwordHash = a.passwordHash ?? b.passwordHash;
  } else {
    passwordHash = a.passwordHash < b.passwordHash ? a.passwordHash : b.passwordHash;
  }

  // Schedules: edits are refused while locked (lock.ts setSchedules), so the
  // only way a peer's list changes mid-lock is a forged/wiped write. If
  // exactly one side is locked, the LOCKED side's list wins — a browser
  // whose storage.local was wiped (DevTools) is no longer locked by its own
  // state, loses to the daemon's intact copy, and re-syncs it right back.
  // The rule is symmetric, so the merge stays commutative. Otherwise the
  // newer stamp wins entirely (deletion must not resurrect rules), with a
  // deterministic union for legacy equal-stamp convergence.
  const aLocked = deriveLockStatus(a, now).settingsLocked;
  const bLocked = deriveLockStatus(b, now).settingsLocked;
  const aTs = a.schedulesUpdatedAt ?? 0;
  const bTs = b.schedulesUpdatedAt ?? 0;
  let schedules: ScheduleRule[];
  let schedulesUpdatedAt: number;
  if (aLocked !== bLocked) {
    const winner = aLocked ? a : b;
    schedules = winner.schedules;
    schedulesUpdatedAt = aLocked ? aTs : bTs;
  } else if (aTs !== bTs) {
    const winner = aTs > bTs ? a : b;
    schedules = winner.schedules;
    schedulesUpdatedAt = Math.max(aTs, bTs);
  } else {
    // Equal timestamps (typically both legacy 0): deterministic union by id.
    // A same-id content conflict picks the canonically smaller rule so the
    // union stays commutative regardless of argument order. The tz fields are
    // part of the content: two same-id rules pinned to different zones must
    // still converge to ONE rule on both sides.
    const canon = (r: ScheduleRule) =>
      `${r.startMinutes}|${r.endMinutes}|${[...r.days].sort((x, y) => x - y).join(',')}|` +
      `${r.tzOffsetMinutes ?? ''}|${r.tzName ?? ''}`;
    const byId = new Map<string, ScheduleRule>();
    for (const r of [...a.schedules, ...b.schedules]) {
      const prev = byId.get(r.id);
      if (!prev || canon(r) < canon(prev)) byId.set(r.id, r);
    }
    schedules = [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    schedulesUpdatedAt = aTs;
  }
  return {
    timerUntil: maxNullable(a.timerUntil, b.timerUntil),
    passwordHash,
    passwordTs: Math.max(aPwTs, bPwTs),
    frozenUntil: maxNullable(a.frozenUntil, b.frozenUntil),
    schedules,
    schedulesUpdatedAt,
  };
}

/** Coerce untrusted input (the companion talks over Native Messaging) into a
 *  well-formed LockState: wrong types dropped, invalid rules dropped, end
 *  timestamps clamped to `now` + maxLockMs so a bad peer cannot lock forever.
 *  The two metadata stamps are clamped to `now` — they order
 *  last-writer-wins merges, so a forged FUTURE stamp must never be admitted:
 *  it would outrank every honest write until that date arrived. */
export function sanitizeLockState(raw: unknown, now: number, maxLockMs: number): LockState {
  const o = (raw ?? {}) as Record<string, unknown>;
  const cap = now + maxLockMs;
  const until = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, cap) : null;
  const stamp = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, now) : 0;
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
    passwordTs: stamp(o.passwordTs),
    frozenUntil: until(o.frozenUntil),
    schedules,
    schedulesUpdatedAt: stamp(o.schedulesUpdatedAt),
  };
}

/** Returns a human-readable problem, or null when the rule is valid. Ranges
 *  for the tz pin match the real world (UTC−12:00 … UTC+14:00) and are
 *  mirrored by `validate_schedule_rule` in lock_math.rs — sanitize paths in
 *  both languages drop rules failing ANY of these checks. */
export function validateScheduleRule(r: ScheduleRule): string | null {
  if (!Array.isArray(r.days) || r.days.length === 0) return 'Pick at least one day.';
  if (r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Days must be 0–6.';
  const validMinute = (m: number) => Number.isInteger(m) && m >= 0 && m <= 1439;
  if (!validMinute(r.startMinutes) || !validMinute(r.endMinutes)) {
    return 'Times must fall within one day.';
  }
  if (r.startMinutes === r.endMinutes) return 'Start and end times must differ.';
  if (
    r.tzOffsetMinutes !== undefined &&
    r.tzOffsetMinutes !== null &&
    (!Number.isInteger(r.tzOffsetMinutes) || r.tzOffsetMinutes < -720 || r.tzOffsetMinutes > 840)
  ) {
    return 'Timezone offset must be between UTC−12:00 and UTC+14:00.';
  }
  if (r.tzName !== undefined && (typeof r.tzName !== 'string' || r.tzName.length > 64)) {
    return 'Timezone name must be a short string.';
  }
  return null;
}
