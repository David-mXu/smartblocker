# Direct Sub-Frame (`frameIds`) Classification, Closed Shadow DOM Piercing & SERP Video Guard

**Date:** 2026-11-05  
**Project:** SmartBlocker (`src/background/blocker.ts`, `src/background/blockscreen.ts`, `src/content/extract-meta.ts`, `src/content/sanitize-page.ts`, `scripts/e2e-test.mjs`)

---

## 1. Original Problem & Feature Goal

SmartBlocker already classified top-level page visits and ran a host-page sanitizer (`sanitizePage` in `src/content/sanitize-page.ts`) to mask `<iframe src="...">` elements on whitelisted workspaces such as Google AI Studio (`aistudio.google.com`) and Google Search (`google.com/search`). However, embedded distraction content (especially YouTube embeds on third-party sites and Google Videos search results) could still bypass the blocker through four structural gaps:

1. **Top-Frame-Only Script Injection (`frameId: 0`):**
   - `api.scripting.executeScript({ target: { tabId } })` only executes in the top-level document (`frameId: 0`). Even when `api.webNavigation.onCommitted` detected a sub-frame navigation (`d.frameId > 0`) to `youtube.com/embed/...`, `blocker.ts` called `runPageSanitizer(d.tabId)` on the parent frame rather than targeting `d.frameId`.
2. **Closed & Open Shadow DOMs + Nested Wrapper Iframes:**
   - `document.querySelectorAll('iframe[src]')` in the top frame cannot see iframes mounted inside open or closed Shadow DOM roots (`Element.attachShadow`), nested intermediate cross-origin wrapper iframes, lazy-loaded `data-src`/`srcdoc` iframes, or `lite-youtube` facades.
3. **YouTube Embed Player DOM Blindness (`src/content/extract-meta.ts`):**
   - `extractMeta()` only matched `/youtube\.com\/(watch|shorts\/)/i`, ignoring `youtube.com/embed/*` and `youtube-nocookie.com/embed/*`. Inside an embed iframe, `document.title` often starts as generic `"YouTube"` while the actual video title and channel live in `.ytp-title-link` and `.ytp-title-channel-name`.
4. **Sub-Frame Block Screen Clipping & Host-Tab Closure (`src/background/blockscreen.ts`):**
   - `showBlockScreen()` assumed a full browser viewport and wired its secondary button (*"Stay focused (close tab)"*) to send `{ type: 'CLOSE_TAB' }`. If injected inside a `560×315` embedded iframe on Google AI Studio or Notion, the card overflowed vertically and clicking *"Stay focused"* closed the user's entire workspace tab.

---

## 2. Root Causes & Underlying Concepts

### A. Cross-Origin Sub-Frame Execution (`target: { tabId, frameIds: [frameId] }`)
Because of the browser's **Same-Origin Policy (SOP)**, JavaScript running in a parent document (`https://aistudio.google.com`) cannot inspect `iframe.contentDocument` of a cross-origin embed (`https://www.youtube.com/embed/...`). Furthermore, if a web component encapsulates the `<iframe>` inside a **closed Shadow DOM** (`attachShadow({ mode: 'closed' })`) or inside an intermediate sandbox iframe, parent-frame DOM queries cannot even find the `<iframe>` element.

However, a Manifest V3 browser extension with `host_permissions: ["<all_urls>"]`, `webNavigation`, and `scripting` operates above the page's DOM tree:
- `webNavigation.onCommitted`, `onCompleted`, `onHistoryStateUpdated`, and `getAllFrames({ tabId })` report every sub-frame navigation with its exact `tabId`, `frameId` (`> 0`), and `url`, regardless of how deeply nested or shadow-encapsulated the iframe is.
- `scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func })` injects directly into that sub-frame's isolated world, where `document` **is** the embed player's own DOM.

### B. Why In-Browser Sub-Frame Enforcement Beats a Network MITM Proxy
A network-level MITM proxy (`mitmproxy`) inspecting `/youtubei/v1/player` has three major weaknesses:
1. YouTube embeds frequently inline `ytInitialPlayerResponse` inside the initial `GET /embed/<id>` HTML response and stream over QUIC (HTTP/3 over UDP 443), bypassing `/youtubei/v1/player` XHR interception.
2. System-wide TLS interception requires installing a custom Root CA across OS and browser trust stores and breaks developer CLI tools (`node`, `cargo`, `git`, `python`).
3. An external proxy lacks browser-tab context (SmartBlocker's active **Focus Goal**, **Open-Tab Context**, on-device feedback centroids, and lock state).

---

## 3. Investigation & Implementation Steps

### Step 1: Extend `extractMeta()` for YouTube & No-Cookie Embed Players (`src/content/extract-meta.ts`)
- **Evidence:** `extract-meta.ts` line 51 checked `/youtube\.com\/(watch|shorts\/)/i`, which skipped `/embed/`, `/live/`, `/v/`, and `youtube-nocookie.com`.
- **Implementation:**
  - Broadened `isYouTube` to `/(?:youtube\.com|youtube-nocookie\.com)\/(?:watch|shorts\/|embed\/|live\/|v\/)/i`.
  - Added YouTube embed chrome selectors for channel (`.ytp-title-channel-name`, `.ytp-ce-channel-title`, `a.ytp-title-channel-logo[aria-label]`) and title (`.ytp-title-link`, `.ytp-title-expanded-title a`, `.ytp-title-text a`, plus cleaned `document.title` when non-generic).
  - Kept `extractMeta()` 100% self-contained with zero outer-scope imports so `scripting.executeScript` serializes it cleanly.

### Step 2: Adapt `showBlockScreen()` for Sub-Frames (`src/background/blockscreen.ts`)
- **Evidence:** In a sub-frame (`window !== window.top`), full-viewport padding (`42px 36px`) clipped action buttons, and sending `CLOSE_TAB` closed the host tab.
- **Implementation:**
  - Detected `isSubFrame = window !== window.top` and `isCompact = isSubFrame || window.innerHeight < 420`.
  - Marked `#smartblocker-overlay` with `data-smartblocker-context="subframe" | "top"` and applied compact, scrollable card styling in sub-frames.
  - Changed the secondary action inside sub-frames to *"Stay focused (disable embed)"*, which permanently strips `<video>`/`<audio>` `src` attributes and posts `stopVideo`/`pauseVideo` commands to the player without closing the host tab.
  - Preserved *"This is actually productive — let me through"* (`OVERRIDE`) and lock-mode enforcement (`locked` hides bypass buttons in both top frames and sub-frames).

### Step 3: Open Shadow DOM Piercing, Facades, and SERP Redirect Unwrapping (`src/content/sanitize-page.ts`)
- **Evidence:** `sanitizePage` only queried light-DOM `iframe[src]`, missed `lite-youtube` facades, and skipped Google Search cards whose `href` used `/url?q=https://www.youtube.com/...`.
- **Implementation:**
  - Added `collectOpenRoots()`, `queryAllDeep()`, `ensureMaskCss()`, and `findBySmartBlockerId()` inside `sanitizePage` to walk open `shadowRoot` trees and inject scoped `:host([data-smartblocker-masked])` styles into shadow roots.
  - Added scanning for lazy iframe attributes (`data-src`, `data-lazy-src`, `data-original`, `srcdoc`), `lite-youtube` / `yt-lite` facades (`facadeVideoId`), inline SERP video preview dialogs (`[role="dialog"] video, g-lightbox video`), and Google `/url?q=` redirect unwrapping (`resolveResultHref`).

### Step 4: Two-Phase Direct Sub-Frame Classification & Sweep (`src/background/blocker.ts`)
- **Evidence:** Sub-frames can navigate independently of the top frame, and their DOM `<title>` / `.ytp-title-link` may not be parsed yet at `onCommitted` time.
- **Implementation:**
  - Added per-subframe state maps keyed by `${tabId}:${frameId}` (`subFrameArmedAt`, `subFrameLastClassified`, `subFrameInFlightKey`, `subFrameGeneration`, `subFrameBlockedVerdict`) with automatic cleanup on top-frame navigation (`arm`) and tab closure (`tabs.onRemoved`).
  - Deduplicated concurrent `resolveYouTubeMeta(videoId)` oEmbed requests via `ytOembedInFlight`.
  - Implemented `armSubFrame(tabId, frameId, url)` and `onSubFrame(tabId, frameId, url, phase)` targeting `{ tabId, frameIds: [frameId] }`:
    1. Immediately injects `applyPreBlockCurtain(1500)` into `{ tabId, frameIds: [frameId] }` on commit.
    2. Checks deterministic `blocklist` and unconditional game/social/stream embed hosts first (`0ms` inference).
    3. Gathers DOM metadata from `{ tabId, frameIds: [frameId] }` (`gatherMeta(tabId, frameId)`) and resolves YouTube oEmbed metadata (`resolveYouTubeMeta`). If neither is ready yet at `phase === 'committed'`, keeps the curtain up until `webNavigation.onCompleted` fires once the sub-frame DOM has parsed.
    4. Classifies with `bge-small-en-v1.5` (including the user's active Focus Goal and Open-Tab Context) and injects `showBlockScreen` directly into `{ tabId, frameIds: [frameId] }` when blocked, or clears the sub-frame curtain when allowed.
  - Extended `sweepOpenTabs()` to enumerate active sub-frames via `api.webNavigation.getAllFrames({ tabId })` so starting a Frozen Turkey or scheduled lock mid-session immediately sweeps and blocks already-open embeds.

---

## 4. Alternatives & Tradeoffs

- **Network MITM Proxy (`mitmproxy`) vs. Direct Sub-Frame Injection (`frameIds: [frameId]`):**
  - Moving ML classification into `mitmproxy` requires custom Root CA installation, breaks on QUIC/HTTP3 and SSR-inlined `/embed/` responses, and loses browser tab context. Direct sub-frame injection via `webNavigation` + `scripting.executeScript({ target: { tabId, frameIds: [frameId] } })` works across HTTPS/HTTP3 without TLS interception, pierces closed Shadow DOMs and nested cross-origin iframes, and shares the extension's warm offscreen ONNX model and Focus Context.
- **Host-Page Sanitizer (`sanitizePage`) vs. Direct Sub-Frame Blocking (`onSubFrame`):**
  - We kept **both** layers working in tandem: `sanitizePage` masks visible embed containers and SERP shelves cleanly in the host page's layout when reachable (light DOM / open Shadow DOM), while `onSubFrame` enforces blocking directly inside `{ tabId, frameIds: [frameId] }` so closed Shadow DOMs, nested wrapper iframes, and unmasked embeds can never play distracting content.

---

## 5. Verification

All verification gates were executed and observed passing:

1. **Typecheck & Dual-Target Build (`npm run typecheck && npm run build`)**:
   - `tsc --noEmit` and Vite builds for `dist/chrome` and `dist/firefox` succeeded with zero errors.
2. **Lock Math Unit Tests (`node scripts/lock-math-test.mjs`)**:
   - `56 passed, 0 failed`.
3. **Real-Chromium End-to-End Suite (`node scripts/e2e-test.mjs`)**:
   - `E2E: ALL PASSED`, including the new Section 10 (`PASS direct sub-frame blocking (closedShadow=true, nestedIframe=true, lectureOverlay=0, hostOverlay=0, hostStillOpen=true)`), confirming that distracting embeds inside a closed Shadow DOM (`attachShadow({ mode: 'closed' })`) and inside a nested cross-origin wrapper iframe receive `#smartblocker-overlay[data-smartblocker-context="subframe"]` directly inside their sub-frame while productive lecture embeds remain unblocked and clicking *"Stay focused (disable embed)"* keeps the parent workspace tab open.
4. **Offline Evaluation Regression Gate (`npm run eval`)**:
   - 13,390 evaluation cases verified with zero regressions against `scripts/eval-baseline.json`.
