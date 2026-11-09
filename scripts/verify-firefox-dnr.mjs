#!/usr/bin/env node
// Firefox live verification of the force-mode DNR redirect (red-team #4/P3).
// Closes the "Firefox DNR live verification" tail of docs/security/red-team-2026-11-05.md.
//
//   npm run build:firefox
//   SB_FIREFOX=/path/to/firefox node scripts/verify-firefox-dnr.mjs
//
// No npm dependencies: uses the shared raw-Marionette helper because current
// WebDriver/BiDi navigation rejects moz-extension:// URLs. Scenario:
//   1. pack dist/firefox into a store-only XPI and install it in cold Firefox
//   2. assert install-time onboarding auto-opens, then load options into the
//      original Marionette content handle using a system principal
//   3. arm Frozen Turkey + a URL-substring blocklist keyword (no model needed)
//   4. navigate example.com and assert blocked.html + one live session rule
//   5. unlock and assert the Firefox session rules drain
// example.com is used because localhost/127.0.0.1 sit in DEFAULT_WHITELIST.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_ORIGIN,
  FIREFOX_UUID,
  FirefoxTestSession,
  GECKO_ID,
  makeChecker,
  sleep,
} from './lib/firefox-marionette.mjs';

const SB_FIREFOX = process.env.SB_FIREFOX;
if (!SB_FIREFOX) {
  console.error('SB_FIREFOX env var required (path to a Firefox binary, e.g. /usr/bin/firefox)');
  process.exit(2);
}

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'firefox');
const KW = 'sb-fx3-dnr-probe-kw';
const TARGET = `https://example.com/?q=${KW}`;
const OPTIONS_URL = `${EXTENSION_ORIGIN}/options.html`;
const { check, finish } = makeChecker('FIREFOX DNR VERIFY');
let session;

try {
  session = await FirefoxTestSession.launch({ firefoxPath: SB_FIREFOX, dist: DIST });
  const { driver } = session;
  const exts = await driver.evalAsync(
    `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     const list = await AddonManager.getAddonsByTypes(['extension']);
     return list.map((a) => a.id + ' active=' + a.isActive);`,
    'chrome',
  );
  check(
    Array.isArray(exts) && exts.some((entry) => entry.startsWith(GECKO_ID) && entry.includes('active=true')),
    'SmartBlocker temporary add-on installed and active',
  );
  await sleep(2500);

  // The extension auto-opens welcome on install. Selecting that tab through
  // gBrowser alone does not change Marionette's active content context, so the
  // subsequent options load goes into the original handle retained by launch().
  let foundOptions = false;
  for (let i = 0; i < 20 && !foundOptions; i++) {
    await sleep(1000);
    foundOptions = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       for (let i = 0; i < win.gBrowser.tabs.length; i++) {
         const uri = win.gBrowser.browsers[i]?.currentURI?.spec ?? '';
         if (uri.startsWith(${JSON.stringify(OPTIONS_URL)})) {
           win.gBrowser.selectedTab = win.gBrowser.tabs[i];
           return true;
         }
       }
       return false;`,
      'chrome',
    );
  }
  check(foundOptions, 'options page tab present (auto-opened on install)');
  await session.load(OPTIONS_URL);
  check(true, 'Marionette loaded options into its active extension tab');
  await sleep(1500);

  const dnrApi = await driver.eval(
    `if (typeof browser === 'undefined') {
       return 'missing @ ' + location.href +
         ' (browser=' + typeof browser + ', chrome=' + typeof chrome + ')';
     }
     return typeof browser.declarativeNetRequest?.updateSessionRules === 'function'
       ? (typeof browser.declarativeNetRequest.getSessionRules === 'function' ? 'full' : 'update-only')
       : 'missing';`,
  );
  check(dnrApi === 'full', `Firefox exposes the session-rules DNR surface (${dnrApi})`);
  if (dnrApi !== 'full') throw new Error(`Firefox extension API probe failed: ${dnrApi}`);

  await driver.evalAsync(
    `const keyword = injected[0];
     const { settings = {} } = await browser.storage.local.get('settings');
     await browser.storage.local.set({
       settings: { ...settings, blocklist: [keyword] },
       lockState: {
         timerUntil: null, passwordHash: null,
         frozenUntil: Date.now() + 120_000, schedules: [], schedulesUpdatedAt: 0,
       },
     });
     return 'armed';`,
    'content',
    [KW],
  );
  console.log('… frozen turkey armed + blocklist keyword set');
  await sleep(1500); // storage.onChanged fan-out into the background scripts

  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     const principal = Services.scriptSecurityManager.getSystemPrincipal();
     const tab = win.gBrowser.addTab(${JSON.stringify(TARGET)}, { triggeringPrincipal: principal });
     win.gBrowser.selectedTab = tab;
     return 'ok';`,
    'chrome',
  );

  let tabs = [];
  let blockedUrl = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    tabs = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       const out = [];
       for (const browser of win.gBrowser.browsers) out.push(browser?.currentURI?.spec ?? '');
       return out;`,
      'chrome',
    );
    blockedUrl = tabs.find((url) => url.includes('blocked.html')) ?? null;
    if (blockedUrl) break;
  }
  console.log('… tab URIs:', JSON.stringify(tabs));

  const onBlockedPage = blockedUrl?.startsWith(`${EXTENSION_ORIGIN}/blocked.html`) ?? false;
  check(
    onBlockedPage,
    'Frozen Turkey force block DNR-redirects to extension-owned blocked.html in Firefox',
  );
  let okSoFar = onBlockedPage;
  if (onBlockedPage) {
    const reason = new URL(blockedUrl).searchParams.get('reason');
    okSoFar = reason === 'dnf-redirect';
    check(okSoFar, `blocked page reason param is dnf-redirect (${reason})`);
  } else {
    const hasOverlay = await driver
      .eval(`return !!document.getElementById('smartblocker-overlay');`)
      .catch(() => null);
    okSoFar = hasOverlay === true;
    check(okSoFar, 'fallback: injected overlay mounted instead (documented Firefox degrade path)');
  }

  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     for (let i = 0; i < win.gBrowser.tabs.length; i++) {
       const uri = win.gBrowser.browsers[i]?.currentURI?.spec ?? '';
       if (uri.startsWith(${JSON.stringify(OPTIONS_URL)})) {
         win.gBrowser.selectedTab = win.gBrowser.tabs[i];
         return 'ok';
       }
     }
     return 'missing';`,
    'chrome',
  );
  await sleep(500);
  const rules = await driver.evalAsync(`return await browser.declarativeNetRequest.getSessionRules();`);
  console.log(
    `… live session rules while locked: ${rules.length}`,
    JSON.stringify(rules.map((rule) => rule.condition?.urlFilter)),
  );
  check(okSoFar ? rules.length >= 1 : true, 'session rule present for the blocked tab (DNR path)');

  await driver.evalAsync(
    `const { lockState } = await browser.storage.local.get('lockState');
     if (lockState) await browser.storage.local.set({ lockState: { ...lockState, frozenUntil: null } });
     return 'unlocked';`,
  );
  await sleep(2500);
  const rulesAfter = await driver.evalAsync(`return await browser.declarativeNetRequest.getSessionRules();`);
  check(rulesAfter.length === 0, `unlock drains Firefox session rules (left ${rulesAfter.length})`);
} catch (error) {
  console.error('FATAL', error?.stack ?? error);
  check(false, 'suite completed without a fatal harness or runtime error');
} finally {
  await session?.close();
}

process.exit(finish() === 0 ? 0 : 1);
