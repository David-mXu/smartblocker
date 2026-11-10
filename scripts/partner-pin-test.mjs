// Browser-side partner authority pin: a raw lockState write must not release
// the settings freeze while the daemon remains armed, and a daemon release
// must still be adopted. Uses the real lock merge with mocked extension storage.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerPartnerPinTest';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/shared/api.ts')) {
      return { format: 'module', shortCircuit: true, source: `export const api = globalThis.${HARNESS}.api; export const IS_FIREFOX = false;` };
    }
    return nextLoad(url, context);
  },
});

const storage = new Map();
const changeListeners = [];
const clone = (value) => value === undefined ? undefined : structuredClone(value);
globalThis[HARNESS] = {
  api: {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: clone(storage.get(keys)) };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, clone(storage.get(key))]));
          }
          return Object.fromEntries([...storage].map(([key, value]) => [key, clone(value)]));
        },
        async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, clone(value)); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        },
      },
      onChanged: { addListener(fn) { changeListeners.push(fn); } },
    },
  },
};
function invalidate(changes) {
  for (const fn of changeListeners) fn(changes, 'local');
}

const { getLockState, getLockStatus, mergeRemoteLockState } = await import('../src/shared/lock.ts?partner-pin=1');
const arm = 'a'.repeat(64);
const otherArm = 'b'.repeat(64);
const now = Date.now();
const armed = {
  breakStartedAt: null, breakNotBefore: null, breakEndsAt: null, breakUpdatedAt: 0,
  timerUntil: null, passwordHash: null, passwordTs: 0, frozenUntil: null,
  schedules: [], schedulesUpdatedAt: 0,
  partnerArmGeneration: arm, partnerArmUpdatedAt: now - 2_000,
};
const released = { ...armed, partnerArmGeneration: null, partnerArmUpdatedAt: now - 1_000 };
const upgradeArm = { ...armed, partnerArmGeneration: 'c'.repeat(64), partnerArmUpdatedAt: now - 5_000 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('partner browser authority pin tests');
await test('an armed raw state seeds the pin on upgrade', async () => {
  storage.set('lockState', structuredClone(upgradeArm));
  invalidate({ lockState: {} });
  const state = await getLockState();
  assert.equal(state.partnerArmGeneration, upgradeArm.partnerArmGeneration);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  assert.equal(storage.get('partnerArmState')?.generation, upgradeArm.partnerArmGeneration);
});

await test('a cold merge seeds an armed raw state without a queue deadlock', async () => {
  storage.delete('partnerArmState');
  storage.set('lockState', structuredClone(upgradeArm));
  invalidate({ lockState: {}, partnerArmState: {} });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('merge deadlocked on its own seed')), 2_000);
  });
  try {
    await Promise.race([mergeRemoteLockState(upgradeArm), timeout]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(storage.get('partnerArmState')?.generation, upgradeArm.partnerArmGeneration);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
});

await test('the daemon arm is pinned and locks settings', async () => {
  assert.equal(await mergeRemoteLockState(armed), true);
  const state = await getLockState();
  assert.equal(state.partnerArmGeneration, arm);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  const raw = storage.get('lockState');
  assert.equal(raw.partnerArmGeneration, arm);
  assert.equal(storage.get('partnerArmState')?.generation, arm);
});

await test('a raw lockState clear cannot release the pinned arm', async () => {
  storage.set('lockState', {
    ...storage.get('lockState'),
    partnerArmGeneration: null,
    partnerArmUpdatedAt: now + 60_000,
  });
  // A storage change invalidates any in-memory cache in the real worker.
  // The cold read must still see the separate pin, before any merge repairs it.
  invalidate({ lockState: {} });
  const cold = await getLockState();
  assert.equal(cold.partnerArmGeneration, arm, 'the cold read is pinned');
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  const changed = await mergeRemoteLockState(armed);
  assert.equal(changed, true, 'the raw clear is repaired');
  assert.equal((await getLockState()).partnerArmGeneration, arm);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  assert.equal(storage.get('lockState').partnerArmGeneration, arm);
});

await test('a raw arm swap cannot replace the daemon generation', async () => {
  storage.set('lockState', {
    ...storage.get('lockState'),
    partnerArmGeneration: otherArm,
    partnerArmUpdatedAt: now + 60_000,
  });
  invalidate({ lockState: {} });
  assert.equal((await getLockState()).partnerArmGeneration, arm, 'the cold read ignores the swap');
  await mergeRemoteLockState(armed);
  assert.equal((await getLockState()).partnerArmGeneration, arm);
});

await test('a stale release frame cannot outrank a newer arm', async () => {
  const staleRelease = { ...released, partnerArmUpdatedAt: now - 3_000 };
  assert.equal(await mergeRemoteLockState(staleRelease), false);
  assert.equal((await getLockState()).partnerArmGeneration, arm);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  assert.equal(storage.get('partnerArmState')?.generation, arm);
});

await test('an equal-stamp stale release cannot unlock a same-millisecond arm', async () => {
  const equalRelease = { ...released, partnerArmUpdatedAt: now - 2_000 };
  assert.equal(await mergeRemoteLockState(equalRelease), false);
  assert.equal((await getLockState()).partnerArmGeneration, arm);
  assert.equal((await getLockStatus(now)).settingsLocked, true);
  assert.equal(storage.get('partnerArmState')?.generation, arm);
});

await test('a daemon release still wins over the pinned arm', async () => {
  assert.equal(await mergeRemoteLockState(released), true);
  assert.equal((await getLockState()).partnerArmGeneration, null);
  assert.equal((await getLockStatus(now)).settingsLocked, false);
  assert.equal(storage.get('lockState').partnerArmGeneration, null);
  assert.equal(storage.get('partnerArmState')?.generation, null);
});

console.log(`\n${passed} passed, 0 failed`);
