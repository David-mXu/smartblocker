// Unit tests for the pure lock/schedule math (src/shared/lock-math.ts).
// Runs directly under Node >= 22.6 type stripping — lock-math.ts is kept free
// of non-erasable TS syntax for exactly this reason.
//
//   node scripts/lock-math-test.mjs
import assert from 'node:assert/strict';
import {
  EMPTY_LOCK_STATE,
  currentWindowEnd,
  deriveLockStatus,
  isInScheduleWindow,
  nextBoundary,
  validateScheduleRule,
} from '../src/shared/lock-math.ts';

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

// Fixed local-time anchors (2026-07-06 is a Monday).
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
const MON = 1;

const workdays = { id: 'wd', days: [1, 2, 3, 4, 5], startMinutes: 9 * 60, endMinutes: 17 * 60 };
const monOvernight = { id: 'on', days: [MON], startMinutes: 22 * 60, endMinutes: 6 * 60 };

console.log('lock-math tests');

// --- simple window membership ---
test('inside a weekday window', () => {
  assert.equal(isInScheduleWindow([workdays], at(2026, 7, 8, 12, 0)), true); // Wed noon
});
test('before the window start', () => {
  assert.equal(isInScheduleWindow([workdays], at(2026, 7, 8, 8, 59)), false);
});
test('window start is inclusive', () => {
  assert.equal(isInScheduleWindow([workdays], at(2026, 7, 8, 9, 0)), true);
});
test('window end is exclusive', () => {
  assert.equal(isInScheduleWindow([workdays], at(2026, 7, 8, 17, 0)), false);
});
test('unlisted day (Saturday) is outside', () => {
  assert.equal(isInScheduleWindow([workdays], at(2026, 7, 11, 12, 0)), false);
});

// --- overnight windows (Mon 22:00 -> Tue 06:00) ---
test('overnight: Mon 22:00 starts the window', () => {
  assert.equal(isInScheduleWindow([monOvernight], at(2026, 7, 6, 22, 0)), true);
});
test('overnight: Mon 21:59 is before it', () => {
  assert.equal(isInScheduleWindow([monOvernight], at(2026, 7, 6, 21, 59)), false);
});
test('overnight: Tue 05:59 is still inside', () => {
  assert.equal(isInScheduleWindow([monOvernight], at(2026, 7, 7, 5, 59)), true);
});
test('overnight: Tue 06:00 has ended', () => {
  assert.equal(isInScheduleWindow([monOvernight], at(2026, 7, 7, 6, 0)), false);
});
test('overnight: Sun 23:00 is a different day', () => {
  assert.equal(isInScheduleWindow([monOvernight], at(2026, 7, 5, 23, 0)), false);
});
test('overnight: currentWindowEnd lands on Tue 06:00', () => {
  assert.equal(
    currentWindowEnd([monOvernight], at(2026, 7, 7, 3, 0)),
    at(2026, 7, 7, 6, 0).getTime(),
  );
});

// --- nextBoundary ---
test('nextBoundary: Sat evening -> next Monday 09:00 (week wraparound)', () => {
  const state = { ...EMPTY_LOCK_STATE, schedules: [workdays] };
  assert.equal(
    nextBoundary(state, at(2026, 7, 4, 20, 0).getTime()),
    at(2026, 7, 6, 9, 0).getTime(),
  );
});
test('nextBoundary: mid-window -> that window’s end', () => {
  const state = { ...EMPTY_LOCK_STATE, schedules: [workdays] };
  assert.equal(
    nextBoundary(state, at(2026, 7, 8, 12, 0).getTime()),
    at(2026, 7, 8, 17, 0).getTime(),
  );
});
test('nextBoundary: inside an overnight window started yesterday -> its end', () => {
  const state = { ...EMPTY_LOCK_STATE, schedules: [monOvernight] };
  assert.equal(
    nextBoundary(state, at(2026, 7, 7, 3, 0).getTime()),
    at(2026, 7, 7, 6, 0).getTime(),
  );
});
test('nextBoundary: earliest of timer/frozen/schedule wins', () => {
  const now = at(2026, 7, 8, 12, 0).getTime();
  const state = {
    ...EMPTY_LOCK_STATE,
    timerUntil: now + 60_000,
    frozenUntil: now + 120_000,
    schedules: [workdays],
  };
  assert.equal(nextBoundary(state, now), now + 60_000);
});
test('nextBoundary: nothing pending -> null', () => {
  assert.equal(nextBoundary(EMPTY_LOCK_STATE, Date.now()), null);
});

// --- deriveLockStatus ---
const NOW = at(2026, 7, 8, 12, 0).getTime(); // Wed noon

test('empty state is unlocked', () => {
  const s = deriveLockStatus(EMPTY_LOCK_STATE, NOW);
  assert.deepEqual(s, { settingsLocked: false, forceBlocking: false, reasons: [], until: null });
});
test('expired timer derives to inactive', () => {
  const s = deriveLockStatus({ ...EMPTY_LOCK_STATE, timerUntil: NOW - 1 }, NOW);
  assert.equal(s.settingsLocked, false);
});
test('active timer locks settings but does not force blocking', () => {
  const s = deriveLockStatus({ ...EMPTY_LOCK_STATE, timerUntil: NOW + 60_000 }, NOW);
  assert.equal(s.settingsLocked, true);
  assert.equal(s.forceBlocking, false);
  assert.deepEqual(s.reasons, ['timer']);
  assert.equal(s.until, NOW + 60_000);
});
test('password lock is indefinite (until: null)', () => {
  const s = deriveLockStatus({ ...EMPTY_LOCK_STATE, passwordHash: 'abc' }, NOW);
  assert.equal(s.settingsLocked, true);
  assert.equal(s.forceBlocking, false);
  assert.equal(s.until, null);
});
test('frozen turkey forces blocking', () => {
  const s = deriveLockStatus({ ...EMPTY_LOCK_STATE, frozenUntil: NOW + 60_000 }, NOW);
  assert.equal(s.forceBlocking, true);
  assert.deepEqual(s.reasons, ['frozen']);
});
test('schedule window forces blocking', () => {
  const s = deriveLockStatus({ ...EMPTY_LOCK_STATE, schedules: [workdays] }, NOW);
  assert.equal(s.settingsLocked, true);
  assert.equal(s.forceBlocking, true);
  assert.deepEqual(s.reasons, ['schedule']);
  assert.equal(s.until, at(2026, 7, 8, 17, 0).getTime());
});
test('until is the max of all active timed ends', () => {
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, timerUntil: NOW + 60_000, frozenUntil: NOW + 120_000 },
    NOW,
  );
  assert.equal(s.until, NOW + 120_000);
});

// --- validateScheduleRule ---
test('valid rule passes', () => {
  assert.equal(validateScheduleRule(workdays), null);
});
test('no days is rejected', () => {
  assert.notEqual(validateScheduleRule({ ...workdays, days: [] }), null);
});
test('out-of-range day is rejected', () => {
  assert.notEqual(validateScheduleRule({ ...workdays, days: [7] }), null);
});
test('start == end (empty window) is rejected', () => {
  assert.notEqual(validateScheduleRule({ ...workdays, endMinutes: workdays.startMinutes }), null);
});
test('out-of-range minutes are rejected', () => {
  assert.notEqual(validateScheduleRule({ ...workdays, endMinutes: 1440 }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
