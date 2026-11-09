// Focus/Pomodoro scheduler with deterministic clock, storage and authority.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerFocusCycleTest';
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
    if (path.endsWith('/src/background/allowance.ts')) {
      return { format: 'module', shortCircuit: true, source: `export const getAllowanceResponse = () => globalThis.${HARNESS}.getAllowanceResponse(); export const submitAllowanceCommand = (command) => globalThis.${HARNESS}.submitAllowanceCommand(command); // No test-specific authority fallback: this harness exercises only commands.` };
    }
    return nextLoad(url, context);
  },
});

const values = {};
const commands = [];
const alarmListeners = [];
const clone = (value) => value === undefined ? undefined : structuredClone(value);
let failNextBreak = false;
let authorityGate = null;
const authorityGates = [];
let stalePending = false;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
globalThis[HARNESS] = {
  api: {
    storage: { local: {
      async get(key) { return { [key]: clone(values[key]) }; },
      async set(items) { Object.assign(values, clone(items)); },
      async remove(key) { delete values[key]; },
    }, onChanged: { addListener() {} } },
    alarms: {
      async create() {},
      async clear() {},
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
  },
  getAllowanceResponse: async () => {
    const gate = authorityGates.shift() ?? authorityGate;
    if (gate) await gate.promise;
    return { ok: true, source: 'daemon', state: { categories: { 'video games': {} } } };
  },
  submitAllowanceCommand: async (command) => {
    commands.push(structuredClone(command));
    if (stalePending) {
      stalePending = false;
      return { ok: false, source: 'daemon', reason: 'clock-rollback' };
    }
    if (command.kind === 'pomodoro-start' && failNextBreak) {
      failNextBreak = false;
      return { ok: false, source: 'daemon', reason: 'overlap' };
    }
    return { ok: true, source: 'daemon', duplicate: command.duplicate || undefined };
  },
};

const T0 = 1_800_000_000_000;
let now = T0;
const actualNow = Date.now;
Date.now = () => now;
const {
  startFocusCycle,
  cancelFocusCycle,
  getFocusCycleResponse,
  initFocusCycleScheduler,
} = await import('../src/background/focus-cycles.ts?cycle-tests=1');
initFocusCycleScheduler();
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function fire() {
  for (const fn of alarmListeners) fn({ name: 'focus-cycle-boundary' });
  for (let n = 0; n < 12; n++) await flush();
}
const start = (mode, cycles = 1) => startFocusCycle({
  category: 'video games', mode, workMinutes: 0.000_01, breakMinutes: 0.000_01, cycles,
});
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('focus cycle tests');
await test('immediate focus earns exactly once on completion, including a redundant tick', async () => {
  const started = await start('focus');
  assert.equal(started.ok, true);
  assert.equal(started.program.stage, 'work');
  const operationId = started.program.pendingCommand.operationId;
  now += 1;
  await fire();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, 'reward');
  assert.equal(commands[0].operationId, operationId);
  assert.equal(commands[0].earnedMs, 1);
  assert.equal((await getFocusCycleResponse()).program, null);
  await fire();
  assert.equal(commands.length, 1);
});

await test('Pomodoro work rewards, free fixed breaks, and two-cycle completion run in order', async () => {
  const started = await start('pomodoro', 2);
  assert.equal(started.ok, true);
  const before = commands.length;
  now += 1;
  await fire();
  assert.deepEqual(commands.slice(before).map((command) => command.kind), ['reward', 'pomodoro-start']);
  const program = (await getFocusCycleResponse()).program;
  assert.equal(program.stage, 'break');
  assert.equal(program.pendingCommand, null);
  assert.equal(commands[before + 1].durationMs > 0, true);
  assert.equal(commands[before + 1].durationMs <= 1, true);
  now += 1;
  await fire();
  assert.equal((await getFocusCycleResponse()).program.cycle, 2);
  assert.equal(commands.length, before + 2, 'stage advancement alone emits no command');
  now += 1;
  await fire();
  assert.deepEqual(commands.slice(before + 2).map((command) => command.kind), ['reward', 'pomodoro-start']);
  now += 1;
  await fire();
  assert.equal((await getFocusCycleResponse()).program, null);
  assert.equal(commands.filter((command) => command.kind === 'pomodoro-start').length, 2);
});

await test('a fixed boundary overlap retries the exact persisted intent, then advances', async () => {
  const started = await start('pomodoro', 2);
  assert.equal(started.ok, true);
  failNextBreak = true;
  now += 1;
  await fire();
  let program = (await getFocusCycleResponse()).program;
  assert.equal(program.stage, 'break');
  const failed = commands.at(-1);
  assert.equal(failed.kind, 'pomodoro-start');
  assert.equal(program.pendingCommand.operationId, failed.operationId);
  const pendingBody = { operationId: failed.operationId, nowMs: failed.nowMs, durationMs: failed.durationMs, grantId: failed.grantId };
  now = program.stageEndsAtMs;
  const { __runFocusCycleForTest } = await import('../src/background/focus-cycles.ts?cycle-tests=1');
  await __runFocusCycleForTest();
  const retried = commands.at(-1);
  assert.deepEqual({ operationId: retried.operationId, nowMs: retried.nowMs, durationMs: retried.durationMs, grantId: retried.grantId }, pendingBody);
  program = (await getFocusCycleResponse()).program;
  assert.equal(program.cycle, 2);
  assert.equal(program.stage, 'work');
  assert.equal(program.pendingCommand.kind, 'reward');
});

await test('worker restart uses persisted pending commands instead of creating another reward', async () => {
  await cancelFocusCycle();
  const started = await start('focus');
  assert.equal(started.ok, true);
  const grantedBeforeRestart = started.program.pendingCommand;
  const restarted = await import('../src/background/focus-cycles.ts?cycle-restart=1');
  restarted.initFocusCycleScheduler();
  const newListener = alarmListeners.at(-1);
  now += 1;
  newListener({ name: 'focus-cycle-boundary' });
  for (let n = 0; n < 12; n++) await flush();
  const rewardsAfterRestart = commands.filter((command) => command.operationId === grantedBeforeRestart.operationId);
  assert.equal(rewardsAfterRestart.length, 1);
  assert.equal(restarted.__runFocusCycleForTest instanceof Function, true);
  assert.equal((await restarted.getFocusCycleResponse()).program, null);
});

await test('cancellation stops future work rewards and planned breaks', async () => {
  await cancelFocusCycle();
  const before = commands.length;
  const started = await start('pomodoro', 2);
  assert.equal(started.ok, true);
  await cancelFocusCycle();
  now += 10_000;
  await fire();
  assert.equal(commands.length, before);
  assert.equal((await getFocusCycleResponse()).program, null);
});

await test('cancellation during async start prevents any program from being armed', async () => {
  await cancelFocusCycle();
  authorityGate = deferred();
  const starting = start('focus');
  for (let n = 0; n < 3; n++) await flush();
  await cancelFocusCycle();
  authorityGate.resolve();
  const started = await starting;
  assert.equal(started.ok, false);
  assert.match(started.error, /cancelled/i);
  assert.equal((await getFocusCycleResponse()).program, null);
  authorityGate = null;
});

await test('cancelled start rejection cannot wipe a newer successful start', async () => {
  await cancelFocusCycle();
  const gateA = deferred();
  const gateB = deferred();
  authorityGates.push(gateA, gateB);
  const first = start('focus');
  for (let n = 0; n < 3; n++) await flush();
  await cancelFocusCycle();
  const second = start('focus');
  for (let n = 0; n < 3; n++) await flush();

  gateA.reject(new Error('injected start authority failure'));
  const failed = await first;
  assert.equal(failed.ok, false);
  assert.match(failed.error, /injected start authority failure/);

  // The cancelled attempt's finally must not free the newer attempt's claim.
  const third = await start('focus');
  assert.equal(third.ok, false);
  assert.match(third.error, /already active/i);

  gateB.resolve();
  const succeeded = await second;
  assert.equal(succeeded.ok, true);
  const stored = (await getFocusCycleResponse()).program;
  assert.ok(stored);
  assert.equal(stored.id, succeeded.program.id, 'the later start still owns the persisted program');
  await cancelFocusCycle();
});

await test('clock-rollback makes a stale pending reward terminal without retry spam', async () => {
  await cancelFocusCycle();
  alarmListeners.length = 0;
  initFocusCycleScheduler();
  const started = await start('focus');
  assert.equal(started.ok, true);
  const pendingId = started.program.pendingCommand.operationId;
  const before = commands.filter((command) => command.operationId === pendingId).length;
  stalePending = true;
  now += 1;
  await fire();
  assert.equal((await getFocusCycleResponse()).program, null);
  await fire();
  assert.equal(commands.filter((command) => command.operationId === pendingId).length, before + 1);
});

await test('malformed persistence does not fabricate a program or issuance list', async () => {
  values.focusCycleProgram = { version: 99, operationId: 'aaaa' };
  const before = commands.length;
  const restarted = await import('../src/background/focus-cycles.ts?cycle-corrupt=1');
  restarted.initFocusCycleScheduler();
  for (let n = 0; n < 12; n++) await flush();
  assert.equal((await restarted.getFocusCycleResponse()).program, null);
  assert.equal(commands.length, before);
});

console.log(`\n${passed} passed, 0 failed`);
Date.now = actualNow;
