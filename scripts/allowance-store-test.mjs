// Actual extension storage writer tests with a controlled async mock.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const KEY = '__smartblockerAllowanceStoreTest';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return awaitResolve(specifier, context, nextResolve);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/shared/api.ts')) {
      return { format: 'module', shortCircuit: true, source: `export const api = globalThis.${KEY}.api;` };
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return { format: 'module', shortCircuit: true, source: `export const getLockStatus = () => globalThis.${KEY}.getLockStatus();` };
    }
    return nextLoad(url, context);
  },
});
// Useful above without wrapping a non-erasable helper around the hook.
function awaitResolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

const STORAGE_KEY = 'allowanceAuthority';
const values = {};
const writes = [];
let locked = false;
let failNextWrite = false;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
globalThis[KEY] = {
  api: {
    storage: {
      local: {
        async get(key) { return { [key]: clone(values[key]) }; },
        async set(items) {
          if (failNextWrite) { failNextWrite = false; throw new Error('injected persistence failure'); }
          writes.push(clone(items));
          Object.assign(values, clone(items));
        },
      },
      onChanged: { addListener() {} },
    },
  },
  getLockStatus: async () => ({ settingsLocked: locked }),
};

const T0 = 1_800_000_000_000;
const DAY = '2026-11-08';
const CONFIG = { dailyAllowanceMs: 600_000, dailyOpenings: 1, waitingBaseMs: 0, waitingStepMs: 0, waitingMaxMs: 0, rewardCapMs: 60_000 };
const id = (n) => n.toString(16).padStart(32, '0');
const command = (kind, n, extra = {}) => ({
  kind, operationId: id(n), category: 'video games', grantId: 'g2', nowMs: T0, dayKey: DAY, ...extra,
});
const configure = () => ({ kind: 'configure', operationId: id(1), category: 'video games', config: CONFIG });
const passed = [];
async function test(name, fn) {
  await fn();
  passed.push(name);
  console.log(`  PASS  ${name}`);
}

const {
  allowanceLocalDayKey,
  getLocalAllowanceAuthority,
  promoteLocalAllowanceAuthorityForConflict,
  reconcileLocalAllowanceSnapshot,
  submitLocalAllowanceCommand,
} = await import('../src/shared/allowance-store.ts?store-test=1');

console.log('allowance extension-store tests');
await test('serialized commands persist increasing revisions and operation ids share no grant', async () => {
  assert.equal((await submitLocalAllowanceCommand(configure())).state.revision, 1);
  await Promise.all([
    submitLocalAllowanceCommand(command('request', 2, { grantId: 'g2', durationMs: 60_000 })),
    submitLocalAllowanceCommand(command('reward', 3, { earnedMs: 30_000 })),
  ]);
  const state = await getLocalAllowanceAuthority();
  assert.equal(state.revision, 3);
  assert.equal(state.receipts.length, 3);
  assert.equal(state.categories['video games'].ledger.grant.id, 'g2');
  assert.equal(state.categories['video games'].ledger.earnedRewardMs, 30_000);
});

await test('durable duplicate retries do not write or increment revisions', async () => {
  const before = (await getLocalAllowanceAuthority()).revision;
  const writesBefore = writes.length;
  const request = command('request', 2, { grantId: 'g2', durationMs: 60_000 });
  const retry = await submitLocalAllowanceCommand(request);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.revision, before);
  assert.equal(writes.length, writesBefore);
  const mismatch = await submitLocalAllowanceCommand({ ...request, durationMs: 120_000 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'duplicate-operation');
});

await test('a lock refusal does not poison the queue and performs no write', async () => {
  const writesBefore = writes.length;
  locked = true;
  await assert.rejects(
    submitLocalAllowanceCommand({ ...configure(), operationId: id(9) }),
    /configuration cannot be changed/,
  );
  assert.equal(writes.length, writesBefore);
  locked = false;
  const cancelled = await submitLocalAllowanceCommand(command('cancel', 8, { grantId: 'g2' }));
  assert.equal(cancelled.ok, true);
  const result = await submitLocalAllowanceCommand(command('opening-start', 4, { grantId: 'open1' }));
  assert.equal(result.ok, true);
  assert.equal(result.state.categories['video games'].ledger.openingsUsed, 1);
});

await test('persistence errors are reported and the next valid command can proceed', async () => {
  const before = await getLocalAllowanceAuthority();
  failNextWrite = true;
  await assert.rejects(
    submitLocalAllowanceCommand(command('opening-close', 5, { grantId: 'open1' })),
    /injected persistence failure/,
  );
  assert.deepEqual(await getLocalAllowanceAuthority(), before);
  const result = await submitLocalAllowanceCommand(command('opening-close', 5, { grantId: 'open1' }));
  assert.equal(result.ok, true);
  assert.equal(result.state.categories['video games'].ledger.grant.endReason, 'explicit');
});

await test('a restarted writer deduplicates from the persisted receipt snapshot', async () => {
  const restarted = await import('../src/shared/allowance-store.ts?store-test=restart');
  const before = (await restarted.getLocalAllowanceAuthority()).revision;
  const result = await restarted.submitLocalAllowanceCommand(command('opening-close', 5, { grantId: 'open1' }));
  assert.equal(result.duplicate, true);
  assert.equal(result.state.revision, before);
});

await test('conflict promotion advances above both revisions and preserves history', async () => {
  const expected = await getLocalAllowanceAuthority();
  const promoted = await promoteLocalAllowanceAuthorityForConflict(expected, expected.revision + 5);
  assert.equal(promoted.revision, expected.revision + 6);
  assert.deepEqual(await getLocalAllowanceAuthority(), promoted);
  assert.equal(promoted.receipts.length, expected.receipts.length);
  assert.deepEqual(promoted.categories, expected.categories);
});

await test('a replaced snapshot wins over a stale promotion request', async () => {
  const expected = await getLocalAllowanceAuthority();
  const advanced = await submitLocalAllowanceCommand({ ...configure(), operationId: id(20) });
  assert.equal(advanced.ok, true);
  const promoted = await promoteLocalAllowanceAuthorityForConflict(expected, expected.revision + 10);
  assert.equal(promoted.revision, advanced.state.revision, 'the newer command was not overwritten');
  assert.equal((await getLocalAllowanceAuthority()).revision, advanced.state.revision);
});

await test('a promotion write failure rejects, preserves the snapshot, and frees the queue', async () => {
  const expected = await getLocalAllowanceAuthority();
  failNextWrite = true;
  await assert.rejects(
    promoteLocalAllowanceAuthorityForConflict(expected, expected.revision + 2),
    /injected persistence failure/,
  );
  assert.equal((await getLocalAllowanceAuthority()).revision, expected.revision);
  const promoted = await promoteLocalAllowanceAuthorityForConflict(expected, expected.revision + 2);
  assert.equal(promoted.revision, expected.revision + 3);
});

await test('fallback reward commands honor the opt-in reward config and daily cap', async () => {
  const category = 'social media and networking';
  const configured = await submitLocalAllowanceCommand({
    ...command('configure', 30, {
      category,
      config: {
        ...CONFIG,
        dailyAllowanceMs: 0,
        dailyOpenings: 0,
        rewardEarning: true,
        rewardWorkMs: 300_000,
        rewardAwardMs: 60_000,
        rewardCapMs: 60_000,
      },
    }),
  });
  assert.equal(configured.ok, true);
  const first = await submitLocalAllowanceCommand(
    command('reward', 31, { category, earnedMs: 60_000 }),
  );
  assert.equal(first.ok, true);
  assert.equal(first.state.categories[category].ledger.earnedRewardMs, 60_000);
  assert.equal(first.state.categories[category].config.rewardEarning, true);
  assert.equal(first.state.categories[category].config.rewardWorkMs, 300_000);
  assert.equal(first.state.categories[category].config.rewardAwardMs, 60_000);
  const second = await submitLocalAllowanceCommand(
    command('reward', 32, { category, earnedMs: 60_000 }),
  );
  assert.equal(second.ok, true);
  assert.equal(
    second.state.categories[category].ledger.earnedRewardMs,
    60_000,
    'authority still enforces the daily reward cap',
  );
});

await test('a failed accepted reconcile reports the durable revision', async () => {
  const current = await getLocalAllowanceAuthority();
  const incoming = structuredClone(current);
  incoming.revision = current.revision + 1;
  incoming.categories['reconcile-target'] = structuredClone(current.categories['video games']);
  failNextWrite = true;
  const failed = await reconcileLocalAllowanceSnapshot(incoming);
  assert.equal(failed.decision, 'accepted');
  assert.ok(failed.error, 'the persistence failure is reported');
  assert.equal(failed.state.revision, current.revision, 'the reported state is the durable one');
  assert.equal((await getLocalAllowanceAuthority()).revision, current.revision);

  const retried = await reconcileLocalAllowanceSnapshot(incoming);
  assert.equal(retried.decision, 'accepted');
  assert.equal(retried.error, undefined);
  assert.equal(retried.state.revision, current.revision + 1);
  assert.ok((await getLocalAllowanceAuthority()).categories['reconcile-target']);
});

await test('local day keys are calendar-shaped local dates', () => {
  assert.equal(allowanceLocalDayKey(new Date(2026, 10, 9)), '2026-11-09');
  assert.equal(allowanceLocalDayKey(new Date(2026, 0, 1)), '2026-01-01');
});

console.log(`\n${passed.length} passed, 0 failed`);
