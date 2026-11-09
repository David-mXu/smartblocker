// Pure display preferences — no browser APIs, no imports. Kept dependency-free
// like lock-math.ts so scripts/preferences-test.mjs can import it directly
// under Node type stripping.
//
// These preferences change PRESENTATION only: schedule evaluation still uses
// the same minutes-since-midnight and Sunday=0 day indexing as lock-math.ts.

/** 0 = Sunday (Date.getDay()/ScheduleRule.days index), 1 = Monday. */
export type FirstDayOfWeek = 0 | 1;

/** Hard cap for the optional custom block-screen message. */
export const MAX_BLOCK_MESSAGE_LENGTH = 160;

export function normalizeFirstDayOfWeek(raw: unknown): FirstDayOfWeek {
  return raw === 1 ? 1 : 0;
}

export function normalizeHour24(raw: unknown): boolean {
  return raw === true;
}

/** Bounded single-line plain text. Control characters are collapsed to a
 *  space so the message cannot smuggle layout tricks into the block screen;
 *  HTML is NOT parsed here, and renderers must still use textContent. */
export function sanitizeBlockMessage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BLOCK_MESSAGE_LENGTH);
}

/** Weekdays in display order for the chosen first day of week. */
export function orderedWeekdays(firstDay: FirstDayOfWeek): number[] {
  return firstDay === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
}

/** Position of a weekday in the preferred display order (0..6). */
export function weekdayOrderIndex(day: number, firstDay: FirstDayOfWeek): number {
  return ((day - firstDay + 7) % 7);
}

/** Sort a day list into display order without mutating the input. */
export function sortDaysForDisplay(days: number[], firstDay: FirstDayOfWeek): number[] {
  return [...days].sort((a, b) => weekdayOrderIndex(a, firstDay) - weekdayOrderIndex(b, firstDay));
}

/** Minutes since local midnight → "9:05 AM" or "09:05". Locale-independent
 *  on purpose: this is the shared testable formatter; options can still use
 *  its own localized date text. */
export function formatMinutesClock(minutes: number, hour24: boolean): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  const mm = String(m).padStart(2, '0');
  if (hour24) return `${String(h).padStart(2, '0')}:${mm}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}
