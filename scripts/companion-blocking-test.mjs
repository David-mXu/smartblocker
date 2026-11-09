// Focused daemon-owned ordinary-blocking synchronization policy tests.
// Runs directly under Node >=22.15 type stripping; no browser or test runner.
//
//   node scripts/companion-blocking-test.mjs
import assert from 'node:assert/strict';
import {
  BlockingIntentLedger,
  blockingBaseRevision,
  parseCompanionBlockingState,
  sameBlockingAuthority,
  shouldAcceptBlockingAuthority,
  shouldSendBlockingIntent,
} from '../src/shared/companion-blocking.ts';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${error.stack ?? error.message}`);
  }
}

console.log('companion ordinary-blocking synchronization tests');

await test('authority parsing accepts only bounded boolean/revision pairs', () => {
  assert.deepEqual(parseCompanionBlockingState({ enabled: false, revision: 0 }), {
    enabled: false,
    revision: 0,
  });
  assert.deepEqual(parseCompanionBlockingState({ enabled: true, revision: Number.MAX_SAFE_INTEGER }), {
    enabled: true,
    revision: Number.MAX_SAFE_INTEGER,
  });
  for (const value of [
    null,
    undefined,
    true,
    [],
    {},
    { enabled: 'true', revision: 1 },
    { enabled: true, revision: -1 },
    { enabled: true, revision: 1.5 },
    { enabled: true, revision: Number.MAX_SAFE_INTEGER + 1 },
    { enabled: true, revision: Number.NaN },
    { enabled: true, revision: '1' },
  ]) {
    assert.equal(parseCompanionBlockingState(value), null);
  }
});

await test('older or contradictory same-revision authority cannot rewind state', () => {
  const current = { enabled: true, revision: 7 };
  assert.equal(shouldAcceptBlockingAuthority(undefined, current), true);
  assert.equal(shouldAcceptBlockingAuthority(null, current), true);
  assert.equal(shouldAcceptBlockingAuthority(current, { enabled: false, revision: 8 }), true);
  assert.equal(shouldAcceptBlockingAuthority(current, { enabled: true, revision: 7 }), true);
  assert.equal(shouldAcceptBlockingAuthority(current, { enabled: false, revision: 7 }), false);
  assert.equal(shouldAcceptBlockingAuthority(current, { enabled: false, revision: 6 }), false);
});

await test('only observed local differences become outgoing intents', () => {
  assert.equal(shouldSendBlockingIntent(undefined, false), false, 'no live daemon observation');
  assert.equal(shouldSendBlockingIntent(null, true), true, 'initialize a fresh daemon');
  assert.equal(shouldSendBlockingIntent(null, false), true, 'an explicit initial off is meaningful');
  assert.equal(shouldSendBlockingIntent({ enabled: true, revision: 4 }, true), false, 'daemon apply echo');
  assert.equal(shouldSendBlockingIntent({ enabled: true, revision: 4 }, false), true, 'new local disable');
});

await test('async duplicate delivery preserves pending intents but disconnect does not', () => {
  const original = { enabled: false, revision: 11 };
  assert.equal(sameBlockingAuthority(original, { ...original }), true);
  assert.equal(sameBlockingAuthority(original, { enabled: true, revision: 11 }), false);
  assert.equal(sameBlockingAuthority(original, { enabled: false, revision: 12 }), false);
  assert.equal(sameBlockingAuthority(null, null), true);
  assert.equal(sameBlockingAuthority(null, undefined), false);
  assert.equal(sameBlockingAuthority(undefined, undefined), true);
});

await test('base revisions distinguish fresh initialization from observed state', () => {
  assert.equal(blockingBaseRevision(undefined), 0);
  assert.equal(blockingBaseRevision(null), 0);
  assert.equal(blockingBaseRevision({ enabled: true, revision: 19 }), 19);
});

await test('rapid off→on preserves the latest value and rebases exactly once', async () => {
  const ledger = new BlockingIntentLedger();
  const authority = { enabled: true, revision: 7 };
  ledger.noteLocal(false);
  assert.deepEqual(ledger.prepare(authority, false), { enabled: false, baseRevision: 7 });
  assert.equal(ledger.prepare(authority, true), null, 'a second intent cannot race the first');

  const firstReply = Promise.resolve({ enabled: false, revision: 8 });
  ledger.noteLocal(true);
  const resolved = await firstReply;
  assert.deepEqual(ledger.resolve(resolved), {
    resolvedInFlight: true,
    pendingLocalValue: true,
    applyToStorage: false,
  });
  assert.deepEqual(ledger.prepare(resolved, true), { enabled: true, baseRevision: 8 });
  const converged = { enabled: true, revision: 9 };
  assert.deepEqual(ledger.resolve(converged), {
    resolvedInFlight: true,
    pendingLocalValue: null,
    applyToStorage: true,
  });
  assert.equal(ledger.prepare(converged, true), null);
});

await test('rapid on→off cannot be overwritten by the earlier on acknowledgement', async () => {
  let deferredResolve;
  const deferred = new Promise((resolve) => {
    deferredResolve = resolve;
  });
  const ledger = new BlockingIntentLedger();
  ledger.noteLocal(true);
  const sent = ledger.prepare({ enabled: false, revision: 20 }, true);
  assert.deepEqual(sent, { enabled: true, baseRevision: 20 });
  ledger.noteLocal(false);

  async function applyReply() {
    const incoming = await deferred;
    const resolution = ledger.resolve(incoming);
    // This is the actual background contract: a pending newest local value
    // prevents the earlier acknowledgement from reaching extension storage.
    if (resolution.applyToStorage) throw new Error('stale acknowledgement was applied');
    return ledger.prepare(incoming, resolution.pendingLocalValue);
  }
  const pending = applyReply();
  deferredResolve({ enabled: true, revision: 21 });
  assert.deepEqual(await pending, { enabled: false, baseRevision: 21 });
  assert.deepEqual(ledger.resolve({ enabled: false, revision: 22 }), {
    resolvedInFlight: true,
    pendingLocalValue: null,
    applyToStorage: true,
  });
});

await test('failed sends release the slot without fabricating a new revision', () => {
  const ledger = new BlockingIntentLedger();
  const authority = { enabled: true, revision: 4 };
  ledger.noteLocal(false);
  assert.deepEqual(ledger.prepare(authority, false), { enabled: false, baseRevision: 4 });
  ledger.failInFlight();
  assert.deepEqual(ledger.prepare(authority, false), { enabled: false, baseRevision: 4 });
  ledger.reset();
  assert.equal(ledger.hasInFlight, false);
  assert.equal(ledger.pendingLocalValue, null);
});

await test('lock refusal heals the rejected value without an error/sync retry loop', () => {
  const ledger = new BlockingIntentLedger();
  const authority = { enabled: true, revision: 30 };
  ledger.noteLocal(false);
  assert.deepEqual(ledger.prepare(authority, false), { enabled: false, baseRevision: 30 });
  ledger.failInFlight();
  const resolution = ledger.resolve(authority);
  assert.equal(resolution.resolvedInFlight, false);
  assert.equal(resolution.pendingLocalValue, null);
  assert.equal(resolution.applyToStorage, true);
  assert.equal(ledger.prepare(authority, true), null, 'healing produces no new intent');
});

await test('an error drops only the rejected generation, never a newer choice', () => {
  const ledger = new BlockingIntentLedger();
  const original = { enabled: true, revision: 32 };
  ledger.noteLocal(false);
  ledger.prepare(original, false);
  ledger.noteLocal(true);
  ledger.failInFlight();
  assert.equal(ledger.pendingLocalValue, true);
  const external = { enabled: false, revision: 33 };
  const resolution = ledger.resolve(external);
  assert.equal(resolution.applyToStorage, false);
  assert.deepEqual(ledger.prepare(external, resolution.pendingLocalValue), {
    enabled: true,
    baseRevision: 33,
  });
});

console.log(`companion-blocking: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
