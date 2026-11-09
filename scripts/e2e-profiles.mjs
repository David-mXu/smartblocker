// Real Chrome options-page check for named profiles: create, activate, scoped
// edit routing, rename/delete, lock disabling and the active-profile banner.
// Also writes the Profiles-page screenshot used by the learning note.
//
//   node scripts/e2e-profiles.mjs
//   SB_SKIP_BUILD=1 node scripts/e2e-profiles.mjs
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('.');
const EXT_PATH = resolve('dist/chrome');
const PROFILE = mkdtempSync('/tmp/opencode/smartblocker-profiles-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const SCREENSHOT = resolve('docs/audits/assets/2026-11-09-profiles.png');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
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

if (process.env.SB_SKIP_BUILD !== '1') {
  console.log('… building Chrome bundle');
  const build = spawnSync('npm', ['run', 'build:chrome'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300_000,
  });
  if (build.status !== 0) throw new Error('Chrome build failed');
}

mkdirSync(resolve('docs/audits/assets'), { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1180, height: 1000 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});
let sw;
try {
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      settings: {
        enabled: true,
        onboarded: true,
        labels: ['video games'],
        blockedLabels: ['video games'],
        blockThreshold: 0.5,
        whitelist: ['default.example'],
        whitelistVersion: 2,
        blocklist: [],
        titleRules: [],
        channelBlocklist: [],
        channelAllowlist: [],
        shareFeedback: false,
        deletedBuiltinLabels: [],
        focusGoal: '',
        useTabContext: false,
        resolveEmbedTitles: false,
        blockAdult: false,
        resumeMode: 'off',
        resumeAt: null,
        breakMode: 'off',
        breakDelayMinutes: 0,
        breakDurationMinutes: 15,
        breakTextLength: 50,
        surrenderMode: 'off',
        maskSearchElements: true,
      },
    });
  });

  const opts = await context.newPage();
  opts.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [options error]', msg.text());
  });
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#profiles`);
  check(
    await poll(() => opts.locator('#profiles-list').count().then((n) => n === 1), 15_000, 'profiles page renders'),
    'Profiles page renders',
  );
  check(
    (await opts.locator('#profile-default').getAttribute('data-active')) === 'true',
    'Default starts active',
  );
  check(await opts.locator('#active-profile-banner').isHidden(), 'no named-profile banner on Default');

  await opts.locator('#profile-name').fill('Work');
  await opts.locator('#profile-create').click();
  check(
    await poll(
      () => opts.locator('#profile-msg').textContent().then((text) => text?.includes('Profile created') ?? false),
      10_000,
      'profile create message',
    ),
    'Create profile reports success',
  );
  const workRow = opts.locator('#profiles-list .profile-row[data-profile-id]').first();
  check(await workRow.isVisible(), 'created profile row appears');
  check((await opts.locator('#profiles-list .profile-row[data-profile-id]').count()) === 1, 'one named profile exists');

  await workRow.locator('.profile-activate').click();
  check(
    await poll(
      () => opts.locator('#active-profile-banner').isVisible().catch(() => false),
      10_000,
      'active profile banner',
    ),
    'Activating a profile shows the global active-profile banner',
  );
  check(
    (await opts.locator('#active-profile-banner').textContent())?.includes('Work') ?? false,
    'Banner names the active profile',
  );
  check(
    (await workRow.getAttribute('data-active')) === 'true',
    'Activated row is marked active',
  );
  check(
    (await opts.locator('#profile-default').getAttribute('data-active')) === 'false',
    'Default row is no longer active',
  );

  await opts.screenshot({ path: SCREENSHOT, fullPage: true });
  console.log(`… screenshot: ${SCREENSHOT}`);

  // A scoped edit on another page must land in Work, never in Default.
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#sites`);
  await poll(() => opts.locator('#whitelist-input').count().then((n) => n === 1), 10_000, 'sites page');
  await opts.locator('#whitelist-input').fill('profile-only.example');
  await opts.locator('#whitelist-input').press('Enter');
  check(
    await poll(
      () => opts.locator('#save-msg').textContent().then((text) => text === 'Saved'),
      10_000,
      'scoped save',
    ),
    'Scoped edit saves through the settings choke point',
  );
  const stored = await sw.evaluate(async () => chrome.storage.local.get(['settings', 'profiles:v1']));
  const work = stored['profiles:v1'].profiles.find((profile) => profile.name === 'Work');
  check(!stored.settings.whitelist.includes('profile-only.example'), 'Default whitelist is untouched');
  check(
    work?.policy.whitelist.includes('profile-only.example') ?? false,
    'Active profile received the scoped whitelist edit',
  );

  // Rename + two-step delete.
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#profiles`);
  await poll(() => opts.locator('#profiles-list').count().then((n) => n === 1), 10_000, 'profiles page reload');
  await opts.locator('#profiles-list .profile-row[data-profile-id]').first().locator('.profile-duplicate').click();
  check(
    await poll(
      () => opts.locator('#profiles-list .profile-row[data-profile-id]').count().then((n) => n === 2),
      10_000,
      'duplicate row',
    ),
    'Duplicate creates a second row',
  );
  const copyRow = opts.locator('#profiles-list .profile-row[data-profile-id]').nth(1);
  check(((await copyRow.textContent()) ?? '').includes('Work copy'), 'Duplicate is named Work copy');

  await copyRow.locator('.profile-rename').click();
  await opts.locator('#profile-rename-input').fill('Evening');
  await copyRow.getByRole('button', { name: 'Save', exact: true }).click();
  check(
    await poll(
      () => opts.locator('#profiles-list .profile-row[data-profile-id]').nth(1).textContent()
        .then((text) => text?.includes('Evening') ?? false),
      10_000,
      'rename row',
    ),
    'Rename updates the row',
  );

  const eveningRow = opts.locator('#profiles-list .profile-row[data-profile-id]').nth(1);
  await eveningRow.locator('.profile-delete').click();
  check(
    ((await eveningRow.locator('.profile-delete').textContent()) ?? '').includes('Confirm'),
    'First delete click asks for confirmation',
  );
  await eveningRow.locator('.profile-delete').click();
  check(
    await poll(
      () => opts.locator('#profiles-list .profile-row[data-profile-id]').count().then((n) => n === 1),
      10_000,
      'delete row',
    ),
    'Second delete click removes the profile',
  );

  // Lock the settings store: every profile action disables, with a visible reason.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: Date.now() + 60_000,
        passwordHash: null,
        passwordTs: 0,
        frozenUntil: null,
        schedules: [],
        schedulesUpdatedAt: 0,
      },
    }),
  );
  check(
    await poll(
      () => opts.locator('#profiles-lock-note').isVisible().catch(() => false),
      10_000,
      'lock note',
    ),
    'Locked profile controls show a reason',
  );
  check(
    await opts.locator('#profiles-list .profile-activate').first().isDisabled(),
    'Activate is disabled while locked',
  );
  check(await opts.locator('#profile-create').isDisabled(), 'Create is disabled while locked');
  await sw.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: null,
        passwordTs: 0,
        frozenUntil: null,
        schedules: [],
        schedulesUpdatedAt: 0,
      },
    }),
  );
  await poll(
    () => opts.locator('#profiles-lock-note').isHidden().catch(() => false),
    10_000,
    'lock note clears',
  );

  // Switch back to Default and confirm effective settings fall back.
  await opts.locator('#profile-default .profile-activate').click();
  check(
    await poll(
      () => opts.locator('#active-profile-banner').isHidden().catch(() => false),
      10_000,
      'Default activation',
    ),
    'Activating Default hides the named-profile banner',
  );
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#sites`);
  await poll(() => opts.locator('#whitelist-input').count().then((n) => n === 1), 10_000, 'sites after Default');
  check(
    await poll(
      () => opts.locator('#whitelist .list-row', { hasText: 'default.example' }).count()
        .then((n) => n === 1),
      10_000,
      'Default whitelist visible',
    ),
    'Default profile falls back to its original protected sites',
  );
  check(
    (await opts.locator('#whitelist .list-row', { hasText: 'profile-only.example' }).count()) === 0,
    'Profile-only site is not visible under Default',
  );
} finally {
  await context.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll profile UI checks passed.' : `\n${failures} profile UI check(s) failed.`);
if (failures > 0) process.exitCode = 1;
