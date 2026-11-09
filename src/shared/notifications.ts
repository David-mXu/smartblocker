// Quiet, opt-in reminders — the narrow slice of Cold Turkey's notification
// mini-product that actually changes behavior: "focus hours start soon,"
// "your break ends soon," and "your allowance is nearly used up."
//
// Design doctrine (same as lock-math/resume):
//   - PURE derivation: no browser APIs, no storage, no non-erasable TS syntax.
//     scripts/notifications-test.mjs imports this file directly under Node
//     type stripping.
//   - STATE IS THE SOURCE OF TRUTH. Alarms only provide promptness. Every
//     reconcile re-derives candidates from the CURRENT lock state, allowance
//     authority, and preference snapshot, so a missed alarm can never make a
//     reminder fire for an event that already passed.
//   - ONE-SHOT alarms, one per notification kind. A fired reminder is
//     recorded in a bounded durable ledger; the same event key never fires
//     twice, and the next reconcile can arm the following schedule start.
//   - ALL OFF BY DEFAULT. Existing installs must not suddenly receive toasts.
//
// Profile scope: preferences are global (one browser profile = one "profile").
// There is no per-category or per-schedule toggle; that would multiply noise
// without a demonstrated need. The allowance reminder itself names the one
// category whose grant is ending.
import {
  EMPTY_LOCK_STATE,
  MAX_BREAK_MS,
  validateCategoryScheduleRule,
  validateScheduleRule,
} from './lock-math.ts';
import type {
  CategoryScheduleRule,
  LockState,
  ScheduleRule,
} from './lock-math.ts';
import { nextScheduleStart } from './resume.ts';
import {
  deriveAllowanceCategory,
  normalizeAllowanceAuthorityState,
} from './allowance-state.ts';
import { displayLabel } from './labels.ts';

const MINUTE_MS = 60_000;

export const NOTIFICATION_PREFS_VERSION = 1;
export const NOTIFICATION_LEDGER_VERSION = 1;
export const MIN_NOTIFICATION_MINUTES = 1;
export const MAX_NOTIFICATION_MINUTES = 60;
export const MAX_NOTIFICATION_LEDGER_KEYS = 64;
export const MAX_NOTIFICATION_DEDUPE_KEY_LENGTH = 200;

/** `sb-notify:` is deliberately distinct from every other feature's alarm
 *  names. Any alarm under this prefix that is not in the allowlist below is
 *  stale (renamed/older build) and the background clears it. */
export const NOTIFICATION_ALARM_PREFIX = 'sb-notify:';

export type NotificationKind = 'schedule-start' | 'break-end' | 'allowance-low';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'schedule-start',
  'break-end',
  'allowance-low',
];

/** The complete allowlist. One alarm per kind means a newer candidate for the
 *  same kind replaces the older one instead of accumulating. */
export const NOTIFICATION_ALARM_NAMES: Record<NotificationKind, string> = {
  'schedule-start': `${NOTIFICATION_ALARM_PREFIX}schedule-start`,
  'break-end': `${NOTIFICATION_ALARM_PREFIX}break-end`,
  'allowance-low': `${NOTIFICATION_ALARM_PREFIX}allowance-low`,
};

/** Fixed OS-notification ids. Reusing an id replaces a still-visible toast
 *  instead of stacking a second one; the ids are also part of the public
 *  allowlist the background uses before calling the notifications API. */
export const NOTIFICATION_IDS: Record<NotificationKind, string> = {
  'schedule-start': 'smartblocker-notify-schedule-start',
  'break-end': 'smartblocker-notify-break-end',
  'allowance-low': 'smartblocker-notify-allowance-low',
};

export interface MinuteWindowPref {
  enabled: boolean;
  /** 1..60. Minutes before the event. */
  leadMinutes: number;
}

export interface AllowanceLowPref {
  enabled: boolean;
  /** 1..60. Warn when a running allowance has this many minutes left. */
  thresholdMinutes: number;
}

export interface NotificationPrefs {
  version: typeof NOTIFICATION_PREFS_VERSION;
  /** Reminder before a focus-hours window starts. */
  scheduleStartingSoon: MinuteWindowPref;
  /** Reminder before an active/pending break re-blocks distractions. */
  breakEndingSoon: MinuteWindowPref;
  /** Reminder when a running allowance has this many minutes left. */
  allowanceLow: AllowanceLowPref;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  version: NOTIFICATION_PREFS_VERSION,
  scheduleStartingSoon: { enabled: false, leadMinutes: 5 },
  breakEndingSoon: { enabled: false, leadMinutes: 5 },
  allowanceLow: { enabled: false, thresholdMinutes: 5 },
};

export interface NotificationEvent {
  kind: NotificationKind;
  /** Epoch ms when the reminder should be delivered (start/end minus lead). */
  fireAt: number;
  /** The schedule start / break end / allowance end this reminder describes. */
  eventAt: number;
  /** Stable idempotency key persisted in the notification ledger. */
  dedupeKey: string;
  title: string;
  message: string;
  /** Category labels involved (schedule windows or the allowance category). */
  categories: string[];
}

export interface NotificationLedger {
  version: typeof NOTIFICATION_LEDGER_VERSION;
  /** dedupeKey → epoch ms when this reminder was successfully delivered. */
  fired: Record<string, number>;
}

export interface NotificationPlanInput {
  prefs: unknown;
  lockState: unknown;
  allowanceState?: unknown;
  firedKeys?: readonly string[];
  now: number;
}

export interface NotificationPlan {
  /** Every currently relevant, not-yet-fired candidate, earliest first. */
  candidates: NotificationEvent[];
  /** At most one alarm candidate per kind (the earliest not fired). */
  alarms: NotificationEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NOTIFICATION_DEDUPE_KEY_LENGTH
  );
}

function clampMinutes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_NOTIFICATION_MINUTES,
    Math.max(MIN_NOTIFICATION_MINUTES, Math.round(value)),
  );
}

function clonePrefs(prefs: NotificationPrefs): NotificationPrefs {
  return {
    version: NOTIFICATION_PREFS_VERSION,
    scheduleStartingSoon: { ...prefs.scheduleStartingSoon },
    breakEndingSoon: { ...prefs.breakEndingSoon },
    allowanceLow: { ...prefs.allowanceLow },
  };
}

/** Sanitize the persisted preference blob. A missing version is the natural
 *  pre-feature shape (defaults); an UNKNOWN future version resets to safe
 *  defaults rather than guessing at fields we do not understand. */
export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  if (!isRecord(raw)) return clonePrefs(DEFAULT_NOTIFICATION_PREFS);
  if (raw.version !== undefined && raw.version !== NOTIFICATION_PREFS_VERSION) {
    return clonePrefs(DEFAULT_NOTIFICATION_PREFS);
  }
  const schedule = isRecord(raw.scheduleStartingSoon) ? raw.scheduleStartingSoon : {};
  const breaking = isRecord(raw.breakEndingSoon) ? raw.breakEndingSoon : {};
  const allowance = isRecord(raw.allowanceLow) ? raw.allowanceLow : {};
  return {
    version: NOTIFICATION_PREFS_VERSION,
    scheduleStartingSoon: {
      enabled: schedule.enabled === true,
      leadMinutes: clampMinutes(
        schedule.leadMinutes,
        DEFAULT_NOTIFICATION_PREFS.scheduleStartingSoon.leadMinutes,
      ),
    },
    breakEndingSoon: {
      enabled: breaking.enabled === true,
      leadMinutes: clampMinutes(
        breaking.leadMinutes,
        DEFAULT_NOTIFICATION_PREFS.breakEndingSoon.leadMinutes,
      ),
    },
    allowanceLow: {
      enabled: allowance.enabled === true,
      thresholdMinutes: clampMinutes(
        allowance.thresholdMinutes,
        DEFAULT_NOTIFICATION_PREFS.allowanceLow.thresholdMinutes,
      ),
    },
  };
}

/** Durable duplicate-suppression ledger. Bounded so devtools edits cannot grow
 *  storage without limit; newest fire timestamps win retention. */
export function normalizeNotificationLedger(raw: unknown): NotificationLedger {
  if (
    !isRecord(raw) ||
    raw.version !== NOTIFICATION_LEDGER_VERSION ||
    !isRecord(raw.fired)
  ) {
    return { version: NOTIFICATION_LEDGER_VERSION, fired: {} };
  }
  const entries = Object.entries(raw.fired)
    .filter(
      (entry): entry is [string, number] =>
        validKey(entry[0]) && isFiniteTimestamp(entry[1]),
    )
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_NOTIFICATION_LEDGER_KEYS);
  return {
    version: NOTIFICATION_LEDGER_VERSION,
    fired: Object.fromEntries(entries),
  };
}

/** Add one delivered key and prune. Pure: returns a new ledger. */
export function rememberNotification(
  raw: unknown,
  key: string,
  now: number,
): NotificationLedger {
  const base = normalizeNotificationLedger(raw);
  if (!validKey(key)) return base;
  const stamp = isFiniteTimestamp(now) ? now : 1;
  return normalizeNotificationLedger({
    version: NOTIFICATION_LEDGER_VERSION,
    fired: { ...base.fired, [key]: stamp },
  });
}

export function notificationKindForAlarm(name: string): NotificationKind | null {
  for (const kind of NOTIFICATION_KINDS) {
    if (NOTIFICATION_ALARM_NAMES[kind] === name) return kind;
  }
  return null;
}

export function isNotificationAlarm(name: string): boolean {
  return typeof name === 'string' && name.startsWith(NOTIFICATION_ALARM_PREFIX);
}

export function isAllowlistedNotificationAlarm(name: string): boolean {
  return notificationKindForAlarm(name) !== null;
}

export function isAllowlistedNotificationId(id: string): boolean {
  return NOTIFICATION_KINDS.some((kind) => NOTIFICATION_IDS[kind] === id);
}

function localDayKey(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clockLabel(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

function categoryList(categories: readonly string[]): string {
  const labels = categories.map((category) => displayLabel(category));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function asLockState(raw: unknown): LockState {
  const value = isRecord(raw) ? raw : {};
  const schedules = Array.isArray(value.schedules)
    ? (value.schedules as ScheduleRule[]).filter(
        (rule) =>
          rule !== null &&
          typeof rule === 'object' &&
          typeof rule.id === 'string' &&
          validateScheduleRule(rule) === null,
      )
    : [];
  const categorySchedules = Array.isArray(value.categorySchedules)
    ? (value.categorySchedules as CategoryScheduleRule[]).filter(
        (rule) =>
          rule !== null &&
          typeof rule === 'object' &&
          typeof rule.id === 'string' &&
          validateCategoryScheduleRule(rule) === null,
      )
    : [];
  return {
    ...EMPTY_LOCK_STATE,
    ...(value as Partial<LockState>),
    schedules,
    categorySchedules,
  };
}

interface RuleEntry {
  rule: ScheduleRule;
  category: boolean;
}

function scheduleEntries(state: LockState): RuleEntry[] {
  const entries: RuleEntry[] = state.schedules.map((rule) => ({
    rule,
    category: false,
  }));
  for (const rule of state.categorySchedules ?? []) {
    entries.push({ rule, category: true });
  }
  return entries;
}

function scheduleDedupeKey(start: number): string {
  return `schedule-start:${start}`;
}

function buildScheduleEvent(
  start: number,
  leadMinutes: number,
  contributors: RuleEntry[],
): NotificationEvent {
  const categories = uniqueSorted(
    contributors.flatMap((entry) =>
      entry.category ? (entry.rule as CategoryScheduleRule).categories : [],
    ),
  );
  const hasGlobal = contributors.some((entry) => !entry.category);
  const at = clockLabel(start);
  const message =
    hasGlobal || categories.length === 0
      ? `Focus hours start at ${at}.`
      : `Focus hours for ${categoryList(categories)} start at ${at}.`;
  return {
    kind: 'schedule-start',
    fireAt: start - leadMinutes * MINUTE_MS,
    eventAt: start,
    dedupeKey: scheduleDedupeKey(start),
    title: 'Focus hours start soon',
    message,
    categories,
  };
}

/** The next schedule start whose reminder key has not fired. Starts already
 *  in the past are never candidates; a fired start is skipped so the planner
 *  can arm the FOLLOWING one without waiting for another storage event. */
function deriveScheduleCandidate(
  state: LockState,
  now: number,
  leadMinutes: number,
  fired: ReadonlySet<string>,
): NotificationEvent | null {
  const entries = scheduleEntries(state);
  if (entries.length === 0) return null;
  const rules = entries.map((entry) => entry.rule);
  const maxHops = Math.max(8, Math.min(128, 8 + 8 * entries.length));
  let cursor = now;
  for (let hop = 0; hop < maxHops; hop++) {
    const start = nextScheduleStart(rules, cursor);
    if (start === null || start <= cursor) return null;
    // A rule contributed to this start iff its own next start from the same
    // cursor is this instant. Grouping lets overlapping rules share one
    // reminder instead of firing one toast per rule id.
    const contributors = entries.filter(
      (entry) => nextScheduleStart([entry.rule], cursor) === start,
    );
    if (!fired.has(scheduleDedupeKey(start))) {
      return buildScheduleEvent(
        start,
        leadMinutes,
        contributors.length > 0 ? contributors : entries,
      );
    }
    cursor = start;
  }
  return null;
}

/** Pending AND active breaks both qualify: a delayed break's reminder may be
 *  scheduled for its own start when the configured lead is longer than the
 *  break. Mirrors lock-math's private breakInterval validation so invalid
 *  persisted shapes never produce a phantom reminder. */
function breakWindow(
  state: LockState,
  now: number,
): { start: number; end: number } | null {
  const requestedAt = state.breakStartedAt ?? null;
  const notBefore = state.breakNotBefore ?? null;
  const endsAt = state.breakEndsAt ?? null;
  if (requestedAt === null || endsAt === null) return null;
  if (!isFiniteTimestamp(requestedAt) || !isFiniteTimestamp(endsAt)) return null;
  if (notBefore !== null && (!isFiniteTimestamp(notBefore) || notBefore < requestedAt)) {
    return null;
  }
  const start = notBefore ?? requestedAt;
  if (endsAt <= start || endsAt - start > MAX_BREAK_MS) return null;
  return { start, end: endsAt };
}

function deriveBreakCandidate(
  state: LockState,
  now: number,
  leadMinutes: number,
  fired: ReadonlySet<string>,
): NotificationEvent | null {
  const interval = breakWindow(state, now);
  if (!interval || interval.end <= now) return null;
  const key = `break-end:${interval.start}:${interval.end}`;
  if (fired.has(key)) return null;
  return {
    kind: 'break-end',
    fireAt: Math.max(interval.start, interval.end - leadMinutes * MINUTE_MS),
    eventAt: interval.end,
    dedupeKey: key,
    title: 'Break ending soon',
    message: `Your break ends at ${clockLabel(interval.end)}. Blocking resumes.`,
    categories: [],
  };
}

/** Only a running/pending `allowance` grant is "nearly used up"; openings and
 *  Pomodoro relief are different contracts and stay silent. A pending grant's
 *  reminder waits until the grant starts, so a long waiting period cannot
 *  produce an "ends soon" toast before the allowance is even usable. */
function deriveAllowanceCandidates(
  rawState: unknown,
  now: number,
  thresholdMinutes: number,
  fired: ReadonlySet<string>,
): NotificationEvent[] {
  const authority = normalizeAllowanceAuthorityState(rawState);
  if (!authority) return [];
  const dayKey = localDayKey(new Date(now));
  const events: NotificationEvent[] = [];
  for (const category of Object.keys(authority.categories).sort()) {
    const current = deriveAllowanceCategory(authority, category, {
      nowMs: now,
      dayKey,
    });
    if (!current) continue;
    const grant = current.ledger.grant;
    if (
      !grant ||
      grant.kind !== 'allowance' ||
      grant.status === 'ended' ||
      grant.status === 'idle-closed' ||
      grant.endsAtMs <= now
    ) {
      continue;
    }
    const key = `allowance-low:${category}:${grant.id}:${grant.endsAtMs}`;
    if (fired.has(key)) continue;
    events.push({
      kind: 'allowance-low',
      fireAt: Math.max(
        grant.notBeforeMs,
        grant.endsAtMs - thresholdMinutes * MINUTE_MS,
      ),
      eventAt: grant.endsAtMs,
      dedupeKey: key,
      title: 'Allowance almost used up',
      message: `${displayLabel(category)} allowance ends at ${clockLabel(grant.endsAtMs)}.`,
      categories: [category],
    });
  }
  return events;
}

const KIND_ORDER: Record<NotificationKind, number> = {
  'schedule-start': 0,
  'break-end': 1,
  'allowance-low': 2,
};

/** Build every relevant candidate and the one alarm each kind should hold.
 *  PURE: the caller supplies the clock and the already-fired key set. A
 *  disabled group contributes nothing (not even an alarm to clean up; the
 *  runtime clears that kind's alarm when no candidate exists). */
export function planNotifications(input: NotificationPlanInput): NotificationPlan {
  const now = input?.now;
  if (!isFiniteTimestamp(now)) return { candidates: [], alarms: [] };
  const prefs = normalizeNotificationPrefs(input.prefs);
  const state = asLockState(input.lockState);
  const fired = new Set(
    (input.firedKeys ?? []).filter((key): key is string => validKey(key)),
  );
  const candidates: NotificationEvent[] = [];

  if (prefs.scheduleStartingSoon.enabled) {
    const event = deriveScheduleCandidate(
      state,
      now,
      prefs.scheduleStartingSoon.leadMinutes,
      fired,
    );
    if (event) candidates.push(event);
  }
  if (prefs.breakEndingSoon.enabled) {
    const event = deriveBreakCandidate(
      state,
      now,
      prefs.breakEndingSoon.leadMinutes,
      fired,
    );
    if (event) candidates.push(event);
  }
  if (prefs.allowanceLow.enabled) {
    candidates.push(
      ...deriveAllowanceCandidates(
        input.allowanceState,
        now,
        prefs.allowanceLow.thresholdMinutes,
        fired,
      ),
    );
  }

  candidates.sort(
    (a, b) =>
      a.fireAt - b.fireAt ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0),
  );

  const alarms: NotificationEvent[] = [];
  const seen = new Set<NotificationKind>();
  for (const candidate of candidates) {
    if (seen.has(candidate.kind)) continue;
    seen.add(candidate.kind);
    alarms.push(candidate);
  }
  return { candidates, alarms };
}
