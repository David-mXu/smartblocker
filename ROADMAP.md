# FlowGuard Roadmap

FlowGuard is a smart distraction blocker. A zero-shot text-classification model
runs **100% locally in the browser** (Transformers.js + ONNX WASM) and classifies
each page *title* — so "React Router Tutorial" passes while "I spent 100 days in
Hardcore Minecraft" gets blocked. It now watches **every `http(s)` site except a
user-editable whitelist** (Cold-Turkey-style "allow these, block the rest"; seeded
with safe defaults). The pitch: **stop blocking the whole internet; start blocking
your bad habits.**

This file is the canonical, in-repo roadmap. It exists because an earlier version
of the plan lived only outside the repo and was lost; keep it here and current.

---

## Phase 1 — Proof of Concept ✅ (done 2026-06-12)

Proves the hard parts are possible:

- Transformers.js zero-shot classification running inside a Manifest V3 background
  (service worker on Chrome/Edge, event page on Firefox), fully local — nothing
  leaves the machine.
- Tri-browser dual-target build: `dist/chrome` (also Edge) + `dist/firefox`.
- Local history scan + category histogram (popup → "Scan History").
- SPA-aware live page-visit classification fast enough to block "instantly", with a
  latency log breaking down page-title lag / model load / inference / injection.
- Framework-less diagnostic popup (Test Pair, Scan History, Latency Log).

**Default model:** `Xenova/nli-deberta-v3-xsmall` q8 (~70 MB, cached) — 9/10 on
realistic titles, ~60–100 ms/title in Node.

**Known ceiling (carried into Phase 2):** tiny NLI models don't recognize newer
proper nouns — "Elden Ring Boss Fight" classifies as *sports*. The Phase 2 fix is
richer page signals (channel name, description), not a bigger model.

---

## Phase 2 — Ambient MVP ✅ (implemented 2026-06-13, v0.2.0)

Turned the POC into something a real user configures and lives with. Four fronts,
built by a coordinated agent team against a shared foundation (typed settings store
+ expanded message contract). All four are integrated; `typecheck`, dual-target
`build`, and the real-Chromium `e2e` pass.

1. **Onboarding + user-configurable categories.** ✅ First-run opens a settings
   page (`src/options/`, `options_ui`) with category block toggles, a threshold
   slider, a master enable switch, and a history-scan helper. Every hardcoded knob
   in `config.ts` is now a `storage.local`-backed `Settings` object
   (`src/shared/settings.ts`) read live by the classifier/blocker.

2. **Richer classifier signals.** ⚠️ *Plumbed, accuracy inconclusive.* Channel +
   description/post-body snippets are scraped from the DOM (`extractMeta`),
   assembled (`buildClassifierText`), and fed to the model; the cache key widened
   to `{ title, channel, context }`. The path is proven by the e2e, **but on the
   current tiny NLI model it does not reliably fix proper-noun blindness** — the
   enriched smoke cases score ~1/4, and enrichment can even backfire (e.g.
   "FromSoftware" contains "Software" → *programming*). The real fix is a stronger
   model — carried into Phase 3 as an open problem.

3. **Service-worker cold-start fix.** ✅ The Transformers pipeline now runs in an
   **offscreen document** (`src/background/offscreen/`) on Chrome/Edge; the SW is a
   thin RPC client (`classify-client.ts`). The e2e confirms warm-but-uncached
   classifications show `load 0ms` (no reload). Firefox keeps the in-process path
   (no offscreen API).

4. **Full block screen + override.** ✅ `blockscreen.ts` (replacing `overlay.ts`)
   shows the category + a **"This is actually productive — let me through"**
   override; corrections are stored (`src/shared/overrides.ts`) so the same title
   is allowed thereafter — lightweight "teaching" without on-device fine-tuning.

Done alongside: `version` → 0.2.0, `CLAUDE.md` + `README.md` updated.

---

## Phase 2.5 — All sites + whitelist ✅ (v0.3.0)
/
Flipped the watch model from YouTube/Reddit-only to **every `http(s)` site except a
user whitelist** (Cold-Turkey-style "allow these, block the rest").

- `host_permissions` → `<all_urls>` (both manifests). The YT/Reddit `WATCHED_HOST`
  and `isContentUrl` gates are gone; the blocker arms any classifiable tab
  (`isClassifiableUrl`) and exempts whitelisted hosts (`isWhitelisted`, domain +
  subdomain match) before classifying.
- New `whitelist` setting (`config.ts` `DEFAULT_WHITELIST` seeds search/mail/docs/
  dev-work tools/localhost), editable from a textarea on the options page.
- History scan generalized to all history, filtered by the same gates.
- `extractMeta` gains a generic `og:`/`description` fallback for non-YT/Reddit pages.
- Caveat carried forward: classifying every page is ~8 inferences per visited page
  and the tiny model is error-prone on arbitrary content — the whitelist, threshold,
  and override button are the mitigations; the real fix is the Phase 3 model upgrade.

---

## Phase 2.6 — More categories + deterministic blocklist ✅

Cold-Turkey-style category coverage plus a second, non-ML blocking layer for
unambiguous cases — the two complement each other: the NLI classifier handles
nuanced sites (YouTube/Reddit mix productive and distracting content), the
blocklist handles sites/searches the user wants blocked with zero ambiguity.

- `LABELS` grows from 8 to 13: `online shopping`, `social media and
  networking`, `gambling and betting`, `movies and tv shows`, `adult content`.
  Four of the five are blocked by default (`BLOCKED_LABELS`); `movies and tv
  shows` ships unchecked, same treatment as `music`/`sports`, since it's the
  most debatable addition. Options page needed no code changes — category
  checkboxes already render dynamically from `settings.labels`.
- New opt-in `blocklist` setting (empty by default): free-text entries matched
  as a substring against the full URL + page title (`matchedBlocklistEntry` in
  `titles.ts`). Covers "block this domain" and "block searches containing X"
  with one mechanism, since search queries live in the URL's query string. A
  match skips the ML classifier entirely and blocks instantly — mirrors how
  `isWhitelisted` already short-circuits, just for the opposite outcome.
  Wired into the live blocker (`blocker.ts`) and the history scanner
  (`history-ingester.ts`); editable from a new textarea on the options page.
- Latency cost accepted: 13 labels ≈ 120-140ms/title in Node vs ~90-100ms at
  8 (see CLAUDE.md Model facts) — not optimized away per user decision.

---

## Phase 2.7 — Model bake-off: embedding-prototype classifier ✅ (2026-07-02)

Resolved the open Phase 3 model-quality problem with data. Built a real eval
(`scripts/eval-dataset.json`, 223 hand-checked cases incl. a 56-title
productive-negative set + enriched-signal variants) and a benchmark harness
(`scripts/benchmark.mjs`) reporting the metrics that matter for a blocker:
productive false-positive rate, must-block recall, top-1, latency.

Bake-off results (threshold 0.5, q8, Node):

| candidate | top-1 | productive FP | must-block recall | p50 |
|---|---|---|---|---|
| nli-deberta-v3-xsmall (was shipping) | 65.2% | 7.1% | 31.9% | 111ms |
| nli-deberta-v3-small | 61.6% | 3.6% | 33.3% | 107ms |
| embed all-MiniLM-L6-v2 (temp .05) | 78.0% | 3.6% | 72.5% | 2ms |
| **embed bge-small-en-v1.5 (temp .03)** | **87.8%** | **1.8%** | **75.4%** | **3ms** |

**Shipped: `CLASSIFIER_BACKEND = 'embed'`** — `Xenova/bge-small-en-v1.5`
(~34MB, half the NLI download) embeds the page text ONCE (label count is
free), classified by cosine similarity against per-category centroid
embeddings (seed texts in `src/shared/prototype-seeds.json`, math in
`prototypes.ts`) plus neutral "productive" centroids that can never block.
Softmax temp 0.03 calibrated so the natural operating point sits at the
existing 0.5 threshold. It also fixes proper-noun blindness the honest way:
"Elden Ring Boss Fight" → video games at 0.89. The NLI path remains as a
config fallback (`'nli'`). Real-Chromium e2e: 9-15ms/title live (was ~150ms).

Strategic unlock: centroids are updatable at runtime — user corrections fold
into them (`feedback.ts getPrototypeExamples`), i.e. genuine on-device
learning with no fine-tuning (Phase 2.8).

---

## Phase 2.8 — Feedback loop + offscreen resurrection ✅ (2026-07-02, v0.4.0)

**Feedback loop** (accuracy improves from real usage, privacy-first):

- Rich correction records (`src/shared/feedback.ts`, local, capped at 500):
  block-screen override → false positive; new popup "Should've been blocked"
  report (with category picker) → false negative. Hostname only, never URLs.
- Corrections TEACH the classifier: false negatives extend the corrected
  category's centroid, false positives feed a "user approved" neutral
  centroid — on-device personalization with zero fine-tuning.
- Options page Feedback section: count, Export JSON (attach to a GitHub
  issue), Clear, and an **opt-in** "share my corrections" toggle
  (`shareFeedback`, default OFF). A daily alarm uploads unsent records to
  `feedback-worker/` (Cloudflare Worker + D1; validated, idempotent, tested
  against a stubbed D1). `PRIVACY.md` documents the exact data flow.
  **Deploy is a manual step**: create the D1 db, `wrangler deploy`, then set
  `FEEDBACK_ENDPOINT` in `config.ts` (empty = uploads hard-disabled).
- Shared/exported records feed `eval-dataset.json` → future model decisions.

**Offscreen resurrection.** The Phase 2 cold-start fix had never actually run:
Chrome 138+ added a `browser` global (breaking the `IS_FIREFOX` detection), and
transformers.js defaults ORT `wasmPaths` to a CSP-blocked CDN outside service
workers. Fixed (Firefox-only-API detection; extension-local glue + ES-module
offscreen bundle) — Chrome/Edge now truly host inference in the offscreen doc
(~11ms/embed, verified via `getContexts`).

**Latency probes** (Track D findings, recorded for posterity): WASM
`numThreads=4` → p50 11ms→8.8ms, not worth 3 worker threads (kept 1); WebGPU
has no adapter in headless Chromium and is irrelevant at ~10ms/title;
SharedArrayBuffer IS available in extension pages without cross-origin
isolation (Chrome exempts extensions) if threading is ever revisited.

---

## Phase 2.9 — Lock system (Cold-Turkey-style commitment) ✅ (2026-07-03, v0.5.0)

The first half of the Phase 4 vision, extension-side: once you lock FlowGuard,
willpower failures can't unlock it. Four mechanisms, all composable
(`src/shared/lock-math.ts` for the pure time math, `src/shared/lock.ts` for
storage + the only legal transitions, `src/background/lock-enforcer.ts` for
alarm/sweep wiring):

- **Timer lock** — "lock settings for N hours/days" from the options page.
- **Password lock** — indefinite until the password is re-entered (salted
  SHA-256 via `crypto.subtle`). Cold Turkey's "type this random string"
  friction gate was considered and deferred: paste can't be reliably blocked
  in a page we own, so it adds UI without adding friction.
- **Scheduled blocks** — recurring windows (day-of-week + start/end, overnight
  supported) during which blocking is forced on and settings are frozen.
- **Frozen Turkey** — one-click "block for the next 1/4/8 hours" in the popup,
  uncancellable once started (no code path shortens it).

Two-tier enforcement model:

- `settingsLocked` (ANY source active): `setSettings` THROWS (single choke
  point — options controls are also disabled with a countdown banner), the
  block screen loses its override/dismiss buttons, and `OVERRIDE` messages are
  dropped in the background (a locked block screen has no override button, so
  any arriving is stale/forged — the false-positive feedback record is dropped
  too, since it would loosen the classifier via the neutral centroid).
- `forceBlocking` (Frozen Turkey or in-window schedule): blocking runs even if
  the master toggle is off, and stored overrides are ignored. A plain
  timer/password lock keeps honoring stored overrides (they're accuracy
  corrections, not bypasses). The whitelist always applies — work sites stay
  usable. When forced blocking starts mid-session, the enforcer sweeps
  already-open tabs (`sweepOpenTabs`).

Design facts that matter later:

- Lock state lives in its OWN storage key (`lockState`), never inside
  `Settings` — the settings guard can't be patched away through the door it
  guards. Transitions are monotonic: extend always, shorten never (password
  unlock clears only the password source; a running Frozen Turkey survives it).
- Correctness never depends on alarms: every check re-derives activeness from
  `Date.now()` vs stored timestamps (MV3 SWs sleep). The one-shot
  `lock-boundary` alarm is promptness-only (tab sweep at window start).
- **This is a soft lock**: devtools raw-storage writes, uninstalling the
  extension, and OS clock changes bypass it. Accepted and documented — the
  Phase 4 desktop companion reads/enforces this same `lockState` key over
  Native Messaging and becomes the hard enforcer (policy force-install so the
  extension can't be removed while locked).
- Tests: `scripts/lock-math-test.mjs` (28 pure-math cases incl. overnight +
  week-wraparound) + e2e section 6 (frozen turkey vs master-off, bypass
  buttons gone, override ignored, options frozen).

---

## Phase 3 — Public beta

- ~~Open problem carried from Phase 2: model quality.~~ **Resolved in
  Phase 2.7** by the embedding-prototype backend (see table above). Remaining
  model work is dataset-driven: grow `eval-dataset.json` from real feedback.
- Open-source GitHub release + Chrome Web Store beta listing (needs a privacy
  policy — `PRIVACY.md` exists; deploy `feedback-worker/` and set
  `FEEDBACK_ENDPOINT` before the listing if opt-in sharing should be live).
- Watch RAM/battery, false-positive rate, and model download UX in the wild.
- Telemetry-free by default; the ONLY network write is the explicit opt-in
  feedback sharing (off by default, hostname-only records — see PRIVACY.md).
  All classification + history analysis remain local.
- Marketing: Show HN, r/ADHD, r/productivity, Product Hunt. Hook: *"Stop blocking
  the whole internet. Start blocking your bad habits."*

---

## Phase 4 — Paid Pro (tamper-proof companion)

- Free extension + paid "Pro" hardcore mode. The lock UX already exists
  (Phase 2.9); this phase makes it tamper-proof.
- Tauri/Rust desktop companion (Windows first) with a Native Messaging bridge:
  reads the extension's `lockState` key, holds a mirror of it outside the
  browser, heartbeats the extension and reacts if it goes silent.
- Managed-policy tamper-proofing (`ExtensionInstallForcelist` — the extension
  can't be disabled/removed while locked), hosts-file/proxy fallback blocking.
- $39 lifetime license (Stripe / Lemon Squeezy).

---

## Engineering ground rules (carried across phases)

These keep the extension from breaking; full detail in `CLAUDE.md`.

- No reachable dynamic `import()` in any bundle loaded by a service worker; never
  set `env.backends.onnx.wasm.wasmPaths` (forces ORT's dynamic-import glue path).
- Chrome background is an ES module; the offscreen document has a real `document`.
- Cross-browser only through the `api` shim (`src/shared/api.ts`) — never bare
  `chrome.*`. Branch Chrome vs Firefox wherever APIs diverge (offscreen, options).
- MV3 listeners registered synchronously at SW startup; async responders use
  `sendResponse` + `return true`.
- CSP keeps `'wasm-unsafe-eval'`. `@huggingface/transformers` pinned to `3.8.1`.
- Everything must work on Chrome, Edge, **and** Firefox. Commit + push at each
  milestone for visible incremental progress.
