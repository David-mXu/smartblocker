// P1 hardening e2e (red-team 2026-11 #14 overrides scoping/normalization and
// #16 sanitizer mask hardening). Loads dist/chrome into a real Chromium the
// same way e2e-test.mjs does — run AFTER `npm run build:chrome`.
// Usage: node scripts/e2e-p1-overrides-sanitizer.mjs
// Profile (and the cached model) persists in .e2e-profile-p1/ across runs; the
// first run downloads the bge model (~35MB) while the harness page classifies.
import { chromium } from 'playwright';
import { readlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-p1');
const HARNESS_TIMEOUT_MS = 5 * 60_000; // first run downloads the model (~35MB)

// Chromium caches the MV3 service-worker SCRIPT in the profile and can keep
// serving a stale background.js after a rebuild. Drop only ScriptCache —
// CacheStorage (the downloaded model) must survive across runs.
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });
// A killed Chromium can leave a broken SW registration; drop the
// registration DB too (CacheStorage = the model stays).
rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });

// Same retry pattern as e2e-test.mjs: launching immediately after a previous
// run sometimes yields a context where the extension never loads.

// A killed/mid-crash run leaves Chromium's ProcessSingleton symlink behind and
// the next launch dies instantly ("Failed to create a ProcessSingleton"). Clear
// it only when the recorded pid is gone, so a genuinely running instance is
// never disturbed.
function clearStaleSingleton(dir) {
  const lock = resolve(dir, 'SingletonLock');
  try {
    const target = readlinkSync(lock);
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
      return; // still alive — leave it alone
    } catch {
      // ESRCH: dead owner
    }
    rmSync(lock, { force: true });
    rmSync(resolve(dir, 'SingletonCookie'), { force: true });
    rmSync(resolve(dir, 'SingletonSocket'), { force: true });
    console.log('… cleared a stale profile SingletonLock');
  } catch {
    // no lock / unreadable — nothing to do
  }
}

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    clearStaleSingleton(PROFILE);
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      // A hung profile (a zombie browser from an earlier killed run) can make
      // launch wait forever; fail fast so the retry can repair the profile.
      timeout: 60_000,
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
    // A killed Chromium can leave a BROKEN service-worker registration in the
    // profile: every later launch loads no SW at all. Drop the registration
    // database (ScriptCache alone is not enough) but KEEP CacheStorage — that
    // is the downloaded model.
    rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });
    rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });
    // A killed Chromium can leave a broken SW registration; drop the
    // registration DB too (CacheStorage = the model stays).
    rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });
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

  // Reveal-forgery fixture A: the content server-renders its own distraction
  // pre-marked as already revealed. With reveal authority in the DOM attribute
  // (the old bug) the sanitizer would skip this container forever; with
  // authority in the isolated-world WeakSet it must mask it like any other.
  const forgedRevealHtml = `<!doctype html><html><head><title>SmartBlocker reveal forgery fixture documentation</title></head><body>
    <h1>Reveal forgery fixture</h1>
    <div id="forged-wrap" class="video-container" data-smartblocker-masked="revealed">
      <iframe id="forged-embed" title="kw embed" src="https://media.example.org/embed?x=${KW}"></iframe>
    </div>
  </body></html>`;
  await context.route('**://sb-reveal.example.net/**', (route) => {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: forgedRevealHtml });
  });

  // Reveal-forgery fixture B: the same forged markup, plus a hostile script
  // that waits for our mask and then fights back ONCE: re-forges the reveal
  // marker and points the blanked iframe back at the media URL. The attribute
  // observer must catch both mutations and the next scan must re-mask (the
  // forged "revealed" has no record in the isolated-world set). One-shot on
  // purpose so the assertion has a deterministic settled state.
  const forgedRevealResistHtml = `<!doctype html><html><head><title>SmartBlocker reveal forgery resistance fixture documentation</title></head><body>
    <h1>Reveal forgery resistance fixture</h1>
    <div id="tamper-wrap" class="video-container" data-smartblocker-masked="revealed">
      <iframe id="tamper-embed" title="kw embed" src="https://media.example.org/embed?x=${KW}"></iframe>
    </div>
    <script>
      (function () {
        var tampered = false;
        new MutationObserver(function () {
          if (tampered) return;
          var w = document.getElementById('tamper-wrap');
          if (!w) return;
          if (w.getAttribute('data-smartblocker-masked') === 'embed') {
            tampered = true;
            w.setAttribute('data-smartblocker-masked', 'revealed');
            document
              .getElementById('tamper-embed')
              .setAttribute('src', 'https://media.example.org/embed?x=${KW}&revived=1');
          }
        }).observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-smartblocker-masked'],
        });
      })();
    </script>
  </body></html>`;
  await context.route('**://sb-resist.example.net/**', (route) => {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: forgedRevealResistHtml });
  });

  // State-forgery fixture: the page pre-tags its embed with our state/id
  // attributes. Before 2026-11-21 those page-writable attributes were trusted
  // as "already handled", so the embed was never classified or masked (the
  // whole embed guard could be bypassed with two attributes). Authority now
  // lives in isolated-world memory; the forged markers must be ignored.
  const forgedStateHtml = `<!doctype html><html><head><title>SmartBlocker state forgery fixture documentation</title></head><body>
    <h1>State forgery fixture</h1>
    <div id="state-wrap" class="video-container" data-smartblocker-state="forged" data-smartblocker-id="sb-embed-1">
      <iframe id="state-embed" title="kw embed" src="https://media.example.org/embed?x=${KW}"></iframe>
    </div>
  </body></html>`;
  await context.route('**://sb-state.example.net/**', (route) => {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: forgedStateHtml });
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

  // ── Override friction tiers (2026-11-21 P0): the 10-second pause must hold
  // the release without typing, never fire early, and record the correction
  // only after the user clicks the enabled button.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, surrenderMode: 'pause' } });
  });
  const pauseTitle = `Pause tier fixture ${RUN}`;
  const pauseUrl =
    `https://videos.example.net/watch?v=p1pause&kw=${KW}&t=${encodeURIComponent(pauseTitle)}`;
  await page.goto('about:blank');
  await page.goto(pauseUrl);
  await page.waitForSelector('#smartblocker-overlay', { timeout: 20_000 });
  const overridesBeforePause = await sw.evaluate(async () => {
    const { overrides = [] } = await chrome.storage.local.get('overrides');
    return overrides.length;
  });
  await page.locator('#smartblocker-overlay button', { hasText: 'actually productive' }).click();
  const pauseWall = await page
    .waitForSelector('#smartblocker-pause-wall', { timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  const pauseOpenDisabled = await page
    .locator('#smartblocker-pause-open')
    .isDisabled()
    .catch(() => null);
  check(
    'surrenderMode=pause shows the cool-down wall with the release button disabled',
    pauseWall && pauseOpenDisabled === true,
    JSON.stringify({ pauseWall, pauseOpenDisabled }),
  );
  // Early synthetic activation must be inert (isTrusted + deadline).
  await page.evaluate(() => {
    document.getElementById('smartblocker-overlay')?.shadowRoot
      ?.querySelector('#smartblocker-pause-open')
      ?.click();
  });
  const stillBlockedEarly = await page.locator('#smartblocker-overlay').count();
  const overridesDuringPause = await sw.evaluate(async () => {
    const { overrides = [] } = await chrome.storage.local.get('overrides');
    return overrides.length;
  });
  check(
    'the pause tier neither releases nor records an override early',
    stillBlockedEarly === 1 && overridesDuringPause === overridesBeforePause,
    JSON.stringify({ stillBlockedEarly, overridesBeforePause, overridesDuringPause }),
  );
  let pauseEnabled = false;
  try {
    await page.waitForFunction(
      () => {
        const host = document.getElementById('smartblocker-overlay');
        const btn = host?.shadowRoot?.querySelector('#smartblocker-pause-open');
        return btn instanceof HTMLElement && !btn.hasAttribute('disabled');
      },
      undefined,
      { timeout: 15_000 },
    );
    pauseEnabled = true;
  } catch {}
  check('the cool-down ends after ~10 seconds', pauseEnabled);
  if (pauseEnabled) {
    await page.locator('#smartblocker-pause-open').click();
    let released = false;
    try {
      await page.waitForFunction(
        () => !document.getElementById('smartblocker-overlay'),
        undefined,
        { timeout: 5_000 },
      );
      released = true;
    } catch {}
    const overridesAfterPause = await sw.evaluate(async (title) => {
      const { overrides = [] } = await chrome.storage.local.get('overrides');
      return overrides.some((record) => String(record.title).includes(title.split(' ')[0]));
    }, pauseTitle);
    check(
      'the pause tier releases the page and records the correction',
      released && overridesAfterPause === true,
      JSON.stringify({ released, overridesAfterPause }),
    );
  }
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, surrenderMode: 'off' } });
  });

  // ── #16: sanitizer mask hardening on the harness page. The kw-carrying
  // iframe is masked synchronously once the (unblocked) page verdict lands
  // and the sanitizer is injected. ───────────────────────────────────────────
  await page.goto('about:blank');
  await page.goto('https://sb-harness.example.net/');
  let embedMasked = false;
  let harnessWaitError = null;
  try {
    // NOTE: options must be the THIRD argument — waitForFunction(fn, arg,
    // options). Passing them as `arg` silently leaves the default 30s
    // timeout, which once broke a cold-start run (31s centroid rebuild).
    await page.waitForFunction(
      () => document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') === 'embed',
      undefined,
      { timeout: HARNESS_TIMEOUT_MS },
    );
    embedMasked = true;
  } catch (e) {
    harnessWaitError = String(e).slice(0, 300);
  }
  if (!embedMasked) {
    // Fail loudly WITH evidence: what the wait died of, plus the live mask
    // state. This is how the 30s-vs-5min timeout bug was diagnosed.
    const harnessDump = await page
      .evaluate(() => ({
        title: document.title,
        url: location.href,
        wrapAttr: document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') ?? null,
        iframeSrcAttr: document.getElementById('p1-embed')?.getAttribute('src') ?? null,
        styleLen: (document.getElementById('smartblocker-mask-style')?.textContent ?? '').length,
        bars: document.querySelectorAll('.smartblocker-mask-bar').length,
      }))
      .catch((e) => ({ err: String(e).slice(0, 200) }));
    console.log('  [harness-fail] wait error:', harnessWaitError);
    console.log('  [harness-fail] state:', JSON.stringify(harnessDump));
  }
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
        undefined,
        { timeout: 5_000 },
      );
      reblanked = true;
    } catch {}
    check('#16 src attribute mutation on a masked embed is re-blanked on the next scan', reblanked);

    // #16 (4c): stripping the mask ATTRIBUTE must not un-mask forever. The
    // isolated-world set still records the element, but authority requires the
    // render hint too, so the next scan re-applies the mask (a page cannot
    // reveal itself by deleting our attribute).
    await page.evaluate(() => {
      document.getElementById('embed-wrap')?.removeAttribute('data-smartblocker-masked');
    });
    let restoredMask = false;
    try {
      await page.waitForFunction(
        () => document.getElementById('embed-wrap')?.getAttribute('data-smartblocker-masked') === 'embed',
        undefined,
        { timeout: 5_000 },
      );
      restoredMask = true;
    } catch {}
    check('#16 stripping the mask attribute is re-masked on the next scan', restoredMask);

    // #16 (5): deleting the injected mask stylesheet must be undone by the
    // next scan's cheap re-ensure.
    await page.evaluate(() => {
      document.getElementById('smartblocker-mask-style')?.remove();
    });
    let styleReadded = false;
    try {
      await page.waitForFunction(
        () => (document.getElementById('smartblocker-mask-style')?.textContent ?? '').length > 500,
        undefined,
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
        undefined,
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


  // ── state/id forgery: page-written "already handled" markers are ignored ──
  await page.goto('about:blank');
  await page.goto('https://sb-state.example.net/');
  let stateForgeryMasked = false;
  try {
    await page.waitForFunction(
      () => document.getElementById('state-wrap')?.getAttribute('data-smartblocker-masked') === 'embed',
      undefined,
      { timeout: HARNESS_TIMEOUT_MS },
    );
    stateForgeryMasked = true;
  } catch {}
  check(
    'page-forged data-smartblocker-state/id do not bypass embed classification',
    stateForgeryMasked,
  );

  // ── #16e: reveal authority must live in the isolated world, not in the
  // page-writable data-smartblocker-masked="revealed" attribute. ──────────────
  // Fixture A: server-rendered forged reveal. A page (or a third-party embed
  // inside an allowed host) that pre-marks its own distraction "revealed" must
  // STILL be masked — the old code checked the attribute and skipped forever.
  await page.goto('about:blank');
  await page.goto('https://sb-reveal.example.net/');
  let forgedStillMasked = false;
  try {
    await page.waitForFunction(
      () =>
        document.getElementById('forged-wrap')?.getAttribute('data-smartblocker-masked') === 'embed' &&
        document.getElementById('forged-embed')?.getAttribute('src') === 'about:blank',
      undefined,
      { timeout: HARNESS_TIMEOUT_MS },
    );
    forgedStillMasked = true;
  } catch {}
  check(
    '#16e server-rendered data-smartblocker-masked="revealed" does not bypass masking',
    forgedStillMasked,
  );

  // Fixture B: same forging, plus a hostile script that re-forges the marker
  // and points the blanked iframe back at the media right after we mask. The
  // attribute observer must trigger a re-scan that re-masks — a forged
  // "revealed" (no record in the isolated-world set) never sticks.
  if (forgedStillMasked) {
    await page.goto('about:blank');
    await page.goto('https://sb-resist.example.net/');
    let tamperSeen = false;
    try {
      // Stage 1: the hostile script fires (mask seen → forge + re-point).
      await page.waitForFunction(
        () =>
          document.getElementById('tamper-wrap')?.getAttribute('data-smartblocker-masked') === 'revealed' &&
          (document.getElementById('tamper-embed')?.getAttribute('src') ?? '').includes('revived=1'),
        undefined,
        { timeout: 10_000 },
      );
      tamperSeen = true;
    } catch {}
    check('#16e hostile tamper observed (forged reveal + iframe re-point)', tamperSeen);

    let remasked = false;
    try {
      // Stage 2: sanitizer wins — forged marker stripped, embed re-masked and
      // re-blanked on the observer-triggered re-scan.
      await page.waitForFunction(
        () =>
          document.getElementById('tamper-wrap')?.getAttribute('data-smartblocker-masked') === 'embed' &&
          document.getElementById('tamper-embed')?.getAttribute('src') === 'about:blank',
        undefined,
        { timeout: 8_000 },
      );
      remasked = true;
    } catch {}
    check('#16e forged reveal + iframe re-point is re-masked on the next scan', remasked);

    if (remasked) {
      // Stage 3: after all that hostility, a TRUSTED user click on the mask
      // bar must still reveal and restore the FIRST-seen src (keep-first
      // stash), not the tamper's `revived=1` URL.
      await page.locator('#tamper-wrap .smartblocker-mask-reveal').click();
      let userRevealWorked = false;
      const afterReveal = await page
        .waitForFunction(
          () => {
            const src = document.getElementById('tamper-embed')?.getAttribute('src') ?? '';
            return (
              document.getElementById('tamper-wrap')?.getAttribute('data-smartblocker-masked') === 'revealed' &&
              src.includes('media.example.org') &&
              !src.includes('revived=1')
            );
          },
          undefined,
          { timeout: 5_000 },
        )
        .then(() => page.evaluate(() => ({
          state: document.getElementById('tamper-wrap')?.getAttribute('data-smartblocker-masked'),
          src: document.getElementById('tamper-embed')?.getAttribute('src') ?? '',
        })))
        .catch(() => null);
      userRevealWorked =
        !!afterReveal &&
        afterReveal.state === 'revealed' &&
        afterReveal.src.includes('media.example.org') &&
        !afterReveal.src.includes('revived=1');
      check(
        '#16e trusted Show still reveals after tampering and restores the first-seen src',
        userRevealWorked,
        JSON.stringify(afterReveal),
      );

      if (userRevealWorked) {
        // Stage 4: the genuine reveal must survive rescans — trigger one via a
        // childList mutation and confirm the element is neither re-masked nor
        // its media re-blanked.
        await page.evaluate(() => {
          document.body.appendChild(document.createElement('div'));
        });
        let revealSurvived = false;
        try {
          await page.waitForFunction(
            () => {
              const src = document.getElementById('tamper-embed')?.getAttribute('src') ?? '';
              return (
                document.getElementById('tamper-wrap')?.getAttribute('data-smartblocker-masked') === 'revealed' &&
                src.includes('media.example.org')
              );
            },
            undefined,
            { timeout: 2_000 },
          );
          revealSurvived = true;
        } catch {}
        check('#16e genuine user reveal survives a post-reveal rescan', revealSurvived);
      }
    }
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
