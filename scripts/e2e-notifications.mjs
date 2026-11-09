// Focused notification e2e: options page wiring + real MV3 alarm
// reconciliation, with chrome.notifications.create stubbed in the service
// worker so the test never depends on an OS toast daemon.
//
//   npm run build:chrome
//   node scripts/e2e-notifications.mjs
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(
  process.env.SB_E2E_NOTIFICATIONS_PROFILE ?? '.e2e-notifications-profile',
);
const MINUTE = 60_000;

let passed = 0;
function ok(condition, label) {
  assert.equal(Boolean(condition), true, label);
  passed++;
  console.log(`PASS ${label}`);
}

// A fresh profile is intentional: defaults must be OFF for an existing-looking
// install, and a dedicated profile keeps this suite independent of the warm
// model/profile used by the longer e2es.
rmSync(PROFILE, { recursive: true, force: true });
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), {
  recursive: true,
  force: true,
});

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      const swPromise = context
        .waitForEvent('serviceworker', { timeout: 10_000 })
        .catch(() => null);
      const waker = await context.newPage();
      await waker.goto('https://example.com').catch(() => {});
      worker = context.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (worker) return { context, worker };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await context.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error('service worker did not boot after 3 launches');
}

async function waitFor(label, fn, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}

function currentWorker(context) {
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('service worker disappeared');
  return worker;
}

async function workerEval(context, fn, arg) {
  return currentWorker(context).evaluate(fn, arg);
}

async function alarms(context) {
  return workerEval(context, () => chrome.alarms.getAll());
}

/** Re-install the capture stub before every trigger. An MV3 service worker can
 *  be reaped between Playwright calls; the previous capture array is kept when
 *  the instance survives, and a restarted worker simply starts a new one. */
async function stubNotifications(context) {
  await workerEval(context, () => {
    globalThis.__sbNotifications = globalThis.__sbNotifications ?? [];
    chrome.notifications.create = (id, options) => {
      globalThis.__sbNotifications.push({ id, options });
      return Promise.resolve(id);
    };
  });
}

async function storedSettings(page) {
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings');
    return stored.settings ?? null;
  });
}

const { context, worker: firstWorker } = await launchWithServiceWorker();
const extensionId = new URL(firstWorker.url()).host;
console.log(`extension ${extensionId}`);

try {
  // --- page + defaults ---
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#notifications`);
  await page.waitForSelector('#page-heading');
  ok(
    (await page.locator('#page-heading').textContent()) === 'Notifications',
    'options page exposes the Notifications page',
  );
  ok(!(await page.locator('#notify-schedule-toggle').isChecked()), 'schedule reminder defaults OFF');
  ok(!(await page.locator('#notify-break-toggle').isChecked()), 'break reminder defaults OFF');
  ok(!(await page.locator('#notify-allowance-toggle').isChecked()), 'allowance reminder defaults OFF');
  ok(
    (await page.locator('#notify-schedule-lead').inputValue()) === '5',
    'default lead is 5 minutes',
  );

  // --- toggles persist with sanitized minute values ---
  await page.locator('#notify-schedule-toggle').check({ force: true });
  await page.fill('#notify-schedule-lead', '7');
  await page.locator('#notify-schedule-lead').press('Tab');
  await page.locator('#notify-break-toggle').check({ force: true });
  await page.fill('#notify-break-lead', '6');
  await page.locator('#notify-break-lead').press('Tab');
  await page.locator('#notify-allowance-toggle').check({ force: true });
  await page.fill('#notify-allowance-threshold', '4');
  await page.locator('#notify-allowance-threshold').press('Tab');

  const prefs = await waitFor('saved notification preferences', async () => {
    const settings = await storedSettings(page);
    const candidate = settings?.notificationPrefs;
    return candidate?.scheduleStartingSoon?.enabled &&
      candidate.scheduleStartingSoon.leadMinutes === 7 &&
      candidate.breakEndingSoon.enabled &&
      candidate.breakEndingSoon.leadMinutes === 6 &&
      candidate.allowanceLow.enabled &&
      candidate.allowanceLow.thresholdMinutes === 4
      ? candidate
      : null;
  });
  ok(prefs.version === 1, 'preference schema is versioned');
  console.log('  saved:', JSON.stringify(prefs));

  // Locked settings must disable the controls (writes would throw otherwise).
  const lockNow = Date.now();
  await page.evaluate(
    (lock) => chrome.storage.local.set({ lockState: lock }),
    {
      timerUntil: lockNow + 60 * MINUTE,
      passwordHash: null,
      frozenUntil: null,
      schedules: [],
      schedulesUpdatedAt: lockNow,
    },
  );
  await page.reload();
  await page.waitForSelector('#notify-schedule-toggle');
  ok(
    await page.locator('#notify-schedule-toggle').isDisabled(),
    'controls disable while locked',
  );
  await page.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: null,
        schedules: [],
        schedulesUpdatedAt: 0,
      },
    }),
  );
  await page.reload();
  await page.waitForSelector('#notify-schedule-toggle');
  ok(
    !(await page.locator('#notify-schedule-toggle').isDisabled()),
    'controls re-enable after the lock ends',
  );

  // Stub the OS notification call in the SW. Fixed IDs + a captured array
  // make dedupe and wording observable without a desktop notification server.
  await stubNotifications(context);

  // --- upcoming schedule reminder arms a one-shot alarm ---
  const seedSchedule = (minutesFromNow) => {
    const now = Date.now();
    const start = new Date(now + minutesFromNow * MINUTE);
    // Rules store whole local minutes; truncate so the test can compute the
    // exact absolute start the planner will use.
    start.setSeconds(0, 0);
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const endMinutes = (startMinutes + 60) % 1440;
    return {
      startAt: start.getTime(),
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: null,
        breakStartedAt: null,
        breakNotBefore: null,
        breakEndsAt: null,
        breakUpdatedAt: 0,
        schedules: [
          {
            id: 'e2e-focus-hours',
            days: [start.getDay()],
            startMinutes,
            endMinutes,
          },
        ],
        schedulesUpdatedAt: now,
      },
    };
  };

  const seededUpcoming = seedSchedule(10);
  await page.evaluate(
    (lock) => chrome.storage.local.set({ lockState: lock }),
    seededUpcoming.lockState,
  );
  const upcoming = await waitFor('upcoming schedule alarm', async () => {
    const all = await alarms(context);
    return all.find((alarm) => alarm.name === 'sb-notify:schedule-start') ?? null;
  });
  // The UI saved a 7-minute lead above; the alarm must land exactly there.
  const expectedWhen = seededUpcoming.startAt - 7 * MINUTE;
  ok(
    Math.abs(upcoming.scheduledTime - expectedWhen) < 2_000,
    'schedule reminder arms at start minus the configured lead',
  );

  // --- stale prefixed alarms are cleaned on reconcile ---
  await workerEval(context, async () => {
    // Worker-side evaluation has no Node constants; inline the minute.
    await chrome.alarms.create('sb-notify:stale', { when: Date.now() + 60_000 });
  });
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...stored.lockState, schedulesUpdatedAt: Date.now() },
    });
  });
  await waitFor('stale alarm cleanup', async () => {
    const all = await alarms(context);
    return !all.some((alarm) => alarm.name === 'sb-notify:stale');
  });
  ok(true, 'stale sb-notify:* alarms are cleared');

  // --- due schedule fires once, then arms the following start ---
  await stubNotifications(context);
  await page.evaluate(async (lock) => {
    await chrome.storage.local.set({
      notificationState: { version: 1, fired: {} },
      lockState: lock,
    });
  }, seedSchedule(2).lockState);
  const scheduleToast = await waitFor('schedule notification', async () => {
    const captured = await workerEval(context, () => globalThis.__sbNotifications ?? []);
    return (
      captured.find(
        (entry) => entry.id === 'smartblocker-notify-schedule-start',
      ) ?? null
    );
  });
  ok(scheduleToast.options.silent === true, 'reminders are silent');
  ok(
    /Focus hours start at/.test(scheduleToast.options.message),
    'schedule reminder uses clear wording',
  );
  await waitFor('next schedule alarm after firing', async () => {
    const all = await alarms(context);
    const alarm = all.find((a) => a.name === 'sb-notify:schedule-start');
    return alarm && alarm.scheduledTime > Date.now() + 20 * 60 * MINUTE;
  });
  ok(true, 'the following schedule start is armed without a page');

  const beforeDuplicate = await workerEval(
    context,
    () => (globalThis.__sbNotifications ?? []).length,
  );
  // A late duplicate alarm and a state touch both reconcile; neither may
  // redeliver the already-fired schedule start.
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...stored.lockState, schedulesUpdatedAt: Date.now() },
    });
    await chrome.alarms.create('sb-notify:schedule-start', {
      when: Date.now() + 50,
    });
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  const afterDuplicate = await workerEval(
    context,
    () => (globalThis.__sbNotifications ?? []).length,
  );
  ok(afterDuplicate === beforeDuplicate, 'a reconcile does not duplicate a fired reminder');

  // --- break ending soon ---
  await stubNotifications(context);
  const breakNow = Date.now();
  await page.evaluate(async (lock) => {
    await chrome.storage.local.set({
      notificationState: { version: 1, fired: {} },
      lockState: lock,
    });
  }, {
    timerUntil: null,
    passwordHash: null,
    frozenUntil: null,
    breakStartedAt: breakNow - MINUTE,
    breakNotBefore: null,
    breakEndsAt: breakNow + 2 * MINUTE,
    breakUpdatedAt: breakNow - MINUTE,
    schedules: [],
    schedulesUpdatedAt: 0,
  });
  const breakToast = await waitFor('break notification', async () => {
    const captured = await workerEval(context, () => globalThis.__sbNotifications ?? []);
    return captured.find((entry) => entry.id === 'smartblocker-notify-break-end') ?? null;
  });
  ok(
    /break ends at/i.test(breakToast.options.message),
    'break reminder says when blocking resumes',
  );

  // --- allowance nearly used up ---
  await stubNotifications(context);
  const allowanceNow = Date.now();
  const dayKey = new Date(allowanceNow);
  const key = `${dayKey.getFullYear().toString().padStart(4, '0')}-${(dayKey.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${dayKey.getDate().toString().padStart(2, '0')}`;
  const allowanceConfig = {
    dailyAllowanceMs: 30 * MINUTE,
    dailyOpenings: 0,
    waitingBaseMs: 0,
    waitingStepMs: 0,
    waitingMaxMs: 0,
    rewardCapMs: 0,
    openingInactivityMs: 120_000,
    openingMaxLifetimeMs: 30 * MINUTE,
  };
  const allowanceState = {
    version: 1,
    revision: 1,
    categories: {
      'video games': {
        config: allowanceConfig,
        ledger: {
          version: 1,
          dayKey: key,
          spentMs: 0,
          earnedRewardMs: 0,
          openingsUsed: 0,
          waitingEscalation: 0,
          lastObservedAtMs: allowanceNow,
          grant: {
            id: 'e2e-allowance',
            kind: 'allowance',
            status: 'active',
            requestedAtMs: allowanceNow - 8 * MINUTE,
            notBeforeMs: allowanceNow - 8 * MINUTE,
            endsAtMs: allowanceNow + 2 * MINUTE,
            durationMs: 10 * MINUTE,
            endedAtMs: null,
            endReason: null,
            chargedMs: 0,
            refundedMs: 0,
            lastActivityAtMs: null,
          },
        },
      },
    },
    receipts: [],
  };
  await page.evaluate(async (state) => {
    await chrome.storage.local.set({
      notificationState: { version: 1, fired: {} },
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: null,
        breakStartedAt: null,
        breakNotBefore: null,
        breakEndsAt: null,
        breakUpdatedAt: 0,
        schedules: [],
        schedulesUpdatedAt: 0,
      },
      allowanceAuthority: state,
    });
  }, allowanceState);
  const allowanceToast = await waitFor('allowance notification', async () => {
    const captured = await workerEval(context, () => globalThis.__sbNotifications ?? []);
    return (
      captured.find(
        (entry) => entry.id === 'smartblocker-notify-allowance-low',
      ) ?? null
    );
  });
  ok(
    /Video games allowance ends at/.test(allowanceToast.options.message),
    'allowance reminder names the category and end time',
  );

  // --- disabling everything clears the alarms and stops new toasts ---
  const beforeDisable = await workerEval(
    context,
    () => (globalThis.__sbNotifications ?? []).length,
  );
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings');
    const settings = stored.settings;
    settings.notificationPrefs = {
      version: 1,
      scheduleStartingSoon: { enabled: false, leadMinutes: 7 },
      breakEndingSoon: { enabled: false, leadMinutes: 6 },
      allowanceLow: { enabled: false, thresholdMinutes: 4 },
    };
    await chrome.storage.local.set({
      settings,
      notificationState: { version: 1, fired: {} },
    });
  });
  await waitFor('notification alarms cleared when disabled', async () => {
    const all = await alarms(context);
    return !all.some((alarm) => alarm.name.startsWith('sb-notify:'));
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  const afterDisable = await workerEval(
    context,
    () => (globalThis.__sbNotifications ?? []).length,
  );
  ok(afterDisable === beforeDisable, 'disabling reminders produces no new notifications');

  console.log(`\n${passed} checks passed`);
  await context.close();
} catch (error) {
  console.error(`\nFAIL ${error.stack ?? error.message}`);
  await context.close().catch(() => {});
  process.exitCode = 1;
}
