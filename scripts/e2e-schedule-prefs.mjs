// Focused e2e for schedule lead-in, display preferences, lock hint, and the
// custom block-screen message (both injected overlay and DNR force redirect).
// Run AFTER `npm run build:chrome`:
//
//   node scripts/e2e-schedule-prefs.mjs
//
// Deterministic: every block is a URL blocklist match, so no model download.
// Uses its own persistent profile so it never races the other gates.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-prefs');
const SHOTS = resolve('/tmp/opencode/smartblocker-schedule-prefs');
const RUN = Date.now().toString(36);
const KW = `sb-prefs-kw-${RUN}`;
const MESSAGE = '<b>Finish the set</b> & come back';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

mkdirSync(SHOTS, { recursive: true });
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let worker = ctx.serviceWorkers()[0];
    if (!worker) {
      const swPromise = ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      worker = ctx.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (worker) return { context: ctx, sw: worker };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('service worker did not boot after 3 launches');
}

const { context, sw } = await launchWithServiceWorker();

try {
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;
  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        enabled: true,
        blocklist: [kw],
        blockMessage: '',
        firstDayOfWeek: 0,
        hour24: false,
        breakMode: 'off',
      },
    });
    await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'lockState']);
  }, KW);

  const page = await context.newPage();

  // ── 0. Tampered stored preferences are sanitized on read ────────────────
  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        enabled: true,
        blocklist: [kw],
        firstDayOfWeek: 6,
        hour24: 'yes',
        blockMessage: '  <i>raw</i>\n\nnote  ',
      },
    });
  }, KW);
  await page.goto(`${optionsUrl}#preferences`);
  await page.waitForSelector('#first-day-of-week');
  check('invalid first day sanitizes to Sunday', (await page.locator('#first-day-of-week').inputValue()) === '0');
  check('non-boolean hour24 sanitizes to off', !(await page.locator('#hour24-toggle').isChecked()));
  await page.goto(`${optionsUrl}#blocking`);
  await page.waitForSelector('#block-message-input');
  check(
    'stored block message collapses whitespace on read',
    (await page.locator('#block-message-input').inputValue()) === '<i>raw</i> note',
  );
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));

  // ── 1. Preferences: first day + 24-hour time persist and format ─────────
  await page.goto(`${optionsUrl}#preferences`);
  await page.waitForSelector('#page-heading');
  check(
    'preferences page renders',
    (await page.locator('#page-heading').textContent())?.trim() === 'Preferences',
  );
  await page.screenshot({ path: resolve(SHOTS, '01-preferences-before.png'), fullPage: true });

  await page.selectOption('#first-day-of-week', '1');
  await page.locator('label:has(#hour24-toggle)').click();
  await page.waitForFunction(() =>
    document.querySelector('#preferences-preview')?.textContent?.includes('Mon, Wed, Fri'),
  );
  const preview = (await page.locator('#preferences-preview').textContent()) ?? '';
  check('Monday-first preview reorders day labels', preview.includes('Mon, Wed, Fri'));
  check('24-hour preview formats 09:00 – 17:00', preview.includes('09:00') && preview.includes('17:00'));

  const storedPrefs = await sw.evaluate(() => chrome.storage.local.get('settings'));
  check('preferences persist', storedPrefs.settings?.firstDayOfWeek === 1 && storedPrefs.settings?.hour24 === true);
  await page.screenshot({ path: resolve(SHOTS, '02-preferences-after.png'), fullPage: true });

  // Reload to prove read-time normalization keeps the prefs.
  await page.reload();
  await page.waitForSelector('#first-day-of-week');
  check('preferences survive reload', (await page.locator('#first-day-of-week').inputValue()) === '1');
  check('24-hour switch survives reload', await page.locator('#hour24-toggle').isChecked());

  // ── 2. Focus hours: day order, lead badge, lead lock reason ─────────────
  await page.goto(`${optionsUrl}#schedule`);
  await page.waitForSelector('#page-heading');
  await page.waitForFunction(() => !document.querySelector('#schedule-list')?.textContent?.includes('Loading'));
  await page.click('#schedule-add');
  await page.waitForSelector('.schedule-row');

  const firstDayTitle = await page.locator('.schedule-row .day-label').first().getAttribute('title');
  check('focus-hours day buttons start on Monday', firstDayTitle === 'Monday', String(firstDayTitle));
  const initialSummary = (await page.locator('.schedule-row').first().textContent()) ?? '';
  check('hour24 applies to the schedule summary', initialSummary.includes('09:00') && initialSummary.includes('17:00'));

  // Put the window 10 minutes ahead with a 30-minute lead: the lead is active
  // now, settings freeze, but blocking does not start yet.
  const now = new Date();
  const start = new Date(now.getTime() + 10 * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const todayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const todayBox = page
    .locator('.schedule-row')
    .first()
    .getByRole('checkbox', { name: todayName, exact: true });
  if (!(await todayBox.isChecked())) await todayBox.check();
  await page.locator('.schedule-row input[type="time"]').nth(0).fill(hhmm(start));
  await page.locator('.schedule-row input[type="time"]').nth(1).fill(hhmm(end));
  await page.locator('.schedule-row input[aria-label="Minutes to lock settings before this window"]').fill('30');
  check(
    'lead badge appears in the rule header',
    (await page.locator('.schedule-lead-badge').first().textContent())?.trim() === 'Lead 30m',
  );
  const leadText = (await page.locator('.schedule-row').first().textContent()) ?? '';
  check('lead explanatory text names the two different start times', leadText.includes('Settings lock at') && leadText.includes('blocking still starts at'));

  await page.click('#schedule-save');
  await page.waitForFunction(() => document.querySelector('#schedule-msg')?.textContent?.includes('saved'));
  const storedLock = await sw.evaluate(() => chrome.storage.local.get('lockState'));
  check('leadMinutes is stored on the rule', storedLock.lockState?.schedules?.[0]?.leadMinutes === 30);
  await page.waitForFunction(() => document.body.innerText.includes('focus hours lead-in'), null, {
    timeout: 10_000,
  });
  check('lock banner names the lead-in reason', (await page.locator('body').innerText()).includes('focus hours lead-in'));
  await page.screenshot({ path: resolve(SHOTS, '03-schedule-lead.png'), fullPage: true });

  // ── 3. Locks: quiet empty hint disappears once a lock exists ────────────
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
  await page.goto(`${optionsUrl}#locks`);
  await page.waitForSelector('#locks-empty-hint');
  check('locks page shows the quiet no-locks hint', true);
  await page.screenshot({ path: resolve(SHOTS, '04-locks-empty.png'), fullPage: true });

  await sw.evaluate(() => chrome.storage.local.set({
    lockState: {
      timerUntil: Date.now() + 120_000,
      passwordHash: null,
      frozenUntil: null,
      schedules: [],
    },
  }));
  await page.waitForFunction(() => !document.querySelector('#locks-empty-hint'), null, { timeout: 10_000 });
  check('hint disappears when a timer lock exists', true);
  await page.screenshot({ path: resolve(SHOTS, '05-locks-timer.png'), fullPage: true });

  // ── 4. Empty focus-hours hint remains present ───────────────────────────
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
  await page.goto(`${optionsUrl}#schedule`);
  await page.waitForFunction(() =>
    document.querySelector('#schedule-list')?.textContent?.includes('No focus hours yet'),
  );
  check('empty focus-hours hint is present', true);

  // ── 5. Custom block message: injected overlay, textContent only ─────────
  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, enabled: true, blocklist: [kw], blockMessage: '<b>Finish the set</b> & come back' },
    });
  }, KW);

  const watchUrl = `https://www.youtube.com/watch?v=prefs-${RUN}&kw=${encodeURIComponent(KW)}&t=${encodeURIComponent('Prefs note ' + RUN)}`;
  await context.route('**://www.youtube.com/watch**', (route) => {
    const u = new URL(route.request().url());
    const t = decodeURIComponent(u.searchParams.get('t') ?? 'YouTube');
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>${t} - YouTube</title></head><body><h1>${t}</h1></body></html>`,
    });
  });

  const tab = await context.newPage();
  await tab.goto(watchUrl);
  await tab.waitForSelector('#smartblocker-overlay', { timeout: 10_000 });
  await tab.waitForSelector('#smartblocker-block-message');
  const overlayText = await tab.locator('#smartblocker-block-message').textContent();
  check('overlay renders the custom message literally', overlayText === '<b>Finish the set</b> & come back', String(overlayText));
  check('overlay does not parse the message as HTML', (await tab.locator('#smartblocker-block-message b').count()) === 0);
  await tab.screenshot({ path: resolve(SHOTS, '06-overlay-message.png') });

  // ── 6. Force redirect: extension-owned page, same literal message ───────
  await sw.evaluate(() => chrome.storage.local.set({
    lockState: {
      timerUntil: null,
      passwordHash: null,
      frozenUntil: Date.now() + 120_000,
      schedules: [],
    },
  }));
  await tab.waitForTimeout(400);
  await tab.reload();
  await tab.waitForURL((url) => url.pathname.endsWith('/blocked.html'), { timeout: 15_000 });
  await tab.waitForSelector('#smartblocker-blocked #smartblocker-block-message');
  const blockedText = await tab.locator('#smartblocker-block-message').textContent();
  check('force-redirect page renders the custom message literally', blockedText === '<b>Finish the set</b> & come back', String(blockedText));
  check('force-redirect page does not parse the message as HTML', (await tab.locator('#smartblocker-block-message b').count()) === 0);
  check('force-redirect URL carries the bounded msg param', new URL(tab.url()).searchParams.get('msg') === '<b>Finish the set</b> & come back');
  await tab.screenshot({ path: resolve(SHOTS, '07-force-redirect-message.png') });

  // Clear the force lock so the next run starts clean.
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
  await tab.waitForTimeout(500);
} finally {
  await context.close();
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
console.log(`screenshots: ${SHOTS}`);
if (failures > 0) process.exitCode = 1;
