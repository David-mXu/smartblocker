# FlowGuard (Phase 1 POC)

Smart distraction blocker: a fully-local AI model classifies YouTube/Reddit
page titles (zero-shot) and blocks off-topic content without blocking whole
sites. This repo is the Phase 1 proof-of-concept; the long-term roadmap
(onboarding UI, session-context detection, paid tamper-proof desktop
companion) lives in the plan, not here yet.

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

- `src/background/` — MV3 background. `classifier.ts` holds ALL the
  Transformers.js risk (singleton pipeline + env config + title cache);
  `blocker.ts` is the SPA-aware navigation/title listener + latency log;
  `history-ingester.ts` scans chrome.history; `index.ts` wires listeners.
- `src/popup/` — framework-less diagnostic UI (test pair, history scan, latency log).
- `src/shared/` — `config.ts` (every tuning knob: model id, labels, thresholds),
  `api.ts` (cross-browser shim), `messages.ts` (popup⇄background contract),
  `titles.ts` (URL/title filters).
- `manifests/chrome.json` + `manifests/firefox.json` → copied to
  `dist/<target>/manifest.json` by `scripts/copy-assets.mjs`.

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
   page HAS a `document`).
3. **Cross-browser API**: always `import { api } from '../shared/api'`, never
   bare `chrome.*` — Firefox's promise APIs live on `browser.*`.
4. **MV3 listeners** must be registered synchronously at SW startup
   (top level of `index.ts`); async message handlers use
   `sendResponse` + `return true` (returning a Promise does NOT work in Chrome).
5. **CSP needs `'wasm-unsafe-eval'`** (both manifests) or WASM compile throws.
6. Pipeline = `@huggingface/transformers@3.8.1` **pinned**: the official
   extension example still uses v3; v4 is a runtime rewrite, unproven in MV3
   SWs. Don't bump casually.

## Model facts (from scripts/smoke-test.mjs runs, 2026-06)

- Default: `Xenova/nli-deberta-v3-xsmall` q8 (~70MB download, cached via
  Cache API): 9/10 on realistic titles, ~60-100ms/title in Node.
- Rejected: `Xenova/mobilebert-uncased-mnli` q8 (27MB): only 5/10 — called
  "React Router Tutorial" *gaming*.
- Known ceiling: tiny NLI models don't know newer proper nouns —
  "Elden Ring Boss Fight" → sports. Kept in TEST_TITLES deliberately.
- Zero-shot = one forward pass per label (8 labels = 8 inferences/title);
  trimming labels is a linear speedup.

## Gotchas

- Service worker dies after ~30s idle → next classification pays a 1-3s
  pipeline reload (`loadMs` in the latency log isolates this). Phase 2 fix:
  offscreen document or keepalive.
- Firefox may lack the Cache API in extension contexts; `classifier.ts`
  probes and falls back to per-session model downloads (warns in console).
- The title cache (storage.local `titleCache`) makes repeat classifications
  ~0ms — clear storage when re-testing latency.
