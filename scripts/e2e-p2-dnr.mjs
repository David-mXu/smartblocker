// P2 DNR force-redirect e2e (red-team 2026-11-05 findings #1/#4 follow-up —
// the finding's own "prefer declarativeNetRequest redirect" recommendation).
// Run AFTER `npm run build:chrome`. Shares the .e2e-profile harness pattern
// from e2e-test.mjs (persistent profile; this suite runs WITHOUT the model:
// every deterministic block goes through the blocklist short-circuit, and the
// fail-closed case sabotages the classifier on purpose).
//
//   a. Frozen Turkey active → a would-block page DNR-redirects to the
//      extension-owned blocked.html: final origin is chrome-extension://, the
//      site's content DOM never renders, and the locked screen (no bypass
//      buttons) renders from query params.
//   b. Page-injected script on the ORIGINAL page cannot remove the block:
//      harness carries the P0 auto-click PoC (MutationObserver clicking
//      "actually productive" and removing #smartblocker-overlay) — there is
//      no shared DOM, so the flow lands on blocked.html anyway and no
//      override is ever stored.
//   c. Unlock (raw frozenUntil clear, same pattern as e2e-test.mjs restore)
//      drains the session rules and the page loads normally again.
//   d. Regression: a non-force block still uses the INJECTED overlay
//      (#smartblocker-overlay present, URL stays https）。
//   e. Frozen Turkey + sabotaged classifier → fail-closed redirect with
//      reason=classifier-unavailable rendered, retries keep firing, and no
//      fake confidence pill. (Password-lock fail-closed stays injected —
//      covered by e2e-p1-privacy-failclosed.mjs.)
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile');
const RUN = Date.now().toString(36); // keeps titles/keywords out of caches
const KW = `sb-p2-kw-${RUN}`; // deterministic blocklist trigger (no classifier)

// Chromium caches the MV3 service-worker SCRIPT in the profile — drop only
// ScriptCache (CacheStorage must survive; this suite never needs the model).
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let worker = ctx.serviceWorkers()[0];
    if (!worker) {
      const swPromise = ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      worker = ctx.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (worker) return { context: ctx, sw: worker };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('service worker did not boot after 3 launches');
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

const { context, sw } = await launchWithServiceWorker();

try {
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  const isBlockedPage = (u) =>
    u.protocol === 'chrome-extension:' &&
    u.host === extensionId &&
    u.pathname.endsWith('/blocked.html');
  const forceRuleCount = () =>
    sw.evaluate((base) =>
      chrome.declarativeNetRequest
        .getSessionRules()
        .then((rules) => rules.filter((r) => r.id >= base).length),
    1_000_000);

  // Fresh state (persistent profile leaks across runs) + deterministic
  // blocklist. Raw storage writes on purpose — see e2e-test.mjs.
  await sw.evaluate(async (kw) => {
    await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'lockState']);
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [kw] } });
  }, KW);

  // Fake watch pages (real youtube.com URLs via network interception). The
  // &poc=1 variant carries the red-team P0 page-side auto-click PoC.
  const P0_POC = `<script>
    // P0 PoC (2026-11-05 finding #1): the blocked page tries to synth-click
    // its own override button AND rip the overlay out of the DOM.
    new MutationObserver(() => {
      const b = [...document.querySelectorAll('#smartblocker-overlay button')]
        .find((x) => /productive/i.test(x.textContent));
      if (b) b.click();
      document.getElementById('smartblocker-overlay')?.remove();
    }).observe(document.documentElement, { childList: true, subtree: true });
  <\/script>`;
  await context.route('**://www.youtube.com/watch**', (route) => {
    const u = new URL(route.request().url());
    const t = decodeURIComponent(u.searchParams.get('t') ?? 'YouTube');
    const poc = u.searchParams.get('poc') === '1' ? P0_POC : '';
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body:
        `<!doctype html><html><head><title>${t} - YouTube</title>${poc}</head>` +
        `<body><h1>${t}</h1></body></html>`,
    });
  });

  const tab = await context.newPage();

  // ── (a) Frozen Turkey → would-block page lands on the extension page ────
  await sw.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: Date.now() + 120_000,
        schedules: [],
      },
    }),
  );
  await tab.waitForTimeout(400); // let onChanged listeners fire

  const titleA = `gaming marathons compilation ${RUN}`;
  const urlA =
    'https://www.youtube.com/watch?v=p2a&kw=' + KW + '&t=' + encodeURIComponent(titleA);
  await tab.goto(urlA);
  let landedA = false;
  try {
    await tab.waitForURL(isBlockedPage, { timeout: 10_000 });
    landedA = true;
  } catch {}
  check('(a) force mode: would-block page DNR-redirects to extension blocked.html', landedA, tab.url());

  if (landedA) {
    const domState = await tab.evaluate(() => ({
      protocol: location.protocol,
      title: document.title,
      h1s: document.querySelectorAll('h1').length,
      bodyText: document.body?.textContent ?? '',
    }));
    check(
      '(a) final document is the extension page; hostile content DOM never renders',
      domState.protocol === 'chrome-extension:' &&
        domState.title === 'Blocked — Smart Blocker' &&
        domState.h1s === 0,
      JSON.stringify({ protocol: domState.protocol, title: domState.title, h1s: domState.h1s }),
    );
    const btns = tab.locator('#smartblocker-blocked button');
    const overrideCount = await btns.filter({ hasText: 'actually productive' }).count();
    const dismissCount = await btns.filter({ hasText: 'Dismiss' }).count();
    const stayCount = await btns.filter({ hasText: 'Stay focused' }).count();
    check(
      '(a) locked block page hides bypass buttons',
      overrideCount === 0 && dismissCount === 0 && stayCount === 1,
      `(override ${overrideCount}, dismiss ${dismissCount}, stay ${stayCount})`,
    );
    check(
      '(a) lock copy + original title render from query params',
      domState.bodyText.includes('Smart Blocker is locked — bypass is disabled') &&
        domState.bodyText.includes(titleA),
    );
    check('(a) redirect carried reason=dnf-redirect', tab.url().includes('reason=dnf-redirect'));
    check('(a) force-redirect session rule installed', (await forceRuleCount()) >= 1);
  }

  // ── (b) P0 page-side PoC cannot remove the block ────────────────────────
  const titleB = `speedrun world record reaction ${RUN}`;
  await tab.goto(
    'https://www.youtube.com/watch?v=p2b&kw=' + KW + '&poc=1&t=' + encodeURIComponent(titleB),
  );
  let landedB = false;
  try {
    await tab.waitForURL(isBlockedPage, { timeout: 10_000 });
    landedB = true;
  } catch {}
  await tab.waitForTimeout(1_500); // give the PoC time to (fail to) act
  const stillBlockedB = landedB && isBlockedPage(new URL(tab.url()));
  check('(b) page-injected P0 PoC script cannot remove the DNR block', stillBlockedB, tab.url());
  const { overrides = [] } = await sw.evaluate(() => chrome.storage.local.get('overrides'));
  check(
    '(b) no override/allowlist entry was stored by the page',
    overrides.length === 0,
    `(overrides ${JSON.stringify(overrides)})`,
  );

  // ── (c) unlock → rules drained → original page loads normally ───────────
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
  await tab.waitForTimeout(600); // storage.onChanged → clearAllForceRedirectRules
  check('(c) unlock drains all force-redirect session rules', (await forceRuleCount()) === 0);
  await tab.goto(urlA);
  await tab.waitForLoadState('load');
  const normalA = await tab.evaluate(() => ({
    protocol: location.protocol,
    title: document.title,
    h1s: document.querySelectorAll('h1').length,
  }));
  check(
    '(c) after unlock the same URL loads its real content DOM',
    normalA.protocol === 'https:' &&
      normalA.title === `${titleA} - YouTube` &&
      normalA.h1s === 1,
    JSON.stringify(normalA),
  );

  // ── (d) regression: NON-force block still uses the injected overlay ─────
  const titleD = `compilations funny moments ${RUN}`;
  await tab.goto(
    'https://www.youtube.com/watch?v=p2d&kw=' + KW + '&t=' + encodeURIComponent(titleD),
  );
  let overlayD = false;
  try {
    await tab.waitForSelector('#smartblocker-overlay', { timeout: 10_000 });
    overlayD = true;
  } catch {}
  const dOk = overlayD && new URL(tab.url()).protocol === 'https:';
  check(
    '(d) non-force block keeps the injected shadow-DOM overlay (no redirect)',
    dOk,
    tab.url(),
  );
  check('(d) non-force block installs NO session rule', (await forceRuleCount()) === 0);

  // ── (e) Frozen Turkey + dead classifier → fail-closed redirect ──────────
  // Sabotage EMBED/CLASSIFY inside the SW (same technique as
  // e2e-p1-privacy-failclosed.mjs §C — zero product-code test hooks).
  await sw.evaluate(() => {
    const g = globalThis;
    if (!g.__sbSendPatched) {
      g.__sbSendPatched = true;
      g.__sbOrigSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    }
    g.__sbSabotageCalls = 0;
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg && (msg.type === 'EMBED' || msg.type === 'CLASSIFY')) {
        g.__sbSabotageCalls++;
        return Promise.reject(new Error('forced classifier failure (e2e-p2)'));
      }
      return g.__sbOrigSendMessage(msg, ...rest);
    };
  });
  await sw.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: Date.now() + 120_000,
        schedules: [],
      },
    }),
  );
  await tab.waitForTimeout(400);

  const titleE = `quiet study piano focus ${RUN}`;
  // NOTE: no kw param — this page must reach the (sabotaged) classifier.
  await tab.goto(
    'https://www.youtube.com/watch?v=p2e&t=' + encodeURIComponent(titleE),
  );
  let landedE = false;
  try {
    await tab.waitForURL(
      (u) => isBlockedPage(u) && u.search.includes('reason=classifier-unavailable'),
      { timeout: 15_000 },
    );
    landedE = true;
  } catch {}
  check('(e) force + dead classifier → fail-closed DNR redirect', landedE, tab.url());
  if (landedE) {
    const bodyE = (await tab.locator('#smartblocker-blocked').textContent()) ?? '';
    const btnsE = tab.locator('#smartblocker-blocked button');
    const shapeE =
      /Classifier unavailable — fail-closed/i.test(bodyE) &&
      /Smart Blocker is locked — bypass is disabled/.test(bodyE) &&
      !/% confidence/.test(bodyE) &&
      (await btnsE.filter({ hasText: 'actually productive' }).count()) === 0 &&
      (await btnsE.filter({ hasText: 'Stay focused' }).count()) === 1;
    check('(e) fail-closed page renders reason, zero fake confidence, no bypass', shapeE);
    // Fail-closed retries continue underneath the redirect (1s → 2s backoff).
    await tab.waitForTimeout(4_000);
    const calls = await sw.evaluate(() => globalThis.__sbSabotageCalls ?? -1);
    check('(e) backoff retries keep firing after the redirect', calls >= 2, `(${calls} classify attempts)`);
  }

  // ── (f) "Stay focused (close tab)" closes only its own tab; the tab's
  // rules are pruned via tabs.onRemoved. Frozen still active from (e). ─────
  const beforeF = await forceRuleCount();
  const tabF = await context.newPage();
  await tabF.goto(
    'https://www.youtube.com/watch?v=p2f&kw=' + KW + '&t=' + encodeURIComponent(`epic fails mashup ${RUN}`),
  );
  let landedF = false;
  try {
    await tabF.waitForURL(isBlockedPage, { timeout: 10_000 });
    landedF = true;
  } catch {}
  check('(f) second tab also redirected under the same lock', landedF);
  let closedF = false;
  if (landedF) {
    const closeWait = tabF.waitForEvent('close', { timeout: 5_000 }).then(() => true).catch(() => false);
    await tabF.locator('#smartblocker-blocked button', { hasText: 'Stay focused' }).click();
    closedF = await closeWait;
  }
  check('(f) "Stay focused (close tab)" closes only its own tab', closedF && !tab.isClosed());
  await tab.waitForTimeout(600); // tabs.onRemoved → per-tab rule pruning
  check(
    '(f) closing the tab prunes its force-redirect rules',
    (await forceRuleCount()) <= beforeF,
    `(before ${beforeF}, after ${await forceRuleCount()})`,
  );

  // Cleanup: repair the classifier, unlock, drain rules for the next run.
  await sw.evaluate(() => {
    const g = globalThis;
    if (g.__sbOrigSendMessage) chrome.runtime.sendMessage = g.__sbOrigSendMessage;
  });
  await sw.evaluate(async () => {
    await chrome.storage.local.remove('lockState');
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [] } });
  });
  await tab.waitForTimeout(600);
  check('cleanup: rules drained for the next run', (await forceRuleCount()) === 0);
} finally {
  await context.close();
}
console.log(process.exitCode ? 'E2E-P2-DNR: FAILED' : 'E2E-P2-DNR: ALL PASSED');
