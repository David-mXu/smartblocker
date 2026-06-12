// Loads dist/chrome into a real Chromium and exercises the POC end-to-end:
// service worker boots, model downloads/loads, popup Test Pair classifies.
// Usage: node scripts/e2e-test.mjs
// Profile (and the cached model) persists in .e2e-profile/ across runs.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile');
const MODEL_TIMEOUT_MS = 5 * 60_000; // first run downloads ~70MB

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
  ],
});

try {
  // 1. Service worker must boot (this alone proves the ES-module bundle parses).
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;

  // Surface background console output (download progress, classifications).
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // 2. Popup loads and Test Pair round-trips through the SW + model.
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [popup:error]', msg.text());
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.click('#test-pair');
  console.log('… waiting for classification (first run downloads the model)');

  await page.waitForFunction(
    () => {
      const t = document.getElementById('out')?.textContent ?? '';
      return t.includes('->') || t.startsWith('Error');
    },
    { timeout: MODEL_TIMEOUT_MS },
  );
  const out = await page.locator('#out').textContent();
  console.log('--- popup output ---\n' + out + '\n--------------------');

  if (out.startsWith('Error')) {
    console.log('FAIL Test Pair returned an error');
    process.exitCode = 1;
  } else {
    const reactOk = /"React Router Tutorial"\n-> programming/.test(out);
    const mcOk = /"I spent 100 days in Hardcore Minecraft"\n-> video games/.test(out);
    console.log(`${reactOk ? 'PASS' : 'FAIL'} React Router Tutorial -> programming`);
    console.log(`${mcOk ? 'PASS' : 'FAIL'} Minecraft title -> video games`);
    if (!reactOk || !mcOk) process.exitCode = 1;
  }

  // 3. Cache check: the Transformers.js model cache must exist in the SW.
  const cacheNames = await sw.evaluate(() => caches.keys());
  const cached = cacheNames.some((n) => n.includes('transformers'));
  console.log(`${cached ? 'PASS' : 'FAIL'} model cache present:`, cacheNames);
  if (!cached) process.exitCode = 1;

  // 4. Live blocker: serve fake YouTube watch pages via network interception
  // so webNavigation + title events fire for a real youtube.com URL.
  const fakeWatch = (title) =>
    `<!doctype html><html><head><title>${title} - YouTube</title></head>` +
    `<body><h1>${title}</h1></body></html>`;
  await context.route('**://www.youtube.com/**', (route) => {
    const u = new URL(route.request().url());
    route.fulfill({
      contentType: 'text/html',
      body: fakeWatch(decodeURIComponent(u.searchParams.get('t') ?? 'YouTube')),
    });
  });

  const tab = await context.newPage();
  await tab.goto(
    'https://www.youtube.com/watch?v=x&t=' +
      encodeURIComponent('I spent 100 days in Hardcore Minecraft'),
  );
  let overlayVisible = false;
  try {
    await tab.waitForSelector('#flowguard-overlay', { timeout: 20_000 });
    overlayVisible = true;
  } catch {}
  console.log(`${overlayVisible ? 'PASS' : 'FAIL'} gaming title gets block overlay`);
  if (!overlayVisible) process.exitCode = 1;

  await tab.goto(
    'https://www.youtube.com/watch?v=y&t=' + encodeURIComponent('React Router Tutorial'),
  );
  await tab.waitForTimeout(8_000); // give a wrong block time to appear
  const wronglyBlocked = await tab.locator('#flowguard-overlay').count();
  console.log(`${wronglyBlocked === 0 ? 'PASS' : 'FAIL'} programming title is NOT blocked`);
  if (wronglyBlocked > 0) process.exitCode = 1;

  // Fresh title (not in the title cache) — measures real warm inference
  // latency through the whole blocker path.
  await tab.goto(
    'https://www.youtube.com/watch?v=z&t=' + encodeURIComponent('speedrunning Dark Souls'),
  );
  let freshBlocked = false;
  try {
    await tab.waitForSelector('#flowguard-overlay', { timeout: 30_000 });
    freshBlocked = true;
  } catch {}
  console.log(`${freshBlocked ? 'PASS' : 'FAIL'} uncached gaming title gets block overlay`);
  if (!freshBlocked) process.exitCode = 1;

  // 5. History scan: the fake-YouTube navigations above are real history
  // entries, so seed a few more and run the ingester end-to-end.
  for (const t of [
    'How the Fed rate decision affects your portfolio',
    'lofi hip hop radio - beats to relax/study to',
    'NBA Finals Game 7 highlights',
  ]) {
    await tab.goto('https://www.youtube.com/watch?v=h&t=' + encodeURIComponent(t));
  }
  await page.bringToFront();
  await page.click('#scan-history');
  await page.waitForFunction(
    () => /Scan (done|error)/.test(document.getElementById('out')?.textContent ?? ''),
    { timeout: 120_000 },
  );
  const scanOut = await page.locator('#out').textContent();
  console.log('--- history scan ---\n' + scanOut + '\n--------------------');
  const scanOk = scanOut.includes('Scan done') && /video games/.test(scanOut);
  console.log(`${scanOk ? 'PASS' : 'FAIL'} history scan completed with categories`);
  if (!scanOk) process.exitCode = 1;

  const { latencySamples = [] } = await sw.evaluate(() =>
    chrome.storage.local.get('latencySamples'),
  );
  console.log('--- latency samples ---');
  for (const s of latencySamples) {
    console.log(
      `  ${s.blocked ? 'BLOCK' : 'allow'} "${s.title}" [${s.label} ${(s.score * 100).toFixed(0)}%] ` +
        `load ${Math.round(s.loadMs)}ms infer ${Math.round(s.inferMs)}ms ` +
        `inject ${Math.round(s.injectMs)}ms total ${Math.round(s.totalMs)}ms${s.cached ? ' (cached)' : ''}`,
    );
  }
} finally {
  await context.close();
}
console.log(process.exitCode ? 'E2E: FAILED' : 'E2E: ALL PASSED');
