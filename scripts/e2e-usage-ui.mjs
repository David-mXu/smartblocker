// Focused Usage dashboard e2e: seeds local v2 aggregates, reloads the
// extension, then verifies the options page renders range/day analytics and
// that JSON export stays aggregate-only. Run after `npm run build:chrome`:
//
//   node scripts/e2e-usage-ui.mjs
//
// A separate profile keeps the persistent model cache untouched; this suite
// never needs the classifier.
import { chromium } from 'playwright';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localUsageDate } from '../src/shared/usage-stats.ts';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-usage-profile');
const SHOT = resolve('docs/audits/assets/2026-11-09-usage-dashboard.png');
const SHOT_SITES = resolve('docs/audits/assets/2026-11-09-usage-sites.png');
const STORAGE_KEY = 'usageStats:v2';

await rm(PROFILE, { recursive: true, force: true });
await mkdir(resolve('docs/audits/assets'), { recursive: true });

function buildSeed() {
  const now = new Date();
  const days = {};
  for (let offset = 0; offset < 35; offset += 1) {
    const date = localUsageDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime(),
    );
    const recent = offset < 7;
    const pagesSilenced = recent ? 6 + (offset % 3) : 2 + (offset % 4);
    const activeMs = recent ? 2_400_000 + offset * 120_000 : 900_000 + offset * 30_000;
    const protectedMs = Math.round(activeMs * (recent ? 0.82 : 0.7));
    const blocks = recent
      ? {
          classifier: Math.max(1, pagesSilenced - 4),
          deterministic: 2,
          channel: 1,
          adult: offset === 0 ? 1 : 0,
          failClosed: offset === 2 ? 1 : 0,
          unknown: 0,
        }
      : {
          classifier: pagesSilenced,
          deterministic: 0,
          channel: 0,
          adult: 0,
          failClosed: 0,
          unknown: 0,
        };
    // Force the partition invariant even when the pattern above overshoots.
    const assigned = Object.values(blocks).reduce((sum, count) => sum + count, 0);
    if (assigned < pagesSilenced) blocks.classifier += pagesSilenced - assigned;
    if (assigned > pagesSilenced) blocks.classifier -= assigned - pagesSilenced;

    const siteNames = [
      'news.ycombinator.com',
      'youtube.com',
      'reddit.com',
      'github.com',
      'wikipedia.org',
      'twitch.tv',
      'x.com',
      'stackoverflow.com',
      'steamcommunity.com',
      'instagram.com',
      'other.invalid',
    ];
    const siteWeights = [0.28, 0.18, 0.14, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02];
    const sites = {};
    let remainingPages = pagesSilenced;
    let remainingMs = activeMs;
    for (const [index, site] of siteNames.entries()) {
      const last = index === siteNames.length - 1;
      const pages = last
        ? remainingPages
        : Math.min(remainingPages, Math.round(pagesSilenced * siteWeights[index]));
      const siteMs = last
        ? remainingMs
        : Math.min(remainingMs, Math.round(activeMs * siteWeights[index]));
      sites[site] = {
        activeMs: siteMs,
        pagesSilenced: pages,
        overrides: offset === 0 && index === 0 ? 2 : 0,
      };
      remainingPages -= pages;
      remainingMs -= siteMs;
    }
    // Put any rounding remainder on the first site.
    sites['news.ycombinator.com'].activeMs += remainingMs;

    const categories = {};
    const categoryNames = ['video games', 'social media and networking', 'memes and entertainment', 'news'];
    const categoryWeights = [0.4, 0.3, 0.2];
    let remainingCategoryPages = pagesSilenced;
    let remainingCategoryMs = activeMs;
    for (const [index, category] of categoryNames.entries()) {
      const last = index === categoryNames.length - 1;
      const pages = last
        ? remainingCategoryPages
        : Math.min(remainingCategoryPages, Math.round(pagesSilenced * categoryWeights[index]));
      const ms = last
        ? remainingCategoryMs
        : Math.min(remainingCategoryMs, Math.round(activeMs * categoryWeights[index]));
      categories[category] = {
        activeMs: ms,
        pagesSilenced: pages,
        overrides: offset === 0 && index === 0 ? 2 : 0,
      };
      remainingCategoryPages -= pages;
      remainingCategoryMs -= ms;
    }
    categories['video games'].activeMs += remainingCategoryMs;

    days[date] = {
      totals: {
        activeMs,
        pagesSilenced,
        overrides: offset === 0 ? 2 : 0,
      },
      protection: {
        protectedMs,
        unprotectedMs: activeMs - protectedMs,
        lockedMs: offset === 0 ? 1_800_000 : 0,
        breakMs: offset === 0 ? 600_000 : 0,
        unknownMs: 0,
      },
      blocks,
      sites,
      categories,
    };
  }
  return {
    version: 2,
    days,
    checkpoint: null,
    recentSilenced: [],
  };
}

const seed = buildSeed();
const today = localUsageDate(Date.now());
const nowDate = new Date();
const sevenDayStart = localUsageDate(
  new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 6).getTime(),
);
const sevenDayPages = Object.entries(seed.days)
  .filter(([date]) => date >= sevenDayStart && date <= today)
  .reduce((sum, [, day]) => sum + day.totals.pagesSilenced, 0);

async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    const event = ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
    const waker = await ctx.newPage();
    await waker.goto('https://example.com').catch(() => {});
    sw = ctx.serviceWorkers()[0] ?? (await event);
    await waker.close();
  }
  if (!sw) {
    await ctx.close();
    throw new Error('service worker did not boot');
  }
  return { context: ctx, worker: sw };
}

let { context, worker } = await launch();

let failures = 0;
const check = (condition, label, detail = '') => {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

try {
  await worker.evaluate(async (state) => {
    await chrome.storage.local.set({ 'usageStats:v2': state });
    await chrome.storage.local.remove('usageStats:v1');
  }, seed);
  // A fresh browser launch gives the service worker a clean in-memory tracker;
  // it reads the seeded value on its first observation.
  await context.close();
  ({ context, worker } = await launch());
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/options.html#usage`);
  await page.waitForSelector('#usage-pages-silenced');

  check(await page.locator('#page-heading').innerText() === 'Usage', 'Usage page renders');
  const pagesText = (await page.locator('#usage-pages-silenced').innerText()).trim();
  check(pagesText === String(sevenDayPages), 'seven-day pages silenced matches seed', `${pagesText} vs ${sevenDayPages}`);
  check((await page.locator('#usage-protection-coverage').innerText()).includes('%'), 'protection coverage shows a percentage');
  check((await page.locator('#usage-active-time').innerText()).trim() !== '—', 'active time renders');
  check((await page.locator('#usage-locked-time').innerText()).includes('m'), 'time under lock renders');
  check((await page.locator('#usage-break-time').innerText()).includes('m'), 'break relief renders');
  check((await page.locator('#usage-tab-blocks').getAttribute('aria-selected')) === 'true', 'Blocks tab is selected');

  check(await page.locator('#usage-chart [data-day]').count() === 7, 'seven-day chart renders seven bars');
  await page.click('#usage-range-35');
  await page.waitForTimeout(200);
  check(await page.locator('#usage-chart [data-day]').count() === 35, '35-day chart renders thirty-five bars');
  check((await page.locator('#usage-range-35').getAttribute('aria-pressed')) === 'true', 'range preset reflects selection');
  const rangeStyles = await page.evaluate(() =>
    ['usage-range-7', 'usage-range-35'].map(
      (id) => getComputedStyle(document.getElementById(id)).backgroundColor,
    ),
  );
  check(rangeStyles[0] !== rangeStyles[1], 'selected range has a distinct surface', rangeStyles.join(' vs '));
  await page.screenshot({ path: SHOT, fullPage: true });
  check(true, `screenshot saved to ${SHOT}`);

  await page.click('#usage-tab-websites');
  check(await page.locator('#usage-tab-websites').getAttribute('aria-selected') === 'true', 'Sites and categories tab activates');
  check(await page.locator('#usage-day').inputValue() === today, 'day selector defaults to today');
  check(await page.locator('#usage-sites tbody tr').count() === 8, 'Top-N limits the site table to eight rows');
  check(await page.locator('#usage-categories tbody tr').count() === 4, 'Top-N shows all four seeded categories');
  check(await page.locator('#usage-sites-toggle').getAttribute('aria-expanded') === 'false', 'show-all starts collapsed');

  await page.click('#usage-sites-toggle');
  check(await page.locator('#usage-sites tbody tr').count() === 11, 'show-all reveals every site bucket');
  check(await page.locator('#usage-sites-toggle').getAttribute('aria-expanded') === 'true', 'show-all reflects expanded state');
  check(await page.locator('#usage-sites').innerText().then((text) => text.includes('Other sites (combined)')), 'aggregate other site row is visible');
  await page.uncheck('#usage-show-other');
  check(!(await page.locator('#usage-sites').innerText()).includes('Other sites (combined)'), 'other toggle hides aggregate other row');
  await page.check('#usage-show-other');

  await page.click('#usage-day-yesterday');
  const yesterday = localUsageDate(Date.now() - 86_400_000);
  check(await page.locator('#usage-day').inputValue() === yesterday, 'Yesterday preset selects the prior local day');
  await page.click('#usage-day-today');

  await page.screenshot({ path: SHOT_SITES, fullPage: true });
  check(true, `screenshot saved to ${SHOT_SITES}`);

  const downloadPromise = page.waitForEvent('download');
  await page.click('#usage-export');
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
  check(exported.version === 2, 'exported JSON is v2');
  check(Array.isArray(exported.days) && exported.days.length === 35, 'export contains all retained days');
  const exportedText = JSON.stringify(exported);
  check(!exportedText.includes('https://'), 'export contains no full URLs');
  check(!exportedText.includes('"checkpoint"'), 'export contains no checkpoint');
  check(!exportedText.includes('"recentSilenced"'), 'export contains no dedupe IDs');
  check(!exportedText.includes('Private title'), 'export contains no page titles');

  await page.click('#usage-clear');
  check((await page.locator('#usage-clear').innerText()).includes('Click again'), 'clear arms only after the first click');
  await page.click('#usage-clear');
  await page.waitForFunction(() => {
    const button = document.getElementById('usage-clear');
    return button?.hasAttribute('disabled') === true && button.textContent?.includes('Clear usage');
  });
  check(await page.locator('#usage-clear').isDisabled(), 'clear disables the button when no days remain');
  const clearedRows = await page.locator('#usage-sites tbody tr').count();
  check(clearedRows === 1, 'cleared day table shows the empty row', `rows=${clearedRows}`);

  check(pageErrors.length === 0, 'no options-page runtime errors', pageErrors.join('; '));
} finally {
  await context.close();
}

console.log(`\n${failures === 0 ? 'USAGE E2E: ALL PASSED' : `USAGE E2E: ${failures} FAILED`}`);
if (failures) process.exitCode = 1;
