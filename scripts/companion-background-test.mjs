// Actual background companion-bridge tests with a controlled Native Messaging
// port and storage. No browser singleton or test runner is required.
//
//   node scripts/companion-background-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS_KEY = '__smartblockerCompanionBackgroundTest';
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
    if (path.endsWith('/src/shared/api.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const api = globalThis.${HARNESS_KEY}.api; export const IS_FIREFOX = false;`,
      };
    }
    if (path.endsWith('/src/shared/settings.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const COMPANION_BLOCKING_ECHO_KEY = 'companionBlockingApplyEcho'; export const getSettings = () => globalThis.${HARNESS_KEY}.getSettings(); export const setCompanionBlockingEnabled = (enabled, echoId) => globalThis.${HARNESS_KEY}.setCompanionBlockingEnabled(enabled, echoId);`,
      };
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const getLockState = async () => ({}); export const getLockStatus = async () => ({ settingsLocked: false, forceBlocking: false }); export const mergeRemoteLockState = (raw) => globalThis.${HARNESS_KEY}.mergeRemoteLockState(raw);`,
      };
    }
    return nextLoad(url, context);
  },
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

class MockPort {
  constructor() {
    this.messages = [];
    this.messageListeners = [];
    this.disconnectListeners = [];
    this.onMessage = { addListener: (fn) => this.messageListeners.push(fn) };
    this.onDisconnect = { addListener: (fn) => this.disconnectListeners.push(fn) };
  }

  postMessage(message) {
    this.messages.push(structuredClone(message));
  }

  disconnect() {
    for (const listener of this.disconnectListeners) listener();
  }

  emit(message) {
    for (const listener of this.messageListeners) listener(message);
  }

  updates() {
    return this.messages.filter((message) => message.type === 'blockingStateUpdate');
  }
}

const ECHO_KEY = 'companionBlockingApplyEcho';
const storageListeners = [];
const alarmListeners = [];
const values = { settings: { enabled: true } };
const pairingRead = deferred();
let authorityWriteHook = null;
let settingsReadHook = null;
let lockMergeHook = null;
let port;
function emitStorage(changes) {
  for (const listener of storageListeners) listener(changes, 'local');
}
async function setStored(next) {
  const changes = {};
  for (const [key, value] of Object.entries(next)) {
    const oldValue = values[key];
    if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
    values[key] = structuredClone(value);
    changes[key] = { oldValue: structuredClone(oldValue), newValue: structuredClone(value) };
  }
  if (Object.keys(changes).length > 0) queueMicrotask(() => emitStorage(changes));
}
const api = {
  storage: {
    local: {
      async get(key) {
        if (key === 'companionPairing') await pairingRead.promise;
        if (typeof key === 'string') return { [key]: values[key] };
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.map((entry) => [entry, values[entry]]));
      },
      set: setStored,
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
  alarms: {
    create: async () => {},
    clear: async () => {},
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
  },
  runtime: {
    id: 'test-extension',
    getManifest: () => ({ version: '0.5.0' }),
    connectNative() {
      const connected = new MockPort();
      port = connected;
      // The daemon's redacted accept greeting precedes pairing/hello. Capture
      // the actual port so a late greeting cannot land on its replacement.
      queueMicrotask(() => connected.emit(statusMessage({ authenticated: false })));
      return connected;
    },
  },
};
globalThis.chrome = api;
globalThis[HARNESS_KEY] = {
  api,
  getSettings: async () =>
    settingsReadHook ? settingsReadHook() : structuredClone(values.settings),
  setCompanionBlockingEnabled: async (enabled, echoId) => {
    if (authorityWriteHook) return authorityWriteHook(enabled, echoId);
    return setStored({
      settings: { ...values.settings, enabled },
      [ECHO_KEY]: echoId,
    });
  },
  mergeRemoteLockState: async (raw) => {
    if (lockMergeHook) return lockMergeHook(raw);
  },
};

function statusMessage({ authenticated, blocking }) {
  return {
    v: 2,
    type: 'companionStatus',
    running: true,
    status: {
      companionVersion: 'test',
      pro: true,
      enforcement: { appBlocking: true, watchdog: true, policyProtected: false },
      lockState: {},
      ...(blocking ? { blocking } : {}),
      ...(authenticated
        ? { extensionLoss: { state: 'connected', graceSeconds: 60, graceRemainingMs: null } }
        : {}),
    },
  };
}

function authorityMessage(enabled, revision) {
  return { v: 2, type: 'blockingStateSync', blocking: { enabled, revision } };
}

async function crashAndReconnect() {
  const previous = port;
  api.runtime.lastError = { message: 'The native messaging host crashed.' };
  for (const listener of previous.disconnectListeners) listener();
  api.runtime.lastError = undefined;
  await flush();
  for (const listener of alarmListeners) listener({ name: 'companion-retry' });
  await flush();
  await flush();
  assert.notEqual(port, previous, 'a replacement Native Messaging port exists');
  return previous;
}

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

console.log('companion background synchronization tests');
const {
  initCompanionBridge,
  setPartnerCommandTimeoutForTest,
  submitPartnerCommand,
} = await import('../src/background/companion.ts?background-test');
initCompanionBridge();
await flush();
assert(port, 'the bridge opened its Native Messaging port');
await flush();

await test('fresh initialization waits through delayed pairing for authenticated hello status', async () => {
  assert.equal(port.messages.some((message) => message.type === 'hello'), false);
  assert.equal(port.updates().length, 0, 'redacted greeting cannot initialize before pairing resolves');
  pairingRead.resolve();
  await flush();
  await flush();
  assert.equal(port.messages.filter((message) => message.type === 'hello').length, 1);
  assert.equal(port.updates().length, 0, 'hello transmission is not yet an authenticated response');

  // Even a late redacted status after hello must not authorize the update.
  port.emit(statusMessage({ authenticated: false }));
  await flush();
  assert.equal(port.updates().length, 0);
  port.emit(statusMessage({ authenticated: true }));
  await flush();
  await flush();
  assert.deepEqual(port.updates(), [
    { v: 2, type: 'blockingStateUpdate', enabled: true, baseRevision: 0 },
  ]);
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: true, revision: 1 } });
  await flush();
  assert.equal(port.updates().length, 1, 'initial authority echo terminates');
});

await test('actual background preserves rapid off→on across a deferred daemon reply', async () => {
  await setStored({ settings: { enabled: false } });
  await setStored({ settings: { enabled: true } });
  await flush();
  await flush();
  assert.deepEqual(port.updates().slice(1), [
    { v: 2, type: 'blockingStateUpdate', enabled: false, baseRevision: 1 },
  ]);

  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: false, revision: 2 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true, 'stale off acknowledgement did not overwrite newer on');
  assert.deepEqual(port.updates().slice(2), [
    { v: 2, type: 'blockingStateUpdate', enabled: true, baseRevision: 2 },
  ]);
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: true, revision: 3 } });
  await flush();
  assert.equal(port.updates().length, 3);
});

await test('actual background preserves rapid on→off and suppresses authority storage echoes', async () => {
  // Establish an unsolicited daemon-off value first; its storage write is an
  // echo and cannot manufacture another intent.
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: false, revision: 4 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, false);
  assert.equal(port.updates().length, 3);

  await setStored({ settings: { enabled: true } });
  await setStored({ settings: { enabled: false } });
  await flush();
  await flush();
  assert.deepEqual(port.updates().slice(3), [
    { v: 2, type: 'blockingStateUpdate', enabled: true, baseRevision: 4 },
  ]);
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: true, revision: 5 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, false, 'stale on acknowledgement did not overwrite newer off');
  assert.deepEqual(port.updates().slice(4), [
    { v: 2, type: 'blockingStateUpdate', enabled: false, baseRevision: 5 },
  ]);
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: false, revision: 6 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, false);
  assert.equal(port.updates().length, 5, 'final authority produces no extra revision churn');
});

await test('lock refusal error plus unchanged authority heals without retrying', async () => {
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: true, revision: 7 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true);
  assert.equal(port.updates().length, 5);

  await setStored({ settings: { enabled: false } });
  await flush();
  await flush();
  assert.deepEqual(port.updates().slice(5), [
    { v: 2, type: 'blockingStateUpdate', enabled: false, baseRevision: 7 },
  ]);
  port.emit({ v: 2, type: 'error', message: 'blocking update refused: a lock is active' });
  port.emit({ v: 2, type: 'blockingStateSync', blocking: { enabled: true, revision: 7 } });
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true);
  assert.equal(port.updates().length, 6, 'refusal does not bounce into another disable');
});

await test('deferred old status cannot cross reconnect and outrank a lower-revision daemon', async () => {
  const oldMerge = deferred();
  lockMergeHook = () => oldMerge.promise;
  port.emit(statusMessage({ authenticated: true, blocking: { enabled: false, revision: 100 } }));

  await crashAndReconnect();
  lockMergeHook = null;
  port.emit(statusMessage({ authenticated: true, blocking: { enabled: true, revision: 1 } }));
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true);
  const updatesBefore = port.updates().length;
  oldMerge.resolve();
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true, 'old revision 100 never displaced restarted revision 1');
  assert.equal(port.updates().length, updatesBefore, 'old status fabricated no intent on the new daemon');
});

await test('old deferred settings write and echo cannot capture a reconnected authority', async () => {
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let oldEchoId;
  authorityWriteHook = (enabled, echoId) => {
    oldEchoId = echoId;
    writeStarted.resolve();
    return releaseWrite.promise.then(() =>
      setStored({ settings: { ...values.settings, enabled }, [ECHO_KEY]: echoId }),
    );
  };
  port.emit(authorityMessage(false, 2));
  await writeStarted.promise;
  authorityWriteHook = null;
  const updatesBefore = port.updates().length;

  await crashAndReconnect();
  port.emit(statusMessage({ authenticated: true, blocking: { enabled: true, revision: 1 } }));
  await flush();
  releaseWrite.resolve();
  await flush();
  await flush();
  await flush();
  assert(oldEchoId, 'the old write had an identity');
  assert.equal(values.settings.enabled, true, 'new authority reasserted after the old write completed');
  assert.equal(
    port.updates().length,
    updatesBefore,
    'retired authority echo was not reported to the new daemon',
  );
});

await test('A→B authority writes stay serialized and a same-value user event cannot resurrect A', async () => {
  const writeStarted = deferred();
  const releaseWrite = deferred();
  authorityWriteHook = (enabled, echoId) => {
    writeStarted.resolve();
    return releaseWrite.promise.then(() =>
      setStored({ settings: { ...values.settings, enabled }, [ECHO_KEY]: echoId }),
    );
  };
  port.emit(authorityMessage(false, 2));
  await writeStarted.promise;
  authorityWriteHook = null;
  const updatesBefore = port.updates().length;

  port.emit(authorityMessage(true, 3));
  await flush();
  assert.equal(values.settings.enabled, true, 'B has not written through outstanding A');
  // This user value happens to equal A. It is not tagged as A's receipt, but
  // settlement may clear it only because it still equals current authority A.
  await setStored({ settings: { ...values.settings, enabled: false } });
  releaseWrite.resolve();
  await flush();
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true, 'newer B is final');
  assert.equal(port.updates().length, updatesBefore, 'neither A nor B produced an outdated intent');
});

await test('user writes during deferred authority preserve the latest opposite choice', async () => {
  const writeStarted = deferred();
  const releaseWrite = deferred();
  authorityWriteHook = (enabled, echoId) => {
    writeStarted.resolve();
    return releaseWrite.promise.then(() =>
      setStored({ settings: { ...values.settings, enabled }, [ECHO_KEY]: echoId }),
    );
  };
  port.emit(authorityMessage(false, 4));
  await writeStarted.promise;
  authorityWriteHook = null;
  const updatesBefore = port.updates().length;

  await setStored({ settings: { ...values.settings, enabled: false } });
  await setStored({ settings: { ...values.settings, enabled: true } });
  releaseWrite.resolve();
  await flush();
  await flush();
  assert.deepEqual(port.updates().slice(updatesBefore), [
    { v: 2, type: 'blockingStateUpdate', enabled: true, baseRevision: 4 },
  ]);
  port.emit(authorityMessage(true, 5));
  await flush();
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true, 'older daemon write never eliminated the newer user choice');
  assert.equal(port.updates().length, updatesBefore + 1, 'the acknowledged choice produces no echo loop');
});

await test('rejected-write recovery cannot overwrite a choice made during its deferred read', async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  authorityWriteHook = () => {
    settingsReadHook = () => {
      // Model a storage read whose result was captured before its promise
      // resolved: a genuine user write can happen in between.
      const captured = structuredClone(values.settings);
      settingsReadHook = null;
      readStarted.resolve();
      return releaseRead.promise.then(() => captured);
    };
    throw new Error('injected lock refusal');
  };
  port.emit(authorityMessage(false, 6));
  await readStarted.promise;
  authorityWriteHook = null;
  const updatesBefore = port.updates().length;

  await setStored({ settings: { ...values.settings, enabled: false } });
  await flush();
  releaseRead.resolve();
  await flush();
  await flush();
  assert.equal(
    port.updates().length,
    updatesBefore,
    'the stale captured value cannot fabricate an opposite intent',
  );
  assert.equal(values.settings.enabled, false, 'the newer user choice remains stored');
});

await test('rejected-write recovery cannot contaminate a reconnected ledger', async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  authorityWriteHook = () => {
    settingsReadHook = () => {
      const captured = structuredClone(values.settings);
      settingsReadHook = null;
      readStarted.resolve();
      return releaseRead.promise.then(() => captured);
    };
    throw new Error('injected lock refusal');
  };
  port.emit(authorityMessage(true, 7));
  await readStarted.promise;
  authorityWriteHook = null;

  await crashAndReconnect();
  port.emit(statusMessage({ authenticated: true, blocking: { enabled: false, revision: 1 } }));
  await flush();
  releaseRead.resolve();
  await flush();
  await flush();
  const updatesBefore = port.updates().length;
  port.emit(authorityMessage(true, 2));
  await flush();
  await flush();
  await flush();
  assert.equal(values.settings.enabled, true, 'new authority applies without an old-epoch intent');
  assert.equal(port.updates().length, updatesBefore, 'old recovery fabricated no new-epoch update');
});

function partnerAck(ok = true) {
  return { v: 2, type: 'commandResult', ok, message: ok ? 'accepted' : 'refused', status: statusMessage({ authenticated: true }).status };
}

await test('legacy partner results resolve single-flight in order without operation IDs', async () => {
  const first = submitPartnerCommand({ action: 'add-key', publicKey: 'a'.repeat(64) });
  await flush();
  const second = submitPartnerCommand({ action: 'arm' });
  await flush();
  assert.equal(port.messages.filter((message) => ['addKey', 'arm'].includes(message.type)).length, 1);
  assert.equal(port.messages.at(-1).type, 'addKey');
  assert.equal(port.messages.at(-1).publicKey, 'a'.repeat(64));

  port.emit(partnerAck());
  const firstResponse = await first;
  assert.equal(firstResponse.ok, true);
  await flush();
  assert.equal(port.messages.at(-1).type, 'arm');
  port.emit(partnerAck());
  assert.equal((await second).ok, true);
});

await test('A timeout cannot let its late result resolve queued B; fresh auth is required', async () => {
  const retired = port;
  const priorMessages = retired.messages.length;
  setPartnerCommandTimeoutForTest(20);
  try {
    const first = submitPartnerCommand({ action: 'begin-operation' });
    await flush();
    const second = submitPartnerCommand({ action: 'arm' });
    await flush();
    assert.equal(retired.messages.slice(priorMessages).filter((message) => ['beginOperation', 'arm'].includes(message.type)).length, 1);
    await assert.rejects(first, /did not acknowledge in time/);
    await flush();
    // A result arriving on the retired port has no authority in the new epoch.
    retired.emit(partnerAck());
    await assert.rejects(second, /unavailable|disconnected/);
    assert.equal(retired.messages.slice(priorMessages).filter((message) => message.type === 'arm').length, 0);

    for (const listener of alarmListeners) listener({ name: 'companion-retry' });
    await flush();
    await flush();
    assert.notEqual(port, retired, 'timeout closes and replaces the retired port');
    port.emit(statusMessage({ authenticated: true, blocking: { enabled: true, revision: 1 } }));
    await flush();
    const current = submitPartnerCommand({ action: 'begin-operation' });
    for (let n = 0; n < 5; n++) await flush();
    assert.equal(port.messages.at(-1).type, 'beginOperation');
    port.emit(partnerAck());
    assert.equal((await current).ok, true);
  } finally {
    setPartnerCommandTimeoutForTest(null);
  }
});

await test('operation result parsing is canonical and exactly matches A amid concurrent B', async () => {
  const { partnerOperationFromResult } = await import('../src/shared/companion-protocol.ts?partner-operation-test');
  const a = {
    installationId: '01'.repeat(32),
    armGeneration: '02'.repeat(32),
    operationId: '03'.repeat(32),
    nonce: '04'.repeat(32),
    expiresAtMs: 200_000,
    expiresMonoMs: 100_000,
  };
  const b = { ...a, operationId: '05'.repeat(32), nonce: '06'.repeat(32) };
  const status = { partner: { installationId: a.installationId, pendingOperations: [a, b] } };
  assert.deepEqual(partnerOperationFromResult(JSON.stringify(a), status), a);
  for (const invalid of [
    { ...a, operationId: 'AB'.repeat(32) },
    { ...a, nonce: b.nonce },
    { ...a, expiresAtMs: 0 },
    { ...a, expiresMonoMs: undefined },
    { ...a, extra: true },
  ]) {
    assert.throws(() => partnerOperationFromResult(JSON.stringify(invalid), status));
  }
  const bMessageWithAStatus = JSON.stringify(b);
  assert.deepEqual(partnerOperationFromResult(bMessageWithAStatus, status), b);
});

await test('a retired partner command cannot resolve through the new epoch', async () => {
  const pending = submitPartnerCommand({ action: 'begin-operation' });
  await flush();
  const retired = await crashAndReconnect();
  await assert.rejects(pending, /unavailable|disconnected/);
  retired.emit(partnerAck());
  port.emit(statusMessage({ authenticated: true, blocking: { enabled: true, revision: 1 } }));
  await flush();
  const current = submitPartnerCommand({ action: 'begin-operation' });
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(port.messages.at(-1).type, 'beginOperation');
  port.emit(partnerAck());
  assert.equal((await current).ok, true);
});

// Exercise the normal not-installed disconnect path to clear the bridge's
// heartbeat timer; otherwise Node would keep the test process alive forever.
api.runtime.lastError = { message: 'Specified native messaging host not found.' };
for (const listener of port.disconnectListeners) listener();

console.log(`companion-background: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
