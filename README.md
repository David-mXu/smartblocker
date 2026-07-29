# FlowGuard

A smart distraction blocker that runs a text-classification model
**100% locally in your browser** (Transformers.js + ONNX WASM). Instead of
blocking whole sites, it classifies each page title — "React Router Tutorial"
passes, "I spent 100 days in Hardcore Minecraft" gets a block screen. It watches
**every site except a whitelist you control** (Cold-Turkey-style "allow these,
block the rest"; seeded with safe defaults like search, mail, docs, and dev tools).

Implemented through Phase 2.9; the full plan is in
[`ROADMAP.md`](ROADMAP.md). What works today:

1. Transformers.js runs inside a Manifest V3 background (service worker on
   Chrome/Edge, event page on Firefox). On Chrome/Edge the model lives in an
   **offscreen document** so it survives the service worker's idle shutdown.
2. **Configurable categories + onboarding** — a settings page (opens on install)
   lets you pick which categories to block, set the threshold, edit the
   whitelist of never-blocked sites, and scan your history to spot your top
   distractions.
3. Page-visit classification blocks in ~10ms once warm
   (popup → "Latency Log" after browsing), with a **block screen** whose
   "this is actually productive" override remembers your correction.
4. **The classifier learns from you.** Corrections (the override button, and
   the popup's "Should've been blocked" report) are stored on-device and fold
   into the classifier's category prototypes. The options page can export
   them as JSON — and an **opt-in, off-by-default** toggle can share them to
   improve the model for everyone ([`PRIVACY.md`](PRIVACY.md)).
5. **Locks, Cold-Turkey-style.** Lock your settings for a set time or behind a
   password, schedule recurring locked blocks (e.g. weekdays 9–5), or hit
   **Frozen Turkey** in the popup to force blocking on for the next 1/4/8
   hours — uncancellable, and the block screen's bypass buttons disappear.
   (A soft lock for now: uninstalling still escapes it. The planned desktop
   companion makes it tamper-proof — see ROADMAP Phase 4.)

Nothing ever leaves your machine (the model, ~35MB one-time, is downloaded
from the Hugging Face Hub and cached; all inference and history analysis are
local) — with exactly one exception: the explicit opt-in feedback sharing
described in [`PRIVACY.md`](PRIVACY.md), which is off by default.

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
   (~35MB, watch the background console); you'll see label distributions and
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
npm run eval                                                # regression gate — fails on any regression
node scripts/benchmark.mjs embed:Xenova/bge-small-en-v1.5   # model bake-off (compare candidates)
node scripts/e2e-test.mjs                                   # full extension e2e in a real Chromium
node feedback-worker/test/local-test.mjs                    # feedback worker (stubbed D1)
```

`npm run eval` is the one that answers *"did that change make the model
better?"* It runs the shipped config over 395 eval cases, scores the real
block/allow decision (whitelist and blocklist included, not just the
classifier's guess), and diffs every case against a committed baseline —
printing exactly which pages got fixed and which regressed, and exiting
non-zero on a regression. Accept an improvement with `--update-baseline`; the
git history of `scripts/eval-baseline.json` is the score history.

Most eval cases carry a real URL, and `npm run eval -- --capture` re-scrapes
those pages with a headless browser using the *same* metadata extractor the
extension injects — so the eval measures the real signal pipeline instead of
hand-written guesses about it.

The shipped classifier is an **embedding-prototype** model
(`Xenova/bge-small-en-v1.5`, ~34MB): the page text is embedded once and
matched against per-category prototype embeddings, so adding categories is
free and inference is ~3ms in Node / ~10ms live. It scores **87.4% top-1 with
a 1.3% false-positive rate on productive pages and 91.0% end-to-end decision
accuracy** across all 395 cases — versus 65.2% / 7.1% at ~111ms for the
zero-shot NLI model it replaced (which remains available as a config
fallback). It also knows its proper nouns: "Elden Ring Boss Fight" → video
games at 0.89.

All tuning knobs (backend, model ids, category labels, blocked categories,
thresholds) live in `src/shared/config.ts`; prototype seed texts live in
`src/shared/prototype-seeds.json`.
