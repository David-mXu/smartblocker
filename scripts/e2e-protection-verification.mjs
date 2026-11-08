// Cold-profile proof-of-protection e2e. Run AFTER `npm run build:chrome`:
//   node scripts/e2e-protection-verification.mjs
//
// Uses a dedicated disposable profile so model initialization is genuinely
// cold. No fixture tabs are opened by VERIFY_PROTECTION: the test sends the RPC
// from one extension page, then sabotages the real offscreen inference channel.
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOCKED_LABELS, BLOCK_THRESHOLD, LABELS } from '../src/shared/config.ts';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.dev-profile-protection');
const MODEL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CORE = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
};

rmSync(PROFILE, { recursive: true, force: true });

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      const swPromise = context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
      const waker = await context.newPage();
      await waker.goto('https://example.com').catch(() => {});
      sw = context.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (sw) return { context, sw };
    await context.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`service worker did not start after 3 launches (attempt ${3})`);
}

function pass(condition, name, details = '') {
  if (!condition) throw new Error(`${name}${details ? `\n${details}` : ''}`);
  console.log(`PASS ${name}`);
}

function compactReport(report) {
  return JSON.stringify({
    status: report?.status,
    saved: report?.saved,
    error: report?.error,
    checks: report?.checks?.map((check) => ({
      id: check.id,
      status: check.status,
      label: check.verdict?.label,
      decision: check.verdict?.decision,
      cached: check.verdict?.cached,
    })),
  });
}

const { context, sw } = await launchWithServiceWorker();
let page;

try {
  const extensionId = new URL(sw.url()).host;
  console.log('PASS service worker booted in a cold profile');
  sw.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [sw:error]', msg.text());
  });

  await sw.evaluate(async (defaults) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings: defaults });
  }, DEFAULT_CORE);

  page = context.pages().find((candidate) => candidate.url().includes('/options.html')) ?? (await context.newPage());
  await page.goto(`chrome-extension://${extensionId}/options.html#advanced`);

  async function rpc(type, timeoutMs = MODEL_TIMEOUT_MS) {
    let timer;
    try {
      return await Promise.race([
        page.evaluate((messageType) => chrome.runtime.sendMessage({ type: messageType }), type),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${type} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const onboarded = () =>
    sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.onboarded === true);

  async function sabotageClassifier() {
    await sw.evaluate(() => {
      const g = globalThis;
      if (!g.__sbProtectionOrigSend) g.__sbProtectionOrigSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      g.__sbProtectionSabotageCalls = 0;
      chrome.runtime.sendMessage = (message, ...rest) => {
        if (message && (message.type === 'EMBED' || message.type === 'CLASSIFY')) {
          g.__sbProtectionSabotageCalls++;
          return Promise.reject(new Error('forced fresh-inference failure (protection e2e)'));
        }
        return g.__sbProtectionOrigSend(message, ...rest);
      };
    });
  }

  const repairClassifier = () =>
    sw.evaluate(() => {
      if (globalThis.__sbProtectionOrigSend) chrome.runtime.sendMessage = globalThis.__sbProtectionOrigSend;
    });
  const sabotageCalls = () => sw.evaluate(() => globalThis.__sbProtectionSabotageCalls ?? 0);

  // 1. Cold model + real host permission + expected semantic/policy decisions.
  const cold = await rpc('VERIFY_PROTECTION');
  const coldDistraction = cold.checks?.find((check) => check.id === 'distraction');
  const coldProductive = cold.checks?.find((check) => check.id === 'productive');
  pass(
    cold.status === 'ready' &&
      coldDistraction?.verdict?.label === 'video games' &&
      coldDistraction?.verdict?.decision === 'block' &&
      coldProductive?.verdict?.label === 'programming and software development' &&
      coldProductive?.verdict?.decision === 'allow' &&
      cold.checks?.find((check) => check.id === 'site-access')?.status === 'passed',
    'cold profile proves gaming/block, programming/allow, and all-site access',
    compactReport(cold),
  );
  pass(
    cold.checks?.filter((check) => check.verdict).every((check) => check.verdict.cached === false),
    'both successful fixture decisions used fresh inference',
    compactReport(cold),
  );
  pass(!(await onboarded()), 'read-only verification does not mark onboarding complete');

  // 2. Prime the title cache above, then kill the real offscreen channel. A
  // cached verdict must not conceal the outage or permit completion.
  await sabotageClassifier();
  const warmFailure = await rpc('VERIFY_PROTECTION');
  pass(
    warmFailure.status === 'error' &&
      warmFailure.checks?.find((check) => check.id === 'distraction')?.status === 'error' &&
      (await sabotageCalls()) >= 2,
    'warm cache cannot hide sabotaged fresh inference',
    `${compactReport(warmFailure)} calls=${await sabotageCalls()}`,
  );
  const failedCompletion = await rpc('COMPLETE_ONBOARDING');
  pass(
    failedCompletion.status === 'error' && failedCompletion.saved === false && !(await onboarded()),
    'background completion refuses to persist during a model outage',
    compactReport(failedCompletion),
  );

  // 3. The actual wizard exposes the error and its unverified exit leaves setup
  // unfinished (the toolbar state is not used as a success proxy).
  await page.goto(`chrome-extension://${extensionId}/options.html#welcome`);
  await page.evaluate(() => localStorage.setItem('smartblocker.welcomeStep', '2'));
  await page.reload();
  await page.waitForSelector('#welcome-verification[data-state="error"]', { timeout: 30_000 });
  pass(await page.locator('#welcome-start').isDisabled(), 'wizard disables Start blocking after inference failure');
  await page.click('#welcome-continue-unverified');
  await page.waitForFunction(() => !document.querySelector('#welcome-wizard'));
  pass(!(await onboarded()), 'Continue without verification leaves onboarded false');

  // 4. Repair the SAME worker/model path and demand a fresh ready report.
  await repairClassifier();
  const recovered = await rpc('VERIFY_PROTECTION');
  pass(
    recovered.status === 'ready' &&
      recovered.checks?.filter((check) => check.verdict).every((check) => check.verdict.cached === false),
    'repairing inference restores ready without relying on cache',
    compactReport(recovered),
  );

  // 5. Host access is checked at completion time, after inference too.
  await sw.evaluate(() => {
    const g = globalThis;
    g.__sbProtectionOrigContains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = (query) =>
      query?.origins?.includes('<all_urls>') ? Promise.resolve(false) : g.__sbProtectionOrigContains(query);
  });
  const denied = await rpc('COMPLETE_ONBOARDING');
  pass(
    denied.status === 'degraded' &&
      denied.saved === false &&
      denied.checks?.find((check) => check.id === 'site-access')?.status === 'failed' &&
      !(await onboarded()),
    'permission denial is degraded and cannot complete onboarding',
    compactReport(denied),
  );
  await sw.evaluate(() => {
    chrome.permissions.contains = globalThis.__sbProtectionOrigContains;
  });

  // 6. Both fixtures are incompatible here. Even with inference sabotaged,
  // these must be configuration diagnostics with ZERO model calls, not errors.
  await sabotageClassifier();
  await sw.evaluate(async (defaults) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        ...defaults,
        blockedLabels: [
          ...defaults.blockedLabels.filter((label) => label !== 'video games'),
          'programming and software development',
        ],
      },
    });
  }, DEFAULT_CORE);
  const incompatible = await rpc('COMPLETE_ONBOARDING');
  const incompatibleDetails = incompatible.checks?.map((check) => check.detail).join('\n') ?? '';
  pass(
    incompatible.status === 'degraded' &&
      incompatible.saved === false &&
      incompatible.checks?.find((check) => check.id === 'distraction')?.status === 'failed' &&
      incompatible.checks?.find((check) => check.id === 'productive')?.status === 'failed' &&
      /current settings allow/.test(incompatibleDetails) &&
      /current settings block/.test(incompatibleDetails) &&
      (await sabotageCalls()) === 0 &&
      !(await onboarded()),
    'incompatible custom settings produce configuration guidance without model-failure claims',
    `${compactReport(incompatible)}\n${incompatibleDetails}\ncalls=${await sabotageCalls()}`,
  );
  await repairClassifier();

  // 7. Force run A (default/ready) to resolve after run B (custom/degraded).
  // Leaving the final step must invalidate A, not let it re-enable the CTA.
  await sw.evaluate(async (defaults) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...defaults } });
  }, DEFAULT_CORE);
  await page.goto(`chrome-extension://${extensionId}/options.html#welcome`);
  await page.evaluate(() => localStorage.setItem('smartblocker.welcomeStep', '2'));
  await page.reload();
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let delayFirst = true;
    chrome.runtime.sendMessage = async (message, ...rest) => {
      const pending = original(message, ...rest);
      if (message?.type === 'VERIFY_PROTECTION' && delayFirst) {
        delayFirst = false;
        const report = await pending;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_800));
        return report;
      }
      return pending;
    };
  });
  await page.waitForSelector('#welcome-verification[data-state="checking"]');
  await page.click('#welcome-back');
  await sw.evaluate(async (defaults) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, blockedLabels: defaults.blockedLabels.filter((label) => label !== 'video games') },
    });
  }, DEFAULT_CORE);
  await page.click('#welcome-continue');
  await page.waitForSelector('#welcome-verification[data-state="degraded"]', { timeout: 30_000 });
  await page.waitForTimeout(2_200);
  pass(
    (await page.locator('#welcome-verification').getAttribute('data-state')) === 'degraded' &&
      (await page.locator('#welcome-start').isDisabled()),
    'delayed stale ready result cannot overwrite the newer degraded check',
  );

  // 8. Restoring compatible settings from another context must invalidate the
  // degraded preview automatically. Delay the completion RESPONSE to inspect
  // the real pending UI; navigation/unverified exit must all be disabled.
  await sw.evaluate(async (defaults) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...defaults } });
  }, DEFAULT_CORE);
  await page.waitForSelector('#welcome-verification[data-state="ready"]', { timeout: 60_000 });
  pass(!(await page.locator('#welcome-start').isDisabled()), 'external settings recovery refreshes ready and enables Start blocking');
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message, ...rest) => {
      const pending = original(message, ...rest);
      if (message?.type === 'COMPLETE_ONBOARDING') {
        const report = await pending;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
        return report;
      }
      return pending;
    };
  });
  await page.click('#welcome-start');
  await page.waitForSelector('#welcome-verification[data-state="checking"]');
  pass(
    (await page.locator('#welcome-continue-unverified').isDisabled()) &&
      (await page.locator('#welcome-back').isDisabled()) &&
      (await page.locator('button[aria-label="Change blocked categories"]').isDisabled()),
    'commit-pending UI disables unverified exit, Back, and settings navigation',
  );
  await page.waitForFunction(() => !document.querySelector('#welcome-wizard'), undefined, { timeout: 60_000 });
  const finalSettings = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  pass(
    finalSettings?.onboarded === true && finalSettings?.enabled === true,
    'real wizard persists enabled + onboarded only after background completion passes',
    JSON.stringify({ enabled: finalSettings?.enabled, onboarded: finalSettings?.onboarded }),
  );
} finally {
  await context.close();
}

console.log('E2E-PROTECTION: ALL PASSED');
