// Focused break proof + storage-transition tests. Runs directly under Node
// >=22.15 type stripping, with no browser or npm test runner required.
//
//   node scripts/breaks-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  BREAK_DELAY_MINUTES_DEFAULT,
  BREAK_DELAY_MINUTES_MAX,
  BREAK_DURATION_MINUTES_DEFAULT,
  BREAK_DURATION_MINUTES_MAX,
  BREAK_TEXT_LENGTH_DEFAULT,
  BREAK_TEXT_LENGTH_MAX,
  clampBreakDelayMinutes,
  clampBreakDurationMinutes,
  clampBreakTextLength,
  generateBreakText,
  normalizeBreakMode,
  normalizeBreakText,
  verifyBreakText,
} from '../src/shared/breaks.ts';

// Source files use bundler-style extensionless relative imports. Resolve those
// to .ts for this direct-Node suite without changing production import style.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !specifier.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.stack ?? e.message}`);
  }
}

// Minimal storage.local + onChanged implementation. Writes are recorded at the
// same boundary used by the extension, so a typo can be asserted to write
// exactly nothing rather than merely leaving equivalent state behind.
const stored = new Map();
const writes = [];
const changeListeners = [];
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function emitChanges(changes) {
  for (const listener of [...changeListeners]) listener(clone(changes), 'local');
}

globalThis.chrome = {
  storage: {
    local: {
      async get(query) {
        const keys =
          typeof query === 'string'
            ? [query]
            : Array.isArray(query)
              ? query
              : query === null || query === undefined
                ? [...stored.keys()]
                : Object.keys(query);
        return Object.fromEntries(keys.filter((key) => stored.has(key)).map((key) => [key, clone(stored.get(key))]));
      },
      async set(items) {
        writes.push(clone(items));
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: clone(stored.get(key)), newValue: clone(value) };
          stored.set(key, clone(value));
        }
        emitChanges(changes);
      },
      async remove(query) {
        const keys = typeof query === 'string' ? [query] : query;
        const changes = {};
        for (const key of keys) {
          changes[key] = { oldValue: clone(stored.get(key)), newValue: undefined };
          stored.delete(key);
        }
        emitChanges(changes);
      },
    },
    onChanged: {
      addListener(listener) {
        changeListeners.push(listener);
      },
    },
  },
};

const { cancelBreak, getLockState, getLockStatus, startBreak } = await import('../src/shared/lock.ts');
const {
  cancelConfiguredBreak,
  requestBreakChallenge,
  startConfiguredBreak,
} = await import('../src/background/breaks.ts');
const { DEFAULTS, getSettings, setSettings } = await import('../src/shared/settings.ts');

const NOW = 1_800_000_000_000;
let now = NOW;
const realDateNow = Date.now;
Date.now = () => now;

const schedule = {
  id: 'focus-hours',
  days: [1, 2, 3, 4, 5],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
  tzOffsetMinutes: 0,
  tzName: 'UTC',
};

function lockedState() {
  return {
    breakStartedAt: null,
    breakNotBefore: null,
    breakEndsAt: null,
    breakUpdatedAt: 0,
    timerUntil: NOW + 4 * 3_600_000,
    passwordHash: 'a'.repeat(64),
    passwordTs: NOW - 2_000,
    frozenUntil: NOW + 5 * 3_600_000,
    schedules: [clone(schedule)],
    schedulesUpdatedAt: NOW - 3_000,
  };
}

function seed({ lockState = lockedState(), settings = {} } = {}) {
  stored.clear();
  stored.set('lockState', clone(lockState));
  stored.set('settings', {
    ...clone(DEFAULTS),
    breakMode: 'delay',
    breakDelayMinutes: 2,
    breakDurationMinutes: 15,
    breakTextLength: 10,
    ...clone(settings),
  });
  writes.length = 0;
  emitChanges({
    lockState: { oldValue: undefined, newValue: clone(stored.get('lockState')) },
    settings: { oldValue: undefined, newValue: clone(stored.get('settings')) },
  });
}

const BREAK_KEYS = ['breakStartedAt', 'breakNotBefore', 'breakEndsAt', 'breakUpdatedAt'];
function nonBreakFields(state) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !BREAK_KEYS.includes(key)));
}

function assertOnlyBreakWrite(before) {
  assert.equal(writes.length, 1, 'expected exactly one storage write');
  assert.deepEqual(Object.keys(writes[0]), ['lockState']);
  const next = writes[0].lockState;
  assert.deepEqual(nonBreakFields(next), nonBreakFields(before), 'non-break lock fields changed');
  return next;
}

console.log('break proof + transition tests');

await test('setting defaults and clamps stay within the v1 contract', () => {
  assert.equal(clampBreakDelayMinutes(undefined), BREAK_DELAY_MINUTES_DEFAULT);
  assert.equal(clampBreakDelayMinutes(-1), 0);
  assert.equal(clampBreakDelayMinutes(99), BREAK_DELAY_MINUTES_MAX);
  assert.equal(clampBreakDelayMinutes(1.6), 2);
  assert.equal(clampBreakDurationMinutes(undefined), BREAK_DURATION_MINUTES_DEFAULT);
  assert.equal(clampBreakDurationMinutes(0), 1);
  assert.equal(clampBreakDurationMinutes(9999), BREAK_DURATION_MINUTES_MAX);
  assert.equal(clampBreakTextLength(undefined), BREAK_TEXT_LENGTH_DEFAULT);
  assert.equal(clampBreakTextLength(1), 10);
  assert.equal(clampBreakTextLength(9999), BREAK_TEXT_LENGTH_MAX);
  assert.equal(normalizeBreakMode('delay'), 'delay');
  assert.equal(normalizeBreakMode('random-text'), 'random-text');
  assert.equal(normalizeBreakMode('unexpected'), 'off');
});

await test('random proof uses the unambiguous 32-symbol alphabet in groups of five', () => {
  const text = generateBreakText(23);
  assert.equal(normalizeBreakText(text).length, 23);
  assert.match(text, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?: [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){3} [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{3}$/);
  assert.doesNotMatch(text, /[01IO]/);
});

await test('proof comparison allows spacing/case differences but no symbol typo', () => {
  const expected = 'ABCDE FGHIJ K2345';
  assert.equal(verifyBreakText(expected, 'abcde fghij k2345'), true);
  assert.equal(verifyBreakText(expected, 'ABCDEFGHIJK2345'), true);
  assert.equal(verifyBreakText(expected, 'ABCDE FGHIJ K2346'), false);
  assert.equal(verifyBreakText(expected, 'ABCDE FGHIJ K234'), false);
  assert.equal(verifyBreakText(expected, 'ABCDE FGHIJ K2345!'), false);
});

await test('delay start writes one pending operation and preserves every non-break field', async () => {
  now = NOW;
  const before = lockedState();
  seed({ lockState: before });
  const status = await startConfiguredBreak('delay');
  const next = assertOnlyBreakWrite(before);
  assert.deepEqual(
    Object.fromEntries(BREAK_KEYS.map((key) => [key, next[key]])),
    {
      breakStartedAt: NOW,
      breakNotBefore: NOW + 120_000,
      breakEndsAt: NOW + 120_000 + 900_000,
      breakUpdatedAt: NOW,
    },
  );
  assert.equal(status.breakActive, false);
  assert.equal(status.settingsLocked, true);
  assert.equal(status.forceBlocking, true);
  assert.deepEqual(status.reasons, ['timer', 'password', 'frozen']);
});

await test('delayed activation and strict end are wall-time reads with zero writes', async () => {
  now = NOW;
  seed();
  await startConfiguredBreak('delay');
  writes.length = 0;
  now = NOW + 119_999;
  assert.equal((await getLockStatus(now)).breakActive, false);
  now = NOW + 120_000;
  assert.equal((await getLockStatus(now)).breakActive, true);
  now = NOW + 120_000 + 899_999;
  assert.equal((await getLockStatus(now)).breakActive, true);
  now = NOW + 120_000 + 900_000;
  const ended = await getLockStatus(now);
  assert.equal(ended.breakActive, false);
  assert.equal(ended.settingsLocked, true);
  assert.equal(ended.forceBlocking, true);
  assert.equal(writes.length, 0);
});

await test('early cancellation is a tombstone and preserves every non-break field', async () => {
  now = NOW;
  seed();
  await startConfiguredBreak('delay');
  const before = await getLockState();
  writes.length = 0;
  now += 1_000;
  const status = await cancelConfiguredBreak();
  const next = assertOnlyBreakWrite(before);
  assert.equal(next.breakStartedAt, null);
  assert.equal(next.breakNotBefore, null);
  assert.equal(next.breakEndsAt, null);
  assert.equal(next.breakUpdatedAt, NOW + 1_000);
  assert.equal(status.breakActive, false);
  assert.equal(status.settingsLocked, true);
  assert.equal(status.forceBlocking, true);
  assert.deepEqual(status.reasons, ['timer', 'password', 'frozen']);
});

await test('random challenge creation and a typo perform zero writes', async () => {
  now = NOW;
  seed({ settings: { breakMode: 'random-text' } });
  const challenge = await requestBreakChallenge();
  assert.equal(normalizeBreakText(challenge).length, 10);
  assert.equal(writes.length, 0);
  await assert.rejects(startConfiguredBreak('random-text', `${challenge}X`), /does not match/);
  assert.equal(writes.length, 0, 'typo wrote storage');
  assert.deepEqual(await getLockState(), lockedState());
});

await test('correct service-worker proof writes only the immediate break fields', async () => {
  now = NOW;
  const before = lockedState();
  seed({ lockState: before, settings: { breakMode: 'random-text' } });
  const challenge = await requestBreakChallenge();
  const status = await startConfiguredBreak('random-text', challenge.toLowerCase());
  const next = assertOnlyBreakWrite(before);
  assert.equal(next.breakStartedAt, NOW);
  assert.equal(next.breakNotBefore, null);
  assert.equal(next.breakEndsAt, NOW + 900_000);
  assert.equal(next.breakUpdatedAt, NOW);
  assert.equal(status.breakActive, true);
  assert.equal(status.forceBlocking, true);
});

await test('only the newest challenge is accepted; stale proof cannot write', async () => {
  now = NOW;
  seed({ settings: { breakMode: 'random-text' } });
  const stale = await requestBreakChallenge();
  const latest = await requestBreakChallenge();
  assert.notEqual(stale, latest);
  await assert.rejects(startConfiguredBreak('random-text', stale), /does not match/);
  assert.equal(writes.length, 0);
  await startConfiguredBreak('random-text', latest);
  assert.equal(writes.length, 1);
});

await test('a challenge expires after 15 minutes and cannot be replayed after success', async () => {
  now = NOW;
  seed({ settings: { breakMode: 'random-text' } });
  const expired = await requestBreakChallenge();
  now += 15 * 60_000 + 1;
  await assert.rejects(startConfiguredBreak('random-text', expired), /does not match/);
  assert.equal(writes.length, 0);

  now = NOW;
  seed({ settings: { breakMode: 'random-text' } });
  const used = await requestBreakChallenge();
  await startConfiguredBreak('random-text', used);
  writes.length = 0;
  await cancelBreak();
  writes.length = 0;
  await assert.rejects(startConfiguredBreak('random-text', used), /already pending or active|does not match/);
  assert.equal(writes.length, 0);
});

await test('missing proof, disabled/mismatched modes, and unlocked starts never write', async () => {
  now = NOW;
  seed({ settings: { breakMode: 'random-text' } });
  await assert.rejects(startConfiguredBreak('random-text', 'ABCDEFGHIJ'), /does not match/);
  assert.equal(writes.length, 0);
  await assert.rejects(startConfiguredBreak('delay'), /not enabled/);
  await assert.rejects(startConfiguredBreak('off'), /not enabled/);
  seed({ settings: { breakMode: 'delay' } });
  await assert.rejects(requestBreakChallenge(), /not enabled/);
  assert.equal(writes.length, 0);

  seed({
    lockState: {
      breakStartedAt: null,
      breakNotBefore: null,
      breakEndsAt: null,
      breakUpdatedAt: 0,
      timerUntil: null,
      passwordHash: null,
      frozenUntil: null,
      schedules: [],
    },
    settings: { breakMode: 'random-text' },
  });
  await assert.rejects(requestBreakChallenge(), /active lock/);
  await assert.rejects(startBreak(0, 60_000), /active lock/);
  assert.equal(writes.length, 0);
});

await test('a second pending/active break is refused without a write', async () => {
  now = NOW;
  seed();
  await startConfiguredBreak('delay');
  writes.length = 0;
  await assert.rejects(startConfiguredBreak('delay'), /already pending or active/);
  now += 120_000;
  await assert.rejects(startBreak(0, 60_000), /already pending or active/);
  assert.equal(writes.length, 0);
});

await test('stored break settings normalize on read without a storage write', async () => {
  now = NOW;
  seed({
    settings: {
      breakMode: 'invalid',
      breakDelayMinutes: 500,
      breakDurationMinutes: -4,
      breakTextLength: Number.NaN,
    },
  });
  const settings = await getSettings();
  assert.equal(settings.breakMode, 'off');
  assert.equal(settings.breakDelayMinutes, BREAK_DELAY_MINUTES_MAX);
  assert.equal(settings.breakDurationMinutes, 1);
  assert.equal(settings.breakTextLength, BREAK_TEXT_LENGTH_DEFAULT);
  assert.equal(writes.length, 0);
});

await test('break-setting writes clamp while unlocked and refuse while locked', async () => {
  now = NOW;
  seed({
    lockState: {
      breakStartedAt: null,
      breakNotBefore: null,
      breakEndsAt: null,
      breakUpdatedAt: 0,
      timerUntil: null,
      passwordHash: null,
      frozenUntil: null,
      schedules: [],
    },
  });
  const settings = await setSettings({
    breakDelayMinutes: 100,
    breakDurationMinutes: 0,
    breakTextLength: 5000,
  });
  assert.equal(settings.breakDelayMinutes, BREAK_DELAY_MINUTES_MAX);
  assert.equal(settings.breakDurationMinutes, 1);
  assert.equal(settings.breakTextLength, BREAK_TEXT_LENGTH_MAX);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ['settings']);

  seed();
  await assert.rejects(setSettings({ breakDurationMinutes: 30 }), /settings are locked/);
  assert.equal(writes.length, 0);
});

Date.now = realDateNow;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
