// Unit tests for pure per-category allowance/opening transitions.
// Runs directly under Node >=22.6 type stripping; no browser or test runner.
//
//   node scripts/allowance-math-test.mjs
import assert from 'node:assert/strict';
import {
  ALLOWANCE_LEDGER_VERSION,
  DEFAULT_OPENING_INACTIVITY_MS,
  DEFAULT_OPENING_MAX_LIFETIME_MS,
  MAX_ALLOWANCE_DURATION_MS,
  MAX_ALLOWANCE_TIMESTAMP_MS,
  addReward,
  cancelAllowanceGrant,
  closeOpening,
  createEmptyAllowanceLedger,
  deriveAllowance,
  normalizeAllowanceConfig,
  normalizeAllowanceLedger,
  recordOpeningActivity,
  requestAllowance,
  startOpening,
  startPomodoro,
} from '../src/shared/allowance-math.ts';

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

const T0 = 1_800_000_000_000;
const DAY = '2026-11-08';
const NEXT_DAY = '2026-11-09';
const MINUTE = 60_000;
const CONFIG = {
  dailyAllowanceMs: 10 * MINUTE,
  dailyOpenings: 2,
  waitingBaseMs: 5_000,
  waitingStepMs: 2_000,
  waitingMaxMs: 9_000,
  rewardCapMs: 3 * MINUTE,
};
const IMMEDIATE = { ...CONFIG, waitingBaseMs: 0, waitingStepMs: 0, waitingMaxMs: 0 };
const at = (nowMs, dayKey = DAY) => ({ nowMs, dayKey });
const action = (grantId, nowMs, dayKey = DAY) => ({ grantId, ...at(nowMs, dayKey) });
const request = (grantId, nowMs, durationMs = MINUTE, dayKey = DAY) => ({
  ...action(grantId, nowMs, dayKey),
  durationMs,
});
const ok = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result.ledger;
};
const refused = (result, reason) => {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  return result.ledger;
};

// Keep the helper independent of the module's public shape: normalization is
// intentionally insensitive to real local timezone or Date construction.
function empty() {
  return createEmptyAllowanceLedger(at(T0));
}

console.log('allowance-math tests');

await test('configuration is clamped and invalid opening lifetimes use safe defaults', () => {
  const clean = normalizeAllowanceConfig({
    dailyAllowanceMs: -1,
    dailyOpenings: 12.9,
    waitingBaseMs: Number.NaN,
    waitingStepMs: Number.POSITIVE_INFINITY,
    waitingMaxMs: Number.MAX_VALUE,
    rewardCapMs: -100,
    openingInactivityMs: Number.NaN,
    openingMaxLifetimeMs: 0,
  });
  assert.deepEqual(clean, {
    dailyAllowanceMs: 0,
    dailyOpenings: 12,
    waitingBaseMs: 0,
    waitingStepMs: 0,
    waitingMaxMs: MAX_ALLOWANCE_DURATION_MS,
    rewardCapMs: 0,
    rewardEarning: false,
    rewardWorkMs: 5 * 60 * 1000,
    rewardAwardMs: 60 * 1000,
    openingInactivityMs: DEFAULT_OPENING_INACTIVITY_MS,
    openingMaxLifetimeMs: DEFAULT_OPENING_MAX_LIFETIME_MS,
  });
  assert.equal(
    normalizeAllowanceConfig({ ...CONFIG, rewardEarning: 'yes' }).rewardEarning,
    false,
  );
  const ratio = normalizeAllowanceConfig({
    ...CONFIG,
    rewardWorkMs: 30_000,
    rewardAwardMs: 10 * 60 * 1000,
  });
  assert.equal(ratio.rewardWorkMs, 60_000, 'work below one minute clamps up');
  assert.equal(ratio.rewardAwardMs, 60_000, 'award never exceeds work');
  const bounded = normalizeAllowanceConfig({
    ...CONFIG,
    rewardWorkMs: Number.MAX_VALUE,
    rewardAwardMs: 0,
  });
  assert.equal(bounded.rewardWorkMs, MAX_ALLOWANCE_DURATION_MS);
  assert.equal(bounded.rewardAwardMs, 60_000, 'invalid award uses its default then clamps');
  assert.equal(
    normalizeAllowanceConfig({ ...CONFIG, openingInactivityMs: 0.5 }).openingInactivityMs,
    1,
  );
  assert.equal(
    normalizeAllowanceConfig({ ...CONFIG, openingMaxLifetimeMs: Number.MAX_VALUE })
      .openingMaxLifetimeMs,
    MAX_ALLOWANCE_DURATION_MS,
  );
});

await test('first allowance request uses base delay and caps duration to the available pool', () => {
  const result = requestAllowance(empty(), CONFIG, request('a1', T0, 30 * MINUTE));
  const ledger = ok(result);
  assert.equal(result.grant.status, 'pending');
  assert.equal(result.grant.notBeforeMs, T0 + 5_000);
  assert.equal(result.grant.endsAtMs, T0 + 5_000 + 10 * MINUTE);
  assert.equal(result.grant.durationMs, 10 * MINUTE);
  assert.equal(ledger.waitingEscalation, 1);
  assert.equal(ledger.spentMs, 0);
  const derived = deriveAllowance(ledger, CONFIG, at(T0));
  assert.equal(derived.reservedMs, 10 * MINUTE);
  assert.equal(derived.availableMs, 0);
  assert.equal(derived.nextWaitingDelayMs, 7_000);
});

await test('subsequent requests escalate linearly to max and refunds never de-escalate', () => {
  let ledger = empty();
  const expected = [5_000, 7_000, 9_000, 9_000];
  for (let index = 0; index < expected.length; index++) {
    const startedAt = T0 + index * 1_000;
    const result = requestAllowance(ledger, CONFIG, request(`e${index}`, startedAt));
    ledger = ok(result);
    assert.equal(result.grant.notBeforeMs - startedAt, expected[index]);
    ledger = ok(cancelAllowanceGrant(ledger, CONFIG, action(`e${index}`, startedAt)));
    assert.equal(ledger.spentMs, 0);
    assert.equal(ledger.waitingEscalation, index + 1);
  }
  assert.equal(deriveAllowance(ledger, CONFIG, at(T0 + 10_000)).nextWaitingDelayMs, 9_000);
});

await test('waiting cancellation charges zero and fully releases only the reservation', () => {
  let ledger = ok(requestAllowance(empty(), CONFIG, request('wait', T0)));
  ledger = ok(cancelAllowanceGrant(ledger, CONFIG, action('wait', T0 + 4_999)));
  assert.equal(ledger.spentMs, 0);
  assert.equal(ledger.waitingEscalation, 1);
  assert.equal(ledger.grant.status, 'ended');
  assert.equal(ledger.grant.endReason, 'waiting-cancelled');
  assert.equal(ledger.grant.chargedMs, 0);
  assert.equal(ledger.grant.refundedMs, MINUTE);
  const derived = deriveAllowance(ledger, CONFIG, at(T0 + 4_999));
  assert.equal(derived.consumedMs, 0);
  assert.equal(derived.reservedMs, 0);
  assert.equal(derived.availableMs, 10 * MINUTE);
});

await test('active allowance charges wall clock including otherwise idle time', () => {
  const ledger = ok(requestAllowance(empty(), IMMEDIATE, request('active', T0, 10 * MINUTE)));
  const before = deriveAllowance(ledger, IMMEDIATE, at(T0));
  assert.equal(before.grant.status, 'active');
  assert.equal(before.consumedMs, 0);
  assert.equal(before.reservedMs, 10 * MINUTE);
  const later = deriveAllowance(ledger, IMMEDIATE, at(T0 + 3 * MINUTE));
  assert.equal(later.activeElapsedMs, 3 * MINUTE);
  assert.equal(later.consumedMs, 3 * MINUTE);
  assert.equal(later.remainingMs, 7 * MINUTE);
  assert.equal(later.reservedMs, 7 * MINUTE);
  assert.equal(later.availableMs, 0);
});

await test('early active cancellation charges elapsed time and refunds unused reservation', () => {
  let ledger = ok(requestAllowance(empty(), IMMEDIATE, request('early', T0, 8 * MINUTE)));
  const snapshot = structuredClone(ledger);
  ledger = ok(cancelAllowanceGrant(ledger, IMMEDIATE, action('early', T0 + 3 * MINUTE)));
  assert.deepEqual(snapshot.grant.status, 'active', 'input grant remains unchanged');
  assert.equal(ledger.spentMs, 3 * MINUTE);
  assert.equal(ledger.grant.endReason, 'early-cancelled');
  assert.equal(ledger.grant.chargedMs, 3 * MINUTE);
  assert.equal(ledger.grant.refundedMs, 5 * MINUTE);
  assert.equal(ledger.waitingEscalation, 1);
  assert.equal(deriveAllowance(ledger, IMMEDIATE, at(T0 + 3 * MINUTE)).availableMs, 7 * MINUTE);
});

await test('natural active expiration settles the full reservation exactly once', () => {
  const requested = ok(requestAllowance(empty(), IMMEDIATE, request('expiry', T0, 2 * MINUTE)));
  const expired = normalizeAllowanceLedger(requested, IMMEDIATE, at(T0 + 2 * MINUTE));
  assert.equal(expired.spentMs, 2 * MINUTE);
  assert.equal(expired.grant.status, 'ended');
  assert.equal(expired.grant.endReason, 'expired');
  assert.equal(expired.grant.chargedMs, 2 * MINUTE);
  assert.equal(expired.grant.endedAtMs, T0 + 2 * MINUTE);
  const again = normalizeAllowanceLedger(expired, IMMEDIATE, at(T0 + 30 * MINUTE));
  assert.equal(again.spentMs, expired.spentMs);
  assert.deepEqual(again.grant, expired.grant);
  assert.equal(deriveAllowance(again, IMMEDIATE, at(T0 + 30 * MINUTE)).consumedMs, 2 * MINUTE);
});

await test('a forward jump over pending waiting and activity still expires only its fixed duration', () => {
  const requested = ok(requestAllowance(empty(), CONFIG, request('pending-expiry', T0)));
  const expired = normalizeAllowanceLedger(requested, CONFIG, at(T0 + 20 * MINUTE));
  assert.equal(expired.spentMs, MINUTE);
  assert.equal(expired.grant.endReason, 'expired');
  assert.equal(expired.grant.endedAtMs, T0 + 5_000 + MINUTE);
  assert.equal(normalizeAllowanceLedger(expired, CONFIG, at(T0 + 21 * MINUTE)).spentMs, MINUTE);
});

await test('exhausted or insufficient allowance refuses new grants without escalating', () => {
  const noPool = { ...IMMEDIATE, dailyAllowanceMs: 0, rewardCapMs: 0 };
  refused(requestAllowance(empty(), noPool, request('none', T0)), 'allowance-exhausted');
  let ledger = ok(requestAllowance(empty(), IMMEDIATE, request('all', T0, 10 * MINUTE)));
  ledger = normalizeAllowanceLedger(ledger, IMMEDIATE, at(T0 + 10 * MINUTE));
  const result = requestAllowance(ledger, IMMEDIATE, request('after-all', T0 + 10 * MINUTE + 1));
  refused(result, 'allowance-exhausted');
  assert.equal(result.ledger.waitingEscalation, 1);
  assert.equal(result.ledger.grant.id, 'all');
});

await test('same-category live grants cannot overlap in any relief kind', () => {
  const ledger = ok(requestAllowance(empty(), IMMEDIATE, request('original', T0, 5 * MINUTE)));
  refused(requestAllowance(ledger, IMMEDIATE, request('second', T0 + 1)), 'overlap');
  refused(startOpening(ledger, IMMEDIATE, action('opening', T0 + 1)), 'overlap');
  refused(startPomodoro(ledger, IMMEDIATE, request('pomodoro', T0 + 1)), 'overlap');
  const after = deriveAllowance(ledger, IMMEDIATE, at(T0 + 1));
  assert.equal(after.grant.id, 'original');
  assert.equal(after.waitingEscalation, 1);
  assert.equal(after.openingsUsed, 0);
});

await test('invalid actions return explicit refusals instead of NaN or throws', () => {
  const ledger = empty();
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    refused(requestAllowance(ledger, CONFIG, request('bad', T0, durationMs)), 'invalid-duration');
  }
  refused(requestAllowance(ledger, CONFIG, request('bad', Number.NaN)), 'invalid-time');
  refused(requestAllowance(ledger, CONFIG, request('bad', -1)), 'invalid-time');
  refused(requestAllowance(ledger, CONFIG, request('bad', T0, MINUTE, '2026-02-30')), 'invalid-day');
  refused(requestAllowance(ledger, CONFIG, request(' ', T0)), 'invalid-grant-id');
  assert.deepEqual(refused(addReward(ledger, CONFIG, { ...at(T0), earnedMs: Number.NaN }), 'invalid-reward'), ledger);
});

await test('safe-integer time ceilings refuse overflows without consuming pools or counts', () => {
  const nearMax = MAX_ALLOWANCE_TIMESTAMP_MS - 1_000;
  const initial = createEmptyAllowanceLedger(at(nearMax));
  refused(requestAllowance(initial, CONFIG, request('overflow', nearMax)), 'time-overflow');
  refused(startOpening(initial, CONFIG, action('overflow', nearMax)), 'time-overflow');
  refused(startPomodoro(initial, IMMEDIATE, request('overflow', nearMax, 2_000)), 'time-overflow');
  for (const derived of [
    deriveAllowance(initial, CONFIG, at(MAX_ALLOWANCE_TIMESTAMP_MS)),
    deriveAllowance(initial, CONFIG, at(Number.MAX_VALUE)),
  ]) {
    for (const value of Object.values(derived)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value) && value >= 0);
    }
  }
});

await test('forward day rollover resets pools, escalation, openings, and old live grants', () => {
  let ledger = ok(addReward(empty(), CONFIG, { ...at(T0), earnedMs: MINUTE }));
  ledger = ok(requestAllowance(ledger, IMMEDIATE, request('old-day', T0, MINUTE)));
  ledger = { ...ledger, openingsUsed: 2 }; // Untrusted-persistence fixture setup.
  const rolled = normalizeAllowanceLedger(ledger, IMMEDIATE, at(T0 + 1000, NEXT_DAY));
  assert.equal(rolled.dayKey, NEXT_DAY);
  assert.equal(rolled.spentMs, 0);
  assert.equal(rolled.earnedRewardMs, 0);
  assert.equal(rolled.openingsUsed, 0);
  assert.equal(rolled.waitingEscalation, 0);
  assert.equal(rolled.grant, null);
  assert.equal(rolled.lastObservedAtMs, T0 + 1000);
});

await test('backward day/clock observations never reset pools or mint elapsed time', () => {
  let ledger = ok(addReward(empty(), CONFIG, { ...at(T0), earnedMs: 2 * MINUTE }));
  ledger = ok(requestAllowance(ledger, IMMEDIATE, request('stable', T0, 4 * MINUTE)));
  const observed = deriveAllowance(ledger, IMMEDIATE, at(T0 + MINUTE));
  assert.equal(observed.consumedMs, MINUTE);
  refused(
    requestAllowance(ledger, IMMEDIATE, request('back-day', T0 + MINUTE, MINUTE, '2026-11-07')),
    'day-rollback',
  );
  refused(addReward(ledger, IMMEDIATE, { nowMs: T0 - 1, dayKey: DAY, earnedMs: MINUTE }), 'clock-rollback');
  const normalized = normalizeAllowanceLedger(ledger, IMMEDIATE, at(T0 - MINUTE, '2026-11-07'));
  assert.equal(normalized.dayKey, DAY);
  assert.equal(normalized.earnedRewardMs, 2 * MINUTE);
  assert.equal(normalized.waitingEscalation, 1);
  assert.equal(normalized.lastObservedAtMs, T0);
  assert.equal(deriveAllowance(ledger, IMMEDIATE, at(T0 - MINUTE)).consumedMs, 0);
  for (const ambiguous of [at(T0 - 1, NEXT_DAY), at(Number.NaN, NEXT_DAY)]) {
    const notReset = normalizeAllowanceLedger(ledger, IMMEDIATE, ambiguous);
    assert.equal(notReset.dayKey, DAY);
    assert.equal(notReset.earnedRewardMs, 2 * MINUTE);
    assert.equal(notReset.spentMs, 0);
    assert.equal(notReset.waitingEscalation, 1);
    assert.equal(notReset.lastObservedAtMs, T0);
  }
});

await test('earned rewards add allowance only up to cap and reset on the next day', () => {
  let ledger = ok(addReward(empty(), CONFIG, { ...at(T0), earnedMs: 2 * MINUTE }));
  assert.equal(ledger.earnedRewardMs, 2 * MINUTE);
  assert.equal(deriveAllowance(ledger, CONFIG, at(T0)).totalAllowanceMs, 12 * MINUTE);
  ledger = ok(addReward(ledger, CONFIG, { ...at(T0 + 1), earnedMs: 2 * MINUTE }));
  assert.equal(ledger.earnedRewardMs, 3 * MINUTE);
  assert.equal(deriveAllowance(ledger, CONFIG, at(T0 + 1)).totalAllowanceMs, 13 * MINUTE);
  const rolled = normalizeAllowanceLedger(ledger, CONFIG, at(T0 + 2, NEXT_DAY));
  assert.equal(rolled.earnedRewardMs, 0);
  assert.equal(deriveAllowance(rolled, CONFIG, at(T0 + 2, NEXT_DAY)).totalAllowanceMs, 10 * MINUTE);
});

await test('opening start consumes one count, never minutes or escalation, with safe defaults', () => {
  const result = startOpening(empty(), CONFIG, action('open', T0));
  const ledger = ok(result);
  assert.equal(result.grant.kind, 'opening');
  assert.equal(result.grant.status, 'active');
  assert.equal(result.grant.lastActivityAtMs, T0);
  assert.equal(result.grant.endsAtMs, T0 + DEFAULT_OPENING_MAX_LIFETIME_MS);
  assert.equal(ledger.openingsUsed, 1);
  assert.equal(ledger.spentMs, 0);
  assert.equal(ledger.waitingEscalation, 0);
  const derived = deriveAllowance(ledger, CONFIG, at(T0 + MINUTE));
  assert.equal(derived.consumedMs, 0);
  assert.equal(derived.reservedMs, 0);
  assert.equal(derived.availableMs, 10 * MINUTE);
  assert.equal(derived.openingsRemaining, 1);
});

await test('opening count exhausts daily and explicit close does not refund it', () => {
  const oneOpening = { ...CONFIG, dailyOpenings: 1 };
  let ledger = ok(startOpening(empty(), oneOpening, action('only', T0)));
  ledger = ok(closeOpening(ledger, oneOpening, action('only', T0 + 10_000)));
  assert.equal(ledger.openingsUsed, 1);
  assert.equal(ledger.grant.endReason, 'explicit');
  refused(startOpening(ledger, oneOpening, action('next', T0 + 20_000)), 'no-openings');
  const nextDay = normalizeAllowanceLedger(ledger, oneOpening, at(T0 + 20_001, NEXT_DAY));
  assert.equal(nextDay.openingsUsed, 0);
  assert.equal(nextDay.waitingEscalation, 0);
});

await test('opening activity advances a monotonic maximum and idle closes exactly at the edge', () => {
  let ledger = ok(startOpening(empty(), CONFIG, action('idle', T0)));
  ledger = ok(recordOpeningActivity(ledger, CONFIG, action('idle', T0 + 60_000)));
  assert.equal(ledger.grant.lastActivityAtMs, T0 + 60_000);
  refused(
    recordOpeningActivity(ledger, CONFIG, action('idle', T0 + 30_000)),
    'clock-rollback',
  );
  const justBefore = normalizeAllowanceLedger(ledger, CONFIG, at(T0 + 60_000 + 119_999));
  assert.equal(justBefore.grant.status, 'active');
  const closed = normalizeAllowanceLedger(justBefore, CONFIG, at(T0 + 60_000 + 120_000));
  assert.equal(closed.grant.status, 'idle-closed');
  assert.equal(closed.grant.endReason, 'idle');
  assert.equal(closed.grant.endedAtMs, T0 + 180_000);
  assert.equal(closed.openingsUsed, 1);
  assert.equal(closed.spentMs, 0);
  assert.equal(closed.waitingEscalation, 0);
  refused(closeOpening(closed, CONFIG, action('idle', T0 + 180_001)), 'grant-ended');
});

await test('opening maximum lifetime fail-closes even with continual activity', () => {
  const config = { ...CONFIG, openingInactivityMs: 1_000, openingMaxLifetimeMs: 5_000 };
  let ledger = ok(startOpening(empty(), config, action('ceiling', T0)));
  for (const elapsed of [900, 1_800, 2_700, 3_600, 4_500]) {
    ledger = ok(recordOpeningActivity(ledger, config, action('ceiling', T0 + elapsed)));
  }
  assert.equal(ledger.grant.lastActivityAtMs, T0 + 4_500);
  const capped = normalizeAllowanceLedger(ledger, config, at(T0 + 5_000));
  assert.equal(capped.grant.status, 'ended');
  assert.equal(capped.grant.endReason, 'max-lifetime');
  assert.equal(capped.grant.endedAtMs, T0 + 5_000);
  assert.equal(capped.spentMs, 0);
  refused(recordOpeningActivity(capped, config, action('ceiling', T0 + 5_001)), 'grant-ended');
});

await test('openings remain independent from an exhausted minute pool', () => {
  const config = { ...CONFIG, dailyAllowanceMs: 0, rewardCapMs: 0 };
  const result = startOpening(empty(), config, action('free-opening', T0));
  const ledger = ok(result);
  assert.equal(ledger.openingsUsed, 1);
  assert.equal(deriveAllowance(ledger, config, at(T0 + MINUTE)).availableMs, 0);
  assert.equal(ledger.spentMs, 0);
  assert.equal(ledger.waitingEscalation, 0);
});

await test('Pomodoro is free fixed-end relief and expiration changes no daily counter', () => {
  const result = startPomodoro(empty(), CONFIG, request('pom', T0, 5 * MINUTE));
  const ledger = ok(result);
  assert.equal(result.grant.status, 'active');
  assert.equal(result.grant.notBeforeMs, T0);
  assert.equal(result.grant.endsAtMs, T0 + 5 * MINUTE);
  assert.equal(ledger.spentMs, 0);
  assert.equal(ledger.openingsUsed, 0);
  assert.equal(ledger.waitingEscalation, 0);
  assert.equal(deriveAllowance(ledger, CONFIG, at(T0 + MINUTE)).availableMs, 10 * MINUTE);
  const ended = normalizeAllowanceLedger(ledger, CONFIG, at(T0 + 5 * MINUTE));
  assert.equal(ended.grant.status, 'ended');
  assert.equal(ended.grant.endReason, 'expired');
  assert.equal(ended.spentMs, 0);
  assert.equal(ended.openingsUsed, 0);
  assert.equal(ended.waitingEscalation, 0);
});

await test('malformed persistence sanitizes counters and invalid grants without unsafe numbers', () => {
  const raw = {
    version: ALLOWANCE_LEDGER_VERSION,
    dayKey: DAY,
    spentMs: Number.NaN,
    earnedRewardMs: Number.POSITIVE_INFINITY,
    openingsUsed: -10,
    waitingEscalation: 3.8,
    lastObservedAtMs: Number.POSITIVE_INFINITY,
    grant: {
      id: 'broken',
      kind: 'allowance',
      status: 'active',
      notBeforeMs: Number.NaN,
      endsAtMs: Number.POSITIVE_INFINITY,
    },
  };
  const ledger = normalizeAllowanceLedger(raw, CONFIG, at(Number.NaN));
  assert.equal(ledger.version, ALLOWANCE_LEDGER_VERSION);
  assert.equal(ledger.spentMs, 0);
  assert.equal(ledger.earnedRewardMs, 0);
  assert.equal(ledger.openingsUsed, 0);
  assert.equal(ledger.waitingEscalation, 3);
  assert.equal(ledger.lastObservedAtMs, 0);
  assert.equal(ledger.grant, null);
  const derived = deriveAllowance(ledger, CONFIG, at(T0));
  for (const value of Object.values(derived)) {
    if (typeof value === 'number') assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
});

await test('unknown grant statuses cannot reconstruct and double-settle a charged allowance', () => {
  const requested = ok(requestAllowance(empty(), IMMEDIATE, request('settled', T0, MINUTE)));
  const settled = normalizeAllowanceLedger(requested, IMMEDIATE, at(T0 + MINUTE));
  assert.equal(settled.spentMs, MINUTE);
  for (const status of ['expired', 'unknown', null, 42, 'idle-closed']) {
    const malformed = { ...settled, grant: { ...settled.grant, status } };
    const normalized = normalizeAllowanceLedger(malformed, IMMEDIATE, at(T0 + 2 * MINUTE));
    assert.equal(normalized.spentMs, MINUTE, `status ${String(status)} charged only once`);
    assert.equal(normalized.grant, null, `status ${String(status)} was rejected`);
  }
});

await test('finite unsafe persisted rewards earn nothing instead of clamping to the full cap', () => {
  for (const earnedRewardMs of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = { ...empty(), earnedRewardMs };
    const normalized = normalizeAllowanceLedger(raw, CONFIG, at(T0));
    assert.equal(normalized.earnedRewardMs, 0);
    assert.equal(deriveAllowance(raw, CONFIG, at(T0)).totalAllowanceMs, 10 * MINUTE);
  }
});

await test('future/corrupt fixed grants expire safely without negative or overflowing account state', () => {
  const raw = {
    dayKey: DAY,
    spentMs: MAX_ALLOWANCE_TIMESTAMP_MS,
    earnedRewardMs: MAX_ALLOWANCE_TIMESTAMP_MS,
    openingsUsed: MAX_ALLOWANCE_TIMESTAMP_MS,
    waitingEscalation: MAX_ALLOWANCE_TIMESTAMP_MS,
    lastObservedAtMs: MAX_ALLOWANCE_TIMESTAMP_MS - 5_000,
    grant: {
      id: 'future',
      kind: 'allowance',
      status: 'pending',
      requestedAtMs: MAX_ALLOWANCE_TIMESTAMP_MS - 5_000,
      notBeforeMs: MAX_ALLOWANCE_TIMESTAMP_MS - 4_000,
      endsAtMs: MAX_ALLOWANCE_TIMESTAMP_MS,
      chargedMs: 0,
    },
  };
  const ledger = normalizeAllowanceLedger(raw, CONFIG, at(MAX_ALLOWANCE_TIMESTAMP_MS));
  assert.equal(ledger.grant.status, 'ended');
  assert.equal(ledger.spentMs, MAX_ALLOWANCE_TIMESTAMP_MS);
  assert.equal(ledger.lastObservedAtMs, MAX_ALLOWANCE_TIMESTAMP_MS);
  const derived = deriveAllowance(ledger, CONFIG, at(MAX_ALLOWANCE_TIMESTAMP_MS));
  assert.ok(Number.isSafeInteger(derived.consumedMs));
  assert.ok(Number.isSafeInteger(derived.nextWaitingDelayMs));
  assert.equal(derived.availableMs, 0);
});

await test('all transitions preserve deep input immutability', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const initial = deepFreeze(empty());
  const requested = requestAllowance(initial, CONFIG, request('immutable', T0));
  assert.deepEqual(initial, empty());
  const active = deepFreeze(ok(requested));
  const cancelled = cancelAllowanceGrant(active, CONFIG, action('immutable', T0));
  assert.equal(active.grant.status, 'pending');
  const frozenOpening = deepFreeze(ok(startOpening(empty(), CONFIG, action('immutable-open', T0))));
  ok(recordOpeningActivity(frozenOpening, CONFIG, action('immutable-open', T0 + 1_000)));
  ok(closeOpening(frozenOpening, CONFIG, action('immutable-open', T0 + 2_000)));
  assert.equal(frozenOpening.grant.lastActivityAtMs, T0);
  assert.equal(frozenOpening.openingsUsed, 1);
  const frozenReward = deepFreeze(empty());
  ok(addReward(frozenReward, CONFIG, { ...at(T0), earnedMs: MINUTE }));
  assert.equal(frozenReward.earnedRewardMs, 0);
  assert.equal(cancelled.ok, true);
});

await test('normalization is deeply idempotent for allowance expiry and opening idle close', () => {
  const allowance = ok(requestAllowance(empty(), IMMEDIATE, request('once', T0, MINUTE)));
  const allowanceOnce = normalizeAllowanceLedger(allowance, IMMEDIATE, at(T0 + 2 * MINUTE));
  assert.deepEqual(normalizeAllowanceLedger(allowanceOnce, IMMEDIATE, at(T0 + 2 * MINUTE)), allowanceOnce);
  assert.equal(
    normalizeAllowanceLedger(allowanceOnce, IMMEDIATE, at(T0 + 3 * MINUTE)).spentMs,
    allowanceOnce.spentMs,
  );
  const opening = ok(startOpening(empty(), CONFIG, action('idle-once', T0)));
  const openingOnce = normalizeAllowanceLedger(opening, CONFIG, at(T0 + DEFAULT_OPENING_INACTIVITY_MS));
  assert.deepEqual(
    normalizeAllowanceLedger(openingOnce, CONFIG, at(T0 + DEFAULT_OPENING_INACTIVITY_MS)),
    openingOnce,
  );
});

await test('grant IDs and kind checks protect closing; duplicate settlement cannot charge twice', () => {
  let ledger = ok(requestAllowance(empty(), IMMEDIATE, request('right', T0, 2 * MINUTE)));
  refused(cancelAllowanceGrant(ledger, IMMEDIATE, action('wrong', T0 + 1)), 'grant-not-found');
  refused(closeOpening(ledger, IMMEDIATE, action('right', T0 + 1)), 'wrong-grant-kind');
  ledger = ok(cancelAllowanceGrant(ledger, IMMEDIATE, action('right', T0 + MINUTE)));
  assert.equal(ledger.spentMs, MINUTE);
  refused(
    cancelAllowanceGrant(ledger, IMMEDIATE, action('right', T0 + MINUTE + 1)),
    'grant-ended',
  );
  assert.equal(ledger.spentMs, MINUTE);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
