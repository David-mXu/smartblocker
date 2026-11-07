# Splitting the landing page out of the options page

**Date:** 2026-11-07 · **Scope:** `src/options/`, new `site/`, docs, popup tooltip, `globals.css`

## 1. The problem

The extension options page ([src/options/OptionsApp.tsx](../../src/options/OptionsApp.tsx))
had grown into a full landing page: a marketing hero ("Silence the impulse,
preserve the craft."), an infinite capability marquee, a scroll-scrubbed
manifesto, scroll-pinned feature chapters with showcase SVGs, a hover-expanding
"interception ladder" accordion, and a "Commit Your Focus Policy" commit footer
— with the actual settings sandwiched in the middle. Any returning user who
clicked "Options" from the popup to tweak a threshold had to scroll an entire
product pitch again. No separate landing page existed anywhere.

Measured on the built page (headless Chromium, 1440×900): **7,837 px tall,
~54% marketing** (hero ~1,006 px, "Defense Architecture" showcase ~3,398 px),
settings only ~35% (~2,719 px).

## 2. Root cause / context

This was intentional, not an accident: on 2026-10-26 the page was redesigned as
a "full-viewport AIDA Command Center" (see
[2026-10-26-editorial-ui-ux-refresher-shadcn-gsap.md](2026-10-26-editorial-ui-ux-refresher-shadcn-gsap.md)) —
Attention → Interest → Desire → Action copy structure, confirmed by JSX section
comments ("A — ATTENTION: EDITORIAL SPLIT HERO", …) and `MANIFESTO_TEXT` /
`ACCORDION_PANELS` / `PINNED_CHAPTERS` constants. Because the options page
auto-opens on install (`src/background/index.ts:45-48` `onInstalled →
openOptionsPage()`), it doubled as the first-run splash. But ROADMAP Phase 3's
marketing plan only listed a Chrome Web Store listing + social posts, so the
landing content had no proper home. Chrome/Mozilla guidance treats options
pages as configuration surfaces, with any splash/onboarding as a separate
one-time surface; comparable blockers (uBlock, LeechBlock, StayFocusd,
Cold Turkey) all ship plain functional settings.

## 3. Investigation → decisions

- **Subagent recon (parallel explore agents)** mapped the 1,909-line file's
  sections, confirmed no other landing page/scaffold existed in-repo
  (companion/, feedback-worker/, .github/ all checked), and traced what opens
  options.html (install redirect + popup gear + browser extension manager).
- **E2E contract inventory** (grep over `scripts/*.mjs`) found exactly what the
  Playwright suites depend on in options.html — IDs `#save-btn`, `#lock-status`,
  `#companion-status`, `#lock-password`, `#lock-password-btn` and text strings
  "Your shared feedback data", "Delete shared data", "none yet — created the
  first time you share…", "Feedback sharing is not configured in this build".
  (`#scan-history`/`#out`/`#test-pair` turned out to be **popup** IDs; the
  privacy suite only checks fonts/no-remote-images on options.) This made a
  UI-only rewrite safe if all IDs/strings survived.
- **Headless render harness** (`playwright` from repo `node_modules`, tiny
  built-in HTTP server + a `chrome.*`/MV3 API stub via `addInitScript`) let us
  screenshot and DOM-probe the real built page without touching the user's
  browser — suitable because the page renders fully with default settings even
  with stubbed extension APIs.
- **User decisions:** landing content → **public marketing website**; onboarding
  banner flow **stays** in options; options → **conventional restructure**
  (single-column dashboard); install **still auto-opens once** (the slimmed
  options page, which is where onboarding lives).

## 4. Implementation

1. **Snapshot:** copied the pre-change `OptionsApp.tsx` to `/tmp` so the landing
   copy could be ported verbatim regardless of the rewrite.
2. **New `site/` app** (delegated to a subagent working only from the
   snapshot): Vite + React + Tailwind v4 + GSAP standalone page — glass-pill
   nav, hero, marquee, scrubbed manifesto, pinned "Engineered for Unbreakable
   Focus" chapters, 3-stage accordion, privacy cards, GitHub-releases CTA,
   footer. Reuses `src/styles/fonts.css` (self-hosted Geist) and
   `src/assets/showcase/*.svg`; new `vite.config.site.ts` + `build:site` /
   `deploy:site` scripts (deploy = `wrangler pages deploy dist-site`, **not
   run**, needs Cloudflare Pages project creation).
3. **Options rewrite:** deleted GSAP/ScrollTrigger/useGSAP, all 9 SVG imports,
  `MANIFESTO_TEXT`/`ACCORDION_PANELS`/`PINNED_CHAPTERS`, hero, showcase,
  marquee, glass-pill marketing nav, editorial `py-32/48` padding — roughly
  700 lines of landing machinery. Rebuilt as: slim sticky header (logo,
  version, status badge, `#save-msg`, `#save-btn` "Save"/"Finish setup") →
  unchanged onboarding banner + `#lock-status` banner → 7 stacked settings
  cards (semantic engine, commitment lock `#commitment-lock`, categories,
  deterministic rules, schedules, desktop companion + history audit, on-device
  learning + erasure) → compact footer with `#model-progress`. **All state,
  effects, handlers, IDs, classes, and e2e-tested strings preserved
  byte-identically.** Full-page: 7,837 → **3,710 px**.
4. **Cleanup:** removed now-dead `.animate-marquee` / `@keyframes marquee-scroll`
   / `.bg-editorial-grid` from `globals.css` (site has its own copies), popup
   tooltip "Open full Command Center" → "Open settings", and doc updates
   ([CLAUDE.md](../../CLAUDE.md) options bullet + new `site/` entry,
   [README.md](../../README.md) UI bullet + build command,
   [ROADMAP.md](../../ROADMAP.md) Phase 3 migration note + deploy task,
   [design-notes.md](../design-notes.md) migration banner + reference fixes).

## 5. Alternatives considered / tradeoffs

- **In-extension welcome page** (welcome.html opened once on install): would
  have preserved the GSAP work with zero new infrastructure, but the user
  preferred a real public site for launch marketing. Scope cost: new build
  pass, a deploy target (Cloudflare Pages), and a future custom domain.
- **Delete the landing content entirely:** simplest, but discards the design
  work that is genuinely useful for the Phase 3 launch (Show HN / Product Hunt).
- The site is static, tracker-free, and shares the extension's assets/palette,
  keeping maintenance and the privacy posture intact.

## 6. Verification (observed, not assumed)

- `npm run typecheck` — passes (site/ is outside tsconfig `include:["src"]`).
- `npm run build` (chrome + firefox, all passes) and `npm run build:site` —
  pass; options bundle contains **zero** `gsap`/`ScrollTrigger`/`scrub-word`/
  manifesto strings (grep).
- Headless DOM probe of `dist/chrome/options.html`: `hasHero/hasManifesto/
  hasDefense` all false; **all 20 contract IDs present**; page height
  7,837 → 3,710 px; zero page errors. ("Feedback sharing is not configured in
  this build" absence is expected — `FEEDBACK_ENDPOINT` is configured in this
  build, so the no-endpoint note correctly doesn't render.)
- Headless render of `dist-site/index.html`: hero, 33 `.scrub-word` spans,
  3 `.gsap-scale-card` prism cards, zero errors — the AIDA showcase intact in
  its new home (~6,104 px of landing where it belongs).
- **Not run:** full Playwright e2e suites (they need real profiles/model
  downloads). The ID/string contract they assert was preserved verbatim and
  spot-verified in the built DOM; run `node scripts/e2e-test.mjs` before the
  next release for full confidence.
- Site **not deployed** — `npm run deploy:site` requires explicit approval
  (creates a Cloudflare Pages project; initial URL `smartblocker.pages.dev`).
