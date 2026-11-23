// Hard warm-up for the nightly lane: loads the built extension in Chromium,
// runs the real classifier once, and exits non-zero if that fails. The
// workflow runs this BEFORE the e2e chain so the warm-model cache can never be
// saved from a run that failed before the model was downloaded (a poisoned
// cache hit would then keep every later nightly cold).
//
//   npm run build:chrome && node scripts/warm-model-cache.mjs
//
// Profile: .e2e-profile (override with SB_E2E_PROFILE), same as e2e-test.
import { chromium } from 'playwright';
import { readlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(process.env.SB_E2E_PROFILE ?? '.e2e-profile');
const MODEL_TIMEOUT_MS = 8 * 60_000;

rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });
rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });

function clearStaleSingleton(dir) {
  const lock = resolve(dir, 'SingletonLock');
  try {
    const target = readlinkSync(lock);
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
      return;
    } catch {
      // dead owner
    }
    rmSync(lock, { force: true });
    rmSync(resolve(dir, 'SingletonCookie'), { force: true });
    rmSync(resolve(dir, 'SingletonSocket'), { force: true });
  } catch {
    // no lock
  }
}

async function launch() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    clearStaleSingleton(PROFILE);
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      timeout: 60_000,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) {
      const event = ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      sw = ctx.serviceWorkers()[0] ?? (await event);
      await waker.close();
    }
    if (sw) return { ctx, sw };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('service worker did not boot; refusing to save a cold cache');
}

const { ctx, sw } = await launch();
try {
  sw.on('console', (msg) => {
    const text = msg.text();
    if (/centroids|Model|download|error/i.test(text)) console.log('  [sw]', text);
  });
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options.html#advanced`);
  // The options bundle can take a moment to mount on a loaded machine; clicking
  // before the diagnostics card exists surfaced as a bare Playwright timeout.
  await page.waitForSelector('#test-pair', { timeout: 60_000 });
  await page.click('#test-pair');
  console.log('… waiting for the production classifier (first run downloads the model)');
  await page.waitForFunction(
    () => {
      const text = document.getElementById('out')?.textContent ?? '';
      return text.includes('->') || text.startsWith('Error');
    },
    undefined,
    { timeout: MODEL_TIMEOUT_MS },
  );
  const out = (await page.locator('#out').textContent()) ?? '';
  if (out.startsWith('Error')) {
    throw new Error(`classifier warm-up failed: ${out.slice(0, 300)}`);
  }
  // Prove the model cache is actually populated before the workflow can save it.
  const cached = await sw.evaluate(async () => {
    try {
      const names = await caches.keys();
      let entries = 0;
      for (const name of names.filter((n) => n.includes('transformers'))) {
        entries += (await (await caches.open(name)).keys()).length;
      }
      return entries;
    } catch {
      return -1;
    }
  });
  if (cached === 0) throw new Error('model CacheStorage is empty after classification');
  console.log(`PASS warm model cache (${cached} cached model entries)`);
} finally {
  await ctx.close();
}
