// Pure notification derivation tests. Node >= 22.6 type stripping imports
// src/shared/notifications.ts directly; the module deliberately avoids
// non-erasable TypeScript syntax and browser APIs.
//
//   node scripts/notifications-test.mjs
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_NOTIFICATION_LEDGER_KEYS,
  NOTIFICATION_ALARM_NAMES,
  NOTIFICATION_ALARM_PREFIX,
  NOTIFICATION_IDS,
  NOTIFICATION_PREFS_VERSION,
  isAllowlistedNotificationAlarm,
  isAllowlistedNotificationId,
  isNotificationAlarm,
  normalizeNotificationLedger,
  normalizeNotificationPrefs,
  notificationKindForAlarm,
  planNotifications,
  rememberNotification,
} from '../src/shared/notifications.ts';
import {
  createEmptyAllowanceLedger,
  requestAllowance,
} from '../src/shared/allowance-math.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.stack ?? e.message}`);
  }
}

const MIN = 60_000;
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const MON = 1;
const WED = 3;
const SUN = 0;

const workdays = {
  id: 'wd',
  days: [1, 2, 3, 4, 5],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
};
const monOvernight = {
  id: 'on',
  days: [MON],
  startMinutes: 22 * 60,
  endMinutes: 6 * 60,
};
const wedCategory = {
  id: 'cat',
  days: [WED],
  startMinutes: 9 * 60,
  endMinutes: 10 * 60,
  categories: ['video games'],
};

function allOn({
  scheduleLead = 5,
  breakLead = 5,
  allowanceThreshold = 5,
} = {}) {
  return {
    version: NOTIFICATION_PREFS_VERSION,
    scheduleStartingSoon: { enabled: true, leadMinutes: scheduleLead },
    breakEndingSoon: { enabled: true, leadMinutes: breakLead },
    allowanceLow: { enabled: true, thresholdMinutes: allowanceThreshold },
  };
}

function plan({
  prefs = allOn(),
  lockState = {},
  allowanceState = undefined,
  firedKeys = [],
  now,
}) {
  return planNotifications({ prefs, lockState, allowanceState, firedKeys, now });
}

function scheduleAlarm(result) {
  return result.alarms.find((event) => event.kind === 'schedule-start') ?? null;
}
function breakAlarm(result) {
  return result.alarms.find((event) => event.kind === 'break-end') ?? null;
}
function allowanceAlarm(result) {
  return result.alarms.find((event) => event.kind === 'allowance-low') ?? null;
}

// Allowance authority fixture: a 10-minute active allowance starting at T0.
const ALLOWANCE_T0 = at(2026, 7, 8, 12, 0);
const ALLOWANCE_DAY = '2026-07-08';
const ALLOWANCE_CONFIG = {
  dailyAllowanceMs: 60 * MIN,
  dailyOpenings: 1,
  waitingBaseMs: 0,
  waitingStepMs: 0,
  waitingMaxMs: 0,
  rewardCapMs: 0,
  openingInactivityMs: 120_000,
  openingMaxLifetimeMs: 30 * MIN,
};
function allowanceAuthority({ nowMs = ALLOWANCE_T0, durationMs = 10 * MIN } = {}) {
  const empty = createEmptyAllowanceLedger({
    nowMs,
    dayKey: ALLOWANCE_DAY,
  });
  const requested = requestAllowance(empty, ALLOWANCE_CONFIG, {
    grantId: 'grant-1',
    nowMs,
    dayKey: ALLOWANCE_DAY,
    durationMs,
  });
  assert.equal(requested.ok, true, requested.ok ? '' : requested.reason);
  return {
    version: 1,
    revision: 1,
    categories: {
      'video games': { config: ALLOWANCE_CONFIG, ledger: requested.ledger },
    },
    receipts: [],
  };
}

console.log('notification derivation tests');

// --- preference schema ---
test('defaults are OFF and versioned', () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFS.version, NOTIFICATION_PREFS_VERSION);
  assert.equal(DEFAULT_NOTIFICATION_PREFS.scheduleStartingSoon.enabled, false);
  assert.equal(DEFAULT_NOTIFICATION_PREFS.breakEndingSoon.enabled, false);
  assert.equal(DEFAULT_NOTIFICATION_PREFS.allowanceLow.enabled, false);
  assert.deepEqual(normalizeNotificationPrefs(undefined), DEFAULT_NOTIFICATION_PREFS);
  assert.deepEqual(normalizeNotificationPrefs('garbage'), DEFAULT_NOTIFICATION_PREFS);
});
test('unknown future preference versions reset to safe defaults', () => {
  const future = normalizeNotificationPrefs({
    version: 99,
    scheduleStartingSoon: { enabled: true, leadMinutes: 30 },
  });
  assert.deepEqual(future, DEFAULT_NOTIFICATION_PREFS);
});
test('minutes are strictly clamped and rounded', () => {
  const prefs = normalizeNotificationPrefs({
    version: 1,
    scheduleStartingSoon: { enabled: true, leadMinutes: 0 },
    breakEndingSoon: { enabled: true, leadMinutes: 999 },
    allowanceLow: { enabled: true, thresholdMinutes: 7.6 },
  });
  assert.equal(prefs.scheduleStartingSoon.leadMinutes, 1);
  assert.equal(prefs.breakEndingSoon.leadMinutes, 60);
  assert.equal(prefs.allowanceLow.thresholdMinutes, 8);
  const invalid = normalizeNotificationPrefs({
    version: 1,
    scheduleStartingSoon: { enabled: true, leadMinutes: 'ten' },
  });
  assert.equal(invalid.scheduleStartingSoon.leadMinutes, 5);
  assert.equal(invalid.scheduleStartingSoon.enabled, true);
});
test('enabled requires a real boolean true (no truthy coercion)', () => {
  const prefs = normalizeNotificationPrefs({
    version: 1,
    scheduleStartingSoon: { enabled: 1, leadMinutes: 5 },
  });
  assert.equal(prefs.scheduleStartingSoon.enabled, false);
});

// --- alarm / notification allowlists ---
test('alarm names are complete, prefixed, and allowlisted', () => {
  assert.equal(NOTIFICATION_ALARM_PREFIX, 'sb-notify:');
  assert.equal(Object.keys(NOTIFICATION_ALARM_NAMES).length, 3);
  for (const [kind, name] of Object.entries(NOTIFICATION_ALARM_NAMES)) {
    assert.equal(name.startsWith(NOTIFICATION_ALARM_PREFIX), true);
    assert.equal(isNotificationAlarm(name), true);
    assert.equal(isAllowlistedNotificationAlarm(name), true);
    assert.equal(notificationKindForAlarm(name), kind);
  }
});
test('unknown prefixed alarms are recognized as stale but not allowlisted', () => {
  assert.equal(isNotificationAlarm('sb-notify:old-name'), true);
  assert.equal(isAllowlistedNotificationAlarm('sb-notify:old-name'), false);
  assert.equal(isNotificationAlarm('lock-boundary'), false);
  assert.equal(notificationKindForAlarm('sb-notify:old-name'), null);
});
test('OS notification ids are fixed and allowlisted', () => {
  assert.equal(Object.keys(NOTIFICATION_IDS).length, 3);
  for (const id of Object.values(NOTIFICATION_IDS)) {
    assert.equal(isAllowlistedNotificationId(id), true);
    assert.equal(id.startsWith('smartblocker-notify-'), true);
  }
  assert.equal(isAllowlistedNotificationId('smartblocker-notify-old'), false);
});

// --- schedule lead windows ---
test('schedule lead fires exactly lead minutes before a start', () => {
  const now = at(2026, 7, 8, 8, 54); // Wed
  const result = plan({ lockState: { schedules: [workdays] }, now });
  const event = scheduleAlarm(result);
  assert.ok(event);
  assert.equal(event.eventAt, at(2026, 7, 8, 9, 0));
  assert.equal(event.fireAt, at(2026, 7, 8, 8, 55));
  assert.equal(event.fireAt > now, true);
  assert.match(event.title, /Focus hours start soon/);
  assert.match(event.message, /start at/);
});
test('inside the lead window the candidate is due immediately', () => {
  const now = at(2026, 7, 8, 8, 58);
  const result = plan({ lockState: { schedules: [workdays] }, now });
  const event = scheduleAlarm(result);
  assert.ok(event);
  assert.equal(event.fireAt <= now, true);
});
test('a started window is skipped; the planner looks at the next start', () => {
  const now = at(2026, 7, 8, 9, 1); // just inside 9–17
  const result = plan({ lockState: { schedules: [workdays] }, now });
  const event = scheduleAlarm(result);
  assert.ok(event);
  assert.equal(event.eventAt, at(2026, 7, 9, 9, 0)); // Thursday
  assert.equal(event.eventAt > now, true);
});
test('a degenerate rule never yields a reminder', () => {
  const result = plan({
    lockState: {
      schedules: [{ id: 'empty', days: [], startMinutes: 540, endMinutes: 600 }],
    },
    now: at(2026, 7, 8, 8, 0),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.alarms.length, 0);
});

// --- overnight + category schedules ---
test('overnight window: reminder before Monday 22:00, inside skips to next week', () => {
  const before = plan({
    lockState: { schedules: [monOvernight] },
    now: at(2026, 7, 6, 21, 50),
  });
  const event = scheduleAlarm(before);
  assert.ok(event);
  assert.equal(event.eventAt, at(2026, 7, 6, 22, 0));
  assert.equal(event.fireAt, at(2026, 7, 6, 21, 55));

  const inside = plan({
    lockState: { schedules: [monOvernight] },
    now: at(2026, 7, 7, 3, 0),
  });
  const next = scheduleAlarm(inside);
  assert.ok(next);
  assert.equal(next.eventAt, at(2026, 7, 13, 22, 0));
});
test('category schedule names the category in the reminder', () => {
  const now = at(2026, 7, 8, 8, 50);
  const result = plan({ lockState: { categorySchedules: [wedCategory] }, now });
  const event = scheduleAlarm(result);
  assert.ok(event);
  assert.equal(event.eventAt, at(2026, 7, 8, 9, 0));
  assert.deepEqual(event.categories, ['video games']);
  assert.match(event.message, /Focus hours for Video games start at/);
});
test('overlapping global + category start shares one reminder', () => {
  const globalWed = { ...workdays, id: 'global-wed', days: [WED] };
  const result = plan({
    lockState: {
      schedules: [globalWed],
      categorySchedules: [wedCategory],
    },
    now: at(2026, 7, 8, 8, 50),
  });
  const events = result.candidates.filter((event) => event.kind === 'schedule-start');
  assert.equal(events.length, 1);
  assert.equal(events[0].dedupeKey, `schedule-start:${at(2026, 7, 8, 9, 0)}`);
  assert.deepEqual(events[0].categories, ['video games']);
  assert.match(events[0].message, /^Focus hours start at/);
});
test('overlapping windows skip a start that is already inside the stack', () => {
  const wide = {
    id: 'wide',
    days: [1, 2, 3, 4, 5],
    startMinutes: 8 * 60,
    endMinutes: 20 * 60,
  };
  const before = plan({
    lockState: { schedules: [workdays, wide] },
    now: at(2026, 7, 8, 7, 50),
  });
  assert.equal(scheduleAlarm(before).eventAt, at(2026, 7, 8, 8, 0));

  const inside = plan({
    lockState: { schedules: [workdays, wide] },
    now: at(2026, 7, 8, 8, 1),
  });
  assert.equal(scheduleAlarm(inside).eventAt, at(2026, 7, 9, 8, 0));
});

// --- DST ---
// lock-math (and its Rust mirror) defines an unpinned local window as
// "local midnight + startMinutes of ELAPSED time", not as a civil wall
// clock. On a transition day that drifts one civil hour, and the reminder
// must track the ENFORCED window, not a second opinion. These tests pin that
// inheritance and prove the planner uses absolute instants (no naive +24h).
// A pinned-offset rule has a separate, documented residual (lock-math.ts).
test('spring-forward: reminder tracks the enforced window across a 23h civil day', () => {
  const sunday = { id: 'sun', days: [SUN], startMinutes: 9 * 60, endMinutes: 10 * 60 };
  const now = at(2026, 3, 7, 23, 0); // Sat 23:00 EST
  const midnight = new Date(2026, 2, 8).getTime();
  const expected = midnight + 9 * 60 * MIN; // midnight + 9 elapsed hours
  assert.equal(expected, Date.UTC(2026, 2, 8, 14, 0)); // 10:00 EDT
  const result = plan({ lockState: { schedules: [sunday] }, now });
  const event = scheduleAlarm(result);
  assert.equal(event.eventAt, expected);
  assert.equal(event.fireAt, expected - 5 * MIN);
  assert.equal(expected - now, 10 * 60 * MIN);

  // The following Sunday is back on 09:00 civil (13:00 UTC) — the planner
  // did not anchor itself to a fixed +24h offset.
  const nextWeek = plan({
    lockState: { schedules: [sunday] },
    now: at(2026, 3, 9, 12, 0),
  });
  assert.equal(scheduleAlarm(nextWeek).eventAt, Date.UTC(2026, 2, 15, 13, 0));
});
test('fall-back: reminder tracks the enforced window across a 25h civil day', () => {
  const sunday = { id: 'sun', days: [SUN], startMinutes: 9 * 60, endMinutes: 10 * 60 };
  const now = at(2026, 10, 31, 23, 0); // Sat 23:00 EDT
  const midnight = new Date(2026, 10, 1).getTime();
  const expected = midnight + 9 * 60 * MIN; // midnight + 9 elapsed hours
  assert.equal(expected, Date.UTC(2026, 10, 1, 13, 0)); // 08:00 EST
  const result = plan({ lockState: { schedules: [sunday] }, now });
  assert.equal(scheduleAlarm(result).eventAt, expected);
  assert.equal(expected - now, 10 * 60 * MIN);

  const nextWeek = plan({
    lockState: { schedules: [sunday] },
    now: at(2026, 11, 2, 12, 0),
  });
  assert.equal(scheduleAlarm(nextWeek).eventAt, Date.UTC(2026, 10, 8, 14, 0));
});

// --- breaks ---
test('active break fires at end minus lead', () => {
  const start = at(2026, 7, 8, 13, 0);
  const end = start + 10 * MIN;
  const now = start + MIN;
  const result = plan({
    lockState: {
      breakStartedAt: start,
      breakNotBefore: null,
      breakEndsAt: end,
      breakUpdatedAt: start,
    },
    now,
  });
  const event = breakAlarm(result);
  assert.ok(event);
  assert.equal(event.eventAt, end);
  assert.equal(event.fireAt, end - 5 * MIN);
  assert.match(event.message, /break ends at/i);
});
test('a long lead on a short break waits for the break to start', () => {
  const start = at(2026, 7, 8, 13, 0);
  const end = start + 2 * MIN;
  const result = plan({
    lockState: {
      breakStartedAt: start - MIN,
      breakNotBefore: start,
      breakEndsAt: end,
      breakUpdatedAt: start - MIN,
    },
    now: start - MIN,
  });
  const event = breakAlarm(result);
  assert.ok(event);
  assert.equal(event.fireAt, start); // not before the break begins
  assert.equal(event.eventAt, end);
});
test('an ended break has no reminder (no late toast)', () => {
  const start = at(2026, 7, 8, 13, 0);
  const end = start + 10 * MIN;
  const result = plan({
    lockState: {
      breakStartedAt: start,
      breakNotBefore: null,
      breakEndsAt: end,
      breakUpdatedAt: start,
    },
    now: end + 1,
  });
  assert.equal(breakAlarm(result), null);
});
test('an invalid partial break shape is inert', () => {
  const result = plan({
    lockState: {
      breakStartedAt: at(2026, 7, 8, 13, 0),
      breakNotBefore: null,
      breakEndsAt: null,
    },
    now: at(2026, 7, 8, 13, 1),
  });
  assert.equal(breakAlarm(result), null);
});

// --- allowance ---
test('allowance threshold fires when the running grant crosses it', () => {
  const authority = allowanceAuthority();
  const early = plan({
    allowanceState: authority,
    now: ALLOWANCE_T0 + 4 * MIN,
  });
  const event = allowanceAlarm(early);
  assert.ok(event);
  assert.equal(event.eventAt, ALLOWANCE_T0 + 10 * MIN);
  assert.equal(event.fireAt, ALLOWANCE_T0 + 5 * MIN);
  assert.deepEqual(event.categories, ['video games']);
  assert.match(event.message, /Video games allowance ends at/);

  const due = plan({
    allowanceState: authority,
    now: ALLOWANCE_T0 + 6 * MIN,
  });
  assert.equal(allowanceAlarm(due).fireAt <= ALLOWANCE_T0 + 6 * MIN, true);
});
test('an ended allowance has no reminder', () => {
  const result = plan({
    allowanceState: allowanceAuthority(),
    now: ALLOWANCE_T0 + 11 * MIN,
  });
  assert.equal(allowanceAlarm(result), null);
});
test('a pending allowance waits until its grant becomes usable', () => {
  const config = {
    ...ALLOWANCE_CONFIG,
    waitingBaseMs: 5 * MIN,
    waitingMaxMs: 5 * MIN,
  };
  const empty = createEmptyAllowanceLedger({
    nowMs: ALLOWANCE_T0,
    dayKey: ALLOWANCE_DAY,
  });
  const requested = requestAllowance(empty, config, {
    grantId: 'waiting-1',
    nowMs: ALLOWANCE_T0,
    dayKey: ALLOWANCE_DAY,
    durationMs: 10 * MIN,
  });
  assert.equal(requested.ok, true);
  const authority = {
    version: 1,
    revision: 1,
    categories: { 'video games': { config, ledger: requested.ledger } },
    receipts: [],
  };
  const result = plan({
    allowanceState: authority,
    now: ALLOWANCE_T0 + 2 * MIN,
  });
  const event = allowanceAlarm(result);
  assert.ok(event);
  assert.equal(event.fireAt, ALLOWANCE_T0 + 10 * MIN); // not before notBefore+5
  assert.equal(event.eventAt, ALLOWANCE_T0 + 15 * MIN);
});
test('non-allowance relief (openings) stays silent', () => {
  const empty = createEmptyAllowanceLedger({
    nowMs: ALLOWANCE_T0,
    dayKey: ALLOWANCE_DAY,
  });
  const authority = {
    version: 1,
    revision: 1,
    categories: {
      'video games': {
        config: { ...ALLOWANCE_CONFIG, dailyOpenings: 1 },
        ledger: empty,
      },
    },
    receipts: [],
  };
  const result = plan({
    allowanceState: authority,
    now: ALLOWANCE_T0 + MIN,
  });
  assert.equal(allowanceAlarm(result), null);
});

// --- duplicate suppression ---
test('a fired schedule key moves the planner to the following start', () => {
  const now = at(2026, 7, 8, 8, 54);
  const first = plan({ lockState: { schedules: [workdays] }, now });
  const key = scheduleAlarm(first).dedupeKey;
  const second = plan({
    lockState: { schedules: [workdays] },
    firedKeys: [key],
    now,
  });
  const event = scheduleAlarm(second);
  assert.ok(event);
  assert.notEqual(event.dedupeKey, key);
  assert.equal(event.eventAt, at(2026, 7, 9, 9, 0));
});
test('a fired break key suppresses the same break only', () => {
  const start = at(2026, 7, 8, 13, 0);
  const end = start + 10 * MIN;
  const lockState = {
    breakStartedAt: start,
    breakNotBefore: null,
    breakEndsAt: end,
    breakUpdatedAt: start,
  };
  const first = plan({ lockState, now: start + MIN });
  const key = breakAlarm(first).dedupeKey;
  const second = plan({ lockState, firedKeys: [key], now: start + MIN });
  assert.equal(breakAlarm(second), null);

  const nextBreak = plan({
    lockState: {
      ...lockState,
      breakStartedAt: end,
      breakEndsAt: end + 10 * MIN,
      breakUpdatedAt: end,
    },
    firedKeys: [key],
    now: end + MIN,
  });
  assert.ok(breakAlarm(nextBreak));
  assert.notEqual(breakAlarm(nextBreak).dedupeKey, key);
});
test('a fired allowance key suppresses that grant', () => {
  const authority = allowanceAuthority();
  const now = ALLOWANCE_T0 + 6 * MIN;
  const first = plan({ allowanceState: authority, now });
  const key = allowanceAlarm(first).dedupeKey;
  const second = plan({
    allowanceState: authority,
    firedKeys: [key],
    now,
  });
  assert.equal(allowanceAlarm(second), null);
});
test('the durable ledger is bounded and keeps the newest keys', () => {
  let ledger = normalizeNotificationLedger(undefined);
  for (let i = 0; i < MAX_NOTIFICATION_LEDGER_KEYS + 6; i++) {
    ledger = rememberNotification(ledger, `schedule-start:${i}`, 1000 + i);
  }
  assert.equal(Object.keys(ledger.fired).length, MAX_NOTIFICATION_LEDGER_KEYS);
  assert.equal(ledger.fired['schedule-start:0'], undefined);
  assert.equal(
    ledger.fired[`schedule-start:${MAX_NOTIFICATION_LEDGER_KEYS + 5}`],
    1000 + MAX_NOTIFICATION_LEDGER_KEYS + 5,
  );
  assert.deepEqual(
    normalizeNotificationLedger({ version: 99, fired: { x: 1 } }),
    { version: 1, fired: {} },
  );
});

// --- disabled / inactive ---
test('all groups off produce no candidates and no alarms', () => {
  const disabled = {
    version: 1,
    scheduleStartingSoon: { enabled: false, leadMinutes: 5 },
    breakEndingSoon: { enabled: false, leadMinutes: 5 },
    allowanceLow: { enabled: false, thresholdMinutes: 5 },
  };
  const start = at(2026, 7, 8, 9, 0);
  const result = plan({
    prefs: disabled,
    lockState: {
      schedules: [workdays],
      breakStartedAt: start + MIN,
      breakNotBefore: null,
      breakEndsAt: start + 10 * MIN,
      breakUpdatedAt: start + MIN,
    },
    allowanceState: allowanceAuthority(),
    now: start - 4 * MIN,
  });
  assert.deepEqual(result, { candidates: [], alarms: [] });
});
test('one enabled group does not light up the others', () => {
  const onlyBreak = {
    version: 1,
    scheduleStartingSoon: { enabled: false, leadMinutes: 5 },
    breakEndingSoon: { enabled: true, leadMinutes: 5 },
    allowanceLow: { enabled: false, thresholdMinutes: 5 },
  };
  const start = at(2026, 7, 8, 13, 0);
  const result = plan({
    prefs: onlyBreak,
    lockState: {
      schedules: [workdays],
      breakStartedAt: start,
      breakNotBefore: null,
      breakEndsAt: start + 10 * MIN,
      breakUpdatedAt: start,
    },
    allowanceState: allowanceAuthority(),
    now: start + MIN,
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, 'break-end');
});
test('invalid or missing state is inert, never a throw', () => {
  const result = plan({
    prefs: allOn(),
    lockState: {
      schedules: 'not-an-array',
      categorySchedules: [{ id: 'bad' }],
      breakEndsAt: Number.NaN,
    },
    allowanceState: { version: 99 },
    now: at(2026, 7, 8, 12, 0),
  });
  assert.deepEqual(result, { candidates: [], alarms: [] });
});
test('invalid now yields an empty plan', () => {
  for (const now of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = plan({ lockState: { schedules: [workdays] }, now });
    assert.deepEqual(result, { candidates: [], alarms: [] });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
