// Block-screen anti-tamper security e2e (red-team 2026-11-05 findings #1 + #4).
// Ports the P0-1 synthetic-click PoC and the finding-#4 remove / CSS-hide
// variants into a regression gate against a REAL Chromium with the shipped
// extension loaded. Run AFTER `npm run build:chrome` (the integrator builds;
// this script only asserts):
//
//   node scripts/e2e-security-blockscreen.mjs
//
//   a. #1 — a blocked page's own MutationObserver that auto-clicks the
//      override button (plus a direct synthetic click piercing the overlay's
//      open shadow root) must NOT dismiss the overlay and must record NO
//      override and NO false_positive feedback (isTrusted gate + per-injection
//      OVERRIDE nonce).
//   b. #4 — page JS `el.remove()` on the overlay host must re-mount within
//      ~1s (re-mount MutationObserver; the media trap must not detach).
//   c. #4 — a pre-emptive page stylesheet
//      `#smartblocker-overlay{display:none!important}` must stay inert: the
//      host's inline `display:flex !important` (plus an open shadow root for
//      everything inside it) keeps the overlay computed-visible.
//
// Uses its OWN persistent profile (.e2e-profile-security) so it never races
// the other e2e gates over .e2e-profile storage. No model download needed:
// every block here is a deterministic blocklist keyword match (URL match →
// block screen with inferMs 0, the e2e-test.mjs §4b path).
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-security');
const RUN_TAG = Date.now().toString(36); // keeps titles out of the title cache
const BLOCKLIST_KW = 'smartblocker-blocklist-security';

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

// Same stale-SW-script-cache hazard as e2e-test.mjs.
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
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

// --- Attack pages served as fake YouTube watch pages -----------------------
// `attack=click` embeds the exact red-team P0-1 PoC snippet (auto-clicks the
// override as soon as the overlay exists). `attack=css` pre-hides the overlay
// id — zero JS needed. `attack=remove` is plain (the driver removes it).
const pageHtml = (title, attack) => {
  const clicker = `<script>
    // Red-team P0-1 PoC: the page clicks its own block screen's override.
    new MutationObserver(() => {
      const b = [...document.querySelectorAll('#smartblocker-overlay button')]
        .find(x => /productive/i.test(x.textContent));
      if (b) { console.log('poc:auto-click:found-button'); b.click(); }
    }).observe(document.documentElement, { childList: true, subtree: true });
  </script>`;
  const cssHide =
    '<style>#smartblocker-overlay{display:none!important;visibility:hidden!important;' +
    'opacity:0!important;z-index:-9999!important;transform:translateX(-200vw)!important}</style>';
  return (
    `<!doctype html><html><head><title>${title} - YouTube</title>` +
    `${attack === 'css' ? cssHide : ''}</head>` +
    `<body><h1>${title}</h1>${attack === 'click' ? clicker : ''}</body></html>`
  );
};

const blockUrl = (attack) =>
  `https://www.youtube.com/watch?v=${attack}-` +
  RUN_TAG +
  `&kw=${BLOCKLIST_KW}&t=${encodeURIComponent('Security PoC ' + attack + ' ' + RUN_TAG)}`;

async function waitForOverlay(tab, timeout = 10_000) {
  try {
    await tab.waitForSelector('#smartblocker-overlay', { timeout });
    return true;
  } catch {
    return false;
  }
}

const { context, sw } = await launchWithServiceWorker();

try {
  console.log('PASS service worker booted:', sw.url());
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // Fresh extension state: no stale overrides/feedback/locks, deterministic
  // blocklist keyword armed exactly like e2e-test.mjs §4b.
  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [kw] } });
    await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'historyScan', 'lockState']);
  }, BLOCKLIST_KW);

  await context.route('**://www.youtube.com/watch**', (route) => {
    const u = new URL(route.request().url());
    const attack = (u.searchParams.get('v') ?? '').split('-')[0];
    route.fulfill({
      contentType: 'text/html',
      body: pageHtml(decodeURIComponent(u.searchParams.get('t') ?? 'YouTube'), attack),
    });
  });

  const tab = await context.newPage();
  tab.on('console', (msg) => {
    if (msg.text().startsWith('poc:')) console.log('  [page]', msg.text());
  });

  // ── (a) #1: synthetic-click self-override ─────────────────────────────
  await tab.goto(blockUrl('click'));
  const aMounted = await waitForOverlay(tab);
  check(aMounted, 'setup: blocklist keyword mounts the block screen (click page)');
  // The override button exists (unlocked block) — otherwise the attack is
  // vacuous. Playwright locators pierce the open shadow root; page JS cannot.
  const overrideBtn = tab.locator('#smartblocker-overlay button', { hasText: 'actually productive' });
  const btnCount = await overrideBtn.count();
  check(btnCount === 1, 'setup: unlocked block screen renders the override button');

  // The served page's MutationObserver has had ample time to auto-click.
  await tab.waitForTimeout(2_500);
  // Stronger than the PoC: pierce the (open) shadow root from page JS and
  // click for real — isTrusted=false must stop it even when reached.
  await tab.evaluate(() => {
    const host = document.getElementById('smartblocker-overlay');
    const btn = host?.shadowRoot?.querySelector('button');
    console.log('poc:shadow-pierce:found=' + !!btn);
    btn?.click();
  });
  await tab.waitForTimeout(1_500);

  const aOverlayCount = await tab.locator('#smartblocker-overlay').count();
  const aState = await sw.evaluate(() =>
    chrome.storage.local.get(['overrides', 'feedback']),
  );
  const aFp = (aState.feedback ?? []).filter((r) => r.kind === 'false_positive');
  check(
    aOverlayCount === 1 && (aState.overrides ?? []).length === 0 && aFp.length === 0,
    'synthetic auto-click + shadow-pierce click: overlay stays, NO override, NO false_positive',
  );

  // ── (b) #4: el.remove() must re-mount ─────────────────────────────────
  await tab.goto(blockUrl('remove'));
  const bMounted = await waitForOverlay(tab);
  check(bMounted, 'setup: blocklist keyword mounts the block screen (remove page)');
  await tab.evaluate(() => document.getElementById('smartblocker-overlay')?.remove());
  let bRemounted = false;
  for (let i = 0; i < 30; i++) {
    // MutationObserver re-append lands on the microtask queue — well under
    // the 1s budget, but poll generously for slow/loaded machines.
    const count = await tab.locator('#smartblocker-overlay').count();
    if (count === 1) {
      bRemounted = true;
      break;
    }
    await tab.waitForTimeout(100);
  }
  const bVisible = bRemounted
    ? await tab.evaluate(() => {
        const el = document.getElementById('smartblocker-overlay');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility === 'visible';
      })
    : false;
  check(bRemounted && bVisible, 'page el.remove() on the overlay re-mounts within ~1s, still visible');

  // ── (c) #4: pre-emptive CSS hide must stay inert ──────────────────────
  await tab.goto(blockUrl('css'));
  const cMounted = await waitForOverlay(tab);
  check(cMounted, 'setup: blocklist keyword mounts the block screen (css page)');
  const cStyle = await tab.evaluate(() => {
    const el = document.getElementById('smartblocker-overlay');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex };
  });
  const cOk =
    !!cStyle &&
    cStyle.display === 'flex' &&
    cStyle.visibility === 'visible' &&
    cStyle.opacity === '1';
  check(cOk, `pre-emptive #smartblocker-overlay{display:none!important} is inert (computed ${JSON.stringify(cStyle)})`);

  // Final storage audit across all three attacks: still nothing recorded.
  const finalState = await sw.evaluate(() => chrome.storage.local.get(['overrides', 'feedback']));
  const finalFp = (finalState.feedback ?? []).filter((r) => r.kind === 'false_positive');
  check(
    (finalState.overrides ?? []).length === 0 && finalFp.length === 0,
    'storage audit after all attacks: overrides empty, zero false_positive feedback records',
  );

  // Leave the dedicated profile clean for the next run.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, blocklist: [] } });
    await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'historyScan', 'lockState']);
  });
} finally {
  await context.close();
}
if (failures) process.exitCode = 1;
console.log(failures ? `BLOCKSCREEN SECURITY: ${failures} FAILED` : 'BLOCKSCREEN SECURITY: ALL PASSED');
