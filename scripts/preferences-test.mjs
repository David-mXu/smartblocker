// Unit tests for pure display preferences and block-message sanitization.
//   node scripts/preferences-test.mjs
import assert from 'node:assert/strict';
import {
  MAX_BLOCK_MESSAGE_LENGTH,
  formatMinutesClock,
  normalizeFirstDayOfWeek,
  normalizeHour24,
  orderedWeekdays,
  sanitizeBlockMessage,
  sortDaysForDisplay,
  weekdayOrderIndex,
} from '../src/shared/display-prefs.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log('display preference tests');

test('first day normalizes to Sunday or Monday only', () => {
  assert.equal(normalizeFirstDayOfWeek(1), 1);
  assert.equal(normalizeFirstDayOfWeek(0), 0);
  assert.equal(normalizeFirstDayOfWeek('1'), 0);
  assert.equal(normalizeFirstDayOfWeek(undefined), 0);
  assert.equal(normalizeFirstDayOfWeek(6), 0);
});

test('hour24 is a strict boolean preference', () => {
  assert.equal(normalizeHour24(true), true);
  assert.equal(normalizeHour24('true'), false);
  assert.equal(normalizeHour24(1), false);
  assert.equal(normalizeHour24(undefined), false);
});

test('weekday order follows the first-day preference', () => {
  assert.deepEqual(orderedWeekdays(0), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(orderedWeekdays(1), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(weekdayOrderIndex(0, 1), 6);
  assert.equal(weekdayOrderIndex(1, 1), 0);
  assert.deepEqual(sortDaysForDisplay([5, 0, 1], 1), [1, 5, 0]);
  assert.deepEqual(sortDaysForDisplay([5, 0, 1], 0), [0, 1, 5]);
});

test('12-hour formatting handles midnight, noon, and padded minutes', () => {
  assert.equal(formatMinutesClock(0, false), '12:00 AM');
  assert.equal(formatMinutesClock(9 * 60 + 5, false), '9:05 AM');
  assert.equal(formatMinutesClock(12 * 60, false), '12:00 PM');
  assert.equal(formatMinutesClock(18 * 60 + 30, false), '6:30 PM');
  assert.equal(formatMinutesClock(23 * 60 + 59, false), '11:59 PM');
});

test('24-hour formatting is zero-padded and wraps safely', () => {
  assert.equal(formatMinutesClock(0, true), '00:00');
  assert.equal(formatMinutesClock(9 * 60 + 5, true), '09:05');
  assert.equal(formatMinutesClock(18 * 60 + 30, true), '18:30');
  assert.equal(formatMinutesClock(1440, true), '00:00');
  assert.equal(formatMinutesClock(-60, true), '23:00');
});

test('block message trims, collapses, strips controls, and caps length', () => {
  assert.equal(sanitizeBlockMessage('  Finish\u0000 the  set.\n'), 'Finish the set.');
  assert.equal(sanitizeBlockMessage('<b>not html</b>'), '<b>not html</b>');
  assert.equal(sanitizeBlockMessage('line one\nline two'), 'line one line two');
  assert.equal(sanitizeBlockMessage(null), '');
  assert.equal(sanitizeBlockMessage(42), '');
  const long = 'x'.repeat(MAX_BLOCK_MESSAGE_LENGTH + 40);
  assert.equal(sanitizeBlockMessage(long).length, MAX_BLOCK_MESSAGE_LENGTH);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
