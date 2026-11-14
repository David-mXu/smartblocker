// Focused regression: STALE-ALLOW verdict race in blocker.ts onTitle.
// arm() frees the in-flight key, so when page A's classification is slow the
// tab can navigate to page B, which blocks; A's ALLOW verdict then resolved in
// the background and its else-branch side effects (clearCurtain/clearOverlay/
// clearForceRedirectRule) tore down B's fresh block screen. The navGeneration/
// armedUrl guard ("stillCurrentPage") must skip those side effects for stale
// verdicts, and the popup recordTabStatus must keep reporting B.
//
// Deterministic slow-window WITHOUT test hooks: storage.local titleCache +
// centroidCache are cleared up front so A's first classify pays the full
// centroid rebuild (~2.5s) — B is navigated to inside that window.
//
// Usage: npm run build:chrome && node scripts/e2e-stale-allow-race.mjs
// Shares .e2e-profile with e2e-test.mjs (warm model cache expected; a cold
// profile first downloads the model). SB_E2E_PROFILE isolates a fresh profile.
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(process.env.SB_E2E_PROFILE ?? '.e2e-profile');
const A_TITLE = 'React Router Tutorial for Beginners';
const B_KEYWORD = 'sb-race-block';
const B_URL = `https://games.arcade.example/play?mark=${B_KEYWORD}`;

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

const { context, sw } = await launchWithServiceWorker();
try {
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // Slow-A setup + deterministic B rule. Raw storage writes on purpose:
  // we're seeding state, deliberately going around the setSettings guard.
  await sw.evaluate(async (kw) => {
    await chrome.storage.local.remove([
      'titleCache', 'centroidCache', 'overrides', 'feedback', 'latencySamples', 'lockState',
    ]);
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [kw] } });
  }, B_KEYWORD);

  await context.route('**://docs.devnotes.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>${A_TITLE}</title></head>` +
        `<body><h1>${A_TITLE}</h1><p>Routing concepts for React applications.</p></body></html>`,
    }),
  );
  await context.route('**://games.arcade.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Blocklist Race Target</title></head>` +
        `<body><h1>Blocklist Race Target</h1></body></html>`,
    }),
  );

  // Navigate to A (slow ALLOW in flight — centroid rebuild window), then swap
  // the SAME tab to B: a deterministic blocklist hit that blocks instantly.
  const tab = await context.newPage();
  await tab.goto('https://docs.devnotes.example/guide/react-router');
  await tab.waitForTimeout(300); // inside the rebuild window
  await tab.goto(B_URL);

  await tab.waitForSelector('#smartblocker-overlay', { timeout: 20_000 });
  console.log('PASS page B block screen present right after navigation');

  // Wait until A's ALLOW verdict actually resolved (logSample fires after the
  // else-branch side effects), then give any would-be teardown time to run.
  const deadline = Date.now() + 45_000;
  let aResolved = false;
  while (Date.now() < deadline) {
    aResolved = await sw.evaluate(
      (t) =>
        (chrome.storage.local.get('latencySamples')).then(({ latencySamples = [] }) =>
          latencySamples.some((s) => s.title === t && !s.blocked)),
      A_TITLE,
    );
    if (aResolved) break;
    await tab.waitForTimeout(500);
  }
  console.log(`${aResolved ? 'PASS' : 'FAIL'} page A verdict resolved (allow recorded)`);
  if (!aResolved) process.exitCode = 1;
  await tab.waitForTimeout(800);

  const survived = await tab.evaluate(() => {
    const host = document.getElementById('smartblocker-overlay');
    return {
      present: !!host,
      text: host?.shadowRoot?.textContent ?? '',
    };
  });
  const stillBlocked = survived.present && /This one can wait\./.test(survived.text);
  console.log(
    `${stillBlocked ? 'PASS' : 'FAIL'} stale ALLOW for page A did NOT tear down B's block screen`,
  );
  if (!stillBlocked) {
    console.log('  overlay state:', JSON.stringify(survived));
    process.exitCode = 1;
  }

  // Popup "This page" record: B's blocked-rule verdict must be the last one
  // for this tab — A's stale verdict must not overwrite the popup status.
  const statuses = await sw.evaluate(async (u) => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('tabStatus:'))
      .map(([, v]) => v)
      .filter((v) => v.url === u);
  }, B_URL);
  const bStatus = statuses.at(-1);
  const statusOk = !!bStatus && bStatus.kind === 'blocked-rule' && bStatus.rule === B_KEYWORD;
  console.log(
    `${statusOk ? 'PASS' : 'FAIL'} popup tab status still reports B as blocked-rule`,
    `(kind=${bStatus?.kind}, rule=${bStatus?.rule})`,
  );
  if (!statusOk) process.exitCode = 1;
} finally {
  await context.close();
}
console.log(process.exitCode ? 'E2E: FAILED' : 'E2E: ALL PASSED');
