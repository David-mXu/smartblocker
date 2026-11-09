// Exact item10 relief/activity sequences, including the early guards that must
// run before any authority/storage call.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { applyAllowanceRelief } = await import('../src/background/allowance-relief.ts');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }
const grant = { id: 'opening-1', kind: 'opening', status: 'active' };
const lock = (overrides = {}) => ({ forceBlocking: false, reasons: [], ...overrides });

async function probe({ blocked, state, effect, relief = grant, reliefFails = false, activityFails = false }) {
  const calls = [];
  const result = await applyAllowanceRelief('video games', blocked, state, effect, {
    reliefForCategory: async (label) => {
      calls.push(`relief:${label}`);
      if (reliefFails) throw new Error('authority down');
      return relief;
    },
    recordActivity: async (label) => {
      calls.push(`activity:${label}`);
      if (activityFails) throw new Error('activity write down');
    },
    warn: (message) => calls.push(`warn:${message}`),
  });
  return { result, calls };
}

console.log('allowance relief guard/sequence tests');
await test('Frozen and global schedule guards precede every authority read', async () => {
  for (const state of [lock({ forceBlocking: true, reasons: ['frozen'] }), lock({ forceBlocking: true, reasons: ['schedule'] })]) {
    for (const blocked of [true, false]) {
      const { result, calls } = await probe({ blocked, state, effect: 'none' });
      assert.equal(result, blocked);
      assert.deepEqual(calls, [], 'no relief or activity call is allowed under a hard lock');
    }
  }
});

await test('password and active scoped-block guards preserve the classifier verdict', async () => {
  for (const [state, effect] of [
    [lock({ reasons: ['password'] }), 'none'],
    [lock(), 'active-block'],
  ]) {
    const { result, calls } = await probe({ blocked: true, state, effect });
    assert.equal(result, true);
    assert.deepEqual(calls, []);
  }
});

await test('a blocked eligible classifier reads relief then records activity', async () => {
  const { result, calls } = await probe({ blocked: true, state: lock(), effect: 'inactive-rescue' });
  assert.equal(result, false);
  assert.deepEqual(calls, ['relief:video games', 'activity:video games']);
});

await test('no live grant preserves the block and records no activity', async () => {
  const { result, calls } = await probe({ blocked: true, state: lock(), effect: 'none', relief: null });
  assert.equal(result, true);
  assert.deepEqual(calls, ['relief:video games']);
});

await test('an already-allowed classifier records activity without a relief lookup', async () => {
  const { result, calls } = await probe({ blocked: false, state: lock(), effect: 'inactive-rescue' });
  assert.equal(result, false);
  assert.deepEqual(calls, ['activity:video games']);
});

await test('relief or activity errors preserve the pre-existing class decision', async () => {
  const reliefFailure = await probe({ blocked: true, state: lock(), effect: 'none', reliefFails: true });
  assert.equal(reliefFailure.result, true);
  assert.deepEqual(reliefFailure.calls.slice(0, 1), ['relief:video games']);
  assert.match(reliefFailure.calls.at(-1), /^warn:/);

  const activityFailure = await probe({ blocked: true, state: lock(), effect: 'none', activityFails: true });
  assert.equal(activityFailure.result, false, 'a granted page stays relieved even if observation fails');
  assert.deepEqual(activityFailure.calls.slice(0, 2), ['relief:video games', 'activity:video games']);
  assert.match(activityFailure.calls.at(-1), /^warn:/);
});

console.log(`\n${passed} passed, 0 failed`);
