// Tests for the opt-in feedback uploader (src/background/feedback-uploader.ts)
// — the only code path that sends user corrections off the device. `fetch` is
// mocked, so nothing leaves this process; chrome.storage/alarms are mocked
// before importing the module graph.
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
const alarms = new Map();
const alarmListeners = [];

function emit(changes) {
  queueMicrotask(() => {
    for (const fn of listeners) fn(changes, 'local');
  });
}
function notifyKeys(keys) {
  const changes = {};
  for (const key of keys) changes[key] = { newValue: storage.get(key) };
  emit(changes);
}

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
        const keys = typeof key === 'string' ? [key] : key;
        for (const k of keys) storage.delete(k);
      },
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  alarms: {
    async create(name, info) { alarms.set(name, structuredClone(info)); },
    async clear(name) { alarms.delete(name); return true; },
    onAlarm: { addListener(fn) { alarmListeners.push(fn); } },
  },
  runtime: {
    getManifest() { return { version: '9.9.9' }; },
    sendMessage: async () => ({ ok: false }),
    lastError: undefined,
  },
};

let fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200 });
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
};

const { initFeedbackUploader } = await import('../src/background/feedback-uploader.ts');

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
async function waitFor(predicate, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return Boolean(await predicate());
}
let tsCounter = 100;
const record = (over = {}) => ({
  kind: 'false_positive',
  title: `Test page ${tsCounter}`,
  domain: 'example.com',
  modelLabel: 'video games',
  score: 0.9,
  modelId: 'test-model',
  extVersion: '1.0.0',
  ts: tsCounter++,
  ...over,
});

function reset({ enabled = true, records = [], keepInstallId = true } = {}) {
  // installId survives a normal reset (it only rotates when extension storage
  // is cleared, i.e. a reinstall); preserve it unless a test opts out.
  const installId = keepInstallId ? storage.get('installId') : undefined;
  storage.clear();
  if (installId) storage.set('installId', installId);
  alarms.clear();
  fetchCalls = [];
  fetchImpl = async () => ({ ok: true, status: 200 });
  storage.set('settings', { shareFeedback: enabled });
  storage.set('feedback', records);
  notifyKeys(['settings', 'feedback']);
}

function triggerUpload() {
  assert.ok(alarmListeners.length > 0, 'initFeedbackUploader must register the alarm');
  for (const fn of alarmListeners) fn({ name: 'feedback-upload' });
}
const uploaded = () => (storage.get('feedback') ?? []).filter((r) => r.uploaded);
const skipped = () => (storage.get('feedback') ?? []).filter((r) => r.skipped);

initFeedbackUploader();

console.log('feedback uploader tests');

await test('registers the daily alarm and sends nothing while the toggle is off', async () => {
  // Check registration BEFORE reset() clears the mocked alarm map. Never call
  // initFeedbackUploader again: each call adds another listener, which would
  // make every later trigger upload the same batch twice.
  assert.equal(alarms.get('feedback-upload')?.periodInMinutes, 24 * 60);
  assert.equal(alarmListeners.length, 1);
  reset({ enabled: false, records: [record()] });
  triggerUpload();
  await sleep(50);
  assert.equal(fetchCalls.length, 0);
  assert.equal(uploaded().length, 0);
});

await test('an enabled upload posts the batch, strips local bookkeeping, and marks uploaded', async () => {
  const a = record({ title: 'First' });
  const b = record({ kind: 'false_negative', title: 'Second', correctedLabel: 'video games' });
  reset({ records: [a, b] });
  triggerUpload();
  assert.ok(await waitFor(() => fetchCalls.length === 1), 'expected exactly one POST');
  const call = fetchCalls[0];
  assert.match(call.url, /\/v1\/feedback$/);
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body);
  assert.equal(body.extVersion, '9.9.9');
  assert.match(body.installId, /^[0-9a-f-]{36}$/i);
  assert.equal(body.records.length, 2);
  for (const sent of body.records) {
    assert.equal('uploaded' in sent, false);
    assert.equal('skipped' in sent, false);
  }
  assert.ok(await waitFor(() => uploaded().length === 2), 'records must be marked uploaded');
  assert.equal(uploaded().length, 2);
});

await test('the install id is minted once and reused across uploads', async () => {
  reset({ records: [record()] });
  triggerUpload();
  await waitFor(() => fetchCalls.length === 1);
  const first = JSON.parse(fetchCalls[0].init.body).installId;
  // Let the first upload finish marking before resetting the mocked storage;
  // otherwise its in-flight markUploaded can write the old array back over the
  // new fixture (a test artifact, not product behavior).
  await waitFor(() => uploaded().length >= 1);
  reset({ records: [record({ ts: 9_001 })] }); // clears fetchCalls too
  triggerUpload();
  assert.ok(await waitFor(() => fetchCalls.length === 1), 'expected the second upload');
  const second = JSON.parse(fetchCalls[0].init.body).installId;
  assert.equal(second, first);
});

await test('a failed POST leaves records unsent for the next alarm', async () => {
  reset({ records: [record()] });
  fetchImpl = async () => ({ ok: false, status: 503 });
  triggerUpload();
  await waitFor(() => fetchCalls.length === 1);
  await sleep(50);
  assert.equal(uploaded().length, 0);
  assert.equal(skipped().length, 0);
  // Next day, healthy server: the same record goes out.
  fetchImpl = async () => ({ ok: true, status: 200 });
  triggerUpload();
  await waitFor(() => fetchCalls.length === 2);
  assert.ok(await waitFor(() => uploaded().length === 1));
});

await test('records outside the worker wire caps are skipped once, not retried forever', async () => {
  const ok = record({ title: 'Sendable' });
  const bad = record({ title: 'x'.repeat(1000), ts: 9_100 });
  reset({ records: [ok, bad] });
  triggerUpload();
  await waitFor(() => fetchCalls.length === 1);
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(body.records.map((r) => r.title), ['Sendable']);
  assert.ok(await waitFor(() => skipped().length === 1));
  assert.equal(skipped()[0].ts, 9_100);
  // A second alarm has nothing sendable left, so it makes NO request at all.
  const before = fetchCalls.length;
  triggerUpload();
  await sleep(80);
  assert.equal(fetchCalls.length, before, 'no POST when nothing is sendable');
  assert.equal(skipped().length, 1);
});

await test('at most 100 records are uploaded per alarm; the rest follow later', async () => {
  reset({ records: Array.from({ length: 150 }, () => record()) });
  triggerUpload();
  await waitFor(() => fetchCalls.length === 1);
  assert.equal(JSON.parse(fetchCalls[0].init.body).records.length, 100);
  assert.ok(await waitFor(() => uploaded().length === 100));
  triggerUpload();
  await waitFor(() => fetchCalls.length === 2);
  assert.equal(JSON.parse(fetchCalls[1].init.body).records.length, 50);
  assert.ok(await waitFor(() => uploaded().length === 150));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
