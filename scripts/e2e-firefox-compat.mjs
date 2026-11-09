#!/usr/bin/env node
// Firefox native permission/private-window compatibility matrix. Run after
// `npm run build:firefox`:
//   SB_FIREFOX=/path/to/firefox node scripts/e2e-firefox-compat.mjs
//
// Unlike the earlier fault-injection suite, every permission/private-access
// transition below goes through the real about:addons UI using trusted
// WebDriver ElementClick input. Assertions also leave that UI: they read real
// browser.* state, exercise the production welcome wizard, and inspect actual
// private documents. No permissions.contains mock or AddonManager permission
// write participates in this test.
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Native controls—not classification fixtures—are the subject of this suite.
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
const OPTIONS_URL = `${EXTENSION_ORIGIN}/options.html`;
const MODEL_TIMEOUT_MS = Number(process.env.SB_FIREFOX_MODEL_TIMEOUT_MS ?? 8 * 60_000);
if (!Number.isFinite(MODEL_TIMEOUT_MS) || MODEL_TIMEOUT_MS < 30_000) {
  throw new Error('SB_FIREFOX_MODEL_TIMEOUT_MS must be a finite number >= 30000');
}
const PRIVATE_DENIED_TITLE = 'Firefox private denied Dark Souls boss run 4381';
const PRIVATE_GAME_TITLE = 'Firefox private allowed Minecraft speedrun 4382';
const PRIVATE_PRODUCTIVE_TITLE = 'Firefox private TypeScript compiler tutorial 4383';
const { check, finish } = makeChecker('E2E-FIREFOX-COMPAT');
const must = (condition, label, details = '') => {
  check(condition, label, details);
  if (!condition) throw new Error(label);
};

let session;
let driver;
let fixtureServer;
let fixtureOrigin;
let mainWindowHandle;

// Marionette selects the element; WebDriver supplies the trusted pointer click.
// Current about:addons cards/details are light DOM. Only moz-toggle's inner
// button is behind a shadow root, accessed explicitly for aria-pressed below.
const CARD_SELECTOR = 'addon-card[addon-id="smartblocker-poc@davidxu.dev"]';
const ADDON_LINK_SELECTOR = `${CARD_SELECTOR} .addon-name-link`;
const PERMISSION_SELECTOR = 'moz-toggle[permission-key="<all_urls>"]';

async function nativeClickDeep(selector) {
  console.log('… native click target', selector, JSON.stringify(await driver.eval(
    `const element = document.querySelector(arguments[0]);
     if (!element) return null;
     const rect = element.getBoundingClientRect();
     return { tag: element.localName, href: element.getAttribute('href'), x: rect.x, y: rect.y, width: rect.width, height: rect.height };`,
    'content',
    [selector],
  )));
  await session.nativeClick(`return document.querySelector(arguments[0]);`, [selector]);
}

async function deepState(selector, body = 'return Boolean(element);') {
  return driver.eval(
    `const element = document.querySelector(arguments[0]);
     if (!element) return null;
     return (function(){ ${body} }).call(element);`,
    'content',
    [selector],
  );
}

async function waitForDeep(selector, body = 'return Boolean(element);', description = selector) {
  await session.waitFor(
    `const element = document.querySelector(arguments[0]);
     if (!element) return false;
     return (function(){ ${body} }).call(element);`,
    { args: [selector], timeoutMs: 30_000, description },
  );
}

async function openAddonDetails() {
  await session.load('about:addons');
  await waitForDeep('button[name="extension"]');
  await nativeClickDeep('button[name="extension"]');
  // Do not use a bare addon-details check here: the outgoing Recommendations
  // view can briefly supply one after the Extensions click, causing the suite
  // to skip SmartBlocker's actual detail link. Only this card's expanded state
  // proves that native navigation reached the intended view.
  await waitForDeep(ADDON_LINK_SELECTOR);
  const expanded = await deepState(CARD_SELECTOR, 'return element.getAttribute("expanded") === "true";');
  if (!expanded) {
    // The custom addon-card host is display:inline and not ElementClick-able;
    // its real addons://detail/... link is the native navigation target.
    await nativeClickDeep(ADDON_LINK_SELECTOR);
  }
  await waitForDeep(
    `${CARD_SELECTOR}[expanded="true"] addon-details`,
    'return Boolean(element);',
    'native SmartBlocker addon details',
  );
}

async function realAccessState() {
  await session.load(`${OPTIONS_URL}#advanced`);
  return driver.evalAsync(
    `return {
      allSites: await browser.permissions.contains({ origins: ['<all_urls>'] }),
      privateAllowed: await browser.extension.isAllowedIncognitoAccess(),
    };`,
  );
}

async function setAllSitesThroughUi(allowed) {
  await openAddonDetails();
  await nativeClickDeep('#details-deck-button-permissions');
  await waitForDeep(PERMISSION_SELECTOR, 'return Boolean(element.shadowRoot);');
  const before = await deepState(
    PERMISSION_SELECTOR,
    'return element.shadowRoot.querySelector("button")?.getAttribute("aria-pressed");',
  );
  if (before !== String(allowed)) await nativeClickDeep(PERMISSION_SELECTOR);
  await session.waitFor(
    `const element = document.querySelector(${JSON.stringify(PERMISSION_SELECTOR)});
     return element?.shadowRoot?.querySelector("button")?.getAttribute("aria-pressed") === ${JSON.stringify(String(allowed))};`,
    { description: `native all-site permission=${allowed}` },
  );
  const uiPressed = await deepState(
    PERMISSION_SELECTOR,
    'return element.shadowRoot.querySelector("button")?.getAttribute("aria-pressed");',
  );
  const actual = await realAccessState();
  must(
    uiPressed === String(allowed) && actual.allSites === allowed,
    `native about:addons ${allowed ? 'grant' : 'revoke'} changes real all-site access`,
    JSON.stringify({ uiPressed, actual }),
  );
  console.log(`… native permission ${allowed ? 'grant' : 'revoke'}`, JSON.stringify({ uiPressed, ...actual }));
  return actual;
}

async function setPrivateThroughUi(allowed) {
  await openAddonDetails();
  await nativeClickDeep('#details-deck-button-details');
  const selector = `input[name="private-browsing"][value="${allowed ? '1' : '0'}"]`;
  await waitForDeep(selector, 'return !element.disabled;');
  if (!(await deepState(selector, 'return element.checked;'))) await nativeClickDeep(selector);
  await session.waitFor(
    `return document.querySelector(${JSON.stringify(selector)})?.checked === true;`,
    { description: `native private-window access=${allowed}` },
  );
  const uiChecked = await deepState(selector, 'return element.checked;');
  const actual = await realAccessState();
  must(
    uiChecked && actual.privateAllowed === allowed,
    `native about:addons ${allowed ? 'allows' : 'disallows'} private-window access`,
    JSON.stringify({ uiChecked, actual }),
  );
  console.log(`… native private ${allowed ? 'allow' : 'deny'}`, JSON.stringify({ uiChecked, ...actual }));
  return actual;
}

async function readSettings() {
  return driver.evalAsync(`return (await browser.storage.local.get('settings')).settings ?? {};`);
}

async function rpc(type) {
  return driver.evalAsync(
    `return await browser.runtime.sendMessage({ type: injected[0] });`,
    'content',
    [type],
    MODEL_TIMEOUT_MS,
  );
}

async function loadWelcomeFinal() {
  // Reset only the viewer's step preference, then traverse both real wizard
  // steps with trusted input. Reloading directly on the final step raced cold
  // Firefox inference and intermittently timed out Marionette's script call.
  let stage = 'load advanced before welcome reset';
  try {
    await session.load(`${OPTIONS_URL}#advanced`);
    stage = 'reset welcome step';
    await driver.eval(`localStorage.setItem('smartblocker.welcomeStep', '0'); return true;`);
    stage = 'load welcome category step';
    await session.load(`${OPTIONS_URL}#welcome`);
    await session.waitFor(
      `return Boolean(document.querySelector('#welcome-category-list')) &&
         document.querySelector('#welcome-continue')?.disabled === false;`,
      { description: 'real category step before native compatibility verification' },
    );
    stage = 'trusted continue to site step';
    await session.nativeClick(`return document.querySelector('#welcome-continue');`);
    await session.waitFor(
      `return Boolean(document.querySelector('#welcome-focus-goal')) &&
         document.querySelector('#welcome-continue')?.disabled === false;`,
      { description: 'real site step before native compatibility verification' },
    );
    stage = 'trusted continue to verification step';
    await session.nativeClick(`return document.querySelector('#welcome-continue');`);
    await session.waitFor(`return Boolean(document.querySelector('#welcome-verification'));`, {
      description: 'welcome verification after trusted category/site steps',
    });
  } catch (error) {
    const content = await driver.eval(
      `return {
         url: location.href,
         ready: document.readyState,
         title: document.title,
         continueDisabled: document.querySelector('#welcome-continue')?.disabled ?? null,
         verification: document.querySelector('#welcome-verification')?.dataset.state ?? null,
       };`,
    ).catch((probeError) => ({ probeError: String(probeError) }));
    const tabs = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       return {
         selected: win.gBrowser.selectedBrowser?.currentURI?.spec ?? null,
         retained: win.__smartBlockerTestTab?.linkedBrowser?.currentURI?.spec ?? null,
         tabs: win.gBrowser.browsers.map((browser) => browser?.currentURI?.spec ?? null),
       };`,
      'chrome',
    ).catch((probeError) => ({ probeError: String(probeError) }));
    console.error('… welcome traversal failed', JSON.stringify({ stage, content, tabs }));
    throw error;
  }
}

async function waitVerification(state) {
  await session.waitFor(
    `return document.querySelector('#welcome-verification')?.dataset.state === ${JSON.stringify(state)};`,
    { timeoutMs: MODEL_TIMEOUT_MS, description: `native-flow verification ${state}` },
  ).catch(async (error) => {
    console.error('… unexpected wizard state', JSON.stringify(await driver.eval(
      `return {
        url: location.href,
        wizard: Boolean(document.querySelector('#welcome-wizard')),
        state: document.querySelector('#welcome-verification')?.dataset.state ?? null,
        startDisabled: document.querySelector('#welcome-start')?.disabled ?? null,
        verificationText: document.querySelector('#welcome-verification')?.textContent ?? null,
        body: document.body.innerText.slice(-5000),
      };`,
    )));
    throw error;
  });
  return driver.eval(
    `return {
      state: document.querySelector('#welcome-verification')?.dataset.state,
      startDisabled: document.querySelector('#welcome-start')?.disabled,
      privateWarning: document.querySelector('#welcome-incognito')?.textContent ?? null,
      body: document.querySelector('#welcome-verification')?.textContent ?? '',
    };`,
  );
}

async function denyCompletion() {
  const report = await rpc('COMPLETE_ONBOARDING');
  const settings = await readSettings();
  must(
    report.status === 'degraded' &&
      report.saved === false &&
      report.checks?.find((entry) => entry.id === 'site-access')?.status === 'failed' &&
      settings.onboarded !== true,
    'real native revocation refuses background onboarding completion',
    JSON.stringify({ report, onboarded: settings.onboarded }),
  );
}

async function windowHandles() {
  return driver.send('WebDriver:GetWindowHandles');
}

async function switchWindow(handle) {
  await driver.send('WebDriver:SwitchToWindow', { handle });
}

async function openPrivatePage(url) {
  const before = await windowHandles();
  await driver.eval(
    `const original = Services.wm.getMostRecentWindow('navigator:browser');
     original.OpenBrowserWindow({ private: true });
     return true;`,
    'chrome',
  );
  await sleep(2000);
  await driver.eval(
    `const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
     const enumerator = Services.wm.getEnumerator('navigator:browser');
     let privateWin;
     while (enumerator.hasMoreElements()) {
       const win = enumerator.getNext();
       if (PrivateBrowsingUtils.isWindowPrivate(win)) { privateWin = win; break; }
     }
     if (!privateWin) throw new Error('private browser window was not opened');
     const tab = privateWin.gBrowser.addTab(arguments[0], {
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });
     privateWin.gBrowser.selectedTab = tab;
     return true;`,
    'chrome',
    [url],
  );
  const deadline = Date.now() + 30_000;
  let privateHandle;
  while (Date.now() < deadline && !privateHandle) {
    const after = await windowHandles();
    const newHandles = after.filter((handle) => !before.includes(handle));
    // Opening a private window creates both about:privatebrowsing and the
    // requested tab. Handle order is not tab order, so inspect each genuine
    // document instead of assuming the first new handle is the fixture.
    for (const handle of newHandles) {
      await switchWindow(handle);
      const currentUrl = await driver.eval(`return location.href;`).catch(() => null);
      if (currentUrl === url) {
        privateHandle = handle;
        break;
      }
    }
    if (!privateHandle) await sleep(250);
  }
  must(privateHandle, 'Firefox exposed a Marionette handle for the real private fixture tab');
  await session.waitFor(`return location.href === ${JSON.stringify(url)};`, {
    description: `private navigation to ${url}`,
  });
  return privateHandle;
}

async function closePrivateWindow(privateHandle) {
  await switchWindow(mainWindowHandle);
  await driver.eval(
    `const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
     const enumerator = Services.wm.getEnumerator('navigator:browser');
     let closed = 0;
     while (enumerator.hasMoreElements()) {
       const win = enumerator.getNext();
       if (PrivateBrowsingUtils.isWindowPrivate(win)) { win.close(); closed++; }
     }
     return closed;`,
    'chrome',
  );
  await session.waitFor(`return location.protocol === 'moz-extension:';`, {
    description: 'return from private window to the original extension tab',
  }).catch(async () => {
    await switchWindow(mainWindowHandle);
    await session.load(`${OPTIONS_URL}#advanced`);
  });
  const deadline = Date.now() + 30_000;
  let remaining = await windowHandles();
  while (remaining.includes(privateHandle) && Date.now() < deadline) {
    await sleep(250);
    remaining = await windowHandles();
  }
  must(!remaining.includes(privateHandle), 'private test window closes and its Marionette handle disappears');
}

async function latencyEvidence() {
  await session.load(`${OPTIONS_URL}#advanced`);
  return driver.evalAsync(
    `const { latencySamples = [] } = await browser.storage.local.get('latencySamples');
     const history = await browser.history.search({ text: '', startTime: 0, maxResults: 1000 });
     const rules = await browser.declarativeNetRequest.getSessionRules();
     return {
       latencySamples,
       fixtureHistory: history.filter((entry) => entry.url?.startsWith(injected[0])).map((entry) => entry.url),
       sessionRules: rules,
     };`,
    'content',
    [fixtureOrigin],
    30_000,
  );
}

try {
  session = await FirefoxTestSession.launch({
    firefoxPath: SB_FIREFOX,
    dist: DIST,
    scriptTimeoutMs: MODEL_TIMEOUT_MS + 15_000,
  });
  driver = session.driver;
  await sleep(1500);
  const initial = await realAccessState();
  mainWindowHandle = (await windowHandles())[0];
  must(
    initial.allSites === true && initial.privateAllowed === false,
    'cold Firefox starts with real all-site access and native private access denied',
    JSON.stringify(initial),
  );

  // 1. Real UI revoke -> denied verification -> UI grant -> ready preview.
  await setAllSitesThroughUi(false);
  await loadWelcomeFinal();
  const denied = await waitVerification('degraded');
  must(
    denied.startDisabled === true && /all-site access/i.test(denied.body),
    'real revoked permission produces degraded wizard evidence and a disabled Start button',
    JSON.stringify(denied),
  );
  await denyCompletion();
  check(
    denied.privateWarning?.includes('Add-ons and themes') &&
      denied.privateWarning.includes('Run in Private Windows'),
    'Firefox welcome warning points to the native private-window control',
    denied.privateWarning ?? 'missing private warning',
  );

  await setAllSitesThroughUi(true);
  await loadWelcomeFinal();
  const granted = await waitVerification('ready');
  must(
    granted.startDisabled === false,
    'real UI grant retries cold inference and enables verified Start blocking',
    JSON.stringify({ state: granted.state, startDisabled: granted.startDisabled }),
  );

  // 2. Revoke even after a ready preview: a new run and commit both fail.
  await setAllSitesThroughUi(false);
  await loadWelcomeFinal();
  const revoked = await waitVerification('degraded');
  must(revoked.startDisabled === true, 'native re-revocation invalidates the previously ready wizard');
  await denyCompletion();

  // 3. A second real UI grant is the retry that permits verified persistence.
  await setAllSitesThroughUi(true);
  await loadWelcomeFinal();
  const retried = await waitVerification('ready');
  await session.nativeClick(`return document.querySelector('#welcome-start');`);
  await session.waitFor(`return !document.querySelector('#welcome-wizard');`, {
    timeoutMs: MODEL_TIMEOUT_MS,
    description: 'native UI retry completes onboarding',
  });
  const completed = await readSettings();
  must(
    retried.startDisabled === false && completed.enabled === true && completed.onboarded === true,
    'native denied→granted→revoked→retried flow ends in verified onboarding persistence',
    JSON.stringify({ enabled: completed.enabled, onboarded: completed.onboarded }),
  );

  // 4. Private denied and allowed states must differ in actual page enforcement.
  await session.load(`${OPTIONS_URL}#locks`);
  await session.waitFor(`return Boolean(document.querySelector('#incognito-warning'));`, {
    description: 'private-access warning in locks settings',
  });
  const locksWarning = await driver.eval(`return document.querySelector('#incognito-warning').textContent;`);
  check(
    locksWarning.includes('Add-ons and themes') && locksWarning.includes('Run in Private Windows'),
    'Firefox locks warning gives Firefox-specific private-permission directions',
    locksWarning,
  );

  const current = await readSettings();
  must(
    (current.blocklist ?? []).length === 0 && (current.titleRules ?? []).length === 0,
    'private navigation retains empty deterministic block/title rules',
  );
  await driver.evalAsync(
    `const { settings = {} } = await browser.storage.local.get('settings');
     await browser.storage.local.set({
       settings: {
         ...settings,
         whitelist: (settings.whitelist ?? []).filter(
           (entry) => !/^(?:localhost|127\\.0\\.0\\.1|\\[?::1\\]?)$/i.test(entry.trim()),
         ),
       },
     });
     return 'loopback fixture is not whitelisted';`,
  );

  fixtureServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const titles = {
      denied: PRIVATE_DENIED_TITLE,
      game: PRIVATE_GAME_TITLE,
      productive: PRIVATE_PRODUCTIVE_TITLE,
    };
    const title = titles[url.searchParams.get('title')];
    if (url.pathname !== '/private-compat' || !title) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        '<body><main><h1>Firefox private compatibility fixture</h1></main></body></html>',
    );
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

  const deniedPrivateHandle = await openPrivatePage(`${fixtureOrigin}/private-compat?title=denied`);
  await session.waitFor(`return document.title === ${JSON.stringify(PRIVATE_DENIED_TITLE)};`, {
    description: 'private-denied fixture title',
  });
  await sleep(4000);
  const deniedDom = await driver.eval(
    `return {
      title: document.title,
      overlay: Boolean(document.getElementById('smartblocker-overlay')),
      privateBrowsingUiVisible: document.body.textContent.includes('Firefox private compatibility fixture'),
    };`,
  );
  must(
    deniedDom.privateBrowsingUiVisible && deniedDom.overlay === false,
    'with native private access denied, the genuine private page remains outside extension enforcement',
    JSON.stringify(deniedDom),
  );
  await closePrivateWindow(deniedPrivateHandle);
  const deniedEvidence = await latencyEvidence();
  must(
    !deniedEvidence.latencySamples.some((sample) => sample.title === PRIVATE_DENIED_TITLE),
    'private-denied navigation produces no background classification evidence',
  );

  await setPrivateThroughUi(true);
  const gamePrivateHandle = await openPrivatePage(`${fixtureOrigin}/private-compat?title=game`);
  await session.waitFor(
    `const host = document.getElementById('smartblocker-overlay');
     return document.title === ${JSON.stringify(PRIVATE_GAME_TITLE)} &&
       Boolean(host?.shadowRoot) && host.dataset.smartblockerContext === 'top';`,
    { timeoutMs: 90_000, description: 'private-allowed classifier overlay' },
  );
  check(true, 'native private Allow enables fresh classifier enforcement inside a real private window');

  await driver.eval(`document.title = arguments[0]; return document.title;`, 'content', [PRIVATE_PRODUCTIVE_TITLE]);
  await session.waitFor(
    `return document.title === ${JSON.stringify(PRIVATE_PRODUCTIVE_TITLE)} &&
       !document.getElementById('smartblocker-overlay');`,
    { timeoutMs: 90_000, description: 'private productive title clears enforcement' },
  );
  check(true, 'fresh programming title clears the overlay in the private window');
  await closePrivateWindow(gamePrivateHandle);

  const finalEvidence = await latencyEvidence();
  const game = [...finalEvidence.latencySamples].reverse().find((sample) => sample.title === PRIVATE_GAME_TITLE);
  const productive = [...finalEvidence.latencySamples]
    .reverse()
    .find((sample) => sample.title === PRIVATE_PRODUCTIVE_TITLE);
  must(
    game?.label === 'video games' &&
      game.blocked === true &&
      game.cached === false &&
      productive?.label === 'programming and software development' &&
      productive.blocked === false &&
      productive.cached === false &&
      finalEvidence.sessionRules.length === 0 &&
      finalEvidence.fixtureHistory.length === 0,
    'private fresh block/allow evidence is real, uses no DNR, and writes no ordinary Firefox history',
    JSON.stringify({
      game,
      productive,
      sessionRules: finalEvidence.sessionRules.length,
      fixtureHistory: finalEvidence.fixtureHistory,
    }),
  );
  await session.load(`${OPTIONS_URL}#locks`);
  await session.waitFor(`return document.body.textContent.includes('Focus hours');`, {
    description: 'locks page after native private Allow',
  });
  await sleep(500);
  const privateWarningGone = await driver.eval(`return !document.querySelector('#incognito-warning');`);
  check(privateWarningGone, 'private-access warning stays clear after native Allow');
} catch (error) {
  console.error('FATAL', error?.stack ?? error);
  check(false, 'suite completed without a fatal harness or runtime error');
} finally {
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  await session?.close();
}

process.exit(finish() === 0 ? 0 : 1);
