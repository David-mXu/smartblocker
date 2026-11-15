// Auto-resume enforcer harness: drives the REAL src/background/resume-enforcer.ts
// against a mocked chrome-like api with in-memory storage — the same
// direct-Node-import approach as scripts/usage-stats-test.mjs (Node >= 22.15
// type stripping; no browser or test runner). ZERO source seams: the module is
// imported as-is and only the `chrome` global it binds through shared/api.ts
// is faked (installed BEFORE the dynamic imports so `api` binds the mock).
//
// Pins the enforcer's derived state machine:
//   1. the onboarded gate on BOTH paths — the armed-plan read (readArmedPlan
//      returns null pre-onboarding) and the alarm-listener bypass (resumeNow
//      re-checks, bails, and clears the one-shot alarm);
//   2. lock deferral — a timed lock re-arms at lock end + 1s and preserves the
//      plan; an indefinite password lock clears the alarm and the next
//      syncResume after unlock fires the still-armed plan;
//   3. startup semantics — storage.session cold-boot marker: runtime.onStartup
//      and a cold browser start fire, an SW reap within the session never does;
//   4. missed-while-asleep — overdue instants fire at the next sync; a manual
//      re-enable clears resumeAt but keeps the mode and a stale alarm no-ops;
//   5. schedule-start targeting — the resume instant is the real window start
//      (a settings-lock lead never moves it) and a live window defers to end.
//
//   node scripts/resume-enforcer-test.mjs
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Production imports are extensionless for Vite; resolve them to TypeScript.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !specifier.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Mocked chrome (must exist BEFORE importing any src module: shared/api.ts
// binds `chrome` at import time — see usage-stats-test.mjs for the precedent).
// ---------------------------------------------------------------------------

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

// Pending-operation counter + settle(): the enforcer fires many async chains
// with `void` (alarm listener, init boot, storage-change handling), so a test
// cannot just await its own calls. Every mocked async method passes through
// track(), keeping `pending` > 0 while any chain still holds a mock call
// in flight; settle() drains macrotask-by-macrotask until nothing is left.
let pending = 0;
function track(fn) {
  return function (...args) {
    pending++;
    let result;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      pending--;
      throw error;
    }
    return Promise.resolve(result).finally(() => {
      pending--;
    });
  };
}

async function settle() {
  for (let i = 0; i < 1000; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (pending === 0) {
      // One quiet macrotask after `pending` hits zero lets post-await tails
      // run and still be caught if they issue another tracked call.
      await new Promise((resolve) => setImmediate(resolve));
      if (pending === 0) return;
    }
  }
  throw new Error('mocked chrome event loop did not settle (enforcer in a loop?)');
}

const makeEvent = () => {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
};

const onChanged = makeEvent();

// Writes made through the module context (setSettings → storage.local.set).
// Raw seeds below bypass these counters on purpose: only the enforcer-driven
// writes land here, so "did it touch settings?" deltas stay exact.
let settingsWriteCount = 0;
const togglesOn = []; // writes whose full settings carried enabled false→true

const localMap = new Map();
const sessionMap = new Map();

function makeArea(name, store) {
  return {
    get: track(function (keys) {
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) if (store.has(key)) result[key] = clone(store.get(key));
      return result;
    }),
    set: track(function (items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        const previous = store.has(key) ? store.get(key) : undefined;
        if (name === 'local' && key === 'settings') {
          settingsWriteCount++;
          if (previous?.enabled === false && value?.enabled === true) togglesOn.push(clone(value));
        }
        changes[key] = { oldValue: clone(previous), newValue: clone(value) };
        store.set(key, clone(value));
      }
      // Real Chrome emits storage.onChanged for every local.set, including the
      // enforcer's own writes — that is what re-triggers syncResume/idempotence.
      if (name === 'local' && Object.keys(changes).length > 0) onChanged.emit(changes, name);
    }),
    remove: track(function (keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    }),
  };
}

const alarmEvent = makeEvent();
const startupEvent = makeEvent();
const alarms = {
  created: [], // { name, ...info } — one-shot only here: { when }
  cleared: [],
  onAlarm: alarmEvent,
  create: track((name, info) => {
    alarms.created.push({ name, ...(info ?? {}) });
  }),
  clear: track((name) => {
    alarms.cleared.push(name);
    return true;
  }),
};

const previousChrome = globalThis.chrome;
globalThis.chrome = {
  storage: {
    local: makeArea('local', localMap),
    session: makeArea('session', sessionMap), // does not emit onChanged (matches tests' needs)
    onChanged,
  },
  alarms,
  runtime: {
    onStartup: startupEvent,
    getURL: (path) => `chrome-extension://smartblocker-test/${path}`,
  },
  // api.notifications deliberately absent: the shipped manifests carry no
  // "notifications" permission, so notifyResumed() must no-op safely — pin
  // that every fire below succeeds without it.
};

// Controlled clock: the enforcer and the pure time math all take Date.now()
// or `new Date(t)` at call time, so tests can jump across resume instants.
const realDateNow = Date.now;
let NOW = Date.UTC(2026, 10, 15, 12, 0, 0); // 2026-11-15T12:00:00Z, fixed base
Date.now = () => NOW;

const { initResumeEnforcer } = await import('../src/background/resume-enforcer.ts');
const { DEFAULTS } = await import('../src/shared/settings.ts');
const { EMPTY_LOCK_STATE } = await import('../src/shared/lock-math.ts');
const { RESUME_ALARM_NAME, nextScheduleStart } = await import('../src/shared/resume.ts');

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

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

const storedSettings = () => localMap.get('settings');
const resumeCreates = () => alarms.created.filter((entry) => entry.name === RESUME_ALARM_NAME);
const resumeClearCount = () => alarms.cleared.filter((name) => name === RESUME_ALARM_NAME).length;
const snapshot = () => ({
  created: resumeCreates().length,
  cleared: resumeClearCount(),
  writes: settingsWriteCount,
  toggles: togglesOn.length,
});

/** Write a storage key directly (as another surface — options page, popup,
 *  DevTools, or a fresh seed would) and deliver the storage.onChanged diff.
 *  This is the ONLY way tests set state: putCrossContext exactly mirrors what
 *  the enforcer can actually observe. */
async function putCrossContext(key, value) {
  const previous = localMap.has(key) ? localMap.get(key) : undefined;
  localMap.set(key, clone(value));
  onChanged.emit({ [key]: { oldValue: clone(previous), newValue: clone(value) } }, 'local');
  await settle();
}

const seedSettings = (overrides = {}) => putCrossContext('settings', { ...DEFAULTS, ...overrides });
const seedLock = (overrides = {}) => putCrossContext('lockState', { ...EMPTY_LOCK_STATE, ...overrides });

async function fireResumeAlarm() {
  alarmEvent.emit({ name: RESUME_ALARM_NAME });
  await settle();
}
async function fireStartup() {
  startupEvent.emit();
  await settle();
}

/** Simulate an MV3 service-worker boot running initResumeEnforcer. The first
 *  call registers the one permanent listener set; later calls simulate SW
 *  restarts and their listener copies are truncated away afterwards so every
 *  single event still fans out to exactly ONE enforcer handler (the copies
 *  only exist to run the boot block: isColdBoot + syncResume + maybeResume).
 *  The settings/lock cache listeners added at import time are untouched. */
let bootedOnce = false;
async function swBoot() {
  if (!bootedOnce) {
    bootedOnce = true;
    initResumeEnforcer();
    await settle();
    return;
  }
  const alarmCount = alarmEvent.listeners.length;
  const startupCount = startupEvent.listeners.length;
  const changeCount = onChanged.listeners.length;
  initResumeEnforcer();
  await settle();
  alarmEvent.listeners.length = alarmCount;
  startupEvent.listeners.length = startupCount;
  onChanged.listeners.length = changeCount;
}

const armed = (mode, extra = {}) => ({ onboarded: true, enabled: false, resumeMode: mode, ...extra });

console.log('auto-resume enforcer (src/background/resume-enforcer.ts) tests');

// ---------------------------------------------------------------------------
// 1. The onboarded gate — both the plan path and the alarm-listener bypass
// ---------------------------------------------------------------------------

await test('pre-onboarding armed time plan never arms, never toggles, plan preserved', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
  const before = snapshot();
  // enabled:false + resumeMode 'time' + a pending instant is EXACTLY the
  // shape a never-onboarded install can be left in — the gate must see it.
  await seedSettings({ onboarded: false, enabled: false, resumeMode: 'time', resumeAt: NOW + 3_600_000 });
  await swBoot(); // first SW boot: syncResume runs on the plan read path
  const after = snapshot();
  assert.equal(after.created - before.created, 0, 'pre-onboarding plan must not arm an alarm');
  assert.ok(after.cleared > before.cleared, 'inert plan must still clear any stale resume alarm');
  assert.equal(after.writes - before.writes, 0, 'no settings write may happen');
  assert.equal(after.toggles - before.toggles, 0, 'the master switch must stay off');
  assert.equal(storedSettings().enabled, false);
  assert.equal(storedSettings().resumeAt, NOW + 3_600_000, 'plan preserved untouched');
  assert.ok(sessionMap.has('resumeBootId'), 'SW boot must create the cold-start marker');
});

await test('a stale fired resume-at alarm bails AND clears on a never-onboarded install', async () => {
  // The alarm listener calls resumeNow DIRECTLY, bypassing readArmedPlan — the
  // onboarded gate must be re-checked inside resumeNow, and a stale one-shot
  // alarm must be cleared there so it cannot keep waking the SW.
  NOW = Date.UTC(2026, 10, 15, 12, 0, 30);
  await seedLock();
  await seedSettings({ onboarded: false, enabled: false, resumeMode: 'time', resumeAt: NOW + 3_600_000 });
  const before = snapshot();
  // A stale alarm armed by an earlier SW generation (pre-dating the gate):
  alarms.created.push({ name: RESUME_ALARM_NAME, when: NOW + 1 });
  await fireResumeAlarm();
  const after = snapshot();
  assert.ok(after.cleared > before.cleared, 'resumeNow must clear the stale alarm');
  assert.equal(after.writes - before.writes, 0, 'resumeNow must not write anything');
  assert.equal(after.toggles - before.toggles, 0, 'the master switch must stay off');
  assert.equal(storedSettings().enabled, false);
  assert.equal(storedSettings().resumeAt, NOW + 3_600_000, 'plan preserved for onboarding to arm later');
  // An unrelated alarm name must be ignored entirely.
  const mid = snapshot();
  alarmEvent.emit({ name: 'lock-boundary' });
  await settle();
  assert.equal(snapshot().writes - mid.writes, 0);
  assert.equal(snapshot().toggles - mid.toggles, 0);
});

await test('an unknown stored mode normalizes to off and never arms', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 1, 0);
  const before = snapshot();
  await seedSettings({ onboarded: true, enabled: false, resumeMode: 'bogus', resumeAt: NOW + 60_000 });
  const after = snapshot();
  assert.equal(after.created - before.created, 0, 'unknown mode must not arm');
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
});

await test('the same armed state on an ONBOARDED install arms at the exact stored instant', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 2, 0);
  await seedLock();
  const before = snapshot();
  await seedSettings(armed('time', { resumeAt: NOW + 3_600_000 }));
  const after = snapshot();
  assert.equal(after.created - before.created, 1, 'exactly one one-shot alarm');
  assert.equal(resumeCreates().at(-1).when, NOW + 3_600_000, 'armed at the stored instant');
  assert.equal(after.writes - before.writes, 0);
  assert.equal(storedSettings().enabled, false);
});

await test('firing the armed alarm flips enabled on, nulls resumeAt, keeps the mode', async () => {
  // Continues the previous scenario's armed state.
  const before = snapshot();
  await fireResumeAlarm();
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 1, 'exactly one enabling write');
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeAt, null, 'fired resume nulls its instant');
  assert.equal(storedSettings().resumeMode, 'time', 'mode survives for the next disable');
  assert.ok(after.cleared > before.cleared, 'the one-shot alarm is cleared after firing');
  assert.ok(after.writes - before.writes >= 1);
  // Idempotence: the write woke the storage listener, and a second (racing)
  // alarm must no-op now that blocking is on.
  const mid = snapshot();
  await fireResumeAlarm();
  assert.equal(snapshot().toggles - mid.toggles, 0, 'second fire must not write again');
  assert.equal(snapshot().writes - mid.writes, 0);
});

await test('blocking already enabled: the plan is inert and an alarm fire writes nothing', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 3, 0);
  const before = snapshot();
  await seedSettings({ onboarded: true, enabled: true, resumeMode: 'time', resumeAt: NOW + 3_600_000 });
  const mid = snapshot();
  assert.equal(mid.created - before.created, 0, 'no alarm while enabled');
  assert.ok(mid.cleared > before.cleared, 'stray resumeAt still disarmed via the alarm slot');
  await fireResumeAlarm();
  const after = snapshot();
  assert.equal(after.writes - mid.writes, 0, 'an enabled install must not write');
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeAt, NOW + 3_600_000, 'untouched — resume only applies while disabled');
});

// ---------------------------------------------------------------------------
// 2. Never fires while a lock is active
// ---------------------------------------------------------------------------

await test('a timed lock defers the resume: re-armed at lock end +1s, plan preserved', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 4, 0);
  await seedLock();
  await seedSettings(armed('time', { resumeAt: NOW + 1_800_000 }));
  // Seed the lock LAST and snapshot after it: that storage change triggers a
  // syncResume which legitimately (re)arms the time alarm — the delta below
  // must isolate the alarm-fire defer path, not the seeding.
  await seedLock({ timerUntil: NOW + 600_000 });
  const before = snapshot();
  await fireResumeAlarm();
  const after = snapshot();
  assert.equal(after.created - before.created, 1, 'the defer path creates exactly the replacement alarm');
  assert.equal(resumeCreates().at(-1).when, NOW + 600_000 + 1000, 'deferred to just past the lock end');
  assert.equal(after.writes - before.writes, 0, 'no settings write mid-lock (setSettings would throw)');
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
  assert.equal(storedSettings().resumeAt, NOW + 1_800_000, 'plan survives in settings');
  assert.equal(storedSettings().resumeMode, 'time');
});

await test('once the timed lock ends, the deferred resume fires', async () => {
  // Continues the previous scenario: timerUntil was NOW₀ + 600s; jump past it.
  NOW = Date.UTC(2026, 10, 15, 12, 4, 0) + 602_000;
  const before = snapshot();
  await fireResumeAlarm();
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 1);
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeAt, null);
});

await test('an indefinite password lock clears the alarm and flips nothing (deferral, not drop)', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 20, 0);
  await seedLock();
  await seedSettings(armed('time', { resumeAt: NOW + 1_000 }));
  await seedLock({ passwordHash: 'ab'.repeat(32), passwordTs: NOW });
  // Snapshot after the lock seed: syncResume still arms time-mode alarms while
  // locked (arming is harmless — firing defers), so the delta below counts
  // only what the pre-locked alarm FIRE does.
  const before = snapshot();
  await fireResumeAlarm();
  const after = snapshot();
  assert.equal(after.created - before.created, 0, 'no until → nothing to re-arm to');
  assert.ok(after.cleared > before.cleared, 'the one-shot alarm is cleared');
  assert.equal(after.writes - before.writes, 0);
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
  assert.equal(storedSettings().resumeAt, NOW + 1_000, 'the armed plan survives the lock');
});

await test('after the password unlock, the next syncResume fires the still-armed overdue plan', async () => {
  // Continues the previous scenario: resumeAt was set at 12:20:00+1s; advance
  // past it, then release the password lock (tombstone stamp, hash null). The
  // lockState storage change is what wakes the enforcer (lockState-write →
  // syncResume), exactly as production: no event exists for "unlock" itself.
  NOW = Date.UTC(2026, 10, 15, 12, 20, 0) + 20_000;
  const before = snapshot();
  await seedLock({ passwordTs: NOW }); // passwordHash null again
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 1, 'the lockState change listener fires the overdue resume');
  assert.equal(after.writes - before.writes, 1, 'the fire is exactly one enabling write');
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeAt, null);
  assert.equal(storedSettings().resumeMode, 'time');
  // Nothing left to fire: a further lock churn must not toggle anything.
  const mid = snapshot();
  await seedLock();
  assert.equal(snapshot().toggles - mid.toggles, 0);
});

// ---------------------------------------------------------------------------
// 3. Startup semantics — cold boot vs service-worker reap
// ---------------------------------------------------------------------------

await test("runtime.onStartup fires an armed 'startup' plan and arms no clock alarm", async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 30, 0);
  await seedLock();
  const before = snapshot();
  await seedSettings(armed('startup'));
  const mid = snapshot();
  assert.equal(mid.created - before.created, 0, "'startup' is event-driven: no clock trigger");
  await fireStartup();
  const after = snapshot();
  assert.equal(after.toggles - mid.toggles, 1);
  assert.equal(storedSettings().enabled, true);
});

await test("onStartup does nothing for armed 'time' plans", async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 31, 0);
  await seedLock();
  await seedSettings(armed('time', { resumeAt: NOW + 3_600_000 }));
  const before = snapshot();
  await fireStartup();
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
});

await test("an SW reap within the browser session (session marker present) never fires 'startup'", async () => {
  // maybeResumeStartup's documented choice: 'startup' means next BROWSER
  // session, not next MV3 service-worker boot. storage.session survives SW
  // reaps, so a warm boot marker = reap = stay inert.
  NOW = Date.UTC(2026, 10, 15, 12, 32, 0);
  await seedLock();
  await seedSettings(armed('startup'));
  const before = snapshot();
  assert.ok(sessionMap.has('resumeBootId'), 'precondition: an earlier boot left the session marker');
  await swBoot(); // SW restart inside the same browser session
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
});

await test("a cold browser start (storage.session gone) fires 'startup' via the boot catch-up", async () => {
  // The cold-start catch-up exists for a browser start whose onStartup raced
  // or never reached us. Dropping storage.session models the process exit.
  NOW = Date.UTC(2026, 10, 15, 12, 33, 0);
  await seedLock();
  await seedSettings(armed('startup'));
  const before = snapshot();
  sessionMap.clear(); // browser process exit discards storage.session
  assert.ok(!sessionMap.has('resumeBootId'), 'precondition: cold boot, no marker yet');
  await swBoot();
  const after = snapshot();
  assert.equal(after.toggles - before.toggles, 1, 'the boot catch-up must fire the armed plan');
  assert.equal(storedSettings().enabled, true);
  assert.ok(sessionMap.has('resumeBootId'), 'boot re-creates the marker for later SW reaps');
});

// ---------------------------------------------------------------------------
// 4. Missed-while-asleep + manual re-enable disarm
// ---------------------------------------------------------------------------

await test('missed-while-asleep: an overdue instant fires at the next sync; future instants arm exactly', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 40, 0);
  await seedLock();
  const before = snapshot();
  await seedSettings(armed('time', { resumeAt: NOW + 120_000 }));
  assert.equal(resumeCreates().at(-1).when, NOW + 120_000, 'future instant arms exactly, no clamp');
  // The browser sleeps past the instant. The next syncResume re-derives from
  // stored state (any settings/lockState change or SW boot), clamps the past
  // instant to now, and fires immediately — nothing is lost to the sleep. A
  // lockState churn stands in for that wake-up event.
  const mid = snapshot();
  NOW += 600_000;
  await seedLock({ schedules: [] });
  const after = snapshot();
  assert.equal(after.toggles - mid.toggles, 1, 'overdue resume fires on wake');
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeAt, null);
  assert.equal(storedSettings().resumeMode, 'time');
});

await test('manual re-enable clears resumeAt, keeps the mode; stale alarm no-ops; re-arms on a fresh instant', async () => {
  NOW = Date.UTC(2026, 10, 15, 13, 0, 0);
  await seedLock();
  await seedSettings(armed('time', { resumeAt: NOW + 3_600_000 }));
  const before = snapshot();
  assert.equal(resumeCreates().at(-1).when, NOW + 3_600_000);
  // The user flips the master toggle back on from the popup: a settings
  // storage change from another surface (oldValue.enabled false → true).
  await seedSettings({ onboarded: true, enabled: true, resumeMode: 'time', resumeAt: NOW + 3_600_000 });
  const mid = snapshot();
  assert.equal(mid.toggles - before.toggles, 0, 'disarm writes resumeAt, never the switch');
  assert.equal(mid.writes - before.writes, 1, 'exactly one disarm write (resumeAt → null)');
  assert.equal(storedSettings().resumeAt, null, 're-enabling clears the pending instant');
  assert.equal(storedSettings().resumeMode, 'time', 'the mode survives for the next disable');
  assert.equal(storedSettings().enabled, true);
  // The stale alarm still fires once — must no-op completely.
  await fireResumeAlarm();
  const stale = snapshot();
  assert.equal(stale.toggles - mid.toggles, 0);
  assert.equal(stale.writes - mid.writes, 0);
  assert.equal(storedSettings().enabled, true);
  // Next disable with no instant: mode 'time' + resumeAt null has no clock
  // trigger — inert until the user picks a new instant.
  await seedSettings(armed('time', { resumeAt: null }));
  const redisabled = snapshot();
  assert.equal(redisabled.created - stale.created, 0, 'null instant must not arm');
  assert.equal(storedSettings().enabled, false);
  await seedSettings(armed('time', { resumeAt: NOW + 1_800_000 }));
  const rearmed = snapshot();
  assert.equal(rearmed.created - redisabled.created, 1, 'a fresh instant re-arms exactly once');
  assert.equal(resumeCreates().at(-1).when, NOW + 1_800_000);
});

// ---------------------------------------------------------------------------
// 5. Schedule-start resume
// ---------------------------------------------------------------------------

await test('schedule mode targets the real window start (settings-lock lead ignored), defers inside it', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 0, 0); // Sunday 2026-11-15, 12:00 UTC
  const day = new Date(NOW).getUTCDay();
  const rule = {
    id: 'focus-hours',
    label: 'Focus hours',
    days: [day],
    startMinutes: 13 * 60, // 13:00 — still ahead of NOW
    endMinutes: 14 * 60,
    tzOffsetMinutes: 0, // pinned to UTC (TZ=UTC keeps local == UTC here)
    leadMinutes: 15, // settings freeze at 12:45 — must NOT move the resume
  };
  const windowStart = nextScheduleStart([rule], NOW);
  assert.equal(windowStart, Date.UTC(2026, 10, 15, 13, 0, 0), 'sanity: today 13:00 UTC');
  assert.notEqual(windowStart, Date.UTC(2026, 10, 15, 12, 45, 0), 'sanity: lead must not move it');
  await seedLock({ schedules: [rule] });
  const before = snapshot();
  await seedSettings(armed('schedule'));
  const after = snapshot();
  assert.equal(after.created - before.created, 1);
  assert.equal(resumeCreates().at(-1).when, windowStart, 'armed at the real window start');
  assert.equal(storedSettings().enabled, false);
  // Fire mid-window: the schedule is itself a settings lock — the resume must
  // defer to just past the window end, exactly like a timed lock.
  NOW = windowStart + 30 * 60_000;
  const mid = snapshot();
  await fireResumeAlarm();
  const deferred = snapshot();
  assert.equal(deferred.created - mid.created, 1);
  assert.equal(
    resumeCreates().at(-1).when,
    Date.UTC(2026, 10, 15, 14, 0, 0) + 1000,
    'defers to the window end + 1s',
  );
  assert.equal(deferred.toggles - mid.toggles, 0);
  assert.equal(deferred.writes - mid.writes, 0);
  assert.equal(storedSettings().enabled, false);
  // Window over: the deferred resume fires.
  NOW = Date.UTC(2026, 10, 15, 14, 0, 30);
  await fireResumeAlarm();
  const fired = snapshot();
  assert.equal(fired.toggles - deferred.toggles, 1);
  assert.equal(storedSettings().enabled, true);
  assert.equal(storedSettings().resumeMode, 'schedule');
});

await test('schedule mode with no schedules stays inert', async () => {
  NOW = Date.UTC(2026, 10, 15, 12, 5, 0);
  await seedLock();
  const before = snapshot();
  await seedSettings(armed('schedule'));
  const after = snapshot();
  assert.equal(after.created - before.created, 0, 'no clock trigger without rules');
  assert.ok(after.cleared > before.cleared, 'any stale alarm is cleared');
  assert.equal(after.toggles - before.toggles, 0);
  assert.equal(storedSettings().enabled, false);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);

Date.now = realDateNow;
if (previousChrome === undefined) delete globalThis.chrome;
else globalThis.chrome = previousChrome;
if (failed) process.exitCode = 1;
