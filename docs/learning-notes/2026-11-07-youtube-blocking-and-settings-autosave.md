# Fixing YouTube Distraction Blocking, SPA Metadata Races, and Settings Auto-Save

**Date:** 2026-11-07  
**Project:** SmartBlocker (`src/background/blocker.ts`, `src/background/classifier.ts`, `src/background/index.ts`, `src/background/blockscreen.ts`, `src/content/extract-meta.ts`, `src/options/OptionsApp.tsx`, `src/popup/PopupApp.tsx`)

---

## 1. Original Problem & Symptoms

While browsing YouTube in Microsoft Edge, SmartBlocker allowed distracting entertainment videos (such as MrBeast's *"Offering People $100,000 To Quit Their Job"* and Bryan Johnson's *"Am I a Billionaire? I Answer the Internet’s Questions"*) to play without interruption, even though:

- In the open `SmartBlocker Settings` tab (`options.html`), the **Enable SmartBlocker** toggle was checked (`ON`), 10 distraction categories were checked, and the top status badge read **"Protection Active"**.
- In the extension Popup (`popup.html`), the status badge read **"Armed"**, and the user had previously reported *"Offering People $100,000 To Quit Their Job"* via **"Should've been blocked"** (`REPORT_FN`).

---

## 2. Root Causes & Underlying Concepts

Five interacting bugs caused the failure:

1. **Unpersisted Local UI State vs. Storage (`src/options/OptionsApp.tsx` & `src/popup/PopupApp.tsx`)**:
   - **Concept — Optimistic UI State vs. Persistent Storage (`chrome.storage.local`)**: In a Manifest V3 browser extension, the Options page, Popup, and Background Service Worker run in separate JavaScript contexts and communicate through `chrome.storage.local` and runtime messages.
   - Toggling `#enabled-toggle` or category switches in `OptionsApp.tsx` updated local React `useState` variables and immediately flipped the header badge to **"Protection Active"**, but did **not** call `setSettings(...)` until the user manually clicked the separate `Save` button. Meanwhile, `PopupApp.tsx` had no master toggle at all and hardcoded its badge to `'Armed'` whenever `settingsLocked` was false. As a result, `chrome.storage.local.settings.enabled` remained `false` while both UIs claimed protection was active.

2. **Missing Background Tab Sweep on Settings Change & `REPORT_FN` (`src/background/blocker.ts`, `src/background/index.ts`)**:
   - `blocker.ts` only registered `webNavigation` and `tabs.onUpdated` listeners; it had no `api.storage.onChanged` listener for `settings`. Toggling `enabled`, changing `blockedLabels`, or reporting a false negative (`REPORT_FN`) never called `sweepOpenTabs()`, leaving already-open YouTube tabs untouched. And when `enabled` was turned off or a category was unblocked, `onTitle` / `onSubFrame` cleared the pre-block curtain (`clearCurtain`) without removing existing full-page block overlays (`clearBlockScreen`).

3. **Full 518-Seed Centroid Rebuild on Single User Feedback (`src/background/classifier.ts`)**:
   - **Concept — Incremental Prototype Embedding**: Each category's prototype is the mean of its seed embeddings (`prototype-seeds.json` + user feedback corrections). Previously, adding 1 user correction invalidated the global `centroidCache` version and re-embedded all 518 seed texts across all 18 categories from scratch (~25.6 seconds in single-threaded WASM), stalling any concurrent classification on the tab being watched.

4. **YouTube Polymer SPA Stale DOM & Frozen `<head>` Metadata (`src/content/extract-meta.ts`)**:
   - **Concept — Single-Page Application (SPA) Hydration Lag**: YouTube uses Google's Polymer framework (`ytd-app`). Only the initial page load is server-side rendered (SSR) into `<head>` (`<meta name="description">`, `<meta name="author">`, `<meta property="og:title">`). Subsequent clicks between videos, channels (`/@...`), or the homepage (`/`) use `history.pushState` without updating `<head>` meta tags, and inactive views (`ytd-watch-flexy[hidden]`) stay mounted in the DOM.
   - `extractMeta()` previously queried the whole document without checking `[hidden]` or verifying `ytd-watch-flexy[video-id]` / `link[rel="canonical"]` against the current URL's video ID. It also returned raw `channel` without `(youtube.com)` (unlike embedded YouTube videos in `blocker.ts`), causing `applyUrlSignals` to drop the `youtube.com` hostname signal when classifying money-themed entertainment videos.

5. **YouTube SPA Navigation Race Conditions (`src/background/blocker.ts`)**:
   - `onTitle` deleted `armedAt` on the first title event even when `cleanTitle(rawTitle)` was `null` (such as the provisional `"YouTube"` title), breaking the `status === 'complete'` fallback.
   - When `changeInfo.title` fired just before `webNavigation.onHistoryStateUpdated`, `arm()` bumped `navGeneration` for the *same* URL and caused `onTitle`'s stale-generation check to drop the block verdict.

---

## 3. Investigation & Implementation Steps

1. **Live Browser Inspection via `browser-use`**:
   - **Evidence**: Querying `chrome.storage.local.get(null)` and the DOM of the open `options.html` tab (`B51004258B92F466AB71E03E04E0E7B7`) in Microsoft Edge revealed `storedSettings.enabled === false` and 5 stored `blockedLabels`, whereas the live `options.html` DOM had `#enabled-toggle.checked === true`, 10 checked category inputs, and the header badge showing `Protection Active`. It also showed a `false_negative` feedback record for *"Offering People $100,000 To Quit Their Job"* followed by a 25.6-second `loadMs` centroid rebuild.
   - **Why `browser-use` fit**: Inspecting the live extension storage and YouTube DOM inside the user's actual Edge session immediately exposed the state mismatch between the open React page and `chrome.storage.local`, as well as YouTube's frozen `<meta>` tags and hidden `ytd-watch-flexy[hidden]` nodes.

2. **Parallel Subagent & Herdr Team Investigation**:
   - **OpenCode Zen `opencode/deepseek-v4.1-flash-free`** audited all 2,072 YouTube cases in `scripts/eval-dataset.json` (15,874 total cases) and tested `effectiveBlockScore` and seed changes against `scripts/eval-baseline.json`, proving that modifying global softmax top-3 summing or `prototype-seeds.json` would introduce per-case regressions on non-YouTube slices, whereas enriching `extract-meta.ts` in the browser DOM preserves 0 regressions on `npm run eval`.
   - **OpenCode Zen `opencode/glm-5.3-flash-free`** audited `src/options/OptionsApp.tsx`, `src/popup/PopupApp.tsx`, and `src/background/blocker.ts`, mapping every control that needed immediate auto-save and cross-tab `storage.onChanged` synchronization.
   - **Herdr `agy-flash` (`gemini-3.8-flash`)** and **`claude-helper` (`claude`)** designed the `blocker.ts` SPA race fixes and the `extract-meta.ts` active-container / canonical-link verification for YouTube Polymer.

3. **Implementation**:
   - [`src/content/extract-meta.ts`](../../src/content/extract-meta.ts):
     - Handled all `youtube.com` / `youtube-nocookie.com` pages so non-video routes (`/`, `/@...`, `/results`, `/feed/...`) never fall through to the generic `<meta>` branch.
     - Scoped `/watch` and `/shorts` queries on YouTube Polymer (`ytd-app`) to unhidden containers matching the current video ID (`ytd-watch-flexy:not([hidden])[video-id]`, `ytd-reel-video-renderer[is-active]:not([hidden])`) and restricted `<head>` meta fallbacks to when `link[rel="canonical"]` matches the current video ID.
     - Stripped YouTube expander chrome (`…more`, chapter timestamps) from descriptions, formatted `channel` as `${channel} (youtube.com)` on Polymer pages, and set `metaStale: true` when Polymer is mid-transition so `blocker.ts` re-checks after hydration.
   - [`src/background/blocker.ts`](../../src/background/blocker.ts) & [`src/background/blockscreen.ts`](../../src/background/blockscreen.ts):
     - Added an `api.storage.onChanged` listener on `settings` that triggers a debounced `sweepOpenTabs()` (prioritizing active tabs first), and wired `clearOverlay` (`clearBlockScreen`) whenever protection is disabled, a site is whitelisted, or a verdict is allowed.
     - Allowed YouTube browsing/discovery surfaces (`/`, `/@...`, `/channel/...`, `/feed/...`, `/results`, `/playlist`) unless matched by a deterministic blocklist rule, while blocking distracting `/watch`, `/shorts/`, and `/live/` videos.
     - Fixed the SPA `armedAt`, `armedUrl`, `lastClassified` (`${url}|${title}`), `navGeneration`, and `metaStale` re-check races.
     - Guarded `showBlockScreen` / `showClassifierUnavailableScreen`'s re-mount `MutationObserver` against invalidated extension contexts (`!chrome.runtime?.id`) after extension reloads.
   - [`src/background/classifier.ts`](../../src/background/classifier.ts) & [`src/background/index.ts`](../../src/background/index.ts):
     - Added per-category `specVersions` caching and incremental tail embedding in `getCentroids` so adding a user feedback correction only embeds the newly added text (~12ms) instead of all 518 seed texts (~25.6s).
     - Added `void sweepOpenTabs()` to the `REPORT_FN` handler so reporting *"Should've been blocked"* immediately re-evaluates and blocks the active tab.
   - [`src/options/OptionsApp.tsx`](../../src/options/OptionsApp.tsx) & [`src/popup/PopupApp.tsx`](../../src/popup/PopupApp.tsx):
     - Wired `autoSaveSettings(...)` to all toggles, category switches, custom category add/remove, sensitivity slider, and focus-goal blur/Enter in `OptionsApp.tsx`, while keeping `#save-btn` intact.
     - Added `#popup-enabled-toggle` and a 3-state badge (`Locked` / `Armed` / `Paused`) to `PopupApp.tsx`, and subscribed both UIs to `chrome.storage.onChanged` for `settings`.

---

## 4. Alternatives & Tradeoffs

- **Global `effectiveBlockScore` Top-3 Summing vs. YouTube Channel Domain Signal**:
  - Summing the top-3 blocked labels globally in `src/shared/prototypes.ts` improved aggregate recall by +22 cases on `eval-dataset.json` but introduced 6 false-positive regressions on non-English portals and a Fireship Short in `npm run eval`.
  - Formatting the YouTube channel in `extract-meta.ts` as `${channel} (youtube.com)` (matching how `blocker.ts` already formats embedded YouTube videos) resolved the money-token ambiguity on MrBeast (`0.83` memes and entertainment) and Bryan Johnson (`0.60` memes and entertainment) with **zero** regressions across all 15,874 eval cases.
- **YouTube Browsing Surfaces vs. Video Pages**:
  - Blocking `https://www.youtube.com/` outright prevents users from using YouTube Search or accessing productive subscriptions/playlists. Allowing browsing surfaces (`/`, `/results`, `/@...`, `/feed/...`) while blocking distracting `/watch` and `/shorts/` pages lets users navigate to productive lectures without friction.

---

## 5. Verification

1. **Typecheck & Dual-Target Build**:
   - Command: `npm run typecheck && npm run build`
   - Outcome: Passed with 0 TypeScript errors; built both `dist/chrome` and `dist/firefox`.
2. **15,874-Case Regression Gate (`npm run eval`)**:
   - Command: `npm run eval`
   - Outcome: `PASS: no regressions` across all slices `v1`–`v8` (95.4% top-1, 0.4% productive FP, 97.6% must-block recall, 0.0% collateral FP, 98.7% e2e decision accuracy).
3. **Playwright Security & End-to-End Suites**:
   - Commands: `node scripts/e2e-security-blockscreen.mjs` and `node scripts/e2e-test.mjs`
   - Outcome: `BLOCKSCREEN SECURITY: ALL PASSED` and `E2E: ALL PASSED`.
4. **Live Microsoft Edge Verification (`browser-use`)**:
   - Applied the user's 10 checked categories + `enabled: true` in Edge and reloaded the extension.
   - Observed results on the live YouTube tab (`03BEE436AC0A8C923B70EC519C6AA13C`):
     - `https://www.youtube.com/` (homepage): allowed (`home_blocked: false`).
     - `https://www.youtube.com/watch?v=DuQbOQwVaNE` (*"Offering People $100,000 To Quit Their Job"*): **blocked** (`memes and entertainment — 83% confidence`, video paused).
     - `https://www.youtube.com/watch?v=SwYhu8VSp-s` (*"Am I a Billionaire? I Answer the Internet’s Questions"*): **blocked** (`memes and entertainment — 60% confidence`, video paused).
     - Clicking `#enabled-toggle` on `options.html` without clicking `Save`: immediately wrote `enabled: false` / `enabled: true` to `chrome.storage.local` and unblocked/re-blocked the live YouTube tab automatically via `sweepOpenTabs()`.
