// Loads dist/chrome into a real Chromium and exercises the POC end-to-end:
// service worker boots, model downloads/loads, popup Test Pair classifies.
// Usage: node scripts/e2e-test.mjs
// Profile (and the cached model) persists in .e2e-profile/ across runs.
// SB_E2E_PROFILE can select an isolated profile without deleting the usual one.
import { chromium } from 'playwright';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(process.env.SB_E2E_PROFILE ?? '.e2e-profile');
const MODEL_TIMEOUT_MS = 5 * 60_000; // first run downloads the model (~35MB)

// Chromium caches the MV3 service-worker SCRIPT in the profile and can keep
// serving a stale background.js after a rebuild. Drop only ScriptCache —
// CacheStorage (the downloaded model) must survive across runs.
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

// Launching immediately after a previous run sometimes yields a context where
// the extension never loads (no SW ever appears, and navigations can't wake
// what isn't registered) — retry with a fresh launch when that happens.
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

const { context, sw } = await launchWithServiceWorker();

try {
  // 1. Service worker booted (this alone proves the ES-module bundle parses).
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;

  // Surface background console output (download progress, classifications).
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // Reset user-correction state that leaks across runs of the persistent
  // profile (a prior run's override click would let this run's blocklist page
  // through). The model + title caches deliberately stay warm.
  await sw.evaluate(() =>
    chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'historyScan', 'lockState']),
  );

  // 2. Options → Advanced → Diagnostics: "Test classifier" round-trips
  // through the SW + model. (Diagnostics moved out of the popup in the
  // 2026-11-07 UX overhaul.)
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [options:error]', msg.text());
  });
  await page.goto(`chrome-extension://${extensionId}/options.html#advanced`);
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
  console.log('--- diagnostics output ---\n' + out + '\n--------------------');

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

  // 3b. #32 P3: options page exposes the self-service erasure card, in the
  // honest state for whatever this build's FEEDBACK_ENDPOINT is. Nothing was
  // ever shared from the e2e profile either way, so "no installId" always
  // holds; the button is enabled (and the "not configured" note absent)
  // exactly when an endpoint is configured.
  {
    const configured = /FEEDBACK_ENDPOINT:\s*string\s*=\s*'(https[^']*)'/.test(
      readFileSync(new URL('../src/shared/config.ts', import.meta.url), 'utf8'),
    );
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extensionId}/options.html#privacy`);
    await opts.waitForSelector('text=Your shared feedback data', { timeout: 15_000 });
    const noId = await opts.locator('text=none yet — created the first time you share').count();
    const notConfigured = await opts
      .locator('text=Feedback sharing is not configured in this build')
      .count();
    const deleteBtn = opts.locator('button:has-text("Delete shared data")');
    const btnDisabled = await deleteBtn.isDisabled().catch(() => false);
    const infoOk =
      noId > 0 &&
      (configured ? notConfigured === 0 && !btnDisabled : notConfigured > 0 && btnDisabled);
    console.log(
      `${infoOk ? 'PASS' : 'FAIL'} options self-service erasure card renders honest ${configured ? 'configured' : 'no-endpoint'} state (installId-none: ${noId}, note: ${notConfigured}, btn-disabled: ${btnDisabled})`,
    );
    if (!infoOk) process.exitCode = 1;
    await opts.close();
  }

  // Clear overrides from previous runs so they don't break the blocklist test
  await sw.evaluate(async () => {
    await chrome.storage.local.remove('overrides');
  });

  // oEmbed title resolution is opt-in (default OFF for privacy, finding #9);
  // the SERP/embed sections below exercise the historical oEmbed resolve
  // path, so opt in for this run. Later set() calls preserve the key.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, resolveEmbedTitles: true } });
  });

  // 4. Live blocker: serve fake YouTube watch pages via network interception
  // so webNavigation + title events fire for a real youtube.com URL.
  const fakeWatch = (title) =>
    `<!doctype html><html><head><title>${title} - YouTube</title></head>` +
    `<body><h1>${title}</h1></body></html>`;
  await context.route('**://www.youtube.com/watch**', (route) => {
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
    await tab.waitForSelector('#smartblocker-overlay', { timeout: 20_000 });
    overlayVisible = true;
  } catch {}
  console.log(`${overlayVisible ? 'PASS' : 'FAIL'} gaming title gets block overlay`);
  if (!overlayVisible) process.exitCode = 1;

  await tab.goto(
    'https://www.youtube.com/watch?v=y&t=' + encodeURIComponent('React Router Tutorial'),
  );
  await tab.waitForTimeout(8_000); // give a wrong block time to appear
  const wronglyBlocked = await tab.locator('#smartblocker-overlay').count();
  console.log(`${wronglyBlocked === 0 ? 'PASS' : 'FAIL'} programming title is NOT blocked`);
  if (wronglyBlocked > 0) process.exitCode = 1;

  // Fresh title (not in the title cache) — measures real warm inference
  // latency through the whole blocker path.
  await tab.goto(
    'https://www.youtube.com/watch?v=z&t=' + encodeURIComponent('speedrunning Dark Souls'),
  );
  let freshBlocked = false;
  try {
    await tab.waitForSelector('#smartblocker-overlay', { timeout: 30_000 });
    freshBlocked = true;
  } catch {}
  console.log(`${freshBlocked ? 'PASS' : 'FAIL'} uncached gaming title gets block overlay`);
  if (!freshBlocked) process.exitCode = 1;

  // 4b. Deterministic blocklist: a URL/keyword match should block instantly,
  // skipping the ML classifier entirely (inferMs 0), and the override button
  // must still work on a blocklist-triggered block (override always wins).
  const BLOCKLIST_KW = 'smartblocker-blocklist-test';
  await sw.evaluate(async (kw) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, blocklist: [kw] } });
  }, BLOCKLIST_KW);

  await tab.waitForTimeout(500); // give onChanged time to fire

  const blocklistTitle = 'Blocklist Test Page';
  const blocklistUrl =
    'https://www.youtube.com/watch?v=bl&kw=' +
    BLOCKLIST_KW +
    '&t=' +
    encodeURIComponent(blocklistTitle);
  await tab.goto(blocklistUrl);
  let blocklistBlocked = false;
  try {
    await tab.waitForSelector('#smartblocker-overlay', { timeout: 5_000 }); // near-instant: no inference
    blocklistBlocked = true;
  } catch {}
  console.log(`${blocklistBlocked ? 'PASS' : 'FAIL'} blocklist keyword match blocks instantly`);
  if (!blocklistBlocked) process.exitCode = 1;

  const { latencySamples: blocklistSamples = [] } = await sw.evaluate(() =>
    chrome.storage.local.get('latencySamples'),
  );
  const blocklistSample = [...blocklistSamples].reverse().find((s) => s.title === blocklistTitle);
  const skippedClassifier = blocklistSample?.inferMs === 0 && blocklistSample?.blocked === true;
  console.log(
    `${skippedClassifier ? 'PASS' : 'FAIL'} blocklist match skipped the ML classifier (inferMs 0)`,
  );
  if (!skippedClassifier) process.exitCode = 1;

  await tab.locator('#smartblocker-overlay button', { hasText: 'actually productive' }).click();
  await tab.goto('about:blank');
  await tab.goto(blocklistUrl);
  await tab.waitForTimeout(3_000);
  const stillBlockedAfterOverride = await tab.locator('#smartblocker-overlay').count();
  console.log(
    `${stillBlockedAfterOverride === 0 ? 'PASS' : 'FAIL'} override lets a blocklist-matched title through`,
  );
  if (stillBlockedAfterOverride > 0) process.exitCode = 1;

  // 4c. The override click must also record a rich false-positive feedback
  // record (title + domain + the verdict being corrected).
  const { feedback = [] } = await sw.evaluate(() => chrome.storage.local.get('feedback'));
  const fpRecord = feedback.find(
    (r) => r.kind === 'false_positive' && r.title === blocklistTitle && r.domain,
  );
  console.log(
    `${fpRecord ? 'PASS' : 'FAIL'} override recorded a false-positive feedback record` +
      (fpRecord ? ` (domain ${fpRecord.domain}, was "${fpRecord.modelLabel}")` : ''),
  );
  if (!fpRecord) process.exitCode = 1;

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

  // 6. Lock system: a Frozen Turkey session must force blocking even with the
  // master toggle off, strip the block screen's bypass buttons, ignore stored
  // overrides, and freeze the options page. Raw storage writes on purpose:
  // we're seeding state, deliberately going around the setSettings guard.
  //
  // P2 DNRed: under a force-blocking lock the block screen is no longer the
  // injected overlay — a declarativeNetRequest session rule redirects the tab
  // to the extension-owned /blocked.html (zero hostile DOM to tamper with).
  // The assertions below therefore follow the redirect: the FINAL url must be
  // the extension page and the SAME locked screen (copy + button posture)
  // must render there. Non-force sections (4b/8/9/10) keep asserting the
  // injected overlay and are untouched.
  const isBlockedPageUrl = (u) =>
    u.protocol === 'chrome-extension:' && u.pathname.endsWith('/blocked.html');
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, enabled: false },
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: Date.now() + 120_000,
        schedules: [],
      },
    });
  });
  await tab.waitForTimeout(500); // let onChanged listeners fire

  const frozenTitle = 'Elden Ring boss guide walkthrough';
  await tab.goto('https://www.youtube.com/watch?v=fz&t=' + encodeURIComponent(frozenTitle));
  let frozenBlocked = false;
  try {
    await tab.waitForURL(isBlockedPageUrl, { timeout: 30_000 });
    frozenBlocked = true;
  } catch {}
  console.log(
    `${frozenBlocked ? 'PASS' : 'FAIL'} frozen turkey blocks even with master toggle off` +
      (frozenBlocked ? ` (redirected to ${tab.url().slice(0, 48)}…)` : ''),
  );
  if (!frozenBlocked) process.exitCode = 1;

  if (frozenBlocked) {
    const overlayBtns = tab.locator('#smartblocker-blocked button');
    const overrideCount = await overlayBtns.filter({ hasText: 'actually productive' }).count();
    const dismissCount = await overlayBtns.filter({ hasText: 'Dismiss' }).count();
    const stayCount = await overlayBtns.filter({ hasText: 'Stay focused' }).count();
    const lockedUi = overrideCount === 0 && dismissCount === 0 && stayCount === 1;
    console.log(
      `${lockedUi ? 'PASS' : 'FAIL'} locked block screen hides bypass buttons ` +
        `(override ${overrideCount}, dismiss ${dismissCount}, stay ${stayCount})`,
    );
    if (!lockedUi) process.exitCode = 1;

    const blockedText = (await tab.locator('#smartblocker-blocked').textContent()) ?? '';
    const lockCopyOk =
      /Smart Blocker is locked — bypass is disabled/.test(blockedText) &&
      blockedText.includes(frozenTitle);
    console.log(`${lockCopyOk ? 'PASS' : 'FAIL'} locked extension block page renders lock copy + title`);
    if (!lockCopyOk) process.exitCode = 1;
  }

  // The blocklist URL was overridden in 4b — forced blocking ignores overrides.
  await tab.goto('about:blank');
  await tab.goto(blocklistUrl);
  let overriddenReblocked = false;
  try {
    await tab.waitForURL(isBlockedPageUrl, { timeout: 10_000 });
    overriddenReblocked = true;
  } catch {}
  console.log(
    `${overriddenReblocked ? 'PASS' : 'FAIL'} forced blocking ignores stored overrides`,
  );
  if (!overriddenReblocked) process.exitCode = 1;

  // Options page freezes while locked.
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extensionId}/options.html#blocking`);
  await opts.waitForTimeout(1_500); // lock status polls at load + 1s tick
  // Everything autosaves now (no Save button): the master switch is the
  // canonical control that must be frozen while locked.
  const toggleDisabled = await opts.locator('#enabled-toggle').isDisabled();
  const bannerText = (await opts.locator('#lock-status').textContent()) ?? '';
  const optionsLocked = toggleDisabled && /locked/i.test(bannerText);
  console.log(
    `${optionsLocked ? 'PASS' : 'FAIL'} options page frozen while locked ` +
      `("${bannerText.trim()}")`,
  );
  if (!optionsLocked) process.exitCode = 1;

  // 7. Companion bridge: the status must be honest for this machine. CI has
  // no Native Messaging host ("coming with the pro release"); a developer
  // machine with the host installed but the daemon stopped truthfully says
  // "Installed but not running". Both are valid; a blank/wrong state is not.
  await opts.goto(`chrome-extension://${extensionId}/options.html#companion`);
  await opts.waitForSelector('#companion-status');
  const companionText = (await opts.locator('#companion-status').textContent()) ?? '';
  const companionOk =
    /coming with the pro release/i.test(companionText) ||
    /Installed but not running \(companion v/i.test(companionText);
  console.log(
    `${companionOk ? 'PASS' : 'FAIL'} companion section shows an honest install state ` +
      `("${companionText.trim()}")`,
  );
  if (!companionOk) process.exitCode = 1;
  await opts.close();

  // Restore state so the next run of the persistent profile starts clean.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enabled: true, blocklist: [] } });
    await chrome.storage.local.remove('lockState');
  });
  await tab.waitForTimeout(400);

  // P2 DNR lifecycle: unlocking must drain every force-redirect session rule.
  const leftoverRules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  const rulesDrained = leftoverRules.filter((r) => r.id >= 1_000_000).length === 0;
  console.log(
    `${rulesDrained ? 'PASS' : 'FAIL'} unlock drains force-redirect session rules ` +
      `(leftover ${JSON.stringify(leftoverRules.map((r) => r.id))})`,
  );
  if (!rulesDrained) process.exitCode = 1;

  // 8. Search Engine (SERP) In-Page Distraction Masking vs. Full-Page Blocking:
  // On a productive/technical Google search ("nvidia rtx 5090"), Google injects
  // Sponsored Products (#tads), YouTube gaming Videos (.ULSxyf), Top stories news,
  // BestBuy shopping cards, and Reddit drama threads alongside real GPU specs.
  // SmartBlocker must NOT full-page block the search tab, MUST keep technical
  // spec cards (nvidia.com, techpowerup.com) visible, and MUST mask all injected
  // distracting shelves and cards in-place.
  const mixedSerpHtml = `<!doctype html><html><head><title>nvidia rtx 5090 - Google Search</title></head><body>
    <textarea name="q">nvidia rtx 5090</textarea>
    <div id="tads"><h3>Sponsored Products</h3><div>14-inch Gaming Rig $2,999</div></div>
    <div id="rcnt">
    <div class="SLPe5b" id="hero-title">
      <div data-attrid="title">Linus Sebastian</div>
      <div data-attrid="subtitle">Canadian YouTuber</div>
    </div>
    <div class="SLPe5b" id="hero-digest">
      <div data-attrid="VisualDigestWebResult"><a href="https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw">Linus Tech Tips - YouTube</a></div>
      <div data-attrid="VisualDigestVideoResult"><a href="https://www.youtube.com/watch?v=hero0000001">I Built The Fastest PC Ever</a></div>
    </div>
    <div id="center_col">
    <div id="rso">
      <div class="MjjYud" id="card-nvidia">
        <a href="https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/"><h3>GeForce RTX 5090 Technical Specifications & CUDA Architecture</h3></a>
        <div class="VwiC3b">21,760 CUDA cores, 32 GB GDDR7 memory, 512-bit memory interface, 5th-gen Tensor Cores for FP4 deep learning inference.</div>
      </div>
      <div class="MjjYud" id="card-techpowerup">
        <a href="https://www.techpowerup.com/gpu-specs/geforce-rtx-5090.c4216"><h3>NVIDIA GeForce RTX 5090 GPU Database Specs</h3></a>
        <div class="VwiC3b">GB202 GPU die size, TSMC 4NP process node, L2 cache architecture, and PCIe 5.0 x16 bandwidth specifications.</div>
      </div>
      <div class="MjjYud" id="card-bestbuy">
        <a href="https://www.bestbuy.ca/en-ca/shop/rtx-5090"><h3>NVIDIA GeForce RTX 5090 32GB Video Card - Best Buy</h3></a>
        <div class="VwiC3b">Up to 5% Cash Back. Shop the RTX 5090 at Best Buy. In stock, Free delivery.</div>
      </div>
      <div class="ULSxyf" id="shelf-videos">
        <div role="heading">Videos</div>
        <a href="https://www.youtube.com/watch?v=vid1">First 5090, now 5080? NVIDIA destroying Gaming... YouTube · JayzTwoCents</a>
        <a href="https://www.youtube.com/watch?v=vid2">RTX 5090 - Phantom Blade Zero Max Settings Gameplay</a>
      </div>
      <div class="ULSxyf" id="shelf-news">
        <div role="heading">Top stories</div>
        <a href="https://www.theverge.com/news/2026/gpu">Breaking news: GPU scalpers flood retail market</a>
      </div>
      <div class="MjjYud" id="shelf-social">
        <div role="heading">What people are saying</div>
        <a href="https://x.com/gamer/status/1">Trending posts on X and TikTok</a>
      </div>
      <div class="MjjYud" id="card-aita">
        <a href="https://www.reddit.com/r/AmItheAsshole/comments/abc123/aita_wedding/"><h3>AITA for refusing to pay for my sister wedding after bridezilla drama</h3></a>
        <div class="VwiC3b">Reddit · r/AmItheAsshole · 4.2K comments · Family wedding drama and relationship gossip thread.</div>
      </div>
    </div>
    <div id="botstuff">
      <div data-attrid="kc:/common/topic:social media presence" id="sweep-social">
        <a href="https://www.youtube.com/@LinusTechTips">YouTube</a>
        <a href="https://www.instagram.com/linustech">Instagram</a>
      </div>
      <div data-hveid="mixed1" id="sweep-mixed">
        <a id="sweep-mixed-nvidia" href="https://www.nvidia.com/en-us/geforce/">NVIDIA GeForce product page</a>
        <span><a id="sweep-mixed-yt" href="https://www.youtube.com/watch?v=mixed000001">RTX 5090 unboxing</a></span>
      </div>
    </div>
    </div>
    </div>
  </body></html>`;

  const minesweeperSerpHtml = `<!doctype html><html><head><title>play minesweeper - Google Search</title></head><body>
    <textarea name="q">play minesweeper</textarea>
    <div id="rso">
      <div class="ULSxyf" id="shelf-games">
        <div role="heading">Games from Google</div>
        <a href="https://www.google.com/fbx?fbx=minesweeper">Minesweeper Puzzle Play</a>
      </div>
      <div class="MjjYud">
        <a href="https://minesweeper.online/"><h3>Minesweeper Online - Play Free Online Minesweeper</h3></a>
        <div class="VwiC3b">Play minesweeper online with over 10 million players around the world!</div>
      </div>
    </div>
  </body></html>`;

  // Mirrors Google's live Images tab: one MjjYud holds the whole grid and an
  // interleaved "Related searches" module, and some tiles link to YouTube.
  const imagesTabHtml = (q) => `<!doctype html><html><head><meta charset="utf-8"><title>${q} - Google Search</title></head><body>
    <div id="rcnt"><div id="center_col"><div id="search"><div id="rso"><div class="MjjYud" id="image-grid">
      <div id="tile-docs" data-attrid="images universal" data-lpage="https://pytorch.org/docs/autograd" data-hveid="a"><a href="https://pytorch.org/docs/autograd"><img alt="Autograd mechanics"></a></div>
      <div id="tile-yt" data-attrid="images universal" data-lpage="https://www.youtube.com/watch?v=aaaaaaaaaaa" data-hveid="b"><a href="https://www.youtube.com/watch?v=aaaaaaaaaaa"><img alt="Autograd explained"></a></div>
      <div id="tile-ruled" data-attrid="images universal" data-lpage="https://blocked-by-rule.example/x" data-hveid="c"><a href="https://blocked-by-rule.example/x"><img alt="Rule target"></a></div>
      <div><h2>Related searches</h2><a href="/search?q=more">more</a></div>
    </div></div></div></div></div></body></html>`;
  const imageRowSerpHtml = `<!doctype html><html><head><meta charset="utf-8"><title>backprop diagram - Google Search</title></head><body>
    <div id="rcnt"><div id="center_col"><div id="search"><div id="rso">
      <div class="MjjYud" id="image-row"><h2>Images</h2><a href="https://www.youtube.com/watch?v=bbbbbbbbbbb"><img alt="Backprop"></a></div>
      <div class="MjjYud" id="related-row"><h2>Related searches</h2><a href="/search?q=more">more</a></div>
    </div></div></div></div></body></html>`;

  await context.route('**://www.google.com/search**', (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q') ?? '';
    route.fulfill({
      contentType: 'text/html',
      body: u.searchParams.get('udm') === '2'
        ? imagesTabHtml(q)
        : q.includes('backprop')
          ? imageRowSerpHtml
          : q.includes('minesweeper')
            ? minesweeperSerpHtml
            : mixedSerpHtml,
    });
  });

  await tab.goto('https://www.google.com/search?q=nvidia+rtx+5090');
  await tab.waitForTimeout(3_000);

  const serpOverlayCount = await tab.locator('#smartblocker-overlay').count();
  const serpMaskState = await tab.evaluate(() => ({
    tadsMasked: !!document.getElementById('tads')?.getAttribute('data-smartblocker-masked'),
    videosMasked: !!document.getElementById('shelf-videos')?.getAttribute('data-smartblocker-masked'),
    newsMasked: !!document.getElementById('shelf-news')?.getAttribute('data-smartblocker-masked'),
    socialMasked: !!document.getElementById('shelf-social')?.getAttribute('data-smartblocker-masked'),
    bestbuyMasked: !!document.getElementById('card-bestbuy')?.getAttribute('data-smartblocker-masked'),
    aitaMasked: !!document.getElementById('card-aita')?.getAttribute('data-smartblocker-masked'),
    nvidiaVisible: !document.getElementById('card-nvidia')?.getAttribute('data-smartblocker-masked'),
    tpuVisible: !document.getElementById('card-techpowerup')?.getAttribute('data-smartblocker-masked'),
    // Entity hero (outside #center_col): both rows masked, ONE bar total.
    heroTitleMasked: !!document.getElementById('hero-title')?.getAttribute('data-smartblocker-masked'),
    heroDigestMasked: !!document.getElementById('hero-digest')?.getAttribute('data-smartblocker-masked'),
    heroBars:
      document.querySelectorAll('#hero-title > .smartblocker-mask-bar, #hero-digest > .smartblocker-mask-bar').length,
    // Leftover-link sweep: pure social row masked; in a mixed tile only the
    // YouTube link is masked and the NVIDIA link stays visible.
    sweepSocialMasked: !!document.getElementById('sweep-social')?.getAttribute('data-smartblocker-masked'),
    sweepMixedTileVisible: !document.getElementById('sweep-mixed')?.getAttribute('data-smartblocker-masked'),
    sweepMixedYtMasked: !!document
      .getElementById('sweep-mixed-yt')
      ?.closest('[data-smartblocker-masked]'),
  }));

  const serpMaskOk =
    serpOverlayCount === 0 &&
    serpMaskState.tadsMasked &&
    serpMaskState.videosMasked &&
    serpMaskState.newsMasked &&
    serpMaskState.socialMasked &&
    serpMaskState.bestbuyMasked &&
    serpMaskState.aitaMasked &&
    serpMaskState.nvidiaVisible &&
    serpMaskState.tpuVisible &&
    serpMaskState.heroTitleMasked &&
    serpMaskState.heroDigestMasked &&
    serpMaskState.heroBars === 1 &&
    serpMaskState.sweepSocialMasked &&
    serpMaskState.sweepMixedTileVisible &&
    serpMaskState.sweepMixedYtMasked;

  console.log(
    `${serpMaskOk ? 'PASS' : 'FAIL'} mixed Google SERP masks distracting shelves/cards while keeping tech specs visible:`,
    serpMaskState,
  );
  if (!serpMaskOk) process.exitCode = 1;

  // Google Images: the page-level query verdict decides, never a heading or
  // thumbnail host inside it, and the user's own rules still reach each tile.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, blocklist: [...(settings.blocklist ?? []), 'blocked-by-rule.example'] },
    });
  });
  await tab.goto('https://www.google.com/search?q=pytorch+autograd&udm=2');
  await tab.waitForTimeout(3_000);
  const productiveImages = await tab.evaluate(() => {
    const m = (id) => document.getElementById(id)?.getAttribute('data-smartblocker-masked') ?? null;
    return { rso: m('rso'), grid: m('image-grid'), docs: m('tile-docs'), yt: m('tile-yt'), ruled: m('tile-ruled') };
  });
  await tab.goto('https://www.google.com/search?q=funny+cat+memes&udm=2');
  await tab.waitForTimeout(3_000);
  const memeImagesFullPageBlocks = await tab.locator('#smartblocker-overlay').count();
  await tab.goto('https://www.google.com/search?q=backprop+diagram');
  await tab.waitForTimeout(3_000);
  const imageRow = await tab.evaluate(() => ({
    row: document.getElementById('image-row')?.getAttribute('data-smartblocker-masked') ?? null,
    related: document.getElementById('related-row')?.getAttribute('data-smartblocker-masked') ?? null,
  }));
  const imagesOk =
    productiveImages.rso === null &&
    productiveImages.grid === null &&
    productiveImages.docs === null &&
    productiveImages.yt === null &&
    productiveImages.ruled === 'serp-card' &&
    memeImagesFullPageBlocks === 1 &&
    imageRow.row === null &&
    imageRow.related === null;
  console.log(
    `${imagesOk ? 'PASS' : 'FAIL'} Google Images grid and image rows follow the search query, with block rules per tile:`,
    { productiveImages, memeImagesFullPageBlocks, imageRow },
  );
  if (!imagesOk) process.exitCode = 1;
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        blocklist: (settings.blocklist ?? []).filter((b) => b !== 'blocked-by-rule.example'),
      },
    });
  });
  await tab.goto('https://www.google.com/search?q=nvidia+rtx+5090');
  await tab.waitForTimeout(3_000);

  // Toggle maskSearchElements: false -> open search page unmasks and sweeps open tabs
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maskSearchElements: false } });
  });
  await tab.waitForTimeout(1_500);
  const unmaskedState = await tab.evaluate(() => ({
    tadsMasked: document.getElementById('tads')?.getAttribute('data-smartblocker-masked') === 'serp-shelf',
    videosMasked: document.getElementById('shelf-videos')?.getAttribute('data-smartblocker-masked') === 'serp-shelf',
    bestbuyMasked: document.getElementById('card-bestbuy')?.getAttribute('data-smartblocker-masked') === 'serp-card',
  }));
  const unmaskOk = !unmaskedState.tadsMasked && !unmaskedState.videosMasked && !unmaskedState.bestbuyMasked;
  console.log(
    `${unmaskOk ? 'PASS' : 'FAIL'} maskSearchElements toggle: turning toggle OFF unmasks SERP shelves/cards:`,
    unmaskedState,
  );
  if (!unmaskOk) process.exitCode = 1;

  // Restore maskSearchElements: true
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maskSearchElements: true } });
  });

  await tab.goto('https://www.google.com/search?q=play+minesweeper');
  let minesweeperBlocked = false;
  try {
    await tab.waitForSelector('#smartblocker-overlay', { timeout: 15_000 });
    minesweeperBlocked = true;
  } catch {}
  console.log(
    `${minesweeperBlocked ? 'PASS' : 'FAIL'} unambiguous gaming SERP ("play minesweeper") gets full-page block`,
  );
  if (!minesweeperBlocked) process.exitCode = 1;

  // 8c. YouTube Search itself stays open, but each video gets its own verdict.
  // A broad "tech" query must not blanket-block or blanket-allow the results.
  const youTubeSearchHtml = `<!doctype html><html><head><title>tech - YouTube</title></head><body>
    <ytd-video-renderer id="yt-game">
      <a id="video-title" href="/watch?v=minecraft01" title="I spent 100 days in Hardcore Minecraft">I spent 100 days in Hardcore Minecraft</a>
      <ytd-channel-name><div id="text"><a>Gaming Archive</a></div></ytd-channel-name>
      <div class="metadata-snippet-text">Surviving hardcore mode and building a base.</div>
    </ytd-video-renderer>
    <ytd-video-renderer id="yt-react">
      <a id="video-title" href="/watch?v=reacttut001" title="React Router Tutorial">React Router Tutorial</a>
      <ytd-channel-name><div id="text"><a>React Training</a></div></ytd-channel-name>
      <div class="metadata-snippet-text">Learn routing in a React application.</div>
    </ytd-video-renderer>
  </body></html>`;
  await context.route('**://www.youtube.com/results**', (route) => {
    route.fulfill({ contentType: 'text/html', body: youTubeSearchHtml });
  });
  await tab.goto('https://www.youtube.com/results?search_query=tech');
  await tab.waitForFunction(
    () =>
      document.getElementById('yt-game')?.getAttribute('data-smartblocker-masked') ===
        'serp-card' &&
      document.getElementById('yt-react')?.getAttribute('data-smartblocker-state') === 'allowed',
    undefined,
    { timeout: 45_000 },
  );
  const youTubeMixedState = await tab.evaluate(() => ({
    gameMasked:
      document.getElementById('yt-game')?.getAttribute('data-smartblocker-masked') === 'serp-card',
    reactVisible:
      !document.getElementById('yt-react')?.getAttribute('data-smartblocker-masked') &&
      document.getElementById('yt-react')?.getAttribute('data-smartblocker-state') === 'allowed',
    pageVisible: document.querySelectorAll('#smartblocker-overlay').length === 0,
  }));
  const youTubeMixedOk =
    youTubeMixedState.gameMasked && youTubeMixedState.reactVisible && youTubeMixedState.pageVisible;
  console.log(
    `${youTubeMixedOk ? 'PASS' : 'FAIL'} YouTube tech search masks gaming but keeps a programming result + the page visible:`,
    youTubeMixedState,
  );
  if (!youTubeMixedOk) process.exitCode = 1;

  // YouTube Polymer inserts Shorts after the initial result scan. The shared
  // MutationObserver must classify these lazily-added cards too.
  await tab.evaluate(() => {
    const shorts = document.createElement('ytd-reel-item-renderer');
    shorts.id = 'yt-shorts';
    shorts.innerHTML =
      '<a href="/shorts/shortsmc001"><h3>I spent 100 days in Hardcore Minecraft</h3></a>';
    document.body.appendChild(shorts);
  });
  await tab.waitForFunction(
    () =>
      document.getElementById('yt-shorts')?.getAttribute('data-smartblocker-masked') ===
      'serp-card',
    { timeout: 30_000 },
  );
  console.log('PASS lazily-inserted YouTube Short is classified and masked');

  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maskSearchElements: false } });
  });
  await tab.waitForTimeout(1_500);
  const youTubeUnmaskState = await tab.evaluate(() => ({
    game: document.getElementById('yt-game')?.getAttribute('data-smartblocker-masked'),
    shorts: document.getElementById('yt-shorts')?.getAttribute('data-smartblocker-masked'),
  }));
  const youTubeUnmaskOk =
    youTubeUnmaskState.game !== 'serp-card' && youTubeUnmaskState.shorts !== 'serp-card';
  console.log(
    `${youTubeUnmaskOk ? 'PASS' : 'FAIL'} search masking toggle also reveals YouTube result cards:`,
    youTubeUnmaskState,
  );
  if (!youTubeUnmaskOk) process.exitCode = 1;
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, maskSearchElements: true } });
  });

  // 9. Embedded YouTube Videos inside Whitelisted Google AI Studio / Chatbots:
  // Even though aistudio.google.com is whitelisted at the page level, a distracting
  // embedded YouTube video (Airrack "Secretly Working At 7-11 Until I Get Fired",
  // iYZ77j7v4GM) must be resolved via oEmbed, classified as distracting, masked
  // in-place, and unloaded (src="about:blank"), while a productive ML lecture
  // (Andrej Karpathy "Let's build GPT", kCc8FmEb1nY) remains unmasked!
  const aiStudioHtml = `<!doctype html><html><head><title>Google AI Studio</title></head><body>
    <h1>Google AI Studio Prompt Workspace</h1>
    <ms-youtube-chunk id="chunk-airrack" class="ng-star-inserted">
      <div class="youtube-container-wrapper">
        <div class="mat-mdc-tooltip-trigger video-container">
          <iframe id="iframe-airrack" title="YouTube video player" src="https://www.youtube.com/embed/iYZ77j7v4GM"></iframe>
        </div>
      </div>
    </ms-youtube-chunk>
    <ms-youtube-chunk id="chunk-karpathy" class="ng-star-inserted">
      <div class="youtube-container-wrapper">
        <div class="mat-mdc-tooltip-trigger video-container">
          <iframe id="iframe-karpathy" title="YouTube video player" src="https://www.youtube.com/embed/kCc8FmEb1nY"></iframe>
        </div>
      </div>
    </ms-youtube-chunk>
  </body></html>`;

  await context.route('**://aistudio.google.com/**', (route) => {
    route.fulfill({ contentType: 'text/html', body: aiStudioHtml });
  });
  await context.route('**://www.youtube.com/embed/**', (route) => {
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>YouTube</title></head><body><video></video></body></html>' });
  });

  await tab.goto('https://aistudio.google.com/prompts/new_chat');
  await tab.waitForFunction(
    () => {
      const airrack = document.getElementById('chunk-airrack');
      const karpathy = document.getElementById('chunk-karpathy');
      return (
        airrack?.getAttribute('data-smartblocker-masked') === 'embed' &&
        karpathy?.getAttribute('data-smartblocker-state') === 'allowed'
      );
    },
    { timeout: 15_000 },
  );

  const aiStudioState = await tab.evaluate(() => ({
    fullPageBlocked: !!document.getElementById('smartblocker-overlay'),
    airrackMasked: document.getElementById('chunk-airrack')?.getAttribute('data-smartblocker-masked'),
    airrackReason: document.getElementById('chunk-airrack')?.getAttribute('data-smartblocker-reason'),
    airrackIframeSrc: document.getElementById('iframe-airrack')?.getAttribute('src'),
    karpathyMasked: document.getElementById('chunk-karpathy')?.getAttribute('data-smartblocker-masked'),
    karpathyState: document.getElementById('chunk-karpathy')?.getAttribute('data-smartblocker-state'),
    karpathyIframeSrc: document.getElementById('iframe-karpathy')?.getAttribute('src'),
  }));

  const aiStudioOk =
    !aiStudioState.fullPageBlocked &&
    aiStudioState.airrackMasked === 'embed' &&
    aiStudioState.airrackIframeSrc === 'about:blank' &&
    !aiStudioState.karpathyMasked &&
    aiStudioState.karpathyState === 'allowed' &&
    aiStudioState.karpathyIframeSrc?.includes('kCc8FmEb1nY');

  console.log(
    `${aiStudioOk ? 'PASS' : 'FAIL'} AI Studio masks & unloads distracting YouTube embed (Airrack) while allowing Karpathy lecture:`,
    aiStudioState,
  );
  if (!aiStudioOk) process.exitCode = 1;

  // 10. Direct Sub-Frame (`frameIds: [frameId]`) Classification & Blocking:
  // Even when an embedded player is hidden inside a CLOSED Shadow DOM (where
  // parent-page document.querySelectorAll cannot see it) or buried inside a
  // nested cross-origin wrapper iframe, `onSubFrame` must target the sub-frame
  // directly by frameId, extract `.ytp-title-link` / `.ytp-title-channel-name`,
  // block distracting embeds in-frame without closing the parent workspace tab,
  // and allow productive lecture embeds through.
  const shadowHostHtml = `<!doctype html><html><head><title>Google AI Studio - Shadow Embed Test</title></head><body>
    <h1>AI Studio Workspace (Closed Shadow + Nested Iframe)</h1>
    <div id="shadow-mount"></div>
    <iframe id="nested-wrapper" src="https://embed-sandbox.example.com/wrapper.html"></iframe>
    <script>
      customElements.define('sb-closed-player', class extends HTMLElement {
        connectedCallback() {
          const closedRoot = this.attachShadow({ mode: 'closed' });
          const fGaming = document.createElement('iframe');
          fGaming.src = 'https://www.youtube-nocookie.com/embed/mcHardcore1';
          closedRoot.appendChild(fGaming);

          const fLecture = document.createElement('iframe');
          fLecture.src = 'https://www.youtube-nocookie.com/embed/gptLecture1';
          closedRoot.appendChild(fLecture);
        }
      });
      document.getElementById('shadow-mount').appendChild(document.createElement('sb-closed-player'));
    </script>
  </body></html>`;

  const nestedWrapperHtml = `<!doctype html><html><head><title>Embed Sandbox Wrapper</title></head><body>
    <iframe id="deep-yt-embed" src="https://www.youtube-nocookie.com/embed/eldenBoss11"></iframe>
  </body></html>`;

  const fakeEmbedPlayerHtml = (title, channel) =>
    `<!doctype html><html><head><title>${title} - YouTube</title></head><body>
      <div class="ytp-chrome-top">
        <div class="ytp-title-text">
          <a class="ytp-title-link" href="https://www.youtube.com/watch?v=x">${title}</a>
          <div class="ytp-title-subtext">
            <a class="ytp-title-channel-name" href="https://www.youtube.com/@c">${channel}</a>
          </div>
        </div>
      </div>
      <video src="about:blank"></video>
    </body></html>`;

  await context.route('**://aistudio.google.com/prompts/shadow_embed_test**', (route) => {
    route.fulfill({ contentType: 'text/html', body: shadowHostHtml });
  });
  await context.route('**://embed-sandbox.example.com/wrapper.html**', (route) => {
    route.fulfill({ contentType: 'text/html', body: nestedWrapperHtml });
  });
  await context.route('**://www.youtube-nocookie.com/embed/**', (route) => {
    const u = route.request().url();
    if (u.includes('mcHardcore1')) {
      route.fulfill({
        contentType: 'text/html',
        body: fakeEmbedPlayerHtml('I spent 100 days in Hardcore Minecraft', 'Luke TheNotable'),
      });
    } else if (u.includes('eldenBoss11')) {
      route.fulfill({
        contentType: 'text/html',
        body: fakeEmbedPlayerHtml('Elden Ring Boss Fight All Remembrances', 'Shirrako'),
      });
    } else {
      route.fulfill({
        contentType: 'text/html',
        body: fakeEmbedPlayerHtml('React Router Tutorial for Beginners', 'Programming with Mosh'),
      });
    }
  });

  await tab.goto('https://aistudio.google.com/prompts/shadow_embed_test');
  await tab.waitForFunction(
    () => !!document.querySelector('sb-closed-player'),
    { timeout: 10_000 },
  );

  // Wait for all 3 sub-frames to attach at the CDP level
  let mcFrame = null;
  let eldenFrame = null;
  let lectureFrame = null;
  for (let i = 0; i < 40; i++) {
    const frames = tab.frames();
    mcFrame = frames.find((f) => f.url().includes('mcHardcore1')) ?? null;
    eldenFrame = frames.find((f) => f.url().includes('eldenBoss11')) ?? null;
    lectureFrame = frames.find((f) => f.url().includes('gptLecture1')) ?? null;
    if (mcFrame && eldenFrame && lectureFrame) break;
    await tab.waitForTimeout(200);
  }

  let closedShadowBlocked = false;
  let nestedIframeBlocked = false;
  try {
    await mcFrame?.waitForSelector('#smartblocker-overlay[data-smartblocker-context="subframe"]', {
      timeout: 15_000,
    });
    closedShadowBlocked = true;
  } catch {}
  try {
    await eldenFrame?.waitForSelector(
      '#smartblocker-overlay[data-smartblocker-context="subframe"]',
      { timeout: 15_000 },
    );
    nestedIframeBlocked = true;
  } catch {}

  await tab.waitForTimeout(1_500);
  const lectureOverlayCount = lectureFrame
    ? await lectureFrame.locator('#smartblocker-overlay').count()
    : -1;
  const hostOverlayCount = await tab.locator('#smartblocker-overlay').count();

  // Verify clicking "Stay focused (disable embed)" inside the sub-frame disables
  // the embed without closing the parent AI Studio tab.
  if (closedShadowBlocked && mcFrame) {
    await mcFrame.locator('#smartblocker-overlay button', { hasText: 'Stay focused' }).click();
  }
  const hostStillOpen = !tab.isClosed() && (await tab.locator('h1').count()) === 1;

  const subFrameOk =
    closedShadowBlocked &&
    nestedIframeBlocked &&
    lectureOverlayCount === 0 &&
    hostOverlayCount === 0 &&
    hostStillOpen;

  console.log(
    `${subFrameOk ? 'PASS' : 'FAIL'} direct sub-frame blocking (` +
      `closedShadow=${closedShadowBlocked}, nestedIframe=${nestedIframeBlocked}, ` +
      `lectureOverlay=${lectureOverlayCount}, hostOverlay=${hostOverlayCount}, hostStillOpen=${hostStillOpen})`,
  );
  if (!subFrameOk) process.exitCode = 1;

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
