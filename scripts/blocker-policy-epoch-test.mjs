// Actual blocker decision/application path with deterministic native API gates.
// The test deliberately pauses DNR reload / override-token minting across a
// scoped-policy epoch change. No Playwright or mock sanitizer substitutes for
// blocker.ts itself: its real listeners, navigation generations and application
// branches run here.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerBlockerEpochTest';
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
    const stub = (source) => ({ format: 'module', shortCircuit: true, source });
    if (path.endsWith('/src/shared/api.ts')) {
      return stub(`export const api = globalThis.${HARNESS}.api;`);
    }
    if (path.endsWith('/src/shared/settings.ts')) {
      return stub(`export const getSettings = async () => globalThis.${HARNESS}.settings();`);
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return stub(`export const getLockState = async () => globalThis.${HARNESS}.lockState(); export const getLockStatus = async () => globalThis.${HARNESS}.lockStatus();`);
    }
    if (path.endsWith('/src/shared/allowance-store.ts')) {
      return stub('export const getLocalAllowanceAuthority = async () => ({ version: 1, revision: 0, categories: {}, receipts: [] });');
    }
    if (path.endsWith('/src/shared/overrides.ts')) {
      return stub('export const isOverridden = async () => false;');
    }
    if (path.endsWith('/src/shared/tab-status.ts')) {
      return stub('export const clearTabStatus = async () => {}; export const recordTabStatus = async () => {};');
    }
    if (path.endsWith('/src/background/classifier.ts')) {
      return stub(`export const classify = async () => ({ label: 'video games', score: 0.99, cached: false, loadMs: 0, inferMs: 1 });`);
    }
    if (path.endsWith('/src/background/allowance.ts')) {
      return stub('export const allowanceReliefForCategory = async () => null; export const recordAllowanceActivity = async () => {};');
    }
    if (path.endsWith('/src/background/blockscreen.ts')) {
      return stub('export const applyPreBlockCurtain = () => {}; export const clearBlockScreen = () => {}; export const clearPreBlockCurtain = () => {}; export function showBlockScreen() {} export function showClassifierUnavailableScreen() {}');
    }
    if (path.endsWith('/src/background/override-tokens.ts')) {
      return stub(`export const mintOverrideToken = () => globalThis.${HARNESS}.mintOverrideToken();`);
    }
    if (path.endsWith('/src/background/force-redirect.ts')) {
      return stub(`export const addForceRedirectRule = (tabId, url, info) => globalThis.${HARNESS}.addRule(tabId, url, info); export const clearForceRedirectRule = (tabId, url) => globalThis.${HARNESS}.clearRule(tabId, url); export const initForceRedirectLifecycle = () => {};`);
    }
    return nextLoad(url, context);
  },
});

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    },
  };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const clone = (value) => structuredClone(value);
const settings = {
  enabled: true,
  blockedLabels: ['video games'],
  labels: ['video games'],
  blockThreshold: 0.5,
  surrenderMode: 'none',
  blocklist: [],
  titleRules: [],
  whitelist: [],
  channelBlocklist: [],
  channelAllowlist: [],
  focusGoal: '',
  useTabContext: false,
  blockAdult: false,
  maskSearchElements: false,
};
const activeScope = {
  id: 'scope', days: [0, 1, 2, 3, 4, 5, 6], startMinutes: 0,
  endMinutes: 1439, tzOffsetMinutes: 0, categories: ['video games'], updatedAt: 1,
};
const state = {
  lockState: { categorySchedules: [activeScope], categorySchedulesUpdatedAt: 2 },
  lockStatus: { settingsLocked: true, forceBlocking: true, reasons: ['schedule'], breakActive: false },
  reloadGate: null,
  addGate: null,
  mintGate: null,
  activeRules: new Map(),
  calls: { add: [], clear: [], reload: [], update: [], execute: [], mint: 0 },
};
const storageEvents = event();
const committed = event();
const completed = event();
const history = event();
const updated = event();
const removed = event();
const alarm = event();
const tab = { id: 41, url: 'https://example.test/play', title: 'speedrunning Dark Souls' };
const api = {
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
    },
    onChanged: storageEvents,
  },
  alarms: { onAlarm: alarm, async create() {}, async clear() {} },
  tabs: {
    onUpdated: updated,
    onRemoved: removed,
    async query() { return [clone(tab)]; },
    async get() { return clone(tab); },
    async reload(tabId) {
      state.calls.reload.push(tabId);
      if (state.reloadGate) await state.reloadGate.promise;
    },
    async update(tabId, changes) { state.calls.update.push({ tabId, ...clone(changes) }); },
  },
  webNavigation: {
    onCommitted: committed,
    onCompleted: completed,
    onHistoryStateUpdated: history,
    async getAllFrames() { return []; },
  },
  scripting: {
    async executeScript(details) {
      state.calls.execute.push(clone({ ...details, func: details.func?.name }));
      return [{ result: {} }];
    },
  },
};
globalThis[HARNESS] = {
  api,
  settings: async () => clone(settings),
  lockState: async () => clone(state.lockState),
  lockStatus: async () => clone(state.lockStatus),
  async addRule(tabId, url) {
    state.calls.add.push({ tabId, url });
    const key = `${tabId}|${url}`;
    if (state.activeRules.has(key)) return { status: 'already-enforced' };
    if (state.addGate) await state.addGate.promise;
    const ruleId = nextSyntheticRuleId++;
    state.activeRules.set(key, ruleId);
    return { status: 'installed', ruleId };
  },
  async clearRule(tabId, url, ownedRuleId) {
    state.calls.clear.push({ tabId, url, ownedRuleId });
    const key = `${tabId}|${url}`;
    const current = state.activeRules.get(key);
    if (ownedRuleId === undefined || current === ownedRuleId) state.activeRules.delete(key);
  },
  async mintOverrideToken() {
    state.calls.mint++;
    if (state.mintGate) await state.mintGate.promise;
    return 'override-token';
  },
};

const { advanceCategoryPolicyEpoch, initBlocker } = await import(
  `../src/background/blocker.ts?epoch-test=${process.pid}`
);
initBlocker();
// initBlocker installs listeners synchronously. The lock-enforcer normally
// performs the boundary sweep; the test does it explicitly after this storage
// notification, just as production does.
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle(rounds = 20) {
  for (let n = 0; n < rounds; n++) await flush();
}
async function waitFor(predicate, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}
async function beginTab(tabId, url) {
  await committed.emit({ tabId, frameId: 0, url });
  await updated.emit(tabId, { title: 'speedrunning Dark Souls' }, { id: tabId, url, title: 'speedrunning Dark Souls' });
}
async function endPolicy(tabId, url, hard) {
  const previous = state.lockState;
  state.lockState = {
    categorySchedules: [{ ...activeScope, startMinutes: 1438, endMinutes: 1439 }],
    categorySchedulesUpdatedAt: Date.now(),
  };
  state.lockStatus = {
    settingsLocked: hard,
    forceBlocking: hard,
    reasons: hard ? ['schedule'] : [],
    breakActive: false,
  };
  await storageEvents.emit({
    lockState: { oldValue: previous, newValue: state.lockState },
  }, 'local');
  const { sweepOpenTabs } = await import(`../src/background/blocker.ts?epoch-test=${process.pid}`);
  await sweepOpenTabs();
}
let passed = 0;
let nextSyntheticRuleId = 10_000;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('blocker policy-epoch application tests');
await test('a stale DNR commit is cleared and the original URL is restored after the newer sweep', async () => {
  state.reloadGate = deferred();
  const url = tab.url;
  await beginTab(tab.id, url);
  await settle();
  const key = `${tab.id}|${url}`;
  assert.equal(state.calls.add.filter((call) => call.tabId === tab.id).length, 1);
  assert.equal(typeof state.activeRules.get(key), 'number');
  assert.equal(state.calls.reload.filter((id) => id === tab.id).length, 1);

  // End the old scope and let the NEW policy's ordinary sweep clear the page
  // BEFORE the old reload resolves. The old operation then completes anyway.
  await endPolicy(tab.id, url, false);
  assert.equal(state.activeRules.has(key), false);
  assert.equal(state.calls.update.some((call) => call.tabId === tab.id), false);
  state.reloadGate.resolve();
  await settle(30);

  assert.equal(
    state.calls.clear.filter((call) => call.tabId === tab.id && call.url === url).length >= 2,
    true,
    'new sweep and post-commit rollback both release the stale URL rule',
  );
  assert.equal(state.activeRules.has(key), false, 'no stale redirect rule remains');
  assert.deepEqual(
    state.calls.update.find((call) => call.tabId === tab.id),
    { tabId: tab.id, url },
    'the evaluator that committed the redirect restores its original URL',
  );
  assert.equal(
    state.calls.execute.some((call) => call.func === 'showBlockScreen'),
    false,
    'old verdict never falls through to an injected block screen',
  );
});

await test('an epoch change during override-token mint cannot paint the stale block screen', async () => {
  const second = { ...tab, id: 42, url: 'https://example.test/second' };
  const query = api.tabs.query;
  const get = api.tabs.get;
  api.tabs.query = async () => [clone(second)];
  api.tabs.get = async () => clone(second);
  state.mintGate = deferred();
  state.lockStatus = { settingsLocked: false, forceBlocking: false, reasons: [], breakActive: false };
  state.lockState = { categorySchedules: [activeScope], categorySchedulesUpdatedAt: Date.now() };
  await beginTab(second.id, second.url);
  await settle();
  assert.equal(state.calls.mint >= 1, true);
  const executionsBefore = state.calls.execute.length;

  // Scope becomes inactive; no force redirect is involved in this branch.
  const previous = state.lockState;
  state.lockState = {
    categorySchedules: [{ ...activeScope, startMinutes: 1438, endMinutes: 1439 }],
    categorySchedulesUpdatedAt: Date.now(),
  };
  await storageEvents.emit({
    lockState: { oldValue: previous, newValue: state.lockState },
  }, 'local');
  advanceCategoryPolicyEpoch(); // explicit time-boundary notification as well
  state.mintGate.resolve();
  await settle(25);
  assert.equal(
    state.calls.execute.slice(executionsBefore).some((call) => call.func === 'showBlockScreen'),
    false,
  );
  api.tabs.query = query;
  api.tabs.get = get;
});

await test('an authority snapshot sweeps an open tab without a navigation or title event', async () => {
  const third = { ...tab, id: 43, url: 'https://example.test/third' };
  api.tabs.query = async () => [clone(third)];
  api.tabs.get = async () => clone(third);
  state.lockStatus = { settingsLocked: false, forceBlocking: false, reasons: [], breakActive: false };
  state.lockState = { categorySchedules: [], categorySchedulesUpdatedAt: Date.now() };
  await beginTab(third.id, third.url);
  await settle();
  const blockedScreen = state.calls.execute.findIndex((call) => call.func === 'showBlockScreen');
  assert.notEqual(blockedScreen, -1, 'baseline classifier block was applied');
  const navigationsBefore = state.calls.reload.length + state.calls.update.length;
  const executionBefore = state.calls.execute.length;

  // Only the authority event fires. The scoped rule also changes in storage so
  // this new sweep has an allowed decision to apply; no lockState notification,
  // navigation, title event or manual sweep trigger is supplied.
  state.lockState = {
    categorySchedules: [{ ...activeScope, startMinutes: 1438, endMinutes: 1439 }],
    categorySchedulesUpdatedAt: Date.now(),
  };
  const authority = { version: 1, revision: 3, categories: {}, receipts: [] };
  await storageEvents.emit({
    allowanceAuthority: { oldValue: undefined, newValue: authority },
  }, 'local');
  const cleared = await waitFor(() =>
    state.calls.execute.slice(executionBefore).some((call) => call.func === 'clearBlockScreen'),
  );
  assert.equal(
    cleared,
    true,
    'the snapshot-triggered reevaluation applies the new allowed verdict',
  );
  assert.equal(
    state.calls.reload.length + state.calls.update.length,
    navigationsBefore,
    'the evidence does not depend on a reload or synthetic navigation',
  );
});

await test('a stale evaluator cannot clear a pre-seeded valid rule after an unrelated navigation', async () => {
  const fourth = { ...tab, id: 44, url: 'https://example.test/already-owned' };
  const unrelatedUrl = 'https://example.test/unrelated-newer-navigation';
  const originalKey = `${fourth.id}|${fourth.url}`;
  const preexistingRuleId = 777_777;
  state.activeRules.set(originalKey, preexistingRuleId);
  state.reloadGate = deferred();
  state.lockStatus = { settingsLocked: true, forceBlocking: true, reasons: ['schedule'], breakActive: false };
  state.lockState = { categorySchedules: [activeScope], categorySchedulesUpdatedAt: Date.now() };
  api.tabs.query = async () => [clone(fourth)];
  api.tabs.get = async () => clone(fourth);
  await beginTab(fourth.id, fourth.url);
  await settle();
  assert.equal(state.calls.reload.includes(fourth.id), true);

  const previous = state.lockState;
  state.lockState = {
    categorySchedules: [{ ...activeScope, startMinutes: 1438, endMinutes: 1439 }],
    categorySchedulesUpdatedAt: Date.now(),
  };
  state.lockStatus = { settingsLocked: false, forceBlocking: false, reasons: [], breakActive: false };
  await storageEvents.emit({
    lockState: { oldValue: previous, newValue: state.lockState },
  }, 'local');
  // The old evaluator's redirect is no longer current; a different URL then
  // navigates in that tab. Its newer rollback/navigation sweep cannot own U.
  await committed.emit({ tabId: fourth.id, frameId: 0, url: unrelatedUrl });
  const current = { ...fourth, url: unrelatedUrl };
  api.tabs.query = async () => [clone(current)];
  api.tabs.get = async () => clone(current);
  const { sweepOpenTabs } = await import(`../src/background/blocker.ts?epoch-test=${process.pid}`);
  await sweepOpenTabs();
  state.reloadGate.resolve();
  await settle(30);

  assert.equal(
    state.activeRules.get(originalKey),
    preexistingRuleId,
    'stale cleanup preserves the rule it did not install',
  );
  assert.equal(
    state.calls.clear.some(
      (call) => call.tabId === fourth.id && call.url === fourth.url && call.ownedRuleId === preexistingRuleId,
    ),
    false,
  );
  assert.equal(
    state.calls.update.some((call) => call.tabId === fourth.id && call.url === fourth.url),
    false,
    'unrelated newer navigation is not yanked back to the old URL',
  );
});

console.log(`\n${passed} passed, 0 failed`);
