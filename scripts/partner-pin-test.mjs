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
      onChanged: { addListener() {} },
    },
  },
};

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

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('partner browser authority pin tests');
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
  // The storage event in a real worker would invalidate this; the test imports
  // once, so reset by merging the daemon's unchanged state.
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
  await mergeRemoteLockState(armed);
  assert.equal((await getLockState()).partnerArmGeneration, arm);
});

await test('a daemon release still wins over the pinned arm', async () => {
  assert.equal(await mergeRemoteLockState(released), true);
  assert.equal((await getLockState()).partnerArmGeneration, null);
  assert.equal((await getLockStatus(now)).settingsLocked, false);
  assert.equal(storage.get('lockState').partnerArmGeneration, null);
  assert.equal(storage.get('partnerArmState')?.generation, null);
});

console.log(`\n${passed} passed, 0 failed`);
