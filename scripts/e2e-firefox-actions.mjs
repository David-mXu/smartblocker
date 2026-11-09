#!/usr/bin/env node
// Packed-XPI Firefox live-site enforcement + trusted block-screen actions.
// Run after `npm run build:firefox`:
//   SB_FIREFOX=/path/to/firefox node scripts/e2e-firefox-actions.mjs
//
// No HTTP fixtures, route interception, cached inference, or synthetic clicks:
// every target is the real https://example.com document with a unique URL
// blocklist keyword. OVERRIDE and Stay-focused use trusted WebDriver pointer
// input. Closed-tab assertions inspect both Marionette handles and gBrowser;
// a navigation/transport error alone is never accepted as closure evidence.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_ORIGIN,
  FirefoxTestSession,
  makeChecker,
  sleep,
} from './lib/firefox-marionette.mjs';

const SB_FIREFOX = process.env.SB_FIREFOX;
if (!SB_FIREFOX) {
  console.error('SB_FIREFOX env var required (path to a Firefox binary)');
  process.exit(2);
}
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'firefox');
const OPTIONS_URL = `${EXTENSION_ORIGIN}/options.html#advanced`;
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const KEYWORDS = {
  override: `sb-firefox-override-${RUN}`,
  stay: `sb-firefox-stay-${RUN}`,
  force: `sb-firefox-force-${RUN}`,
};
const LIVE_TITLE = 'Example Domain';
const { check, finish } = makeChecker('E2E-FIREFOX-ACTIONS');
const must = (condition, label, details = '') => {
  check(condition, label, details);
  if (!condition) throw new Error(label);
};

let session;
let driver;
let controlHandle;
const openTargets = new Set();

async function handles() {
  return driver.send('WebDriver:GetWindowHandles');
}

async function switchWindow(handle) {
  await driver.send('WebDriver:SwitchToWindow', { handle: handle?.value ?? handle });
}

async function handleDocuments() {
  const currentResult = await driver.send('WebDriver:GetWindowHandle');
  const current = currentResult?.value ?? currentResult;
  const rawHandles = await handles();
  const documents = [];
  for (const rawHandle of rawHandles) {
    const handle = rawHandle?.value ?? rawHandle;
    await switchWindow(handle);
    documents.push({
      handle,
      document: await driver.eval(`return { url: location.href, title: document.title };`)
        .catch((error) => ({ error: String(error?.message ?? error) })),
    });
  }
  await switchWindow(current);
  return documents;
}

async function ensureAllSitesAccess() {
  const granted = await driver.evalAsync(
    `return await browser.permissions.contains({ origins: ['<all_urls>'] });`,
  );
  if (granted) return;

  // Firefox 121 defaults optional host access to denied. Change real browser
  // state only through trusted native Add-ons Manager input.
  const card = 'addon-card[addon-id="smartblocker-poc@davidxu.dev"]';
  const addonLink = `${card} .addon-name-link`;
  const toggle = 'moz-toggle[permission-key="<all_urls>"]';
  const nativeClick = (selector) =>
    session.nativeClick(`return document.querySelector(arguments[0]);`, [selector]);
  await session.load('about:addons');
  await session.waitFor(`return Boolean(document.querySelector('button[name="extension"]'));`, {
    description: 'Extensions category before action-suite host grant',
  });
  await nativeClick('button[name="extension"]');
  await session.waitFor(`return Boolean(document.querySelector(${JSON.stringify(addonLink)}));`, {
    description: 'SmartBlocker card before action-suite host grant',
  });
  const expanded = await driver.eval(
    `return document.querySelector(arguments[0])?.getAttribute('expanded') === 'true';`,
    'content',
    [card],
  );
  if (!expanded) await nativeClick(addonLink);
  await session.waitFor(
    `return Boolean(document.querySelector(${JSON.stringify(`${card}[expanded="true"] addon-details`)}));`,
    { description: 'SmartBlocker details before action-suite host grant' },
  );
  await nativeClick('#details-deck-button-permissions');
  await session.waitFor(
    `return Boolean(document.querySelector(${JSON.stringify(toggle)})?.shadowRoot);`,
    { description: 'action-suite native all-site permission toggle' },
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
    { description: 'action-suite native all-site permission enabled' },
  );
  await session.load(OPTIONS_URL);
  must(
    await driver.evalAsync(`return await browser.permissions.contains({ origins: ['<all_urls>'] });`),
    'real all-site access is available before live-site action tests',
  );
}

async function openTarget(url) {
  const before = await handles();
  const marker = `target-${openTargets.size}-${RUN}`;
  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     const tab = win.gBrowser.addTab('about:blank', {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     tab.__sbFirefoxActionMarker = arguments[0];
     win.gBrowser.selectedTab = tab;
     return true;`,
    'chrome',
    [marker],
  );

  let handle = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !handle) {
    const added = (await handles()).filter((candidate) => !before.includes(candidate));
    for (const candidate of added) {
      await switchWindow(candidate);
      const currentUrl = await driver.eval(`return location.href;`).catch(() => null);
      if (currentUrl === 'about:blank') {
        handle = candidate;
        break;
      }
    }
    if (!handle) await sleep(200);
  }
  must(handle, 'Firefox exposes a real Marionette handle for the action target');
  const target = { handle, marker, url };
  openTargets.add(target);
  await driver.send('WebDriver:Navigate', { url });
  return target;
}

async function markerCount(target) {
  return driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     return [...win.gBrowser.tabs].filter(
       (tab) => tab.__sbFirefoxActionMarker === arguments[0]
     ).length;`,
    'chrome',
    [target.marker],
  );
}

async function assertTargetClosed(target, label) {
  await switchWindow(controlHandle);
  const deadline = Date.now() + 15_000;
  let state = null;
  while (Date.now() < deadline) {
    state = {
      handlePresent: (await handles()).includes(target.handle),
      liveMarkedTabs: await markerCount(target),
    };
    if (!state.handlePresent && state.liveMarkedTabs === 0) {
      openTargets.delete(target);
      check(true, label, JSON.stringify(state));
      return;
    }
    await sleep(150);
  }
  must(false, label, JSON.stringify(state));
}

async function closeTargetForCleanup(target) {
  if (!openTargets.has(target)) return;
  await switchWindow(controlHandle);
  if ((await markerCount(target)) > 0) {
    await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       for (const tab of [...win.gBrowser.tabs]) {
         if (tab.__sbFirefoxActionMarker === arguments[0]) win.gBrowser.removeTab(tab);
       }
       return true;`,
      'chrome',
      [target.marker],
    );
  }
  openTargets.delete(target);
}

async function trustedCloseClick(target, selectorScript) {
  let clickTransition = null;
  try {
    await session.nativeClick(selectorScript);
  } catch (error) {
    // Closing the sender's own tab can invalidate Marionette's click context.
    // Retain this only as diagnostics; assertTargetClosed below is the proof.
    clickTransition = String(error?.message ?? error);
  }
  if (clickTransition) console.log('… expected close-click transition', clickTransition);
}

async function loadControl() {
  await switchWindow(controlHandle);
  try {
    await session.load(OPTIONS_URL);
  } catch (error) {
    const content = await driver.eval(`return { url: location.href, title: document.title };`)
      .catch((probeError) => ({ probeError: String(probeError) }));
    const tabs = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       return {
         selected: win.gBrowser.selectedBrowser?.currentURI?.spec ?? null,
         retained: win.__smartBlockerTestTab?.linkedBrowser?.currentURI?.spec ?? null,
         tabs: [...win.gBrowser.tabs].map((tab) => ({
           url: tab.linkedBrowser?.currentURI?.spec ?? null,
           marker: tab.__sbFirefoxActionMarker ?? null,
         })),
       };`,
      'chrome',
    ).catch((probeError) => ({ probeError: String(probeError) }));
    const handleMap = await handleDocuments().catch((probeError) => ({ probeError: String(probeError) }));
    console.error('… control-navigation failure evidence', JSON.stringify({ controlHandle, content, tabs, handleMap }));
    throw error;
  }
}

async function configure({ clearOverrides = false, lockState } = {}) {
  await loadControl();
  await driver.evalAsync(
    `if (injected[0].clearOverrides) {
       await browser.storage.local.remove('overrides');
     }
     if (injected[0].lockState !== undefined) {
       if (injected[0].lockState === null) await browser.storage.local.remove('lockState');
       else await browser.storage.local.set({ lockState: injected[0].lockState });
     }
     return true;`,
    'content',
    [{ clearOverrides, lockState }],
  );
  await sleep(800); // real storage.onChanged fan-out; no mocked background state
}

async function evidence() {
  await loadControl();
  return driver.evalAsync(
    `const stored = await browser.storage.local.get([
       'overrides', 'feedback', 'latencySamples', 'lockState'
     ]);
     return {
       ...stored,
       sessionRules: await browser.declarativeNetRequest.getSessionRules(),
     };`,
  );
}

async function waitForOverlay(url) {
  try {
    await session.waitFor(
      `const host = document.getElementById('smartblocker-overlay');
       return location.href === arguments[0] &&
         document.title === ${JSON.stringify(LIVE_TITLE)} &&
         document.body?.textContent?.includes('This domain is for use in documentation examples') &&
         Boolean(host?.shadowRoot) && host.dataset.smartblockerContext === 'top';`,
      { args: [url], timeoutMs: 45_000, description: `live Firefox overlay at ${url}` },
    );
  } catch (error) {
    const dom = await driver.eval(
      `return {
         url: location.href,
         title: document.title,
         h1: document.querySelector('h1')?.textContent ?? null,
         body: document.body?.textContent?.slice(0, 500) ?? '',
         overlay: Boolean(document.getElementById('smartblocker-overlay')),
       };`,
    ).catch((probeError) => ({ probeError: String(probeError) }));
    const runtimeEvidence = await evidence().catch((probeError) => ({ probeError: String(probeError) }));
    console.error('… live-overlay failure evidence', JSON.stringify({ dom, runtimeEvidence }));
    throw error;
  }
  check(true, 'real HTTPS example.com document receives the top-frame Firefox overlay', url);
}

const OVERRIDE_BUTTON = `const host = document.getElementById('smartblocker-overlay');
  return [...(host?.shadowRoot?.querySelectorAll('button') ?? [])]
    .find((button) => /actually productive/.test(button.textContent));`;
const OVERLAY_STAY_BUTTON = `const host = document.getElementById('smartblocker-overlay');
  return [...(host?.shadowRoot?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent === 'Stay focused (close tab)');`;
const BLOCKED_STAY_BUTTON = `return [...document.querySelectorAll('#smartblocker-blocked button')]
  .find((button) => button.textContent === 'Stay focused (close tab)');`;

try {
  session = await FirefoxTestSession.launch({ firefoxPath: SB_FIREFOX, dist: DIST });
  driver = session.driver;
  const controlHandleResult = await driver.send('WebDriver:GetWindowHandle');
  controlHandle = controlHandleResult?.value ?? controlHandleResult;
  await sleep(1200);
  await session.load(OPTIONS_URL);
  await ensureAllSitesAccess();
  await driver.evalAsync(
    `await browser.storage.local.remove(['lockState', 'overrides', 'feedback', 'latencySamples']);
     const { settings = {} } = await browser.storage.local.get('settings');
     await browser.storage.local.set({
       settings: {
         ...settings,
         enabled: true,
         onboarded: true,
         blocklist: injected[0],
         titleRules: [],
         surrenderMode: 'off',
       },
     });
     return true;`,
    'content',
    [Object.values(KEYWORDS)],
  );
  await sleep(800);
  check(true, 'packed Firefox profile is armed with unique deterministic rules on a real host grant');

  // 1. Real live page + trusted OVERRIDE through the open shadow root.
  const overrideUrl = `https://example.com/?q=${KEYWORDS.override}`;
  const overrideTarget = await openTarget(overrideUrl);
  await waitForOverlay(overrideUrl);
  await session.nativeClick(OVERRIDE_BUTTON);
  await session.waitFor(`return !document.getElementById('smartblocker-overlay');`, {
    description: 'trusted OVERRIDE dismisses the Firefox overlay',
  });
  let overrideEvidence;
  for (let attempt = 0; attempt < 40; attempt++) {
    overrideEvidence = await evidence();
    if (
      overrideEvidence.overrides?.some((entry) => entry.title === LIVE_TITLE) &&
      overrideEvidence.feedback?.some((entry) => entry.title === LIVE_TITLE)
    ) break;
    await sleep(150);
  }
  const storedOverride = overrideEvidence.overrides?.find(
    (entry) => entry.title === LIVE_TITLE && entry.host === 'example.com',
  );
  const correction = overrideEvidence.feedback?.find(
    (entry) => entry.kind === 'false_positive' && entry.title === LIVE_TITLE && entry.domain === 'example.com',
  );
  const overrideSample = [...(overrideEvidence.latencySamples ?? [])]
    .reverse()
    .find((sample) => sample.url === overrideUrl);
  must(
    storedOverride && correction?.modelLabel === `blocked rule: "${KEYWORDS.override}"` &&
      overrideSample?.blocked === true && overrideSample.inferMs === 0 &&
      overrideEvidence.sessionRules.length === 0,
    'trusted OVERRIDE persists host-scoped allow + false-positive evidence for a real rule block',
    JSON.stringify({ storedOverride, correction, overrideSample, rules: overrideEvidence.sessionRules }),
  );

  await switchWindow(overrideTarget.handle);
  const originalTimeOrigin = await driver.eval(`return performance.timeOrigin;`);
  const reloadRequestedAt = Date.now();
  console.log('… OVERRIDE reload causality', JSON.stringify({
    storedOverrideAt: storedOverride.ts,
    reloadRequestedAt,
    originalTimeOrigin,
  }));
  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     const tab = [...win.gBrowser.tabs].find(
       (candidate) => candidate.__sbFirefoxActionMarker === arguments[0]
     );
     if (!tab) throw new Error('OVERRIDE target disappeared before reload');
     win.gBrowser.selectedTab = tab;
     tab.linkedBrowser.reload();
     return true;`,
    'chrome',
    [overrideTarget.marker],
  );
  await switchWindow(overrideTarget.handle);
  await session.waitFor(
    `return location.href === arguments[0] &&
       performance.timeOrigin !== arguments[1] && performance.timeOrigin >= arguments[2] &&
       document.body?.textContent?.includes('This domain is for use in documentation examples');`,
    {
      args: [overrideUrl, originalTimeOrigin, storedOverride.ts],
      timeoutMs: 45_000,
      description: 'real document reload after the OVERRIDE was persisted',
    },
  );
  await session.waitFor(`return !document.getElementById('smartblocker-overlay');`, {
    timeoutMs: 45_000,
    description: 'persisted OVERRIDE allows live re-navigation',
  }).catch((error) => console.error('… OVERRIDE re-navigation did not settle allowed', String(error)));
  const overrideNavigation = await driver.eval(
    `return {
       url: location.href,
       title: document.title,
       timeOrigin: performance.timeOrigin,
       originalTimeOrigin: arguments[0],
       liveContent: document.body?.textContent?.includes('This domain is for use in documentation examples'),
       overlay: Boolean(document.getElementById('smartblocker-overlay')),
     };`,
    'content',
    [originalTimeOrigin],
  );
  const navigationEvidence = await evidence();
  const secondOverrideSample = [...(navigationEvidence.latencySamples ?? [])]
    .reverse()
    .find((sample) =>
      sample.url === overrideUrl && sample.title === LIVE_TITLE && sample.ts >= storedOverride.ts
    );
  must(
    overrideNavigation.url === overrideUrl && overrideNavigation.liveContent &&
      overrideNavigation.overlay === false && secondOverrideSample?.blocked === false,
    'the persisted OVERRIDE really allows the same live URL on a fresh navigation',
    JSON.stringify({
      overrideNavigation,
      reloadRequestedAt,
      storedOverrideAt: storedOverride.ts,
      overrides: navigationEvidence.overrides,
      secondOverrideSample,
      samples: navigationEvidence.latencySamples,
    }),
  );
  await closeTargetForCleanup(overrideTarget);

  // 2. Non-force top-frame Stay focused must close its sender tab, with no DNR.
  await configure({ clearOverrides: true, lockState: null });
  const stayUrl = `https://example.com/?q=${KEYWORDS.stay}`;
  const stayTarget = await openTarget(stayUrl);
  await waitForOverlay(stayUrl);
  await trustedCloseClick(stayTarget, OVERLAY_STAY_BUTTON);
  await assertTargetClosed(stayTarget, 'trusted injected-overlay Stay focused closes the actual live tab');
  const stayEvidence = await evidence();
  const staySample = [...(stayEvidence.latencySamples ?? [])]
    .reverse()
    .find((sample) => sample.url === stayUrl);
  must(
    staySample?.blocked === true && staySample.inferMs === 0 && stayEvidence.sessionRules.length === 0,
    'ordinary Firefox overlay action uses a real rule verdict and no DNR session rule',
    JSON.stringify({ staySample, rules: stayEvidence.sessionRules }),
  );

  // 3. Frozen Turkey uses a real session DNR redirect to extension-owned UI;
  // its light-DOM Stay-focused control must also close exactly the sender tab.
  await configure({
    clearOverrides: true,
    lockState: {
      timerUntil: null,
      passwordHash: null,
      frozenUntil: Date.now() + 120_000,
      schedules: [],
      schedulesUpdatedAt: 0,
    },
  });
  const forceUrl = `https://example.com/?q=${KEYWORDS.force}`;
  const forceTarget = await openTarget(forceUrl);
  await session.waitFor(
    `return location.href.startsWith(${JSON.stringify(`${EXTENSION_ORIGIN}/blocked.html?`)}) &&
       new URL(location.href).searchParams.get('reason') === 'dnf-redirect' &&
       Boolean(document.querySelector('#smartblocker-blocked'));`,
    { timeoutMs: 45_000, description: 'live Frozen Turkey DNR redirect to blocked.html' },
  );
  const forceDom = await driver.eval(
    `return {
       url: location.href,
       title: document.title,
       originalHostileH1s: document.querySelectorAll('h1').length,
       buttons: [...document.querySelectorAll('#smartblocker-blocked button')].map((b) => b.textContent),
       lockCopy: document.body.textContent.includes('Smart Blocker is locked'),
     };`,
  );
  const forceRules = await driver.evalAsync(
    `return await browser.declarativeNetRequest.getSessionRules();`,
  );
  const forceRule = forceRules.find(
    (rule) => rule.condition?.urlFilter === `|${forceUrl}|` && rule.condition?.tabIds?.length === 1,
  );
  must(
    forceDom.title === 'Blocked — Smart Blocker' && forceDom.originalHostileH1s === 0 &&
      forceDom.lockCopy && forceDom.buttons.length === 1 &&
      forceDom.buttons[0] === 'Stay focused (close tab)' &&
      forceRule?.action?.redirect?.extensionPath?.startsWith('/blocked.html?') &&
      forceRule.action.redirect.extensionPath.includes('reason=dnf-redirect'),
    'live forced block has exact tab/URL DNR evidence and only the trusted close action',
    JSON.stringify({ forceDom, forceRules }),
  );
  await trustedCloseClick(forceTarget, BLOCKED_STAY_BUTTON);
  await assertTargetClosed(forceTarget, 'trusted blocked.html Stay focused closes the real DNR-redirected tab');
  const closedForceEvidence = await evidence();
  must(
    closedForceEvidence.sessionRules.length === 0 &&
      closedForceEvidence.lockState?.frozenUntil > Date.now(),
    'closing the forced tab removes its real session rule while the lock remains active',
    JSON.stringify({ rules: closedForceEvidence.sessionRules, lockState: closedForceEvidence.lockState }),
  );
  await configure({ lockState: null });
} catch (error) {
  console.error('FATAL', error?.stack ?? error);
  check(false, 'suite completed without a fatal harness or runtime error');
} finally {
  if (session && driver && controlHandle) {
    for (const target of [...openTargets]) {
      await closeTargetForCleanup(target).catch(() => {});
    }
  }
  await session?.close();
}

process.exit(finish() === 0 ? 0 : 1);
