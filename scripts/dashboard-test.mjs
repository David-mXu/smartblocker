// Deterministic tests for the pure Now / Next / Relief dashboard selector.
// Runs directly under Node >=22.6 type stripping; no browser or test runner.
//
//   node scripts/dashboard-test.mjs
//
// The DST cases run in a child process with TZ=America/New_York so the suite
// is meaningful (and still deterministic) on machines in any timezone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_LOCK_STATE,
} from '../src/shared/lock-math.ts';
import {
  buildDashboard,
  buildDayTimeline,
  formatDashboardRemaining,
} from '../src/shared/dashboard.ts';

const DST_CHILD = process.argv.includes('--dst-child');
const HOUR = 3_600_000;
const MINUTE = 60_000;

const localOffset = (ms) => -new Date(ms).getTimezoneOffset();
const localMs = (year, month, day, hour, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const NOW = localMs(2026, 11, 9, 15, 40);
const OFFSET = localOffset(NOW);

const settings = (overrides = {}) => ({
  enabled: true,
  focusGoal: '',
  resumeMode: 'off',
  resumeAt: null,
  breakMode: 'off',
  breakDelayMinutes: 1,
  breakDurationMinutes: 10,
  breakTextLength: 100,
  ...overrides,
});

const rule = (overrides = {}) => ({
  id: 'rule-1',
  days: [0, 1, 2, 3, 4, 5, 6],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
  tzOffsetMinutes: OFFSET,
  tzName: 'Local',
  ...overrides,
});

const categoryRule = (overrides = {}) => ({
  ...rule({ id: 'category-1', startMinutes: 13 * 60, endMinutes: 15 * 60 }),
  categories: ['video games', 'online shopping'],
  ...overrides,
});

const lockState = (overrides = {}) => ({
  ...EMPTY_LOCK_STATE,
  schedules: [],
  categorySchedules: [],
  ...overrides,
});

const emptyAllowance = { state: null, source: null };

const model = (overrides = {}) =>
  buildDashboard({
    now: overrides.now ?? NOW,
    settings: settings(overrides.settings),
    lockState: lockState(overrides.lockState),
    pendingFocus: overrides.pendingFocus ?? null,
    companion: overrides.companion ?? null,
    allowance: overrides.allowance ?? emptyAllowance,
    locale: 'en-US',
    ...(overrides.timeline ? { timeline: overrides.timeline } : {}),
  });

const companionStatus = (overrides = {}) => ({
  companionVersion: '0.1.0',
  pro: true,
  enforcement: { appBlocking: true, watchdog: true, policyProtected: false },
  lockState: EMPTY_LOCK_STATE,
  ...overrides,
});

const companion = (state, overrides = {}) => ({
  state,
  status: null,
  extensionLoss: null,
  lastConnectedAt: null,
  ...overrides,
});

const allowanceState = (grant, configOverrides = {}) => ({
  version: 1,
  revision: 1,
  categories: {
    'video games': {
      config: {
        dailyAllowanceMs: 10 * MINUTE,
        dailyOpenings: 2,
        waitingBaseMs: 0,
        waitingStepMs: 0,
        waitingMaxMs: 0,
        rewardCapMs: 0,
        openingInactivityMs: 120_000,
        openingMaxLifetimeMs: 30 * MINUTE,
        ...configOverrides,
      },
      ledger: {
        version: 1,
        dayKey: `${new Date(NOW).getFullYear()}-${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}-${String(new Date(NOW).getDate()).padStart(2, '0')}`,
        spentMs: 0,
        earnedRewardMs: 0,
        openingsUsed: 0,
        waitingEscalation: 0,
        lastObservedAtMs: NOW,
        grant,
      },
    },
  },
  receipts: [],
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${error.stack ?? error.message}`);
  }
}

async function runDstChild() {
  console.log('dashboard DST subprocess (America/New_York)');
  await test('spring-forward day is 23 hours and the marker uses real day width', () => {
    const noon = localMs(2026, 3, 8, 12);
    const timeline = buildDayTimeline(
      { schedules: [{ id: 'dst-spring', days: [0, 1, 2, 3, 4, 5, 6], startMinutes: 60, endMinutes: 240 }], categorySchedules: [] },
      noon,
      'en-US',
    );
    assert.equal(timeline.dayEnd - timeline.dayStart, 23 * HOUR);
    assert.equal(timeline.lanes[0].segments.length, 1);
    const segment = timeline.lanes[0].segments[0];
    assert.ok(segment.start >= timeline.dayStart && segment.end <= timeline.dayEnd);
    assert.ok(segment.widthPct > 0 && segment.widthPct < 100);
    assert.match(timeline.lanes[0].text[0], /\d{1,2}:\d{2}\s?(AM|PM)/);
    assert.ok(timeline.nowPct > 0 && timeline.nowPct < 100);
  });

  await test('fall-back day is 25 hours and the marker uses real day width', () => {
    const noon = localMs(2026, 11, 1, 12);
    const timeline = buildDayTimeline(
      { schedules: [{ id: 'dst-fall', days: [0, 1, 2, 3, 4, 5, 6], startMinutes: 60, endMinutes: 240 }], categorySchedules: [] },
      noon,
      'en-US',
    );
    assert.equal(timeline.dayEnd - timeline.dayStart, 25 * HOUR);
    assert.equal(timeline.lanes[0].segments.length, 1);
    const segment = timeline.lanes[0].segments[0];
    assert.ok(segment.start >= timeline.dayStart && segment.end <= timeline.dayEnd);
    assert.ok(segment.widthPct > 0 && segment.widthPct < 100);
    assert.match(timeline.lanes[0].text[0], /\d{1,2}:\d{2}\s?(AM|PM)/);
    assert.ok(timeline.nowPct > 0 && timeline.nowPct < 100);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

if (DST_CHILD) {
  await runDstChild();
} else {
  console.log('dashboard tests');

  await test('empty state: no locks, no schedules, no invented data', () => {
    const result = model();
    assert.equal(result.lock.active, false);
    assert.deepEqual(result.lock.reasons, []);
    assert.equal(result.lock.summary, 'No lock is active.');
    assert.equal(result.globalWindow.configured, false);
    assert.equal(result.globalWindow.active, false);
    assert.equal(result.categoryWindow.configured, false);
    assert.equal(result.next.global.at, null);
    assert.equal(result.next.global.text, 'No focus hours configured.');
    assert.equal(result.next.category.at, null);
    assert.equal(result.next.category.text, 'No category schedule configured.');
    assert.equal(result.next.autoResume.mode, 'off');
    assert.equal(result.relief.grants.length, 0);
    assert.equal(result.relief.allowanceTitle, 'Allowance state unavailable');
    assert.equal(result.timeline.lanes[0].segments.length, 0);
    assert.equal(result.timeline.lanes[1].segments.length, 0);
    assert.deepEqual(result.timeline.lanes[0].text, ['No focus hours today.']);
    assert.deepEqual(result.timeline.lanes[1].text, ['No category schedules today.']);
    assert.equal(result.profile, null);
  });

  await test('blocking on, paused, and forced by a lock are distinguished', () => {
    assert.equal(model().blocking.title, 'Blocking on');
    assert.equal(model({ settings: { enabled: false } }).blocking.title, 'Blocking paused');
    const forced = model({
      settings: { enabled: false },
      lockState: { frozenUntil: NOW + HOUR },
    });
    assert.equal(forced.blocking.title, 'Blocking forced by a lock');
    assert.equal(forced.blocking.forced, true);
    assert.equal(forced.blocking.tone, 'commit');
  });

  await test('overlapping timer, focus session and schedule report every reason with truthful ends', () => {
    const scheduleEnd = localMs(2026, 11, 9, 17, 0);
    const result = model({
      lockState: {
        timerUntil: NOW + 10 * MINUTE,
        frozenUntil: NOW + 2 * HOUR,
        schedules: [rule({ startMinutes: 14 * 60, endMinutes: 17 * 60 })],
      },
    });
    assert.equal(result.lock.active, true);
    assert.deepEqual(
      result.lock.reasons.map((reason) => reason.reason),
      ['timer', 'frozen', 'schedule'],
    );
    assert.equal(result.lock.reasons[0].countdown.remainingMs, 10 * MINUTE);
    assert.equal(result.lock.reasons[1].countdown.remainingMs, 2 * HOUR);
    assert.equal(result.lock.reasons[2].endsAt, scheduleEnd);
    assert.equal(result.lock.until.remainingMs, 2 * HOUR);
    assert.match(result.lock.summary, /^All locks end at /);
    assert.equal(result.globalWindow.active, true);
    assert.equal(result.globalWindow.endsAt, scheduleEnd);
    assert.equal(result.blocking.forced, true);
  });

  await test('countdown boundaries: exact end removes the source; sub-minute stays positive', () => {
    const end = NOW + MINUTE;
    const justBefore = model({ now: end - 1, lockState: { timerUntil: end } });
    assert.equal(justBefore.lock.reasons.length, 1);
    assert.equal(justBefore.lock.reasons[0].countdown.remainingMs, 1);
    assert.equal(justBefore.lock.reasons[0].countdown.text, '<1m left (until ' + justBefore.lock.reasons[0].countdown.clock + ')');

    const exactly = model({ now: end, lockState: { timerUntil: end } });
    assert.equal(exactly.lock.reasons.length, 0);
    assert.equal(exactly.lock.active, false);

    const after = model({ now: end + 1, lockState: { timerUntil: end } });
    assert.equal(after.lock.reasons.length, 0);

    assert.equal(formatDashboardRemaining(0), 'now');
    assert.equal(formatDashboardRemaining(-1), 'now');
    assert.equal(formatDashboardRemaining(59_999), '<1m');
    assert.equal(formatDashboardRemaining(60_000), '1m');
    assert.equal(formatDashboardRemaining(90 * MINUTE), '1h 30m');
  });

  await test('an indefinite password gate wins over a timed source', () => {
    const result = model({
      lockState: {
        timerUntil: NOW + HOUR,
        passwordHash: 'a'.repeat(64),
      },
    });
    assert.equal(result.lock.active, true);
    assert.equal(result.lock.indefinite, true);
    assert.equal(result.lock.until, null);
    assert.match(result.lock.summary, /^No automatic unlock/);
    assert.match(result.lock.summary, /timed sources end by/);
    assert.match(result.lock.summary, /password lock/);
    const password = result.lock.reasons.find((reason) => reason.reason === 'password');
    assert.equal(password.countdown, null);
  });

  await test('overnight focus hours: active after midnight, next transition ends, then starts', () => {
    const overnightNow = localMs(2026, 11, 10, 3, 0);
    const end = localMs(2026, 11, 10, 6, 0);
    const nextStart = localMs(2026, 11, 16, 22, 0);
    const overnight = rule({
      id: 'overnight',
      days: [1],
      startMinutes: 22 * 60,
      endMinutes: 6 * 60,
      tzOffsetMinutes: localOffset(overnightNow),
    });

    const active = buildDashboard({
      now: overnightNow,
      settings: settings(),
      lockState: lockState({ schedules: [overnight] }),
      pendingFocus: null,
      companion: null,
      allowance: emptyAllowance,
      locale: 'en-US',
    });
    assert.equal(active.globalWindow.active, true);
    assert.equal(active.globalWindow.endsAt, end);
    assert.equal(active.next.global.direction, 'ends');
    assert.equal(active.next.global.at, end);
    assert.match(active.next.global.text, /ends at/);
    assert.equal(active.timeline.lanes[0].segments[0].start, localMs(2026, 11, 10, 0));
    assert.equal(active.timeline.lanes[0].segments[0].startsBeforeToday, true);
    assert.match(active.timeline.lanes[0].text[0], /from yesterday/);

    const ended = buildDashboard({
      now: end,
      settings: settings(),
      lockState: lockState({ schedules: [overnight] }),
      pendingFocus: null,
      companion: null,
      allowance: emptyAllowance,
      locale: 'en-US',
    });
    assert.equal(ended.globalWindow.active, false);
    assert.equal(ended.next.global.direction, 'starts');
    assert.equal(ended.next.global.at, nextStart);
  });

  await test('overlapping windows: the earliest end wins, then the outer window remains', () => {
    const outer = rule({ id: 'outer', startMinutes: 9 * 60, endMinutes: 17 * 60 });
    const inner = rule({ id: 'inner', startMinutes: 13 * 60, endMinutes: 15 * 60 });
    const active = model({
      lockState: { schedules: [outer, inner] },
      now: localMs(2026, 11, 9, 14, 0),
    });
    assert.equal(active.next.global.at, localMs(2026, 11, 9, 15, 0));
    assert.equal(active.next.global.direction, 'ends');
    assert.equal(active.next.global.ruleId, 'inner');
    assert.equal(active.timeline.lanes[0].segments.length, 1);
    assert.equal(active.timeline.lanes[0].segments[0].start, localMs(2026, 11, 9, 9, 0));
    assert.equal(active.timeline.lanes[0].segments[0].end, localMs(2026, 11, 9, 17, 0));

    const afterInner = model({
      lockState: { schedules: [outer, inner] },
      now: localMs(2026, 11, 9, 15, 0),
    });
    assert.equal(afterInner.next.global.at, localMs(2026, 11, 9, 17, 0));
    assert.equal(afterInner.next.global.ruleId, 'outer');
  });

  await test('category windows block classifies without locking settings, and show categories', () => {
    const active = model({
      now: localMs(2026, 11, 9, 14, 0),
      lockState: { categorySchedules: [categoryRule()] },
    });
    assert.equal(active.lock.active, false);
    assert.equal(active.categoryWindow.active, true);
    assert.deepEqual(active.categoryWindow.categories, ['online shopping', 'video games']);
    assert.equal(active.next.category.direction, 'ends');
    assert.equal(active.next.category.at, localMs(2026, 11, 9, 15, 0));
    assert.deepEqual(active.next.category.categories, ['video games', 'online shopping']);
    assert.equal(active.timeline.lanes[1].segments.length, 1);
    assert.match(active.timeline.lanes[1].text[0], /video games, online shopping/);

    const inactive = model({
      now: localMs(2026, 11, 9, 16, 0),
      lockState: { categorySchedules: [categoryRule()] },
    });
    assert.equal(inactive.categoryWindow.active, false);
    assert.match(inactive.categoryWindow.detail, /rescues classifier blocks/);
    assert.equal(inactive.next.category.direction, 'starts');
    assert.equal(inactive.next.category.at, localMs(2026, 11, 10, 13, 0));
  });

  await test('pending focus shows the undo window, then the lock commit, then the end', () => {
    const pending = { until: NOW + 2 * HOUR, commitAt: NOW + 30_000, durationMs: 2 * HOUR };
    const before = model({ pendingFocus: pending });
    assert.equal(before.focus.kind, 'pending');
    assert.match(before.focus.title, /pending/);
    assert.match(before.focus.detail, /undo until/);
    assert.equal(before.focus.countdown.remainingMs, 30_000);
    assert.equal(before.next.pendingFocus, before.focus);

    const exact = model({ now: pending.commitAt, pendingFocus: pending });
    assert.equal(exact.focus.kind, 'pending');
    assert.match(exact.focus.title, /locking/);
    assert.match(exact.focus.detail, /undo window closed/);

    const after = model({ now: pending.until + 1, pendingFocus: pending });
    assert.match(after.focus.title, /finishing/);
  });

  await test('active focus session and focus goal are both represented truthfully', () => {
    const active = model({
      settings: { focusGoal: 'Finish the dashboard' },
      lockState: { frozenUntil: NOW + HOUR },
    });
    assert.equal(active.focus.kind, 'active');
    assert.match(active.focus.detail, /Finish the dashboard/);
    assert.equal(active.focus.countdown.remainingMs, HOUR);

    const goal = model({ settings: { focusGoal: 'Finish the dashboard' } });
    assert.equal(goal.focus.kind, 'goal');
    assert.match(goal.focus.title, /Finish the dashboard/);

    assert.equal(model().focus.kind, 'none');
  });

  await test('auto-resume reports time, schedule, startup, and inert states', () => {
    const time = model({
      settings: { enabled: false, resumeMode: 'time', resumeAt: NOW + 10 * MINUTE },
    });
    assert.equal(time.next.autoResume.at, NOW + 10 * MINUTE);
    assert.match(time.next.autoResume.detail, /^At /);

    const clamped = model({
      settings: { enabled: false, resumeMode: 'time', resumeAt: NOW + 48 * HOUR },
    });
    assert.equal(clamped.next.autoResume.at, NOW + 24 * HOUR);

    const schedule = model({
      settings: { enabled: false, resumeMode: 'schedule' },
      lockState: { schedules: [rule({ startMinutes: 18 * 60, endMinutes: 20 * 60 })] },
    });
    assert.equal(schedule.next.autoResume.at, localMs(2026, 11, 9, 18, 0));
    assert.match(schedule.next.autoResume.detail, /next focus-hour start/);

    const startup = model({ settings: { enabled: false, resumeMode: 'startup' } });
    assert.equal(startup.next.autoResume.at, null);
    assert.match(startup.next.autoResume.title, /browser start/);

    const noSchedule = model({ settings: { enabled: false, resumeMode: 'schedule' } });
    assert.equal(noSchedule.next.autoResume.at, null);
    assert.match(noSchedule.next.autoResume.title, /no scheduled start/);

    const noTime = model({ settings: { enabled: false, resumeMode: 'time', resumeAt: null } });
    assert.equal(noTime.next.autoResume.at, null);
    assert.match(noTime.next.autoResume.title, /No auto-resume time/);

    const alreadyOn = model({ settings: { resumeMode: 'time', resumeAt: NOW + HOUR } });
    assert.equal(alreadyOn.next.autoResume.at, NOW + HOUR);
    assert.match(alreadyOn.next.autoResume.title, /already on/);
    assert.match(alreadyOn.next.autoResume.detail, /only fires while blocking is off/);
  });

  await test('relief reports active, pending, ended, and opening grants without inventing authority', () => {
    const activeGrant = {
      id: 'grant-active',
      kind: 'allowance',
      status: 'active',
      requestedAtMs: NOW - MINUTE,
      notBeforeMs: NOW - MINUTE,
      endsAtMs: NOW + 4 * MINUTE,
      durationMs: 5 * MINUTE,
      endedAtMs: null,
      endReason: null,
      chargedMs: 0,
      refundedMs: 0,
      lastActivityAtMs: null,
    };
    const active = model({
      allowance: { state: allowanceState(activeGrant), source: 'fallback' },
    });
    assert.equal(active.relief.grants.length, 1);
    assert.match(active.relief.grants[0].title, /video games/);
    assert.equal(active.relief.grants[0].remainingMs, 4 * MINUTE);
    assert.match(active.relief.statement, /classifier verdicts/);
    assert.match(active.relief.statement, /Deterministic rules/);
    assert.match(active.relief.statement, /desktop enforcement/);

    const pendingGrant = { ...activeGrant, status: 'pending', notBeforeMs: NOW + 2 * MINUTE, endsAtMs: NOW + 7 * MINUTE, durationMs: 5 * MINUTE };
    const pending = model({ allowance: { state: allowanceState(pendingGrant), source: 'daemon' } });
    assert.equal(pending.relief.grants.length, 1);
    assert.match(pending.relief.grants[0].detail, /^Starts at /);

    const endedGrant = { ...activeGrant, status: 'ended', endsAtMs: NOW - 1, endedAtMs: NOW - 1, endReason: 'expired' };
    const ended = model({ allowance: { state: allowanceState(endedGrant), source: 'fallback' } });
    assert.equal(ended.relief.grants.length, 0);
    assert.match(ended.relief.allowanceTitle, /No allowance or opening/);

    const openingGrant = {
      ...activeGrant,
      id: 'grant-opening',
      kind: 'opening',
      status: 'active',
      notBeforeMs: NOW - MINUTE,
      endsAtMs: NOW + 20 * MINUTE,
      durationMs: 21 * MINUTE,
      lastActivityAtMs: NOW - 30_000,
    };
    const opening = model({ allowance: { state: allowanceState(openingGrant), source: 'fallback' } });
    assert.equal(opening.relief.grants.length, 1);
    assert.match(opening.relief.grants[0].detail, /closes after 120s without activity/);

    const noState = model();
    assert.equal(noState.relief.allowanceTitle, 'Allowance state unavailable');
    const pendingAuthority = model({ allowance: { state: allowanceState(activeGrant), source: 'pending' } });
    assert.equal(pendingAuthority.relief.allowanceTitle, 'Allowance authority is initializing');
  });

  await test('break mode and active break copy stay explicit about classifier-only relief', () => {
    const delay = model({ settings: { breakMode: 'delay', breakDelayMinutes: 5, breakDurationMinutes: 15 } });
    assert.match(delay.relief.breakMode.detail, /5-minute wait/);
    assert.match(delay.relief.breakMode.detail, /15 minutes/);

    const activeBreak = model({
      lockState: {
        breakStartedAt: NOW - MINUTE,
        breakEndsAt: NOW + 5 * MINUTE,
        breakUpdatedAt: NOW - MINUTE,
      },
    });
    assert.equal(activeBreak.break.active, true);
    assert.match(activeBreak.break.detail, /Classifier verdicts are relaxed/);
    assert.match(activeBreak.break.detail, /Deterministic rules and locks still apply/);

    const pendingBreak = model({
      lockState: {
        breakStartedAt: NOW - MINUTE,
        breakNotBefore: NOW + 2 * MINUTE,
        breakEndsAt: NOW + 7 * MINUTE,
        breakUpdatedAt: NOW - MINUTE,
      },
    });
    assert.equal(pendingBreak.break.pending, true);
    assert.equal(pendingBreak.next.pendingBreak, pendingBreak.break);
  });

  await test('companion health reflects every snapshot state and authoritative grace only', () => {
    assert.match(model().companion.title, /Checking/);
    assert.match(model({ companion: companion('not-installed') }).companion.title, /not installed/);
    assert.match(model({ companion: companion('connecting') }).companion.title, /Connecting/);
    assert.match(model({ companion: companion('disconnected') }).companion.title, /disconnected/);

    const connected = model({
      companion: companion('connected', { status: companionStatus() }),
    });
    assert.equal(connected.companion.healthy, true);
    assert.equal(connected.companion.tone, 'success');
    assert.match(connected.companion.detail, /app blocking on/);

    const grace = model({
      companion: companion('connected', {
        status: companionStatus(),
        extensionLoss: {
          state: 'grace',
          observedAtMs: NOW - 1_000,
          lastHeartbeatAtMs: null,
          graceRemainingMs: 20_000,
          graceSeconds: 30,
        },
      }),
    });
    assert.equal(grace.companion.healthy, false);
    assert.equal(grace.companion.tone, 'warning');
    assert.match(grace.companion.title, /extension grace/);
    assert.match(grace.companion.detail, /browser may close in 19s/);
  });

  await test('timeline gives local-time text equivalents and marks the current time', () => {
    const timeline = buildDayTimeline(
      {
        schedules: [rule({ startMinutes: 9 * 60, endMinutes: 17 * 60 })],
        categorySchedules: [categoryRule({ startMinutes: 22 * 60, endMinutes: 2 * 60 })],
      },
      NOW,
      'en-US',
    );
    assert.equal(timeline.ticks.length, 5);
    assert.ok(timeline.nowPct > 0 && timeline.nowPct < 100);
    // The category window starts at 10 PM, so its lane also carries the
    // after-midnight tail of yesterday's window.
    assert.equal(timeline.lanes[0].segments.length, 1);
    assert.equal(timeline.lanes[1].segments.length, 2);
    assert.match(timeline.lanes[0].text[0], /\d{1,2}:\d{2}\s?(AM|PM)/);
    assert.match(timeline.lanes[0].text[0], /–/);
    assert.match(timeline.lanes[1].text[0], /video games, online shopping/);
    assert.match(timeline.lanes[1].text[0], /from yesterday/);
    assert.match(timeline.lanes[1].text[1], /continues tomorrow/);
  });

  await test('the dashboard never adds URL, host, or page-title fields', () => {
    const input = {
      now: NOW,
      settings: settings({ focusGoal: 'Read one chapter' }),
      lockState: lockState({ schedules: [rule()] }),
      pendingFocus: null,
      companion: null,
      allowance: emptyAllowance,
      locale: 'en-US',
      url: 'https://example.com/private?q=1',
      title: 'Secret page title',
      host: 'example.com',
    };
    const result = buildDashboard(input);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('Secret page title'), false);
    assert.equal(serialized.includes('example.com'), false);
  });

  await test('DST display is day-length safe (child process, America/New_York)', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dst-child'], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    if (child.status !== 0) {
      throw new Error(`DST child failed:\n${child.stdout}\n${child.stderr}`);
    }
    assert.match(child.stdout, /2 passed, 0 failed/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
