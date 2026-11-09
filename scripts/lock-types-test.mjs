// Focused delay/random-text lock storage, proof, and state-machine tests.
// Runs directly under Node >=22.15 type stripping; no browser or test runner.
//
//   node scripts/lock-types-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  MAX_DELAY_LOCK_MS,
  MIN_DELAY_LOCK_MS,
  clampDelayLockDuration,
  deriveLockStatus,
} from '../src/shared/lock-math.ts';
import { normalizeRandomText } from '../src/shared/breaks.ts';

// Production imports are extensionless for Vite. Resolve them to TypeScript
// only for this direct-Node suite.
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
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${error.stack ?? error.message}`);
  }
}

// Record the exact storage boundary: failed proofs must perform no writes, not
// merely write back an equivalent lock object.
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
        return Object.fromEntries(
          keys.filter((key) => stored.has(key)).map((key) => [key, clone(stored.get(key))]),
        );
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

const {
  armDelayLock,
  armRandomTextLock,
  completeDelayUnlock,
  getLockState,
  getLockStatus,
  mergeRemoteLockState,
  setCategorySchedules,
  startDelayUnlock,
} = await import('../src/shared/lock.ts');
const {
  attemptRandomTextUnlock,
  completeReadyDelayUnlock,
  requestRandomTextUnlockChallenge,
  startDelayUnlockRpc,
} = await import('../src/background/lock-types.ts');

const NOW = 1_800_000_000_000;
let now = NOW;
const realDateNow = Date.now;
Date.now = () => now;

const schedule = {
  id: 'always-focus',
  days: [0, 1, 2, 3, 4, 5, 6],
  startMinutes: 0,
  endMinutes: 1439,
  tzOffsetMinutes: 0,
  tzName: 'UTC',
};

function otherGates() {
  return {
    breakStartedAt: NOW - 10_000,
    breakNotBefore: null,
    breakEndsAt: NOW + 20 * 60_000,
    breakUpdatedAt: NOW - 10_000,
    timerUntil: NOW + 10 * 24 * 3_600_000,
    passwordHash: 'a'.repeat(64),
    passwordTs: NOW - 5_000,
    randomTextLen: 25,
    randomTextUpdatedAt: NOW - 4_000,
    frozenUntil: NOW + 11 * 24 * 3_600_000,
    schedules: [clone(schedule)],
    schedulesUpdatedAt: NOW - 6_000,
  };
}

function emptyState() {
  return {
    breakStartedAt: null,
    breakNotBefore: null,
    breakEndsAt: null,
    breakUpdatedAt: 0,
    timerUntil: null,
    passwordHash: null,
    passwordTs: 0,
    frozenUntil: null,
    schedules: [],
    schedulesUpdatedAt: 0,
  };
}

function seed(lockState = emptyState()) {
  stored.clear();
  stored.set('lockState', clone(lockState));
  writes.length = 0;
  emitChanges({
    lockState: { oldValue: undefined, newValue: clone(lockState) },
  });
}

function replaceStoredWithoutWrite(lockState) {
  const oldValue = stored.get('lockState');
  stored.set('lockState', clone(lockState));
  emitChanges({ lockState: { oldValue: clone(oldValue), newValue: clone(lockState) } });
}

const DELAY_KEYS = ['delayUntil', 'delayDurationMs', 'delayUpdatedAt'];
const RANDOM_KEYS = ['randomTextLen', 'randomTextUpdatedAt'];
function withoutKeys(state, keys) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !keys.includes(key)));
}
function assertGateWrite(before, keys) {
  assert.equal(writes.length, 1, 'expected exactly one storage write');
  assert.deepEqual(Object.keys(writes[0]), ['lockState']);
  const next = writes[0].lockState;
  assert.deepEqual(withoutKeys(next, keys), withoutKeys(before, keys));
  return next;
}

console.log('delay/random-text lock proof + transition tests');

await test('delay duration clamps only to the 1 minute–40 day contract', () => {
  assert.equal(clampDelayLockDuration(1), MIN_DELAY_LOCK_MS);
  assert.equal(clampDelayLockDuration(MIN_DELAY_LOCK_MS), MIN_DELAY_LOCK_MS);
  assert.equal(clampDelayLockDuration(MAX_DELAY_LOCK_MS), MAX_DELAY_LOCK_MS);
  assert.equal(clampDelayLockDuration(MAX_DELAY_LOCK_MS * 2), MAX_DELAY_LOCK_MS);
  assert.throws(() => clampDelayLockDuration(0), /1 minute and 40 days/);
  assert.throws(() => clampDelayLockDuration(Number.NaN), /1 minute and 40 days/);
  assert.throws(() => clampDelayLockDuration(Number.POSITIVE_INFINITY), /1 minute and 40 days/);
});

await test('arming delay persists an independent waiting gate and preserves every other field', async () => {
  now = NOW;
  const before = { ...otherGates(), delayUntil: null, delayDurationMs: null, delayUpdatedAt: NOW - 100 };
  seed(before);
  await armDelayLock(MIN_DELAY_LOCK_MS);
  const next = assertGateWrite(before, DELAY_KEYS);
  assert.equal(next.delayUntil, 0);
  assert.equal(next.delayDurationMs, MIN_DELAY_LOCK_MS);
  assert.equal(next.delayUpdatedAt, NOW);
  assert.equal(next.timerUntil, before.timerUntil);
  const status = await getLockStatus(now);
  assert.equal(status.settingsLocked, true);
  assert.equal(status.delayReady, false);
  assert.equal(status.until, null);
});

await test('invalid or duplicate delay arms perform zero writes', async () => {
  now = NOW;
  seed(emptyState());
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(armDelayLock(value), /1 minute and 40 days/);
  }
  assert.equal(writes.length, 0);
  await armDelayLock(MIN_DELAY_LOCK_MS);
  writes.length = 0;
  await assert.rejects(armDelayLock(MAX_DELAY_LOCK_MS), /already armed/);
  assert.equal(writes.length, 0);
});

await test('Start unlocking uses the persisted wait, never timerUntil, and cannot restart', async () => {
  now = NOW;
  const before = { ...otherGates(), delayUntil: 0, delayDurationMs: 120_000, delayUpdatedAt: NOW - 1 };
  seed(before);
  const status = await startDelayUnlockRpc();
  const next = assertGateWrite(before, DELAY_KEYS);
  assert.equal(next.delayUntil, NOW + 120_000);
  assert.equal(next.delayDurationMs, 120_000);
  assert.equal(next.delayUpdatedAt, NOW);
  assert.equal(next.timerUntil, before.timerUntil);
  assert.equal(status.delayReady, false);
  assert.equal(status.until, null);
  writes.length = 0;
  await assert.rejects(startDelayUnlock(), /already started/);
  assert.equal(writes.length, 0);
});

await test('early background completion and direct completion are quiet/refused without writes', async () => {
  now = NOW;
  seed({ ...emptyState(), delayUntil: NOW + 60_000, delayDurationMs: 60_000, delayUpdatedAt: NOW });
  assert.equal(await completeReadyDelayUnlock(), null);
  await assert.rejects(completeDelayUnlock(), /not elapsed/);
  assert.equal(writes.length, 0);
  now += 59_999;
  assert.equal(await completeReadyDelayUnlock(), null);
  assert.equal(writes.length, 0);
});

await test('timer expiry is automatic, but delay readiness stays locked until background release', async () => {
  now = NOW;
  const timerState = { ...emptyState(), timerUntil: NOW + 60_000 };
  seed(timerState);
  const timerStatus = deriveLockStatus(timerState, NOW + 60_000);
  assert.equal(timerStatus.settingsLocked, false);
  assert.deepEqual(timerStatus.reasons, []);
  assert.equal(writes.length, 0);

  const delayState = {
    ...emptyState(),
    delayUntil: NOW + 60_000,
    delayDurationMs: 60_000,
    delayUpdatedAt: NOW,
  };
  seed(delayState);
  assert.equal(deriveLockStatus(delayState, NOW + 59_999).delayReady, false);
  const ready = deriveLockStatus(delayState, NOW + 60_000);
  assert.equal(ready.delayReady, true);
  assert.equal(ready.settingsLocked, true);
  assert.deepEqual(ready.reasons, ['delay']);
  assert.equal(ready.until, null);
  assert.equal(writes.length, 0);
  now = NOW + 60_000;
  const released = await completeReadyDelayUnlock();
  assert.equal(released?.settingsLocked, false);
  assert.equal('delayReady' in (released ?? {}), false);
  assertGateWrite(delayState, DELAY_KEYS);
});

await test('post-delay background wake releases after an arbitrarily late worker restart', async () => {
  now = NOW;
  const before = { ...otherGates(), delayUntil: NOW + 60_000, delayDurationMs: 60_000, delayUpdatedAt: NOW };
  seed(before);
  now += 3 * 24 * 3_600_000;
  await completeReadyDelayUnlock();
  const next = assertGateWrite(before, DELAY_KEYS);
  assert.equal(next.delayUntil, null);
  assert.equal(next.delayDurationMs, null);
  assert.equal(next.delayUpdatedAt, now);
  assert.equal(next.randomTextLen, before.randomTextLen);
  assert.equal(next.breakEndsAt, before.breakEndsAt);
});

await test('Cancel returns to armed waiting; a stale original deadline cannot release the restarted wait', async () => {
  now = NOW;
  seed({ ...emptyState(), delayUntil: 0, delayDurationMs: 60_000, delayUpdatedAt: NOW - 1 });
  await startDelayUnlockRpc();
  now += 30_000;
  const { cancelDelayUnlockRpc } = await import('../src/background/lock-types.ts');
  const cancelled = await cancelDelayUnlockRpc();
  assert.equal(cancelled.delayUntil, 0);
  assert.equal(cancelled.delayDurationMs, 60_000);
  assert.equal(cancelled.settingsLocked, true);
  now += 1_000;
  await startDelayUnlockRpc();
  writes.length = 0;
  now = NOW + 60_000;
  assert.equal(await completeReadyDelayUnlock(), null, 'stale deadline released the new countdown');
  assert.equal(writes.length, 0);
  now = NOW + 91_000;
  await completeReadyDelayUnlock();
  assert.equal((await getLockState()).delayUntil, null);
  assert.equal(writes.length, 1);
});

await test('a stale release cannot resurrect delay; a newer arm can replace the tombstone', async () => {
  now = NOW;
  const released = {
    ...otherGates(),
    delayUntil: null,
    delayDurationMs: null,
    delayUpdatedAt: NOW,
  };
  seed(released);
  const changed = await mergeRemoteLockState({
    delayUntil: NOW + 60_000,
    delayDurationMs: 60_000,
    delayUpdatedAt: NOW - 100,
  });
  assert.equal(changed, false);
  assert.equal(writes.length, 0);
  assert.deepEqual(await getLockState(), released);

  now += 1;
  assert.equal(
    await mergeRemoteLockState({ delayUntil: 0, delayDurationMs: 60_000, delayUpdatedAt: now }),
    true,
  );
  const next = assertGateWrite(released, DELAY_KEYS);
  assert.equal(next.delayUntil, 0);
  assert.equal(next.delayUpdatedAt, now);
});

await test('random-text arm accepts both boundaries and rejects invalid lengths with zero writes', async () => {
  now = NOW;
  for (const length of [1, 5_000]) {
    const before = { ...otherGates(), randomTextLen: null, randomTextUpdatedAt: NOW - 100 };
    seed(before);
    await armRandomTextLock(length);
    const next = assertGateWrite(before, RANDOM_KEYS);
    assert.equal(next.randomTextLen, length);
    assert.equal(next.randomTextUpdatedAt, NOW);
  }
  seed(emptyState());
  for (const length of [0, -1, 5_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(armRandomTextLock(length), /between 1 and 5,000/);
  }
  assert.equal(writes.length, 0);
  await armRandomTextLock(10);
  writes.length = 0;
  await assert.rejects(armRandomTextLock(20), /already armed/);
  assert.equal(writes.length, 0);
});

await test('challenge creation is background-only storage-wise and uses the armed alphabet/grouping', async () => {
  now = NOW;
  const before = { ...emptyState(), randomTextLen: 23, randomTextUpdatedAt: NOW };
  seed(before);
  const challenge = await requestRandomTextUnlockChallenge();
  assert.equal(normalizeRandomText(challenge.text).length, 23);
  assert.match(
    challenge.text,
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?: [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){3} [ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{3}$/,
  );
  assert.match(challenge.id, /^[0-9a-f-]{36}$/);
  assert.equal(writes.length, 0);
  seed(emptyState());
  await assert.rejects(requestRandomTextUnlockChallenge(), /not armed/);
  assert.equal(writes.length, 0);
});

await test('challenge generation supports the exact 1 and 5,000 symbol boundaries', async () => {
  now = NOW;
  for (const length of [1, 5_000]) {
    seed({ ...emptyState(), randomTextLen: length, randomTextUpdatedAt: NOW });
    const challenge = await requestRandomTextUnlockChallenge();
    assert.equal(normalizeRandomText(challenge.text).length, length);
    assert.doesNotMatch(normalizeRandomText(challenge.text), /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/);
  }
  assert.equal(writes.length, 0);
});

await test('only the newest challenge is accepted; stale proof writes nothing', async () => {
  now = NOW;
  const before = { ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW };
  seed(before);
  const stale = await requestRandomTextUnlockChallenge();
  const latest = await requestRandomTextUnlockChallenge();
  assert.notEqual(stale.id, latest.id);
  await assert.rejects(attemptRandomTextUnlock(stale.id, stale.text), /no longer valid/);
  assert.equal(writes.length, 0);
  await attemptRandomTextUnlock(latest.id, latest.text);
  assertGateWrite(before, RANDOM_KEYS);
});

await test('a typo consumes its challenge and every rejected retry performs zero writes', async () => {
  now = NOW;
  const before = { ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW };
  seed(before);
  const challenge = await requestRandomTextUnlockChallenge();
  await assert.rejects(attemptRandomTextUnlock(challenge.id, `${challenge.text}X`), /does not match/);
  assert.equal(writes.length, 0);
  assert.deepEqual(await getLockState(), before);
  await assert.rejects(attemptRandomTextUnlock(challenge.id, challenge.text), /no longer valid/);
  assert.equal(writes.length, 0);
});

await test('expired and unknown proofs never touch lock storage', async () => {
  now = NOW;
  seed({ ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW });
  const challenge = await requestRandomTextUnlockChallenge();
  now += 15 * 60_000;
  await assert.rejects(attemptRandomTextUnlock(challenge.id, challenge.text), /expired/);
  await assert.rejects(attemptRandomTextUnlock('unknown', 'ABCDEFGHIJ'), /no longer valid/);
  assert.equal(writes.length, 0);
});

await test('a correct proof clears only its own gate and replay writes nothing', async () => {
  now = NOW;
  const before = otherGates();
  seed(before);
  const challenge = await requestRandomTextUnlockChallenge();
  const status = await attemptRandomTextUnlock(
    challenge.id,
    challenge.text.toLowerCase().replaceAll(' ', ''),
  );
  const next = assertGateWrite(before, RANDOM_KEYS);
  assert.equal(next.randomTextLen, null);
  assert.equal(next.randomTextUpdatedAt, NOW);
  assert.equal(next.delayUntil, before.delayUntil);
  assert.equal(next.timerUntil, before.timerUntil);
  assert.equal(status.reasons.includes('random-text'), false);
  assert.equal(status.settingsLocked, true);
  writes.length = 0;
  await assert.rejects(attemptRandomTextUnlock(challenge.id, challenge.text), /no longer valid/);
  assert.equal(writes.length, 0);
});

await test('concurrent copies of one valid proof have exactly one winner and one write', async () => {
  now = NOW;
  seed({ ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW });
  const challenge = await requestRandomTextUnlockChallenge();
  const results = await Promise.allSettled([
    attemptRandomTextUnlock(challenge.id, challenge.text),
    attemptRandomTextUnlock(challenge.id, challenge.text),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(writes.length, 1);
  assert.equal((await getLockState()).randomTextLen, null);
});

await test('a challenge is bound to its arm generation even when length is unchanged', async () => {
  now = NOW;
  const before = { ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW };
  seed(before);
  const challenge = await requestRandomTextUnlockChallenge();
  replaceStoredWithoutWrite({ ...before, randomTextUpdatedAt: NOW + 1 });
  await assert.rejects(attemptRandomTextUnlock(challenge.id, challenge.text), /older lock/);
  assert.equal(writes.length, 0);
  assert.equal((await getLockState()).randomTextLen, 10);
});

await test('a service-worker restart invalidates the old in-memory challenge', async () => {
  now = NOW;
  seed({ ...emptyState(), randomTextLen: 10, randomTextUpdatedAt: NOW });
  const challenge = await requestRandomTextUnlockChallenge();
  const restarted = await import('../src/background/lock-types.ts?test-restart=1');
  await assert.rejects(
    restarted.attemptRandomTextUnlock(challenge.id, challenge.text),
    /no longer valid/,
  );
  assert.equal(writes.length, 0);
});

await test('a stale random-text arm cannot erase a newer release tombstone', async () => {
  now = NOW;
  const released = { ...otherGates(), randomTextLen: null, randomTextUpdatedAt: NOW };
  seed(released);
  assert.equal(
    await mergeRemoteLockState({ randomTextLen: 5_000, randomTextUpdatedAt: NOW - 100 }),
    false,
  );
  assert.equal(writes.length, 0);
  assert.deepEqual(await getLockState(), released);
});

await test('category schedule writes preserve legacy state and pin only the scoped list', async () => {
  now = NOW;
  const legacy = { ...schedule, id: 'legacy', days: [2], tzOffsetMinutes: -300 };
  const before = { ...emptyState(), schedules: [legacy], schedulesUpdatedAt: NOW - 500 };
  seed(before);
  const scoped = {
    ...schedule,
    id: 'scoped',
    days: [new Date(now + 24 * 3_600_000).getUTCDay()],
    categories: ['video games', 'é'],
  };
  await setCategorySchedules([scoped]);
  assert.equal(writes.length, 1);
  const next = await getLockState();
  assert.deepEqual(next.schedules, before.schedules);
  assert.equal(next.schedulesUpdatedAt, before.schedulesUpdatedAt);
  assert.equal(next.categorySchedulesUpdatedAt, NOW);
  assert.deepEqual(next.categorySchedules[0].categories, scoped.categories);
  assert.equal(next.categorySchedules[0].tzOffsetMinutes, 0);
  assert.equal(next.categorySchedules[0].tzName, 'UTC');
  assert.equal((await getLockStatus()).forceBlocking, false);
});

await test('active category windows and independent legacy locks refuse edits with zero writes', async () => {
  now = NOW;
  const currentMinute = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
  const active = {
    ...schedule,
    id: 'active-scope',
    days: [new Date(now).getUTCDay()],
    startMinutes: currentMinute,
    endMinutes: (currentMinute + 10) % 1440,
    categories: ['video games'],
  };
  seed({ ...emptyState(), categorySchedules: [active], categorySchedulesUpdatedAt: NOW - 1 });
  await assert.rejects(setCategorySchedules([]), /category window is active/);
  assert.equal(writes.length, 0);
  seed({
    ...emptyState(),
    timerUntil: NOW + 60_000,
    categorySchedules: [],
    categorySchedulesUpdatedAt: NOW - 1,
  });
  await assert.rejects(setCategorySchedules([]), /SmartBlocker is locked/);
  assert.equal(writes.length, 0);
});

await test('invalid or duplicate category rules and older-peer absence cannot erase scoped state', async () => {
  now = NOW;
  const scoped = { ...schedule, id: 'kept', categories: ['video games'] };
  seed(emptyState());
  await assert.rejects(setCategorySchedules([{ ...scoped, categories: [] }]), /at least one category/);
  await assert.rejects(
    setCategorySchedules([scoped, { ...scoped, startMinutes: 60 }]),
    /IDs must be unique/,
  );
  assert.equal(writes.length, 0);
  const before = { ...emptyState(), categorySchedules: [scoped], categorySchedulesUpdatedAt: NOW - 1 };
  seed(before);
  assert.equal(await mergeRemoteLockState(emptyState()), false);
  assert.equal(writes.length, 0);
  assert.deepEqual((await getLockState()).categorySchedules, before.categorySchedules);
});

await test('forward clock compensation extends only active wall-clock deadlines and preserves gate metadata', async () => {
  // Stub the unrelated tab sweeper. The real enforcer, storage transitions,
  // skew detector, and background delay completion remain under test.
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('/src/background/blocker.ts')) {
        return {
          format: 'module',
          source: 'export async function sweepOpenTabs() {} export function advanceCategoryPolicyEpoch() {}',
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });

  now = NOW;
  let mono = 10_000;
  const before = {
    ...emptyState(),
    timerUntil: NOW + 600_000,
    delayUntil: NOW + 80_000,
    delayDurationMs: 60_000,
    delayUpdatedAt: NOW,
    randomTextLen: 25,
    randomTextUpdatedAt: NOW,
    frozenUntil: NOW + 700_000,
  };
  seed(before);
  stored.set('lockClockAnchor', { wall0: NOW, mono0: mono });

  globalThis.chrome.alarms = {
    onAlarm: { addListener() {} },
    async create() {},
    async clear() { return true; },
  };
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: () => mono });
  const realSetInterval = globalThis.setInterval;
  const clockTicks = [];
  globalThis.setInterval = (callback) => {
    clockTicks.push(callback);
    return 0;
  };
  try {
    const { initLockEnforcer } = await import('../src/background/lock-enforcer.ts');
    initLockEnforcer();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(clockTicks.length, 1);
  // Let the startup alarm/sweep task settle without advancing either clock.
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  writes.length = 0;

  now += 120_000;
  mono += 5_000;
  clockTicks[0]();
  for (
    let i = 0;
    i < 20 && !(writes.some((items) => items.lockState) && writes.some((items) => items.lockClockAnchor));
    i++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const lockWrites = writes.filter((items) => items.lockState);
  assert.equal(lockWrites.length, 1, 'expected exactly one lock-state storage write');
  const next = lockWrites[0].lockState;
  assert.deepEqual(withoutKeys(next, ['timerUntil', 'frozenUntil', 'delayUntil']), withoutKeys(before, ['timerUntil', 'frozenUntil', 'delayUntil']));
  assert.equal(writes.filter((items) => items.lockClockAnchor).length, 1);
  assert.equal(writes.length, 2, 'unexpected storage keys were written');
  const shift = 115_000;
  assert.equal(next.timerUntil, before.timerUntil + shift);
  assert.equal(next.frozenUntil, before.frozenUntil + shift);
  assert.equal(next.delayUntil, before.delayUntil + shift);
  assert.equal(next.delayDurationMs, before.delayDurationMs);
  assert.equal(next.delayUpdatedAt, before.delayUpdatedAt);
  assert.equal(next.randomTextLen, before.randomTextLen);
  assert.equal(next.randomTextUpdatedAt, before.randomTextUpdatedAt);
  assert.equal(next.breakStartedAt, before.breakStartedAt);
  assert.equal(next.breakEndsAt, before.breakEndsAt);
  assert.equal(next.schedulesUpdatedAt, before.schedulesUpdatedAt);
  if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow);
});

Date.now = realDateNow;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
