# SmartBlocker Design Notes & UI/UX Architecture

## 1. Empirical Reference Research (Lazyweb MCP)

**Finalized Lazyweb Agentic Search Resource:**
- URL: https://www.lazyweb.com/agentic-search/7420c370-d6a5-41f9-b755-cf08e676eece
- Search ID: `7420c370-d6a5-41f9-b755-cf08e676eece`

### Reference Takeaways Applied to SmartBlocker
1. **Opal (`screens:e4e1dd0560ad6cb81f6a6a60`, `screens:ff76db1b48890d32afc706db`)**
   - **Pattern:** Deep obsidian surfaces (`#09090b` to `#121215`) paired with high-contrast ivory typography (`#fafafa`) and warm amber/emerald commitment indicators.
   - **Application:** Used for the Commitment Lock ("Frozen Turkey", timer lock, password lock, and recurring schedule windows) so irreversible commitment states feel deliberate and architectural rather than punitive.
2. **Endel (`screens:c50a3efc251b38e7c61008ef`, `screens:818056ee8f79becd52772d78`, `flows:a6ca0a8b5438cb3313cc5f42`)**
   - **Pattern:** Monochromatic dark precision with ambient radial lighting, expressive editorial headlines, and calm full-screen takeover interstitials.
   - **Application:** Applied to the Options Command Center hero, onboarding banner, and the injected `blockscreen.ts` overlay so blocked pages interrupt impulsive browsing with an atmospheric, high-contrast editorial pause screen.
3. **Linear (`screens:7463e0a2461687b16b38174a`) & Depot (`screens:9915d76937f29f973a78ada4`)**
   - **Pattern:** Hairline `1px` borders (`rgba(255,255,255,0.08)`), dense scannable control cards, tabular numerals (`font-variant-numeric: tabular-nums`), and monospace telemetry blocks.
   - **Application:** Applied across the 5-card Gapless Bento Grid in `options.html` and the compact diagnostic HUD in `popup.html` (Test Pair, History Scan, and Latency Log).
4. **Focus Four (`screens:bc628c922c1d0c1a5d6e9eef`)**
   - **Pattern:** Explicit separation between active task intention ("Current Focus Goal") and background rule configuration.
   - **Application:** Elevates SmartBlocker's System 1.5 Focus Context (`focusGoal` + `useTabContext`) into a primary interactive module in both the Popup HUD and the Options Command Center.

---

## 2. `@gpt-taste` Design System Specification

### Python-Driven Deterministic Selection
Derived from prompt character count (`len(prompt) = 335`):
- **Hero Architecture:** `1` — Cinematic Center (`max-w-6xl w-full` centered H1, strictly 2-3 lines via `clamp(2.75rem, 4.8vw, 5.25rem)`, inline pill-shaped photographic window inside the headline, two high-contrast CTAs, and a full-bleed atmospheric backdrop with dark radial wash).
- **Typography Stack:** `Outfit` (Primary geometric display & UI sans) paired with `Geist Mono` / `JetBrains Mono` for telemetry, latency breakdowns, and domain rule lists. Loaded cleanly with local/system geometric fallbacks. Never `Inter`.
- **Component Arsenal (3 Selected):**
  1. **Inline Typography Images:** Pill-shaped filtered imagery embedded inline inside display headings.
  2. **Horizontal Accordions:** Expandable vertical architectural slices detailing SmartBlocker's 3-stage local defense pipeline (Whitelist Gate, Deterministic Substring Blocklist, and BGE-Small Multi-Prototype Centroid Classifier).
  3. **Infinite Marquee:** Continuous horizontal ticker showcasing local-AI guarantees, zero-telemetry architecture, and protected focus capabilities with `@phosphor-icons/react`.
- **GSAP Motion Paradigms (2 Selected + Hover Physics):**
  1. **Scrubbing Text Reveal:** Word-by-word opacity scrub (`0.12` to `1.0`) on the central manifesto statement driven by `ScrollTrigger`.
  2. **Image Scale & Fade + Pinned Split Showcase:** Pinned architectural overview on the left while visual telemetry cards scale from `0.85` to `1.0` on entry in the right column.
  3. **Hover Physics:** `group-hover:scale-105 transition-transform duration-700 ease-out` inside `overflow-hidden` containers across interactive cards and media surfaces.

### Color & Surface Tokens (Dark-First Editorial)
- **Background Primary:** `#070709` (Obsidian Void)
- **Surface Card / Bento Cell:** `#0e0e12` / `rgba(18, 18, 24, 0.82)` with `backdrop-blur-xl`
- **Surface Elevated / Input:** `#14141a`
- **Border Hairline:** `rgba(255, 255, 255, 0.08)` (`border-zinc-800/80`), active hover `rgba(255, 255, 255, 0.18)`
- **Text Primary:** `#fafafa` (Crisp Ivory)
- **Text Secondary:** `#a1a1aa` (Zinc 400)
- **Text Muted:** `#71717a` (Zinc 500)
- **Accent Primary:** `#f4f4f5` (High-contrast white CTA fill with `#09090b` text)
- **Semantic Status:**
  - Productive / Connected: `#10b981` (Emerald 500)
  - Commitment Lock / Warning: `#f59e0b` (Amber 500) / `#ef4444` (Crimson 500)

### Strict Bans & Guardrails
- **Zero Emojis:** No emojis in UI text, code, or comments across `popup`, `options`, or `blockscreen.ts`. Replaced with crisp vector SVG / `@phosphor-icons/react` iconography.
- **Zero Cheap Meta-Labels:** No labels like `"SECTION 01"` or `"QUESTION 05"`. Section headers use semantic editorial titles.
- **No Horizontal Overflow:** Root page wrapped in `<main className="overflow-x-hidden w-full max-w-full">`.
- **Gapless Bento Math:** `grid-cols-1 md:grid-cols-12 grid-flow-dense` where every row sums to exactly 12 columns (`7 + 5 = 12`, `6 + 6 = 12`, `12 = 12`).

---

## 3. E2E & Extension Contract Preservation

SmartBlocker's automated Playwright test suites (`scripts/e2e-test.mjs` and `scripts/e2e-companion-test.mjs`) interact with specific DOM IDs, classes, and text patterns. All `shadcn/ui` React components in `popup` and `options` and the self-contained `blockscreen.ts` MUST preserve:

### Popup (`src/popup/`)
- `#lock-line`: Hidden when unlocked; visible with `"Locked: ..."` when `settingsLocked` is true.
- `#focus-goal`, `#save-focus-goal`, `#use-tab-context`: Focus context controls, disabled when locked.
- `.frozen-btn` (`data-mins="60"`, `"240"`, `"480"`): Two-click confirmation before starting `startFrozenTurkey`.
- `#test-pair`, `#scan-history`, `#latency-log`, `#open-options`: Diagnostic action buttons.
- `#report-category`, `#report-fn`: False-negative reporting controls for the active tab.
- `#status`, `#out`: Status feedback line and `<pre id="out">` output container preserving the exact `->` classification and `Scan done` formatting.

### Options (`src/options/`)
- `#banner`: First-run onboarding banner (`display: none` once onboarded).
- `#enabled-toggle`: Master blocking checkbox/switch input.
- `#label-list`, `#custom-category-input`, `#add-category-btn`: Category toggle list (`li`, `.delete-label-btn`) and custom category input.
- `#threshold`, `#threshold-val`: Confidence threshold slider (`0.3` to `0.9`, step `0.05`) and percentage readout.
- `#focus-goal`, `#use-tab-context`: System 1.5 Focus Context inputs.
- `#whitelist`, `#blocklist`: Domain whitelist and instant substring blocklist textareas.
- `#lock-status`, `#lock-duration`, `#lock-unit`, `#lock-timer-btn`, `#lock-password`, `#lock-password-btn`, `#lock-password-msg`: Commitment lock controls.
- `#schedule-list` (`.schedule-row`, `.day-label`, `.schedule-remove`), `#schedule-add`, `#schedule-save`, `#schedule-msg`: Scheduled block windows editor.
- `#companion-status`, `#companion-enforcement`: Native Messaging companion status (must render `"Get SmartBlocker Companion — coming with the Pro release"` when `not-installed`, and `"Connected — hardcore mode active..."` when connected).
- `#scan-btn`, `#block-top-btn`, `#scan-status`, `#scan-out`: Browsing history scanner and top-distraction auto-selector.
- `#feedback-count`, `#feedback-export`, `#feedback-clear`, `#share-toggle`: On-device centroid learning feedback controls.
- `#save-btn`, `#save-msg`, `#model-progress`: Primary save button (disabled when `settingsLocked` is true), save confirmation badge, and model download progress indicator.

### Block Screen (`src/background/blockscreen.ts`)
- Must remain a **100% self-contained function** (`showBlockScreen`, `applyPreBlockCurtain`, `clearPreBlockCurtain`) with zero external imports or module-scope closures because it is serialized via `scripting.executeScript({ func })`.
- Root overlay ID: `#smartblocker-overlay`.
- Action buttons when unlocked:
  - Override button containing text `"actually productive"` (`"This is actually productive — let me through"`).
  - Close tab button containing text `"Stay focused"` (`"Stay focused (close tab)"`).
  - Dismiss button with text `"Dismiss"`.
- When `locked === true`: Override and Dismiss buttons are omitted; only the lock notice and `"Stay focused (close tab)"` button are rendered.
