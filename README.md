# FlowGuard — Phase 1 Proof of Concept

A smart distraction blocker that runs a zero-shot text-classification model
**100% locally in your browser** (Transformers.js + ONNX WASM). Instead of
blocking all of YouTube or Reddit, it classifies each page title — "React
Router Tutorial" passes, "I spent 100 days in Hardcore Minecraft" gets a
block overlay.

This POC proves three things:

1. Transformers.js runs inside a Manifest V3 background (service worker on
   Chrome/Edge, event page on Firefox).
2. Your existing history can be scanned and categorized locally
   (popup → "Scan History").
3. Page-visit classification is fast enough to block "instantly"
   (popup → "Latency Log" after browsing).

Nothing ever leaves your machine: the model (~70MB, one-time) is downloaded
from the Hugging Face Hub and cached; all inference and history analysis are
local.

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
   to youtube.com/reddit.com (Firefox treats MV3 host permissions as opt-in).

**Then, in any browser:**
1. Click the toolbar popup → **Test Pair**. First click downloads the model
   (~70MB, watch the background console); you'll see label distributions and
   per-title timings.
2. **Scan History** → live progress + a category histogram of your recent
   YouTube/Reddit browsing.
3. Visit a gaming video on YouTube → red overlay (click to dismiss). Click
   through to another video via the sidebar (SPA navigation) → it re-blocks.
   A programming tutorial → no overlay. **Latency Log** shows the breakdown
   (`pageDelay` = the page's own title lag; `load` = model cold start;
   `infer` = classification; cached repeats are ~0ms).

## Model quality check (no browser needed)

```sh
node scripts/smoke-test.mjs                                # default model
node scripts/smoke-test.mjs Xenova/mobilebert-uncased-mnli # compare others
```

Current default `Xenova/nli-deberta-v3-xsmall` scores 9/10 on realistic
titles at ~60–100ms each. Known limitation: tiny NLI models don't recognize
newer proper nouns ("Elden Ring Boss Fight" → sports); richer page signals
(channel name, description) are the planned Phase 2 mitigation.

All tuning knobs (model id, category labels, blocked categories, thresholds)
live in `src/shared/config.ts`.
