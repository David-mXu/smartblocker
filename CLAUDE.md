# FlowGuard

Smart distraction blocker: a fully-local AI model classifies page titles
(zero-shot) and blocks off-topic content without blocking whole sites.
**FlowGuard watches every `http(s)` site except the user's whitelist** (domain +
subdomain match, seeded with a safe default list in `config.ts`
`DEFAULT_WHITELIST`; user-editable on the options page). **The full multi-phase
roadmap lives in `ROADMAP.md`.** Phase 1 POC and Phase 2 "Ambient MVP" are
implemented: user-configurable categories + onboarding (options page), richer
page signals, an offscreen-document cold-start fix (Chrome/Edge), and a block
screen with a "this is actually productive" override.

Remote: `origin = github.com/David-mXu/smartblocker.git` (push with plain `git`;
`gh` CLI is not installed).

## Commands

- `npm run build` — build both targets: `dist/chrome` (also Edge) + `dist/firefox`
- `npm run build:chrome` / `npm run build:firefox` — single target
- `npm run typecheck` — `tsc --noEmit`
- `node scripts/smoke-test.mjs [modelId]` — Node-side model quality/speed test
  (no browser needed; first run downloads the model)
- `node scripts/e2e-test.mjs` — full e2e in a real Chromium (Playwright):
  boots the SW, runs Test Pair, fakes YouTube pages via network interception
  to verify block/allow + latency, seeds and runs the history scan. First run
  downloads the model into `.e2e-profile/` (~70MB, persists across runs).

Run typecheck + build + e2e before considering any background change done.

## Architecture

- `src/background/` — MV3 background.
  - `classifier.ts` — the classify() entry point: title cache + verdict assembly.
    On Chrome/Edge it delegates inference to the **offscreen document** via
    `classify-client.ts`; on Firefox it runs the Transformers.js pipeline
    in-process (`getClassifier()` singleton + env config still live here).
  - `classify-client.ts` — SW-side offscreen RPC: `supportsOffscreen()` +
    `classifyViaOffscreen(text, labels)` (ensures the doc, sends `CLASSIFY`).
  - `offscreen/offscreen.{html,ts}` — Chrome-only document that HOSTS the
    Transformers pipeline (pure inference; no caching/settings). Survives SW idle.
  - `blocker.ts` — SPA-aware nav/title listener; arms ANY `http(s)` tab
    (`isClassifiableUrl`), exempts whitelisted hosts (`isWhitelisted`), gathers
    richer signals (`extractMeta`), checks settings + overrides, injects
    `blockscreen.ts`.
  - `blockscreen.ts` — injected full block screen with the override button
    (replaced the old `overlay.ts`).
  - `history-ingester.ts` scans chrome.history; `index.ts` wires listeners,
    first-run onboarding (`openOptionsPage`), and the `OVERRIDE` handler.
- `src/popup/` — framework-less diagnostic UI (test pair, history scan, latency log).
- `src/options/` — settings + onboarding page (`options_ui`, open-in-tab):
  category block toggles, threshold slider, master enable, whitelist textarea,
  history-scan helper.
- `src/content/extract-meta.ts` — self-contained injected function that scrapes
  channel/subreddit + description snippet from the page DOM; falls back to
  `og:site_name`/`og:description`/`description` meta on generic (non-YT/Reddit) sites.
- `src/shared/` — `config.ts` (DEFAULTS: model id, labels, thresholds,
  `DEFAULT_WHITELIST`), `settings.ts` (user-overridable `Settings` in
  storage.local incl. `whitelist` — the runtime source of truth),
  `overrides.ts` (user-correction store), `build-input.ts`
  (`buildClassifierText` + `inputCacheKey` from a `ClassifyInput`),
  `api.ts` (cross-browser shim + `IS_FIREFOX`), `messages.ts` (message contract),
  `titles.ts` (`isClassifiableUrl` http(s) gate + `isWhitelisted` domain/subdomain
  match + `cleanTitle`).
- Build passes (one Vite config each, since `inlineDynamicImports` forbids
  multi-input): `vite.config.background.ts`, `vite.config.offscreen.ts`
  (chrome only), `vite.config.popup.ts`, `vite.config.options.ts`.
- `manifests/{chrome,firefox}.json` → `dist/<target>/manifest.json` via
  `scripts/copy-assets.mjs`, which ALSO hand-copies `offscreen.html` for Chrome
  (the offscreen Vite pass emits only `offscreen.js`).

## Load-bearing constraints (violate these and the extension breaks)

1. **No reachable dynamic `import()` in the background bundle.** Chrome SWs
   reject it at runtime. `vite.config.background.ts` sets
   `inlineDynamicImports: true`; additionally **never set
   `env.backends.onnx.wasm.wasmPaths`** — any override forces onnxruntime-web
   down its dynamic-import glue-loading path. Left unset, it uses the
   bundler-inlined glue and the Vite-emitted `.wasm` asset.
2. **Chrome background must be an ES module** (`"type": "module"` in
   manifest, `format: 'es'` in Vite): ORT resolves its `.wasm` asset against
   `import.meta.url`, and Vite's IIFE fallback uses `document.baseURI` —
   `document` doesn't exist in a SW. Firefox stays IIFE (its background event
   page HAS a `document`); the **offscreen** bundle is also IIFE (the offscreen
   document HAS a `document`, so `document.baseURI` resolves the `.wasm`).
3. **Cross-browser API**: always `import { api } from '../shared/api'`, never
   bare `chrome.*` — Firefox's promise APIs live on `browser.*`.
4. **MV3 listeners** must be registered synchronously at SW startup
   (top level of `index.ts`); async message handlers use
   `sendResponse` + `return true` (returning a Promise does NOT work in Chrome).
5. **CSP needs `'wasm-unsafe-eval'`** (both manifests) or WASM compile throws.
6. Pipeline = `@huggingface/transformers@3.8.1` **pinned**: the official
   extension example still uses v3; v4 is a runtime rewrite, unproven in MV3
   SWs. Don't bump casually.
7. **Offscreen (Chrome/Edge only).** The model runs in `offscreen.html` so it
   survives SW idle. `chrome.offscreen` needs the `"offscreen"` permission and
   a valid `reasons` enum value (`WORKERS`). The offscreen doc keeps the SAME
   wasm constraints (#1) — its Vite pass also sets `inlineDynamicImports` and
   never touches `wasmPaths`. **Do NOT put a tight `<meta>` CSP in
   `offscreen.html`** (e.g. `default-src 'none'`) — it would block fetching the
   bundled `.wasm` from the `chrome-extension://` origin; rely on the manifest's
   `extension_pages` CSP. Firefox has no offscreen API → it stays on the
   in-process path (`classify-client.ts` `supportsOffscreen()` gate). CacheStorage
   is origin-scoped, so the SW and offscreen doc SHARE the `transformers-cache`.

## Model facts (from scripts/smoke-test.mjs runs, 2026-06)

- Default: `Xenova/nli-deberta-v3-xsmall` q8 (~70MB download, cached via
  Cache API): 9/10 on realistic titles, ~60-100ms/title in Node.
- Rejected: `Xenova/mobilebert-uncased-mnli` q8 (27MB): only 5/10 — called
  "React Router Tutorial" *gaming*.
- Known ceiling: tiny NLI models don't know newer proper nouns —
  "Elden Ring Boss Fight" → sports. Kept in TEST_TITLES deliberately.
- Zero-shot = one forward pass per label (8 labels = 8 inferences/title);
  trimming labels is a linear speedup.
- **Richer-signal caveat (Phase 2 finding).** Feeding channel + description into
  the model is now plumbed end-to-end (`extractMeta` → `buildClassifierText`),
  and the e2e proves the path, but on this tiny model it does NOT reliably fix
  proper-noun blindness — the enriched smoke cases score ~1/4. Enrichment is
  double-edged: e.g. "Elden Ring … FromSoftware soulslike" classifies as
  *programming* because **"FromSoftware" contains the token "Software."** The
  real fix is a stronger model (Phase 3), not more context on this one. Note the
  smoke-test script DEFAULTS to the rejected `mobilebert`; pass
  `Xenova/nli-deberta-v3-xsmall` to test the model the extension actually ships.

## Gotchas

- SW idle cold-start (the 1-3s `loadMs` reload) is FIXED on Chrome/Edge by the
  offscreen document (e2e shows `load 0ms` on warm-but-uncached titles). Firefox
  still pays it (no offscreen API) — keepalive there is future work.
- Firefox may lack the Cache API in extension contexts; both `classifier.ts` and
  `offscreen.ts` probe and fall back to per-session model downloads (warns).
- The title cache (storage.local `titleCache`) makes repeat classifications
  ~0ms — clear storage when re-testing latency. The cache key now spans every
  signal (`inputCacheKey`: title+channel+context), not just the title.
- Settings + overrides are storage.local-backed with in-memory caches
  invalidated via `storage.onChanged`; on Chrome the model code is bundled into
  BOTH `background.js` and `offscreen.js` (the in-process path is just never
  taken there) — a known size trade-off, not a bug.
