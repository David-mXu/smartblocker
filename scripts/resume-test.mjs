// Unit tests for the pure auto-resume math (src/shared/resume.ts).
// Runs directly under Node >= 22.6 type stripping — resume.ts is kept free
// of non-erasable TS syntax for exactly this reason (same as lock-math.ts).
//
//   node scripts/resume-test.mjs
import assert from 'node:assert/strict';
import {
  clampResumeAt,
  MAX_RESUME_AHEAD_MS,
  nextResumeAt,
  nextScheduleStart,
  normalizeResumeMode,
  RESUME_ALARM_NAME,
} from '../src/shared/resume.ts';

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
const NOW = at(2026, 7, 8, 12, 0).getTime(); // Wed noon

console.log('resume tests');

// --- normalizeResumeMode ---
test('valid modes pass through', () => {
  assert.equal(normalizeResumeMode('off'), 'off');
  assert.equal(normalizeResumeMode('startup'), 'startup');
  assert.equal(normalizeResumeMode('schedule'), 'schedule');
  assert.equal(normalizeResumeMode('time'), 'time');
});
test('unknown / garbage modes degrade to off', () => {
  assert.equal(normalizeResumeMode('sometimes'), 'off');
  assert.equal(normalizeResumeMode(''), 'off');
  assert.equal(normalizeResumeMode(undefined), 'off');
  assert.equal(normalizeResumeMode(3), 'off');
});

// --- clampResumeAt ---
test('clamp: invalid values become null (disarm)', () => {
  assert.equal(clampResumeAt(null, NOW), null);
  assert.equal(clampResumeAt(undefined, NOW), null);
  assert.equal(clampResumeAt('tomorrow', NOW), null);
  assert.equal(clampResumeAt(NaN, NOW), null);
  assert.equal(clampResumeAt(Infinity, NOW), null);
  assert.equal(clampResumeAt(0, NOW), null);
  assert.equal(clampResumeAt(-5000, NOW), null);
});
test('clamp: inside the horizon passes through (rounded)', () => {
  assert.equal(clampResumeAt(NOW + 60_000, NOW), NOW + 60_000);
  assert.equal(clampResumeAt(NOW + 60_000.6, NOW), NOW + 60_001);
});
test('clamp: beyond 24h is pinned to the horizon (cap-to-24h)', () => {
  assert.equal(clampResumeAt(NOW + MAX_RESUME_AHEAD_MS + 1, NOW), NOW + MAX_RESUME_AHEAD_MS);
  assert.equal(clampResumeAt(NOW + 30 * MAX_RESUME_AHEAD_MS, NOW), NOW + MAX_RESUME_AHEAD_MS);
  assert.equal(clampResumeAt(NOW + MAX_RESUME_AHEAD_MS, NOW), NOW + MAX_RESUME_AHEAD_MS);
});

// --- nextResumeAt: off / startup / unknown ---
test('off mode never fires (even with an instant set)', () => {
  assert.equal(nextResumeAt({ mode: 'off', resumeAt: NOW + 60_000 }, [workdays], NOW), null);
});
test('startup mode has no clock trigger (event-driven)', () => {
  assert.equal(nextResumeAt({ mode: 'startup', resumeAt: NOW + 60_000 }, [workdays], NOW), null);
  assert.equal(nextResumeAt({ mode: 'startup', resumeAt: null }, [workdays], NOW), null);
});
test('unknown stored mode degrades to inert', () => {
  assert.equal(nextResumeAt({ mode: 'bogus', resumeAt: NOW + 60_000 }, [workdays], NOW), null);
});

// --- nextResumeAt: time ---
test('time: future instant fires exactly then', () => {
  assert.equal(nextResumeAt({ mode: 'time', resumeAt: NOW + 3_600_000 }, [], NOW), NOW + 3_600_000);
});
test('time: past instant clamps to now (overdue-clamp → fire immediately)', () => {
  assert.equal(nextResumeAt({ mode: 'time', resumeAt: NOW - 1 }, [], NOW), NOW);
  assert.equal(nextResumeAt({ mode: 'time', resumeAt: NOW }, [], NOW), NOW);
});
test('time: missing/invalid instant is inert', () => {
  assert.equal(nextResumeAt({ mode: 'time', resumeAt: null }, [], NOW), null);
  assert.equal(nextResumeAt({ mode: 'time', resumeAt: 'nope' }, [], NOW), null);
});
test('time: a tampered instant beyond 24h is capped', () => {
  assert.equal(
    nextResumeAt({ mode: 'time', resumeAt: NOW + MAX_RESUME_AHEAD_MS + 999 }, [], NOW),
    NOW + MAX_RESUME_AHEAD_MS,
  );
});

// --- nextResumeAt / nextScheduleStart: schedule mode ---
test('schedule: no rules → null (no-schedule case)', () => {
  assert.equal(nextResumeAt({ mode: 'schedule', resumeAt: null }, [], NOW), null);
  assert.equal(nextScheduleStart([], NOW), null);
});
test('schedule: degenerate rules never start → null', () => {
  assert.equal(nextScheduleStart([{ id: 'x', days: [], startMinutes: 9 * 60, endMinutes: 17 * 60 }], NOW), null);
});
test('schedule: Sat evening → next Monday 09:00 (week wraparound)', () => {
  assert.equal(nextScheduleStart([workdays], at(2026, 7, 4, 20, 0).getTime()), at(2026, 7, 6, 9, 0).getTime());
});
test('schedule: right before the window → that window’s start', () => {
  assert.equal(nextScheduleStart([workdays], at(2026, 7, 8, 8, 59).getTime()), at(2026, 7, 8, 9, 0).getTime());
});
test('schedule: mid-window skips to the NEXT start (end is not a start)', () => {
  // Wed noon inside 9–17 → next start is Thu 09:00, not today's 17:00 end.
  assert.equal(nextScheduleStart([workdays], at(2026, 7, 8, 12, 0).getTime()), at(2026, 7, 9, 9, 0).getTime());
});
test('schedule: exactly at window start counts as inside (inclusive start)', () => {
  assert.equal(nextScheduleStart([workdays], at(2026, 7, 8, 9, 0).getTime()), at(2026, 7, 9, 9, 0).getTime());
});
test('schedule: exactly at window end is outside → next start', () => {
  assert.equal(nextScheduleStart([workdays], at(2026, 7, 8, 17, 0).getTime()), at(2026, 7, 9, 9, 0).getTime());
});
test('schedule: overlapping windows are skipped as one stack', () => {
  const wide = { id: 'wide', days: [1, 2, 3, 4, 5], startMinutes: 8 * 60, endMinutes: 20 * 60 };
  // Wed noon: inside both 9–17 and 8–20 → hop past 20:00 → Thu 08:00.
  assert.equal(
    nextScheduleStart([workdays, wide], at(2026, 7, 8, 12, 0).getTime()),
    at(2026, 7, 9, 8, 0).getTime(),
  );
});
test('schedule: overnight window upcoming today (Sun → Mon 22:00)', () => {
  assert.equal(
    nextScheduleStart([monOvernight], at(2026, 7, 5, 20, 0).getTime()),
    at(2026, 7, 6, 22, 0).getTime(),
  );
});
test('schedule: inside an overnight window → next week’s start', () => {
  // Tue 03:00 is inside Mon 22:00→Tue 06:00; the next start is next Mon 22:00.
  assert.equal(
    nextScheduleStart([monOvernight], at(2026, 7, 7, 3, 0).getTime()),
    at(2026, 7, 13, 22, 0).getTime(),
  );
});
// Pinned-timezone rule, mirroring the lock-math tz tests: host-zone-independent.
const istPin = {
  id: 'tz-pin',
  days: [0, 1, 2, 3, 4, 5, 6],
  startMinutes: 540,
  endMinutes: 1020,
  tzOffsetMinutes: 330,
  tzName: 'Asia/Kolkata',
};
test('schedule: tz-pinned rule before the window → today’s pinned start', () => {
  // 14:00 IST (JAN5 08:30 UTC) is before the 15:00 IST start... pin is 09:00–17:00 IST:
  // 08:30 UTC = 14:00 IST is INSIDE 09:00–17:00, so next start is next day 09:00 IST.
  assert.equal(
    nextScheduleStart([istPin], Date.UTC(2026, 0, 5, 2, 0)), // 07:30 IST — before
    Date.UTC(2026, 0, 5, 3, 30), // 09:00 IST
  );
  assert.equal(
    nextScheduleStart([istPin], Date.UTC(2026, 0, 5, 10, 30)), // 16:00 IST — inside
    Date.UTC(2026, 0, 6, 3, 30), // next day 09:00 IST
  );
});

// --- constants ---
test('alarm name uses the resume- prefix; horizon is 24h', () => {
  assert.equal(RESUME_ALARM_NAME.startsWith('resume-'), true);
  assert.equal(MAX_RESUME_AHEAD_MS, 24 * 3_600_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
