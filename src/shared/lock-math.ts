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
