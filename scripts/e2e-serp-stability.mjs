// Focused Google SERP SPA-stability regression. Run after `npm run build:chrome`:
//   node scripts/e2e-serp-stability.mjs
//
// All Google pages are routed fixtures; no live searches are made. The default
// persistent profile is .e2e-profile (override with SB_E2E_PROFILE). Only its
// Service Worker ScriptCache is cleared so a rebuilt background.js cannot go
// stale. CacheStorage, including an already-downloaded model, is never removed.
import { chromium } from 'playwright';
import { readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(process.env.SB_E2E_PROFILE ?? '.e2e-profile');
const TRANSIENT_QUERY = 'funny cat memes';
const STABLE_QUERY = 'play minesweeper';
const ALLOWED_QUERY = 'React Router Tutorial';
const QUIET_WINDOW_MS = 650;
const TRANSIENT_WINDOW_MS = 350; // Deliberately below the planned quiet window.

let failures = 0;
function check(ok, label, details) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (details !== undefined) console.log(`  ${JSON.stringify(details)}`);
  if (!ok) failures++;
}
function skip(label, details) {
  console.log(`SKIP ${label}${details ? ` — ${details}` : ''}`);
}

// Chromium can retain an MV3 service-worker script across rebuilds. Do not
// clear the profile or CacheStorage (the model cache must stay warm).
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), {
  recursive: true,
  force: true,
});

// A fixed manifest key gives us the extension ID without touching a real
// browser. Opening an extension page + sending an unknown, read-only message
// wakes MV3 without a network navigation (and therefore without inference).
const manifest = JSON.parse(readFileSync(resolve(EXT_PATH, 'manifest.json'), 'utf8'));
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16).toString('hex')]
  .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
  .join('');

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let sw = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`));
    if (!sw) {
      const swPromise = context
        .waitForEvent('serviceworker', {
          predicate: (worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`),
          timeout: 10_000,
        })
        .catch(() => null);
      const waker = await context.newPage();
      await waker.goto(`chrome-extension://${extensionId}/options.html`).catch(() => {});
      await waker
        .evaluate(async () => {
          try {
            await chrome.runtime.sendMessage({ type: 'SB_E2E_SERP_STABILITY_WAKE' });
          } catch {
            // The service-worker event itself is the wake mechanism.
          }
        })
        .catch(() => {});
      sw = context.serviceWorkers().find((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`)) ?? (await swPromise);
      await waker.close();
    }
    if (sw) return { context, sw };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await context.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error('service worker did not boot after 3 launches');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

async function installGoogleFixtures(context) {
  await context.route('**://www.google.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/' && url.pathname !== '/search') {
      return route.fulfill({ contentType: 'text/plain', body: 'routed fixture' });
    }
    if (url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta charset="utf-8"><title>Google</title></head><body><main><textarea name="q"></textarea><p>Routed SPA starting point</p></main></body></html>',
      });
    }
    const query = url.searchParams.get('q') ?? '';
    const q = escapeHtml(query);
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>${q} - Google Search</title></head><body><textarea name="q">${q}</textarea><div id="rso"><div class="MjjYud"><a href="https://reactrouter.com/"><h3>React Router documentation and programming tutorial</h3></a><div class="VwiC3b">Learn client-side routing and software development with the official React Router documentation.</div></div></div></body></html>`,
    });
  });
}

// Runs before site/extension scripts in every new document. The observer keeps
// mount events even when a curtain auto-expires or an overlay is later removed.
// reset() is used only within an SPA document, preserving the same observer.
async function installMountObserver(context) {
  await context.addInitScript(() => {
    const overlayEvents = [];
    const curtainEvents = [];
    const record = (kind, node) => {
      const event = {
        kind,
        timestamp: Date.now(),
        documentMs: Math.round(performance.now() * 100) / 100,
        title: document.title,
        url: location.href,
        nodeId: node.id,
      };
      (kind === 'overlay' ? overlayEvents : curtainEvents).push(event);
    };
    const inspect = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.id === 'smartblocker-overlay') record('overlay', node);
      if (node.id === 'smartblocker-curtain') record('curtain', node);
      for (const nested of node.querySelectorAll('#smartblocker-overlay, #smartblocker-curtain')) {
        record(nested.id === 'smartblocker-overlay' ? 'overlay' : 'curtain', nested);
      }
    };
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) inspect(node);
      }
    }).observe(document, { childList: true, subtree: true });

    Object.defineProperty(window, '__sbSerpStability', {
      value: Object.freeze({
        reset() {
          overlayEvents.length = 0;
          curtainEvents.length = 0;
        },
        snapshot() {
          return {
            overlays: overlayEvents.map((event) => ({ ...event })),
            curtains: curtainEvents.map((event) => ({ ...event })),
          };
        },
      }),
      configurable: false,
      writable: false,
    });
  });
}

async function pushSpaQuery(tab, query) {
  await tab.evaluate((nextQuery) => {
    const input = document.querySelector('textarea[name="q"], input[name="q"]');
    if (input) input.value = nextQuery;
    const url = new URL(location.href);
    url.pathname = '/search';
    url.searchParams.set('q', nextQuery);
    history.pushState({ smartBlockerSerpFixture: true }, '', url);
    document.title = `${nextQuery} - Google Search`;
  }, query);
}

async function resetMounts(tab) {
  await tab.evaluate(() => window.__sbSerpStability.reset());
}
async function mounts(tab) {
  return tab.evaluate(() => window.__sbSerpStability.snapshot());
}
async function openingGoogleDocument(tab) {
  await tab.goto('https://www.google.com/');
  await tab.waitForTimeout(250); // Let the benign starting document settle.
  await resetMounts(tab);
}
async function transientThenFinal(tab, finalQuery) {
  await pushSpaQuery(tab, TRANSIENT_QUERY);
  // Advance immediately on an old-build transient insertion, or after 350 ms
  // on a fixed build. The final query lands before a 650 ms debounce can settle.
  await tab
    .waitForFunction(() => window.__sbSerpStability.snapshot().overlays.length > 0, undefined, {
      timeout: TRANSIENT_WINDOW_MS,
    })
    .catch(() => {});
  await pushSpaQuery(tab, finalQuery);
}

let context;
let sw;
let originalState;
let stateArmed = false;

try {
  ({ context, sw } = await launchWithServiceWorker());
  console.log(`PASS service worker booted: ${sw.url()}`);
  sw.on('console', (message) => {
    if (message.type() === 'error') console.log(`  [sw:error] ${message.text()}`);
  });

  originalState = await sw.evaluate(() =>
    chrome.storage.local.get(['settings', 'overrides', 'lockState']),
  );
  await sw.evaluate(async ({ transient, stable }) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const whitelist = Array.isArray(settings.whitelist) ? settings.whitelist : [];
    await chrome.storage.local.set({
      settings: {
        ...settings,
        enabled: true,
        blocklist: [],
        titleRules: [transient, stable],
        // Blank Google is an extension-safe starting document. Active SERPs
        // intentionally bypass this whitelist in production and in this test.
        whitelist: [...new Set([...whitelist, 'google.com'])],
        focusGoal: '',
        useTabContext: false,
        maskSearchElements: false,
        surrenderMode: 'off',
      },
    });
    await chrome.storage.local.remove(['overrides', 'lockState', 'latencySamples']);
  }, { transient: TRANSIENT_QUERY, stable: STABLE_QUERY });
  stateArmed = true;

  await installGoogleFixtures(context);
  await installMountObserver(context);
  const tab = await context.newPage();

  // 1. Blocked transient -> blocked final query on ONE Google document. The
  // pre-fix behavior is >1 full-page host insertion; the regression target is
  // exactly one insertion, for the settled final query only.
  await openingGoogleDocument(tab);
  await transientThenFinal(tab, STABLE_QUERY);
  await tab.waitForTimeout(QUIET_WINDOW_MS + 1250);
  const blockedToBlocked = await mounts(tab);
  const finalBlockedState = await tab.evaluate(() => ({
    title: document.title,
    url: location.href,
    visibleOverlay: Boolean(document.getElementById('smartblocker-overlay')),
  }));
  check(
    blockedToBlocked.overlays.length === 1 &&
      new URL(blockedToBlocked.overlays[0].url).searchParams.get('q') === STABLE_QUERY &&
      finalBlockedState.visibleOverlay,
    'blocked → blocked SPA transition mounts exactly one overlay for the final settled query',
    { ...blockedToBlocked, final: finalBlockedState },
  );

  // 2. A completed, deterministic short-ish query still blocks after the quiet
  // window. This rejects a fix that debounces by dropping short queries or by
  // applying a title/query-length heuristic instead of settling the latest one.
  await tab.goto('https://www.google.com/search?q=play+minesweeper&case=stable-short');
  await tab.waitForTimeout(QUIET_WINDOW_MS + 750);
  const stableShort = await mounts(tab);
  check(
    stableShort.overlays.length === 1 &&
      (await tab.locator('#smartblocker-overlay').count()) === 1,
    `"${STABLE_QUERY}" still blocks after ${QUIET_WINDOW_MS} ms quiet window (no length heuristic)`,
    stableShort,
  );

  // 3. The previous blocked search marks Google as recently blocked on the old
  // build. A fresh, deterministic override-allowed SERP used to flash a dark
  // curtain before that allow verdict. The desired behavior is NO curtain at
  // any point, even though it may have been removed by the time we inspect DOM.
  await sw.evaluate(async (allowedTitle) => {
    await chrome.storage.local.set({
      overrides: [{ title: allowedTitle, host: 'google.com', ts: Date.now() }],
    });
  }, TRANSIENT_QUERY);
  await tab.goto('https://www.google.com/search?q=funny+cat+memes&case=allowed-after-blocked');
  await tab.waitForTimeout(1200);
  const allowedAfterBlocked = await mounts(tab);
  check(
    allowedAfterBlocked.curtains.length === 0,
    'allowed Google SERP after a blocked query never mounts a dark pre-curtain',
    allowedAfterBlocked,
  );
  check(
    allowedAfterBlocked.overlays.length === 0 &&
      (await tab.locator('#smartblocker-overlay').count()) === 0,
    'scoped test override makes the post-block SERP deterministically allowed',
    allowedAfterBlocked,
  );

  // 4. Optional model-backed transient -> known-allowed React Router Tutorial.
  // Never initialize/download a cold model just for this test. When CacheStorage
  // is already warm, use the production classifier path and require zero total
  // overlay insertions on the shared SPA document.
  const modelCache = await sw.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.includes('transformers'));
    let entries = 0;
    for (const name of names) entries += (await (await caches.open(name)).keys()).length;
    return { names, entries };
  });
  if (modelCache.entries === 0) {
    skip('warm-model blocked transient → React Router Tutorial', 'no existing Transformers CacheStorage entries; not downloading a model');
  } else {
    await sw.evaluate(() => chrome.storage.local.remove('overrides'));
    await openingGoogleDocument(tab);
    await transientThenFinal(tab, ALLOWED_QUERY);
    await tab.waitForTimeout(8000);
    const modelTransition = await mounts(tab);
    const { latencySamples = [] } = await sw.evaluate(() => chrome.storage.local.get('latencySamples'));
    const reactSample = [...latencySamples].reverse().find((sample) => sample.title === ALLOWED_QUERY);
    check(
      modelTransition.overlays.length === 0 &&
        (await tab.locator('#smartblocker-overlay').count()) === 0 &&
        reactSample?.title === ALLOWED_QUERY &&
        reactSample?.blocked === false,
      'warm-model blocked transient → allowed React Router Tutorial mounts zero overlays and records the final allow',
      { ...modelTransition, reactSample, modelCache },
    );
  }

  await tab.close();
} catch (error) {
  check(false, 'SERP stability harness completed without an exception', error?.stack ?? String(error));
} finally {
  if (sw && stateArmed && originalState) {
    try {
      await sw.evaluate(async (original) => {
        if (original.settings === undefined) await chrome.storage.local.remove('settings');
        else await chrome.storage.local.set({ settings: original.settings });
        if (original.overrides === undefined) await chrome.storage.local.remove('overrides');
        else await chrome.storage.local.set({ overrides: original.overrides });
        if (original.lockState === undefined) await chrome.storage.local.remove('lockState');
        else await chrome.storage.local.set({ lockState: original.lockState });
      }, originalState);
    } catch (error) {
      check(false, 'restore original E2E-profile settings/overrides/lock state', String(error));
    }
  }
  await context?.close();
}

console.log(`E2E-SERP-STABILITY: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
