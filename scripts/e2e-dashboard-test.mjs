// Real-browser dashboard check: live extension state, seeded schedules,
// countdowns, relief copy, timeline text equivalents, and responsive layout.
// Run after `npm run build:chrome`.
//
//   node scripts/e2e-dashboard-test.mjs
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const PROFILE = mkdtempSync('/tmp/opencode/smartblocker-dashboard-profile-');
const MINUTE = 60_000;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
}
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      // Page/SW still starting.
    }
    await sleep(150);
  }
  console.log(`… poll timed out: ${label}`);
  return false;
}

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  check(Boolean(sw), 'extension service worker booted');

  await sw.evaluate(async () => chrome.storage.local.clear());
  const now = Date.now();
  await sw.evaluate(
    async ({ now, minute }) => {
      const date = new Date(now);
      const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const wallMinutes = date.getHours() * 60 + date.getMinutes();
      const wrap = (value) => ((value % 1440) + 1440) % 1440;
      const globalStart = wrap(wallMinutes - 30);
      const globalEnd = wrap(wallMinutes + 30);
      const categoryStart = wrap(wallMinutes - 15);
      const categoryEnd = wrap(wallMinutes + 15);
      const offset = -date.getTimezoneOffset();
      const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

      const config = {
        dailyAllowanceMs: 10 * minute,
        dailyOpenings: 1,
        waitingBaseMs: 0,
        waitingStepMs: 0,
        waitingMaxMs: 0,
        rewardCapMs: 0,
        openingInactivityMs: 120_000,
        openingMaxLifetimeMs: 30 * minute,
      };
      const grant = {
        id: 'dashboard-e2e-grant',
        kind: 'allowance',
        status: 'active',
        requestedAtMs: now - minute,
        notBeforeMs: now - minute,
        endsAtMs: now + 4 * minute,
        durationMs: 5 * minute,
        endedAtMs: null,
        endReason: null,
        chargedMs: 0,
        refundedMs: 0,
        lastActivityAtMs: null,
      };
      await chrome.storage.local.set({
        settings: {
          enabled: true,
          onboarded: true,
          focusGoal: 'Finish the dashboard',
          resumeMode: 'time',
          resumeAt: now + 20 * minute,
          breakMode: 'delay',
          breakDelayMinutes: 5,
          breakDurationMinutes: 10,
        },
        lockState: {
          timerUntil: now + 10 * minute,
          passwordHash: null,
          frozenUntil: now + 25 * minute,
          schedules: [
            {
              id: 'e2e-global',
              days: ALL_DAYS,
              startMinutes: globalStart,
              endMinutes: globalEnd,
              tzOffsetMinutes: offset,
              tzName: 'Local',
            },
          ],
          categorySchedules: [
            {
              id: 'e2e-category',
              days: ALL_DAYS,
              startMinutes: categoryStart,
              endMinutes: categoryEnd,
              tzOffsetMinutes: offset,
              tzName: 'Local',
              categories: ['video games', 'online shopping'],
            },
          ],
        },
        pendingFocusSession: {
          until: now + 2 * 60 * minute,
          commitAt: now + 5 * minute,
          durationMs: 2 * 60 * minute,
        },
        allowanceAuthority: {
          version: 1,
          revision: 1,
          categories: {
            'video games': {
              config,
              ledger: {
                version: 1,
                dayKey,
                spentMs: 0,
                earnedRewardMs: 0,
                openingsUsed: 0,
                waitingEscalation: 0,
                lastObservedAtMs: now,
                grant,
              },
            },
          },
          receipts: [],
        },
      });
    },
    { now, minute: MINUTE },
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#dashboard`);
  const ready = await poll(() => page.locator('#dashboard-now').count().then((count) => count > 0), 20_000, 'dashboard renders');
  check(ready, 'options route #dashboard renders');

  const nav = page.locator('nav[aria-label="Settings pages"] a');
  check((await nav.first().getAttribute('href')) === '#dashboard', 'dashboard is first in navigation');
  check((await nav.first().getAttribute('aria-current')) === 'page', 'dashboard is the active navigation item');
  check(
    (await page.title()).startsWith('Now — SmartBlocker'),
    'document title reflects the dashboard route',
    await page.title(),
  );

  check(
    (await page.locator('#dashboard-blocking').textContent())?.includes('Blocking on') ?? false,
    'Now shows blocking enabled',
  );
  check(
    (await page.locator('#dashboard-lock-summary').textContent())?.includes('All locks end at') ?? false,
    'Now shows a truthful aggregate lock end',
  );
  const reasonCount = await page.locator('#dashboard-lock-reasons li').count();
  check(reasonCount >= 3, 'Now lists timer, focus-session and focus-hours lock reasons', `count ${reasonCount}`);
  check(
    (await page.locator('#dashboard-next-global').textContent())?.includes('ends at') ?? false,
    'Next shows the global focus-hour transition as an end',
  );
  check(
    (await page.locator('#dashboard-next-category').textContent())?.includes('video games') ?? false,
    'Next includes the category schedule and its categories',
  );
  check(
    /\d{1,2}:\d{2}\s?(AM|PM)/.test((await page.locator('#dashboard-next-global').textContent()) ?? ''),
    'Next displays a local clock time',
  );
  check(
    /\d{1,2}:\d{2}\s?(AM|PM)/.test((await page.locator('#dashboard-next-resume').textContent()) ?? ''),
    'Next shows the armed auto-resume time',
  );
  check(
    (await page.locator('#dashboard-next-focus').textContent())?.includes('undo until') ?? false,
    'Next shows the pending focus commit and undo window',
  );
  check(
    (await page.locator('#dashboard-relief-statement').textContent())?.includes('classifier verdicts') ?? false,
    'Relief explicitly limits itself to classifier verdicts',
  );
  check(
    (await page.locator('#dashboard-relief-statement').textContent())?.includes('desktop enforcement') ?? false,
    'Relief states that desktop enforcement remains',
  );
  check(
    (await page.locator('#dashboard-relief-break').textContent())?.includes('5-minute wait') ?? false,
    'Relief shows the configured break mode',
  );
  check(
    (await page.locator('#dashboard-relief').textContent())?.includes('video games — allowance') ?? false,
    'Relief shows the live allowance grant from local authority',
  );
  check(
    (await page.locator('#dashboard-timeline-now').textContent())?.includes('Now ·') ?? false,
    'timeline shows the live now marker label',
  );
  const globalSegments = await page.locator('#dashboard-timeline-global .dashboard-timeline-segment').count();
  const categorySegments = await page.locator('#dashboard-timeline-category .dashboard-timeline-segment').count();
  check(globalSegments > 0, 'global timeline lane has today segments', `count ${globalSegments}`);
  check(categorySegments > 0, 'category timeline lane has today segments', `count ${categorySegments}`);
  const textEquivalents = await page.locator('#dashboard-timeline-text li').allTextContents();
  const timelineText = (await page.locator('#dashboard-timeline-text').textContent()) ?? '';
  check(textEquivalents.length >= 2, 'timeline exposes textual equivalents', `count ${textEquivalents.length}`);
  check(
    timelineText.includes('Focus hours') && timelineText.includes('video games'),
    'textual equivalents name both schedule lanes',
  );

  const companionText = (await page.locator('#dashboard-companion').textContent()) ?? '';
  check(
    /not installed|Connecting|Connected|Disconnected|Checking/.test(companionText),
    'companion health is reported',
    companionText,
  );

  // Live state: a short timer appears, then disappears without a reload.
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...stored.lockState, timerUntil: Date.now() + 1_500 },
    });
  });
  check(
    await poll(() => page.locator('#dashboard-lock-reasons').textContent().then((text) => text?.includes('Timer lock') ?? false), 5_000, 'timer reason appears live'),
    'dashboard reacts to a live lock-state write',
  );
  check(
    await poll(() => page.locator('#dashboard-lock-reasons').textContent().then((text) => !(text?.includes('Timer lock') ?? true)), 6_000, 'timer reason expires live'),
    'dashboard drops an expired timer without a reload',
  );

  const bodyText = (await page.locator('body').textContent()) ?? '';
  check(!bodyText.includes('https://'), 'dashboard exposes no page URL');
  check(!bodyText.includes('Secret page title'), 'dashboard exposes no page title');

  await page.screenshot({ path: '/tmp/opencode/dashboard-1280.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const noHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  check(noHorizontalScroll, 'dashboard has no horizontal scroll at 390px');
  await page.screenshot({ path: '/tmp/opencode/dashboard-390.png', fullPage: true });
  console.log('screenshots: /tmp/opencode/dashboard-1280.png · /tmp/opencode/dashboard-390.png');
} catch (error) {
  failures++;
  console.error(error.stack ?? error);
} finally {
  await context.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(failures === 0 ? 'DASHBOARD E2E: ALL PASSED' : `DASHBOARD E2E: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
