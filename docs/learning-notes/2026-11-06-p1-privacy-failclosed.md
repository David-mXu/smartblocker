# P1 privacy + fail-closed: oEmbed gating (#9), hard-lock fail-closed (#13), self-hosted UI assets (#17)

Date: 2026-11-06 · Agent task: red-team P1 remediation, Team C (files: `src/background/blocker.ts`,
`src/background/blockscreen.ts`, `src/shared/settings.ts`, `src/options/OptionsApp.tsx`, both manifests,
`PRIVACY.md`, new `src/assets/fonts/` + `src/assets/showcase/` + `src/styles/fonts.css` + `src/vite-env.d.ts`,
new `scripts/e2e-p1-privacy-failclosed.mjs`)

## Problem

Red-team audit (`docs/security/red-team-2026-11-05.md`) found three P1s:

- **#9 — oEmbed egress.** Embedded YouTube title resolution hit `www.youtube.com/oembed` unconditionally (every
  embed without a DOM title leaked its video ID to YouTube, defeating youtube-nocookie and privacy facades).
- **#13 — fail-open classification.** If the offscreen document died or the model failed to load, `classify()`
  rejected and the page sailed through — including while a Frozen Turkey / schedule / password lock was active.
- **#17 — remote UI assets.** popup/options pulled Geist fonts from `fonts.googleapis.com` and showcase images
  from `picsum.photos` on every open — UI phoning home, and broken offline.

## Root cause / concepts

- **MV3 CSP context.** The task brief assumed the model download was a service-worker fetch (CSP-exempt). Verified
  FALSE for Chrome: inference runs in the **offscreen document** (`src/background/offscreen/offscreen.ts`,
  `pipeline()` from `@huggingface/transformers`), which is an extension *page* and therefore subject to the
  manifest's `content_security_policy.extension_pages`. Same story on Firefox (background page). So tightening
  CSP requires an explicit Hugging Face `connect-src` allowlist or the model download breaks.
- **Fail-open vs fail-closed.** Historically a rejected `classify()` propagated and callers returned without
  blocking — correct UX in normal mode (never block on uncertainty), wrong during a *hard* lock, whose whole
  point is "no unverified content". The fix keeps both behaviors: the lock state decides the posture at the call
  site.
- **Hard lock vs timer lock** (`src/shared/lock-math.ts`): `forceBlocking` is true for Frozen Turkey and active
  schedule windows; `reasons` may also contain `'password'` (settings lock, `forceBlocking` stays false). Hard
  lock = `forceBlocking || reasons.includes('password')`. Timer-only is NOT hard.
- **Privacy-preserving embeds.** The sanitizer rewrites embed URLs to canonical `watch` URLs before evaluation,
  so nocookie/facade provenance must be recovered from the item's `channel`/`context`/`id`, not its URL.
- **Shadow-DOM probing.** `locator.textContent()` reads only a shadow host's (empty) light DOM; the fail-closed
  screen renders entirely inside an open shadow root. Playwright CSS/text *locators* pierce shadow, but
  `.textContent()` does not — the e2e reads `el.shadowRoot?.textContent` explicitly.

## What changed and why

### #9 — oEmbed gating (`blocker.ts`, new `settings.resolveEmbedTitles`, default **false**)

- `resolveYouTubeMeta(videoId, { privacyPreserving })` returns `null` before any fetch when (a) the source is
  nocookie/facade, or (b) the toggle is off. Cache (300-entry LRU-ish Map) + in-flight dedupe keep repeat embeds
  free. 2.5 s `AbortSignal.timeout`.
- Call sites ordered so oEmbed is **strictly last resort**: DOM-extracted title first, URL `?title=` param
  second, oEmbed third (sub-frame path); sanitizer cards fire it only when the title is empty or the generic
  "YouTube video player" placeholder (`evaluateSubItems`).
- Sub-frame provenance: `/(?:^|\.)youtube-nocookie\.com$/i.test(embedHost)`. Sanitizer-item provenance:
  `isPrivacyPreservingEmbed` checks nocookie in `url`/`channel`, `/facade/i` in `context`, `sb-facade` id prefix.
- Options UI: `#oembed-toggle` Switch next to share-feedback (Sub-panel 3), `disabled` while settings-locked,
  copy explains the egress + the nocookie/facade exception and points at PRIVACY.md.

### #13 — fail-closed machinery (`blocker.ts` + `blockscreen.ts`)

- `classifyWithHardLockRetry(input, hardLocked, stillCurrent, onFirstFailure)`:
  - not hard-locked → rejection propagates unchanged (**normal mode is byte-identical fail-open**);
  - hard-locked → `onFirstFailure()` injects the loud screen, then retries at **1s→2s→4s→8s→16s**; success →
    normal verdict flow; exhaustion → synthetic verdict `classifier unavailable (locked)` (score 1, blocked); a
    navigation bumping the generation → `stale`, everything dropped.
- Wired into `onTitle`, `onSubFrame`, and `evaluateSubItems` (per-card fail-closed mask, no backoff — the
  sanitizer already re-scans).
- Recovery: if a retry succeeds with an **allow** verdict after the loud screen went up, `clearBlockScreen()`
  tears it down (a block verdict would overwrite it anyway). The normal category screen never *replaces* the
  fail-closed screen (`classifyFailedClosed` guard) so no fake "100% confidence" claim appears.
- `showClassifierUnavailableScreen(title)` (blockscreen.ts): same P0-1 hardening as `showBlockScreen` (shadow
  root, `!important` everywhere, `isTrusted`-gated buttons, MutationObserver re-mount, media pause trap, cleanup
  global), but **amber** (vs red), `data-smartblocker-reason="classifier-unavailable"`, pill reads "Classifier
  unavailable — fail-closed", body says a lock is active and the classifier could not run, note reads "bypass is
  disabled", and the ONLY button is "Stay focused (close tab / disable embed)" — no override, no dismiss.
- `subFrameBlockedVerdict` gained `unavailable?: boolean` so the onCompleted re-ensure path re-injects the
  correct screen variant.
- **Deliberate edge, documented:** under a password-only hard lock (`forceBlocking === false`) a pre-existing
  exact-match user override can still clear a *page* block — identical to how blocklist/ML blocks already behave
  under password lock (password lock = settings protection; Frozen Turkey/schedule = no mercy). The sanitizer
  per-card fail-closed path does **not** consult overrides (cards stay masked until the classifier recovers —
  the sanitizer re-scans and corrects itself).

### #17 — self-hosted UI assets

- `src/assets/fonts/geist-latin-var.woff2` (29 400 B) + `geist-mono-latin-var.woff2` (23 128 B): the exact
  variable-font files Google Fonts serves for the latin subset, downloaded at dev time. One `@font-face` per
  family with `font-weight: 100 900` (`src/styles/fonts.css`, imported by `globals.css`). Google Fonts `<link>`s
  removed from both HTML shells.
- 9 local SVGs in `src/assets/showcase/` (~2.0–2.4 KB each) replace the 5 picsum `<img>`s in `OptionsApp.tsx`;
  imported as modules so Vite inlines them as `data:` URIs (why CSP keeps `img-src data:`). New
  `src/vite-env.d.ts` declares `*.svg` modules for tsc.
- CSP (both manifests): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://huggingface.co
  https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co https://www.youtube.com; object-src 'self'`.
  HF hosts are needed because the offscreen-page model fetch is **not** CSP-exempt (see Root cause);
  `www.youtube.com` is the opt-in oEmbed endpoint; `wasm-unsafe-eval` is ONNX runtime.

### PRIVACY.md

Absolute "phones home for exactly nothing" phrasing replaced by a **"Network requests"** section enumerating the
complete list: (1) one-time model download from Hugging Face, (2) opt-in oEmbed (default OFF, video ID only,
never nocookie/facade), (3) opt-in correction sharing (default OFF).

## Alternatives / tradeoffs

- oEmbed *before* `urlFallbackTitle` on YouTube items: a YouTube URL carries no title slug, so the URL fallback
  is a generic host-ish dreg — a real oEmbed title is a stronger signal. DOM and `?title=` still win; oEmbed is
  last resort among *useful* sources.
- Backoff caps at 16 s and stops after 5 retries: Frozen Turkey sessions are long; a permanently dead classifier
  leaves the loud screen up, which is the desired closed state, and each retry is one cheap SW→offscreen RPC.
- e2e sabotages the SW's `chrome.runtime.sendMessage` (rejects `EMBED`/`CLASSIFY`) and wraps SW `fetch` —
  zero product-code test hooks. Works because `src/shared/api.ts` delegates to `chrome` on Chromium.

## Verification

- `npm run typecheck` → clean (one fix along the way: TS narrowing of `title: string | null` doesn't survive
  into the fail-closed injection closure in `onSubFrame` — `args: [title ?? '']`, matching four sibling sites).
- `node scripts/lock-math-test.mjs` → 65/65.
- `node --check scripts/e2e-p1-privacy-failclosed.mjs` → parse OK. Not executed here: it needs
  `dist/chrome` from `npm run build:chrome`, which the task reserves for the integrator. Assertions:
  - **A (#17):** zero fonts.googleapis/gstatic/picsum requests from popup+options (hosts also route-aborted);
    `document.fonts.check` passes for Geist 600 + Geist Mono 500 in both pages; all options `<img>`s local,
    none broken.
  - **B (#9):** toggle OFF → 0 oEmbed requests for a youtube.com embed card; toggle ON → exactly 1 (synthetic
    SW `fetch` fixture, hermetic); youtube-nocookie embed → still 0 with the toggle ON.
  - **C (#13):** Frozen Turkey + sabotaged classifier → `#smartblocker-overlay[data-smartblocker-reason=
    "classifier-unavailable"]` appears, mentions classifier+lock, has 0 override / 0 dismiss / 1 "Stay focused"
    buttons, no "% confidence" pill, and ≥2 classify attempts within ~4 s (backoff). Same sabotage with **no
    lock** → no overlay (fail-open preserved). Repair → normal category block returns on a fresh gaming title.
- Shadow-DOM test bug fixed before handoff: `textContent()` → explicit `shadowRoot?.textContent` read.
- **Watch item for the integrator:** existing `scripts/e2e-test.mjs` §9 (AI Studio embed) may depend on oEmbed
  and now needs `resolveEmbedTitles: true` seeded in its storage reset, or its title assertion may see the
  generic fallback.
- Asset-flow assumption to confirm at build time: Vite emits the woff2 via CSS `url()` and inlines the small
  SVGs; expected under `dist/chrome/assets/`.
