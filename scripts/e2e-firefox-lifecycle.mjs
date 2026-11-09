#!/usr/bin/env node
// Persistent-XPI Firefox process-restart + natural event-page suspension test.
// Run after `npm run build:firefox`:
//   SB_FIREFOX=/path/to/firefox node scripts/e2e-firefox-lifecycle.mjs
//
// The first launch installs the packed XPI non-temporarily. The second launch
// reuses its profile and MUST NOT issue Addon:Install. Fresh post-restart
// inference then runs with background fetch sabotaged, so neither title-cache
// hits nor network downloads can masquerade as persisted model availability.
// After the deterministic wake fixture is stored, a third real process starts
// the natural-idle phase from that quiet persisted profile with no reinstall.
// The natural-suspend phase gives only this disposable browser an isolated
// $HOME, so Firefox cannot discover the machine's native-messaging host (an
// open native port legitimately prevents event-page suspension). It then uses
// Firefox's real idle scheduler with a 5-second test timeout, below the
// product's intentional 20-second keepalive but long enough for startup work.
// It does not claim that an open companion port or the production default
// timeout/keepalive permits eviction. The real usage-idle API is temporarily
// configured outside the stability window and restored to 30s before inference.
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBED_MODEL_REVISION } from '../src/shared/config.ts';
import { USAGE_STATS_IDLE_SECONDS } from '../src/shared/usage-stats.ts';
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
const IDLE_TIMEOUT_MS = 5_000;
const TEST_USAGE_IDLE_SECONDS = 60 * 60;
if (!Number.isFinite(MODEL_TIMEOUT_MS) || MODEL_TIMEOUT_MS < 30_000) {
  throw new Error('SB_FIREFOX_MODEL_TIMEOUT_MS must be a finite number >= 30000');
}
const { check, finish } = makeChecker('E2E-FIREFOX-LIFECYCLE');
const must = (condition, label, details = '') => {
  check(condition, label, details);
  if (!condition) throw new Error(label);
};

let session;
let driver;
let fixtureServer;
let fixtureUrl;

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

function readyWithFreshVerdicts(report, saved = false) {
  const distraction = report?.checks?.find((entry) => entry.id === 'distraction');
  const productive = report?.checks?.find((entry) => entry.id === 'productive');
  return (
    report?.status === 'ready' &&
    (!saved || report.saved === true) &&
    distraction?.verdict?.label === 'video games' &&
    distraction?.verdict?.decision === 'block' &&
    distraction?.verdict?.cached === false &&
    productive?.verdict?.label === 'programming and software development' &&
    productive?.verdict?.decision === 'allow' &&
    productive?.verdict?.cached === false &&
    report?.checks?.find((entry) => entry.id === 'site-access')?.status === 'passed'
  );
}

async function rpc(type) {
  return driver.evalAsync(
    `return await browser.runtime.sendMessage({ type: injected[0] });`,
    'content',
    [type],
    MODEL_TIMEOUT_MS,
  );
}

async function persistentSnapshot() {
  return driver.evalAsync(
    `const stored = await browser.storage.local.get(['settings', 'titleCache', 'centroidCache']);
     const cacheNames = await caches.keys();
     const cacheEntries = {};
     for (const name of cacheNames) {
       const cache = await caches.open(name);
       cacheEntries[name] = (await cache.keys()).map((request) => request.url).sort();
     }
     const sessionState = await browser.storage.session.get('resumeBootId');
     return {
       settings: stored.settings,
       titleCache: stored.titleCache,
       centroidCache: stored.centroidCache,
       cacheEntries,
       resumeBootId: sessionState.resumeBootId ?? null,
     };`,
  );
}

async function sabotageModelFetch() {
  const result = await driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     if (!background) return { patched: false };
     if (!background.__sbLifecycleOriginalFetch) {
       background.__sbLifecycleOriginalFetch = background.fetch.bind(background);
     }
     background.__sbLifecycleFetchFaults = 0;
     background.__sbLifecycleFaultUrls = [];
     background.fetch = (input, ...rest) => {
       const url = typeof input === 'string' ? input : input?.url ?? String(input);
       // This is a network outage, not a package-integrity failure: local ORT
       // MJS/WASM fetches must still work. Only remote HTTP(S) model traffic is
       // rejected and counted, so success proves CacheStorage/model persistence.
       if (!/^https?:/i.test(url)) return background.__sbLifecycleOriginalFetch(input, ...rest);
       background.__sbLifecycleFetchFaults++;
       background.__sbLifecycleFaultUrls.push(url);
       return Promise.reject(new Error('forced Firefox lifecycle network outage'));
     };
     return {
       patched: true,
       backgroundUrl: background.location.href,
       timeOrigin: background.performance.timeOrigin,
     };`,
  );
  must(result.patched, 'network outage reaches the genuine restarted Firefox event page', JSON.stringify(result));
}

async function fetchFaults() {
  return driver.evalAsync(
    `const background = await browser.runtime.getBackgroundPage();
     return {
       calls: background?.__sbLifecycleFetchFaults ?? null,
       urls: background?.__sbLifecycleFaultUrls ?? [],
     };`,
  );
}

async function backgroundState() {
  return driver.eval(
    `const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
     const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(GECKO_ID)});
     return {
       state: extension?.backgroundState ?? null,
       contextId: extension?.backgroundContext?.contextId ?? null,
       nativePorts: extension?.backgroundContext?.hasActiveNativeAppPorts ?? null,
       pendingListeners: extension?.backgroundContext?.pendingRunListenerPromisesCount ?? null,
       devtools: ExtensionParent.DebugUtils.hasDevToolsAttached(${JSON.stringify(GECKO_ID)}),
     };`,
    'chrome',
  );
}

async function waitForBackgroundState(expected, description, timeoutMs = 30_000, stableMs = 0) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let matchingSince = null;
  while (Date.now() < deadline) {
    latest = await backgroundState();
    if (latest.state === expected) {
      matchingSince ??= Date.now();
      if (Date.now() - matchingSince >= stableMs) {
        return { ...latest, stableForMs: Date.now() - matchingSince };
      }
    } else {
      // A starting/running event resets the stability window. In particular,
      // a momentary shutdown immediately followed by startup is NOT a suspend.
      matchingSince = null;
    }
    await sleep(100);
  }
  const events = await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     return {
       startedAt: win.__sbLifecycleIdleStartedAt ?? null,
       now: Date.now(),
       events: win.__sbLifecycleIdleEvents ?? [],
              storageCalls: win.__sbLifecycleStorageCalls ?? [],
     };`,
    'chrome',
  ).catch(() => null);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify({ latest, events })}`);
}

function compactSnapshot(snapshot) {
  return {
    enabled: snapshot.settings?.enabled,
    onboarded: snapshot.settings?.onboarded,
    titleVerdicts: Object.keys(snapshot.titleCache ?? {}).length,
    centroidNames: snapshot.centroidCache?.names?.length ?? 0,
    centroidSeedGroups: snapshot.centroidCache?.seedVectors?.length ?? 0,
    caches: Object.fromEntries(
      Object.entries(snapshot.cacheEntries ?? {}).map(([name, urls]) => [name, urls.length]),
    ),
    resumeBootId: snapshot.resumeBootId,
  };
}

try {
  fixtureServer = http.createServer((request, response) => {
    if (request.url !== '/lifecycle-wake?sb-lifecycle-wake-rule') {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Firefox lifecycle deterministic wake fixture</title><h1>wake fixture</h1>');
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/lifecycle-wake?sb-lifecycle-wake-rule`;

  session = await FirefoxTestSession.launch({
    firefoxPath: SB_FIREFOX,
    dist: DIST,
    temporary: false,
    scriptTimeoutMs: MODEL_TIMEOUT_MS + 15_000,
    isolateNativeMessaging: true,
  });
  driver = session.driver;
  const originalPid = session.process.pid;
  const work = session.work;
  await sleep(1500);
  await session.load(`${OPTIONS_URL}#advanced`);
  const completed = await rpc('COMPLETE_ONBOARDING');
  must(
    readyWithFreshVerdicts(completed, true),
    'persistent XPI completes real cold onboarding with two fresh verdicts',
    compactReport(completed),
  );

  const before = await persistentSnapshot();
  const beforeSummary = compactSnapshot(before);
  console.log('… pre-restart persistence', JSON.stringify(beforeSummary));
  must(
    before.settings?.enabled === true &&
      before.settings?.onboarded === true &&
      Object.keys(before.titleCache ?? {}).length >= 2 &&
      before.centroidCache?.names?.length > 0 &&
      before.centroidCache?.seedVectors?.length === before.centroidCache.names.length &&
      Object.values(before.cacheEntries).flat().some((url) => url.includes(EMBED_MODEL_REVISION)),
    'cold install persists settings, title verdicts, centroids, and pinned-revision model bytes',
    JSON.stringify(beforeSummary),
  );

  await session.quit();
  must(
    session.process.exitCode !== null || session.process.signalCode !== null,
    'Marionette:Quit performs a complete Firefox process shutdown',
    `pid=${originalPid} exit=${session.process.exitCode} signal=${session.process.signalCode}`,
  );

  session = await FirefoxTestSession.launch({
    firefoxPath: SB_FIREFOX,
    dist: DIST,
    reuseWork: work,
    temporary: false,
    install: false,
    scriptTimeoutMs: MODEL_TIMEOUT_MS + 15_000,
    isolateNativeMessaging: true,
  });
  driver = session.driver;
  const restartedPid = session.process.pid;
  must(restartedPid !== originalPid, 'lifecycle resume uses a different Firefox process PID', `${originalPid} -> ${restartedPid}`);
  const addon = await driver.evalAsync(
    `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     const installed = await AddonManager.getAddonByID(injected[0]);
     return installed ? { id: installed.id, active: installed.isActive, version: installed.version } : null;`,
    'chrome',
    [GECKO_ID],
  );
  must(
    addon?.id === GECKO_ID && addon.active === true,
    'packed XPI remains installed and active after restart without Addon:Install',
    JSON.stringify(addon),
  );

  await session.load(`${OPTIONS_URL}#advanced`);
  const after = await persistentSnapshot();
  console.log('… post-restart persistence', JSON.stringify(compactSnapshot(after)));
  must(
    JSON.stringify(after.settings) === JSON.stringify(before.settings) &&
      JSON.stringify(after.titleCache) === JSON.stringify(before.titleCache) &&
      JSON.stringify(after.centroidCache) === JSON.stringify(before.centroidCache) &&
      JSON.stringify(after.cacheEntries) === JSON.stringify(before.cacheEntries) &&
      after.resumeBootId !== before.resumeBootId,
    'new browser process preserves local/model caches exactly but starts a new storage.session boot',
  );

  await sabotageModelFetch();
  const restarted = await rpc('VERIFY_PROTECTION');
  const restartFaults = await fetchFaults();
  must(
    readyWithFreshVerdicts(restarted) && restartFaults.calls === 0,
    'post-restart fresh block/allow inference needs zero model-network requests',
    `${compactReport(restarted)} faults=${JSON.stringify(restartFaults)}`,
  );

  // Natural suspension: the observer reads ExtensionParent directly from the
  // parent process and never calls runtime.getBackgroundPage() while waiting.
  await driver.evalAsync(
    `const { settings = {} } = await browser.storage.local.get('settings');
     await browser.storage.local.set({
       settings: {
         ...settings,
         enabled: true,
         onboarded: true,
         blocklist: ['sb-lifecycle-wake-rule'],
         titleRules: [],
         whitelist: (settings.whitelist ?? []).filter(
           (entry) => !/^(?:localhost|127\\.0\\.0\\.1|\\[?::1\\]?)$/i.test(entry.trim()),
         ),
       },
     });
     await browser.storage.session.set({ resumeBootId: injected[0] });
     return 'natural-suspension fixture armed';`,
    'content',
    [after.resumeBootId],
  );
  const fixtureSnapshot = await persistentSnapshot();
  const preNaturalPid = session.process.pid;
  await session.quit();

  // Start the measured idle phase from a quiet persisted browser process.
  // Earlier restart/model/UI activity can leave storage and native-port startup
  // work repeatedly rearming an artificially short timeout. No listener, port,
  // or background state is manipulated during the actual suspension phase.
  session = await FirefoxTestSession.launch({
    firefoxPath: SB_FIREFOX,
    dist: DIST,
    reuseWork: work,
    temporary: false,
    install: false,
    scriptTimeoutMs: MODEL_TIMEOUT_MS + 15_000,
    isolateNativeMessaging: true,
  });
  driver = session.driver;
  must(
    session.process.pid !== preNaturalPid,
    'natural-suspension phase starts in a fresh Firefox process without Addon:Install',
    `${preNaturalPid} -> ${session.process.pid}`,
  );
  await session.load(`${OPTIONS_URL}#advanced`);
  const naturalStart = await persistentSnapshot();
  must(
    JSON.stringify(naturalStart.settings) === JSON.stringify(fixtureSnapshot.settings) &&
      JSON.stringify(naturalStart.titleCache) === JSON.stringify(fixtureSnapshot.titleCache) &&
      JSON.stringify(naturalStart.centroidCache) === JSON.stringify(fixtureSnapshot.centroidCache) &&
      JSON.stringify(naturalStart.cacheEntries) === JSON.stringify(fixtureSnapshot.cacheEntries) &&
      naturalStart.resumeBootId !== fixtureSnapshot.resumeBootId,
    'quiet process preserves the armed fixture and model bytes but starts a new session boot',
    JSON.stringify(compactSnapshot(naturalStart)),
  );

  const preSuspension = await backgroundState();
  const companion = await driver.evalAsync(
    `return (await browser.storage.local.get('companionSnapshot')).companionSnapshot ?? null;`,
  );
  // A headless DOM click does not reset nsIUserIdleService. Use the actual
  // extension API to move the usage-only idle threshold beyond this test's
  // stop/stability window. This changes no blocking rule, OS state, or model
  // behavior, and is restored to the product value before final inference.
  const usageIdleTrial = await driver.evalAsync(
    `const seconds = injected[0];
     await browser.idle.setDetectionInterval(seconds);
     return {
       seconds,
       active: (await browser.idle.queryState(seconds)) === 'active',
     };`,
    'content',
    [TEST_USAGE_IDLE_SECONDS],
  );
  await session.load('about:blank');
  const idleSetup = await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     for (const tab of [...win.gBrowser.tabs]) {
       if (tab === win.__smartBlockerTestTab) continue;
       if (tab.linkedBrowser?.currentURI?.spec?.startsWith('moz-extension:')) win.gBrowser.removeTab(tab);
     }
     const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
     const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(GECKO_ID)});
     win.__sbLifecycleIdleEvents = [];
          win.__sbLifecycleStorageCalls = [];
     const storageBackends = [
       ['json', ChromeUtils.importESModule('resource://gre/modules/ExtensionStorage.sys.mjs').ExtensionStorage],
       ['idb', ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs').ExtensionStorageIDB],
     ];
     for (const [backend, storage] of storageBackends) {
       if (!storage?.notifyListeners) continue;
       const notify = storage.notifyListeners;
       storage.notifyListeners = function (extensionId, changes) {
         if (extensionId === ${JSON.stringify(GECKO_ID)}) {
           win.__sbLifecycleStorageCalls.push({
             backend,
             at: Date.now(),
             keys: Object.keys(changes ?? {}),
             companionState: changes?.companionSnapshot?.newValue?.state ?? null,
           });
         }
         return Reflect.apply(notify, this, arguments);
       };
     }
     // Storage tracing is observation-only and preserves real notifications.
     for (const name of [
       'background-script-reset-idle',
       'background-script-suspend-ignored',
       'background-script-suspend-canceled',
       'shutdown-background-script',
       'background-script-event',
     ]) {
       extension.on(name, (event, ...args) => {
         win.__sbLifecycleIdleEvents.push({ name, args, at: Date.now() });
       });
     }
     // No internal port/background manipulation: this browser started with
     // isolated native-host discovery, so only Firefox's real scheduler runs.
     // Record ALL activity during settling as well as after the timeout change.
     win.__sbLifecycleIdleSettleStartedAt = Date.now();
     return {
       remainingTabs: win.gBrowser.tabs.length,
       userNativeManifestDir: Services.dirsvc.get('XREUserNativeManifests', Ci.nsIFile).path,
       usageIdleDetectionSeconds: extension.startupData?.idleDetectionInterval ?? null,
     };`,
    'chrome',
  );
  // Tab/settings changes queue a real 15-second usage-stats batch, while the
  // product intentionally pings Firefox every 20 seconds. Let both complete
  // under the normal idle timeout before testing fast idle eviction. Setting
  // an overly aggressive timeout earlier can repeatedly interrupt startup/storage
  // work; that is churn, not evidence of a settled event page being suspended.
  // Five seconds remains below the 20-second keepalive without terminating the
  // native-port/startup sequence after only one second.
  await sleep(22_000);
  const settledPreIdle = await backgroundState();
  // Apply the temporary, API-configured usage-idle threshold only after all
  // ordinary deferred work has completed under the normal background timeout.
  const idleTimer = await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     const userIdle = Cc['@mozilla.org/widget/useridleservice;1']
       .getService(Ci.nsIUserIdleService);
     const osIdleMs = userIdle.idleTime;
     win.__sbLifecycleIdleStartedAt = Date.now();
     Services.prefs.setIntPref('extensions.background.idle.timeout', ${IDLE_TIMEOUT_MS});
     return {
       idleTimeout: Services.prefs.getIntPref('extensions.background.idle.timeout'),
       settledForMs: Date.now() - win.__sbLifecycleIdleSettleStartedAt,
       osIdleMs,
     };`,
    'chrome',
  );
  const idleConfig = { ...idleSetup, ...idleTimer };
  console.log('… natural-idle configuration', JSON.stringify(idleConfig));

  must(
    idleConfig.userNativeManifestDir === join(work, 'isolated-home', '.mozilla') &&
      settledPreIdle.state === 'running' &&
      settledPreIdle.contextId === preSuspension.contextId &&
      preSuspension.nativePorts === false &&
      preSuspension.pendingListeners === 0 &&
      preSuspension.devtools === false &&
      companion?.state === 'not-installed',
    'isolated Firefox starts without the machine’s native companion or other idle blockers',
    JSON.stringify({ idleConfig, preSuspension, companionState: companion?.state }),
  );

  must(
    usageIdleTrial.active === true &&
      usageIdleTrial.seconds === TEST_USAGE_IDLE_SECONDS &&
      idleConfig.usageIdleDetectionSeconds === TEST_USAGE_IDLE_SECONDS,
    'the real idle API gives this test a quiet usage-detection window without masking OS state',
    JSON.stringify({ usageIdleTrial, usageIdleDetectionSeconds: idleConfig.usageIdleDetectionSeconds }),
  );

  const stopped = await waitForBackgroundState(
    'stopped',
    'Firefox scheduler keeps the event page naturally stopped with no spontaneous restart',
    60_000,
    IDLE_TIMEOUT_MS + 1_000,
  );
  must(
    preSuspension.state === 'running' && stopped.contextId === null,
    'Firefox naturally suspends the persistent event page without disable/enable',
    JSON.stringify({ preSuspension, stopped }),
  );

  const quietIdleWrites = await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     return win.__sbLifecycleStorageCalls.filter(
       (call) => call.at >= win.__sbLifecycleIdleStartedAt
     );`,
    'chrome',
  );
  must(
    quietIdleWrites.length === 0,
    'the stable idle window has no self-triggering storage snapshot writes',
    JSON.stringify(quietIdleWrites),
  );

  await session.load(fixtureUrl);
  const resumed = await waitForBackgroundState('running', 'ordinary navigation wakes the suspended event page');
  must(
    resumed.contextId !== null && resumed.contextId !== preSuspension.contextId,
    'natural wake creates a new background context in the same Firefox process',
    JSON.stringify({ preSuspension, resumed }),
  );
  await session.waitFor(
    `const host = document.getElementById('smartblocker-overlay');
     return Boolean(host?.shadowRoot) && host.dataset.smartblockerContext === 'top';`,
    { timeoutMs: 90_000, description: 'post-suspension deterministic block overlay' },
  );
  check(true, 'ordinary navigation after natural suspension produces real rule enforcement');

  // The shortened timeout has served its purpose and would otherwise suspend
  // the page again between this navigation wake and the model verification.
  // Restore Firefox's production default before making the final RPC.
  await driver.eval(
    `Services.prefs.clearUserPref('extensions.background.idle.timeout');
     return Services.prefs.getIntPref('extensions.background.idle.timeout', 30000);`,
    'chrome',
  );
  await session.load(`${OPTIONS_URL}#advanced`);
  await driver.evalAsync(
    `await browser.idle.setDetectionInterval(injected[0]);
     return injected[0];`,
    'content',
    [USAGE_STATS_IDLE_SECONDS],
  ).then((seconds) =>
    check(seconds === USAGE_STATS_IDLE_SECONDS, 'production usage-idle detection is restored before final inference'),
  );
  const resumedBoot = await driver.evalAsync(
    `return (await browser.storage.session.get('resumeBootId')).resumeBootId ?? null;`,
  );
  must(
    resumedBoot === naturalStart.resumeBootId,
    'natural event-page restart preserves the same-browser storage.session marker',
    JSON.stringify({ before: naturalStart.resumeBootId, after: resumedBoot, stopped, resumed }),
  );
  await sabotageModelFetch();
  const afterSuspension = await rpc('VERIFY_PROTECTION');
  const suspensionFaults = await fetchFaults();
  must(
    readyWithFreshVerdicts(afterSuspension) && suspensionFaults.calls === 0,
    'naturally resumed event page also runs fresh inference from persisted model assets',
    `${compactReport(afterSuspension)} faults=${JSON.stringify(suspensionFaults)}`,
  );
} catch (error) {
  console.error('FATAL', error?.stack ?? error);
  check(false, 'suite completed without a fatal harness or runtime error');
} finally {
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  await session?.close();
}

process.exit(finish() === 0 ? 0 : 1);
