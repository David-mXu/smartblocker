// Item10 opening-activity observation: only live openings emit the throttled
// authenticated command, and the fallback authority path is exercised too.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const HARNESS = '__smartblockerAllowanceActivityTest';
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
    if (path.endsWith('/src/background/companion.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const getLiveAllowanceAuthority = () => globalThis.${HARNESS}.live;
export const isAllowanceAuthorityInitializing = () => false;
export const submitCompanionAllowanceCommand = () => globalThis.${HARNESS}.daemonCommand();`,
      };
    }
    if (path.endsWith('/src/shared/allowance-store.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const getLocalAllowanceAuthority = () => globalThis.${HARNESS}.local();
export const submitLocalAllowanceCommand = (command) => globalThis.${HARNESS}.submitLocal(command);
export const allowanceLocalDayKey = (date) => date.toISOString().slice(0, 10);`,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  applyAllowanceCommand,
  commitAllowanceCommandRevision,
  emptyAllowanceAuthorityState,
} = await import('../src/shared/allowance-state.ts');
const { recordAllowanceActivity, allowanceReliefForCategory } = await import('../src/background/allowance.ts');

const T0 = 1_800_000_000_000;
const DAY_KEY = new Date(T0).toISOString().slice(0, 10);
let now = T0;
Date.now = () => now;
const commands = [];
const id = (n) => n.toString(16).padStart(32, '0');
const category = 'video games';
const at = (nowMs = T0) => ({ nowMs, dayKey: DAY_KEY });
const config = { dailyAllowanceMs: 600_000, dailyOpenings: 1, waitingBaseMs: 0, waitingStepMs: 0, waitingMaxMs: 0, rewardCapMs: 60_000 };
function configured() {
  const configuredState = applyAllowanceCommand(emptyAllowanceAuthorityState(), {
    kind: 'configure', operationId: id(1), category, config,
  }, 0);
  assert.equal(configuredState.ok, true);
  return commitAllowanceCommandRevision(configuredState.state, 1, {
    kind: 'configure', operationId: id(1), category, config,
  });
}
function withOpening(grantId = 'opening-a') {
  const base = configured();
  const opened = applyAllowanceCommand(base, {
    kind: 'opening-start', operationId: id(2), category, grantId, ...at(),
  }, base.revision);
  assert.equal(opened.ok, true);
  assert.equal(opened.grant.kind, 'opening');
  return commitAllowanceCommandRevision(opened.state, base.revision + 1, {
    kind: 'opening-start', operationId: id(2), category, grantId, ...at(),
  });
}
function withOrdinary(grantId = 'ordinary-a') {
  const base = configured();
  const requested = applyAllowanceCommand(base, {
    kind: 'request', operationId: id(3), category, grantId, durationMs: 60_000, ...at(),
  }, base.revision);
  assert.equal(requested.ok, true);
  assert.equal(requested.grant.kind, 'allowance');
  return commitAllowanceCommandRevision(requested.state, base.revision + 1, {
    kind: 'request', operationId: id(3), category, grantId, durationMs: 60_000, ...at(),
  });
}

let live = withOpening();
let local = live;
globalThis[HARNESS] = {
  get live() { return live; },
  set live(value) { live = value; },
  local: () => local,
  setLocal(value) { local = value; },
  daemonCommand: () => null,
  submitLocal: (command) => {
    commands.push(structuredClone(command));
    return { ok: true, state: local, kind: command.kind, category: command.category, grant: null };
  },
};

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('allowance opening-activity tests');
await test('active opening emits one authenticated activity command, then throttles for five seconds', async () => {
  now = T0 + 1_000;
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, 'opening-activity');
  assert.equal(commands[0].grantId, 'opening-a');
  assert.equal(commands[0].category, category);
  assert.equal(commands[0].nowMs, T0 + 1_000);

  now = T0 + 2_000;
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 1, 'a second classified activity inside the window is throttled');

  now = T0 + 7_000;
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 2, 'activity after the interval advances the durable observation');
  assert.equal(commands[1].nowMs, T0 + 7_000);
});

await test('ordinary and absent grants never send opening activity', async () => {
  live = withOrdinary();
  local = live;
  now = T0 + 30_000;
  const relief = await allowanceReliefForCategory(category);
  assert.equal(relief?.kind, 'allowance');
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 2, 'ordinary allowance relief is not an opening activity');

  live = configured();
  local = live;
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 2, 'no live grant has nothing to observe');
});

await test('fallback authority uses the same opening-only throttled command path', async () => {
  live = null;
  local = withOpening('opening-b');
  now = T0 + 100_000;
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 3);
  assert.equal(commands.at(-1).kind, 'opening-activity');
  assert.equal(commands.at(-1).grantId, 'opening-b');
  await recordAllowanceActivity(category);
  assert.equal(commands.length, 3);
});

console.log(`\n${passed} passed, 0 failed`);
