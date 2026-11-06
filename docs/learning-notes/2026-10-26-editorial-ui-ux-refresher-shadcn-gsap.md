# Learning Note: Editorial UI/UX Refresher with React, shadcn/ui, Tailwind v4, and GSAP in a Multi-Root MV3 Extension

**Date:** 2026-10-26  
**Topic:** Migrating extension UI surfaces (`popup`, `options`, and `blockscreen.ts`) to a Dark-First Editorial design system with `shadcn/ui` and GSAP while preserving MV3 serialization and Playwright E2E contracts.

---

## 1. Original Problem & Goal

SmartBlocker's core local-AI classification engine (BGE-Small multi-prototype centroids + Focus Context System 1.5 + Cold-Turkey-style commitment locks + Rust Native Messaging companion) had reached high technical maturity (97.6% E2E decision accuracy), but its three user-facing surfaces were still early Proof-of-Concept vanilla HTML/CSS forms:
- `src/popup/popup.html` + `src/popup/popup.ts`: A 360px plain white diagnostic panel with unstyled buttons and raw `<pre>` output.
- `src/options/options.html` + `src/options/options.ts`: A single-column 600px settings form with inline styles.
- `src/background/blockscreen.ts`: A basic red circle badge overlay injected via `chrome.scripting.executeScript({ func })`.

The goal was to execute a comprehensive UI/UX refresher across all three extension surfaces:
1. Ground the visual hierarchy and interaction patterns in empirical product references from **Lazyweb MCP** (`lazyweb_search_screens`, `lazyweb_search_flows`, and `lazyweb_agentic_search_finalize`).
2. Follow the `@gpt-taste` design engineering directive:
   - Deterministic Python-seeded layout and component selection (Editorial Split Hero with 2-line H1 and inline pill image, `Geist` / `Geist Mono` typography, 5-card Gapless Bento Grid with `grid-flow-dense`, GSAP `ScrollTrigger` scrubbing text reveal + pinned split gallery, horizontal accordions, and infinite marquee).
   - Strict bans on emojis, cheap meta-labels (`"SECTION 01"`), and horizontal scrollbars (`overflow-x-hidden`).
3. Migrate `popup` and `options` to **React + Tailwind CSS v4 + `shadcn/ui` + `@gsap/react`** while keeping `blockscreen.ts` self-contained and preserving 100% compatibility with `scripts/e2e-test.mjs` and `scripts/e2e-companion-test.mjs`.

---

## 2. Key Concepts & Architectural Constraints

### A. Why `blockscreen.ts` Cannot Import React or Tailwind
In Manifest V3, SmartBlocker injects the block overlay using `chrome.scripting.executeScript({ target: { tabId }, func: showBlockScreen, args: [...] })`. The browser calls `Function.prototype.toString()` on `showBlockScreen`, serializes its source text, and evaluates it inside the target tab's isolated content-script world.
- **Implication:** Any external import (React, GSAP, `@phosphor-icons/react`, or module-scoped helper variables) would be undefined inside the serialized function body and throw a `ReferenceError` at runtime.
- **Solution:** We redesigned `src/background/blockscreen.ts` as a self-contained Dark-First Editorial monolith card using inline CSS tokens and W3C `document.createElementNS('http://www.w3.org/2000/svg', 'svg')` vector iconography (replacing emojis cleanly without `innerHTML`).

### B. Multi-Root Vite Builds and Tailwind CSS v4 `@source` Discovery
SmartBlocker uses four separate Vite build passes (`vite.config.background.ts`, `vite.config.offscreen.ts`, `vite.config.popup.ts`, and `vite.config.options.ts`) because Rollup's `inlineDynamicImports: true` (required for MV3 service workers) forbids multiple entry inputs.
- Both `vite.config.popup.ts` (`root: 'src/popup'`) and `vite.config.options.ts` (`root: 'src/options'`) set their Vite `root` to a subdirectory of `src/`.
- **Gotcha Discovered During Visual Inspection:** By default, `@tailwindcss/vite` (Tailwind CSS v4) only scans files inside Vite's configured `root` directory (`src/popup` or `src/options`). Shared `shadcn/ui` components located in `src/components/ui/*.tsx` were outside those roots, causing utility classes used only inside `src/components/ui/` (such as `bg-zinc-100`, `text-zinc-950`, `translate-x-5`) to be omitted from the generated CSS bundle.
- **Fix:** Adding `@source "../";` at the top of `src/styles/globals.css` instructs Tailwind v4's oxide scanner to traverse the entire `src/` tree regardless of which subdirectory Vite uses as `root`.

### C. Preserving Native DOM Semantics Inside `shadcn/ui` Primitives
Playwright E2E tests (`scripts/e2e-test.mjs` and `scripts/e2e-companion-test.mjs`) interact with specific selectors (`#test-pair`, `#scan-history`, `#save-btn`, `#lock-status`, `#companion-status`, `#smartblocker-overlay button`).
- For custom switches (`src/components/ui/switch.tsx`), backing the styled track/thumb with a real `<input type="checkbox" className="peer sr-only" />` that forwards `id`, `checked`, `disabled`, and `onChange` ensures both React state and Playwright DOM `.checked` / `.disabled` queries work without adapter glue.

---

## 3. Investigation & Implementation Steps

1. **Lazyweb MCP Research (`docs/design-notes.md`)**
   - Ran `lazyweb_search_screens` and `lazyweb_search_flows` across desktop dark-mode dashboards and focus blockers (Opal, Endel, Linear, Focus Four, Depot) and finalized the curated references into Agentic Search `https://www.lazyweb.com/agentic-search/7420c370-d6a5-41f9-b755-cf08e676eece`.
   - Documented the visual tokens, `@gpt-taste` math proofs, and E2E selector contract in `docs/design-notes.md`.

2. **Build & Component Infrastructure (`vite.config.popup.ts`, `vite.config.options.ts`, `src/components/ui/`)**
   - Installed `react`, `react-dom`, `gsap`, `@gsap/react`, `@phosphor-icons/react`, `tailwindcss`, `@tailwindcss/vite`, and `@vitejs/plugin-react@^5.0.0` (matching the repo's `vite@^7.0.0` peer dependency).
   - Built `src/components/ui/{button,card,input,textarea,badge,switch,select}.tsx` and `src/styles/globals.css`.

3. **Surface Implementation (`src/popup/PopupApp.tsx`, `src/options/OptionsApp.tsx`, `src/background/blockscreen.ts`)**
   - Implemented the compact Dark-First HUD in `src/popup/PopupApp.tsx` with GSAP staggered entrance animations, System 1.5 Focus Intention controls, Frozen Turkey 2-step confirmation buttons, active tab false-negative correction, and the inference telemetry stream.
   - Implemented the full-viewport AIDA Command Center in `src/options/OptionsApp.tsx`:
     - Floating glass-pill navigation bar.
     - Editorial Split Hero with a 2-line H1 (`clamp(2.5rem, 4.0vw, 4.35rem)`) and embedded inline pill image.
     - 5-card Gapless Bento Control Matrix (`grid-cols-1 md:grid-cols-12 grid-flow-dense`, rows summing to `7 + 5 = 12`, `6 + 6 = 12`, `12 = 12`).
     - GSAP `ScrollTrigger` scrubbing manifesto reveal, pinned split showcase with scaling imagery, 3-stage horizontal accordions, and infinite marquee.
     - High-contrast commit footer with `#save-btn` and live model progress indicator.
   - Upgraded `src/background/blockscreen.ts` to render an obsidian/crimson radial overlay card with inline vector SVG shield icon and high-contrast action buttons.

---

## 4. Tradeoffs & Alternatives Considered

- **Radix UI Primitives vs. Native-Backed `shadcn/ui` Components:** Using `@radix-ui/react-switch` or `@radix-ui/react-select` replaces `<input type="checkbox">` and `<select>` with `<button role="switch">` and portal popovers, which can break existing DOM tests or require changes to selector queries (`#report-category` value reading). Building `shadcn/ui` primitives backed by semantic `<input type="checkbox">` and `<select>` gave identical visual polish with zero E2E friction and smaller bundle overhead.
- **Keep `src/shared/*.ts` Pure:** Because `scripts/eval.mjs`, `scripts/benchmark.mjs`, and `scripts/lock-math-test.mjs` import `src/shared/*.ts` directly under Node.js type-stripping, we isolated all React/JSX and CSS imports strictly to `src/components/`, `src/popup/`, and `src/options/`.

---

## 5. Verification

All automated checks and browser inspections were executed and verified:
- `npm run typecheck`: Passed (`tsc --noEmit`, 0 errors).
- `npm run build`: Passed for both `dist/chrome` and `dist/firefox`.
- `node scripts/lock-math-test.mjs`: 56/56 pure-math and Rust-parity fixture tests passed.
- `node scripts/e2e-test.mjs`: Passed all end-to-end checks in real Chromium (service worker boot, popup Test Pair classification, YouTube distraction block overlay, productive allow, deterministic blocklist 0ms match, false-positive override + feedback recording, history scan, Frozen Turkey lock enforcement, locked block screen button stripping, and locked options page + companion status).
- `node scripts/e2e-companion-test.mjs`: Passed full native daemon + relay E2E loop in real Chromium (`Connected — hardcore mode active`, bidirectional lock sync, blocked app termination, incompatible browser termination, and blocked page under companion-held lock).
- **Playwright Geometric & Visual Audit:** Verified at `1440x900` (`options.html`) and `392x620` (`popup.html`):
  - `h1Height: 124px`, `lineHeight: 62px` -> exact `2` lines in the Hero heading.
  - `scrollWidth: 1440 === clientWidth: 1440` (`overflowX: false`, zero horizontal scrollbar).
  - Visually inspected rendered screenshots of Hero, Bento Matrix, Desire GSAP section, Popup HUD, and Blockscreen Overlay to confirm button contrast and Tailwind v4 `@source` scanning.
