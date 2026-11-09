// Unit tests for the pure lock/schedule math (src/shared/lock-math.ts).
// Runs directly under Node >= 22.6 type stripping — lock-math.ts is kept free
// of non-erasable TS syntax for exactly this reason.
//
//   node scripts/lock-math-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EMPTY_LOCK_STATE,
  currentWindowEnd,
  deriveLockStatus,
  isInScheduleWindow,
  makeBreakOperation,
  mergeLockStates,
  nextBoundary,
  nextScheduleLockAt,
  nextWindowStart,
  sanitizeLockState,
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
  assert.deepEqual(s, {
    breakActive: false,
    breakStartedAt: null,
    breakNotBefore: null,
    breakEndsAt: null,
    settingsLocked: false,
    forceBlocking: false,
    reasons: [],
    until: null,
  });
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

// --- tz-pinned windows (red-team #26) ---
// Pinned rules evaluate against their OWN fixed offset — host-zone-indepen-
// dent, so these hold on any dev machine. The pinned cases below mirror the
// shared fixtures; the legacy case pins down the pre-#26 behavior absent
// fields must keep. DST residual: fixed offsets cannot follow DST changes —
// a rule pinned in winter fires an hour off after the change (documented in
// lock-math.ts; encoded as a shared fixture).
const JAN5 = (h, m) => Date.UTC(2026, 0, 5, h, m); // a Monday
const istPin = {
  id: 'tz-pin',
  days: [0, 1, 2, 3, 4, 5, 6],
  startMinutes: 540,
  endMinutes: 1020,
  tzOffsetMinutes: 330,
  tzName: 'Asia/Kolkata',
};

test('pinned rule: 16:00 IST (10:30 UTC) is inside the pinned window', () => {
  const d = new Date(JAN5(10, 30));
  assert.equal(isInScheduleWindow([istPin], d), true);
  assert.equal(currentWindowEnd([istPin], d), JAN5(11, 30)); // 17:00 IST
});
test('pinned rule: 17:30 IST is outside — the device UTC clock cannot sidestep the pin', () => {
  assert.equal(isInScheduleWindow([istPin], new Date(JAN5(12, 0))), false);
});
test('legacy rule (no tz fields) keeps pre-#26 device-local behavior', () => {
  const legacy = { id: 'legacy', days: [1, 2, 3, 4, 5], startMinutes: 9 * 60, endMinutes: 17 * 60 };
  assert.equal('tzOffsetMinutes' in legacy, false);
  assert.equal(isInScheduleWindow([legacy], at(2026, 7, 8, 12, 0)), true);
  assert.equal(isInScheduleWindow([legacy], at(2026, 7, 8, 8, 59)), false);
});
test('validateScheduleRule: tz pin bounds are UTC−12:00 … UTC+14:00', () => {
  assert.equal(validateScheduleRule({ ...istPin, tzOffsetMinutes: -720 }), null);
  assert.equal(validateScheduleRule({ ...istPin, tzOffsetMinutes: 840 }), null);
  assert.notEqual(validateScheduleRule({ ...istPin, tzOffsetMinutes: 841 }), null);
  assert.notEqual(validateScheduleRule({ ...istPin, tzOffsetMinutes: 330.5 }), null);
  assert.notEqual(validateScheduleRule({ ...istPin, tzName: 42 }), null);
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
test('schedule lead: 0 and 1440 are accepted, out-of-range and fractional are rejected', () => {
  assert.equal(validateScheduleRule({ ...workdays, leadMinutes: 0 }), null);
  assert.equal(validateScheduleRule({ ...workdays, leadMinutes: 1 }), null);
  assert.equal(validateScheduleRule({ ...workdays, leadMinutes: 1440 }), null);
  assert.notEqual(validateScheduleRule({ ...workdays, leadMinutes: -1 }), null);
  assert.notEqual(validateScheduleRule({ ...workdays, leadMinutes: 1441 }), null);
  assert.notEqual(validateScheduleRule({ ...workdays, leadMinutes: 30.5 }), null);
});

// --- settings-lock lead time ---
const leadWorkdays = { ...workdays, leadMinutes: 30 };

test('lead: 08:30 is inside the pre-lock and freezes settings only', () => {
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, schedules: [leadWorkdays] },
    at(2026, 7, 8, 8, 30).getTime(),
  );
  assert.equal(s.settingsLocked, true);
  assert.equal(s.forceBlocking, false);
  assert.deepEqual(s.reasons, ['schedule-lead']);
  assert.equal(s.until, at(2026, 7, 8, 17, 0).getTime());
});
test('lead: exact window start switches to the ordinary schedule reason', () => {
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, schedules: [leadWorkdays] },
    at(2026, 7, 8, 9, 0).getTime(),
  );
  assert.deepEqual(s.reasons, ['schedule']);
  assert.equal(s.forceBlocking, true);
});
test('lead: one minute before the window start is still pre-lock', () => {
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, schedules: [leadWorkdays] },
    at(2026, 7, 8, 8, 59).getTime(),
  );
  assert.deepEqual(s.reasons, ['schedule-lead']);
});
test('lead: overlapping windows keep schedule then schedule-lead order', () => {
  const other = { id: 'other', days: [3], startMinutes: 10 * 60, endMinutes: 11 * 60, leadMinutes: 60 };
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, schedules: [workdays, other] },
    at(2026, 7, 8, 9, 30).getTime(),
  );
  assert.deepEqual(s.reasons, ['schedule', 'schedule-lead']);
  assert.equal(s.until, at(2026, 7, 8, 17, 0).getTime());
});
test('lead: overnight window lead begins the previous evening', () => {
  const overnight = { ...monOvernight, leadMinutes: 60 };
  const before = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, schedules: [overnight] },
    at(2026, 7, 6, 21, 30).getTime(),
  );
  assert.deepEqual(before.reasons, ['schedule-lead']);
  assert.equal(before.forceBlocking, false);
  assert.equal(before.until, at(2026, 7, 7, 6, 0).getTime());
});
test('lead: category schedule lead never locks settings', () => {
  const category = {
    ...leadWorkdays,
    id: 'cat',
    categories: ['video games'],
  };
  const s = deriveLockStatus(
    { ...EMPTY_LOCK_STATE, categorySchedules: [category] },
    at(2026, 7, 8, 8, 30).getTime(),
  );
  assert.equal(s.settingsLocked, false);
  assert.equal(s.forceBlocking, false);
  assert.deepEqual(s.reasons, []);
});
test('nextScheduleLockAt: lead start, not the window start', () => {
  assert.equal(
    nextScheduleLockAt([leadWorkdays], at(2026, 7, 8, 8, 0).getTime()),
    at(2026, 7, 8, 8, 30).getTime(),
  );
});
test('nextScheduleLockAt: without a lead it is the window start', () => {
  assert.equal(
    nextScheduleLockAt([workdays], at(2026, 7, 8, 8, 0).getTime()),
    at(2026, 7, 8, 9, 0).getTime(),
  );
});
test('nextWindowStart: ignores the lead and resumes at the real window', () => {
  assert.equal(
    nextWindowStart([leadWorkdays], at(2026, 7, 8, 8, 0).getTime()),
    at(2026, 7, 8, 9, 0).getTime(),
  );
});
test('nextBoundary: lead start fires before the window start', () => {
  const state = { ...EMPTY_LOCK_STATE, schedules: [leadWorkdays] };
  assert.equal(
    nextBoundary(state, at(2026, 7, 8, 8, 0).getTime()),
    at(2026, 7, 8, 8, 30).getTime(),
  );
});

// --- break operation construction ---
test('break operation: delay is pending, leaves lock fields out of the result', () => {
  assert.deepEqual(makeBreakOperation(NOW, 60_000, 600_000), {
    breakStartedAt: NOW,
    breakNotBefore: NOW + 60_000,
    breakEndsAt: NOW + 660_000,
    breakUpdatedAt: NOW,
  });
});
test('break operation: immediate mode has a finite active interval', () => {
  const operation = makeBreakOperation(NOW, 0, 600_000);
  const state = { ...EMPTY_LOCK_STATE, ...operation };
  assert.equal(deriveLockStatus(state, NOW).breakActive, true);
  assert.equal(deriveLockStatus(state, NOW + 600_000).breakActive, false);
});
test('break operation: duration and total horizon cannot exceed 24h', () => {
  assert.equal(makeBreakOperation(NOW, 0, 48 * 3_600_000).breakEndsAt, NOW + 24 * 3_600_000);
  assert.throws(() => makeBreakOperation(NOW, 24 * 3_600_000, 60_000));
});

// --- cross-language golden fixtures (shared with the Rust companion) ---
// The same file drives smartblocker-core's cargo tests; a case failing here or
// there means the TS and Rust lock implementations have drifted apart.
const fixtures = JSON.parse(
  readFileSync(
    new URL('../companion/crates/smartblocker-core/tests/fixtures/lock-cases.json', import.meta.url),
    'utf8',
  ),
);

for (const c of fixtures.mergeLockStates) {
  test(`fixture merge: ${c.name}`, () => {
    const now = c.now ?? 0;
    assert.deepEqual(mergeLockStates(c.a, c.b, now), c.expect);
    // The merge is a convergence step between two independent stores — it
    // must be commutative and idempotent or the sides never settle.
    assert.deepEqual(mergeLockStates(c.b, c.a, now), c.expect);
    assert.deepEqual(mergeLockStates(c.expect, c.expect, now), c.expect);
  });
}
for (const c of fixtures.deriveLockStatus) {
  test(`fixture status: ${c.name}`, () => {
    assert.deepEqual(deriveLockStatus(c.state, c.now), c.expect);
  });
}
for (const c of fixtures.nextBoundary) {
  test(`fixture boundary: ${c.name}`, () => {
    assert.equal(nextBoundary(c.state, c.now), c.expect);
  });
}
for (const c of fixtures.sanitizeLockState) {
  test(`fixture sanitize: ${c.name}`, () => {
    assert.deepEqual(sanitizeLockState(c.raw, c.now, c.maxLockMs), c.expect);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
