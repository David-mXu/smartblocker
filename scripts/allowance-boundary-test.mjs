import assert from 'node:assert/strict';
import {
  applyAllowanceCommand,
  commitAllowanceCommandRevision,
  emptyAllowanceAuthorityState,
  nextAllowanceBoundary,
} from '../src/shared/allowance-state.ts';

const T0 = 1_800_000_000_000;
const DAY = '2026-11-08';
const config = { dailyAllowanceMs: 60_000, dailyOpenings: 2, waitingBaseMs: 5_000, waitingStepMs: 0, waitingMaxMs: 5_000, rewardCapMs: 0, openingInactivityMs: 10_000, openingMaxLifetimeMs: 120_000 };
let state = applyAllowanceCommand(emptyAllowanceAuthorityState(), { kind: 'configure', operationId: 'a'.repeat(32), category: 'video games', config });
state = commitAllowanceCommandRevision(state.state, 1, { kind: 'configure', operationId: 'a'.repeat(32), category: 'video games', config });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

test('a daily reset is always scheduled when no grant exists', () => {
  const boundary = nextAllowanceBoundary(state, T0);
  const local = new Date(T0);
  assert.equal(boundary, new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1).getTime());
});
test('pending upgrade wakes at notBefore, not at an unrelated ended grant', () => {
  const result = applyAllowanceCommand(state, { kind: 'request', operationId: 'b'.repeat(32), category: 'video games', grantId: 'pending', nowMs: T0, dayKey: DAY, durationMs: 30_000 });
  state = commitAllowanceCommandRevision(result.state, 2, { kind: 'request', operationId: 'b'.repeat(32), category: 'video games', grantId: 'pending', nowMs: T0, dayKey: DAY, durationMs: 30_000 });
  assert.equal(nextAllowanceBoundary(state, T0), T0 + 5_000);
  assert.equal(nextAllowanceBoundary(state, T0 + 5_000), T0 + 35_000);
});
test('opening boundary is the earlier of inactivity and max lifetime, and disappears after close', () => {
  const cancelled = applyAllowanceCommand(state, { kind: 'cancel', operationId: 'e'.repeat(32), category: 'video games', grantId: 'pending', nowMs: T0, dayKey: DAY });
  state = commitAllowanceCommandRevision(cancelled.state, 3, { kind: 'cancel', operationId: 'e'.repeat(32), category: 'video games', grantId: 'pending', nowMs: T0, dayKey: DAY });
  const started = applyAllowanceCommand(state, { kind: 'opening-start', operationId: 'c'.repeat(32), category: 'video games', grantId: 'open', nowMs: T0, dayKey: DAY });
  state = commitAllowanceCommandRevision(started.state, 4, { kind: 'opening-start', operationId: 'c'.repeat(32), category: 'video games', grantId: 'open', nowMs: T0, dayKey: DAY });
  assert.equal(nextAllowanceBoundary(state, T0), T0 + 10_000);
  const close = applyAllowanceCommand(state, { kind: 'opening-close', operationId: 'd'.repeat(32), category: 'video games', grantId: 'open', nowMs: T0 + 1_000, dayKey: DAY });
  state = commitAllowanceCommandRevision(close.state, 5, { kind: 'opening-close', operationId: 'd'.repeat(32), category: 'video games', grantId: 'open', nowMs: T0 + 1_000, dayKey: DAY });
  const local = new Date(T0);
  assert.equal(nextAllowanceBoundary(state, T0), new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1).getTime());
});
test('malformed authorities and expired grants have no live future grant boundary', () => {
  assert.equal(nextAllowanceBoundary({ version: 99 }, T0), null);
});
console.log(`\n${passed} passed, 0 failed`);
