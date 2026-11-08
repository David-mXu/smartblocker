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
export const MAX_BREAK_MS = 24 * 3_600_000;
export const MIN_DELAY_LOCK_MS = 60_000;
export const MAX_DELAY_LOCK_MS = 40 * 24 * 3_600_000;
export const MIN_RANDOM_TEXT_LOCK_LENGTH = 1;
export const MAX_RANDOM_TEXT_LOCK_LENGTH = 5_000;

export interface LockState {
  /** When this break operation was requested. All three nullable break
   *  timestamps are one operation, merged together by breakUpdatedAt. */
  breakStartedAt?: number | null;
  /** Delayed activation instant; null means the break starts immediately. */
  breakNotBefore?: number | null;
  /** When classifier-driven blocking resumes (strict end boundary). */
  breakEndsAt?: number | null;
  /** Last-writer-wins operation stamp. A newer all-null operation is a
   *  cancellation tombstone, so a stale peer cannot resurrect the break. */
  breakUpdatedAt?: number;
  /** Timer lock: settings frozen until this epoch ms. */
  timerUntil: number | null;
  /** Password lock: salted SHA-256 hex. Non-null = armed (indefinite). */
  passwordHash: string | null;
  /** Arm/unlock stamp (epoch ms; absent = 0, legacy). Arm stamps on set and
   *  unlock stamps on clear, so a fresh "unlocked" tombstone beats an older
   *  armed hash in the merge — password unlocks propagate to the companion
   *  instead of being re-armed by its copy a heartbeat later. */
  passwordTs?: number;
  /** Delay lock: null = unarmed/released tombstone, 0 = armed and waiting for
   *  the user to start unlocking, positive = wall-clock unlock deadline.
   *  Reaching the deadline makes the gate READY, not unlocked; the background
   *  must complete the release RPC. */
  delayUntil?: number | null;
  /** Immutable wait chosen when the delay gate was armed. Keeping this beside
   *  delayUntil prevents a reload from silently choosing a shorter delay. */
  delayDurationMs?: number | null;
  /** Whole-gate LWW stamp. A newer null operation is a release tombstone. */
  delayUpdatedAt?: number;
  /** Random-text lock: non-null = armed; one fresh background challenge of
   *  exactly this many symbols is required for release. */
  randomTextLen?: number | null;
  /** Whole-gate LWW stamp and challenge-generation binding. Re-arming changes
   *  this stamp, invalidating every challenge minted for an earlier arm. */
  randomTextUpdatedAt?: number;
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
  /** True only inside the validated break interval. This never changes
   *  settingsLocked, forceBlocking, reasons, or until. */
  breakActive: boolean;
  breakStartedAt: number | null;
  breakNotBefore: number | null;
  breakEndsAt: number | null;
  /** Any source active: settings frozen, block-screen bypass hidden. */
  settingsLocked: boolean;
  /** Frozen Turkey or an in-window schedule: blocking runs even if the
   *  master toggle is off, and stored overrides are ignored. */
  forceBlocking: boolean;
  reasons: ('timer' | 'password' | 'delay' | 'random-text' | 'frozen' | 'schedule')[];
  /** When the current lock fully ends; null = indefinite (password or an
   *  explicit-release delay/random-text gate armed) or nothing active. */
  until: number | null;
  /** Present only while the corresponding NEW gate is armed. Omitting them
   *  for legacy/released states keeps pre-existing exact status results. */
  delayUntil?: number | null;
  delayDurationMs?: number | null;
  delayReady?: boolean;
  randomTextLen?: number | null;
}

export const EMPTY_LOCK_STATE: LockState = {
  breakStartedAt: null,
  breakNotBefore: null,
  breakEndsAt: null,
  timerUntil: null,
  passwordHash: null,
  frozenUntil: null,
  schedules: [],
};

/** Validate and return the full break interval, including a pending delay.
 *  The requested timestamp anchors the operation; activation is notBefore
 *  when present. Invalid/partial shapes have no interval at all. */
function breakInterval(state: LockState): { start: number; end: number } | null {
  const requestedAt = state.breakStartedAt ?? null;
  const notBefore = state.breakNotBefore ?? null;
  const endsAt = state.breakEndsAt ?? null;
  if (requestedAt === null || endsAt === null) return null;
  if (
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(endsAt) ||
    (notBefore !== null && !Number.isFinite(notBefore)) ||
    requestedAt <= 0 ||
    endsAt <= 0 ||
    (notBefore !== null && (notBefore < requestedAt || notBefore <= 0))
  ) {
    return null;
  }
  const start = notBefore ?? requestedAt;
  if (endsAt <= start || endsAt - start > MAX_BREAK_MS) return null;
  return { start, end: endsAt };
}

/** Active interval is [requested/delayed start, re-block), derived purely
 *  from wall time so an MV3 restart cannot strand a break open or closed. */
export function activeBreakInterval(
  state: LockState,
  now: number,
): { start: number; end: number } | null {
  const interval = breakInterval(state);
  return interval && now >= interval.start && now < interval.end ? interval : null;
}

/** Build a complete pending/active break operation. Delay and re-block share
 *  a 24h anti-fat-finger horizon; this changes no lock timestamp. */
export function makeBreakOperation(
  now: number,
  delayMs: number,
  durationMs: number,
): Pick<LockState, 'breakStartedAt' | 'breakNotBefore' | 'breakEndsAt' | 'breakUpdatedAt'> {
  if (!Number.isFinite(now) || now <= 0) throw new Error('Invalid break start time.');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Break delay cannot be negative.');
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Break duration must be positive.');
  }
  const delay = Math.min(Math.floor(delayMs), MAX_BREAK_MS);
  const duration = Math.min(Math.ceil(durationMs), MAX_BREAK_MS);
  const start = now + delay;
  const end = Math.min(start + duration, now + MAX_BREAK_MS);
  if (end <= start) throw new Error('Break delay leaves no time for a break.');
  return {
    breakStartedAt: now,
    breakNotBefore: delay > 0 ? start : null,
    breakEndsAt: end,
    breakUpdatedAt: now,
  };
}

/** Validate the configured wait without trusting caller-provided numbers. */
export function clampDelayLockDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Unlock delay must be between 1 minute and 40 days.');
  }
  return Math.min(MAX_DELAY_LOCK_MS, Math.max(MIN_DELAY_LOCK_MS, Math.round(durationMs)));
}

/** Armed delay operations include waiting (0), counting down, and ready. */
export function armedDelayLock(
  state: LockState,
): { until: number; durationMs: number } | null {
  const until = state.delayUntil;
  const durationMs = state.delayDurationMs;
  if (
    typeof until !== 'number' ||
    !Number.isFinite(until) ||
    until < 0 ||
    typeof durationMs !== 'number' ||
    !Number.isInteger(durationMs) ||
    durationMs < MIN_DELAY_LOCK_MS ||
    durationMs > MAX_DELAY_LOCK_MS
  ) {
    return null;
  }
  return { until, durationMs };
}

export function armedRandomTextLength(state: LockState): number | null {
  const len = state.randomTextLen;
  return typeof len === 'number' &&
    Number.isInteger(len) &&
    len >= MIN_RANDOM_TEXT_LOCK_LENGTH &&
    len <= MAX_RANDOM_TEXT_LOCK_LENGTH
    ? len
    : null;
}

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
  const breakWindow = breakInterval(state);
  if (breakWindow) {
    if (breakWindow.start > now) candidates.push(breakWindow.start);
    if (breakWindow.end > now) candidates.push(breakWindow.end);
  }
  if (state.timerUntil !== null && state.timerUntil > now) candidates.push(state.timerUntil);
  const delay = armedDelayLock(state);
  if (delay && delay.until > now) candidates.push(delay.until);
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
  const delay = armedDelayLock(state);
  if (delay) reasons.push('delay');
  const randomTextLen = armedRandomTextLength(state);
  if (randomTextLen !== null) reasons.push('random-text');
  if (state.frozenUntil !== null && state.frozenUntil > now) {
    reasons.push('frozen');
    ends.push(state.frozenUntil);
  }
  const windowEnd = currentWindowEnd(state.schedules, new Date(now));
  if (windowEnd !== null) {
    reasons.push('schedule');
    ends.push(windowEnd);
  }
  const status: LockStatus = {
    breakActive: activeBreakInterval(state, now) !== null,
    breakStartedAt: state.breakStartedAt ?? null,
    breakNotBefore: state.breakNotBefore ?? null,
    breakEndsAt: state.breakEndsAt ?? null,
    settingsLocked: reasons.length > 0,
    forceBlocking: windowEnd !== null || reasons.includes('frozen'),
    reasons,
    until:
      state.passwordHash || delay || randomTextLen !== null
        ? null
        : ends.length
          ? Math.max(...ends)
          : null,
  };
  if (delay) {
    status.delayUntil = delay.until;
    status.delayDurationMs = delay.durationMs;
    status.delayReady = delay.until > 0 && now >= delay.until;
  }
  if (randomTextLen !== null) status.randomTextLen = randomTextLen;
  return status;
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

  // Delay: one whole-gate LWW operation. Equal stamps fail closed: an armed
  // operation beats a release, a waiting/reset operation beats a countdown,
  // then the later deadline and longer configured duration win. A legacy peer
  // with no delay fields has stamp 0 and cannot erase a stampless active gate.
  const hasDelayFields = (s: LockState) =>
    s.delayUntil !== undefined ||
    s.delayDurationMs !== undefined ||
    s.delayUpdatedAt !== undefined;
  const includeDelay = hasDelayFields(a) || hasDelayFields(b);
  const aDelayTs = a.delayUpdatedAt ?? 0;
  const bDelayTs = b.delayUpdatedAt ?? 0;
  const aDelay = armedDelayLock(a);
  const bDelay = armedDelayLock(b);
  const delayCanon = (s: LockState) =>
    JSON.stringify([s.delayUntil ?? null, s.delayDurationMs ?? null]);
  let delayWinner = a;
  if (aDelayTs !== bDelayTs) {
    delayWinner = aDelayTs > bDelayTs ? a : b;
  } else if ((aDelay !== null) !== (bDelay !== null)) {
    delayWinner = aDelay ? a : b;
  } else if (aDelay && bDelay && (aDelay.until === 0) !== (bDelay.until === 0)) {
    delayWinner = aDelay.until === 0 ? a : b;
  } else if (aDelay && bDelay && aDelay.until !== bDelay.until) {
    delayWinner = aDelay.until > bDelay.until ? a : b;
  } else if (aDelay && bDelay && aDelay.durationMs !== bDelay.durationMs) {
    delayWinner = aDelay.durationMs > bDelay.durationMs ? a : b;
  } else if (delayCanon(a) !== delayCanon(b)) {
    delayWinner = delayCanon(a) < delayCanon(b) ? a : b;
  }

  // Random text follows the same LWW/tombstone model. Equal stamps keep the
  // armed gate, then the longer challenge; released legacy-empty states lose.
  const hasRandomFields = (s: LockState) =>
    s.randomTextLen !== undefined || s.randomTextUpdatedAt !== undefined;
  const includeRandom = hasRandomFields(a) || hasRandomFields(b);
  const aRandomTs = a.randomTextUpdatedAt ?? 0;
  const bRandomTs = b.randomTextUpdatedAt ?? 0;
  const aRandomLen = armedRandomTextLength(a);
  const bRandomLen = armedRandomTextLength(b);
  let randomWinner = a;
  if (aRandomTs !== bRandomTs) {
    randomWinner = aRandomTs > bRandomTs ? a : b;
  } else if ((aRandomLen !== null) !== (bRandomLen !== null)) {
    randomWinner = aRandomLen !== null ? a : b;
  } else if (aRandomLen !== null && bRandomLen !== null && aRandomLen !== bRandomLen) {
    randomWinner = aRandomLen > bRandomLen ? a : b;
  } else if (JSON.stringify([a.randomTextLen ?? null]) !== JSON.stringify([b.randomTextLen ?? null])) {
    // Deterministic total fallback for unsanitized legacy/corrupt shapes.
    randomWinner =
      JSON.stringify([a.randomTextLen ?? null]) < JSON.stringify([b.randomTextLen ?? null]) ? a : b;
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

  // Break: one timestamped LWW operation, NOT independent timestamp maxima.
  // A newer cancellation (all three timestamps null) therefore beats a stale
  // active/pending break. Same-stamp conflicts fail closed: cancellation
  // wins; otherwise the earlier re-block wins, then the later activation and
  // request. Every tiebreak is total and argument-order independent.
  const aBreakTs = a.breakUpdatedAt ?? 0;
  const bBreakTs = b.breakUpdatedAt ?? 0;
  const emptyBreak = (s: LockState) =>
    (s.breakStartedAt ?? null) === null &&
    (s.breakNotBefore ?? null) === null &&
    (s.breakEndsAt ?? null) === null;
  let breakWinner = a;
  if (aBreakTs !== bBreakTs) {
    breakWinner = aBreakTs > bBreakTs ? a : b;
  } else if (emptyBreak(a) !== emptyBreak(b)) {
    breakWinner = emptyBreak(a) ? a : b;
  } else if ((a.breakEndsAt ?? null) !== (b.breakEndsAt ?? null)) {
    breakWinner = (a.breakEndsAt ?? Number.MAX_SAFE_INTEGER) <
      (b.breakEndsAt ?? Number.MAX_SAFE_INTEGER)
      ? a
      : b;
  } else if ((a.breakNotBefore ?? null) !== (b.breakNotBefore ?? null)) {
    breakWinner = (a.breakNotBefore ?? 0) > (b.breakNotBefore ?? 0) ? a : b;
  } else if ((a.breakStartedAt ?? null) !== (b.breakStartedAt ?? null)) {
    breakWinner = (a.breakStartedAt ?? 0) > (b.breakStartedAt ?? 0) ? a : b;
  }

  const merged: LockState = {
    breakStartedAt: breakWinner.breakStartedAt ?? null,
    breakNotBefore: breakWinner.breakNotBefore ?? null,
    breakEndsAt: breakWinner.breakEndsAt ?? null,
    breakUpdatedAt: Math.max(aBreakTs, bBreakTs),
    timerUntil: maxNullable(a.timerUntil, b.timerUntil),
    passwordHash,
    passwordTs: Math.max(aPwTs, bPwTs),
    frozenUntil: maxNullable(a.frozenUntil, b.frozenUntil),
    schedules,
    schedulesUpdatedAt,
  };
  if (includeDelay) {
    merged.delayUntil = delayWinner.delayUntil ?? null;
    merged.delayDurationMs = delayWinner.delayDurationMs ?? null;
    merged.delayUpdatedAt = Math.max(aDelayTs, bDelayTs);
  }
  if (includeRandom) {
    merged.randomTextLen = randomWinner.randomTextLen ?? null;
    merged.randomTextUpdatedAt = Math.max(aRandomTs, bRandomTs);
  }
  return merged;
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
  const breakCap = now + MAX_BREAK_MS;
  const breakTimestamp = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, breakCap) : null;
  const startedAt = stamp(o.breakStartedAt) || null;
  const notBefore = breakTimestamp(o.breakNotBefore);
  const endsAt = breakTimestamp(o.breakEndsAt);
  const breakCandidate: LockState = {
    breakStartedAt: startedAt,
    breakNotBefore: notBefore,
    breakEndsAt: endsAt,
    timerUntil: null,
    passwordHash: null,
    frozenUntil: null,
    schedules: [],
  };
  // Partial, reversed, overlong, and non-finite shapes become an empty
  // tombstone, never a partially active break.
  const validBreak = breakInterval(breakCandidate) !== null;

  // New gates are all-or-neutral under sanitization: malformed active shapes
  // are dropped entirely, never converted into a newer UNLOCK tombstone.
  // A stamp-only operation is a valid release because Rust omits null fields.
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(o, key);
  let delay: Pick<LockState, 'delayUntil' | 'delayDurationMs' | 'delayUpdatedAt'> | null = null;
  if (owns('delayUntil') || owns('delayDurationMs') || owns('delayUpdatedAt')) {
    const duration =
      typeof o.delayDurationMs === 'number' &&
      Number.isInteger(o.delayDurationMs) &&
      o.delayDurationMs >= MIN_DELAY_LOCK_MS &&
      o.delayDurationMs <= MAX_DELAY_LOCK_MS
        ? o.delayDurationMs
        : null;
    const released =
      (o.delayUntil === null || o.delayUntil === undefined) &&
      (o.delayDurationMs === null || o.delayDurationMs === undefined);
    const waiting = o.delayUntil === 0 && duration !== null;
    const countingDown =
      typeof o.delayUntil === 'number' &&
      Number.isFinite(o.delayUntil) &&
      o.delayUntil > 0 &&
      duration !== null;
    if (released || waiting || countingDown) {
      delay = {
        delayUntil: released
          ? null
          : waiting
            ? 0
            : Math.min(o.delayUntil as number, now + MAX_DELAY_LOCK_MS),
        delayDurationMs: released ? null : duration,
        delayUpdatedAt: stamp(o.delayUpdatedAt),
      };
    }
  }
  let random: Pick<LockState, 'randomTextLen' | 'randomTextUpdatedAt'> | null = null;
  if (owns('randomTextLen') || owns('randomTextUpdatedAt')) {
    const released = o.randomTextLen === null || o.randomTextLen === undefined;
    const armed =
      typeof o.randomTextLen === 'number' &&
      Number.isInteger(o.randomTextLen) &&
      o.randomTextLen >= MIN_RANDOM_TEXT_LOCK_LENGTH &&
      o.randomTextLen <= MAX_RANDOM_TEXT_LOCK_LENGTH;
    if (released || armed) {
      random = {
        randomTextLen: released ? null : (o.randomTextLen as number),
        randomTextUpdatedAt: stamp(o.randomTextUpdatedAt),
      };
    }
  }

  const sanitized: LockState = {
    breakStartedAt: validBreak ? startedAt : null,
    breakNotBefore: validBreak ? notBefore : null,
    breakEndsAt: validBreak ? endsAt : null,
    breakUpdatedAt: stamp(o.breakUpdatedAt),
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
  if (delay) Object.assign(sanitized, delay);
  if (random) Object.assign(sanitized, random);
  return sanitized;
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
