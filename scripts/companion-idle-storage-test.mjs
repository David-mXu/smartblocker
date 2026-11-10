// Regression: an already-known missing native host must not oscillate
// companionSnapshot in storage on every Firefox event-page restart.
// The real retry still calls connectNative; a later actual host message must
// persist connected. This is a module test, not a substitute for Firefox e2e.
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
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/shared/api.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const api = globalThis.chrome; export const IS_FIREFOX = true;',
      };
    }
    if (path.endsWith('/src/shared/settings.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const COMPANION_BLOCKING_ECHO_KEY = 'companionBlockingApplyEcho';
          export const getSettings = async () => ({ enabled: true });
          export const setCompanionBlockingEnabled = async () => {};`,
      };
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const getLockState = async () => ({});
          export const mergeRemoteLockState = async () => {};
          export const getLockStatus = async () => ({ settingsLocked: false });`,
      };
    }
    return nextLoad(url, context);
  },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const values = {
  companionSnapshot: {
    state: 'not-installed',
    status: null,
    extensionLoss: null,
    lastConnectedAt: null,
  },
  companionPairing: 'already-paired',
};
let connectCalls = 0;
let storageWrites = 0;
let notifications = 0;
let hostAvailable = false;
const alarmListeners = [];
const storageListeners = [];
let activePort;

class TestPort {
  constructor() {
    this.messageListeners = [];
    this.disconnectListeners = [];
    this.onMessage = { addListener: (fn) => this.messageListeners.push(fn) };
    this.onDisconnect = { addListener: (fn) => this.disconnectListeners.push(fn) };
  }

  emit(message) {
    for (const listener of this.messageListeners) listener(message);
  }

  failMissingHost() {
    this.error = { message: 'No such native application smartblocker_test' };
    for (const listener of this.disconnectListeners) listener();
  }
}

const api = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: values[key] };
        return { ...values };
      },
      async set(items) {
        storageWrites++;
        Object.assign(values, structuredClone(items));
        notifications++;
        for (const listener of storageListeners) listener(items, 'local');
      },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
  alarms: {
    async create() {},
    async clear() {},
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
  },
  runtime: {
    id: 'idle-storage-test',
    getManifest: () => ({ version: '0.5.0' }),
    connectNative() {
      connectCalls++;
      activePort = new TestPort();
      if (!hostAvailable) queueMicrotask(() => activePort.failMissingHost());
      return activePort;
    },
  },
};
globalThis.chrome = api;

const { initCompanionBridge } = await import('../src/background/companion.ts?idle-storage-test');
initCompanionBridge();
await flush();
await flush();
await flush();
assert.equal(connectCalls, 0, 'known missing-host startup deliberately opens no doomed port');
assert.equal(storageWrites, 0, 'known missing-host initialization emits no snapshot write');
assert.equal(notifications, 0, 'identical missing-host state emits no wake notification');
assert.equal(values.companionSnapshot.state, 'not-installed');

for (const listener of alarmListeners) listener({ name: 'companion-retry' });
await flush();
await flush();
assert.equal(connectCalls, 1, 'an explicit scheduled retry still performs the real native-host lookup');
assert.equal(storageWrites, 0, 'retrying the same missing host emits no snapshot write');
assert.equal(notifications, 0, 'the missing-host retry cannot create a wake cycle');

hostAvailable = true;
for (const listener of alarmListeners) listener({ name: 'companion-retry' });
await flush();
assert.equal(connectCalls, 2);
activePort.emit({
  type: 'companionStatus',
  running: true,
  status: { companionVersion: 'test', lockState: {} },
});
await flush();
await flush();
assert.equal(values.companionSnapshot.state, 'connected', 'a genuine host response publishes connected');
assert(storageWrites > 0, 'the real connected transition is persisted');
console.log('PASS known missing-host startup opens no port; scheduled retries still work and a real host response persists connected');
// The successful-host branch intentionally starts the production heartbeat.
process.exit(0);
