// Focused per-category authority/command transition tests. No browser/daemon.
import assert from 'node:assert/strict';
import {
  MAX_ALLOWANCE_CATEGORIES,
  MAX_ALLOWANCE_RECEIPTS,
  activeAllowanceRelief,
  allowanceStateHasLocalOnlyReceipts,
  applyAllowanceCommand,
  commitAllowanceCommandRevision,
  deriveAllowanceCategory,
  emptyAllowanceAuthorityState,
} from '../src/shared/allowance-state.ts';

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
const MINUTE = 60_000;
const CONFIG = {
  dailyAllowanceMs: 10 * MINUTE,
  dailyOpenings: 1,
  waitingBaseMs: 0,
  waitingStepMs: 0,
  waitingMaxMs: 0,
  rewardCapMs: 3 * MINUTE,
};
const id = (n) => n.toString(16).padStart(32, '0');
const base = (n, category = 'video games') => ({ operationId: id(n), category });
const observation = (n, grantId = `g${n}`, nowMs = T0, dayKey = DAY) => ({
  ...base(n), grantId, nowMs, dayKey,
});
const command = (kind, n, extra = {}) => ({ kind, ...observation(n), ...extra });
const ok = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result;
};
const rejected = (result, reason) => {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  return result;
};
const configured = (category = 'video games') => {
  const initial = { kind: 'configure', ...base(1, category), config: CONFIG };
  const result = ok(applyAllowanceCommand(emptyAllowanceAuthorityState(), initial));
  return commitAllowanceCommandRevision(result.state, 1, initial);
};
const accepted = (state, value) => {
  const result = ok(applyAllowanceCommand(state, value, state.revision));
  return commitAllowanceCommandRevision(result.state, state.revision + 1, value);
};

console.log('allowance authority-state tests');

await test('configuration creates only a category template and preserves elapsed history', () => {
  const state = configured();
  assert.equal(state.revision, 1);
  assert.equal(state.categories['video games'].ledger.spentMs, 0);
  assert.equal(state.categories['video games'].ledger.dayKey, '1970-01-01');
  const updated = ok(applyAllowanceCommand(state, {
    kind: 'configure', ...base(2), config: { ...CONFIG, dailyAllowanceMs: 20 * MINUTE },
  }, 1));
  assert.equal(updated.state.revision, 1, 'validation does not assign the revision');
  assert.equal(updated.state.categories['video games'].config.dailyAllowanceMs, 20 * MINUTE);
});

await test('stale bases and malformed identities refuse without changing the input', () => {
  const state = configured();
  const snapshot = structuredClone(state);
  rejected(applyAllowanceCommand(state, command('request', 2, { durationMs: MINUTE }), 0), 'revision');
  rejected(applyAllowanceCommand(state, { ...command('request', 2, { durationMs: MINUTE }), operationId: 'bad' }), 'invalid-operation');
  rejected(applyAllowanceCommand(state, { ...command('request', 2, { durationMs: MINUTE }), category: ' ' }), 'invalid-category');
  assert.deepEqual(state, snapshot);
});

await test('a valid request commits exactly one higher revision and a persisted active grant', () => {
  const state = configured();
  const next = accepted(state, command('request', 2, { durationMs: 2 * MINUTE }));
  assert.equal(next.revision, 2);
  assert.equal(next.categories['video games'].ledger.grant.status, 'active');
  assert.equal(next.categories['video games'].ledger.grant.durationMs, 2 * MINUTE);
  assert.throws(() => commitAllowanceCommandRevision(next, 2), /must increase/);
});

await test('matching retries are idempotent across later revisions; reused IDs cannot change meaning', () => {
  let state = configured();
  const request = command('request', 2, { durationMs: 2 * MINUTE });
  state = accepted(state, request);
  state = accepted(state, command('reward', 3, { earnedMs: MINUTE }));
  const retry = ok(applyAllowanceCommand(state, request, 999));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.revision, 3);
  assert.equal(retry.state.receipts.length, 3);
  assert.equal(retry.state.categories['video games'].ledger.waitingEscalation, 1);
  rejected(
    applyAllowanceCommand(state, { ...request, durationMs: 3 * MINUTE }),
    'duplicate-operation',
  );
});

await test('categories share a revision but never consume each other’s primary pool', () => {
  let state = configured();
  state = accepted(state, { kind: 'configure', ...base(2, 'social media'), config: CONFIG });
  state = accepted(state, command('request', 3, { durationMs: 4 * MINUTE }));
  state = accepted(state, { ...command('request', 4, { durationMs: 5 * MINUTE }), category: 'social media' });
  assert.equal(state.revision, 4);
  assert.equal(state.categories['video games'].ledger.grant.durationMs, 4 * MINUTE);
  assert.equal(state.categories['social media'].ledger.grant.durationMs, 5 * MINUTE);
  assert.equal(state.categories['social media'].ledger.spentMs, 0);
});

await test('early cancellation charges elapsed time while retaining escalation', () => {
  let state = configured();
  state = accepted(state, command('request', 2, { durationMs: 5 * MINUTE }));
  state = accepted(state, command('cancel', 3, { grantId: 'g2', nowMs: T0 + MINUTE }));
  const current = state.categories['video games'].ledger;
  assert.equal(current.spentMs, MINUTE);
  assert.equal(current.grant.refundedMs, 4 * MINUTE);
  assert.equal(current.waitingEscalation, 1);
});

await test('rewards are capped and rollover cannot move backward', () => {
  let state = configured();
  state = accepted(state, command('reward', 2, { earnedMs: 5 * MINUTE }));
  assert.equal(state.categories['video games'].ledger.earnedRewardMs, 3 * MINUTE);
  rejected(
    applyAllowanceCommand(state, command('reward', 3, { earnedMs: MINUTE, nowMs: T0 - 1 })),
    'clock-rollback',
  );
  rejected(
    applyAllowanceCommand(state, command('reward', 3, { earnedMs: MINUTE, dayKey: '2026-11-07' })),
    'day-rollback',
  );
});

await test('opening commands use their own count and monotonic activity', () => {
  let state = configured();
  state = accepted(state, command('opening-start', 2));
  state = accepted(state, command('opening-activity', 3, { grantId: 'g2', nowMs: T0 + 30_000 }));
  const current = state.categories['video games'].ledger;
  assert.equal(current.openingsUsed, 1);
  assert.equal(current.grant.lastActivityAtMs, T0 + 30_000);
  assert.equal(current.grant.kind, 'opening');
  assert.equal(current.spentMs, 0);
  assert.equal(current.waitingEscalation, 0);
  rejected(applyAllowanceCommand(state, command('opening-start', 4, { nowMs: T0 + 31_000 })), 'overlap');
  state = accepted(state, command('opening-close', 4, { grantId: 'g2', nowMs: T0 + 31_000 }));
  rejected(applyAllowanceCommand(state, command('opening-start', 5, { nowMs: T0 + 32_000 })), 'no-openings');
});

await test('Pomodoro grants are free fixed relief and observations settle them once', () => {
  let state = configured();
  state = accepted(state, command('pomodoro-start', 2, { durationMs: 5 * MINUTE }));
  const derived = deriveAllowanceCategory(state, 'video games', { nowMs: T0 + 5 * MINUTE, dayKey: DAY });
  assert.equal(derived.ledger.grant.status, 'ended');
  assert.equal(derived.ledger.spentMs, 0);
  assert.equal(derived.ledger.openingsUsed, 0);
  assert.equal(derived.ledger.waitingEscalation, 0);
});

await test('unknown commands and wrong action kinds cannot close a grant', () => {
  let state = configured();
  state = accepted(state, command('request', 2, { durationMs: MINUTE }));
  rejected(applyAllowanceCommand(state, command('opening-close', 3, { grantId: 'g2' })), 'wrong-grant-kind');
  rejected(applyAllowanceCommand(state, { kind: 'unknown', ...observation(3) }), 'invalid-operation');
});

await test('relief is primary-category/live-only and pending or idle grants never relax a page', () => {
  let state = configured();
  state = accepted(state, command('request', 2, { grantId: 'other', durationMs: MINUTE }));
  assert.equal(activeAllowanceRelief(state, 'social media', { nowMs: T0, dayKey: DAY }), null);
  assert.equal(activeAllowanceRelief(state, 'video games', { nowMs: T0, dayKey: DAY })?.id, 'other');
  assert.equal(activeAllowanceRelief(state, 'video games', { nowMs: T0 + MINUTE, dayKey: DAY }), null);

  const cancelled = accepted(state, command('cancel', 12, { grantId: 'other' }));
  const waitingConfig = { ...CONFIG, waitingBaseMs: 5_000, waitingMaxMs: 5_000 };
  const waitingState = accepted(cancelled, {
    kind: 'configure', ...base(10), config: waitingConfig,
  });
  const pendingState = accepted(waitingState, command('request', 11, { durationMs: MINUTE }));
  assert.equal(activeAllowanceRelief(pendingState, 'video games', { nowMs: T0, dayKey: DAY }), null);
  assert.equal(activeAllowanceRelief(pendingState, 'video games', { nowMs: T0 + 5_000, dayKey: DAY })?.id, 'g11');

  const opened = accepted(cancelled, command('opening-start', 13, { grantId: 'limited' }));
  assert.equal(activeAllowanceRelief(opened, 'video games', { nowMs: T0, dayKey: DAY })?.kind, 'opening');
  assert.equal(activeAllowanceRelief(opened, 'video games', { nowMs: T0 + 120_000, dayKey: DAY }), null);
});

await test('cap and malformed authority failures never fabricate a category transition', () => {
  let state = emptyAllowanceAuthorityState();
  for (let n = 0; n < MAX_ALLOWANCE_CATEGORIES; n++) {
    const category = `c${n}`;
    state = accepted(state, { kind: 'configure', ...base(n + 1, category), config: CONFIG });
  }
  rejected(applyAllowanceCommand(state, { kind: 'configure', ...base(999, 'overflow'), config: CONFIG }), 'category-limit');
  const snapshot = structuredClone(state);
  rejected(applyAllowanceCommand({ version: 999, revision: 0, categories: {} }, {
    kind: 'configure', ...base(1), config: CONFIG,
  }), 'version');
  assert.deepEqual(state, snapshot);
});

await test('a receipt evicted from the peer window is not local-only history', () => {
  const configureChain = (count) => {
    let state = emptyAllowanceAuthorityState();
    for (let n = 1; n <= count; n++) {
      const value = { kind: 'configure', ...base(n), config: CONFIG };
      state = accepted(state, value);
    }
    return state;
  };
  const local = configureChain(70); // retained receipts 7..70
  const daemon = configureChain(72); // retained receipts 9..72
  assert.equal(local.receipts.length, MAX_ALLOWANCE_RECEIPTS);
  assert.equal(local.receipts[0].revision, 7);
  assert.equal(daemon.receipts[0].revision, 9);
  assert.equal(
    allowanceStateHasLocalOnlyReceipts(local, daemon),
    false,
    'evicted receipts 7/8 are ambiguous, not proof of an offline transition',
  );

  const divergent = structuredClone(local);
  divergent.revision = 71;
  divergent.receipts.push({ operationId: id(999), fingerprint: 'f'.repeat(64), revision: 71 });
  divergent.receipts = divergent.receipts.slice(-MAX_ALLOWANCE_RECEIPTS);
  assert.equal(allowanceStateHasLocalOnlyReceipts(divergent, daemon), true, 'a receipt inside the peer window is genuine divergence');

  const changed = structuredClone(local);
  changed.receipts.at(-1).fingerprint = 'e'.repeat(64);
  assert.equal(allowanceStateHasLocalOnlyReceipts(changed, daemon), true, 'a same-revision fingerprint mismatch still diverges');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
