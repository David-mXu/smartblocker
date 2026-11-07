# Warm Obsidian + Amber Design System & Semantic Tokenization

**Date:** 2026-11-07 · **Scope:** `src/styles/tokens.css`, `src/styles/globals.css`, `src/components/ui/*`, `src/options/`, `src/popup/`, `src/blocked/`, `src/background/blockscreen*.ts`, `src/assets/showcase/*.svg`, `site/`, `docs/design-notes.md`

## 1. Problem & Goal

Although `src/styles/globals.css` declared shadcn-style CSS custom properties (`--background`, `--card`, `--accent`, etc.), **zero components or pages actually consumed them**. Every file in `src/components/ui/`, `src/options/OptionsApp.tsx`, `src/popup/PopupApp.tsx`, `src/background/blockscreen-ui.ts`, and `site/SiteApp.tsx` hardcoded cold near-monochrome zinc + neon emerald classes (`bg-[#070709]`, `bg-[#0d0d12]`, `bg-[#111117]`, `zinc-*`, `emerald-*`). As a result:
- Changing the palette required editing hundreds of scattered utility classes across every surface.
- Neon emerald (`#10b981`) was overloaded to mean brand accent, active toggle, slider thumb, focus context icon, AND positive status ("Saved!", "Connected"), leaving no visual distinction between interactive brand controls and semantic success states.
- The cold blue-black zinc surfaces felt like a generic developer dashboard rather than a calm, high-commitment focus tool.

The goal was to research real focus/productivity references (via Lazyweb MCP and web search) and top design skills on `skills.sh`, choose a distinctive palette direction with the user, codify strict design rules, and refactor all surfaces onto a single semantic token source of truth.

## 2. Core Concepts

- **Semantic Token Indirection (`shadcn/ui` rule #1):** Components and pages reference *roles* (`bg-background`, `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`) rather than *raw color literals* (`bg-zinc-900`, `#111117`). In Tailwind CSS v4, `@theme inline` maps `--color-<role>: var(--<role>)` so standard utilities (`bg-card`, `text-accent-soft`, `border-border/80`) resolve dynamically through CSS variables.
- **Perceptually Uniform OKLCH Ramps (`meodai/skill.color-expert`):** Unlike HSL (where equal "lightness" percentages look wildly different in brightness across hues), **OKLCH** (`oklch(L C H)`) separates perceptual lightness `L` (`0..1`), chroma `C`, and hue angle `H`. Keeping a consistent warm hue angle (`H ≈ 72°–87°`) while stepping `L` (`0.156` → `0.190` → `0.213` → `0.236` → `0.276`) produces an elevation hierarchy that feels cohesive and avoids muddy gray transitions.
- **Dual-Lightness Status Tokens (`base` vs. `-soft`):** A status color (`--success`, `--warning`, `--destructive`, `L ≈ 0.65–0.83`) that works as an icon or solid badge fill is often too dark to read comfortably as small body text over a `10%–15%` tinted dark callout background. Pairing each status hue with a higher-lightness `-soft` token (`L ≈ 0.78–0.88`, slightly lower chroma) guarantees crisp contrast on dark tinted banners without resorting to raw `text-emerald-200` classes.

## 3. Investigation, Research & Decisions

1. **Lazyweb MCP & `skills.sh` Research:**
   - Queried Lazyweb (`lazyweb_search_screens`) for Opal, Raycast, and Endel references (`screens:81ac232a1cac906c8d1b5156`, `screens:ebb68194de7e8b651c7fee2c`, plus the earlier finalized search `7420c370-d6a5-41f9-b755-cf08e676eece`).
   - Loaded the `lazyweb-apply-design-best-practices` routing table and fetched the top-ranked `skills.sh` instruction files directly from GitHub: `shadcn-ui/ui` (`skills/shadcn/SKILL.md`, 271K installs) for semantic token & component composition rules, and `meodai/skill.color-expert` (`SKILL.md`) for OKLCH ramp construction.
2. **Visual Prototyping & User Selection:**
   - Built a side-by-side HTML/CSS preview (`/tmp/opencode/sb-design/palette-preview.html`) rendered via headless Playwright (`/tmp/opencode/sb-design/palette-proposals.png`) comparing three directions: **A — Deep Focus Indigo**, **B — Warm Obsidian + Amber**, and **C — Verdant Slate**.
   - The user selected **B — Warm Obsidian + Amber**, grounded in Opal's commitment-focused warmth where amber (`#e8a33d`) represents deliberate caution/commitment while jade (`#5cb98a`) is reserved exclusively for genuine positive outcomes ("Saved!", "Connected").
3. **Implementation Steps:**
   - **Single token file ([src/styles/tokens.css](../../src/styles/tokens.css)):** Computed exact sRGB → OKLCH conversions via Python and exposed all semantic roles (`background`, `card`, `popover`, `muted`, `secondary`, `foreground`, `muted-foreground`, `primary`, `accent`, `accent-soft`, `success`, `success-soft`, `warning`, `warning-soft`, `destructive`, `destructive-soft`, `border`, `input`, `ring`) through `@theme inline`. Imported `tokens.css` into both [src/styles/globals.css](../../src/styles/globals.css) and [site/styles.css](../../site/styles.css).
   - **Refactored all 7 `shadcn/ui` primitives ([src/components/ui/](../../src/components/ui/)):** Replaced hardcoded `zinc`/`emerald`/`#0d0d12` classes in `button.tsx`, `badge.tsx`, `card.tsx`, `input.tsx`, `textarea.tsx`, `select.tsx`, and `switch.tsx` with semantic tokens and renamed palette-coupled variant names (`emerald` → `accent`, `amber` → `warning`, `crimson` → `destructive`).
   - **Swept all application & site surfaces:** Updated [src/options/OptionsApp.tsx](../../src/options/OptionsApp.tsx), [src/popup/PopupApp.tsx](../../src/popup/PopupApp.tsx), [site/SiteApp.tsx](../../site/SiteApp.tsx), and the HTML entry shells (`options.html`, `popup.html`, `blocked.html`) to use semantic token classes.
   - **Updated isolated blockscreen surfaces ([src/background/blockscreen.ts](../../src/background/blockscreen.ts), [src/background/blockscreen-ui.ts](../../src/background/blockscreen-ui.ts)):** Because `blockscreen.ts` is serialized via `chrome.scripting.executeScript({ func })` into hostile host pages without extension CSS, updated its inline style constants to the exact hex/rgba equivalents of the Warm Obsidian + Amber tokens.
   - **Warmed showcase SVGs & fixed hero inline pill ([src/assets/showcase/](../../src/assets/showcase/), [site/SiteApp.tsx](../../site/SiteApp.tsx)):** Remapped the 9 showcase SVGs from cool blue-zinc stops to warm obsidian + amber/ivory stops, removed the `grayscale` filter on the landing site, and replaced the unquoted CSS `backgroundImage: url(${heroPillImg})` (which failed to parse because Vite's SVG data URI contains single quotes) with an `<img>` element inside the pill container.

## 4. Alternatives & Tradeoffs

- **Hex vs. OKLCH in `tokens.css`:** Hex is shorter to read, but OKLCH makes lightness steps and contrast relationships explicit in the stylesheet (`L = 0.156` → `0.190` → `0.213` → `0.236` → `0.276`). Each token line includes its hex equivalent in a comment so grep and human inspection remain effortless.
- **Inline hexes in `blockscreen.ts`:** We cannot import `tokens.css` inside `blockscreen.ts` because MV3 `executeScript({ func })` serializes only the function body into the target page's isolated world. Keeping a documented 1:1 hex mapping in `docs/design-notes.md` §3 is the cleanest tradeoff.

## 5. Verification (Observed)

- **Zero leftover palette classes/hexes:** `grep -rnE "zinc-[0-9]|emerald-[0-9]|amber-[0-9]|red-[0-9]|crimson|#070709|#0d0d12|#111117..." src/ site/` returned **0 matches**.
- **Typecheck & full builds:** `npm run typecheck`, `npm run build` (`dist/chrome` + `dist/firefox`), and `npm run build:site` (`dist-site/`) all succeeded with zero errors.
- **Headless Chromium verification (`/tmp/opencode/sb-shots/shot2.cjs`):**
  - `options.html`: `getComputedStyle(document.body).backgroundColor` → `oklch(0.156 0.0071 78.3)`, `#enabled-toggle` track → `oklch(0.765 0.1399 72.9)`, all 22 E2E contract IDs and 3 erasure-card strings present, 0 page errors.
  - Visual inspection of screenshots (`/tmp/opencode/sb-shots/p2-options-00.png`, `p2-options-50.png`, `p2-popup.png`, `p2-blocked.png`, `p2-site-00.png`, `p2-site-35.png`, `p2-site-62.png`) confirmed warm obsidian surfaces, amber interactive accents, jade/crimson semantic distinction, and the restored hero inline pill on the landing site.
