// Real-browser item10 reward path: options UI opt-in + live status, then a
// focused productive tab accrues wall-clock work and credits reward through the
// extension-only authoritative fallback. NO daemon is started.
//
// The productive classifier verdict is injected into storage.session for a
// real foreground tab so the test does not wait for a fresh local model load;
// the browser integration under test is the reward resolver, checkpoint
// persistence, and authoritative `reward` command path.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('.');
const EXT_PATH = resolve('dist/chrome');
const PROFILE = mkdtempSync('/tmp/opencode/smartblocker-reward-profile-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const CATEGORY = 'video games';
const REWARD_LABEL = 'programming and software development';
const executablePath = process.env.SB_CHROMIUM_PATH;
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
    await sleep(200);
  }
  console.log(`… poll timed out: ${label}`);
  return false;
}

console.log('… building Chrome bundle for the reward fallback check');
const build = spawnSync('npm', ['run', 'build:chrome'], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 });
if (build.status !== 0) throw new Error('Chrome build failed');

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  env: { ...process.env, SMARTBLOCKER_SOCKET: 'smartblocker-reward-no-daemon' },
});
let injection = null;
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));
  await sw.evaluate(() => chrome.storage.local.clear());

  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#allowance`);
  check(
    await poll(() => opts.locator('#allowance-category option').count().then((count) => count > 0), 20_000, 'category options load'),
    'options exposes category choices',
  );
  await opts.locator('#allowance-category').selectOption(CATEGORY);
  await opts.locator('#allowance-minutes').fill('1');
  await opts.locator('#allowance-openings').fill('0');
  await opts.locator('#allowance-reward-cap').fill('1');
  await opts.locator('#allowance-wait-base').fill('0');
  await opts.locator('#allowance-wait-step').fill('0');
  await opts.locator('#allowance-wait-max').fill('0');
  await opts.locator('label:has(#reward-earning)').click();
  check(await opts.locator('#reward-earning').isChecked(), 'reward earning switch toggles');
  check(await opts.locator('#reward-work-minutes').isVisible(), 'reward ratio fields appear after opt-in');
  await opts.waitForTimeout(2_200);
  check(
    await opts.locator('#reward-earning').isChecked(),
    'unsaved opt-in survives the live authority poll',
  );
  await opts.locator('#reward-work-minutes').fill('1');
  await opts.locator('#reward-award-minutes').fill('1');
  await opts.locator('#allowance-save').click();

  const saved = await poll(() => sw.evaluate(async (category) => {
    const stored = await chrome.storage.local.get('allowanceAuthority');
    const config = stored.allowanceAuthority?.categories?.[category]?.config;
    return config?.rewardEarning === true
      && config.rewardWorkMs === 60_000
      && config.rewardAwardMs === 60_000
      && config.rewardCapMs === 60_000;
  }, CATEGORY), 10_000, 'reward configuration persists');
  check(saved, 'opt-in work/reward ratio and cap persist through the authority');
  if (!saved) {
    console.log('  … config:', await sw.evaluate(() => chrome.storage.local.get('allowanceAuthority')));
    console.log('  … message:', await opts.locator('#allowance-msg').textContent());
  }

  // A timer lock is real settings-lock evidence. Configure first: locked
  // inputs are intentionally disabled.
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      lockState: {
        timerUntil: Date.now() + 10 * 60_000,
        passwordHash: null,
        frozenUntil: null,
        schedules: [],
      },
    });
  });
  check(
    await poll(() => opts.locator('#reward-status').textContent().then((text) => text?.includes('Paused') ?? false), 10_000, 'lock status observed'),
    'reward status observes the active lock',
  );

  const url = 'https://example.com/smartblocker-reward-e2e';
  await context.route('https://example.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>TypeScript compiler tutorial</title></head><body><h1>TypeScript compiler tutorial</h1></body></html>',
  }));
  const tab = await context.newPage();
  await tab.goto(url);
  const tabId = await sw.evaluate(async (target) => {
    const found = (await chrome.tabs.query({})).find((candidate) => candidate.url === target);
    if (found?.id !== undefined) await chrome.tabs.update(found.id, { active: true });
    return found?.id ?? null;
  }, url);
  check(tabId !== null, 'reward test tab is active in the focused window');

  const status = {
    url,
    title: 'TypeScript compiler tutorial',
    kind: 'allowed',
    label: REWARD_LABEL,
    score: 0.99,
    ts: Date.now(),
  };
  const inject = () => sw.evaluate(async ({ key, value }) => {
    await chrome.storage.session.set({ [key]: value });
  }, { key: `tabStatus:${tabId}`, value: { ...status, ts: Date.now() } });
  await inject();
  // Re-assert the verdict and give each observation a new timestamp so the
  // storage listener drives real checkpoints. The blocker may overwrite it.
  injection = setInterval(() => void inject().catch(() => {}), 4_000);

  const earning = await poll(
    () => opts.locator('#reward-status-badge').textContent().then((text) => text?.includes('Earning now') ?? false),
    15_000,
    'live earning status',
  );
  check(earning, 'options live badge reports earning on a focused productive page');

  // Stop the repeated injection, then present a blocked verdict. The next
  // observation must close the productive segment without crediting it.
  clearInterval(injection);
  injection = null;
  await sw.evaluate(async ({ key, value }) => {
    await chrome.storage.session.set({ [key]: { ...value, kind: 'blocked', ts: Date.now() } });
  }, { key: `tabStatus:${tabId}`, value: status });
  check(
    await poll(() => opts.locator('#reward-status').textContent().then((text) => text?.includes('productive classifier') ?? false), 15_000, 'blocked page pauses earning'),
    'a blocked verdict is not productive reward evidence',
  );
  await inject();
  injection = setInterval(() => void inject().catch(() => {}), 4_000);

  const credited = await poll(() => sw.evaluate(async (category) => {
    const stored = await chrome.storage.local.get(['allowanceAuthority', 'rewardAccrual:v1']);
    const ledger = stored.allowanceAuthority?.categories?.[category]?.ledger;
    const accrual = stored['rewardAccrual:v1'];
    return {
      earned: ledger?.earnedRewardMs ?? 0,
      pending: Boolean(accrual?.categories?.[category]?.pending),
      rewardReceipts: (stored.allowanceAuthority?.receipts ?? []).filter((receipt) => receipt.fingerprint.includes('"reward"')).length,
    };
  }, CATEGORY).then((state) => state.earned === 60_000), 180_000, 'authoritative reward credit');
  if (!credited) {
    console.log('  … reward status:', await opts.locator('#reward-status').textContent());
    console.log('  … accrual:', await sw.evaluate(() => chrome.storage.local.get(['rewardAccrual:v1', 'allowanceAuthority'])));
  }
  check(credited, 'one minute of focused work credits one authoritative reward minute');

  const result = await sw.evaluate(async (category) => {
    const stored = await chrome.storage.local.get(['allowanceAuthority', 'rewardAccrual:v1']);
    return {
      earned: stored.allowanceAuthority?.categories?.[category]?.ledger?.earnedRewardMs ?? 0,
      pending: Boolean(stored['rewardAccrual:v1']?.categories?.[category]?.pending),
      rewardReceipts: (stored.allowanceAuthority?.receipts ?? []).filter((receipt) => receipt.fingerprint.includes('"reward"')).length,
      source: stored.allowanceAuthority ? 'fallback' : 'missing',
    };
  }, CATEGORY);
  check(result.earned === 60_000, 'earned balance is capped at one minute');
  check(result.pending === false, 'the pending intent settled after authoritative acknowledgement');
  check(result.rewardReceipts >= 1, 'the reward command is present in the fallback receipt log');
  check(result.source === 'fallback', 'no daemon was used: the browser fallback authority owns the balance');

  const label = await opts.locator('#reward-progress-label').textContent();
  check(label?.includes('1') ?? false, `options shows earned/progress state (${label?.trim()})`);
  await poll(
    () => opts.locator('#reward-status').textContent().then((text) => text?.includes('cap reached') ?? false),
    15_000,
    'cap reached status',
  );
  check(
    await opts.locator('#reward-status').textContent().then((text) => text?.includes('cap reached') ?? false),
    'the daily cap pauses further earning and is explained in the UI',
  );
} catch (error) {
  failures++;
  console.error(error.stack ?? error);
} finally {
  if (injection) clearInterval(injection);
  await context.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}
console.log(failures === 0 ? 'REWARD FALLBACK E2E: ALL PASSED' : `REWARD FALLBACK E2E: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
