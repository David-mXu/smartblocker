// Tests for the feedback store + on-device learning fold
// (src/shared/feedback.ts). Installs a chrome.storage mock before importing
// the module (api.ts binds at import time).
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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
});

const storage = new Map();
const listeners = [];
let failWrites = false;
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') {
          return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
        }
        const out = {};
        for (const k of key) if (storage.has(k)) out[k] = structuredClone(storage.get(k));
        return out;
      },
      async set(values) {
        if (failWrites) throw new Error('quota');
        const changes = {};
        for (const [k, v] of Object.entries(values)) {
          changes[k] = { oldValue: storage.get(k), newValue: structuredClone(v) };
          storage.set(k, structuredClone(v));
        }
        queueMicrotask(() => {
          for (const fn of listeners) fn(changes, 'local');
        });
      },
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  runtime: {},
};

const {
  addFeedback,
  getFeedback,
  clearFeedback,
  markUploaded,
  markSkipped,
  getPrototypeExamples,
} = await import('../src/shared/feedback.ts');
const { NEUTRAL_PREFIX } = await import('../src/shared/prototypes.ts');

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
const reset = () => {
  storage.clear();
  failWrites = false;
  for (const fn of listeners) fn({ feedback: { newValue: undefined } }, 'local');
};
let tsCounter = 1;
const record = (over = {}) => ({
  kind: 'false_positive',
  title: `Title ${tsCounter}`,
  domain: 'example.com',
  modelLabel: 'video games',
  score: 0.9,
  modelId: 'test-model',
  extVersion: '1.0.0',
  ts: tsCounter++,
  ...over,
});

console.log('feedback store tests');

await test('appends records and reads them back', async () => {
  reset();
  await addFeedback(record({ title: 'A' }));
  await addFeedback(record({ title: 'B' }));
  assert.deepEqual((await getFeedback()).map((r) => r.title), ['A', 'B']);
});

await test('text fields are capped (title 300, channel/context 500, domain 253)', async () => {
  reset();
  await addFeedback(
    record({
      title: 't'.repeat(1000),
      channel: 'c'.repeat(1000),
      context: 'x'.repeat(1000),
      domain: 'd'.repeat(1000),
    }),
  );
  const [r] = await getFeedback();
  assert.equal(r.title.length, 300);
  assert.equal(r.channel.length, 500);
  assert.equal(r.context.length, 500);
  assert.equal(r.domain.length, 253);
});

await test('the store is bounded to 500, oldest dropped first', async () => {
  reset();
  for (let i = 0; i < 505; i++) await addFeedback(record({ title: `T${i}` }));
  const all = await getFeedback();
  assert.equal(all.length, 500);
  assert.equal(all[0].title, 'T5');
  assert.equal(all[all.length - 1].title, 'T504');
});

await test('concurrent appends are serialized (no lost record)', async () => {
  reset();
  await Promise.all(Array.from({ length: 12 }, (_, i) => addFeedback(record({ title: `C${i}` }))));
  assert.equal((await getFeedback()).length, 12);
});

await test('markUploaded / markSkipped target exact ts identities', async () => {
  reset();
  await addFeedback(record({ title: 'one', ts: 11 }));
  await addFeedback(record({ title: 'two', ts: 22 }));
  await markUploaded([11]);
  await markSkipped([22]);
  const byTitle = Object.fromEntries((await getFeedback()).map((r) => [r.title, r]));
  assert.equal(byTitle.one.uploaded, true);
  assert.equal(byTitle.one.skipped, undefined);
  assert.equal(byTitle.two.skipped, true);
  assert.equal(byTitle.two.uploaded, undefined);
});

await test('clearFeedback empties the store', async () => {
  reset();
  await addFeedback(record());
  await clearFeedback();
  assert.deepEqual(await getFeedback(), []);
});

await test('a failed write rejects and invalidates the cache', async () => {
  reset();
  await addFeedback(record({ title: 'kept', ts: 5 }));
  failWrites = true;
  await assert.rejects(() => addFeedback(record({ title: 'dropped', ts: 6 })));
  failWrites = false;
  // Re-read from storage: only the persisted record remains.
  assert.deepEqual((await getFeedback()).map((r) => r.title), ['kept']);
});

await test('learning fold: FP → user-approved neutral, FN → corrected label, newest 24 kept', async () => {
  reset();
  // 30 false positives across 30 distinct titles.
  for (let i = 0; i < 30; i++) {
    await addFeedback(record({ kind: 'false_positive', title: `Approved ${i}`, ts: 100 + i }));
  }
  await addFeedback(
    record({ kind: 'false_negative', title: 'Sneaky Game', correctedLabel: 'video games', ts: 200 }),
  );
  await addFeedback(record({ kind: 'false_negative', title: 'No Label', ts: 201 }));
  const examples = await getPrototypeExamples();
  const approved = examples[`${NEUTRAL_PREFIX}user approved`];
  assert.equal(approved.length, 24, 'only the newest 24 corrections feed one centroid');
  assert.ok(approved[approved.length - 1].includes('Approved 29'));
  assert.ok(!approved.some((t) => t.includes('Approved 0')));
  assert.deepEqual(examples['video games'], ['Sneaky Game']);
  assert.equal(examples['undefined'], undefined, 'a false negative without a label is ignored');
});

await test('learning fold skips records with no usable classifier text', async () => {
  reset();
  await addFeedback(
    record({ kind: 'false_positive', title: '', channel: '', context: '', domain: '' }),
  );
  const examples = await getPrototypeExamples();
  assert.deepEqual(examples, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
