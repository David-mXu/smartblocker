// Focused Chrome e2e for the schedule editing UX:
//   - quiet overlap warnings (and silence when windows do not overlap)
//   - duplicate actions for global focus hours and category schedules
//   - lock-disabled duplicate controls
//   - preference-aware time text and a mobile-width screenshot
//
// Run AFTER `npm run build:chrome`:
//
//   node scripts/e2e-schedule-ux.mjs
//
// Uses its own persistent profile so it never races the other gates.
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-schedule-ux');
const SHOTS = resolve('/tmp/opencode/smartblocker-schedule-ux');
const RUN = Date.now().toString(36);
const KW = `sb-sched-ux-${RUN}`;

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

  const globalRules = [
    {
      id: 'g-morning',
      days: [1, 2, 3, 4, 5],
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
    },
    {
      id: 'g-midday',
      days: [1, 2, 3, 4, 5],
      startMinutes: 12 * 60,
      endMinutes: 18 * 60,
    },
  ];
  const categoryRules = [
    {
      id: 'c-games',
      days: [1, 2, 3, 4, 5],
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
      categories: ['video games'],
    },
    {
      id: 'c-social',
      days: [1, 2, 3, 4, 5],
      startMinutes: 12 * 60,
      endMinutes: 18 * 60,
      categories: ['social media'],
    },
  ];

  await sw.evaluate(
    async ({ kw, globalRules, categoryRules }) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: {
          ...settings,
          enabled: true,
          blocklist: [kw],
          labels: ['video games', 'social media'],
          firstDayOfWeek: 0,
          hour24: true,
          breakMode: 'off',
        },
      });
      await chrome.storage.local.set({
        lockState: {
          timerUntil: null,
          passwordHash: null,
          frozenUntil: null,
          schedules: globalRules,
          schedulesUpdatedAt: Date.now(),
          categorySchedules: categoryRules,
          categorySchedulesUpdatedAt: Date.now(),
        },
      });
      await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples']);
    },
    { kw: KW, globalRules, categoryRules },
  );

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${optionsUrl}#schedule`);
  await page.waitForSelector('#page-heading');
  await page.waitForFunction(() => document.querySelectorAll('.schedule-row').length === 2);

  // ── 1. Overlap warning is visible, quiet, accessible, and specific ──────
  const warning = page.locator('#schedule-overlap-warning');
  await warning.waitFor();
  const warningText = (await warning.innerText()).replace(/\s+/g, ' ');
  check('global overlap warning is visible', await warning.isVisible());
  check('warning says overlaps are allowed and blocking is the union', /allowed/i.test(warningText) && /blocking is the union/i.test(warningText));
  check('warning names both focus-hour windows', warningText.includes('09:00') && warningText.includes('17:00') && warningText.includes('12:00') && warningText.includes('18:00'));
  check('warning uses a polite status region', (await warning.getAttribute('role')) === 'status' && (await warning.getAttribute('aria-live')) === 'polite');
  check('warning exposes a stable data hook', (await warning.getAttribute('data-overlap-count')) === '1');
  check('duplicate control has a stable per-rule id', (await page.locator('#schedule-duplicate-g-midday').count()) === 1);
  await page.screenshot({ path: resolve(SHOTS, '01-schedule-overlap.png'), fullPage: true });

  // ── 2. No nag when the windows stop overlapping ─────────────────────────
  const secondFrom = page.locator('.schedule-row').nth(1).locator('input[type="time"]').nth(0);
  await secondFrom.fill('17:00');
  await page.waitForFunction(() => !document.querySelector('#schedule-overlap-warning'));
  check('no warning when windows only touch at an endpoint', true);
  await page.screenshot({ path: resolve(SHOTS, '02-schedule-no-overlap.png'), fullPage: true });

  await secondFrom.fill('12:00');
  await page.waitForSelector('#schedule-overlap-warning');
  check('warning returns when overlap returns', true);

  // ── 3. Duplicate a global rule, then persist it ─────────────────────────
  const rowsBefore = await page.locator('.schedule-row').count();
  await page.locator('.schedule-duplicate').first().click();
  await page.waitForFunction((before) => document.querySelectorAll('.schedule-row').length === before + 1, rowsBefore);
  const rowsAfter = await page.locator('.schedule-row').count();
  check('duplicate adds one global rule', rowsAfter === rowsBefore + 1, `${rowsBefore} → ${rowsAfter}`);
  const copyRowText = (await page.locator('.schedule-row').nth(1).innerText()).replace(/\s+/g, ' ');
  check('duplicate is labelled as a copy', copyRowText.includes('Focus hours (copy)'), copyRowText);
  check('duplicate keeps the source window', copyRowText.includes('09:00') && copyRowText.includes('17:00'));
  check('duplicate marks the editor dirty', /unsaved changes/i.test((await page.locator('#schedule-msg').innerText()) ?? ''));
  await page.screenshot({ path: resolve(SHOTS, '03-schedule-duplicate.png'), fullPage: true });

  await page.click('#schedule-save');
  await page.waitForFunction(() => /saved/i.test(document.querySelector('#schedule-msg')?.textContent ?? ''));
  const storedSchedules = await sw.evaluate(async () => {
    const { lockState } = await chrome.storage.local.get('lockState');
    return (lockState?.schedules ?? []).map((rule) => ({
      id: rule.id,
      label: rule.label,
      days: rule.days,
      startMinutes: rule.startMinutes,
      endMinutes: rule.endMinutes,
    }));
  });
  check('saved state has the duplicate', storedSchedules.length === rowsAfter);
  check('saved duplicate has a fresh unique id', new Set(storedSchedules.map((rule) => rule.id)).size === storedSchedules.length);
  const savedCopy = storedSchedules.find((rule) => rule.label === 'Focus hours (copy)');
  check('saved duplicate keeps its label', Boolean(savedCopy));
  check('saved duplicate keeps the original bounds', savedCopy?.startMinutes === 9 * 60 && savedCopy?.endMinutes === 17 * 60);

  // ── 4. Category schedules get the same warning and duplicate action ─────
  const categoryWarning = page.locator('#category-schedule-overlap-warning');
  await categoryWarning.waitFor();
  const categoryText = (await categoryWarning.innerText()).replace(/\s+/g, ' ');
  check('category overlap warning is visible', await categoryWarning.isVisible());
  check('category warning names the categories', categoryText.includes('video games') && categoryText.includes('social media'));
  check('category duplicate control has a stable per-rule id', (await page.locator('#category-schedule-duplicate-c-social').count()) === 1);

  const categoryBefore = await page.locator('.category-schedule-row').count();
  await page.locator('.category-schedule-duplicate').first().click();
  await page.waitForFunction((before) => document.querySelectorAll('.category-schedule-row').length === before + 1, categoryBefore);
  const categoryRowText = (await page.locator('.category-schedule-row').nth(1).innerText()).replace(/\s+/g, ' ');
  check('category duplicate is labelled as a copy', categoryRowText.includes('Category schedule (copy)'), categoryRowText);
  check('category duplicate keeps its category', categoryRowText.includes('video games'));
  await page.screenshot({ path: resolve(SHOTS, '04-category-duplicate.png'), fullPage: true });

  await page.click('#category-schedule-save');
  await page.waitForFunction(() => /saved/i.test(document.querySelector('#category-schedule-msg')?.textContent ?? ''));
  const storedCategories = await sw.evaluate(async () => {
    const { lockState } = await chrome.storage.local.get('lockState');
    return (lockState?.categorySchedules ?? []).map((rule) => ({
      id: rule.id,
      label: rule.label,
      categories: rule.categories,
    }));
  });
  check('saved category state has the duplicate', storedCategories.length === categoryBefore + 1);
  check('saved category duplicate has a fresh unique id', new Set(storedCategories.map((rule) => rule.id)).size === storedCategories.length);
  check('saved category duplicate has the copy label', storedCategories.some((rule) => rule.label === 'Category schedule (copy)'));

  // ── 5. Duplicate controls respect a lock; the warning stays quiet ───────
  await sw.evaluate(async () => {
    const { lockState } = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...lockState, timerUntil: Date.now() + 120_000 },
    });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.schedule-row').length >= 2);
  check('global duplicate is disabled while locked', await page.locator('.schedule-duplicate').first().isDisabled());
  check('category duplicate is disabled while locked', await page.locator('.category-schedule-duplicate').first().isDisabled());
  check('overlap warning remains available while locked', await page.locator('#schedule-overlap-warning').isVisible());
  await page.screenshot({ path: resolve(SHOTS, '05-schedule-locked.png'), fullPage: true });

  // ── 6. Mobile layout keeps the warning readable and inside the viewport ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForSelector('#schedule-overlap-warning');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('mobile layout has no horizontal overflow', overflow <= 1, `${overflow}px`);
  await page.screenshot({ path: resolve(SHOTS, '06-schedule-overlap-mobile.png'), fullPage: true });

  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
} finally {
  await context.close();
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
console.log(`screenshots: ${SHOTS}`);
if (failures > 0) process.exitCode = 1;
