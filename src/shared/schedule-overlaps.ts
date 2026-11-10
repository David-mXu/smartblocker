// Pure weekly-window overlap detection for global focus hours and
// per-category schedules. This is a DISPLAY aid, not a second scheduler:
// evaluation still lives exclusively in lock-math.ts / category-schedule-math.ts.
// The only scheduling primitive reused here is lock-math's window duration.
//
// Windows are half-open: [start, end). Two rules that merely touch at an
// endpoint (09:00–12:00 and 12:00–17:00) do NOT overlap. Overnight windows
// are expanded into their real day span before comparison, so a Monday
// 22:00–06:00 rule can overlap a Tuesday 05:00–07:00 rule. Timezone-pinned
// rules are shifted into the device's weekly frame using the same fixed
// offset evaluation uses; legacy rules use the current device offset.
//
// Keep this file erasable-syntax-only so Node can import it directly under
// type stripping.

import {
  formatMinutesClock,
  sortDaysForDisplay,
  type FirstDayOfWeek,
} from './display-prefs.ts';
import {
  scheduleWindowMinutes,
  type CategoryScheduleRule,
  type ScheduleRule,
} from './lock-math.ts';

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type ScheduleRuleKind = 'global' | 'category';

export interface ScheduleOverlapEntry {
  rule: ScheduleRule | CategoryScheduleRule;
  /** Defaults to "category" when the rule has a categories array. */
  kind?: ScheduleRuleKind;
}

export interface ScheduleOverlapOptions {
  firstDay?: FirstDayOfWeek;
  hour24?: boolean;
  /** Minutes EAST of UTC for unpinned (device-local) rules. Omit to read the
   *  current runtime offset. Pure tests pass this explicitly. */
  deviceOffsetMinutes?: number;
}

/** One canonical weekly occurrence of an overlap. */
export interface ScheduleOverlapInterval {
  /** Minutes from Sunday 00:00 in the device's frame (0…10079). */
  startWeekMinutes: number;
  durationMinutes: number;
  /** Start day 0=Sun … 6=Sat. */
  day: number;
  startMinutes: number;
  endDay: number;
  endMinutes: number;
}

export interface ScheduleOverlapPair {
  /** Stable for a given input order and rule ids. */
  key: string;
  kind: ScheduleRuleKind | 'mixed';
  aId: string;
  bId: string;
  aIndex: number;
  bIndex: number;
  /** "Mon 09:00–17:00" plus category/tz context when relevant. */
  aWindow: string;
  bWindow: string;
  /** "Mon 09:00–17:00 overlaps Mon 12:00–18:00". */
  summary: string;
  /** "Shared time: Mon 12:00–17:00." */
  detail: string;
  intervals: ScheduleOverlapInterval[];
}

interface Segment {
  start: number;
  end: number;
}

function resolveDeviceOffset(option: number | undefined): number {
  if (typeof option === 'number' && Number.isFinite(option)) return Math.round(option);
  return -new Date().getTimezoneOffset();
}

/** Mirrors lock-math's dispatch: a valid integer pin wins, otherwise the
 *  device's current offset is the rule's frame. */
function ruleOffset(rule: ScheduleRule, deviceOffset: number): number {
  return typeof rule.tzOffsetMinutes === 'number' && Number.isInteger(rule.tzOffsetMinutes)
    ? rule.tzOffsetMinutes
    : deviceOffset;
}

function kindOf(entry: ScheduleOverlapEntry): ScheduleRuleKind {
  if (entry.kind) return entry.kind;
  return Array.isArray((entry.rule as CategoryScheduleRule).categories) ? 'category' : 'global';
}

function isValidRule(rule: ScheduleRule): boolean {
  if (!Array.isArray(rule.days) || rule.days.length === 0) return false;
  if (rule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return false;
  if (!Number.isInteger(rule.startMinutes) || !Number.isInteger(rule.endMinutes)) return false;
  if (rule.startMinutes < 0 || rule.startMinutes > 1_439) return false;
  if (rule.endMinutes < 0 || rule.endMinutes > 1_439) return false;
  return rule.startMinutes !== rule.endMinutes;
}

/** Real weekly spans for one rule in the device's frame. The ±1 week copies
 *  let a Sunday-night window overlap a Monday-morning one without special
 *  cases; duplicates are removed after the intersection step. */
function ruleSegments(rule: ScheduleRule, deviceOffset: number): Segment[] {
  if (!isValidRule(rule)) return [];
  const duration = scheduleWindowMinutes(rule);
  if (duration <= 0) return [];
  const shift = deviceOffset - ruleOffset(rule, deviceOffset);
  const days = [...new Set(rule.days)].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (const day of days) {
    const base = day * MINUTES_PER_DAY + rule.startMinutes + shift;
    for (const week of [-1, 0, 1]) {
      const start = base + week * MINUTES_PER_WEEK;
      segments.push({ start, end: start + duration });
    }
  }
  return segments;
}

function canonicalStart(start: number): number {
  return ((start % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
}

function toInterval(start: number, duration: number): ScheduleOverlapInterval {
  const end = start + duration;
  return {
    startWeekMinutes: start,
    durationMinutes: duration,
    day: Math.floor(start / MINUTES_PER_DAY) % 7,
    startMinutes: start % MINUTES_PER_DAY,
    endDay: Math.floor(end / MINUTES_PER_DAY) % 7,
    endMinutes: end % MINUTES_PER_DAY,
  };
}

/** Canonical, de-duplicated weekly intersection occurrences, earliest first. */
function collectIntervals(a: Segment[], b: Segment[]): ScheduleOverlapInterval[] {
  const byKey = new Map<string, ScheduleOverlapInterval>();
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (end <= start) continue;
      const canonical = canonicalStart(start);
      const duration = end - start;
      const key = `${canonical}:${duration}`;
      if (!byKey.has(key)) byKey.set(key, toInterval(canonical, duration));
    }
  }
  return [...byKey.values()].sort(
    (x, y) => x.startWeekMinutes - y.startWeekMinutes || x.durationMinutes - y.durationMinutes,
  );
}

/** Shared day-list wording for the schedule editor and overlap notices. */
export function formatScheduleDays(days: number[], firstDay: FirstDayOfWeek = 0): string {
  const unique = [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  const set = unique.join(',');
  if (set === '') return 'No days picked';
  if (set === '0,1,2,3,4,5,6') return 'Every day';
  if (set === '1,2,3,4,5') return 'Weekdays';
  if (set === '0,6') return 'Weekends';
  return sortDaysForDisplay(unique, firstDay)
    .map((day) => DAY_SHORT[day])
    .join(', ');
}

function offsetLabel(offset: number): string {
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function timezoneSuffix(rule: ScheduleRule, deviceOffset: number): string {
  const offset = ruleOffset(rule, deviceOffset);
  if (offset === deviceOffset) return '';
  const name =
    typeof rule.tzName === 'string' && rule.tzName.trim() !== ''
      ? rule.tzName.trim()
      : offsetLabel(offset);
  return ` (${name})`;
}

function categorySuffix(entry: ScheduleOverlapEntry, kind: ScheduleRuleKind): string {
  if (kind !== 'category') return '';
  const categories = (entry.rule as CategoryScheduleRule).categories;
  if (!Array.isArray(categories) || categories.length === 0) return '';
  const shown =
    categories.length <= 2
      ? categories.join(', ')
      : `${categories[0]}, ${categories[1]} +${categories.length - 2}`;
  return ` · ${shown}`;
}

/** Human-readable window for a rule, using the user's display preferences. */
export function formatScheduleWindow(
  entry: ScheduleOverlapEntry,
  options: ScheduleOverlapOptions = {},
): string {
  const firstDay = options.firstDay ?? 0;
  const hour24 = options.hour24 ?? false;
  const deviceOffset = resolveDeviceOffset(options.deviceOffsetMinutes);
  const rule = entry.rule;
  const kind = kindOf(entry);
  const range = `${formatMinutesClock(rule.startMinutes, hour24)}–${formatMinutesClock(
    rule.endMinutes,
    hour24,
  )}`;
  return `${formatScheduleDays(rule.days, firstDay)} ${range}${categorySuffix(
    entry,
    kind,
  )}${timezoneSuffix(rule, deviceOffset)}`;
}

function formatInterval(interval: ScheduleOverlapInterval, hour24: boolean): string {
  const start = `${DAY_SHORT[interval.day]} ${formatMinutesClock(interval.startMinutes, hour24)}`;
  if (interval.day === interval.endDay) {
    return `${start}–${formatMinutesClock(interval.endMinutes, hour24)}`;
  }
  return `${start}–${DAY_SHORT[interval.endDay]} ${formatMinutesClock(
    interval.endMinutes,
    hour24,
  )}`;
}

function formatSharedTime(
  intervals: ScheduleOverlapInterval[],
  hour24: boolean,
  firstDay: FirstDayOfWeek,
): string {
  const parts: string[] = [];
  const emittedSameDay = new Set<string>();
  for (const interval of intervals) {
    if (interval.day === interval.endDay) {
      const key = `${interval.startMinutes}:${interval.endMinutes}`;
      if (emittedSameDay.has(key)) continue;
      emittedSameDay.add(key);
      const days = intervals
        .filter(
          (candidate) =>
            candidate.day === candidate.endDay &&
            candidate.startMinutes === interval.startMinutes &&
            candidate.endMinutes === interval.endMinutes,
        )
        .map((candidate) => candidate.day);
      parts.push(
        `${formatScheduleDays(days, firstDay)} ${formatMinutesClock(
          interval.startMinutes,
          hour24,
        )}–${formatMinutesClock(interval.endMinutes, hour24)}`,
      );
    } else {
      parts.push(formatInterval(interval, hour24));
    }
  }
  const shown = parts.slice(0, 3);
  const extra = parts.length - shown.length;
  return `${shown.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}`;
}

/**
 * Deterministic pairwise overlap report.
 *
 * Input order defines pair order (`aIndex`, `bIndex`); intervals inside a pair
 * are ordered by their canonical weekly start. Invalid/empty rules are
 * ignored. Only pairs with at least one real [start, end) intersection are
 * returned, so callers render nothing when the list is empty.
 */
export function findScheduleOverlaps(
  entries: readonly ScheduleOverlapEntry[],
  options: ScheduleOverlapOptions = {},
): ScheduleOverlapPair[] {
  const firstDay = options.firstDay ?? 0;
  const hour24 = options.hour24 ?? false;
  const deviceOffset = resolveDeviceOffset(options.deviceOffsetMinutes);
  const pairs: ScheduleOverlapPair[] = [];

  for (let aIndex = 0; aIndex < entries.length; aIndex++) {
    const a = entries[aIndex];
    const aKind = kindOf(a);
    const aSegments = ruleSegments(a.rule, deviceOffset);
    if (aSegments.length === 0) continue;
    for (let bIndex = aIndex + 1; bIndex < entries.length; bIndex++) {
      const b = entries[bIndex];
      const bSegments = ruleSegments(b.rule, deviceOffset);
      if (bSegments.length === 0) continue;
      const intervals = collectIntervals(aSegments, bSegments);
      if (intervals.length === 0) continue;
      const bKind = kindOf(b);
      const kind = aKind === bKind ? aKind : ('mixed' as const);
      const aWindow = formatScheduleWindow(a, options);
      const bWindow = formatScheduleWindow(b, options);
      pairs.push({
        key: `${kind}:${a.rule.id}:${b.rule.id}:${aIndex}:${bIndex}`,
        kind,
        aId: a.rule.id,
        bId: b.rule.id,
        aIndex,
        bIndex,
        aWindow,
        bWindow,
        summary: `${aWindow} overlaps ${bWindow}`,
        detail: `Shared time: ${formatSharedTime(intervals, hour24, firstDay)}.`,
        intervals,
      });
    }
  }

  // Input order is already deterministic; this explicit sort keeps that
  // promise if the implementation above changes.
  return pairs.sort((x, y) => x.aIndex - y.aIndex || x.bIndex - y.bIndex);
}

/** True when any pair overlaps. Tiny convenience for callers that only need
 *  the presence of a warning. */
export function hasScheduleOverlap(
  entries: readonly ScheduleOverlapEntry[],
  options: ScheduleOverlapOptions = {},
): boolean {
  return findScheduleOverlaps(entries, options).length > 0;
}
