# FlowGuard

Smart distraction blocker: a fully-local AI model classifies page titles and
blocks off-topic content without blocking whole sites.
**FlowGuard watches every `http(s)` site except the user's whitelist** (domain +
subdomain match, seeded with a safe default list in `config.ts`
`DEFAULT_WHITELIST`; user-editable on the options page). It also supports an
**opt-in deterministic blocklist** (`config.ts`/`settings.ts` `blocklist`,
empty by default): substring matches against the URL + title skip the ML
classifier entirely and block instantly. **The full multi-phase roadmap lives
in `ROADMAP.md`.** Implemented through Phase 2.9: user-configurable categories
+ onboarding, richer page signals, the **embedding-prototype classifier**
(2026-07 bake-off winner — see Model facts), a block screen with a "this is
actually productive" override, a **feedback loop** (corrections are stored
locally, teach the classifier via centroid updates, and can be exported or —
opt-in, off by default — shared to a Cloudflare Worker; see `PRIVACY.md`),
and the **Cold-Turkey-style lock system** (timer/password locks, scheduled
blocks, popup "Frozen Turkey" sessions — soft locks; see `lock.ts` and
ROADMAP Phase 2.9). Phase 4's **desktop companion** (`companion/`, Rust) is
the paid HARD enforcer of the same lock state over Native Messaging: watchdog
closes browsers running without a responsive extension during a lock, closes
incompatible browsers and blocklisted apps, and survives extension wipes
(states merge monotonically — see companion/README.md).

Remote: `origin = github.com/David-mXu/smartblocker.git` (push with plain `git`;
`gh` CLI is not installed).

## Commands

- `npm run build` — build both targets: `dist/chrome` (also Edge) + `dist/firefox`
- `npm run build:chrome` / `npm run build:firefox` — single target
- `npm run typecheck` — `tsc --noEmit`
- `npm run eval` (`scripts/eval.mjs`) — **THE regression gate.** Runs the
  SHIPPED config over `scripts/eval-dataset.json` (395 cases: 274 `v1` +
  121 url-bearing `v2`), scores the real block/allow decision (whitelist →
  blocklist → threshold, not just classifier top-1), and diffs every case
  against the committed `scripts/eval-baseline.json`. Prints what FIXED and
  what REGRESSED by name; **exits non-zero on any regression**. Accept new
  results with `--update-baseline` — the git history of `eval-baseline.json`
  IS the score history. `--verbose` lists every failing case.
  `--capture` (opt-in, network) re-scrapes live pages for cases with a `url`
  using the REAL `extract-meta.ts` under Playwright and writes the result to
  each case's `captured` field; `--limit=N`/`--only=<substr>` narrow it.
  Cases flagged `noCapture` are skipped (dead URL, or the site bot-walls
  headless Chromium) and stay on their hand-authored `input`.
- `node scripts/benchmark.mjs <nli:modelId | embed:modelId>` — the model
  **bake-off** tool: runs a CANDIDATE model against the same dataset and
  reports top-1, productive-FP rate, must-block recall, e2e decision
  accuracy, latency, and a threshold sweep. Use this to compare candidates;
  use `npm run eval` to check the shipped config for regressions.
  Flags: `--template=N` (NLI hypothesis variants), `--temp=T` (embed softmax
  temperature), `--verbose`.
- `node scripts/import-feedback.mjs <export.json | --from-worker …>` — turns
  real user corrections into **candidate** eval cases in
  `scripts/feedback-candidates.json` (gitignored review queue). Dedupes
  against the eval set, refuses anything colliding with `prototype-seeds.json`
  (train/test split), and groups by how many distinct installs agree.
  It NEVER writes `eval-dataset.json` or `prototype-seeds.json` — a human
  moves each candidate to exactly one side.
- `node scripts/smoke-test.mjs [modelId]` — quick NLI-only sanity check
  (defaults to the legacy NLI model; the shipped backend is `embed`).
- `node scripts/lock-math-test.mjs` — pure-math unit tests for the lock
  system's schedule/expiry derivations (`src/shared/lock-math.ts`, imported
  directly via Node type stripping — keep that file erasable-syntax-only).
- `node scripts/e2e-test.mjs` — full e2e in a real Chromium (Playwright):
  boots the SW, runs Test Pair, fakes YouTube pages via network interception
  to verify block/allow + latency + feedback capture, seeds and runs the
  history scan. First run downloads the model into `.e2e-profile/` (~35MB,
  persists across runs). Occasionally the extension fails to load on launch;
  the script relaunches automatically (up to 3×).
- `node feedback-worker/test/local-test.mjs` — feedback ingestion worker
  tests against a stubbed D1 (no Cloudflare account needed).
- `cd companion && cargo test && cargo clippy --all-targets -- -D warnings &&
  cargo fmt --check` — the companion gate (Rust; needs `. ~/.cargo/env`).
  NEVER `--workspace` here: it would drag in the Tauri crate, which cannot
  even compile without webkit2gtk (Windows-only build, see companion/README).
- `node scripts/e2e-companion-test.mjs` — full companion loop in a real
  Chromium: builds the bins, registers a real NM manifest in `.e2e-profile/
  NativeMessagingHosts/`, runs a scratch daemon (`FLOWGUARD_SOCKET` env picks
  the socket; inherited by the browser-spawned relay), asserts lock sync both
  directions + fake app/browser kills. Run the plain e2e first (warm model).

Run typecheck + build + e2e before considering any background change done
(+ `npm run eval` when anything touching classification changed: seeds,
config, `extract-meta.ts`, `url-signals.ts`, `build-input.ts`, `prototypes.ts`;
+ the cargo gate and companion e2e when `companion/` or the bridge changed).
Commit and push when appropriate.

## Architecture

- `src/background/` — MV3 background.
  - `classifier.ts` — the classify() entry point: title cache + verdict
    assembly + **backend switch** (`config.ts` `CLASSIFIER_BACKEND`):
    - `'embed'` (shipped): ONE feature-extraction pass per title, cosine
      similarity vs per-category **centroid embeddings** + softmax
      (`prototypes.ts`). Centroid vectors are cached in storage.local
      (`centroidCache`), version-keyed over model id + active labels + seed
      and user-correction texts — any change rebuilds them (~2.5s, one-time).
    - `'nli'` (legacy fallback): zero-shot NLI, one pass PER label.
    On Chrome/Edge inference runs in the **offscreen document** via
    `classify-client.ts` (`EMBED`/`CLASSIFY` RPC); on Firefox in-process.
  - `classify-client.ts` — SW-side offscreen RPC: `supportsOffscreen()`,
    `classifyViaOffscreen(text, labels)`, `embedViaOffscreen(texts)`.
  - `offscreen/offscreen.{html,ts}` — Chrome-only document that HOSTS the
    Transformers pipelines (pure inference; no caching/settings). Survives SW
    idle. ES-module bundle + local `wasmPaths` override (see constraint #7).
  - `blocker.ts` — SPA-aware nav/title listener; arms ANY `http(s)` tab
    (`isClassifiableUrl`), exempts whitelisted hosts (`isWhitelisted`), then
    checks the deterministic blocklist (`matchedBlocklistEntry`) — a hit skips
    straight to the block screen with no inference. Otherwise gathers richer
    signals (`extractMeta`), classifies, checks settings + overrides, injects
    `blockscreen.ts`.
  - `blockscreen.ts` — injected full block screen; the override button sends
    `OVERRIDE` with title + label + score (→ override store + a rich
    false-positive feedback record). Takes a `locked` flag: when a lock is
    active the override/dismiss buttons are not rendered (only "close tab").
  - `lock-enforcer.ts` — lock-system wiring: one-shot `lock-boundary` alarm at
    the next lock start/end (promptness-only — correctness always re-derives
    from timestamps) + a `lockState` storage.onChanged listener that wakes the
    SW and `sweepOpenTabs()` when forced blocking starts mid-session.
  - `feedback-uploader.ts` — daily `alarms`-driven opt-in uploader: only when
    `settings.shareFeedback` (default OFF) AND `config.ts FEEDBACK_ENDPOINT`
    (empty = disabled) are set; batches unsent records + random resettable
    `installId` to the worker, marks them uploaded.
  - `companion.ts` — Native-Messaging bridge to the desktop companion:
    `connectNative('dev.davidxu.flowguard')`, hello + lockStateSync on
    connect, 20s heartbeats, incoming state → `mergeRemoteLockState` (the
    storage write wakes `lock-enforcer.ts` — zero enforcement code here).
    Host-not-found = silent free-tier no-op (retry on SW start + daily
    alarm); while connected a 30s `companion-keepalive` alarm revives the SW
    if Chrome reaps it despite the open port (else the companion watchdog
    would false-positive). Snapshot cached in storage.local
    `companionSnapshot` for the options page (`GET_COMPANION_STATUS`).
  - `history-ingester.ts` scans chrome.history; `index.ts` wires listeners,
    first-run onboarding, and the `OVERRIDE` / `REPORT_FN` / `CLOSE_TAB`
    handlers.
- `src/popup/` — framework-less diagnostic UI (test pair, history scan,
  latency log) + **"Should've been blocked"** false-negative report (category
  picker; sends `REPORT_FN` for the active tab).
- `src/options/` — settings + onboarding page: category block toggles,
  threshold slider, master enable, whitelist/blocklist textareas, history-scan
  helper, and the **Feedback section** (record count, Export JSON, Clear,
  opt-in share toggle).
- `src/content/extract-meta.ts` — self-contained injected function that scrapes
  channel/subreddit + description snippet from the page DOM; falls back to
  `og:site_name`/`og:description`/`description` meta on generic sites. On
  generic sites it also derives a **page-kind hint** from `og:type` + JSON-LD
  `@type` ("Online store product page.", "Movie or TV show page.", …)
  prepended to the context (so it survives the 200-char trim), and uses the
  `<h1>` as context when the page has no description meta.
- `src/shared/` — `config.ts` (DEFAULTS: backend, model ids, softmax
  temperature, 13 `LABELS`, thresholds, `DEFAULT_WHITELIST`,
  `FEEDBACK_ENDPOINT`), `settings.ts` (user-overridable `Settings` incl.
  `whitelist`, `blocklist`, `shareFeedback` — the runtime source of truth),
  `prototypes.ts` (centroid specs from `prototype-seeds.json` + similarity
  math; neutral centroids get a `neutral: ` label prefix and can never block;
  user-added custom categories get a label-text fallback centroid),
  `prototype-seeds.json` (per-category seed texts — keep DISJOINT from
  `eval-dataset.json`, that's the train/test split), `feedback.ts`
  (FP/FN correction store; `getPrototypeExamples()` folds corrections into
  centroids = on-device learning), `overrides.ts` (title-only allow store),
  `build-input.ts` (`buildClassifierText` + `inputCacheKey(input, modelKey)`),
  `api.ts` (cross-browser shim + `IS_FIREFOX`), `messages.ts` (message
  contract), `titles.ts` (URL gates + `cleanTitle`), `url-signals.ts`
  (`hostnameOf` + `urlPathHint` + `applyUrlSignals` — URL-derived hints; in
  shared/ NOT background/ so the offline evaluator builds classifier input
  through the same code the blocker uses), `lock-math.ts` (pure
  lock/schedule time math — no browser APIs, Node-testable; also
  `mergeLockStates` + `sanitizeLockState`, MIRRORED in the companion's
  `merge.rs`/`lock_math.rs` — change both together, parity enforced by
  `companion/crates/flowguard-core/tests/fixtures/lock-cases.json` which both
  test suites consume), `lock.ts` (the `lockState` store + the ONLY legal
  lock transitions: timer/frozen extend-only, password arm/unlock, schedule
  editing refused while locked; `mergeRemoteLockState` is the companion's
  merge-only write path), `companion-protocol.ts` (NM wire types v1 —
  mirrored in `protocol.rs`, erasable-syntax-only).
- `feedback-worker/` — Cloudflare Worker (wrangler + D1). `POST /v1/feedback`
  ingests opt-in batches **unauthenticated** (every install would otherwise
  need a secret baked into a public bundle); `GET /v1/export` serves them back
  to `scripts/import-feedback.mjs` and **requires the `EXPORT_TOKEN` secret**
  — the table holds users' page titles, so bulk read must never be open, and
  an unconfigured deploy fails closed (503). NOT part of the extension build;
  deploy is manual (see wrangler.toml header; set `FEEDBACK_ENDPOINT` after
  deploying). **Not deployed yet** — `database_id` is still a placeholder and
  `FEEDBACK_ENDPOINT` is `''`, so no real records flow.
- `scripts/lib/eval-harness.mjs` — shared by `eval.mjs` and `benchmark.mjs`.
  Imports the REAL `src/shared` modules (config, prototypes, titles,
  build-input, url-signals) under Node type-stripping and never mirrors them;
  that is why `prototypes.ts` carries `with { type: 'json' }` on its seeds
  import. Owns the block-decision ladder and all metric math.
- `companion/` — the Phase 4 desktop companion (cargo workspace, NOT part of
  the extension build; see `companion/README.md`). `flowguard-core` = ALL
  logic (protocol/framing/lock math mirror/merge/store/enforcer/procwatch/
  ipc/daemon/registration/policy/license), `flowguard-nm-host` = the
  browser-spawned stdio↔IPC relay, `flowguard-daemon` = headless Linux/e2e
  face, `flowguard-companion` = Tauri shell (Windows; excluded from
  default-members). Extension IDs are pinned: chrome/edge
  `dhbhbhhcjkfdkfbloeaeedndfjfadajh` (from the committed manifest `"key"`;
  private key `flowguard-dev-key.pem` at repo root, gitignored — DO NOT
  lose it), firefox `flowguard-poc@davidxu.dev`.
- Build passes (one Vite config each, since `inlineDynamicImports` forbids
  multi-input): `vite.config.background.ts`, `vite.config.offscreen.ts`
  (chrome only), `vite.config.popup.ts`, `vite.config.options.ts`.
- `manifests/{chrome,firefox}.json` → `dist/<target>/manifest.json` via
  `scripts/copy-assets.mjs`, which ALSO hand-copies `offscreen.html` and the
  **unhashed ORT glue files** (`ort-wasm-simd-threaded.jsep.{mjs,wasm}`) for
  Chrome — the offscreen doc's `wasmPaths` override points at them.

## Load-bearing constraints (violate these and the extension breaks)

1. **No reachable dynamic `import()` in the background bundle.** Chrome SWs
   reject it at runtime. `vite.config.background.ts` sets
   `inlineDynamicImports: true`; additionally **never set
   `env.backends.onnx.wasm.wasmPaths` in the SW** — transformers.js leaves
   them unset only inside a ServiceWorkerGlobalScope and then uses the
   bundler-inlined glue + the Vite-emitted `.wasm` asset.
2. **Chrome background must be an ES module** (`"type": "module"` in
   manifest, `format: 'es'` in Vite): ORT resolves its `.wasm` asset against
   `import.meta.url`. Firefox stays IIFE (its background event page HAS a
   `document`). The **offscreen bundle is ALSO an ES module** — as an IIFE it
   sent ORT down the CDN dynamic-import path (see #7).
3. **Cross-browser API**: always `import { api } from '../shared/api'`, never
   bare `chrome.*`. **Chrome 138+ defines a `browser` global in MV3**, so
   `typeof browser !== 'undefined'` is NOT a Firefox test — that exact bug
   silently disabled the offscreen path for weeks. `IS_FIREFOX` checks
   `browser.runtime.getBrowserInfo` (Firefox-only API).
4. **MV3 listeners** must be registered synchronously at SW startup
   (top level of `index.ts`); async message handlers use
   `sendResponse` + `return true` (returning a Promise does NOT work in Chrome).
5. **CSP needs `'wasm-unsafe-eval'`** (both manifests) or WASM compile throws.
6. Pipeline = `@huggingface/transformers@3.8.1` **pinned**: v4 is a runtime
   rewrite, unproven in MV3 SWs. Don't bump casually.
7. **Offscreen (Chrome/Edge only).** Inference runs in `offscreen.html` so it
   survives SW idle. `chrome.offscreen` needs the `"offscreen"` permission and
   a valid `reasons` value (`WORKERS`). **Outside a service worker,
   transformers.js DEFAULTS `wasmPaths` to its jsdelivr CDN** — CSP-blocked in
   extensions ("Failed to fetch dynamically imported module … jsep.mjs") — so
   `offscreen.ts` MUST override `wasmPaths` to the extension-local glue copies
   shipped by `copy-assets.mjs` (the inverse of the SW rule in #1; dynamic
   import of a same-origin module is fine in a real document). **Do NOT put a
   tight `<meta>` CSP in `offscreen.html`**; rely on the manifest's
   `extension_pages` CSP. Firefox has no offscreen API → in-process path.
   CacheStorage is origin-scoped, so the SW and offscreen doc SHARE the
   `transformers-cache`.

## Model facts (scripts/benchmark.mjs, 2026-07 bake-off)

- **Shipped: embedding-prototype backend** — `Xenova/bge-small-en-v1.5` q8
  (~34MB), softmax temperature 0.026, threshold 0.5. One forward pass per title
  (label count is FREE), classified against centroids built from
  `prototype-seeds.json` + user corrections. Neutral "productive" centroids
  (work/docs/errands/accounts/career + user-approved) absorb non-distraction
  pages and can never block. NOTE: adding a centroid grows the softmax
  denominator and deflates every score — recalibrate the temperature (the
  0.03 → 0.026 move paid for the 18th centroid).
- Bake-off @0.5 threshold (223-case eval): **bge-small embed: 87.8% top-1,
  1.8% productive FP, 75.4% must-block recall, ~3ms/title (Node)** vs the old
  `nli-deberta-v3-xsmall`: 65.2% / 7.1% / 31.9% @ ~111ms. MiniLM-L6 embed:
  78.0% / 3.6% / 72.5% @ 2ms. `nli-deberta-v3-small`: no better than xsmall.
  Live in Chromium: ~9-15ms/title.
- The embedding backend fixes the old proper-noun ceiling honestly:
  "Elden Ring Boss Fight" → video games 0.89 (was: sports).
- 2026-07-02 seed tune (found via real usage: apple.com pages misread once
  og-description marketing copy was fed as context): brand-storefront +
  whiteboard/kanban seeds added. Both remaining productive FPs ("Pull
  requests · facebook/react" → social, "Sprint retro board | Miro" →
  shopping) are covered by DEFAULT_WHITELIST (github.com, miro.com) in
  practice.
- 2026-07-03 page-kind hint (`extract-meta.ts`): og:type + JSON-LD `@type`
  map to a short sentence ("Online store product page.") PREPENDED to the
  context on generic sites, plus an `<h1>` fallback when there's no
  description meta. Grounds spec-heavy marketing copy; 232-case eval:
  **89.1% top-1, 3.5% productive FP, 79.5% must-block recall @0.5**,
  shopping 22/22. `benchmark.mjs --temp` now defaults to config's
  SOFTMAX_TEMPERATURE (a hardcoded mirror — keep in sync) — running it at any
  other temp silently deflates/inflates every threshold metric.
- 2026-07-07 institutional fix (real usage: bank/gov/university sign-in and
  account pages blocked as social media — "Sign In", "Messages",
  "Notifications" titles are near-verbatim social seeds). Fixes, all at zero
  added latency: (1) `blocker.ts` URL signals — hostname as channel fallback
  + whole-segment path hints (/login → "Account sign-in page.", /checkout →
  shopping, /shorts|reels|feed → social; "watch" deliberately absent);
  (2) `extract-meta.ts` — institutional JSON-LD types (BankOrCreditUnion,
  GovernmentOrganization, …) map to page-kind hints CHECKED BEFORE product
  (banks declare credit-card Products), password-field probe emits the same
  sign-in sentence (blocker dedupes by substring), nav-link fingerprint
  ("Accounts · Transfers · …") used only when the description is <80 chars;
  (3) new neutral "accounts and sign-in" centroid + counter-seeds in
  social/shopping so login/checkout language doesn't leak. 274-case eval:
  **88.8% top-1, 2.1% productive FP (institutional slice 0), 80.5%
  must-block recall @0.5**. Deliberate policy: sign-in pages NEVER block —
  "Log in to Facebook" is eval'd as must-not-block (SSO popups share that
  title; the post-login feed still blocks).
- Remaining weak spots: sparse titles ("Home / X" → neutral), enriched
  marketing copy pulling toward spec-y categories (mitigated, watch it), and
  programming/science titles sometimes landing in neutral documentation/work
  centroids — harmless for blocking (neutral never blocks), visible in top-1.
- 2026-07-29 measurement overhaul + `v2` eval slice (121 url-bearing cases,
  104 grounded by real `--capture` scrapes). Metrics are reported PER SLICE so
  the v1 numbers above stay directly comparable; `v1` is unchanged at
  **88.8 / 2.1 / 80.5**. New figures: `v2` **83.6% top-1, 0.0% productive FP,
  62.8% must-block recall, 85.8% e2e**; combined (395 cases) **87.4% top-1,
  1.3% productive FP, 74.4% must-block recall, 91.0% e2e decision accuracy**.
  v2 is deliberately harder — real homepages/feeds, institutional pages, and
  whitelisted-host pages whose titles look distracting.
- **Auth-walled pages must not be capture-grounded.** Anonymous `--capture` of
  a logged-in surface (linkedin.com/feed, x.com/explore, pinterest search,
  roblox, 888casino, olg.ca) returns a sign-in interstitial, and
  `extract-meta.ts`'s password-field probe then prepends "Account sign-in
  page." — encoding "block this sign-in page" on a must-block case, the exact
  inverse of the never-block-sign-in policy. Those 6 carry `noCapture` and
  score on their authored input, which is what a signed-in user actually sees.
  Capture is ground truth ONLY where the anonymous view matches the user view;
  check new url-bearing cases for this before trusting a capture.
- **OPEN FINDING — threshold calibration.** 20 of the 32 combined must-block
  misses have the CORRECT top-1 label but score just under the 0.5 threshold
  (0.18–0.50; a cluster at 0.37–0.48). Richer captured context spreads softmax
  mass across centroids and deflates the max score, so real pages score lower
  than the terse hand-written v1 titles the temperature was calibrated on.
  Sweep (combined): @0.50 → 74.4% recall / 1.3% FP; @0.40 → 81.6% / 2.0%;
  @0.35 → 86.4% / 2.7%. Lowering the threshold (or re-tuning
  SOFTMAX_TEMPERATURE against the v2 slice) is the obvious next move — it is a
  product call about blocking aggressiveness, so it was left at 0.5.
- Improving the model is now dataset work, and it is mechanical: run
  `scripts/import-feedback.mjs` over real corrections → review
  `feedback-candidates.json` → move each case into `eval-dataset.json` (test)
  or `prototype-seeds.json` (train), never both → `npm run eval`.
- Legacy NLI facts: zero-shot = one pass per label; tiny NLI models miss newer
  proper nouns; enrichment can backfire ("FromSoftware" contains "Software" →
  programming). Kept in `TEST_TITLES` deliberately.

## Gotchas

- **The offscreen path was silently dead until Phase 2.8** (two stacked bugs:
  constraint #3's `browser` global + #7's CDN wasmPaths default). The
  in-process fallback masks such regressions — if you touch this, verify via
  `chrome.runtime.getContexts({})` showing `OFFSCREEN_DOCUMENT` and download
  logs NOT appearing in the SW console.
- Chromium caches the MV3 SW script in the profile's
  `Default/Service Worker/ScriptCache` and can keep running a STALE
  `background.js` after a rebuild — the e2e deletes that dir each run (keeps
  `CacheStorage/` = the model). Remember this when testing manually too.
- The title cache (storage.local `titleCache`) makes repeat classifications
  ~0ms — clear it when re-testing latency. Its key spans every signal PLUS
  the model key (backend + model id + centroid version), so model switches
  and user corrections never serve stale verdicts.
- User corrections change the centroid version → centroids rebuild and cached
  titles re-classify. That's by design (on-device learning), not a bug.
- Firefox may lack the Cache API in extension contexts; both `classifier.ts`
  and `offscreen.ts` probe and fall back to per-session model downloads.
- Settings + overrides + feedback are storage.local-backed with in-memory
  caches invalidated via `storage.onChanged`; on Chrome the model code is
  bundled into BOTH `background.js` and `offscreen.js` (the in-process path is
  just never taken there) — a known size trade-off, not a bug.
- SW idle cold-start on Firefox remains (no offscreen API) — keepalive there
  is future work.
- **`setSettings` THROWS while a lock is active** (`lock.ts` `settingsLocked`)
  — any new settings-writing UI must try/catch it. Lock transitions go through
  `lock.ts` ONLY (its own `lockState` storage key, monotonic: extend always,
  shorten never). Import direction is `settings.ts` → `lock.ts`, never the
  reverse (cycle). The lock is SOFT by design: devtools/uninstall/clock
  changes bypass it; the Phase 4 desktop companion is the hard enforcer.
- **Companion sync must stay loop-free**: every side (extension `lock.ts`,
  daemon `merge_in`) persists + re-broadcasts a received lock state ONLY if
  the merge changed it. The merge is commutative/idempotent/monotonic — if
  you touch it, change `lock-math.ts` AND `merge.rs` together and extend the
  shared fixtures, or the two stores drift and never converge.
- **Companion connections are only "a browser" after hello.** The nm-host
  relay caches the browser's hello and REPLAYS it when it reconnects to a
  restarted daemon (the extension never re-hellos on a daemon bounce);
  the daemon pushes companionStatus to every fresh IPC connection for the
  same reason. Remove either half and the watchdog will suspect (and
  eventually close) a perfectly healthy browser after a daemon restart.
  UI clients deliberately DON'T hello, so they can't mask a dead extension.
- The companion e2e runs the daemon with REAL kills: fake processes are
  copies of /bin/sleep named `fakegame`/`fakebrowser` (exe-stem matching —
  Linux `Process::name()` truncates at 15 chars, so procwatch reads exe()).
  The test's own Chromium is safe because its extension heartbeats.
