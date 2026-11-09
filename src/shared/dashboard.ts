// Pure "Now / Next / Relief" dashboard derivation.
//
// The dashboard is a READ-ONLY view over the same stores every other surface
// uses: settings.ts, lock-math.ts (the one schedule engine), allowance-math.ts,
// resume.ts and companion-protocol.ts. It owns no timers and never writes
// state. Node imports this file directly in scripts/dashboard-test.mjs, so it
// must stay free of browser APIs and non-erasable TypeScript syntax.
//
// The 24-hour timeline samples the EXISTING schedule predicate
// (`currentWindowEnd`) at minute boundaries instead of growing a second
// scheduler. Rules are minute-granular and all rule frames are whole-minute
// offsets, so the sampled boundaries are exact while DST days are handled by
// iterating the real local day (23/25 hours) rather than a hardcoded 24.
import {
  EMPTY_LOCK_STATE,
  activeBreakInterval,
  armedDelayLock,
  currentWindowEnd,
  deriveLockStatus,
  nextBoundary,
  type CategoryScheduleRule,
  type LockState,
  type LockStatus,
  type ScheduleRule,
} from './lock-math.ts';
import { nextResumeAt, type ResumeMode } from './resume.ts';
import { deriveAllowance, type AllowanceGrant } from './allowance-math.ts';
import { normalizeBreakMode, type BreakMode } from './breaks.ts';
import { deriveExtensionGrace, extensionGraceText } from './grace-math.ts';
import type { AllowanceAuthorityState } from './allowance-state.ts';
import type { CompanionSnapshot } from './companion-protocol.ts';
import type { PendingFocusSession } from './focus-session.ts';

const MINUTE = 60_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type DashboardTone = 'success' | 'warning' | 'commit' | 'neutral' | 'destructive';

export interface DashboardSettings {
  enabled: boolean;
  focusGoal: string;
  resumeMode: ResumeMode;
  resumeAt: number | null;
  breakMode: BreakMode;
  breakDelayMinutes: number;
  breakDurationMinutes: number;
  breakTextLength: number;
}

export interface DashboardAllowanceInput {
  state: AllowanceAuthorityState | null;
  source: 'daemon' | 'fallback' | 'pending' | null;
}

/** Optional future profile support. The current build supplies no profile,
 *  so the model contains `null` rather than inventing one. */
export interface DashboardProfile {
  name: string;
  detail?: string;
}

export interface DashboardInput {
  now: number;
  settings: DashboardSettings;
  lockState: LockState;
  pendingFocus: PendingFocusSession | null;
  companion: CompanionSnapshot | null;
  allowance: DashboardAllowanceInput;
  profile?: DashboardProfile | null;
  /** Injected by the page so the (day-stable) timeline is not rebuilt on
   *  every one-second clock tick. Tests may omit it. */
  timeline?: DashboardTimeline;
  locale?: string | string[];
}

export interface DashboardCountdown {
  at: number;
  remainingMs: number;
  clock: string;
  text: string;
}

export interface DashboardBlocking {
  enabled: boolean;
  forced: boolean;
  title: string;
  detail: string;
  tone: DashboardTone;
}

export interface DashboardLockReason {
  reason: LockStatus['reasons'][number];
  name: string;
  detail: string;
  endsAt: number | null;
  automaticEnd: boolean;
  countdown: DashboardCountdown | null;
}

export interface DashboardLock {
  active: boolean;
  reasons: DashboardLockReason[];
  summary: string;
  until: DashboardCountdown | null;
  indefinite: boolean;
}

export interface DashboardWindow {
  configured: boolean;
  active: boolean;
  ruleCount: number;
  endsAt: number | null;
  countdown: DashboardCountdown | null;
  title: string;
  detail: string;
  categories: string[];
}

export interface DashboardBreak {
  active: boolean;
  pending: boolean;
  startsAt: number | null;
  endsAt: number | null;
  countdown: DashboardCountdown | null;
  title: string;
  detail: string;
}

export interface DashboardFocus {
  kind: 'pending' | 'active' | 'goal' | 'none';
  title: string;
  detail: string;
  until: number | null;
  commitAt: number | null;
  countdown: DashboardCountdown | null;
}

export interface DashboardCompanion {
  state: CompanionSnapshot['state'] | 'unknown';
  healthy: boolean;
  title: string;
  detail: string;
  tone: DashboardTone;
}

export interface DashboardScheduleTransition {
  lane: 'global' | 'category';
  configured: boolean;
  at: number | null;
  direction: 'starts' | 'ends' | null;
  ruleId: string | null;
  ruleSummary: string | null;
  categories: string[];
  countdown: DashboardCountdown | null;
  text: string;
}

export interface DashboardAutoResume {
  mode: ResumeMode;
  at: number | null;
  countdown: DashboardCountdown | null;
  title: string;
  detail: string;
}

export interface DashboardNext {
  global: DashboardScheduleTransition;
  category: DashboardScheduleTransition;
  autoResume: DashboardAutoResume;
  pendingFocus: DashboardFocus | null;
  pendingBreak: DashboardBreak | null;
}

export interface DashboardBreakMode {
  mode: BreakMode;
  title: string;
  detail: string;
}

export interface DashboardReliefGrant {
  category: string;
  kind: AllowanceGrant['kind'];
  status: AllowanceGrant['status'];
  endsAt: number;
  remainingMs: number;
  countdown: DashboardCountdown;
  title: string;
  detail: string;
}

export interface DashboardRelief {
  breakMode: DashboardBreakMode;
  allowanceSource: DashboardAllowanceInput['source'];
  allowanceTitle: string;
  allowanceDetail: string;
  grants: DashboardReliefGrant[];
  statement: string;
}

export interface DashboardTimelineSegment {
  start: number;
  end: number;
  leftPct: number;
  widthPct: number;
  startsBeforeToday: boolean;
  endsAfterToday: boolean;
  label: string;
}

export interface DashboardTimelineOccurrence {
  ruleId: string;
  summary: string;
  categories: string[];
  startLabel: string;
  endLabel: string;
  startsBeforeToday: boolean;
  endsAfterToday: boolean;
  text: string;
}

export interface DashboardTimelineLane {
  id: 'global' | 'category';
  title: string;
  emptyText: string;
  segments: DashboardTimelineSegment[];
  occurrences: DashboardTimelineOccurrence[];
  text: string[];
}

export interface DashboardTimelineTick {
  at: number;
  label: string;
  pct: number;
}

export interface DashboardTimeline {
  dayStart: number;
  dayEnd: number;
  now: number;
  nowPct: number;
  label: string;
  ticks: DashboardTimelineTick[];
  lanes: DashboardTimelineLane[];
}

export interface DashboardModel {
  now: number;
  nowLabel: string;
  blocking: DashboardBlocking;
  lock: DashboardLock;
  globalWindow: DashboardWindow;
  categoryWindow: DashboardWindow;
  break: DashboardBreak;
  focus: DashboardFocus;
  companion: DashboardCompanion;
  next: DashboardNext;
  relief: DashboardRelief;
  timeline: DashboardTimeline;
  profile: DashboardProfile | null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function localDayKey(now: number): string {
  const date = new Date(now);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** "3h 12m" / "2d 4h" / "<1m". Never displays a positive remainder as 0. */
export function formatDashboardRemaining(ms: number): string {
  if (!finite(ms)) return 'unknown';
  if (ms <= 0) return 'now';
  if (ms < MINUTE) return '<1m';
  const mins = Math.ceil(ms / MINUTE);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "3:40 PM" today, "Tue 3:40 PM" within a week, else "Nov 14, 3:40 PM". */
export function formatDashboardClock(
  ts: number,
  now = Date.now(),
  locale?: string | string[],
): string {
  if (!finite(ts)) return 'unknown';
  const date = new Date(ts);
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  if (ts - now < 6 * 86_400_000) {
    return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${time}`;
}

function clockAt(ts: number, now: number, locale?: string | string[]): string {
  return formatDashboardClock(ts, now, locale);
}

function countdownAt(
  at: number,
  now: number,
  locale?: string | string[],
): DashboardCountdown {
  const remainingMs = Math.max(0, at - now);
  const clock = clockAt(at, now, locale);
  return {
    at,
    remainingMs,
    clock,
    text: `${formatDashboardRemaining(remainingMs)} left (until ${clock})`,
  };
}

function daysSummary(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b).join(',');
  if (sorted === '') return 'No days';
  if (sorted === '0,1,2,3,4,5,6') return 'Every day';
  if (sorted === '1,2,3,4,5') return 'Weekdays';
  if (sorted === '0,6') return 'Weekends';
  return [...days]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => DAY_NAMES[day])
    .join(', ');
}

/** Rule-wall-clock label (the rule's own pinned frame when pinned). */
function ruleClock(minutes: number): string {
  const total = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

function offsetLabel(rule: ScheduleRule): string {
  if (rule.tzName) return rule.tzName;
  if (typeof rule.tzOffsetMinutes === 'number' && Number.isInteger(rule.tzOffsetMinutes)) {
    const offset = rule.tzOffsetMinutes;
    if (offset === 0) return 'UTC';
    const sign = offset > 0 ? '+' : '−';
    const abs = Math.abs(offset);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  }
  return '';
}

function ruleSummary(rule: ScheduleRule): string {
  const overnight = rule.endMinutes < rule.startMinutes ? ' (next day)' : '';
  const tz = offsetLabel(rule);
  return `${daysSummary(rule.days)} · ${ruleClock(rule.startMinutes)} – ${ruleClock(rule.endMinutes)}${overnight}${tz ? ` · ${tz}` : ''}`;
}

const REASON_NAMES: Record<LockStatus['reasons'][number], string> = {
  timer: 'Timer lock',
  password: 'Password lock',
  delay: 'Unlock delay',
  'random-text': 'Random-text lock',
  frozen: 'Focus session',
  schedule: 'Focus hours',
  partner: 'Accountability partner',
};

function buildLock(
  status: LockStatus,
  state: LockState,
  now: number,
  locale?: string | string[],
): DashboardLock {
  const reasons: DashboardLockReason[] = [];
  const push = (
    reason: LockStatus['reasons'][number],
    detail: string,
    endsAt: number | null,
    automaticEnd: boolean,
  ) => {
    reasons.push({
      reason,
      name: REASON_NAMES[reason],
      detail,
      endsAt,
      automaticEnd,
      countdown: endsAt !== null && endsAt > now ? countdownAt(endsAt, now, locale) : null,
    });
  };

  for (const reason of status.reasons) {
    switch (reason) {
      case 'timer':
        push(
          reason,
          'Settings are frozen until the timer ends.',
          state.timerUntil,
          true,
        );
        break;
      case 'password':
        push(reason, 'Settings stay locked until the password is entered.', null, false);
        break;
      case 'delay': {
        const delay = armedDelayLock(state);
        if (delay) {
          if (delay.until === 0) {
            push(reason, 'Waiting for you to start the unlock countdown.', null, false);
          } else if (now < delay.until) {
            push(
              reason,
              `The unlock wait ends at ${clockAt(delay.until, now, locale)}; the background then completes the release.`,
              delay.until,
              false,
            );
          } else {
            push(reason, 'The unlock wait has elapsed; the background completes the release.', null, false);
          }
        }
        break;
      }
      case 'random-text': {
        const length = status.randomTextLen;
        push(
          reason,
          length ? `Enter a fresh ${length}-symbol challenge to unlock.` : 'A fresh random-text challenge is required.',
          null,
          false,
        );
        break;
      }
      case 'frozen':
        push(
          reason,
          'A focus session is running; blocking is forced on.',
          state.frozenUntil,
          true,
        );
        break;
      case 'schedule': {
        const end = currentWindowEnd(state.schedules, new Date(now));
        push(
          reason,
          'Focus hours are active; blocking is forced on and settings are frozen.',
          end,
          true,
        );
        break;
      }
      case 'partner':
        push(reason, 'Only the accountability partner can release this lock.', null, false);
        break;
    }
  }

  const indefinite = reasons.some((reason) => !reason.automaticEnd);
  const timedEnds = reasons
    .filter((reason) => reason.automaticEnd && reason.endsAt !== null)
    .map((reason) => reason.endsAt as number);
  const lastEnd = timedEnds.length ? Math.max(...timedEnds) : null;

  let summary = 'No lock is active.';
  if (status.settingsLocked) {
    if (!indefinite && lastEnd !== null) {
      summary = `All locks end at ${clockAt(lastEnd, now, locale)} (${formatDashboardRemaining(lastEnd - now)} left).`;
    } else {
      const methods = reasons
        .filter((reason) => !reason.automaticEnd)
        .map((reason) => reason.name.toLowerCase())
        .join(', ');
      summary =
        `No automatic unlock${lastEnd !== null ? `; timed sources end by ${clockAt(lastEnd, now, locale)}` : ''}` +
        `${methods ? ` — release through the ${methods}` : ''}.`;
    }
  }

  return {
    active: status.settingsLocked,
    reasons,
    summary,
    until: status.until !== null ? countdownAt(status.until, now, locale) : null,
    indefinite,
  };
}

function buildGlobalWindow(
  rules: ScheduleRule[],
  now: number,
  locale?: string | string[],
): DashboardWindow {
  const end = currentWindowEnd(rules, new Date(now));
  if (end !== null) {
    return {
      configured: rules.length > 0,
      active: true,
      ruleCount: rules.length,
      endsAt: end,
      countdown: countdownAt(end, now, locale),
      title: 'Focus hours are active',
      detail: `Blocking is forced on and settings are frozen until ${clockAt(end, now, locale)} (${formatDashboardRemaining(end - now)} left).`,
      categories: [],
    };
  }
  return {
    configured: rules.length > 0,
    active: false,
    ruleCount: rules.length,
    endsAt: null,
    countdown: null,
    title: rules.length > 0 ? 'No focus-hours window right now' : 'No focus hours configured',
    detail:
      rules.length > 0
        ? 'Blocking follows the master switch until the next window starts.'
        : 'Add weekly focus hours to force blocking automatically.',
    categories: [],
  };
}

function buildCategoryWindow(
  rules: CategoryScheduleRule[],
  now: number,
  locale?: string | string[],
): DashboardWindow {
  const activeRules = rules.filter((rule) => currentWindowEnd([rule], new Date(now)) !== null);
  const end = currentWindowEnd(rules, new Date(now));
  const categories = [...new Set(activeRules.flatMap((rule) => rule.categories))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (end !== null) {
    return {
      configured: rules.length > 0,
      active: true,
      ruleCount: rules.length,
      endsAt: end,
      countdown: countdownAt(end, now, locale),
      title: 'Category window is active',
      detail:
        `Confident classifier matches in ${categories.length ? categories.join(', ') : 'the chosen categories'} block until ${clockAt(end, now, locale)} (${formatDashboardRemaining(end - now)} left). ` +
        'This window does not lock settings.',
      categories,
    };
  }
  return {
    configured: rules.length > 0,
    active: false,
    ruleCount: rules.length,
    endsAt: null,
    countdown: null,
    title: rules.length > 0 ? 'No category window right now' : 'No category schedules configured',
    detail:
      rules.length > 0
        ? 'Outside its window, a configured category schedule rescues classifier blocks instead.'
        : 'Category schedules add scoped windows without locking settings.',
    categories: [],
  };
}

function buildBreak(
  state: LockState,
  settings: DashboardSettings,
  now: number,
  locale?: string | string[],
): DashboardBreak {
  const interval = activeBreakInterval(state, now);
  if (interval) {
    return {
      active: true,
      pending: false,
      startsAt: interval.start,
      endsAt: interval.end,
      countdown: countdownAt(interval.end, now, locale),
      title: 'Break is active',
      detail: `Classifier verdicts are relaxed until ${clockAt(interval.end, now, locale)} (${formatDashboardRemaining(interval.end - now)} left). Deterministic rules and locks still apply.`,
    };
  }

  const requestedAt = state.breakStartedAt ?? null;
  const startsAt = state.breakNotBefore ?? requestedAt;
  const endsAt = state.breakEndsAt ?? null;
  if (startsAt !== null && endsAt !== null && startsAt > now && endsAt > now) {
    return {
      active: false,
      pending: true,
      startsAt,
      endsAt,
      countdown: countdownAt(startsAt, now, locale),
      title: 'Break starts soon',
      detail: `Starts at ${clockAt(startsAt, now, locale)} (in ${formatDashboardRemaining(startsAt - now)}); ends at ${clockAt(endsAt, now, locale)}.`,
    };
  }

  return {
    active: false,
    pending: false,
    startsAt: null,
    endsAt: null,
    countdown: null,
    title: 'No break is active',
    detail:
      settings.breakMode === 'off'
        ? 'Breaks are turned off in Locks and breaks.'
        : 'Start a break from the popup while a lock is active.',
  };
}

function buildFocus(
  state: LockState,
  settings: DashboardSettings,
  pending: PendingFocusSession | null,
  now: number,
  locale?: string | string[],
): DashboardFocus {
  if (pending) {
    const commitCountdown = countdownAt(pending.commitAt, now, locale);
    if (now < pending.commitAt) {
      return {
        kind: 'pending',
        title: 'Focus session pending',
        detail: `Locks in ${formatDashboardRemaining(pending.commitAt - now)}; undo until ${clockAt(pending.commitAt, now, locale)}. Session ends ${clockAt(pending.until, now, locale)}.`,
        until: pending.until,
        commitAt: pending.commitAt,
        countdown: commitCountdown,
      };
    }
    if (pending.until > now) {
      return {
        kind: 'pending',
        title: 'Focus session locking',
        detail: `The undo window closed at ${clockAt(pending.commitAt, now, locale)}. Blocking is forced until ${clockAt(pending.until, now, locale)}.`,
        until: pending.until,
        commitAt: pending.commitAt,
        countdown: countdownAt(pending.until, now, locale),
      };
    }
    return {
      kind: 'pending',
      title: 'Focus session finishing',
      detail: 'The session end has passed; the pending record clears on the next commit check.',
      until: pending.until,
      commitAt: pending.commitAt,
      countdown: null,
    };
  }

  if (state.frozenUntil !== null && state.frozenUntil > now) {
    const goal = settings.focusGoal.trim();
    return {
      kind: 'active',
      title: 'Focus session running',
      detail:
        `Blocking is forced until ${clockAt(state.frozenUntil, now, locale)} (${formatDashboardRemaining(state.frozenUntil - now)} left).` +
        (goal ? ` Working on: ${goal}.` : ''),
      until: state.frozenUntil,
      commitAt: null,
      countdown: countdownAt(state.frozenUntil, now, locale),
    };
  }

  const goal = settings.focusGoal.trim();
  if (goal) {
    return {
      kind: 'goal',
      title: `Working on: ${goal}`,
      detail: 'Your focus goal is used to disambiguate borderline pages.',
      until: null,
      commitAt: null,
      countdown: null,
    };
  }

  return {
    kind: 'none',
    title: 'No focus goal set',
    detail: 'Set one on the Focus page to help the classifier with borderline pages.',
    until: null,
    commitAt: null,
    countdown: null,
  };
}

function buildCompanion(
  snapshot: CompanionSnapshot | null,
  now: number,
): DashboardCompanion {
  if (!snapshot) {
    return {
      state: 'unknown',
      healthy: false,
      title: 'Checking the desktop companion…',
      detail: 'The browser extension is enforcing locks on its own.',
      tone: 'neutral',
    };
  }

  const grace = snapshot.extensionLoss
    ? deriveExtensionGrace(now, snapshot.extensionLoss, snapshot.extensionLoss.graceSeconds)
    : null;
  const graceActive = grace !== null && (grace.state === 'grace' || grace.state === 'expired');

  switch (snapshot.state) {
    case 'not-installed':
      return {
        state: snapshot.state,
        healthy: false,
        title: 'Desktop companion not installed',
        detail: 'Optional. The browser extension still enforces locks here.',
        tone: 'neutral',
      };
    case 'connecting':
      return {
        state: snapshot.state,
        healthy: false,
        title: 'Connecting to the desktop companion…',
        detail: 'Hard enforcement begins after the connection is authenticated.',
        tone: 'neutral',
      };
    case 'disconnected':
      return {
        state: snapshot.state,
        healthy: false,
        title: 'Desktop companion disconnected',
        detail: snapshot.status
          ? `Installed but not running (companion v${snapshot.status.companionVersion}).`
          : 'Reconnecting…',
        tone: 'warning',
      };
    case 'connected': {
      const status = snapshot.status;
      const flags = status
        ? [
            status.enforcement.appBlocking ? 'app blocking on' : 'app blocking off',
            status.enforcement.watchdog ? 'browser watchdog on' : 'browser watchdog off',
            status.enforcement.policyProtected ? 'policy protection on' : 'policy protection off',
          ].join(' · ')
        : 'Enforcement details unavailable.';
      return {
        state: snapshot.state,
        healthy: !graceActive,
        title: graceActive ? 'Desktop companion connected — extension grace active' : 'Desktop companion connected',
        detail: graceActive ? extensionGraceText(grace) : flags,
        tone: graceActive ? 'warning' : 'success',
      };
    }
  }
}

interface RuleTransition {
  at: number;
  direction: 'starts' | 'ends';
  rule: ScheduleRule;
}

function nextRuleTransition(rule: ScheduleRule, now: number): RuleTransition | null {
  const at = nextBoundary({ ...EMPTY_LOCK_STATE, schedules: [rule] }, now);
  if (at === null) return null;
  // A currently-active rule's earliest boundary is its end; an inactive
  // rule's earliest boundary is its next start (its end always has a
  // strictly earlier start). Both paths come from lock-math itself.
  const active = currentWindowEnd([rule], new Date(now)) !== null;
  return { at, direction: active ? 'ends' : 'starts', rule };
}

function nextTransition(
  rules: ScheduleRule[],
  lane: 'global' | 'category',
  now: number,
  locale?: string | string[],
): DashboardScheduleTransition {
  let best: RuleTransition | null = null;
  for (const rule of rules) {
    const candidate = nextRuleTransition(rule, now);
    if (!candidate) continue;
    if (
      best === null ||
      candidate.at < best.at ||
      // A tie means one window ends while another begins at the same instant;
      // reporting the ending side keeps the countdown truthful and stable.
      (candidate.at === best.at && candidate.direction === 'ends' && best.direction === 'starts')
    ) {
      best = candidate;
    }
  }

  const label = lane === 'global' ? 'Focus hours' : 'Category schedule';
  if (!best) {
    return {
      lane,
      configured: rules.length > 0,
      at: null,
      direction: null,
      ruleId: null,
      ruleSummary: null,
      categories: [],
      countdown: null,
      text:
        rules.length > 0
          ? `No upcoming ${label.toLowerCase()} transition.`
          : `No ${label.toLowerCase()} configured.`,
    };
  }

  const verb = best.direction === 'starts' ? 'starts' : 'ends';
  const categoryRule = lane === 'category' ? (best.rule as CategoryScheduleRule) : null;
  return {
    lane,
    configured: true,
    at: best.at,
    direction: best.direction,
    ruleId: best.rule.id,
    ruleSummary: ruleSummary(best.rule),
    categories: categoryRule ? [...categoryRule.categories] : [],
    countdown: countdownAt(best.at, now, locale),
    text: `${label} ${verb} at ${clockAt(best.at, now, locale)} (in ${formatDashboardRemaining(best.at - now)}).`,
  };
}

function buildAutoResume(
  settings: DashboardSettings,
  schedules: ScheduleRule[],
  now: number,
  locale?: string | string[],
): DashboardAutoResume {
  const mode = settings.resumeMode;
  if (mode === 'off') {
    return {
      mode,
      at: null,
      countdown: null,
      title: 'Auto-resume is off',
      detail: 'Turning blocking off stays off until you turn it back on.',
    };
  }
  if (settings.enabled) {
    // The stored resume plan is still armed while blocking is on; show its
    // time, but say plainly that it only fires after blocking is turned off.
    const armedAt =
      mode === 'time' || mode === 'schedule'
        ? nextResumeAt({ mode, resumeAt: settings.resumeAt }, schedules, now)
        : null;
    return {
      mode,
      at: armedAt,
      countdown: armedAt !== null ? countdownAt(armedAt, now, locale) : null,
      title: 'Blocking is already on',
      detail:
        armedAt !== null
          ? `Auto-resume is armed for ${clockAt(armedAt, now, locale)} (in ${formatDashboardRemaining(armedAt - now)}), but only fires while blocking is off.`
          : 'Auto-resume only fires while blocking is off.',
    };
  }
  if (mode === 'startup') {
    return {
      mode,
      at: null,
      countdown: null,
      title: 'Auto-resume at browser start',
      detail: 'Blocking turns back on the next time the browser starts.',
    };
  }

  const at = nextResumeAt({ mode, resumeAt: settings.resumeAt }, schedules, now);
  if (at === null) {
    return {
      mode,
      at: null,
      countdown: null,
      title: mode === 'schedule' ? 'Auto-resume has no scheduled start' : 'No auto-resume time set',
      detail:
        mode === 'schedule'
          ? 'Add focus hours, or choose a different resume mode.'
          : 'Choose a time on the Blocking page.',
    };
  }
  return {
    mode,
    at,
    countdown: countdownAt(at, now, locale),
    title: 'Blocking resumes automatically',
    detail:
      mode === 'schedule'
        ? `At the next focus-hour start: ${clockAt(at, now, locale)} (in ${formatDashboardRemaining(at - now)}).`
        : `At ${clockAt(at, now, locale)} (in ${formatDashboardRemaining(at - now)}).`,
  };
}

function buildBreakMode(settings: DashboardSettings): DashboardBreakMode {
  const mode = normalizeBreakMode(settings.breakMode);
  if (mode === 'delay') {
    return {
      mode,
      title: 'Breaks use an unlock wait',
      detail: `A break can start after a ${settings.breakDelayMinutes}-minute wait and lasts ${settings.breakDurationMinutes} minutes.`,
    };
  }
  if (mode === 'random-text') {
    return {
      mode,
      title: 'Breaks use a random-text proof',
      detail: `A break needs a fresh ${settings.breakTextLength}-symbol proof and lasts ${settings.breakDurationMinutes} minutes.`,
    };
  }
  return {
    mode,
    title: 'Breaks are off',
    detail: 'No break can relax classifier blocks while a lock is active.',
  };
}

function buildRelief(
  settings: DashboardSettings,
  allowance: DashboardAllowanceInput,
  now: number,
  locale?: string | string[],
): DashboardRelief {
  const breakMode = buildBreakMode(settings);
  const dayKey = localDayKey(now);
  const grants: DashboardReliefGrant[] = [];

  if (allowance.state) {
    for (const [category, value] of Object.entries(allowance.state.categories)) {
      const derived = deriveAllowance(value.ledger, value.config, { nowMs: now, dayKey });
      const grant = derived.grant;
      if (!grant || (grant.status !== 'pending' && grant.status !== 'active')) continue;
      const remainingMs = Math.max(0, grant.endsAtMs - now);
      const kindLabel =
        grant.kind === 'allowance' ? 'allowance' : grant.kind === 'opening' ? 'opening' : 'Pomodoro relief';
      let detail: string;
      if (grant.kind === 'allowance' && grant.status === 'pending') {
        detail = `Starts at ${clockAt(grant.notBeforeMs, now, locale)} and ends at ${clockAt(grant.endsAtMs, now, locale)}.`;
      } else if (grant.kind === 'opening') {
        const idleMs = value.config.openingInactivityMs ?? 120_000;
        const idleAt = Math.max(grant.notBeforeMs, grant.lastActivityAtMs ?? grant.notBeforeMs) + idleMs;
        detail = `Open until ${clockAt(grant.endsAtMs, now, locale)} at the latest; closes after ${Math.round(idleMs / 1000)}s without activity (${clockAt(idleAt, now, locale)} if idle now).`;
      } else {
        detail = `Ends at ${clockAt(grant.endsAtMs, now, locale)} (${formatDashboardRemaining(remainingMs)} left).`;
      }
      grants.push({
        category,
        kind: grant.kind,
        status: grant.status,
        endsAt: grant.endsAtMs,
        remainingMs,
        countdown: countdownAt(grant.endsAtMs, now, locale),
        title: `${category} — ${kindLabel}`,
        detail,
      });
    }
  }
  grants.sort((a, b) => a.endsAt - b.endsAt || a.category.localeCompare(b.category));

  let allowanceTitle: string;
  let allowanceDetail: string;
  if (allowance.source === 'pending') {
    allowanceTitle = 'Allowance authority is initializing';
    allowanceDetail = 'Commands wait for the desktop authority before they can change relief.';
  } else if (!allowance.state) {
    allowanceTitle = 'Allowance state unavailable';
    allowanceDetail = 'The background has not reported a local allowance authority yet.';
  } else if (grants.length > 0) {
    allowanceTitle = `${grants.length} live relief ${grants.length === 1 ? 'grant' : 'grants'}`;
    allowanceDetail =
      allowance.source === 'daemon'
        ? 'Shared by the desktop daemon across your browsers.'
        : allowance.source === 'fallback'
          ? 'Browser-only fallback: this profile owns the pool.'
          : 'Using the state reported by the extension.';
  } else if (Object.keys(allowance.state.categories).length === 0) {
    allowanceTitle = 'No per-category allowance configured';
    allowanceDetail = 'Configure daily minutes or openings on the Breaks page.';
  } else {
    allowanceTitle = 'No allowance or opening is active';
    allowanceDetail = 'A configured category has no live grant right now.';
  }

  return {
    breakMode,
    allowanceSource: allowance.source,
    allowanceTitle,
    allowanceDetail,
    grants,
    statement:
      'Relief only relaxes classifier verdicts. Deterministic rules, an active category-schedule block, forced locks, and desktop enforcement keep applying.',
  };
}

function buildBlocking(
  settings: DashboardSettings,
  status: LockStatus,
): DashboardBlocking {
  if (status.forceBlocking) {
    return {
      enabled: true,
      forced: true,
      title: settings.enabled ? 'Blocking on — forced by a lock' : 'Blocking forced by a lock',
      detail: settings.enabled
        ? 'A focus session or focus-hours window is forcing blocking on.'
        : 'The master switch is off, but a focus session or focus-hours window is forcing blocking on.',
      tone: 'commit',
    };
  }
  if (settings.enabled) {
    return {
      enabled: true,
      forced: false,
      title: 'Blocking on',
      detail: 'Pages are checked on this device; only your blocked categories and rules are silenced.',
      tone: 'success',
    };
  }
  return {
    enabled: false,
    forced: false,
    title: 'Blocking paused',
    detail: 'New pages are not classified or blocked. An active lock can still force blocking on.',
    tone: 'warning',
  };
}

function formatTime(ts: number, locale?: string | string[]): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

function dayBounds(now: number): { start: number; end: number; date: Date } {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return { start, end, date };
}

/** Minute-sampled intervals for ONE rule inside [dayStart, dayEnd). The
 *  predicate is lock-math's own `currentWindowEnd`, so overnight windows,
 *  pinned offsets and overlap all keep the production semantics. */
function ruleIntervals(
  rule: ScheduleRule,
  dayStart: number,
  dayEnd: number,
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (let t = dayStart; t < dayEnd; t += MINUTE) {
    const active = currentWindowEnd([rule], new Date(t + MINUTE / 2)) !== null;
    if (active && open === null) open = t;
    if (!active && open !== null) {
      intervals.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null) intervals.push({ start: open, end: dayEnd });
  return intervals;
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];
  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function buildLane(
  id: 'global' | 'category',
  rules: ScheduleRule[],
  dayStart: number,
  dayEnd: number,
  locale?: string | string[],
): DashboardTimelineLane {
  const occurrences: DashboardTimelineOccurrence[] = [];
  const allIntervals: Array<{ start: number; end: number }> = [];

  for (const rule of rules) {
    const intervals = ruleIntervals(rule, dayStart, dayEnd);
    const startsBeforeToday = currentWindowEnd([rule], new Date(dayStart - 1)) !== null;
    const endsAfterToday = currentWindowEnd([rule], new Date(dayEnd)) !== null;
    for (const interval of intervals) {
      allIntervals.push(interval);
      const startsBefore = startsBeforeToday && interval.start === dayStart;
      const endsAfter = endsAfterToday && interval.end === dayEnd;
      const startLabel = formatTime(interval.start, locale);
      const endLabel = formatTime(interval.end, locale);
      const categoryRule = id === 'category' ? (rule as CategoryScheduleRule) : null;
      occurrences.push({
        ruleId: rule.id,
        summary: ruleSummary(rule),
        categories: categoryRule ? [...categoryRule.categories] : [],
        startLabel,
        endLabel,
        startsBeforeToday: startsBefore,
        endsAfterToday: endsAfter,
        text:
          `${ruleSummary(rule)}: ${startLabel}–${endLabel}` +
          (categoryRule ? ` · ${categoryRule.categories.join(', ')}` : '') +
          (startsBefore ? ' (from yesterday)' : '') +
          (endsAfter ? ' (continues tomorrow)' : ''),
      });
    }
  }

  const merged = mergeIntervals(allIntervals);
  const segments: DashboardTimelineSegment[] = merged.map((interval) => ({
    start: interval.start,
    end: interval.end,
    leftPct: ((interval.start - dayStart) / (dayEnd - dayStart)) * 100,
    widthPct: ((interval.end - interval.start) / (dayEnd - dayStart)) * 100,
    startsBeforeToday:
      interval.start === dayStart &&
      rules.some((rule) => currentWindowEnd([rule], new Date(dayStart - 1)) !== null),
    endsAfterToday:
      interval.end === dayEnd &&
      rules.some((rule) => currentWindowEnd([rule], new Date(dayEnd)) !== null),
    label: `${formatTime(interval.start, locale)}–${formatTime(interval.end, locale)}`,
  }));

  const title = id === 'global' ? 'Focus hours' : 'Category windows';
  const emptyText = id === 'global' ? 'No focus hours today.' : 'No category schedules today.';
  return {
    id,
    title,
    emptyText,
    segments,
    occurrences,
    text: occurrences.length ? occurrences.map((occurrence) => occurrence.text) : [emptyText],
  };
}

/** Build the today timeline. `now` only selects the local day and places the
 *  marker; the lanes themselves are deterministic for that day. */
export function buildDayTimeline(
  lockState: Pick<LockState, 'schedules' | 'categorySchedules'>,
  now: number,
  locale?: string | string[],
): DashboardTimeline {
  const { start: dayStart, end: dayEnd, date } = dayBounds(now);
  const span = dayEnd - dayStart;
  const nowClamped = Math.min(Math.max(now, dayStart), dayEnd);
  const ticks: DashboardTimelineTick[] = [0, 6, 12, 18, 24].map((hour) => {
    const at = hour === 24 ? dayEnd : new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime();
    return {
      at,
      label: formatTime(at, locale),
      pct: ((at - dayStart) / span) * 100,
    };
  });

  return {
    dayStart,
    dayEnd,
    now,
    nowPct: ((nowClamped - dayStart) / span) * 100,
    label: `Today · ${date.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' })}`,
    ticks,
    lanes: [
      buildLane('global', lockState.schedules, dayStart, dayEnd, locale),
      buildLane('category', lockState.categorySchedules ?? [], dayStart, dayEnd, locale),
    ],
  };
}

export function buildDashboard(input: DashboardInput): DashboardModel {
  const { now, settings, lockState, pendingFocus, companion, allowance } = input;
  const status = deriveLockStatus(lockState, now);
  const lock = buildLock(status, lockState, now, input.locale);
  const breakInfo = buildBreak(lockState, settings, now, input.locale);
  const focus = buildFocus(lockState, settings, pendingFocus, now, input.locale);
  const nextGlobal = nextTransition(lockState.schedules, 'global', now, input.locale);
  const nextCategory = nextTransition(
    lockState.categorySchedules ?? [],
    'category',
    now,
    input.locale,
  );

  return {
    now,
    nowLabel: clockAt(now, now, input.locale),
    blocking: buildBlocking(settings, status),
    lock,
    globalWindow: buildGlobalWindow(lockState.schedules, now, input.locale),
    categoryWindow: buildCategoryWindow(lockState.categorySchedules ?? [], now, input.locale),
    break: breakInfo,
    focus,
    companion: buildCompanion(companion, now),
    next: {
      global: nextGlobal,
      category: nextCategory,
      autoResume: buildAutoResume(settings, lockState.schedules, now, input.locale),
      pendingFocus: focus.kind === 'pending' ? focus : null,
      pendingBreak: breakInfo.pending ? breakInfo : null,
    },
    relief: buildRelief(settings, allowance, now, input.locale),
    timeline: input.timeline ?? buildDayTimeline(lockState, now, input.locale),
    profile: input.profile ?? null,
  };
}
