// P1 hardening e2e (red-team 2026-11 #14 overrides scoping/normalization and
// #16 sanitizer mask hardening). Loads dist/chrome into a real Chromium the
// same way e2e-test.mjs does — run AFTER `npm run build:chrome`.
// Usage: node scripts/e2e-p1-overrides-sanitizer.mjs
// Profile (and the cached model) persists in .e2e-profile-p1/ across runs; the
// first run downloads the bge model (~35MB) while the harness page classifies.
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-p1');
const HARNESS_TIMEOUT_MS = 5 * 60_000; // first run downloads the model (~35MB)

// Chromium caches the MV3 service-worker SCRIPT in the profile and can keep
// serving a stale background.js after a rebuild. Drop only ScriptCache —
// CacheStorage (the downloaded model) must survive across runs.
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

// Same retry pattern as e2e-test.mjs: launching immediately after a previous
// run sometimes yields a context where the extension never loads.
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
    // MV3 SWs are lazy; a real navigation fires webNavigation.onCommitted,
    // which the blocker listens to, forcing the SW to start.
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
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // Unique-per-run titles so the title/verdict caches of the persistent
  // profile can never leak a verdict between runs.
  const RUN = Date.now().toString(36);
  // Blocklist keyword carried in the URL query, so a page blocks
  // deterministically (inferMs 0, no classifier) unless an override releases it.
  const KW = `sb-p1-kw-${RUN}`;

  // Reset user-correction/lock state that leaks across runs of the persistent
  // profile, then install the deterministic blocklist. Raw storage writes on
  // purpose: we're seeding state, deliberately going around the setSettings
  // guard (same pattern as e2e-test.mjs).
  await sw.evaluate(() => chrome.storage.local.remove(['overrides', 'feedback', 'lockState']));
  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [kw] } });
  }, KW);

  // Fake pages via network interception so webNavigation + title events fire
  // for real-looking URLs (same technique as e2e-test.mjs).
  await context.route('**://www.youtube.com/watch**', (route) => {
    const u = new URL(route.request().url());
    const t = decodeURIComponent(u.searchParams.get('t') ?? 'YouTube');
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>${t} - YouTube</title></head><body><h1>${t}</h1></body></html>`,
    });
  });
  await context.route('**://videos.example.net/watch**', (route) => {
    const u = new URL(route.request().url());
    const t = decodeURIComponent(u.searchParams.get('t') ?? 'Example Videos');
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1></body></html>`,
    });
  });
  // Sanitizer harness: an embedded iframe whose src contains the blocklist
  // keyword gets masked instantly (no classifier in the loop), which is what
  // every #16 assertion below builds on. The page itself must stay unblocked.
  const harnessHtml = `<!doctype html><html><head><title>SmartBlocker sanitizer P1 fixture documentation</title></head><body>
    <h1>Sanitizer hardening fixture</h1>
    <div id="embed-wrap" class="video-container">
      <iframe id="p1-embed" title="kw embed" src="https://media.example.org/embed?x=${KW}"></iframe>
    </div>
  </body></html>`;
  await context.route('**://sb-harness.example.net/**', (route) => {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: harnessHtml });
  });
  await context.route('**://media.example.org/**', (route) => {
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>embed</title></head><body></body></html>',
    });
  });

  await new Promise((r) => setTimeout(r, 500)); // let storage onChanged fire

  const page = await context.newPage();

  // ── #14 (1): a legacy title-only override (stored pre-scoping, no `host`
  // field) must still pass its title. ────────────────────────────────────────
  const t1 = `Legacy override fixture ${RUN}`;
  await sw.evaluate(async (title) => {
    await chrome.storage.local.set({ overrides: [{ title, ts: Date.now() }] });
  }, t1);
  await page.goto(
    `https://www.youtube.com/watch?v=p1a&kw=${KW}&t=${encodeURIComponent(t1)}`,
  );
  await page.waitForTimeout(4_000); // give a wrong block time to appear (blocklist path is instant)
  const legacyOverlay = await page.locator('#smartblocker-overlay').count();
  check('#14 legacy title-only override still passes its title', legacyOverlay === 0);

  // ── #14 (2): a freshly stored override is hostname-scoped — the same title
  // on a DIFFERENT host must still block. ────────────────────────────────────
  const t2 = `Scoped override fixture ${RUN}`;
  await sw.evaluate(async (title) => {
    await chrome.storage.local.set({ overrides: [{ title, host: 'youtube.com', ts: Date.now() }] });
  }, t2);
  await page.goto('about:blank');
  await page.goto(
    `https://www.youtube.com/watch?v=p1b&kw=${KW}&t=${encodeURIComponent(t2)}`,
  );
  await page.waitForTimeout(4_000);
  const sameHostOverlay = await page.locator('#smartblocker-overlay').count();
  check('#14 host-scoped override passes its title on its own host', sameHostOverlay === 0);

  await page.goto('about:blank');
  await page.goto(
    `https://videos.example.net/watch?v=p1b&kw=${KW}&t=${encodeURIComponent(t2)}`,
  );
  let crossHostBlocked = false;
  try {
    await page.waitForSelector('#smartblocker-overlay', { timeout: 8_000 });
    crossHostBlocked = true;
  } catch {}
  check('#14 scoped override does NOT apply — same title on a different host still blocks', crossHostBlocked);

  // ── #14 (3): a zero-width/fullwidth variant of an overridden title must
  // still match on the SAME host (Cf strip + NFKC + whitespace collapse). ────
  const t2Variant =
    `\uFF33coped\u200B override\u00A0fixture ${RUN}`; // fullwidth S + ZWSP + NBSP
  await page.goto('about:blank');
  await page.goto(
    `https://www.youtube.com/watch?v=p1c&kw=${KW}&t=${encodeURIComponent(t2Variant)}`,
  );
  await page.waitForTimeout(4_000);
  const zwspOverlay = await page.locator('#smartblocker-overlay').count();
  check('#14 zero-width/homoglyph title variant still matches the override on the same host', zwspOverlay === 0);

  // ── #16: sanitizer mask hardening on the harness page. The kw-carrying
  // iframe is masked synchronously once the (unblocked) page verdict lands
  // and the sanitizer is injected. ───────────────────────────────────────────
  await page.goto('about:blank');
  await page.goto('https://sb-harness.example.net/');
  let embedMasked = false;
  try {
    await page.waitForFunction(
      () => document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') === 'embed',
      { timeout: HARNESS_TIMEOUT_MS },
    );
    embedMasked = true;
  } catch {}
  check('#16 blocklisted embed is masked on the harness page', embedMasked);

  if (embedMasked) {
    // #16 (4): synthetic clicks on the reveal button must NOT reveal the mask.
    const synth = await page.evaluate(() => {
      const wrap = document.getElementById('embed-wrap');
      const btn = wrap.querySelector('.smartblocker-mask-reveal');
      if (btn) btn.click(); // untrusted synthetic click
      return {
        hadButton: !!btn,
        state: wrap.getAttribute('data-smartblocker-masked'),
        src: document.getElementById('p1-embed')?.getAttribute('src'),
      };
    });
    check(
      '#16 synthetic btn.click() does NOT reveal the mask (isTrusted)',
      synth.hadButton && synth.state === 'embed' && synth.src === 'about:blank',
      JSON.stringify(synth),
    );

    // #16 (4b): an attribute mutation that points the blanked iframe back at
    // the media URL must be re-blanked on the next scan (attribute observer).
    await page.evaluate((kw) => {
      document
        .getElementById('p1-embed')
        ?.setAttribute('src', `https://media.example.org/embed?x=${kw}&again=1`);
    }, KW);
    let reblanked = false;
    try {
      await page.waitForFunction(
        () =>
          document.getElementById('p1-embed')?.getAttribute('src') === 'about:blank' &&
          document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') === 'embed',
        { timeout: 5_000 },
      );
      reblanked = true;
    } catch {}
    check('#16 src attribute mutation on a masked embed is re-blanked on the next scan', reblanked);

    // #16 (5): deleting the injected mask stylesheet must be undone by the
    // next scan's cheap re-ensure.
    await page.evaluate(() => {
      document.getElementById('smartblocker-mask-style')?.remove();
    });
    let styleReadded = false;
    try {
      await page.waitForFunction(
        () => (document.getElementById('smartblocker-mask-style')?.textContent ?? '').length > 500,
        { timeout: 5_000 },
      );
      styleReadded = true;
    } catch {}
    check('#16 mask style node is re-ensured after the page deletes it', styleReadded);

    // Regression check for the memory-stash rework (#16d): a TRUSTED click on
    // Show must still reveal and restore the original src from isolated-world
    // memory (data-sb-orig-* attributes no longer exist).
    await page.locator('#embed-wrap .smartblocker-mask-reveal').click();
    let revealed = false;
    try {
      await page.waitForFunction(
        () => document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') === 'revealed',
        { timeout: 5_000 },
      );
      revealed = true;
    } catch {}
    const restored = await page.evaluate(() => ({
      state: document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked'),
      src: document.getElementById('p1-embed')?.getAttribute('src') ?? '',
      origAttrs: document.getElementById('p1-embed')?.hasAttribute('data-sb-orig-src') ?? true,
    }));
    check(
      '#16 trusted Show reveals and restores the original src from memory',
      revealed && restored.state === 'revealed' && restored.src.includes('media.example.org') && !restored.origAttrs,
      JSON.stringify(restored),
    );
  }

  // Restore state so the next run (and other e2e scripts sharing the machine)
  // starts clean.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [] } });
    await chrome.storage.local.remove('overrides');
  });
} finally {
  await context.close();
}
console.log(process.exitCode ? 'E2E-P1: FAILED' : 'E2E-P1: ALL PASSED');
