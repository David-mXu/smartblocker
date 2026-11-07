// P1 privacy + fail-closed e2e (red-team 2026-11 findings #9, #13, #17).
// Run AFTER `npm run build:chrome` (the integrator builds; this script only
// asserts). Shares the .e2e-profile harness pattern from e2e-test.mjs, incl.
// the persistent model cache.
//
//   a. #17 — popup.html + options.html emit ZERO requests to
//      fonts.googleapis.com / fonts.gstatic.com / picsum.photos, fonts load
//      from the self-hosted bundle, and showcase <img>s resolve locally.
//   b. #9  — with settings.resolveEmbedTitles false (default), a YouTube
//      embed card fires ZERO www.youtube.com/oembed requests; with it true,
//      exactly one; a youtube-nocookie / privacy-facade embed fires zero in
//      BOTH modes.
//   c. #13 — with a Frozen Turkey active and the classifier forced to fail
//      (EMBED/CLASSIFY messages sabotaged from inside the SW), a fresh page
//      is DNR-redirected to the extension-owned fail-closed block page
//      (blocked.html?reason=classifier-unavailable — P2 force-mode design)
//      after exponential-backoff retries, while the SAME failure with
//      no lock active leaves the page alone (fail-open preserved).
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile');
const MODEL_TIMEOUT_MS = 5 * 60_000; // first run downloads the model (~35MB)
const RUN_TAG = Date.now().toString(36); // keeps titles out of the title cache

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

const { context, sw } = await launchWithServiceWorker();

try {
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  // Fresh state every run (the profile persists across runs; this mirrors the
  // storage reset in e2e-test.mjs but also pins the new toggle off).
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, blocklist: [], resolveEmbedTitles: false },
    });
    await chrome.storage.local.remove(['overrides', 'feedback', 'latencySamples', 'historyScan', 'lockState']);
  });

  // ── A. #17 — extension pages fetch ZERO remote UI assets ────────────────
  // Sniff every http(s) request the popup and options pages make; abort the
  // three offending hosts as well so a regression both fails loudly here and
  // stays hermetic (page still renders on system-font fallback).
  const REMOTE_UI_HOST_RE = /(?:^|\.)(?:fonts\.googleapis\.com|fonts\.gstatic\.com|picsum\.photos)$/i;
  const remoteUiHits = [];
  const sniff = (page, pageName) => {
    page.on('request', (req) => {
      try {
        const u = new URL(req.url());
        if ((u.protocol === 'https:' || u.protocol === 'http:') && REMOTE_UI_HOST_RE.test(u.hostname)) {
          remoteUiHits.push(`${pageName}:${req.url()}`);
        }
      } catch {}
    });
  };
  await context.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await context.route('**://fonts.gstatic.com/**', (r) => r.abort());
  await context.route('**://picsum.photos/**', (r) => r.abort());

  const popup = await context.newPage();
  sniff(popup, 'popup');
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForTimeout(1500);
  // document.fonts.check() is load-state (not declaration) — with
  // font-display:swap + unicode-range the woff2 loads lazily, so check() can
  // be false on a perfectly wired page. fonts.load() triggers the fetch and
  // proves BOTH the @font-face declaration and the bundled asset under CSP.
  const popupFonts = await popup.evaluate(async () => {
    const probe = async (font) => {
      try {
        const faces = await document.fonts.load(font, 'Hg');
        return faces.length > 0 && faces.every((f) => f.status === 'loaded');
      } catch {
        return false;
      }
    };
    return { geist: await probe('600 12px "Geist"'), mono: await probe('500 12px "Geist Mono"') };
  });
  const fontsOk = popupFonts.geist && popupFonts.mono;
  console.log(`${fontsOk ? 'PASS' : 'FAIL'} self-hosted Geist + Geist Mono load in popup:`, popupFonts);
  if (!fontsOk) process.exitCode = 1;

  // fonts.load() proves the font CAN load, not that the page USES it. Chrome
  // injects an unlayered extension-page stylesheet (body font + 75% size)
  // that beats anything inside Tailwind's @layer base — the 2026-11-07 bug
  // where every surface silently rendered in the system font at 12px.
  // Assert the COMPUTED body font so that regression can't hide again.
  for (const [name, pg] of [['popup', popup]]) {
    const body = await pg.evaluate(() => ({
      family: getComputedStyle(document.body).fontFamily,
      size: getComputedStyle(document.body).fontSize,
    }));
    const ok = /^"?Geist"?,/.test(body.family) && body.size === '14px';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} <body> computes to Geist 14px (not Chrome's injected default):`, body);
    if (!ok) process.exitCode = 1;
  }

  const opts = await context.newPage();
  sniff(opts, 'options');
  await opts.goto(`chrome-extension://${extensionId}/options.html`);
  await opts.waitForTimeout(2000);
  const optsState = await opts.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img')];
    const probe = async (font) => {
      try {
        const faces = await document.fonts.load(font, 'Hg');
        return faces.length > 0 && faces.every((f) => f.status === 'loaded');
      } catch {
        return false;
      }
    };
    return {
      imgCount: imgs.length,
      remoteImgs: imgs.filter((i) => /^https?:/i.test(i.src)).map((i) => i.src),
      brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      geist: await probe('600 12px "Geist"'),
      mono: await probe('500 12px "Geist Mono"'),
    };
  });
  const optsFontsOk = optsState.geist && optsState.mono;
  console.log(
    `${optsFontsOk ? 'PASS' : 'FAIL'} self-hosted Geist + Geist Mono load in options:`,
    { geist: optsState.geist, mono: optsState.mono },
  );
  if (!optsFontsOk) process.exitCode = 1;
  const optsBody = await opts.evaluate(() => ({
    family: getComputedStyle(document.body).fontFamily,
    size: getComputedStyle(document.body).fontSize,
  }));
  const optsBodyOk = /^"?Geist"?,/.test(optsBody.family) && optsBody.size === '14px';
  console.log(
    `${optsBodyOk ? 'PASS' : 'FAIL'} options <body> computes to Geist 14px (not Chrome's injected default):`,
    optsBody,
  );
  if (!optsBodyOk) process.exitCode = 1;

  // The showcase SVGs moved to the standalone site/ on 2026-11-07, so the
  // options page may legitimately have zero <img>s; the privacy invariant is
  // that any image present is local and renders.
  const imgsOk = optsState.remoteImgs.length === 0 && optsState.brokenImgs === 0;
  console.log(
    `${imgsOk ? 'PASS' : 'FAIL'} options images (if any) are all local & render ` +
      `(${optsState.imgCount} imgs, remote: ${JSON.stringify(optsState.remoteImgs)}, broken: ${optsState.brokenImgs})`,
  );
  if (!imgsOk) process.exitCode = 1;

  const noRemoteUi = remoteUiHits.length === 0;
  console.log(
    `${noRemoteUi ? 'PASS' : 'FAIL'} ZERO fonts.googleapis/gstatic/picsum requests from popup+options` +
      (noRemoteUi ? '' : ` — saw: ${JSON.stringify(remoteUiHits)}`),
  );
  if (!noRemoteUi) process.exitCode = 1;

  // Model warm-up (first run downloads ~35MB — cached profile makes this ~1s).
  await popup.click('#test-pair');
  await popup.waitForFunction(
    () => {
      const t = document.getElementById('out')?.textContent ?? '';
      return t.includes('->') || t.startsWith('Error');
    },
    { timeout: MODEL_TIMEOUT_MS },
  );
  const pairOut = await popup.locator('#out').textContent();
  const warmupOk = !pairOut.startsWith('Error');
  console.log(`${warmupOk ? 'PASS' : 'FAIL'} model warm (test pair round-trip)`);
  if (!warmupOk) process.exitCode = 1;
  await popup.close();
  await opts.close();

  // ── B. #9 — oEmbed gating behind settings.resolveEmbedTitles ────────────
  // Instrument SW fetch: count oEmbed lookups and answer them with a fixture
  // (fully hermetic — no real youtube.com egress in the test).
  await sw.evaluate(() => {
    const g = globalThis;
    if (!g.__sbOembedWrapped) {
      g.__sbOembedWrapped = true;
      const orig = g.fetch;
      g.__sbOembedCalls = 0;
      g.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (/youtube\.com\/oembed/.test(url)) {
          g.__sbOembedCalls++;
          return Promise.resolve(
            new Response(
              JSON.stringify({ title: 'oEmbed Fixture Title', author_name: 'Fixture Channel' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return orig(input, init);
      };
    }
    g.__sbOembedCalls = 0;
  });
  const oembedCount = () => sw.evaluate(() => globalThis.__sbOembedCalls ?? -1);

  // Chatbot-host fixture with ONE generically-titled YouTube embed: the
  // sanitizer must fall back to oEmbed (toggle on) or nothing (toggle off).
  // The embed iframe content carries real .ytp-title DOM so the direct
  // sub-frame path never needs oEmbed — keeping the counts deterministic.
  const embedFixture = (vid, host) => `<!doctype html><html><head><title>Embed Fixture</title></head><body>
    <h1>Chatbot Workspace</h1>
    <ms-youtube-chunk id="chunk">
      <div class="youtube-container-wrapper">
        <iframe id="yt-embed" title="YouTube video player" src="https://www.${host}/embed/${vid}"></iframe>
      </div>
    </ms-youtube-chunk>
  </body></html>`;
  const ytPlayerDom = `<!doctype html><html><head><title>Advanced TypeScript Generics Workshop - YouTube</title></head><body>
    <div class="ytp-chrome-top"><div class="ytp-title-text">
      <a class="ytp-title-link" href="https://www.youtube.com/watch?v=x">Advanced TypeScript Generics Workshop</a>
      <div class="ytp-title-subtext"><a class="ytp-title-channel-name" href="https://www.youtube.com/@c">Tech Conf Archive</a></div>
    </div></div>
    <video src="about:blank"></video>
  </body></html>`;

  await context.route('**://aistudio.google.com/embed-fixture**', (route) => {
    const u = new URL(route.request().url());
    route.fulfill({
      contentType: 'text/html',
      body: embedFixture(u.searchParams.get('vid'), u.searchParams.get('host') ?? 'youtube.com'),
    });
  });
  await context.route('**://www.youtube.com/embed/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: ytPlayerDom }),
  );
  await context.route('**://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: ytPlayerDom }),
  );

  const tab = await context.newPage();

  // B1. default (toggle OFF): ZERO oembed for a plain youtube.com embed.
  await tab.goto('https://aistudio.google.com/embed-fixture?vid=OffDef000AB');
  await tab.waitForTimeout(6000);
  let n = await oembedCount();
  const b1 = n === 0;
  console.log(`${b1 ? 'PASS' : 'FAIL'} oEmbed OFF by default: ${n} request(s) for youtube.com embed`);
  if (!b1) process.exitCode = 1;

  // B2. toggle ON: exactly ONE oembed for a fresh youtube.com embed id.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, resolveEmbedTitles: true } });
  });
  await tab.waitForTimeout(400);
  await tab.goto('https://aistudio.google.com/embed-fixture?vid=OnTogg10CD2');
  await tab.waitForTimeout(6000);
  n = await oembedCount();
  const b2 = n === 1;
  console.log(`${b2 ? 'PASS' : 'FAIL'} oEmbed toggle ON: exactly one request (saw ${n})`);
  if (!b2) process.exitCode = 1;

  // B3. nocookie embed: ZERO oembed even with the toggle ON.
  await tab.goto('https://aistudio.google.com/embed-fixture?vid=NoC0ok1eXY4&host=youtube-nocookie.com');
  await tab.waitForTimeout(6000);
  n = await oembedCount();
  const b3 = n === 1;
  console.log(`${b3 ? 'PASS' : 'FAIL'} youtube-nocookie NEVER oEmbeds (toggle ON): still ${n} request(s)`);
  if (!b3) process.exitCode = 1;

  // Restore toggle default-off.
  await sw.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, resolveEmbedTitles: false } });
  });

  // ── C. #13 — fail-closed during a hard lock, fail-open without one ──────
  // Fake watch pages (title via ?t=) so webNavigation + title events fire
  // for a real youtube.com URL, exactly like e2e-test.mjs §4.
  await context.route('**://www.youtube.com/watch**', (route) => {
    const u = new URL(route.request().url());
    const t = decodeURIComponent(u.searchParams.get('t') ?? 'YouTube');
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>${t} - YouTube</title></head><body><h1>${t}</h1></body></html>`,
    });
  });

  // Sabotage the classifier from inside the SW: EMBED/CLASSIFY traffic is the
  // offscreen inference RPC — rejecting it reproduces "offscreen kill /
  // model failure" with zero product-code test hooks.
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
        return Promise.reject(new Error('forced classifier failure (e2e)'));
      }
      return g.__sbOrigSendMessage(msg, ...rest);
    };
  });
  const sabotageCalls = () => sw.evaluate(() => globalThis.__sbSabotageCalls ?? -1);
  const repairClassifier = () =>
    sw.evaluate(() => {
      const g = globalThis;
      chrome.runtime.sendMessage = g.__sbOrigSendMessage;
    });

  // C1. Frozen Turkey active + classifier dead => DNR-redirected to the
  // extension-owned fail-closed block page (P2: force mode no longer injects
  // into the hostile document at all — the loud screen IS blocked.html).
  await sw.evaluate(() =>
    chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: null,
        frozenUntil: Date.now() + 180_000,
        schedules: [],
      },
    }),
  );
  await tab.waitForTimeout(400); // let onChanged fire
  await tab.goto(
    'https://www.youtube.com/watch?v=fc&t=' +
      encodeURIComponent(`quiet study music ${RUN_TAG}`),
  );
  let failClosed = false;
  try {
    await tab.waitForURL('**/blocked.html*', { timeout: 20_000 });
    const u = new URL(tab.url());
    failClosed =
      u.protocol === 'chrome-extension:' &&
      u.pathname.endsWith('/blocked.html') &&
      u.searchParams.get('reason') === 'classifier-unavailable';
  } catch {}
  console.log(
    `${failClosed ? 'PASS' : 'FAIL'} hard lock + dead classifier => fail-closed extension block page` +
      (failClosed ? '' : ` (landed on ${tab.url().slice(0, 120)})`),
  );
  if (!failClosed) process.exitCode = 1;

  if (failClosed) {
    // The block page renders into #root in plain light DOM (no shadow root —
    // it IS a trusted extension document, so textContent is sufficient).
    const bodyText = (await tab.locator('body').textContent()) ?? '';
    const loudOk = /classifier/i.test(bodyText) && /lock/i.test(bodyText);
    const btns = tab.locator('button');
    const overrideCount = await btns.filter({ hasText: 'actually productive' }).count();
    const dismissCount = await btns.filter({ hasText: 'Dismiss' }).count();
    const stayCount = await btns.filter({ hasText: 'Stay focused' }).count();
    const shapeOk = loudOk && overrideCount === 0 && dismissCount === 0 && stayCount === 1;
    console.log(
      `${shapeOk ? 'PASS' : 'FAIL'} fail-closed screen is distinct (mentions classifier+lock, no bypass buttons) ` +
        `(override ${overrideCount}, dismiss ${dismissCount}, stay ${stayCount})`,
    );
    if (!shapeOk) process.exitCode = 1;

    // Exponential backoff: 1s → 2s retries land within the first ~4s.
    await tab.waitForTimeout(4000);
    const calls = await sabotageCalls();
    const retried = calls >= 2;
    console.log(`${retried ? 'PASS' : 'FAIL'} backoff retries fire while fail-closed (${calls} classify attempts)`);
    if (!retried) process.exitCode = 1;

    // No category pill / fake 100% confidence on the fail-closed screen.
    const pillCount = await tab.locator('text=% confidence').count();
    const pillOk = pillCount === 0;
    console.log(`${pillOk ? 'PASS' : 'FAIL'} fail-closed screen shows no fake confidence pill (${pillCount})`);
    if (!pillOk) process.exitCode = 1;
  }

  // C2. SAME failure, NO lock => fail-open (page left alone).
  await sw.evaluate(() => chrome.storage.local.remove('lockState'));
  await tab.waitForTimeout(400);
  await tab.goto('about:blank');
  await tab.goto(
    'https://www.youtube.com/watch?v=fo&t=' +
      encodeURIComponent(`hardcore minecraft speedrun ${RUN_TAG}`),
  );
  await tab.waitForTimeout(6000); // give a wrong fail-closed block time to appear
  const openOverlay = await tab.locator('#smartblocker-overlay').count();
  // Under DNR a wrong fail-closed force-block would land on blocked.html
  // (which ALSO has overlay count 0) — assert the URL stayed on the site too.
  const stayedOnSite = !tab.url().includes('blocked.html');
  const failOpen = openOverlay === 0 && stayedOnSite;
  console.log(
    `${failOpen ? 'PASS' : 'FAIL'} no lock + dead classifier => fail-open preserved (overlay count ${openOverlay}, on blocked.html: ${!stayedOnSite})`,
  );
  if (!failOpen) process.exitCode = 1;

  // C3. Recovery proof: restore the classifier and confirm normal blocking
  // works again on a fresh gaming title (fail-closed was caused by the
  // sabotage, not a broken SW).
  await repairClassifier();
  await tab.goto(
    'https://www.youtube.com/watch?v=re&t=' +
      encodeURIComponent(`elden ring boss rush ${RUN_TAG}`),
  );
  let recovered = false;
  try {
    await tab.waitForSelector('#smartblocker-overlay:not([data-smartblocker-reason="classifier-unavailable"])', {
      timeout: 30_000,
    });
    recovered = true;
  } catch {}
  console.log(`${recovered ? 'PASS' : 'FAIL'} classifier recovery restores normal category blocking`);
  if (!recovered) process.exitCode = 1;

  await tab.close();
} finally {
  await context.close();
}
console.log(process.exitCode ? 'E2E-P1: FAILED' : 'E2E-P1: ALL PASSED');
