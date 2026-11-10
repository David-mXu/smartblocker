// Unit tests for productive-work reward accrual: pure ratio math, idle/stale
// gaps, restart recovery, day rollover, caps, disabled/relief boundaries,
// duplicate checkpoints, and exact-once authoritative command retries.
//
//   node scripts/reward-accrual-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  REWARD_MAX_CHECKPOINT_GAP_MS,
  createEmptyRewardAccrualState,
  localRewardDayKey,
  pendingRewardAwards,
  rewardAccrualStatus,
  rewardVerdictEligible,
  sanitizeRewardAccrualState,
  settleRewardAward,
  transitionRewardCheckpoint,
} = await import('../src/shared/reward-accrual.ts');
const { RewardAccrualTracker } = await import('../src/background/reward-tracker.ts');

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

const T0 = new Date(2026, 10, 9, 9, 0, 0).getTime();
const DAY = '2026-11-09';
const NEXT_DAY = '2026-11-10';
const MINUTE = 60_000;
const CATEGORY = 'video games';
const OTHER = 'social media and networking';
const DEVICE = 'a'.repeat(32);
const CONFIG = { workMs: MINUTE, awardMs: 30_000, remainingCapMs: 10 * MINUTE };
const configs = (overrides = {}) => ({ [CATEGORY]: { ...CONFIG, ...overrides } });

function empty() {
  return createEmptyRewardAccrualState(DEVICE);
}

function checkpoint(state, at, categories = [CATEGORY], config = configs(), discardPrevious = false) {
  return transitionRewardCheckpoint(state, {
    atMs: at,
    dayKey: localRewardDayKey(at),
    categories,
    configs: config,
    discardPrevious,
  });
}

function okAward(award) {
  return {
    ok: true,
    state: {},
    kind: 'reward',
    category: award.category,
    grant: null,
  };
}

class MemoryStorage {
  values = {};
  writes = 0;
  async get(key) {
    return { [key]: this.values[key] === undefined ? undefined : structuredClone(this.values[key]) };
  }
  async set(items) {
    this.writes++;
    for (const [key, value] of Object.entries(items)) this.values[key] = structuredClone(value);
  }
}

console.log('reward accrual tests');

await test('the first checkpoint is recovery-only and each full unit credits once', () => {
  let state = empty();
  const first = checkpoint(state, T0);
  assert.equal(first.state.categories[CATEGORY].progressMs, 0);
  assert.equal(first.awards.length, 0);

  state = first.state;
  const second = checkpoint(state, T0 + MINUTE);
  assert.equal(second.state.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(second.awards.length, 1);
  assert.equal(second.awards[0].earnedMs, 30_000);
  assert.equal(second.awards[0].consumedWorkMs, MINUTE);
  assert.match(second.awards[0].operationId, /^[0-9a-f]{48}$/);

  // While the intent is pending, more checkpoints cannot mint a duplicate.
  const third = checkpoint(second.state, T0 + 2 * MINUTE);
  assert.equal(third.awards.length, 0);
  assert.equal(pendingRewardAwards(third.state).length, 1);

  const settled = settleRewardAward(third.state, second.awards[0].operationId, true);
  assert.equal(settled.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(pendingRewardAwards(settled).length, 0);
});

await test('a tab switch credits the page that was actually worked on', () => {
  let state = checkpoint(empty(), T0).state;
  const switched = checkpoint(
    state,
    T0 + MINUTE,
    [OTHER],
    {
      [CATEGORY]: CONFIG,
      [OTHER]: { ...CONFIG },
    },
  );
  assert.equal(switched.state.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(switched.awards.length, 1);
  assert.equal(switched.awards[0].category, CATEGORY);
  assert.equal(switched.state.categories[OTHER].progressMs, 0);
  assert.deepEqual(switched.state.checkpoint.categories, [OTHER]);
});

await test('each opt-in category has an independent pool and deterministic id', () => {
  const both = { [CATEGORY]: CONFIG, [OTHER]: { ...CONFIG } };
  let state = checkpoint(empty(), T0, [CATEGORY, OTHER], both).state;
  const second = checkpoint(state, T0 + MINUTE, [CATEGORY, OTHER], both);
  assert.equal(second.awards.length, 2);
  assert.deepEqual(
    second.awards.map((award) => award.category).sort(),
    [CATEGORY, OTHER].sort(),
  );
  assert.notEqual(second.awards[0].operationId, second.awards[1].operationId);
  assert.equal(second.state.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(second.state.categories[OTHER].progressMs, MINUTE);

  // A category at its cap stops minting without blocking the other pool.
  state = settleRewardAward(second.state, second.awards[0].operationId);
  state = settleRewardAward(state, second.awards[1].operationId);
  const capped = checkpoint(
    state,
    T0 + 2 * MINUTE,
    [CATEGORY, OTHER],
    { [CATEGORY]: { ...CONFIG, remainingCapMs: 0 }, [OTHER]: { ...CONFIG } },
  );
  assert.equal(capped.awards.length, 1);
  assert.equal(capped.awards[0].category, OTHER);
});

await test('a stale gap is discarded in full after the bounded checkpoint window', () => {
  let state = checkpoint(empty(), T0).state;
  const second = checkpoint(state, T0 + MINUTE);
  state = settleRewardAward(second.state, second.awards[0].operationId);
  assert.equal(state.categories[CATEGORY].progressMs, 0);
  // 200s gap: the whole preceding segment is discarded, not truncated to 135s.
  state = checkpoint(state, T0 + MINUTE + 200_000).state;
  assert.equal(state.categories[CATEGORY].progressMs, 0);
  assert.equal(pendingRewardAwards(state).length, 0);
  // A normal checkpoint after the stale boundary resumes accruing.
  const resumed = checkpoint(state, T0 + MINUTE + 200_000 + MINUTE);
  assert.equal(resumed.state.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(resumed.awards.length, 1);
  assert.ok(REWARD_MAX_CHECKPOINT_GAP_MS < 200_000);
});

await test('discardPrevious (startup/idle recovery) charges nothing before the boundary', () => {
  const state = checkpoint(empty(), T0).state;
  const recovered = checkpoint(state, T0 + MINUTE, [CATEGORY], configs(), true);
  assert.equal(recovered.state.categories[CATEGORY].progressMs, 0);
  assert.equal(recovered.awards.length, 0);
});

await test('an identical checkpoint time does not double count', () => {
  let state = checkpoint(empty(), T0).state;
  state = checkpoint(state, T0 + MINUTE).state;
  const repeated = checkpoint(state, T0 + MINUTE);
  assert.equal(repeated.state.categories[CATEGORY].progressMs, MINUTE);
  assert.equal(pendingRewardAwards(repeated.state).length, 1);
  assert.equal(repeated.awards.length, 0);
});

await test('work does not carry across local midnight, but the new day starts clean', () => {
  let state = checkpoint(empty(), T0).state;
  const first = checkpoint(state, T0 + MINUTE);
  state = settleRewardAward(first.state, first.awards[0].operationId);
  assert.equal(state.categories[CATEGORY].progressMs, 0);
  const tomorrow = new Date(2026, 10, 10, 9, 0, 0).getTime();
  const rolled = checkpoint(state, tomorrow);
  assert.equal(rolled.state.categories[CATEGORY].dayKey, NEXT_DAY);
  assert.equal(rolled.state.categories[CATEGORY].progressMs, 0);
  const earned = checkpoint(rolled.state, tomorrow + MINUTE);
  assert.equal(earned.awards.length, 1);
  assert.equal(earned.awards[0].dayKey, NEXT_DAY);
});

await test('the remaining daily cap bounds the requested award', () => {
  let state = checkpoint(empty(), T0).state;
  const capped = checkpoint(state, T0 + MINUTE, [CATEGORY], configs({ remainingCapMs: 15_000 }));
  assert.equal(capped.awards.length, 1);
  assert.equal(capped.awards[0].earnedMs, 15_000);
  const settled = settleRewardAward(capped.state, capped.awards[0].operationId);
  assert.equal(settled.categories[CATEGORY].progressMs, 0);
  const none = checkpoint(
    settled,
    T0 + 2 * MINUTE,
    [CATEGORY],
    configs({ remainingCapMs: 0 }),
  );
  assert.equal(none.awards.length, 0);
  assert.equal(none.state.categories[CATEGORY].progressMs, MINUTE);
});

await test('disabled earning accrues nothing, and an explicit relief/break boundary accrues nothing', () => {
  let state = checkpoint(empty(), T0, [], {}).state;
  state = checkpoint(state, T0 + MINUTE, [], {}).state;
  assert.deepEqual(state.categories, {});
  assert.equal(pendingRewardAwards(state).length, 0);

  // The tracker reports the boundary reason; no category was eligible.
  const status = rewardAccrualStatus(state, 'relief', {});
  assert.equal(status.earning, false);
  assert.equal(status.reason, 'relief');
  assert.equal(rewardAccrualStatus(state, 'break', {}).earning, false);
});

await test('only a confident real classifier allow is productive', () => {
  assert.equal(rewardVerdictEligible({ kind: 'allowed', score: 0.8 }, 0.5), true);
  assert.equal(rewardVerdictEligible({ kind: 'allowed', score: 0.5 }, 0.5), true);
  assert.equal(rewardVerdictEligible({ kind: 'allowed', score: 0.49 }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'blocked', score: 0.9 }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'blocked-rule', score: 0.9 }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'overridden', score: 0.9 }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'browsing', score: 0.9 }, 0.5), false);
  // Whitelisted pages have an allowed kind but no classifier verdict/score.
  assert.equal(rewardVerdictEligible({ kind: 'allowed' }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'allowed', score: Number.NaN }, 0.5), false);
  assert.equal(rewardVerdictEligible({ kind: 'allowed', score: 0.9 }, Number.NaN), false);
  assert.equal(rewardVerdictEligible(null, 0.5), false);
});

await test('malformed persistence is bounded and prototype-safe', () => {
  const clean = sanitizeRewardAccrualState(
    {
      version: 1,
      deviceId: 'not-hex',
      nextAwardOrdinal: -5,
      categories: {
        __proto__: { dayKey: DAY, progressMs: 123, pending: null },
        [CATEGORY]: {
          dayKey: DAY,
          progressMs: Number.MAX_VALUE,
          pending: {
            operationId: 'f'.repeat(48),
            category: CATEGORY,
            dayKey: DAY,
            nowMs: T0,
            earnedMs: 30_000,
            consumedWorkMs: MINUTE,
          },
        },
      },
      checkpoint: { atMs: T0, categories: [CATEGORY, CATEGORY, '__proto__'] },
    },
    DEVICE,
  );
  assert.equal(clean.deviceId, DEVICE);
  assert.equal(clean.nextAwardOrdinal, 0);
  assert.equal(clean.categories[CATEGORY].progressMs, 24 * 60 * MINUTE);
  assert.equal(pendingRewardAwards(clean).length, 1);
  assert.deepEqual(clean.checkpoint.categories, [CATEGORY, '__proto__']);

  // JSON.parse creates an own "__proto__" key; sanitizing must keep it as data.
  const proto = sanitizeRewardAccrualState(
    JSON.parse(
      JSON.stringify({
        version: 1,
        deviceId: DEVICE,
        nextAwardOrdinal: 0,
        categories: { ['__proto__']: { dayKey: DAY, progressMs: 123, pending: null } },
        checkpoint: null,
      }),
    ),
    DEVICE,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(proto.categories, '__proto__'), true);
  assert.equal(proto.categories['__proto__'].progressMs, 123);
});

console.log('\ntracker tests');

await test('restart recovery charges no stale gap, then resumes normally', async () => {
  const storage = new MemoryStorage();
  const resolution = { categories: [CATEGORY], configs: configs(), reason: 'earning', discardPrevious: false };
  const attempts = [];
  const first = new RewardAccrualTracker(storage, () => resolution, async (award) => {
    attempts.push(award.operationId);
    return okAward(award);
  });
  await first.checkpoint(T0);
  await first.checkpoint(T0 + MINUTE);
  assert.equal(attempts.length, 1, 'one full unit was submitted');
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);

  const restarted = new RewardAccrualTracker(storage, () => resolution, async (award) => {
    attempts.push(award.operationId);
    return okAward(award);
  });
  await restarted.checkpoint(T0 + 10 * MINUTE);
  assert.equal(attempts.length, 1, 'the 9-minute recovery gap was not charged');
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);
  await restarted.checkpoint(T0 + 10 * MINUTE + MINUTE);
  assert.equal(attempts.length, 2);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);
});

await test('a pending intent is retried with the exact same id, time and amount', async () => {
  const storage = new MemoryStorage();
  const resolution = { categories: [CATEGORY], configs: configs(), reason: 'earning', discardPrevious: false };
  const attempts = [];
  let settle = false;
  const tracker = new RewardAccrualTracker(storage, () => resolution, async (award) => {
    attempts.push({ ...award });
    return settle
      ? okAward(award)
      : { ok: false, state: {}, reason: 'revision' };
  });
  await tracker.checkpoint(T0);
  await tracker.checkpoint(T0 + MINUTE);
  assert.equal(attempts.length, 1);
  assert.equal(
    storage.values['rewardAccrual:v1'].categories[CATEGORY].pending.operationId,
    attempts[0].operationId,
  );
  await tracker.checkpoint(T0 + 2 * MINUTE);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0], 'retry reuses the exact command payload');

  settle = true;
  await tracker.checkpoint(T0 + 3 * MINUTE);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2], attempts[0]);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].pending, null);
  assert.equal(
    storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs,
    2 * MINUTE,
    'work continued during the failed submissions and remains claimable',
  );
  const status = await tracker.status();
  assert.equal(status.earning, true);
});

await test('a terminal refusal consumes its work instead of retrying forever', async () => {
  const storage = new MemoryStorage();
  const resolution = { categories: [CATEGORY], configs: configs(), reason: 'earning', discardPrevious: false };
  const attempts = [];
  const tracker = new RewardAccrualTracker(storage, () => resolution, async (award) => {
    attempts.push(award.operationId);
    return { ok: false, state: {}, reason: 'day-rollback' };
  });
  await tracker.checkpoint(T0);
  await tracker.checkpoint(T0 + MINUTE);
  assert.equal(attempts.length, 1);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);
  await tracker.checkpoint(T0 + MINUTE);
  assert.equal(attempts.length, 1, 'the same intent was not resubmitted');
  assert.equal(pendingRewardAwards(storage.values['rewardAccrual:v1']).length, 0);

  await tracker.checkpoint(T0 + 2 * MINUTE);
  assert.equal(attempts.length, 2, 'only newly observed work creates a new intent');
  assert.notEqual(attempts[1], attempts[0]);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);
});

await test('break/relief/not-locked resolutions accrue nothing while claimable progress stays bounded', async () => {
  const storage = new MemoryStorage();
  let resolution = { categories: [CATEGORY], configs: configs(), reason: 'earning', discardPrevious: false };
  const tracker = new RewardAccrualTracker(storage, () => resolution, async (award) => okAward(award));
  await tracker.checkpoint(T0);
  await tracker.checkpoint(T0 + MINUTE);
  await tracker.checkpoint(T0 + 2 * MINUTE);
  const before = storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs;

  resolution = { categories: [], configs: configs(), reason: 'break', discardPrevious: true };
  await tracker.checkpoint(T0 + 3 * MINUTE);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, before);
  const status = await tracker.status();
  assert.equal(status.earning, false);
  assert.equal(status.reason, 'break');
  assert.equal(status.progress.find((entry) => entry.category === CATEGORY).pending, false);
});

await test('day rollover resets the persisted progress view', async () => {
  const storage = new MemoryStorage();
  const resolution = { categories: [CATEGORY], configs: configs(), reason: 'earning', discardPrevious: false };
  const tracker = new RewardAccrualTracker(storage, () => resolution, async (award) => okAward(award));
  await tracker.checkpoint(T0);
  await tracker.checkpoint(T0 + MINUTE);
  const tomorrow = new Date(2026, 10, 10, 9, 0, 0).getTime();
  await tracker.checkpoint(tomorrow);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].dayKey, NEXT_DAY);
  assert.equal(storage.values['rewardAccrual:v1'].categories[CATEGORY].progressMs, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
