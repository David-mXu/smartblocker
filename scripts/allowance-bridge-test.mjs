// Native-port-independent allowance bridge tests with fake persistence and
// controllable daemon replies. The real state reducer and storage boundary run.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerAllowanceBridgeTest';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const path = url.split('?')[0];
    if (path.endsWith('/src/shared/api.ts')) {
      return { format: 'module', shortCircuit: true, source: `export const api = globalThis.${HARNESS}.api;` };
    }
    if (path.endsWith('/src/shared/lock.ts')) {
      return { format: 'module', shortCircuit: true, source: 'export const getLockStatus = async () => ({ settingsLocked: false });' };
    }
    return nextLoad(url, context);
  },
});

const values = {};
const clone = (value) => value === undefined ? undefined : structuredClone(value);
let writeGate = null;
let writeFailure = null;
let readGate = null;
let readFailure = null;
let connected = true;
globalThis[HARNESS] = {
  api: { storage: { local: {
    async get(key) {
      if (readGate) {
        const gate = readGate;
        readGate = null;
        await gate.promise;
      }
      if (readFailure) {
        const message = readFailure;
        readFailure = null;
        throw new Error(message);
      }
      return { [key]: clone(values[key]) };
    },
    async set(items) {
      if (writeGate) await writeGate.promise;
      if (writeFailure) {
        const message = writeFailure;
        writeFailure = null;
        throw new Error(message);
      }
      Object.assign(values, clone(items));
    },
  }, onChanged: { addListener() {} } } },
};

const {
  applyAllowanceCommand,
  commitAllowanceCommandRevision,
  emptyAllowanceAuthorityState,
} = await import('../src/shared/allowance-state.ts');
const { createAllowanceBridge } = await import('../src/background/allowance-bridge.ts');
const { allowanceLocalDayKey, submitLocalAllowanceCommand } = await import('../src/shared/allowance-store.ts');
const dispatch = async (command) => {
  const response = await bridge.submit(command);
  if (response) return response;
  const local = await submitLocalAllowanceCommand(command);
  return { ...local, source: 'fallback' };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
let epoch = 1;
let server = emptyAllowanceAuthorityState();
const sent = [];
const heldReplies = new Set();
const results = [];
let bridge = createAllowanceBridge({
  getConnection: () => connected ? ({ epoch, send }) : null,
  onAuthority: (state) => results.push(state.revision),
});
function send(message) {
  sent.push(structuredClone(message));
  if (message.type === 'allowanceBootstrap') {
    if (message.allowance?.revision > server.revision) {
      server = structuredClone(message.allowance);
      queueMicrotask(() => bridge.onMessage({
        v: 2, type: 'allowanceStateSync', allowance: server,
      }, epoch));
    }
    return true;
  }
  if (message.type === 'allowanceCommand') {
    if (heldReplies.has(message.command.operationId)) return true;
    const applied = applyAllowanceCommand(server, message.command, message.baseRevision);
    if (!applied.ok) {
      queueMicrotask(() => bridge.onMessage({
        v: 2, type: 'allowanceCommandResult', ok: false, operationId: message.command.operationId,
        allowance: server, reason: applied.reason,
      }, epoch));
      return true;
    }
    if (!applied.duplicate) server = commitAllowanceCommandRevision(applied.state, server.revision + 1, message.command);
    queueMicrotask(() => bridge.onMessage({
      v: 2, type: 'allowanceCommandResult', ok: true, operationId: message.command.operationId,
      allowance: server, duplicate: applied.duplicate || undefined,
    }, epoch));
  }
  return true;
}
const id = (n) => n.toString(16).padStart(32, '0');
const category = 'video games';
const at = { nowMs: 1_800_000_000_000, dayKey: '2026-11-08' };
const configure = (n = 1) => ({ kind: 'configure', operationId: id(n), category, config: {
  dailyAllowanceMs: 600_000, dailyOpenings: 1, waitingBaseMs: 0, waitingStepMs: 0, waitingMaxMs: 0, rewardCapMs: 60_000,
}});
const reward = (n = 2) => ({ kind: 'reward', operationId: id(n), category, grantId: 'unused', earnedMs: 30_000, ...at });

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('allowance bridge tests');
await test('command B waits for A result and receives its higher base revision', async () => {
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  await flush();
  heldReplies.add(id(1));
  const first = bridge.submit(configure());
  const second = bridge.submit(reward());
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(sent.filter((message) => message.type === 'allowanceCommand').length, 1);
  heldReplies.delete(id(1));
  send(sent.at(-1)); // deliver the deliberately held acknowledgement.
  const [a, b] = await Promise.all([first, second]);
  const commands = sent.filter((message) => message.type === 'allowanceCommand');
  assert.deepEqual(commands.map((message) => message.baseRevision), [0, 0, 1]);
  assert.equal(a.state.revision, 1);
  assert.equal(b.state.revision, 2);
  assert.equal(values.allowanceAuthority.revision, 2);
  assert.equal(results.at(-1), 2);
});

await test('success waits for actual snapshot persistence', async () => {
  const gate = deferred();
  writeGate = gate;
  let settled = false;
  const promise = bridge.submit({ ...reward(3) }).then((response) => { settled = true; return response; });
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(settled, false, 'response cannot precede the queued storage write');
  gate.resolve();
  writeGate = null;
  const response = await promise;
  assert.equal(response.ok, true);
  assert.equal(values.allowanceAuthority.revision, 3);
});

await test('restart recovery uses persisted receipts rather than a second consumption', async () => {
  const response = await bridge.submit(reward(3));
  assert.equal(response.duplicate, true);
  assert.equal(response.state.revision, 3);
  assert.equal(values.allowanceAuthority.revision, 3);
});

await test('disconnect rejects outstanding work and stale epoch replies cannot revive it', async () => {
  const before = sent.length;
  heldReplies.add(id(4));
  const pending = bridge.submit(reward(4));
  await flush();
  const afterKnownSend = sent.length;
  bridge.reset();
  await assert.rejects(pending, /disconnected/);
  bridge.onMessage({
    v: 2, type: 'allowanceCommandResult', ok: true, operationId: id(4), allowance: server,
  }, epoch);
  await flush();
  epoch++;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  await flush();
  assert.equal(sent.length, afterKnownSend, 'old reply generated no replacement write');
  assert.equal(bridge.current().revision, 3);
});

await test('an absent field bootstraps the offline snapshot once per connection', async () => {
  bridge.onStatus(undefined, epoch);
  bridge.onStatus(undefined, epoch);
  for (let n = 0; n < 5; n++) await flush();
  const bootstraps = sent.filter((message) => message.type === 'allowanceBootstrap');
  assert.equal(bootstraps.length, 1);
  assert.equal(bootstraps[0].allowance.revision, 3);
  bridge.reset();
  epoch++;
  bridge.onStatus(undefined, epoch);
  bridge.onStatus(undefined, epoch);
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(
    sent.filter((message) => message.type === 'allowanceBootstrap').length,
    2,
    'the new uninitialized daemon gets exactly one migration attempt, not two',
  );
  bridge.reset();
  epoch++;
  bridge.onStatus(undefined, epoch);
  bridge.onStatus(undefined, epoch);
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(sent.filter((message) => message.type === 'allowanceBootstrap').length, 3);
  assert.ok(allowanceLocalDayKey(new Date()).length === 10);
});

await test('first configure waits for actual bootstrap instead of falling back into losing state', async () => {
  bridge.reset();
  epoch++;
  server = emptyAllowanceAuthorityState();
  values.allowanceAuthority = {};
  sent.length = 0;
  bridge = createAllowanceBridge({
    getConnection: () => connected ? ({ epoch, send }) : null,
    onAuthority: (state) => results.push(state.revision),
  });
  bridge.onStatus(undefined, epoch);
  const first = bridge.submit(configure());
  for (let n = 0; n < 3; n++) await flush();
  assert.equal(
    sent.filter((message) => message.type === 'allowanceCommand').length,
    0,
    'unknown initialization cannot immediately mint fallback state',
  );
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  const response = await first;
  assert.equal(response.source, 'daemon');
  assert.equal(response.state.revision, 1);
  assert.equal(response.state.categories['video games'].config.dailyAllowanceMs, 600_000);
  assert.equal(values.allowanceAuthority.revision, 1);
});

await test('a late bootstrap reply cannot overwrite fallback commands written after timeout', async () => {
  epoch++;
  server = emptyAllowanceAuthorityState();
  values.allowanceAuthority = {};
  bridge = createAllowanceBridge({
    getConnection: () => connected ? ({ epoch, send }) : null,
    onAuthority: (state) => results.push(state.revision),
    initializationTimeoutMs: 0,
  });
  bridge.onStatus(undefined, epoch);
  const first = dispatch(configure());
  await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await first;
  assert.equal(response.source, 'fallback');
  assert.equal(response.state.revision, 1);
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 5; n++) await flush();
  assert.equal(values.allowanceAuthority.revision, 1);
  assert.equal(values.allowanceAuthority.categories['video games'].config.dailyAllowanceMs, 600_000);
  assert.equal(bridge.current(), null);
  assert.equal(bridge.initializing(), false, 'epoch fallback is final, not an infinite retry loop');
  bridge.reset();
  epoch++;
  server = values.allowanceAuthority;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 5; n++) await flush();
  assert.notEqual(bridge.current(), null);
});

await test('a mirror-write failure rejects its operation and frees the next command', async () => {
  epoch++;
  bridge.reset();
  server = values.allowanceAuthority;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 5; n++) await flush();
  const failed = bridge.submit(configure(61));
  writeFailure = 'injected snapshot write failure';
  await assert.rejects(failed, /injected snapshot write failure/);
  const revisionAfterFailure = server.revision;
  const recovered = await bridge.submit(configure(62));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.revision, revisionAfterFailure + 1);
  assert.equal(values.allowanceAuthority.revision, recovered.state.revision);
});

await test('lower revision reconnect cannot erase newer offline opening usage', async () => {
  bridge.reset();
  epoch++;
  server = values.allowanceAuthority;
  const daemonRevision = server.revision;
  values.allowanceAuthority = server;
  const opened = await submitLocalAllowanceCommand({
    kind: 'opening-start', operationId: id(63), category, grantId: 'offline-open', ...at,
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.categories[category].ledger.openingsUsed, 1);
  const openedRevision = opened.state.revision;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 6; n++) await flush();
  assert.equal(values.allowanceAuthority.revision, openedRevision);
  assert.equal(values.allowanceAuthority.categories[category].ledger.openingsUsed, 1);
  assert.equal(sent.at(-1).type, 'allowanceBootstrap');
  assert.equal(sent.at(-1).allowance.revision, openedRevision);
  assert.equal(
    bridge.current().revision,
    openedRevision,
    'the daemon accepted the newer fallback snapshot and broadcast it',
  );
  assert.equal(values.allowanceAuthority.categories[category].ledger.openingsUsed, 1);
  assert.equal(server.revision, openedRevision);
  assert.ok(daemonRevision < openedRevision);
});

await test('equal-revision divergent fallback usage is promoted instead of overwritten', async () => {
  bridge.reset();
  epoch++;
  const conflictCategory = 'social media';
  const configured = await submitLocalAllowanceCommand({
    kind: 'configure', operationId: id(68), category: conflictCategory, config: {
      dailyAllowanceMs: 600_000, dailyOpenings: 1, waitingBaseMs: 0, waitingStepMs: 0, waitingMaxMs: 0, rewardCapMs: 60_000,
    },
  });
  assert.equal(configured.ok, true);
  server = configured.state;
  const baseRevision = server.revision;
  const opened = await submitLocalAllowanceCommand({
    kind: 'opening-start', operationId: id(70), category: conflictCategory, grantId: 'offline-conflict', ...at,
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.revision, baseRevision + 1);
  assert.equal(opened.state.categories[conflictCategory].ledger.openingsUsed, 1);
  const localEarned = opened.state.categories[conflictCategory].ledger.earnedRewardMs;

  // The daemon independently applies a different command at the same revision.
  const daemonCommand = { ...reward(71), category: conflictCategory };
  const applied = applyAllowanceCommand(server, daemonCommand, server.revision);
  assert.equal(applied.ok, true);
  server = commitAllowanceCommandRevision(applied.state, server.revision + 1, daemonCommand);
  assert.equal(server.revision, opened.state.revision);
  assert.equal(server.categories[conflictCategory].ledger.openingsUsed, 0);

  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 8; n++) await flush();

  const settled = values.allowanceAuthority;
  assert.equal(settled.revision, baseRevision + 2, 'conflicting offline history advances one revision');
  assert.equal(settled.categories[conflictCategory].ledger.openingsUsed, 1, 'offline opening usage survives reconciliation');
  assert.equal(settled.categories[conflictCategory].ledger.earnedRewardMs, localEarned, 'daemon-side same-revision reward did not replace local history');
  assert.equal(server.revision, settled.revision, 'the daemon adopted the promoted snapshot');
  assert.equal(server.categories[conflictCategory].ledger.openingsUsed, 1);
  assert.equal(bridge.current().revision, settled.revision);
  const bootstrap = sent.filter((message) => message.type === 'allowanceBootstrap').at(-1);
  assert.equal(bootstrap.allowance.revision, baseRevision + 2);
  assert.equal(bootstrap.allowance.categories[conflictCategory].ledger.openingsUsed, 1);
});

await test('a local read failure rejects its command instead of orphaning it', async () => {
  const operation = configure(80);
  heldReplies.add(operation.operationId);
  const pending = bridge.submit(operation);
  for (let n = 0; n < 4; n++) await flush();
  assert.equal(sent.at(-1).command.operationId, operation.operationId);
  readFailure = 'injected local read failure';
  heldReplies.delete(operation.operationId);
  send(sent.at(-1));
  await assert.rejects(pending, /injected local read failure/);
  // The daemon still applied it; adopt the snapshot so later checks include it.
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 8; n++) await flush();
  assert.equal(bridge.current().revision, server.revision);
  assert.equal(values.allowanceAuthority.revision, server.revision);
});

await test('a daemon revision lead preserves local-only receipts above both revisions', async () => {
  bridge.reset();
  epoch++;
  connected = true;
  values.allowanceAuthority = {};
  server = emptyAllowanceAuthorityState();
  const scope = 'news';
  const config = {
    dailyAllowanceMs: 600_000, dailyOpenings: 2, waitingBaseMs: 0, waitingStepMs: 0,
    waitingMaxMs: 0, rewardCapMs: 60_000,
  };
  const configured = await submitLocalAllowanceCommand({
    kind: 'configure', operationId: id(81), category: scope, config,
  });
  assert.equal(configured.ok, true);
  server = structuredClone(configured.state);
  bridge = createAllowanceBridge({
    getConnection: () => connected ? ({ epoch, send }) : null,
    onAuthority: (state) => results.push(state.revision),
  });
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 8; n++) await flush();
  const base = server.revision;
  assert.equal(bridge.current().revision, base);

  // The browser mints one opening while offline.
  const opened = await submitLocalAllowanceCommand({
    kind: 'opening-start', operationId: id(82), category: scope, grantId: 'offline-lead', ...at,
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.revision, base + 1);
  assert.equal(opened.state.categories[scope].ledger.openingsUsed, 1);

  // Independently, the daemon commits two unrelated rewards (a revision lead)
  // that do not include the browser's opening receipt.
  for (const n of [83, 84]) {
    const command = { ...reward(n), category: scope };
    const applied = applyAllowanceCommand(server, command, server.revision);
    assert.equal(applied.ok, true);
    server = commitAllowanceCommandRevision(applied.state, server.revision + 1, command);
  }
  assert.equal(server.revision, base + 2);
  assert.equal(server.categories[scope].ledger.openingsUsed, 0);

  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 10; n++) await flush();

  const settled = values.allowanceAuthority;
  assert.equal(settled.revision, base + 3, 'promotion clears the daemon lead too');
  assert.equal(settled.categories[scope].ledger.openingsUsed, 1, 'offline opening survives');
  assert.equal(server.revision, base + 3, 'the daemon adopted the promoted snapshot');
  assert.equal(server.categories[scope].ledger.openingsUsed, 1);
  assert.equal(bridge.current().revision, base + 3);
});

await test('a retired epoch observation cannot latch over the new connection', async () => {
  bridge.reset();
  epoch++;
  connected = true;
  values.allowanceAuthority = structuredClone(server);
  bridge = createAllowanceBridge({
    getConnection: () => connected ? ({ epoch, send }) : null,
    onAuthority: (state) => results.push(state.revision),
  });
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 8; n++) await flush();
  const base = server.revision;
  assert.equal(bridge.current().revision, base);

  const stale = structuredClone(server);
  stale.revision = base + 5;
  stale.categories['news'].ledger.openingsUsed = 0;
  const gate = deferred();
  readGate = gate;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: stale }, epoch);
  for (let n = 0; n < 3; n++) await flush();
  // Retire the connection while the observation is parked in its local read.
  bridge.reset();
  epoch++;
  const fresh = structuredClone(server);
  fresh.revision = base + 1;
  bridge.onMessage({ type: 'allowanceStateSync', allowance: fresh }, epoch);
  for (let n = 0; n < 3; n++) await flush();
  gate.resolve();
  for (let n = 0; n < 10; n++) await flush();

  assert.equal(bridge.current().revision, base + 1, 'the stale epoch did not win');
  assert.equal(values.allowanceAuthority.revision, base + 1);
  assert.equal(values.allowanceAuthority.categories['news'].ledger.openingsUsed, 1);
});

await test('a committed daemon snapshot is mirrored before an offline fallback extends it', async () => {
  bridge.reset();
  epoch++;
  connected = true;
  values.allowanceAuthority = structuredClone(server);
  bridge = createAllowanceBridge({
    getConnection: () => connected ? ({ epoch, send }) : null,
    onAuthority: (state) => results.push(state.revision),
  });
  bridge.onMessage({ type: 'allowanceStateSync', allowance: server }, epoch);
  for (let n = 0; n < 8; n++) await flush();
  const base = server.revision;
  const config = {
    dailyAllowanceMs: 600_000, dailyOpenings: 1, waitingBaseMs: 0, waitingStepMs: 0,
    waitingMaxMs: 0, rewardCapMs: 60_000,
  };

  const daemonCommand = { kind: 'configure', operationId: id(90), category: 'daemon-only', config };
  heldReplies.add(daemonCommand.operationId);
  const pending = bridge.submit(daemonCommand);
  for (let n = 0; n < 4; n++) await flush();
  writeFailure = 'injected mirror failure';
  heldReplies.delete(daemonCommand.operationId);
  send(sent.at(-1));
  await assert.rejects(pending, /injected mirror failure/);
  assert.equal(server.revision, base + 1, 'the daemon committed the command');
  assert.equal(values.allowanceAuthority.revision, base, 'the local mirror did not');
  assert.equal(bridge.current().revision, base + 1, 'the accepted snapshot is in memory');

  connected = false;
  const response = await dispatch({
    kind: 'configure', operationId: id(91), category: 'fallback-only', config,
  });
  assert.equal(response.source, 'fallback');
  const local = values.allowanceAuthority;
  assert.equal(local.revision, base + 2, 'fallback extended the flushed daemon revision');
  assert.ok(local.categories['daemon-only'], 'the daemon-committed command was not lost');
  assert.ok(local.categories['fallback-only']);
  connected = true;
});

console.log(`\n${passed} passed, 0 failed`);
