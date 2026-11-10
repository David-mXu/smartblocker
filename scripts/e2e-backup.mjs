// Real Chrome backup/restore suite. Exercises the shipped options page:
// export bytes, corrupt-import rejection, merge/replace preview + apply,
// lock refusal before writes, and pre-restore recovery.
//
//   node scripts/e2e-backup.mjs
//   SB_SKIP_BUILD=1 node scripts/e2e-backup.mjs
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const ROOT = resolve('.');
const EXT_PATH = resolve('dist/chrome');
const PROFILE = mkdtempSync('/tmp/opencode/smartblocker-backup-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const SCREENSHOT = resolve('docs/audits/assets/2026-11-09-backup.png');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { buildBackup, serializeBackup, BACKUP_SCHEMA_ID, BACKUP_SCHEMA_VERSION } =
  await import('../src/shared/backup.ts');

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
function writeBackupFile(name, document) {
  const path = resolve(PROFILE, name);
  writeFileSync(path, serializeBackup(document));
  return path;
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const NOW = Date.now();
const BASE_POLICY = {
  labels: ['video games', 'programming and software development'],
  blockedLabels: ['video games'],
  blockThreshold: 0.5,
  whitelist: ['local.example'],
  whitelistVersion: 2,
  blocklist: [],
  titleRules: [],
  channelBlocklist: [],
  channelAllowlist: [],
  deletedBuiltinLabels: [],
  focusGoal: 'local focus',
  useTabContext: false,
  blockAdult: false,
  maskSearchElements: true,
  surrenderMode: 'off',
  blockMessage: '',
  breakMode: 'off',
  breakDelayMinutes: 0,
  breakDurationMinutes: 15,
  breakTextLength: 50,
};

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
  viewport: { width: 1180, height: 1100 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});
let sw;
try {
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20_000 });
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  await sw.evaluate(async (basePolicy) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      settings: {
        ...basePolicy,
        enabled: true,
        onboarded: true,
        shareFeedback: false,
        resolveEmbedTitles: false,
        resumeMode: 'off',
        resumeAt: null,
        notificationPrefs: {
          version: 1,
          scheduleStartingSoon: { enabled: false, leadMinutes: 5 },
          breakEndingSoon: { enabled: false, leadMinutes: 5 },
          allowanceLow: { enabled: false, thresholdMinutes: 5 },
        },
        firstDayOfWeek: 0,
        hour24: false,
      },
      'profiles:v1': {
        version: 1,
        activeProfileId: null,
        profiles: [
          {
            id: 'p_local',
            name: 'Local only',
            createdAt: 1000,
            updatedAt: 1000,
            policy: { ...basePolicy, whitelist: ['local-only.example'] },
            appBlocklist: ['steam'],
            appBlocklistUpdatedAt: 0,
          },
        ],
        defaultAppBlocklist: [],
        defaultAppBlocklistUpdatedAt: 0,
      },
      lockState: {
        timerUntil: null,
        passwordHash: null,
        passwordTs: 0,
        frozenUntil: 1,
        schedules: [{ id: 's_local', days: [1], startMinutes: 540, endMinutes: 600 }],
        schedulesUpdatedAt: 100,
        categorySchedules: [],
        categorySchedulesUpdatedAt: 0,
      },
      lockKdf: { salt: 'c'.repeat(32), iterations: 210000, v: 2 },
      usageStats: { pages: 5 },
    });
  }, BASE_POLICY);

  const opts = await context.newPage();
  opts.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [options error]', msg.text());
  });
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#backup`);
  check(
    await poll(() => opts.locator('#backup-export').count().then((count) => count === 1), 15_000, 'backup page'),
    'Backup page renders',
  );
  check(
    (await opts.locator('nav[aria-label="Settings pages"] a[href="#backup"]').count()) === 1,
    'Backup is in the sidebar',
  );

  // ---- Export bytes -------------------------------------------------------
  const downloadPromise = opts.waitForEvent('download');
  await opts.locator('#backup-export').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const exportedText = readFileSync(downloadPath, 'utf8');
  const exported = JSON.parse(exportedText);
  check(exported.schema === BACKUP_SCHEMA_ID, 'Export carries the schema id');
  check(exported.version === BACKUP_SCHEMA_VERSION, 'Export carries the schema version');
  check(exported.profiles.length === 1 && exported.profiles[0].name === 'Local only', 'Export includes named profiles');
  check(exported.schedules.rules.length === 1, 'Export includes focus hours');
  check(exported.default.settings.whitelist.includes('local.example'), 'Export includes Default policy');
  check(
    !exportedText.includes('passwordHash') &&
      !exportedText.includes('lockKdf') &&
      !exportedText.includes('usageStats'),
    'Export excludes lock/password/usage state',
  );
  check(
    (await opts.locator('#backup-msg').textContent())?.includes('downloaded') ?? false,
    'Export reports success',
  );

  // ---- Corrupt import -----------------------------------------------------
  const corruptPath = resolve(PROFILE, 'corrupt.json');
  writeFileSync(corruptPath, '{"schema":"smartblocker.config","version":1');
  await opts.locator('#backup-import').setInputFiles(corruptPath);
  check(
    await poll(
      () => opts.locator('#backup-errors').textContent().then((text) => text?.includes('valid JSON') ?? false),
      10_000,
      'corrupt import error',
    ),
    'Corrupt import is rejected with a validation error',
  );
  check(await opts.locator('#backup-apply').isDisabled(), 'Apply is disabled after a corrupt import');
  check((await opts.locator('#backup-preview-changes li').count()) === 0, 'No preview is shown for a corrupt file');

  // ---- Merge --------------------------------------------------------------
  const mergeDoc = buildBackup({
    settings: {
      enabled: false,
      blockThreshold: 0.4,
      whitelist: ['imported.example'],
      focusGoal: 'imported focus',
    },
    profiles: {
      version: 1,
      activeProfileId: null,
      profiles: [
        {
          id: 'p_work',
          name: 'Work',
          createdAt: 2000,
          updatedAt: 2000,
          policy: {
            ...BASE_POLICY,
            blockThreshold: 0.3,
            whitelist: ['work.example'],
          },
          appBlocklist: ['discord'],
          appBlocklistUpdatedAt: 2000,
        },
      ],
      defaultAppBlocklist: ['slack'],
      defaultAppBlocklistUpdatedAt: 2000,
    },
    lockState: {
      schedules: [{ id: 's_imported', days: [2], startMinutes: 600, endMinutes: 660 }],
      schedulesUpdatedAt: 200,
      categorySchedules: [
        { id: 'c_imported', days: [3], startMinutes: 700, endMinutes: 800, categories: ['video games'] },
      ],
      categorySchedulesUpdatedAt: 200,
    },
    exportedAt: new Date(NOW).toISOString(),
    appVersion: '0.5.0',
    now: NOW,
  });
  const mergePath = writeBackupFile('merge.json', mergeDoc);
  await opts.locator('#backup-import').setInputFiles(mergePath);
  check(
    await poll(
      () => opts.locator('#backup-preview-summary').textContent().then((text) => text?.includes('Merge') ?? false),
      10_000,
      'merge preview',
    ),
    'Merge preview renders',
  );
  check((await opts.locator('#backup-mode-merge').isChecked()) === true, 'Merge is the default mode');
  check(await opts.locator('#backup-apply').isEnabled(), 'Merge apply is enabled');
  check(
    (await opts.locator('#backup-preview-changes li').count()) > 0,
    'Preview lists the changes',
  );
  await opts.screenshot({ path: SCREENSHOT, fullPage: true });
  console.log(`… screenshot: ${SCREENSHOT}`);

  await opts.locator('#backup-apply').click();
  check(
    await poll(
      () => opts.locator('#backup-msg').textContent().then((text) => text?.includes('Merged') ?? false),
      10_000,
      'merge apply',
    ),
    'Merge applies',
  );
  const merged = await sw.evaluate(async () => {
    return chrome.storage.local.get(['settings', 'profiles:v1', 'lockState', 'backup:preRestore:v1']);
  });
  check(merged.settings.blockThreshold === 0.4, 'Merge updates Default threshold');
  check(merged.settings.enabled === false, 'Merge restores the exported master switch');
  check(merged.settings.onboarded === true, 'Merge preserves onboarding state');
  check(merged.settings.whitelist.includes('local.example'), 'Merge unions Default allowed sites (local)');
  check(merged.settings.whitelist.includes('imported.example'), 'Merge unions Default allowed sites (imported)');
  check(
    merged['profiles:v1'].profiles.map((profile) => profile.name).sort().join(',') === 'Local only,Work',
    'Merge keeps local-only profiles and adds imported profiles',
  );
  check(
    merged['profiles:v1'].profiles.find((profile) => profile.name === 'Work')?.appBlocklist.includes('discord') ?? false,
    'Merge imports app associations',
  );
  check(
    merged.lockState.schedules.map((rule) => rule.id).join(',') === 's_imported,s_local',
    'Merge unions focus-hour rules',
  );
  check(
    merged.lockState.categorySchedules.map((rule) => rule.id).join(',') === 'c_imported',
    'Merge adds category windows',
  );
  check(merged.lockState.frozenUntil === 1, 'Merge preserves non-schedule lock fields');
  check(Boolean(merged['backup:preRestore:v1']?.text), 'Merge captures the pre-restore slot');
  const preAfterMerge = JSON.parse(merged['backup:preRestore:v1'].text);
  check(preAfterMerge.default.settings.blockThreshold === 0.5, 'Pre-restore slot holds the pre-merge threshold');
  check(
    await poll(
      () => opts.locator('#backup-pre-restore-info').textContent().then((text) => text?.includes('1 profile') ?? false),
      10_000,
      'pre-restore info',
    ),
    'Pre-restore snapshot appears on the page',
  );

  // ---- Replace ------------------------------------------------------------
  const replaceDoc = buildBackup({
    settings: {
      enabled: true,
      blockThreshold: 0.6,
      whitelist: ['replace.example'],
      focusGoal: 'replace focus',
    },
    profiles: {
      version: 1,
      activeProfileId: 'p_replaced',
      profiles: [
        {
          id: 'p_replaced',
          name: 'Replaced',
          createdAt: 3000,
          updatedAt: 3000,
          policy: { ...BASE_POLICY, blockThreshold: 0.6, whitelist: ['replaced.example'] },
          appBlocklist: [],
          appBlocklistUpdatedAt: 0,
        },
      ],
      defaultAppBlocklist: [],
      defaultAppBlocklistUpdatedAt: 0,
    },
    lockState: {
      schedules: [{ id: 's_replace', days: [5], startMinutes: 480, endMinutes: 540 }],
      schedulesUpdatedAt: 300,
      categorySchedules: [],
      categorySchedulesUpdatedAt: 300,
    },
    exportedAt: new Date(NOW).toISOString(),
    appVersion: '0.5.0',
    now: NOW,
  });
  const replacePath = writeBackupFile('replace.json', replaceDoc);
  await opts.locator('#backup-import').setInputFiles(replacePath);
  check(
    await poll(
      () => opts.locator('#backup-preview-summary').textContent().then((text) => text?.includes('Merge') ?? false),
      10_000,
      'replace file preview (merge mode)',
    ),
    'Imported replace file previews in the current mode',
  );
  await opts.locator('#backup-mode-replace').click();
  check(
    await poll(
      () => opts.locator('#backup-preview-summary').textContent().then((text) => text?.includes('Replace') ?? false),
      10_000,
      'replace preview',
    ),
    'Replace preview renders after switching mode',
  );
  check(
    (await opts.locator('#backup-confirm-replace-note').textContent())?.includes('deletes local profiles') ?? false,
    'Replace explains what is deleted',
  );
  check(await opts.locator('#backup-apply').isDisabled(), 'Replace requires explicit confirmation');
  await opts.locator('#backup-confirm-replace').check();
  check(await opts.locator('#backup-apply').isEnabled(), 'Confirming enables replace');

  await opts.locator('#backup-apply').click();
  check(
    await poll(
      () => opts.locator('#backup-msg').textContent().then((text) => text?.includes('Replaced') ?? false),
      10_000,
      'replace apply',
    ),
    'Replace applies',
  );
  const replaced = await sw.evaluate(async () => {
    return chrome.storage.local.get(['settings', 'profiles:v1', 'lockState', 'backup:preRestore:v1']);
  });
  check(
    replaced['profiles:v1'].profiles.map((profile) => profile.name).join(',') === 'Replaced',
    'Replace removes local-only profiles',
  );
  check(
    replaced['profiles:v1'].activeProfileId === 'p_replaced',
    'Replace restores the exported active profile',
  );
  check(replaced.settings.blockThreshold === 0.6, 'Replace swaps Default settings');
  check(
    replaced.settings.whitelist.join(',') === 'replace.example',
    'Replace swaps the Default whitelist',
  );
  check(
    replaced.lockState.schedules.map((rule) => rule.id).join(',') === 's_replace',
    'Replace swaps focus-hour rules',
  );
  check(
    Array.isArray(replaced.lockState.categorySchedules) &&
      replaced.lockState.categorySchedules.length === 0,
    'Replace explicitly deletes category windows',
  );
  check(
    await poll(
      () => opts.locator('#backup-pre-restore-info').textContent().then((text) => text?.includes('2 profiles') ?? false),
      10_000,
      'pre-restore after replace',
    ),
    'The replace pre-restore slot holds the merged state',
  );

  // ---- Lock refusal -------------------------------------------------------
  await opts.locator('#backup-mode-merge').click();
  check(
    await poll(
      () => opts.locator('#backup-preview-summary').textContent().then((text) => text?.includes('Merge') ?? false),
      10_000,
      'merge mode for lock test',
    ),
    'Prepared a valid merge preview before locking',
  );
  const preLockSlot = await sw.evaluate(async () =>
    chrome.storage.local.get('backup:preRestore:v1').then((value) => value['backup:preRestore:v1']?.savedAt ?? 0),
  );
  const preLockStorage = await sw.evaluate(async () =>
    chrome.storage.local.get(['settings', 'profiles:v1', 'lockState']),
  );
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...stored.lockState, timerUntil: Date.now() + 60_000 },
    });
  });
  check(
    await poll(
      () => opts.locator('#backup-lock-note').isVisible().catch(() => false),
      10_000,
      'lock note',
    ),
    'Locked restore shows a refusal explanation',
  );
  await opts.locator('#backup-apply').click();
  check(
    await poll(
      () => opts.locator('#backup-msg').textContent().then((text) => /locked/i.test(text ?? '') && /refused/i.test(text ?? '')),
      10_000,
      'locked apply message',
    ),
    'Apply while locked reports the refusal',
  );
  const lockedStorage = await sw.evaluate(async () =>
    chrome.storage.local.get(['settings', 'profiles:v1', 'lockState', 'backup:preRestore:v1']),
  );
  check(
    JSON.stringify(lockedStorage.settings) === JSON.stringify(preLockStorage.settings) &&
      JSON.stringify(lockedStorage['profiles:v1']) === JSON.stringify(preLockStorage['profiles:v1']) &&
      JSON.stringify(lockedStorage.lockState.schedules) ===
        JSON.stringify(preLockStorage.lockState.schedules) &&
      JSON.stringify(lockedStorage.lockState.categorySchedules) ===
        JSON.stringify(preLockStorage.lockState.categorySchedules),
    'Locked refusal leaves the live configuration and schedules untouched',
  );
  check(
    lockedStorage['backup:preRestore:v1']?.savedAt === preLockSlot,
    'Locked refusal does not overwrite the pre-restore slot',
  );

  // ---- Pre-restore recovery ----------------------------------------------
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: { ...stored.lockState, timerUntil: null },
    });
  });
  await poll(
    () => opts.locator('#backup-lock-note').isHidden().catch(() => false),
    10_000,
    'lock note clears',
  );
  // The current pre-restore slot was captured before the replace, i.e. it is
  // the merged 2-profile state. Restoring it must bring Local only + Work back.
  await opts.locator('#backup-pre-restore-apply').click();
  check(
    ((await opts.locator('#backup-pre-restore-msg').textContent()) ?? '').includes('Click Restore pre-restore again'),
    'Pre-restore asks for confirmation',
  );
  await opts.locator('#backup-pre-restore-apply').click();
  check(
    await poll(
      () => opts.locator('#backup-pre-restore-msg').textContent().then((text) => text?.includes('applied') ?? false),
      10_000,
      'pre-restore apply',
    ),
    'Pre-restore restores the earlier configuration',
  );
  const recovered = await sw.evaluate(async () => {
    return chrome.storage.local.get(['settings', 'profiles:v1', 'lockState']);
  });
  check(
    recovered['profiles:v1'].profiles.map((profile) => profile.name).sort().join(',') === 'Local only,Work',
    'Pre-restore brings back the merged profiles',
  );
  check(recovered.settings.blockThreshold === 0.4, 'Pre-restore brings back the merged threshold');

  const preDownloadPromise = opts.waitForEvent('download');
  await opts.locator('#backup-pre-restore-download').click();
  const preDownload = await preDownloadPromise;
  const preText = readFileSync(await preDownload.path(), 'utf8');
  const preDoc = JSON.parse(preText);
  check(preDoc.schema === BACKUP_SCHEMA_ID, 'Pre-restore snapshot downloads as a valid backup');
} finally {
  await context.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll backup UI checks passed.' : `\n${failures} backup UI check(s) failed.`);
if (failures > 0) process.exitCode = 1;
