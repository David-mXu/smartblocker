#!/usr/bin/env node
// Real Firefox cold-profile onboarding + ordinary navigation enforcement.
// Run after `npm run build:firefox`:
//   SB_FIREFOX=/path/to/firefox node scripts/e2e-firefox-onboarding.mjs
//
// No cached verdict, weakened blocking rule, or fabricated verification report
// can produce a passing readiness result here. The suite rejects the genuine
// background fetch before the first model load, repairs that same event page,
// and requires fresh gaming/block + programming/allow inference. It later
// restarts the add-on with title verdicts in storage but model CacheStorage and
// network unavailable, proving warm verdicts cannot hide an inference outage.
// Ordinary overlay navigation separately uses fresh, non-fixture titles on a
// local HTTP document (127.0.0.1 is removed only from the disposable profile's
// whitelist so the configured classifier is actually exercised).
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKED_LABELS, BLOCK_THRESHOLD, LABELS } from '../src/shared/config.ts';
import {
  EXTENSION_ORIGIN,
  FirefoxTestSession,
  GECKO_ID,
  makeChecker,
  sleep,
} from './lib/firefox-marionette.mjs';

const SB_FIREFOX = process.env.SB_FIREFOX;
if (!SB_FIREFOX) {
  console.error('SB_FIREFOX env var required (path to a Firefox binary)');
  process.exit(2);
}

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'firefox');
const OPTIONS_URL = `${EXTENSION_ORIGIN}/options.html`;
const MODEL_TIMEOUT_MS = Number(process.env.SB_FIREFOX_MODEL_TIMEOUT_MS ?? 8 * 60_000);
if (!Number.isFinite(MODEL_TIMEOUT_MS) || MODEL_TIMEOUT_MS < 30_000) {
  throw new Error('SB_FIREFOX_MODEL_TIMEOUT_MS must be a finite number >= 30000');
}
const DEFAULT_CORE = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
};
const GAME_TITLE = 'Firefox runtime speedrunning Dark Souls and Minecraft';
const PRODUCTIVE_TITLE = 'Firefox runtime React Router and TypeScript tutorial';

const { check, finish } = makeChecker('E2E-FIREFOX');
const must = (condition, label, details = '') => {
  check(condition, label, details);
  if (!condition) throw new Error(label);
};

function compactReport(report) {
  return JSON.stringify({
    status: report?.status,
    saved: report?.saved,
    error: report?.error,
    checks: report?.checks?.map((entry) => ({
      id: entry.id,
      status: entry.status,
      label: entry.verdict?.label,
      decision: entry.verdict?.decision,
      cached: entry.verdict?.cached,
      detail: entry.status === 'passed' ? undefined : entry.detail,
    })),
  });
}

function readyWithFreshVerdicts(report) {
  const distraction = report?.checks?.find((entry) => entry.id === 'distraction');
  const productive = report?.checks?.find((entry) => entry.id === 'productive');
  return (
    report?.status === 'ready' &&
    distraction?.verdict?.label === 'video games' &&
    distraction?.verdict?.decision === 'block' &&
    distraction?.verdict?.cached === false &&
    productive?.verdict?.label === 'programming and software development' &&
    productive?.verdict?.decision === 'allow' &&
    productive?.verdict?.cached === false &&
    report?.checks?.find((entry) => entry.id === 'site-access')?.status === 'passed'
  );
}

let session;
let fixtureServer;
let driver;

async function readSettings() {
  return driver.evalAsync(`return (await browser.storage.local.get('settings')).settings ?? {};`);
}

async function patchStoredSettings(patch) {
  return driver.evalAsync(
    `const patch = injected[0];
     const { settings = {} } = await browser.storage.local.get('settings');
     await browser.storage.local.set({ settings: { ...settings, ...patch } });
     return (await browser.storage.local.get('settings')).settings;`,
    'content',
    [patch],
  );
}

async function onboarded() {
  return (await readSettings()).onboarded === true;
}

async function rpc(type) {
  return driver.evalAsync(
    `return await browser.runtime.sendMessage({ type: injected[0] });`,
    'content',
    [type],
    MODEL_TIMEOUT_MS,
  );
}

async function click(selector) {
  const clicked = await driver.eval(
    `const element = document.querySelector(arguments[0]);
     if (!element || element.disabled) return false;
     element.click();
     return true;`,
    'content',
    [selector],
  );
  if (!clicked) throw new Error(`Cannot click enabled element ${selector}`);
}

async function ensureAllSitesAccess() {
  const initiallyGranted = await driver.evalAsync(
    `return await browser.permissions.contains({ origins: ['<all_urls>'] });`,
  );
  if (initiallyGranted) return;

  // Older Firefox builds default optional host access to denied. Change that
  // real browser state only through about:addons trusted pointer input; no
  // permissions.contains mock or privileged grant API participates here.
  const card = 'addon-card[addon-id="smartblocker-poc@davidxu.dev"]';
  const addonLink = `${card} .addon-name-link`;
  const toggle = 'moz-toggle[permission-key="<all_urls>"]';
  const nativeClick = async (selector) => {
    await session.nativeClick(`return document.querySelector(arguments[0]);`, [selector]);
  };
  await session.load('about:addons');
  await session.waitFor(`return Boolean(document.querySelector('button[name="extension"]'));`, {
    description: 'Firefox Extensions category before native host grant',
  });
  await nativeClick('button[name="extension"]');
  await session.waitFor(`return Boolean(document.querySelector(${JSON.stringify(addonLink)}));`, {
    description: 'SmartBlocker card before native host grant',
  });
  const expanded = await driver.eval(
    `return document.querySelector(arguments[0])?.getAttribute('expanded') === 'true';`,
    'content',
    [card],
  );
  if (!expanded) await nativeClick(addonLink);
  await session.waitFor(
    `return Boolean(document.querySelector(${JSON.stringify(`${card}[expanded="true"] addon-details`)}));`,
    { description: 'SmartBlocker details before native host grant' },
  );
  await nativeClick('#details-deck-button-permissions');
  await session.waitFor(
    `return Boolean(document.querySelector(${JSON.stringify(toggle)})?.shadowRoot);`,
    { description: 'native all-site permission toggle' },
  );
  const pressed = await driver.eval(
    `return document.querySelector(arguments[0])?.shadowRoot
       ?.querySelector('button')?.getAttribute('aria-pressed');`,
    'content',
    [toggle],
  );
  if (pressed !== 'true') await nativeClick(toggle);
  await session.waitFor(
    `return document.querySelector(${JSON.stringify(toggle)})?.shadowRoot
       ?.querySelector('button')?.getAttribute('aria-pressed') === 'true';`,
    { description: 'native all-site permission enabled' },
  );
  await session.load(`${OPTIONS_URL}#advanced`);
  const granted = await driver.evalAsync(
    `return await browser.permissions.contains({ origins: ['<all_urls>'] });`,
  );
  must(granted, 'native about:addons preflight grants real all-site access on default-denied Firefox');
}

async function waitForVerification(state, timeoutMs = 90_000) {
  try {
    await session.waitFor(
      `return document.querySelector('#welcome-verification')?.dataset.state === arguments[0];`,
      { args: [state], timeoutMs, description: `welcome verification state ${state}` },
    );
  } catch (error) {
    const ui = await driver.eval(
      `return {
         url: location.href,
         state: document.querySelector('#welcome-verification')?.dataset.state ?? null,
         text: document.querySelector('#welcome-verification')?.textContent?.slice(0, 2000) ?? null,
         step: localStorage.getItem('smartblocker.welcomeStep'),
       };`,
    ).catch((probeError) => ({ probeError: String(probeError) }));
    console.error(`… verification wait expected ${state}`, JSON.stringify(ui));
    throw error;
  }
}

async function sabotageModelFetch() {
  const result = await driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     if (!background) return { patched: false };
     if (!background.__sbFirefoxOriginalFetch) {
       background.__sbFirefoxOriginalFetch = background.fetch.bind(background);
     }
     background.__sbFirefoxFetchFaults = 0;
     background.__sbFirefoxFaultUrls = [];
     background.fetch = (input, ...rest) => {
       const url = typeof input === 'string' ? input : input?.url ?? String(input);
       background.__sbFirefoxFetchFaults++;
       background.__sbFirefoxFaultUrls.push(url);
       return Promise.reject(new Error('forced Firefox model-download failure (onboarding e2e)'));
     };
     return {
       patched: true,
       backgroundUrl: background.location.href,
       firefoxApi: typeof background.browser?.runtime?.getBrowserInfo === 'function',
       hasOffscreen: typeof background.chrome?.offscreen !== 'undefined',
     };`,
  );
  must(result.patched && result.firefoxApi, 'fault injection reached the genuine Firefox event page', JSON.stringify(result));
  return result;
}

async function repairModelFetch() {
  return driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     if (background?.__sbFirefoxOriginalFetch) background.fetch = background.__sbFirefoxOriginalFetch;
     return { repaired: Boolean(background?.__sbFirefoxOriginalFetch) };`,
  );
}

async function fetchFaults() {
  return driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     return {
       calls: background?.__sbFirefoxFetchFaults ?? null,
       urls: background?.__sbFirefoxFaultUrls?.slice(0, 4) ?? [],
     };`,
  );
}

async function restartInstalledAddon() {
  // Keep Marionette's adopted content handle on a browser-owned page while
  // every extension document is torn down. Otherwise SetContext loses its
  // original browsing context and the test driver dies with the event page.
  await session.load('about:blank');
  try {
    await driver.evalAsync(
      `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
       const addon = await AddonManager.getAddonByID(injected[0]);
       if (!addon) throw new Error('installed addon missing before restart');
       await addon.disable();
       return { active: addon.isActive, disabled: !addon.isActive };`,
      'chrome',
      [GECKO_ID],
    );
  } catch (error) {
    // Disabling an add-on necessarily unloads its options document. Marionette
    // reports that expected transition even though chrome context issued the
    // AddonManager operation. Any other failure still fails the suite.
    if (!/Document was unloaded/i.test(error?.message ?? '')) throw error;
  }
  await sleep(1000);
  const state = await driver.evalAsync(
    `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     const addon = await AddonManager.getAddonByID(injected[0]);
     await addon.enable();
     return { active: addon.isActive };`,
    'chrome',
    [GECKO_ID],
  );
  must(state.active, 'Firefox disabled and re-enabled the same installed add-on');
  await session.load(`${OPTIONS_URL}#advanced`);
}

async function instrumentDelayedVerification() {
  return driver.evalAsync(
    `const page = window.wrappedJSObject ?? window;
     const runtime = (page.browser ?? browser).runtime;
     const original = runtime.sendMessage.bind(runtime);
     page.__sbFirefoxDelayVerification = true;
     const wrapped = async (message, ...rest) => {
       const pending = original(message, ...rest);
       if (message?.type === 'VERIFY_PROTECTION' && page.__sbFirefoxDelayVerification) {
         // The caller disables delay after observing the intended checking run.
         const report = await pending;
         await new Promise((resolve) => setTimeout(resolve, 1800));
         return report;
       }
       return pending;
     };
     runtime.sendMessage = wrapped;
     return { patched: runtime.sendMessage === wrapped, sharedPageApi: Boolean(page.browser) };`,
  );
}

async function instrumentDelayedCompletion() {
  return driver.evalAsync(
    `const page = window.wrappedJSObject ?? window;
     const runtime = (page.browser ?? browser).runtime;
     const original = runtime.sendMessage.bind(runtime);
     const wrapped = async (message, ...rest) => {
       const pending = original(message, ...rest);
       if (message?.type === 'COMPLETE_ONBOARDING') {
         const report = await pending;
         await new Promise((resolve) => setTimeout(resolve, 1200));
         return report;
       }
       return pending;
     };
     runtime.sendMessage = wrapped;
     return { patched: runtime.sendMessage === wrapped, sharedPageApi: Boolean(page.browser) };`,
  );
}

try {
  session = await FirefoxTestSession.launch({
    firefoxPath: SB_FIREFOX,
    dist: DIST,
    scriptTimeoutMs: MODEL_TIMEOUT_MS + 15_000,
  });
  driver = session.driver;
  await sleep(2000);

  const install = await driver.evalAsync(
    `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     const addon = await AddonManager.getAddonByID(injected[0]);
     const win = Services.wm.getMostRecentWindow('navigator:browser');
     return {
       active: Boolean(addon?.isActive),
       installTabs: win.gBrowser.browsers.map((browser) => browser?.currentURI?.spec ?? ''),
     };`,
    'chrome',
    [GECKO_ID],
  );
  must(install.active, 'cold Firefox installed and activated the packed SmartBlocker XPI');
  must(
    install.installTabs.some((url) => url === `${OPTIONS_URL}#welcome`),
    'first install opened the exact real welcome wizard URL',
    JSON.stringify(install.installTabs),
  );

  await session.load(`${OPTIONS_URL}#advanced`);
  await driver.evalAsync(
    `await browser.storage.local.clear();
     await browser.storage.local.set({ settings: injected[0] });
     return 'cold settings reset';`,
    'content',
    [DEFAULT_CORE],
  );

  await ensureAllSitesAccess();
  const apiProbe = await driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     const info = await browser.runtime.getBrowserInfo();
     const localOrt = await Promise.all(
       ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'].map(async (file) => {
         const response = await fetch(browser.runtime.getURL(file), { method: 'HEAD' });
         return { file, ok: response.ok, status: response.status };
       }),
     );
     return {
       info,
       localOrt,
       backgroundUrl: background?.location.href ?? null,
       permission: await browser.permissions.contains({ origins: ['<all_urls>'] }),
       scripting: typeof browser.scripting?.executeScript,
       navigation: typeof browser.webNavigation?.onCommitted?.addListener,
       history: typeof browser.history?.search,
       alarms: typeof browser.alarms?.create,
       dnr: typeof browser.declarativeNetRequest?.updateSessionRules,
       offscreen: typeof background?.chrome?.offscreen,
     };`,
  );
  console.log('… Firefox runtime:', JSON.stringify(apiProbe));
  must(
    apiProbe.backgroundUrl?.startsWith(`${EXTENSION_ORIGIN}/`) &&
      apiProbe.localOrt?.every((asset) => asset.ok) &&
      apiProbe.permission === true &&
      apiProbe.scripting === 'function' &&
      apiProbe.navigation === 'function' &&
      apiProbe.history === 'function' &&
      apiProbe.alarms === 'function' &&
      apiProbe.dnr === 'function' &&
      apiProbe.offscreen === 'undefined',
    'Firefox exposes required APIs, real all-site access, and no Chromium offscreen backend',
    JSON.stringify(apiProbe),
  );

  // 1. A genuinely cold event page must fail first, before any successful
  // inference or model CacheStorage exists in this disposable profile.
  await sabotageModelFetch();
  const coldFailure = await rpc('VERIFY_PROTECTION');
  const coldFaults = await fetchFaults();
  must(
    coldFailure.status === 'error' &&
      coldFailure.checks?.find((entry) => entry.id === 'distraction')?.status === 'error' &&
      coldFailure.checks?.find((entry) => entry.id === 'productive')?.status === 'error' &&
      coldFaults.calls >= 2,
    'cold model-download failure reaches both fresh checks instead of fabricating readiness',
    `${compactReport(coldFailure)} faults=${JSON.stringify(coldFaults)}`,
  );
  const failedColdCompletion = await rpc('COMPLETE_ONBOARDING');
  must(
    failedColdCompletion.status === 'error' && failedColdCompletion.saved === false && !(await onboarded()),
    'background refuses onboarding persistence during the cold model outage',
    compactReport(failedColdCompletion),
  );

  // 2. Incompatible settings are configuration failures, not model errors.
  // Since the model is still cold and fetch is failing, zero new fetch calls is
  // a meaningful assertion that neither fixture ran inference.
  await patchStoredSettings({
    ...DEFAULT_CORE,
    blockedLabels: [
      ...DEFAULT_CORE.blockedLabels.filter((label) => label !== 'video games'),
      'programming and software development',
    ],
  });
  const faultsBeforeConfig = (await fetchFaults()).calls;
  const incompatible = await rpc('COMPLETE_ONBOARDING');
  const faultsAfterConfig = (await fetchFaults()).calls;
  const incompatibleDetails = incompatible.checks?.map((entry) => entry.detail).join('\n') ?? '';
  must(
    incompatible.status === 'degraded' &&
      incompatible.saved === false &&
      incompatible.checks?.find((entry) => entry.id === 'distraction')?.status === 'failed' &&
      incompatible.checks?.find((entry) => entry.id === 'productive')?.status === 'failed' &&
      /current settings allow/.test(incompatibleDetails) &&
      /current settings block/.test(incompatibleDetails) &&
      faultsAfterConfig === faultsBeforeConfig &&
      !(await onboarded()),
    'incompatible settings produce guidance with zero attempted model downloads',
    `${compactReport(incompatible)}\n${incompatibleDetails}\nfaults=${faultsBeforeConfig}->${faultsAfterConfig}`,
  );
  await patchStoredSettings(DEFAULT_CORE);

  // 3. Walk the real first-run steps into the still-failing final step.
  await session.load(`${OPTIONS_URL}#welcome`);
  await session.waitFor(`return Boolean(document.querySelector('#welcome-continue'));`, {
    description: 'welcome categories step',
  });
  await click('#welcome-continue');
  await session.waitFor(`return document.body.textContent.includes('Step 2 of 3');`, {
    description: 'welcome sites step',
  });
  await click('#welcome-continue');
  await waitForVerification('error');
  must(
    await driver.eval(`return document.querySelector('#welcome-start')?.disabled === true;`),
    'real Firefox wizard disables Start blocking after model failure',
  );
  await click('#welcome-continue-unverified');
  await session.waitFor(`return !document.querySelector('#welcome-wizard');`, {
    description: 'unverified wizard exit',
  });
  must(!(await onboarded()), 'Continue without verification leaves Firefox onboarding unfinished');

  // 4. Repair the SAME event page and require a real cold model initialization,
  // ONNX/WASM work, centroid construction, and two fresh semantic decisions.
  await session.load(`${OPTIONS_URL}#advanced`);
  const repaired = await repairModelFetch();
  must(repaired.repaired, 'repaired the same Firefox event-page fetch boundary');
  const coldReady = await rpc('VERIFY_PROTECTION');
  must(
    readyWithFreshVerdicts(coldReady),
    'cold Firefox model recovers with fresh gaming/block, programming/allow, and site access',
    compactReport(coldReady),
  );
  must(!(await onboarded()), 'read-only Firefox readiness never marks onboarding complete');

  const modelEvidence = await driver.evalAsync(
    `const stored = await browser.storage.local.get(['centroidCache', 'titleCache']);
     let cacheNames;
     let cacheError = null;
     try { cacheNames = await caches.keys(); } catch (error) { cacheNames = []; cacheError = String(error); }
     return {
       cacheNames,
       cacheError,
       centroidNames: stored.centroidCache?.names?.length ?? 0,
       centroidSeedGroups: stored.centroidCache?.seedVectors?.length ?? 0,
       titleVerdicts: Object.keys(stored.titleCache ?? {}).length,
     };`,
  );
  console.log('… model/cache evidence:', JSON.stringify(modelEvidence));
  must(
    modelEvidence.centroidNames > 0 &&
      modelEvidence.centroidSeedGroups === modelEvidence.centroidNames &&
      modelEvidence.titleVerdicts >= 2,
    'Firefox persisted real centroid vectors and fresh title verdicts',
    JSON.stringify(modelEvidence),
  );

  // 5. Restart the event page while verdicts survive, remove model bytes only,
  // and block the network. A title-cache hit must not be accepted as readiness.
  const titleCountBeforeRestart = modelEvidence.titleVerdicts;
  const purged = await driver.evalAsync(
    `let names = [];
     try {
       names = await caches.keys();
       await Promise.all(names.map((name) => caches.delete(name)));
       return { names, remaining: await caches.keys() };
     } catch (error) { return { names, remaining: [], cacheError: String(error) }; }`,
  );
  await restartInstalledAddon();
  const warmStored = await driver.evalAsync(`return await browser.storage.local.get('titleCache');`);
  await sabotageModelFetch();
  const warmFailure = await rpc('VERIFY_PROTECTION');
  must(
    Object.keys(warmStored.titleCache ?? {}).length === titleCountBeforeRestart &&
      titleCountBeforeRestart > 0 &&
      warmFailure.status === 'error' &&
      warmFailure.checks?.find((entry) => entry.id === 'distraction')?.status === 'error' &&
      (await fetchFaults()).calls > 0,
    'after event-page restart, surviving title verdicts cannot hide an unavailable model',
    `${compactReport(warmFailure)} cachePurge=${JSON.stringify(purged)} faults=${JSON.stringify(await fetchFaults())}`,
  );
  const warmFailedCompletion = await rpc('COMPLETE_ONBOARDING');
  must(
    warmFailedCompletion.status === 'error' && warmFailedCompletion.saved === false && !(await onboarded()),
    'restarted background still refuses completion under fresh-inference failure',
    compactReport(warmFailedCompletion),
  );
  await repairModelFetch();
  const warmRecovered = await rpc('VERIFY_PROTECTION');
  must(
    readyWithFreshVerdicts(warmRecovered),
    'restarted Firefox event page recovers with fresh inference again',
    compactReport(warmRecovered),
  );

  // 6. Permission denial is independently rechecked at background commit time.
  const permissionPatch = await driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     const original = background.browser.permissions.contains.bind(background.browser.permissions);
     const mocked = (query) => query?.origins?.includes('<all_urls>')
       ? Promise.resolve(false)
       : original(query);
     background.__sbFirefoxOriginalContains = original;
     background.browser.permissions.contains = mocked;
     return {
       patched: background.browser.permissions.contains === mocked,
       denied: !(await background.browser.permissions.contains({ origins: ['<all_urls>'] })),
     };`,
  );
  must(permissionPatch.patched && permissionPatch.denied, 'permission-denial fault reached the background API boundary');
  const denied = await rpc('COMPLETE_ONBOARDING');
  await driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     background.browser.permissions.contains = background.__sbFirefoxOriginalContains;
     return !(await browser.permissions.contains({ origins: ['<all_urls>'] })) === false;`,
  );
  must(
    denied.status === 'degraded' &&
      denied.saved === false &&
      denied.checks?.find((entry) => entry.id === 'site-access')?.status === 'failed' &&
      !(await onboarded()),
    'Firefox permission denial is degraded and cannot complete onboarding',
    compactReport(denied),
  );

  // 7. A delayed ready response must not overwrite the newer degraded run.
  await patchStoredSettings(DEFAULT_CORE);
  await session.load(`${OPTIONS_URL}#welcome`);
  await driver.eval(`localStorage.setItem('smartblocker.welcomeStep', '2'); location.reload(); return true;`);
  // Firefox 121 can execute the next Marionette command in the outgoing
  // navigation context, which returns a null async result instead of the
  // instrumentation evidence. Bind the patch to the actual reloaded wizard.
  await session.waitFor(`return Boolean(document.querySelector('#welcome-verification'));`, {
    description: 'reloaded final wizard before delayed-response instrumentation',
  });
  const verifyDelay = await instrumentDelayedVerification();
  must(verifyDelay.patched, 'options-page runtime messaging accepted the stale-response probe', JSON.stringify(verifyDelay));
  // Warm ESR can finish the initial check before the hook is installed.
  // Reordering only the SAME blocked labels triggers a genuine policy check
  // without changing the classifier policy or weakening any block decision.
  await patchStoredSettings({ blockedLabels: [...DEFAULT_CORE.blockedLabels].reverse() });
  await waitForVerification('checking');
  await driver.eval(
    `const page = window.wrappedJSObject ?? window;
     page.__sbFirefoxDelayVerification = false;
     return true;`,
  );
  await click('#welcome-back');
  await patchStoredSettings({
    blockedLabels: DEFAULT_CORE.blockedLabels.filter((label) => label !== 'video games'),
  });
  await click('#welcome-continue');
  await waitForVerification('degraded');
  await sleep(2300);
  must(
    await driver.eval(
      `return document.querySelector('#welcome-verification')?.dataset.state === 'degraded' &&
         document.querySelector('#welcome-start')?.disabled === true;`,
    ),
    'delayed stale Firefox ready result cannot overwrite newer degraded settings',
  );

  // 8. An external settings recovery refreshes the preview. Delay only the
  // completion RESPONSE to observe all real commit-pending controls.
  await patchStoredSettings(DEFAULT_CORE);
  await waitForVerification('ready');
  must(
    await driver.eval(`return document.querySelector('#welcome-start')?.disabled === false;`),
    'external Firefox settings recovery refreshes ready and enables Start blocking',
  );
  const completionDelay = await instrumentDelayedCompletion();
  must(completionDelay.patched, 'options-page runtime accepted the commit-pending probe', JSON.stringify(completionDelay));
  await click('#welcome-start');
  await waitForVerification('checking');
  must(
    await driver.eval(
      `return document.querySelector('#welcome-continue-unverified')?.disabled === true &&
         document.querySelector('#welcome-back')?.disabled === true &&
         document.querySelector('button[aria-label="Change blocked categories"]')?.disabled === true;`,
    ),
    'Firefox commit-pending UI disables unverified exit, Back, and settings navigation',
  );
  await session.waitFor(`return !document.querySelector('#welcome-wizard');`, {
    timeoutMs: 90_000,
    description: 'verified wizard completion',
  });
  const finalSettings = await readSettings();
  must(
    finalSettings.enabled === true && finalSettings.onboarded === true,
    'real Firefox wizard persists enabled + onboarded after background completion passes',
    JSON.stringify({ enabled: finalSettings.enabled, onboarded: finalSettings.onboarded }),
  );

  // 9. Mount both other extension surfaces and round-trip real storage/UI state.
  await session.load(`${EXTENSION_ORIGIN}/popup.html`);
  await session.waitFor(`return Boolean(document.querySelector('#popup-enabled-toggle'));`, {
    description: 'Firefox popup mount',
  });
  must(
    await driver.eval(
      `return document.querySelector('#popup-enabled-toggle')?.checked === true &&
         Boolean(document.querySelector('#open-options')) &&
         typeof browser.runtime.getBackgroundPage === 'function';`,
    ),
    'Firefox popup mounts against real background state',
  );
  await click('#popup-enabled-toggle');
  await session.waitFor(`return document.querySelector('#popup-enabled-toggle')?.checked === false;`, {
    description: 'popup pause state',
  });
  must((await readSettings()).enabled === false, 'popup pause persists enabled=false in Firefox storage');
  await click('#popup-enabled-toggle');
  await session.waitFor(`return document.querySelector('#popup-enabled-toggle')?.checked === true;`, {
    description: 'popup resume state',
  });
  must((await readSettings()).enabled === true, 'popup resume persists enabled=true in Firefox storage');

  await session.load(`${OPTIONS_URL}#advanced`);
  await session.waitFor(`return Boolean(document.querySelector('#test-pair'));`, {
    description: 'Firefox advanced diagnostics',
  });
  await click('#test-pair');
  await session.waitFor(
    `const text = document.querySelector('#out')?.textContent ?? '';
     return text.includes('video games') && text.includes('programming and software development');`,
    { timeoutMs: 90_000, description: 'Firefox Test classifier output' },
  );
  check(true, 'Firefox Advanced → Test classifier round-trips through the background model');

  // 10. Ordinary classifier-driven navigation: no blocklist/title rules, no
  // force lock, no DNR redirect, and titles never used by readiness above.
  const current = await readSettings();
  must(
    current.blocklist?.length === 0 && current.titleRules?.length === 0,
    'navigation test retains empty deterministic block/title rules',
    JSON.stringify({ blocklist: current.blocklist, titleRules: current.titleRules }),
  );
  await patchStoredSettings({
    whitelist: (current.whitelist ?? []).filter(
      (entry) => !/^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(entry.trim()),
    ),
  });

  fixtureServer = http.createServer((request, response) => {
    if (request.url !== '/runtime-navigation') {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${GAME_TITLE}</title></head>` +
        `<body><main><h1>Firefox runtime navigation fixture</h1><p>The test changes this document title after enforcement.</p></main></body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/runtime-navigation`;
  await session.load(fixtureUrl);
  await session.waitFor(
    `const host = document.getElementById('smartblocker-overlay');
     return Boolean(host?.shadowRoot) && host.dataset.smartblockerContext === 'top';`,
    { timeoutMs: 90_000, description: 'classifier-driven Firefox gaming overlay' },
  );
  check(true, 'fresh gaming navigation injects the ordinary top-frame Firefox overlay');
  const beforeProductive = await driver.eval(
    `const host = document.getElementById('smartblocker-overlay');
     return {
       stillOriginalTitle: document.title === ${JSON.stringify(GAME_TITLE)},
       overlayText: host?.shadowRoot?.textContent?.slice(0, 300) ?? '',
     };`,
  );
  must(beforeProductive.stillOriginalTitle, 'Firefox overlay coexists with the real classified document', JSON.stringify(beforeProductive));

  await driver.eval(`document.title = arguments[0]; return document.title;`, 'content', [PRODUCTIVE_TITLE]);
  await session.waitFor(
    `return document.title === arguments[0] && !document.getElementById('smartblocker-overlay');`,
    { args: [PRODUCTIVE_TITLE], timeoutMs: 90_000, description: 'programming title clears the overlay' },
  );
  await sleep(3000);
  must(
    await driver.eval(`return !document.getElementById('smartblocker-overlay');`),
    'fresh programming title clears and stays clear of the Firefox overlay',
  );

  await session.load(`${OPTIONS_URL}#advanced`);
  const navEvidence = await driver.evalAsync(
    `const { latencySamples = [] } = await browser.storage.local.get('latencySamples');
     const rules = await browser.declarativeNetRequest.getSessionRules();
     return { latencySamples, rules };`,
    'content',
    [],
    30_000,
  );
  // A page can emit several title/navigation events. A later cache hit must not
  // hide (or impersonate) the earlier actual inference this test requires.
  const gameSample = navEvidence.latencySamples.find(
    (sample) => sample.title === GAME_TITLE && sample.cached === false,
  );
  const productiveSample = navEvidence.latencySamples.find(
    (sample) => sample.title === PRODUCTIVE_TITLE && sample.cached === false,
  );
  must(
    gameSample?.blocked === true &&
      gameSample.cached === false &&
      gameSample.label === 'video games' &&
      productiveSample?.blocked === false &&
      productiveSample.cached === false &&
      productiveSample.label === 'programming and software development' &&
      navEvidence.rules.length === 0,
    'Firefox latency evidence proves fresh classifier block/allow without a DNR redirect',
    JSON.stringify({ gameSample, productiveSample, sessionRules: navEvidence.rules.length }),
  );
} catch (error) {
  console.error('FATAL', error?.stack ?? error);
  check(false, 'suite completed without a fatal harness or runtime error');
} finally {
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  await session?.close();
}

process.exit(finish() === 0 ? 0 : 1);
