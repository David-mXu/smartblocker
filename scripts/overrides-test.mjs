// Pure-ish tests for the SW override store (src/shared/overrides.ts).
//
// The module binds `api` from shared/api.ts at import time, so install a
// minimal chrome.storage mock on globalThis BEFORE the dynamic import (the
// usage-stats-test pattern). No browser is involved.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// shared/ modules use bundler-style extensionless relative imports; resolve
// them to the .ts source under Node type stripping (same shim as backup-test).
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
  addOverride,
  isOverridden,
  normalizeOverrideTitle,
} = await import('../src/shared/overrides.ts');

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
  // The module keeps an in-memory cache; emit the real invalidation signal
  // instead of dropping the listeners the module registered at import time.
  for (const fn of listeners) fn({ overrides: { newValue: undefined } }, 'local');
};

console.log('override store tests');

await test('normalization strips invisible chars, folds compatibility, caps at 300', () => {
  assert.equal(normalizeOverrideTitle('  React​ Router\tTutorial  '), 'React Router Tutorial');
  assert.equal(normalizeOverrideTitle('Ｒｅａｃｔ Router'), 'React Router');
  const long = normalizeOverrideTitle('x'.repeat(1000));
  assert.equal(long.length, 300);
});

await test('scoped entries only apply on their own host (www-insensitive)', async () => {
  reset();
  await addOverride('Elden Ring Boss Fight', 'www.youtube.com');
  assert.equal(await isOverridden('Elden Ring Boss Fight', 'youtube.com'), true);
  assert.equal(await isOverridden('elden ring boss fight', 'm.youtube.com'), false);
  assert.equal(await isOverridden('Elden Ring Boss Fight', 'example.com'), false);
});

await test('legacy host-less entries still apply on every host', async () => {
  reset();
  storage.set('overrides', [{ title: 'Legacy Pass', ts: 1 }]);
  assert.equal(await isOverridden('Legacy Pass', 'anything.example'), true);
  assert.equal(await isOverridden('Legacy Pass'), true);
});

await test('a query with no hostname keeps the historical title-only behaviour', async () => {
  reset();
  await addOverride('Some Page', 'docs.example');
  assert.equal(await isOverridden('Some Page'), true);
});

await test('same (host, title) refreshes in place instead of duplicating', async () => {
  reset();
  await addOverride('Dup Page', 'a.example');
  const first = structuredClone(storage.get('overrides'));
  await new Promise((r) => setTimeout(r, 5));
  await addOverride('Dup  Page', 'A.EXAMPLE');
  const list = storage.get('overrides');
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Dup Page');
  assert.ok(list[0].ts >= first[0].ts);
});

await test('the same title on a different host is a separate scope', async () => {
  reset();
  await addOverride('Shared Title', 'a.example');
  await addOverride('Shared Title', 'b.example');
  assert.equal(storage.get('overrides').length, 2);
});

await test('concurrent adds are serialized (no lost append)', async () => {
  reset();
  await Promise.all(Array.from({ length: 10 }, (_, i) => addOverride(`Concurrent ${i}`, 'c.example')));
  assert.equal(storage.get('overrides').length, 10);
  assert.equal(await isOverridden('Concurrent 4', 'c.example'), true);
});

await test('the list is bounded to 1000, oldest dropped first', async () => {
  reset();
  await Promise.all(Array.from({ length: 1005 }, (_, i) => addOverride(`Bulk ${i}`, 'b.example')));
  const list = storage.get('overrides');
  assert.equal(list.length, 1000);
  assert.equal(await isOverridden('Bulk 0', 'b.example'), false);
  assert.equal(await isOverridden('Bulk 1004', 'b.example'), true);
});

await test('empty/whitespace titles are ignored', async () => {
  reset();
  await addOverride('   ', 'a.example');
  assert.equal(storage.has('overrides'), false);
});

await test('a failed write rejects and does not poison the cache', async () => {
  reset();
  await addOverride('Persisted', 'a.example');
  failWrites = true;
  await assert.rejects(() => addOverride('Dropped', 'a.example'));
  failWrites = false;
  // The in-context cache was invalidated on failure; the next read must see
  // storage's truth (only the first entry).
  assert.equal(await isOverridden('Dropped', 'a.example'), false);
  assert.equal(await isOverridden('Persisted', 'a.example'), true);
});

await test('an external storage write invalidates the cache', async () => {
  reset();
  await addOverride('Mine', 'a.example');
  storage.set('overrides', [...storage.get('overrides'), { title: 'External', host: 'a.example', ts: 2 }]);
  for (const fn of listeners) fn({ overrides: { newValue: storage.get('overrides') } }, 'local');
  assert.equal(await isOverridden('External', 'a.example'), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
