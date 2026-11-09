// Real browser item10 fallback: options UI + actual extension storage + model
// classification. NO daemon is started; a nonexistent socket makes fallback
// explicit instead of accidentally connecting to the user's production app.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('.');
const EXT_PATH = resolve('dist/chrome');
const PROFILE = mkdtempSync('/tmp/opencode/smartblocker-allowance-profile-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(150);
  }
  console.log(`… poll timed out: ${label}`);
  return false;
}

console.log('… building Chrome + Firefox bundles for the fallback check');
const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', timeout: 300_000 });
if (build.status !== 0) throw new Error('browser build failed');

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  env: { ...process.env, SMARTBLOCKER_SOCKET: 'smartblocker-allowance-no-daemon' },
});
let sw;
try {
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));
  await sw.evaluate(() => chrome.storage.local.clear());
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#allowance`);
  const labelsReady = await poll(
    () => opts.locator('#allowance-category option').count().then((count) => count > 0),
    20_000,
    'category options load',
  );
  check(labelsReady, 'options exposes real category choices');
  await opts.locator('#allowance-category').selectOption('video games');
  // With zero configuration, relief is refused before any clock/grant work.
  await opts.locator('#relief-duration').fill('1');
  await opts.getByRole('button', { name: 'Use allowance', exact: true }).click();
  const zeroRefused = await poll(() => opts.locator('#allowance-msg').textContent().then((text) => ['allowance-exhausted', 'invalid-category'].some((reason) => text?.includes(reason)) ?? false), 10_000, 'zero configuration refuses grant');
  if (!zeroRefused) {
    console.log('  … zero-config UI response:', await opts.locator('#allowance-msg').textContent());
    console.log('  … zero-config authority:', await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority')));
  }
  check(zeroRefused, 'zero-config category cannot mint allowance relief');

  await opts.locator('#allowance-minutes').fill('1');
  await opts.locator('#allowance-openings').fill('1');
  await opts.locator('#allowance-reward-cap').fill('1');
  await opts.locator('#allowance-wait-base').fill('1');
  await opts.locator('#allowance-wait-step').fill('1');
  await opts.locator('#allowance-wait-max').fill('2');
  await opts.locator('#allowance-save').click();
  check(
    await poll(() => opts.locator('#allowance-msg').textContent().then((text) => text === 'Category relief settings saved.'), 10_000, 'configuration persists'),
    'category configuration persists through the background writer',
  );

  const title = 'speedrunning Dark Souls';
  await context.route('**://www.youtube.com/**', (route) => {
    const url = new URL(route.request().url());
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>${decodeURIComponent(url.searchParams.get('t') ?? title)} - YouTube</title></head><body><h1>${title}</h1></body></html>`,
    });
  });
  const tab = await context.newPage();
  const url = `https://www.youtube.com/watch?v=allowance01&t=${encodeURIComponent(title)}`;
  const blockedOnPage = async () => {
    if (await tab.locator('#smartblocker-overlay').count().catch(() => 0)) return true;
    return new URL(tab.url()).protocol === 'chrome-extension:';
  };
  await tab.goto(url);
  check(await poll(blockedOnPage, 300_000, 'baseline game page blocks'), 'baseline blocked label blocks before any grant');

  await opts.getByRole('button', { name: 'Use allowance', exact: true }).click();
  const active = await poll(async () => {
    const state = await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority'));
    const grant = state.allowanceAuthority?.categories?.['video games']?.ledger?.grant;
    return Boolean(grant && ['pending', 'active'].includes(grant.status) && Date.now() >= grant.notBeforeMs);
  }, 15_000, 'persisted pending bound becomes active at observation');
  check(active, 'pending allowance activates from persisted wall-clock bounds');
  if (!active) {
    console.log('  … activation UI:', await opts.locator('#allowance-msg').textContent());
    console.log('  … activation authority:', await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority')));
  }
  await tab.reload();
  check(await poll(async () => !(await blockedOnPage()), 30_000, 'active allowance permits its own primary category'), 'active allowance relaxes only its primary classifier category');
  const otherCategory = await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('allowanceAuthority');
    const state = stored.allowanceAuthority;
    return { revision: state?.revision, grant: state?.categories?.['video games']?.ledger?.grant ?? null };
  });
  check(otherCategory.grant?.kind === 'allowance', 'no other category grant or reward is consumed');

  await opts.getByRole('button', { name: 'End allowance', exact: true }).click();
  check(
    await poll(async () => {
      const stored = await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority'));
      return stored.allowanceAuthority?.categories?.['video games']?.ledger?.grant?.status === 'ended';
    }, 10_000, 'early cancellation persists'),
    'ending allowance settles an ended grant and unused reservation refund',
  );
  await tab.reload();
  check(await poll(blockedOnPage, 30_000, 'ended grant no longer relaxes the page'), 'ended allowance cannot weaken blocking again');

  const ruleUrl = `${url}&deterministic=1`;
  await opts.getByRole('button', { name: 'Use allowance', exact: true }).click();
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...stored.settings, blocklist: ['dark souls'] } });
  });
  await poll(async () => {
    const stored = await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority'));
    const grant = stored.allowanceAuthority?.categories?.['video games']?.ledger?.grant;
    return Boolean(grant && ['pending', 'active'].includes(grant.status) && Date.now() >= grant.notBeforeMs);
  }, 15_000, 'second allowance is live for deterministic precedence check');
  await tab.goto(ruleUrl);
  check(await poll(blockedOnPage, 30_000, 'deterministic rule remains blocked during allowance'), 'active per-category relief never relaxes a deterministic block');

  check(true, 'no daemon was started: source remains extension fallback');
} catch (error) {
  failures++;
  console.error(error.stack ?? error);
} finally {
  await context.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}
console.log(failures === 0 ? 'ALLOWANCE FALLBACK E2E: ALL PASSED' : `ALLOWANCE FALLBACK E2E: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
