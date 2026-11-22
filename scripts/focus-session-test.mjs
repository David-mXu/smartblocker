// Harness for the deferred "Focus session" commit (src/shared/focus-session.ts)
// — the 60-second undo window that ends by writing an irreversible Frozen
// Turkey lock. This was the highest-risk untested path in the 2026-11-21 audit.
//
// chrome.storage/alarms are mocked before importing the module graph.
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
        const changes = {};
        for (const k of keys) {
          if (!storage.has(k)) continue;
          changes[k] = { oldValue: storage.get(k), newValue: undefined };
          storage.delete(k);
        }
        if (Object.keys(changes).length) emit(changes);
      },
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  alarms: {
    async create(name, info) { alarms.set(name, structuredClone(info)); },
    async clear(name) { alarms.delete(name); return true; },
    onAlarm: { addListener(fn) { alarmListeners.push(fn); } },
  },
  runtime: {},
};

const {
  FOCUS_COMMIT_ALARM,
  FOCUS_UNDO_MS,
  startFocusSession,
  getPendingFocusSession,
  undoFocusSession,
  commitFocusSessionIfDue,
  initFocusSessionCommitter,
} = await import('../src/shared/focus-session.ts');

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
  alarms.clear();
  for (const fn of listeners) fn({ lockState: { newValue: undefined }, pendingFocusSession: { newValue: undefined } }, 'local');
};
const frozenUntil = () => storage.get('lockState')?.frozenUntil ?? null;
const REAL_NOW = Date.now;

console.log('focus-session deferred-commit tests');

await test('start defers: pending record + one-shot alarm, NO lockState yet', async () => {
  reset();
  const now = Date.now();
  const pending = await startFocusSession(30 * 60_000, now);
  assert.equal(pending.commitAt, now + FOCUS_UNDO_MS);
  assert.equal(pending.until, now + 30 * 60_000);
  assert.deepEqual(storage.get('pendingFocusSession'), pending);
  assert.equal(frozenUntil(), null, 'nothing may be written to the lock before commit');
  assert.equal(alarms.get(FOCUS_COMMIT_ALARM).when, pending.commitAt);
});

await test('undo inside the window cancels the pending record and alarm', async () => {
  reset();
  await startFocusSession(30 * 60_000, Date.now());
  assert.equal(await undoFocusSession(), true);
  assert.equal(await getPendingFocusSession(), null);
  assert.equal(alarms.has(FOCUS_COMMIT_ALARM), false);
  assert.equal(frozenUntil(), null);
});

await test('commit before the deadline is a no-op', async () => {
  reset();
  const now = Date.now();
  await startFocusSession(30 * 60_000, now);
  assert.equal(await commitFocusSessionIfDue(now + FOCUS_UNDO_MS - 1), false);
  assert.notEqual(await getPendingFocusSession(), null);
  assert.equal(frozenUntil(), null);
});

await test('commit after the deadline writes the fixed end time; concurrent commits converge', async () => {
  reset();
  const durationMs = 30 * 60_000;
  const now = Date.now();
  await startFocusSession(durationMs, now);
  const commitAt = now + FOCUS_UNDO_MS + 1;
  const expectedEnd = now + durationMs;
  // Advance the WALL clock too: the commit derives the remaining duration
  // from the supplied `now`, then startFrozenTurkey anchors it to Date.now().
  Date.now = () => commitAt;
  let results;
  try {
    // Two surfaces notice the due session at the same instant (alarm + popup
    // reopen). Both read the pending record before either removes it, so this
    // actually exercises the extend-only converger rather than the missing-
    // pending guard.
    results = await Promise.all([commitFocusSessionIfDue(commitAt), commitFocusSessionIfDue(commitAt)]);
  } finally {
    Date.now = REAL_NOW;
  }
  assert.ok(results.some(Boolean), 'at least one committer must report the commit');
  assert.equal(await getPendingFocusSession(), null);
  const end = frozenUntil();
  assert.ok(
    Math.abs(end - expectedEnd) < 3_000,
    `frozen end should stay at click+duration (got delta ${end - expectedEnd}ms)`,
  );
  // A later re-commit has nothing pending and must not move the end.
  assert.equal(await commitFocusSessionIfDue(commitAt + 2), false);
  assert.equal(frozenUntil(), end);
});

await test('a session whose end already passed still commits (clears pending, no lock)', async () => {
  reset();
  const now = Date.now();
  await startFocusSession(10_000, now); // shorter than the undo window
  assert.equal(await commitFocusSessionIfDue(now + FOCUS_UNDO_MS + 1), true);
  assert.equal(await getPendingFocusSession(), null);
  assert.equal(frozenUntil(), null);
});

await test('undo after commit returns false', async () => {
  reset();
  const now = Date.now();
  await startFocusSession(30 * 60_000, now);
  await commitFocusSessionIfDue(now + FOCUS_UNDO_MS + 1);
  assert.equal(await undoFocusSession(), false);
});

await test('the alarm listener commits a due session', async () => {
  reset();
  initFocusSessionCommitter();
  const now = Date.now();
  await startFocusSession(30 * 60_000, now);
  // Pretend the one-shot fired late.
  Date.now = () => now + FOCUS_UNDO_MS + 5;
  try {
    for (const fn of alarmListeners) fn({ name: FOCUS_COMMIT_ALARM });
    // The listener is fire-and-forget; let its awaits settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(frozenUntil() !== null, true);
  } finally {
    Date.now = REAL_NOW;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
