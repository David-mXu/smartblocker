// Unit tests for daemon-observed extension-loss grace display math.
// Node >=22.6 imports the erasable-syntax-only TS module directly.
//
//   node scripts/grace-math-test.mjs
import assert from 'node:assert/strict';
import {
  deriveExtensionGrace,
  extensionGraceDisplaySeconds,
  extensionGraceText,
} from '../src/shared/grace-math.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const T0 = 1_800_000_000_000;
const connected = (heartbeat = T0, observedAtMs = T0) => ({
  state: 'connected',
  observedAtMs,
  lastHeartbeatAtMs: heartbeat,
  graceRemainingMs: null,
});
const grace = (remainingMs = 60_000, observedAtMs = T0, lastHeartbeatAtMs = T0 - 45_000) => ({
  state: 'grace',
  observedAtMs,
  lastHeartbeatAtMs,
  graceRemainingMs: remainingMs,
});

console.log('extension grace-math tests');

test('connected with a daemon-observed heartbeat has no countdown', () => {
  assert.deepEqual(deriveExtensionGrace(T0 + 1000, connected(), 60), {
    state: 'connected',
    remainingMs: null,
  });
});

test('losing heartbeat becomes grace only from an explicit grace status', () => {
  assert.equal(deriveExtensionGrace(T0, connected(), 60).state, 'connected');
  const lost = deriveExtensionGrace(T0, grace(), 60);
  assert.deepEqual(lost, { state: 'grace', remainingMs: 60_000 });
});

test('before the deadline: remaining decreases by elapsed time', () => {
  assert.deepEqual(deriveExtensionGrace(T0 + 30_000, grace(), 60), {
    state: 'grace',
    remainingMs: 30_000,
  });
});

test('at the deadline: state expires at exactly zero', () => {
  assert.deepEqual(deriveExtensionGrace(T0 + 60_000, grace(), 60), {
    state: 'expired',
    remainingMs: 0,
  });
});

test('after the deadline: remaining stays clamped to zero', () => {
  assert.deepEqual(deriveExtensionGrace(T0 + 90_000, grace(), 60), {
    state: 'expired',
    remainingMs: 0,
  });
});

test('recovery with fresh connected status clears the countdown', () => {
  const result = deriveExtensionGrace(T0 + 10_000, connected(T0 + 9000, T0 + 10_000), 60);
  assert.deepEqual(result, { state: 'connected', remainingMs: null });
});

test('an old heartbeat inside grace status does not fabricate a deadline', () => {
  // Only the enforcer's explicit grace observation and relative remainder are
  // used; the last-heartbeat field is documentary while grace is active.
  assert.deepEqual(deriveExtensionGrace(T0 + 1000, grace(50_000), 60), {
    state: 'grace',
    remainingMs: 49_000,
  });
});

test('unknown when status is unavailable', () => {
  assert.deepEqual(deriveExtensionGrace(T0, null, 60), {
    state: 'unknown',
    remainingMs: null,
  });
});

test('unknown when grace duration is unavailable', () => {
  for (const seconds of [null, 0, -1, NaN, Infinity]) {
    assert.deepEqual(deriveExtensionGrace(T0, grace(), seconds), {
      state: 'unknown',
      remainingMs: null,
    });
  }
});

test('explicit connected authority needs no wall-clock heartbeat timestamp', () => {
  assert.deepEqual(deriveExtensionGrace(T0, connected(null), 60), {
    state: 'connected',
    remainingMs: null,
  });
});

test('unknown when grace status lacks daemon remaining time', () => {
  assert.deepEqual(deriveExtensionGrace(T0, grace(null), 60), {
    state: 'unknown',
    remainingMs: null,
  });
});

test('unknown for invalid clocks and oversized grace instead of NaN/Infinity', () => {
  assert.equal(deriveExtensionGrace(NaN, grace(), 60).state, 'unknown');
  assert.equal(deriveExtensionGrace(Infinity, grace(), 60).state, 'unknown');
  assert.equal(deriveExtensionGrace(T0, grace(NaN), 60).state, 'unknown');
  assert.equal(deriveExtensionGrace(T0, grace(Infinity), 60).state, 'unknown');
  assert.equal(deriveExtensionGrace(T0, grace(), Number.MAX_VALUE).state, 'unknown');
});

test('backward clock jump clamps elapsed time to zero', () => {
  assert.deepEqual(deriveExtensionGrace(T0 - 120_000, grace(42_000), 60), {
    state: 'grace',
    remainingMs: 42_000,
  });
});

test('initial daemon remainder cannot exceed the grace cap', () => {
  assert.deepEqual(deriveExtensionGrace(T0, grace(120_000), 60), {
    state: 'grace',
    remainingMs: 60_000,
  });
});

test('negative daemon remainder clamps to expired zero', () => {
  assert.deepEqual(deriveExtensionGrace(T0, grace(-100), 60), {
    state: 'expired',
    remainingMs: 0,
  });
});

test('extreme forward clocks expire without infinite output', () => {
  assert.deepEqual(deriveExtensionGrace(Number.MAX_VALUE, grace(), 60), {
    state: 'expired',
    remainingMs: 0,
  });
});

test('one-second display cadence decrements exactly and never goes negative', () => {
  const observed = [];
  for (let elapsed = 0; elapsed <= 61_000; elapsed += 1000) {
    const result = deriveExtensionGrace(T0 + elapsed, grace(), 60);
    observed.push(extensionGraceDisplaySeconds(result.remainingMs));
  }
  assert.deepEqual(observed, Array.from({ length: 62 }, (_, i) => Math.max(0, 60 - i)));
  for (let i = 1; i < observed.length; i++) assert.ok(observed[i] <= observed[i - 1]);
  assert.ok(observed.every(Number.isFinite));
});

test('whole-second epsilon does not round an exact second upward', () => {
  assert.equal(extensionGraceDisplaySeconds(60_000), 60);
  assert.equal(extensionGraceDisplaySeconds(59_000), 59);
  assert.equal(extensionGraceDisplaySeconds(1000), 1);
  assert.equal(extensionGraceDisplaySeconds(1), 1);
  assert.equal(extensionGraceDisplaySeconds(0), 0);
  assert.equal(extensionGraceDisplaySeconds(-1), 0);
  assert.equal(extensionGraceDisplaySeconds(NaN), null);
  assert.equal(extensionGraceDisplaySeconds(Infinity), null);
  assert.equal(extensionGraceDisplaySeconds(null), null);
});

test('fractional remainders round up to a truthful whole second, never negative', () => {
  assert.equal(extensionGraceDisplaySeconds(59_500), 60);
  assert.equal(extensionGraceDisplaySeconds(59_499), 60);
  assert.equal(extensionGraceDisplaySeconds(58_000), 58);
  assert.equal(extensionGraceDisplaySeconds(999), 1);
});

test('requested grace wording contains the truthful remaining seconds', () => {
  const result = deriveExtensionGrace(T0 + 30_000, grace(), 60);
  assert.equal(extensionGraceText(result), 'Extension lost: browser may close in 30s unless it returns.');
});

test('unknown wording explicitly declines an authoritative countdown', () => {
  assert.match(extensionGraceText({ state: 'unknown', remainingMs: null }), /remaining time is unavailable/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
