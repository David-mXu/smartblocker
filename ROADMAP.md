# SmartBlocker Roadmap

SmartBlocker is a smart distraction blocker. A zero-shot text-classification model
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

The first half of the Phase 4 vision, extension-side: once you lock SmartBlocker,
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

## Phase 3 — Public beta — code ✅ (2026-11-05); external launch ops remaining

- ~~Open problem carried from Phase 2: model quality.~~ **Resolved in
  Phase 2.7** by the embedding-prototype backend (see table above), then
  pushed far beyond it in the 2026-10/11 dataset + classifier passes:
  - **v3–v8 dataset expansion:** `eval-dataset.json` grew from 395 to
    **15,874 cases** (615 `v3` multi-context + 1,195 `v4` adversarial +
    4,543 `v5` multilingual/boundary/focus + 4,199 `v6` SERP &
    chatbot-embed + 2,443 `v7` lexical-twin/focus/global + 2,484 `v8` dense
    gaming/spec-stores/statutory-law), mined by agent swarms and kept
    train/test-disjoint from the **518** support-vector seed texts by
    `scripts/verify-dataset.mjs`.
  - **Multi-prototype System 1 head + Focus Context:** 75% mean-centroid +
    25% weighted top-2 seed similarity, `effectiveBlockScore` top-2 blocked
    mass, and the gated `focusGoal` / `useTabContext` rescue centroid.
    Combined: **95.4% top-1, 0.4% productive FP, 97.6% must-block recall,
    98.7% e2e decision accuracy**.
  - **Blocking surface coverage:** direct sub-frame classification
    (`frameIds`), YouTube oEmbed resolution, open shadow-root traversal
    (closed roots are unreachable by design), and the two-pass
    SERP/chatbot-embed sanitizer (`src/content/sanitize-page.ts`).
- **UI refresh ✅ (2026-10-26):** React 19 + Tailwind CSS v4 + shadcn/ui +
  GSAP editorial surfaces (popup + options + block screen), real extension
  and companion icons. **(2026-11-07):** AIDA showcase moved out of the
  options page into the standalone `site/` landing page; the options page is
  now a conventional settings dashboard (same DOM IDs, e2e-safe).
- **Landing site scaffold ✅ (2026-11-07):** `site/` — Vite + React +
  Tailwind + GSAP port of the editorial showcase; `npm run build:site` →
  `dist-site/`.
- **Firefox parity ✅:** MV3 event-page keepalive in `lock-enforcer.ts`
  (event-page suspension can no longer stall enforcement or impersonate a
  dead extension to the companion watchdog) + incognito-access warning UI.
- **Remaining — external launch ops only (no code blockers):**
  - Deploy `feedback-worker/` to Cloudflare D1 (create the db, `wrangler
    deploy`, then set `FEEDBACK_ENDPOINT` in `config.ts`) so opt-in sharing
    is live for the listing.
  - Open-source GitHub release + Chrome Web Store beta listing (privacy
    policy exists as `PRIVACY.md`).
  - Watch RAM/battery, false-positive rate, and model download UX in the wild.
  - Deploy the `site/` landing page (`npm run deploy:site` → Cloudflare
    Pages project `smartblocker`; custom domain later), then link it from
    the store listing + README.
  - Marketing: Show HN, r/ADHD, r/productivity, Product Hunt. Hook: *"Stop
    blocking the whole internet. Start blocking your bad habits."*
- Telemetry-free by default; the ONLY network write is the explicit opt-in
  feedback sharing (off by default, hostname-only records — see PRIVACY.md).
  All classification + history analysis remain local.

### Design note: collective feedback → a better model for everyone

How opt-in shared feedback (the `feedback-worker/` D1 store) becomes model
improvements, once there are external users:

1. **Export** — periodic manual dump of the D1 `feedback` table (wrangler
   d1 execute / export). No live pipeline; cadence follows volume.
2. **Sanitize** — drop `installId`s, dedupe identical titles, discard
   anything that looks personal (names, emails, account numbers in titles).
   Records are hostname-only by design (PRIVACY.md), but titles can still
   leak PII — treat every title as untrusted user data.
3. **Curate (human step, non-negotiable)** — read the misclassifications and
   pick real, generalizable failures. This is the poisoning firewall: a
   hostile or confused uploader can submit "facebook.com should be
   productive" records at volume; nothing they send reaches the model
   without a human deciding it's a genuine failure mode.
4. **Eval first, seeds second** — each curated failure becomes an
   `eval-dataset.json` case FIRST (measure the gap, protect against
   regression forever), and only then — if a fix is needed — new
   `prototype-seeds.json` seed texts with *different wording* (the
   train/test disjointness rule). Every change gates through
   `scripts/benchmark.mjs`.
5. **Ship** — seed/dataset changes ride normal releases. Centroids rebuild
   client-side automatically (version-keyed over seed texts), so a release
   IS the model update; no download infrastructure needed.

Explicitly ruled out: auto-updating centroids from remote feedback. Three
reasons: poisoning (one uploader skews a shared centroid for everyone),
provenance (no way to audit why the model changed), and privacy (raw titles
would flow into every install). The only *automatic* learning path stays
local: the user's own corrections folding into their own centroids
(`feedback.ts getPrototypeExamples`).

Useful aggregate (no curation needed): per-category FP/FN counts from the
D1 store tell us WHERE to grow the dataset next, without reading titles.

---

## Phase 4 — Paid Pro (tamper-proof companion) — core ✅ (2026-07-04), hardening ✅ (2026-11-05)

The desktop companion is built, e2e-verified on Linux, and hardened against
the ten concrete OS/extension bypass vectors found in the 2026-11 bypass
audit (see
`docs/learning-notes/2026-11-05-companion-hardening-and-roadmap-completion.md`).
What remains is launch logistics, not code: real-hardware Windows
verification and a signed installer. Free extension = the Phase 2.9 soft
lock; the companion is the paid hard enforcer.

**Shipped** (`companion/` cargo workspace + extension bridge):

- **Native Messaging bridge**: `src/background/companion.ts` ⇄
  `smartblocker-nm-host` (stdio relay, one per browser port) ⇄ local IPC ⇄ the
  companion daemon (`smartblocker_core::daemon` — headless `smartblocker-daemon`
  bin on Linux/e2e, embedded in the Tauri app on Windows). Protocol v1
  (`companion-protocol.ts` ↔ `protocol.rs`): hello / lockStateSync /
  heartbeat(20s) / companionStatus.
- **Lock-state convergence**: both sides persist a copy and MERGE
  (commutative/idempotent/monotonic — `mergeLockStates`, schedules LWW via
  `schedulesUpdatedAt`, remote input sanitized + clamped). Locks extend,
  never shorten; wiping the extension doesn't clear a lock; re-broadcast
  only on change (no sync loops). TS/Rust parity enforced by shared golden
  fixtures (`companion/.../tests/fixtures/lock-cases.json`).
- **Hard enforcement while forceBlocking** (pure `enforcer::tick`, monotonic
  clock, kills only from PERSISTED state): watchdog (supported browser w/o a
  responsive extension → notify → 60s grace → browser closed), incompatible
  browsers (Brave/Opera/Vivaldi/…) closed after 10s notice, app blocklist
  closed instantly. Healthy browsers never touched (extension keepalive
  alarms + 60s grace absorb MV3 SW/event-page reaping — now on Firefox too).
- **Tauri 2 tray app** (`crates/smartblocker-companion`): status, start locks
  (via IPC as a hello-less client so the UI can't mask a dead extension),
  add-only-while-locked app blocklist, Install/Repair (HKCU registry keys on
  Windows, manifest files on Linux), autostart, quit refused while locked.
  Not in cargo default-members — the WSL gate never compiles it.
- **Stable extension ID** `dhbhbhhcjkfdkfbloeaeedndfjfadajh` via the committed
  chrome-manifest `"key"` (private key gitignored at the repo root — back it
  up).
- **Full-loop Linux e2e** (`scripts/e2e-companion-test.mjs`): real Chromium +
  NM manifest + real relay/daemon — connected status, bidirectional lock sync
  incl. daemon-restart seeding, fake blocked app + fake incompatible browser
  killed, page blocked under a companion-held lock.

**Hardened (2026-11-05):**

- **Behavioral process fingerprinting** (`procwatch.rs classify_process`):
  browsers identified by renderer command-line structure (`--type=renderer`,
  `-contentproc`) instead of trusting exe stems — rename-spoofing a blocked
  app to `chrome` no longer inherits trust, and masquerading as the
  companion fails because kill-immunity (`PROTECTED_STEMS` + recorded own
  PIDs) binds to the companion's real executables only.
- **Private/extensionless launch detection**: `--incognito`, `--inprivate`,
  `--guest`, `--disable-extensions` flags mark a browser as unable to host
  the extension → treated as a bypass attempt; the extension UI also warns
  when incognito access is not granted.
- **Monotonic clock-jump compensation**: daemon and extension
  (`lock-enforcer.ts`) anchor lock/expiry math to a monotonic source and
  compensate wall-clock rewinds — setting the system clock back can't
  shorten a lock.
- **Reverse-sync self-healing**: the daemon's persisted copy re-merges
  (`merge.rs merge_in`) into a wiped/reinstalled extension on reconnect, so
  a storage wipe heals back to the lock instead of clearing it; mid-lock
  `config.json` edits merge against enforcement-critical fields instead of
  silently weakening them.
- **Paired watchdog supervisor** (`smartblocker-daemon watchdog`): supervisor
  and daemon monitor each other and respawn whichever is killed;
  `uninstall` is lock-guarded and refuses to tear down registration and
  autostart mid-lock.
- **Offline HMAC-SHA256 Pro licensing** (`license.rs`): verifies
  `SBPRO1.<payload>.<sig>` keys fully offline — no activation server, zero
  network traffic (companion still has no network code).
- **Policy hardening**: Firefox `policies.json` + Chromium hardening policies
  written by Install/Repair where consumer policy is honored; force-install
  still needs the Phase 3 store `update_url` on unmanaged machines — the
  behavioral watchdog remains the enforcement that works everywhere.
- **Real icons** for the extension and the companion tray app.

**Remaining for the paid release (launch logistics, not code):**

- Manual Windows verification on real hardware (checklist in
  `companion/README.md`) + a signed Windows installer (code-signing cert is
  a purchase, not code).
- $39 lifetime payment flow (Stripe / Lemon Squeezy) issuing the `SBPRO1`
  keys `license.rs` already verifies; `config.json licenseKey` is wired.
- Chrome Web Store listing (Phase 3) — the deployment dependency for
  managed force-install policy.

---

## Phase 5 — Cold Turkey parity+ (from the 2026-11-07 blocker audit)

Full evidence base: `docs/audits/2026-11-07-cold-turkey-blocker-landscape-audit.md`
(gap matrix + P0/P1/P2) and `docs/audits/2026-11-07-blocker-ui-ux-and-news.md`
(UI teardown + category news). The audit's conclusion: nobody ships **local ML
classification + OS enforcement**; the phases below close CT's feature leads
without giving up our architectural ones.

### Batch 1 — quick deterministic wins (extension-only, no lock-schema changes)

> ✅ **SHIPPED 2026-11-08** — all four items built by four isolated-worktree
> agents, union-merged and committed into main. Gates in main:
> typecheck clean, both build targets, **54** rules tests + **17** RTA tests +
> **24** resume tests + **77** lock-math tests green, `npm run eval` **PASS:
> no regressions** (15,874 cases, metrics bit-identical, dataset/baseline
> untouched), Playwright e2e **ALL PASSED**. New modules `src/shared/rules.ts`
> + `resume.ts`, `src/background/resume-enforcer.ts`; settings all additive
> and inert at defaults; `"notifications"` manifest permission added for the
> local auto-resume toast (approved at the merge checkpoint).

1. **Title rules.** Case-insensitive substring rules against the cleaned page
   title, evaluated beside the URL `blocklist` (skip inference on hit, same
   block path). CT sells this as Pro "window titles" blocking.
2. **YouTube channel rules.** `channelBlocklist` forces a block,
   `channelAllowlist` rescues from *classification* (not from URL blocklist);
   handles normalized (`@name`, case-insensitive). Channel extraction already
   exists in `extract-meta.ts`; CT's whole channel feature is this list.
3. **RTA adult-site signal.** Opt-in `blockAdult` (default off): `<meta
   name="rating">` = `adult`/RTA tag → deterministic block; `*.xxx` TLD
   covered by the same switch. Matches CT's entire adult feature with one
   meta probe.
4. **Autostart resume.** Optional auto-resume when blocking is disabled:
   on browser startup, at next scheduled-block start, or at a chosen
   datetime (`resumeAt`, alarm-driven). Closes CT's "forgot to re-enable"
   relapse path.

### Batch 2 — commitment UX v2 (touches lock schema + Rust mirror; own phase)

> ✅ **2026-11-08 status:** items **5, 6 and 7 shipped** in main; item **8
> shipped as the truthful extension-side partial** described below. A final
> integration audit also closed the companion authentication gap: unauthenticated
> merges now pin all break/delay/random-text operation fields, preserving
> authenticated releases and anonymous timer/Frozen extension. The three new
> daemon regressions demonstrably failed before this fix and pass afterward.
> Final merged-tree gates: **14** break tests, **21** focused lock-type tests,
> **124** lock-math tests consuming the shared TypeScript/Rust fixtures, **12**
> surrender tests, **21** grace tests, all Batch 1 suites, **161** Rust tests
> across six suites, clippy/fmt clean, typecheck + Chrome/Firefox builds green,
> eval **PASS: no regressions** across **15,874** cases with no per-case changes,
> and Playwright **E2E: ALL PASSED**. Batch 2 is integrated and committed on
> main; no remote push is implied by this status.

5. **Breaks v1: delay break + random-text break** (`lock.ts` holds the only
   legal transition: a break *schedules re-block*, never shortens the stored
   lock; unlock gates live in shared/lock-math so extension and daemon agree).
6. **New lock types: delay + random-text** (delay 1 min–40 days, text
   1–5,000 chars — service-side-equivalent gating, per the audit: the page
   never decides). Update `lock-math.ts` + `merge.rs` + shared fixtures
   together.
7. **Typed-surrender quit wall** on non-hard overrides (effort + delay, no
   guilt copy — per the PNAS finding; FocusMe's typo-restart trick).
8. **Visible extension-loss grace countdown** (companion + popup: "browser
   closes in 60 s unless the extension returns", re-check every 10 s).
   **Extension-side partial (2026-11-08):** pure grace math plus a locked,
   non-numeric disconnect warning landed. The truthful numeric countdown is
   blocked until `companionStatus` carries the daemon's actual grace state and
   remaining time; outgoing heartbeat sends cannot substitute for it. See
   `docs/learning-notes/2026-11-08-extension-loss-grace-countdown.md`.

### Batch 3 — retention + admin (bigger surfaces)

> ✅ **2026-11-08 status:** item **9 is complete**, and item **13's
> extension-side wildcard block/allow grammar is complete**. The item 13 daemon
> CLI remains separate, and item 14 accountability-partner codes are unchanged.
> The completed Batch 3 scope is shipped on `main`; unrelated search/research
> work was preserved outside this change through path/hunk-specific staging.
> Final gates: **22** wildcard tests, **22**
> usage-statistics tests, all Batch 1/2 pure suites, **161** Rust tests,
> clippy/fmt, typecheck, and Chrome/Firefox builds pass. The **15,874-case** eval
> reports **PASS: no regressions** with no per-case changes and unchanged input
> files. The final two consecutive Playwright reruns report **E2E: ALL PASSED**.
> One earlier concurrent attempt failed only the YouTube page-visibility timing
> assertion despite correct individual verdicts; it did not reproduce on either
> unchanged rerun, so no root cause is claimed.

9. **Idle-aware usage statistics + dashboard** (per-day per-site/category
   counters + "pages silenced this week" + override-rate; JSON export;
   computed from tab events, not `chrome.history`, so incognito-inclusive
   and history-clear-independent — CT parity).
   **Complete (2026-11-08):** bounded local-day aggregates,
   conservative focus/idle active-time accounting, seven-day counters and
   override rate, per-day site/category tables, aggregate-only JSON export, and
   confirmed clearing are integrated. Rule-derived labels collapse to the
   generic `blocked by rule` category before storage. See
   `docs/learning-notes/2026-11-08-idle-aware-usage-statistics.md`.
10. **Breaks v2: Allowance / Reward / Sessions / Pomodoro** (escalating
    cost per use — Opal Waiting-Room pattern).
11. **Multi-browser onboarding + "Fix extensions" surface** (companion
    detects installed browsers, per-browser install/fix flow).
12. **Windows companion verification pass** (service-name randomization,
    exe file-locks during blocks, Task-Manager protection — CT's own
    settings schema is the checklist; see audit §3.2) → flip
    `policy_enforce` after the Phase 3 store listing.
13. **Wildcard list grammar** (`*` anywhere in blocklist/whitelist rules —
    CT-compatible) + **CLI on the daemon socket** (`block start|stop|toggle`,
    `lock`) for automation tools; accountability-partner codes remain item 14.
    **Extension-side wildcard grammar complete (2026-11-08):**
    star-free legacy behavior is preserved; wildcard blocking uses ordered
    literals, constrained allows remain anchored, SERP guards precede allows,
    and popup allow display/removal uses the shared matcher. The **daemon CLI
    remains open**, and partner codes belong to item 14. See
    `docs/learning-notes/2026-11-08-wildcard-list-grammar.md`.
14. **Per-category schedules** (then per-list after the multi-list UI
    redesign) and **accountability-partner unlock codes** (offline-signed,
    24 h partner-activation delay).

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
