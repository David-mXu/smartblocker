# FlowGuard Roadmap

FlowGuard is a smart distraction blocker. A zero-shot text-classification model
runs **100% locally in the browser** (Transformers.js + ONNX WASM) and classifies
each YouTube/Reddit page *title* — so "React Router Tutorial" passes while "I spent
100 days in Hardcore Minecraft" gets blocked. The pitch: **stop blocking the whole
internet; start blocking your bad habits.**

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

## Phase 2 — Ambient MVP 🛠️ (in progress)

Turn the POC into something a real user configures and lives with. Four fronts,
built by a coordinated agent team against a shared foundation (typed settings store
+ expanded popup⇄background message contract).

1. **Onboarding + user-configurable categories.** First-run flow opens a settings
   page, scans history to surface the user's top "kryptonite" vs "productive"
   categories, and lets them choose what to block. Replaces every hardcoded knob in
   `src/shared/config.ts` (labels, blocked set, threshold, enable) with a
   `storage.local`-backed `Settings` object read live by the classifier/blocker.

2. **Richer classifier signals.** Feed channel name + a description/post-body
   snippet (extracted from the page DOM via a self-contained injected function, the
   `overlay.ts` pattern) into the model so it stops mislabeling proper nouns. Widens
   the classify input + cache key from bare title to `{ title, channel, context }`.

3. **Service-worker cold-start fix.** The SW dies after ~30 s idle, costing a
   1–3 s model reload on the next classification. Move the Transformers pipeline
   into an **offscreen document** (persistent, has a real `document`) on Chrome/Edge;
   the SW becomes a thin RPC client. Firefox has no offscreen API → keep the
   in-process path as a first-class fallback.

4. **Full block screen + override.** Replace the throwaway "click to dismiss"
   overlay with a real block screen showing the category and a **"This is actually
   productive — let me through"** override. The override is recorded in a local
   correction store so the same title is allowed in future — a lightweight way to
   "teach" the system without on-device fine-tuning.

Also in scope: `version` → 0.2.0; docs (`CLAUDE.md`, `README.md`) updated for the
new architecture.

---

## Phase 3 — Public beta

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
