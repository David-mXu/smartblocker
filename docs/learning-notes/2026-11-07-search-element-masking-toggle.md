# Toggle for Proactive Search Element Masking (SERP Sanitization)

## 1. Problem and Goal

SmartBlocker uses an in-page sanitizer script ([`sanitize-page.ts`](../../src/content/sanitize-page.ts)) to proactively mask distracting elements on search engines (Google, Bing, DuckDuckGo, Brave, Yahoo, Baidu, Yandex, Naver, and Ecosia). This includes video carousels, Google game launchers, shopping product shelves, news feeds, entity hero collages, and off-topic organic result cards.

However, there was previously no dedicated setting or user toggle to disable this behavior. Users who wanted page-level protection across the web without having in-search elements and result cards masked or evaluated had no way to turn off SERP element masking independently. The goal was to add a dedicated user-configurable setting and UI toggle (`maskSearchElements`) with immediate, reactive unmasking when disabled.

## 2. Underlying Concepts

- **SERP (Search Engine Results Page)**: The page returned by a search engine in response to a keyword query. SERPs combine traditional organic web links with interactive widgets (video carousels, interactive mini-games, knowledge panels, product ads).
- **Two-Pass Sanitization**:
  1. *Pass 1 (Deterministic)*: Synchronously matches known distraction module headings, CSS classes, ad containers, and distraction domains (e.g., YouTube, Twitch, Steam, betting sites).
  2. *Pass 2 (ML Evaluation)*: Queues ambiguous organic cards and entity panels asynchronously to the background service worker ([`evaluateSubItems()`](../../src/background/blocker.ts)), running an on-device ONNX embedding model (`bge-small-en-v1.5`) to determine whether an individual result card should be collapsed.
- **Fail-Safe Settings Propagation**: In a multi-process browser extension, settings persist in `chrome.storage.local`. When a setting changes, the background service worker must notify content scripts and re-evaluate open tabs ([`sweepOpenTabs()`](../../src/background/blocker.ts)) so changes apply reactively without requiring a page reload.

## 3. Investigation and Implementation Steps

### Step 1: Baseline Verification
Before making modifications, we verified that existing test suites passed:
- `npm run typecheck` passed cleanly.
- Pure-math unit tests (`lock-math-test.mjs`, `resume-test.mjs`, `rules-test.mjs`, `rta-test.mjs`) passed with 0 failures.
- `npm run eval` confirmed 0 regressions across all 15,874 dataset cases.

### Step 2: Settings Schema and Defaults
In [`src/shared/settings.ts`](../../src/shared/settings.ts):
- Added `maskSearchElements: boolean` to the `Settings` interface.
- Added `maskSearchElements: true` to `DEFAULTS`.
- Because `getSettings()` merges `...DEFAULTS, ...storedSettings`, existing installs seamlessly default to `true` without migration overhead or breaking changes.

### Step 3: Background Service Worker Wiring
In [`src/background/blocker.ts`](../../src/background/blocker.ts):
- Added `'maskSearchElements'` to `SETTINGS_SWEEP_KEYS`. When the setting changes in storage, `sweepOpenTabs()` fires automatically.
- Updated `runPageSanitizer()` to pass `maskSearchElements: settings.maskSearchElements` in the injected options.
- Updated `evaluateSubItems()` so that if `item.kind === 'serp-card'` and `settings.maskSearchElements === false`, the background worker immediately returns `{ blocked: false }`, skipping redundant machine learning inferences.

### Step 4: Content Script Sanitizer Reactivity
In [`src/content/sanitize-page.ts`](../../src/content/sanitize-page.ts):
- Extended `SanitizePageOptions` with `maskSearchElements?: boolean`.
- In `scan()`, if the current page is a search engine (`isSerpHost`):
  - When `activeOpts.maskSearchElements === false`, all existing `[data-smartblocker-masked="serp-shelf"]` and `[data-smartblocker-masked="serp-card"]` elements are switched to `data-smartblocker-masked="revealed"` and their mask bars are removed.
  - Part B of the sanitizer (shelf scanning, organic card checks, entity hero panels, leftover link sweeps) is skipped.
  - Part A (universal embedded media iframes / chatbot video guard) remains active on all pages.

### Step 5: Options UI Toggle
In [`src/options/pages/BlockingPage.tsx`](../../src/options/pages/BlockingPage.tsx):
- Added a `SettingRow` with a switch control titled **Search element masking** in the **Protection** section.
- Added a descriptive caption explaining that it proactively collapses video carousels, games, shopping modules, and off-topic cards on Google, Bing, and other search engines.
- Connected the control to the `lock` state so that during commitment locks (e.g. Frozen Turkey), the setting remains locked.

## 4. Alternatives and Tradeoffs

- **Alternative 1: Per-Search Engine Whitelist**:
  - *Considered*: Allowing users to add `google.com` to the standard whitelist to disable search masking.
  - *Rejected*: In [`titles.ts`](../../src/shared/titles.ts), active search pages (`?q=...`) intentionally bypass the whitelist because whitelisting search engines previously served as a backdoor to watch YouTube and access distractions without visiting the blocked sites directly. A dedicated toggle decouples search element masking from domain whitelisting cleanly.
- **Alternative 2: Disabling the Entire Sanitizer Script**:
  - *Considered*: Stopping `runPageSanitizer` entirely when search masking is disabled.
  - *Rejected*: The sanitizer also protects against embedded video iframes and chatbot embeds on workspaces (AI Studio, Claude, Docs, Notion). We only wanted to disable Part B (SERP distraction masking) while preserving universal embedded media protections in Part A.

## 5. Verification

1. **Type Checking & Build**:
   - `npm run typecheck` exited with code 0.
   - `npm run build` succeeded for both Chrome (`dist/chrome`) and Firefox (`dist/firefox`).
2. **End-to-End Suite (`scripts/e2e-test.mjs`)**:
   - Extended the e2e test suite to verify the toggle behavior on a mock Google SERP:
     - With `maskSearchElements: true` (default): All shelves (ads, videos, news, social), product cards, and entity heroes are masked (`serpMaskOk: true`).
     - Toggling `maskSearchElements: false` via service worker storage: Open tabs are swept, previously masked shelves and cards unmask instantly (`{ tadsMasked: false, videosMasked: false, bestbuyMasked: false }`).
     - Restoring `maskSearchElements: true`: Full masking functionality resumes.
   - Full suite passed: `E2E: ALL PASSED`.
3. **Hardened Sanitizer Suite (`scripts/e2e-p1-overrides-sanitizer.mjs`)**:
   - Passed with 0 failures: `E2E-P1: ALL PASSED`.
4. **Regression Gate (`npm run eval`)**:
   - Passed with 0 per-case changes against baseline across 15,874 dataset cases.
