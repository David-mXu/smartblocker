# FlowGuard

A smart distraction blocker that runs a zero-shot text-classification model
**100% locally in your browser** (Transformers.js + ONNX WASM). Instead of
blocking whole sites, it classifies each page title — "React Router Tutorial"
passes, "I spent 100 days in Hardcore Minecraft" gets a block screen. It watches
**every site except a whitelist you control** (Cold-Turkey-style "allow these,
block the rest"; seeded with safe defaults like search, mail, docs, and dev tools).

Phase 1 (POC) and Phase 2 ("Ambient MVP") are implemented; the full plan is in
[`ROADMAP.md`](ROADMAP.md). What works today:

1. Transformers.js runs inside a Manifest V3 background (service worker on
   Chrome/Edge, event page on Firefox). On Chrome/Edge the model lives in an
   **offscreen document** so it survives the service worker's idle shutdown.
2. **Configurable categories + onboarding** — a settings page (opens on install)
   lets you pick which categories to block, set the threshold, edit the
   whitelist of never-blocked sites, and scan your history to spot your top
   distractions.
3. Page-visit classification is fast enough to block "instantly"
   (popup → "Latency Log" after browsing), with a **block screen** whose
   "this is actually productive" override remembers your correction.

Nothing ever leaves your machine: the model (~70MB, one-time) is downloaded
from the Hugging Face Hub and cached; all inference and history analysis are
local.

> Note: the bundled tiny NLI model still misclassifies some newer proper nouns
> (e.g. "Elden Ring Boss Fight" → sports); a stronger local model is the planned
> Phase 3 fix. See `ROADMAP.md`.

## Build

```sh
npm install
npm run build        # -> dist/chrome (also Edge) and dist/firefox
```

## Try it

**Chrome / Edge**
1. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode.
2. "Load unpacked" → select `dist/chrome`.
3. Click the "service worker" link to open the background console.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" → select `dist/firefox/manifest.json`.
3. In `about:addons`, open the extension's Permissions tab and grant access
   to all sites (Firefox treats MV3 host permissions as opt-in).

**Then, in any browser:**
1. On first install the **settings page opens automatically** (onboarding):
   toggle which categories to block, set the block threshold, and hit
   **Scan my history** to see your top distraction vs productive categories.
   Reopen it anytime from the extensions menu → "Options" (or the popup).
2. Click the toolbar popup → **Test Pair**. First click downloads the model
   (~70MB, watch the background console); you'll see label distributions and
   per-title timings.
3. **Scan History** → live progress + a category histogram of your recent
   browsing (all sites except the whitelist).
4. Visit a gaming video on YouTube → **block screen**. Click *"This is actually
   productive — let me through"* and the correction sticks (that title won't be
   blocked again); *"Stay focused"* just dismisses. Click through to another
   video via the sidebar (SPA navigation) → it re-blocks. A programming tutorial
   → no block. **Latency Log** shows the breakdown (`pageDelay` = the page's own
   title lag; `load` = model cold start — ~0 on Chrome thanks to the offscreen
   document; `infer` = classification; cached repeats are ~0ms).

## Automated checks

```sh
node scripts/smoke-test.mjs   # model quality/speed in Node (no browser)
node scripts/e2e-test.mjs     # full extension e2e in a real Chromium
```

Measured on this machine (real Chromium service worker): cached titles block
in 5–13ms; uncached titles take ~0.4–1.5s of inference; a cold service worker
adds ~1.3–3.1s to reload the model from cache (no re-download).

Current default `Xenova/nli-deberta-v3-xsmall` scores 9/10 on realistic
titles at ~60–100ms each. Known limitation: tiny NLI models don't recognize
newer proper nouns ("Elden Ring Boss Fight" → sports); richer page signals
(channel name, description) are the planned Phase 2 mitigation.

All tuning knobs (model id, category labels, blocked categories, thresholds)
live in `src/shared/config.ts`.
