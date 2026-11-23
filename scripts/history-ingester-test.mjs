// Tests for the on-demand history scan (src/background/history-ingester.ts).
// The classifier is module-mocked (it would otherwise pull in transformers)
// and chrome.history/storage are mocked, so this runs in plain Node.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const CLASSIFIER_STUB = '__sbHistoryClassifierStub';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/background/classifier.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function classify(input) { return globalThis.${CLASSIFIER_STUB}(input); }`,
      };
    }
    return nextLoad(url, context);
  },
});

const storage = new Map();
const listeners = [];
function emit(changes) {
  queueMicrotask(() => {
    for (const fn of listeners) fn(changes, 'local');
  });
}
const historyItems = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        const keys = typeof key === 'string' ? [key] : key;
        const out = {};
        for (const k of keys) if (storage.has(k)) out[k] = structuredClone(storage.get(k));
        return out;
      },
      async set(values) {
        const changes = {};
        for (const [k, v] of Object.entries(values)) {
          changes[k] = { oldValue: storage.get(k), newValue: structuredClone(v) };
          storage.set(k, structuredClone(v));
        }
        emit(changes);
      },
      async remove(key) {
        for (const k of typeof key === 'string' ? [key] : key) storage.delete(k);
      },
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  history: {
    async search() {
      return structuredClone(historyItems);
    },
  },
  runtime: {},
};

let classifyCalls = [];
globalThis[CLASSIFIER_STUB] = async (input) => {
  classifyCalls.push(input);
  if (input.title === 'Slow page') await new Promise((r) => setTimeout(r, globalThis.__slowMs ?? 120));
  if (input.title.includes('game')) return { label: 'video games', score: 0.93, all: null };
  return { label: 'programming and software development', score: 0.81, all: null };
};

const { HISTORY_CAP } = await import('../src/shared/config.ts');
const { scanHistory, healStaleHistoryScan } = await import(
  '../src/background/history-ingester.ts'
);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scanState = () => storage.get('historyScan');

function reset({ whitelist = ['docs.example'], blocklist = [], history = [] } = {}) {
  storage.clear();
  classifyCalls = [];
  historyItems.length = 0;
  historyItems.push(...history);
  storage.set('settings', { whitelist, blocklist });
  emit({ settings: { newValue: storage.get('settings') } });
}

console.log('history ingester tests');

await test('filters to classifiable, non-whitelisted, de-duplicated entries', async () => {
  reset({
    history: [
      { url: 'https://games.example/play', title: 'Funny game compilation', lastVisitTime: 1 },
      { url: 'https://games.example/play', title: 'Funny game compilation', lastVisitTime: 1 },
      { url: 'https://docs.example/guide', title: 'React Router Tutorial', lastVisitTime: 1 },
      { url: 'chrome://settings', title: 'Settings', lastVisitTime: 1 },
      { url: 'https://learn.example/notes', title: 'React Router Tutorial', lastVisitTime: 1 },
      { url: 'https://learn.example/empty', title: '   ', lastVisitTime: 1 },
    ],
  });
  await scanHistory();
  const state = scanState();
  assert.equal(state.status, 'done');
  assert.equal(state.historyCount, 6, 'historyCount reports what the browser returned');
  assert.equal(state.total, 2, 'duplicate title collapses; whitelist/non-http/empty skipped');
  assert.deepEqual(state.items.map((i) => i.title), ['Funny game compilation', 'React Router Tutorial']);
  assert.equal(state.categoryCounts['video games'], 1);
  assert.equal(state.categoryCounts['programming and software development'], 1);
});

await test('a blocklist hit is counted without spending an inference', async () => {
  reset({
    blocklist: ['blocked-title'],
    history: [
      { url: 'https://a.example/blocked', title: 'A blocked-title page', lastVisitTime: 1 },
      { url: 'https://b.example/ok', title: 'Ordinary page', lastVisitTime: 1 },
    ],
  });
  await scanHistory();
  const state = scanState();
  assert.equal(classifyCalls.length, 1, 'only the non-rule page is classified');
  assert.equal(state.categoryCounts['blocked rule: "blocked-title"'], 1);
  assert.equal(state.status, 'done');
});

await test('caps the number of classified targets at HISTORY_CAP', async () => {
  reset({
    history: Array.from({ length: HISTORY_CAP + 10 }, (_, i) => ({
      url: `https://site${i}.example/page`,
      title: `Distinct page ${i}`,
      lastVisitTime: 1,
    })),
  });
  await scanHistory();
  const state = scanState();
  assert.equal(state.total, HISTORY_CAP);
  assert.equal(state.items.length, HISTORY_CAP);
  assert.equal(classifyCalls.length, HISTORY_CAP);
});

await test('a classifier failure marks the scan errored and releases the running flag', async () => {
  reset({ history: [{ url: 'https://a.example/x', title: 'Boom page', lastVisitTime: 1 }] });
  globalThis[CLASSIFIER_STUB] = async () => {
    throw new Error('model exploded');
  };
  try {
    await scanHistory();
  } finally {
    globalThis[CLASSIFIER_STUB] = async (input) => {
      classifyCalls.push(input);
      if (input.title === 'Slow page') {
        await new Promise((r) => setTimeout(r, globalThis.__slowMs ?? 120));
      }
      return input.title.includes('game')
        ? { label: 'video games', score: 0.93, all: null }
        : { label: 'programming and software development', score: 0.81, all: null };
    };
  }
  const state = scanState();
  assert.equal(state.status, 'error');
  assert.match(String(state.error), /model exploded/);
});

await test('a stale "running" record from a dead worker is healed to an error', async () => {
  reset();
  storage.set('historyScan', {
    status: 'running',
    done: 3,
    total: 10,
    historyCount: 40,
    items: [],
    categoryCounts: {},
    elapsedMs: 5,
  });
  storage.set('historyScanStartedAt', Date.now() - 30_000);
  await healStaleHistoryScan();
  const healed = scanState();
  assert.equal(healed.status, 'error');
  assert.match(String(healed.error), /Interrupted/);
  assert.equal(healed.done, 3, 'progress is preserved in the healed record');
});

await test('heal leaves a finished record alone', async () => {
  reset();
  const done = {
    status: 'done',
    done: 2,
    total: 2,
    historyCount: 2,
    items: [],
    categoryCounts: {},
    elapsedMs: 9,
  };
  storage.set('historyScan', done);
  await healStaleHistoryScan();
  assert.deepEqual(scanState(), done);
});

await test('heal does not disturb a LIVE scan', async () => {
  reset({ history: [{ url: 'https://slow.example/x', title: 'Slow page', lastVisitTime: 1 }] });
  globalThis.__slowMs = 400;
  try {
    const scanning = scanHistory();
    // Give the scan a moment to set status=running, then ask the healer while
    // the classification is still in flight.
    await sleep(60);
    assert.equal(scanState().status, 'running', 'precondition: scan is live');
    await healStaleHistoryScan();
    assert.equal(scanState().status, 'running', 'a live scan must not be marked interrupted');
    await scanning;
    assert.equal(scanState().status, 'done');
  } finally {
    globalThis.__slowMs = undefined;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
