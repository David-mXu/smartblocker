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

## Phase 3 — Public beta

- **Open problem carried from Phase 2: model quality.** The tiny NLI model
  (`nli-deberta-v3-xsmall`) misses newer proper nouns and richer signals don't
  fix it reliably. Evaluate a stronger local model (larger NLI, or a small
  embed-and-classify approach) against the RAM/latency budget before launch.
- Open-source GitHub release + Chrome Web Store beta listing.
- Watch RAM/battery, false-positive rate, and model download UX in the wild.
- Stay telemetry-free; all classification + history analysis remain local.
- Marketing: Show HN, r/ADHD, r/productivity, Product Hunt. Hook: *"Stop blocking
  the whole internet. Start blocking your bad habits."*

---

## Phase 4 — Paid Pro (tamper-proof companion)

- Free extension + paid "Pro" hardcore mode.
- Tauri/Rust desktop companion with a Native Messaging bridge to the extension.
- Managed-policy tamper-proofing (can't just disable the extension when willpower
  fails).
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
