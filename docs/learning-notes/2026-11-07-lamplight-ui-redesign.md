# Lamplight: redesigning SmartBlocker's popup, options and block screen

**Date:** 2026-11-07 · **Design doc:** [`docs/design-notes.md`](../design-notes.md)
· **References:** Lazyweb board
<https://www.lazyweb.com/agentic-search/699981d4-0acf-4bf4-ae54-e28bdb662eaa>
· Builds on [2026-11-07-warm-obsidian-amber-design-system](2026-11-07-warm-obsidian-amber-design-system.md)

## 1. The problem

The extension UI "looked like slop" even though it already had a token
system (warm obsidian + amber, OKLCH, shadcn semantic classes). Having
**colors** is not the same as having a **design language**: hierarchy,
density, and one obvious thing to look at per screen.

## 2. Investigation, in order

### Step 1 — look at the rendered UI, not the source
A Playwright script (`.design-work/shoot.mjs`, gitignored) loads `dist/chrome`
as a real extension and screenshots the popup, options (1280px + 390px) and
both block screens. *Why this tool:* "slop" is a visual judgment; reading JSX
can't show you that nine sections all have identical weight.

Findings (full list in design-notes §1): cards nested inside cards, mono
uppercase jargon labels ("BGE-Small Local Centroid Engine"), amber on
everything, decorative badges, diagnostics given the primary button slot,
and the block screen making **"let me through"** the primary action.

### Step 2 — the font bug hiding in plain sight
The screenshots looked like DejaVu Sans, not Geist. Evidence from
`page.evaluate` in the extension page:

```
html font: Geist, …      body font: "DejaVu Sans", Arial, sans-serif
document.fonts → Geist:unloaded
```

**Root cause — CSS cascade layers.** Chrome injects its own stylesheet into
extension pages (`body { font-family: <system>; font-size: 75% }`). That
stylesheet is *unlayered*. Tailwind v4 puts base styles inside
`@layer base`. The cascade rule: **unlayered author styles beat every
layered style, regardless of specificity or order.** So our `html, body`
font rule silently lost on `<body>`, and every page rendered in the system
font at 12px. `<html>` was fine (Chrome doesn't target it), which is why the
bug was easy to miss.

**Fix:** declare body typography *outside* any `@layer` in
`src/styles/globals.css`. After the fix `document.fonts.check('16px Geist')`
returns `true`.

### Step 3 — pick the right design skill (via Lazyweb)
Lazyweb's skill-routing table ranks skills per design task. The relevant
distinction: **gpt-taste** (used earlier) is a *landing page* skill and its
own entry says "do not use for dashboards"; **Dammyjay93/interface-design**
is the pick for *settings pages, tools, dashboards*. Applying a marketing
skill to a settings page is exactly how you get a brochure-looking settings
page. We layered the **shadcn** skill for component rules.

### Step 4 — gather real product evidence
Lazyweb MCP wasn't registered in this Claude Code session, but its token was
installed, so we called its HTTP MCP endpoint directly (JSON-RPC
`tools/call` → `lazyweb_execute`). Searches: dark settings pages, app
blocker schedules, focus timers, blocked/limit screens. Takeaways: Linear/
Notion settings are *one surface* of grouped rows; Opal/Endel make the
block/limit moment calm, with one focal element and one action.

### Step 5 — write the design doc before code
Following interface-design's "intent first": who (a student mid-task), what
(commit to focus / go back to work), feel (a desk lamp at night). Two
**signatures**: the *Threshold Meter* (score bar + amber tick at the user's
threshold) and *amber means commitment only*. The doc also records the e2e
DOM contract so a redesign can't silently break tests.

### Step 6 — implement
- `src/styles/tokens.css`: added `--faint` (4th text tier) and font tokens.
- `src/components/ui/`: flattened Button/Card/Input (no shadows/blur/glow),
  ivory "on" Switch, new `Checkbox` and `settings.tsx`
  (`SettingsSection` → `SettingsGroup` → `SettingRow`).
- Options: sticky scroll-spy nav + grouped rows; sentence-case categories;
  amber lock banner instead of red.
- Popup: status first, no GSAP entrance animation (opened many times a day →
  animation reads as slowness), diagnostics demoted to a footer but kept
  **visible** because e2e suites click them.
- Block screens (`blockscreen.ts` + `blockscreen-ui.ts`, intentional
  duplicates): no card, "This one can wait.", Threshold Meter, **Stay
  focused** as the primary ivory button. `showBlockScreen` gained an
  *optional* 7th `threshold` arg (old callers still work); `blocker.ts`
  passes `settings.blockThreshold` at its three injection sites.

## 3. Alternatives and tradeoffs

- **Changing the palette** — rejected; the palette fit the product. The
  problem was structure and distribution of the accent.
- **Collapsible diagnostics** (`<details>`) — rejected: Playwright can't click
  a button inside a closed `<details>`.
- **Self-hosting Geist inside the injected overlay** — not done; host pages
  can't load our font without web-accessible resources, so the overlay uses
  the OS UI font (Segoe UI / SF / DejaVu). Acceptable; documented.
- `blocked.html`'s meter has no threshold tick because the DNR redirect URL
  doesn't carry the threshold (would need a `force-redirect.ts` change).

## 4. Verification

Observed (2026-11-07):

- `npm run typecheck` — clean. `npm run build:chrome` and `npm run build:firefox` — succeed.
- Token grep from design-notes §6 over `src/**/*.tsx` — no raw palette classes or hexes.
- Before/after screenshots (popup, options 1280 + 390, injected overlay,
  `blocked.html` locked) inspected by eye; fixed two issues found that way
  (odd-count category grid left a filler cell; meter tick vanished on a full
  fill bar).
- E2E: `e2e-test` (24 PASS), `e2e-p2-dnr` (20), `e2e-p2-kdf-modelpin` (18),
  `e2e-security-blockscreen` (9), `e2e-p1-overrides-sanitizer` (10) — all pass.
- `e2e-p1-privacy-failclosed` initially failed ONE check, "options showcase
  images … (0 imgs)". Not caused by this redesign: committed HEAD's options
  page had 4 showcase `<img>`s, and the earlier same-day `site/` split had
  already removed them before this work began. The check now asserts the
  real privacy invariant (any image is local and renders) without requiring
  images to exist. The suite also gained a **computed body font** assertion
  for popup and options: the old `document.fonts.load()` check passed even
  while the cascade-layer bug was live, because it proves a font *can* load,
  not that `<body>` *uses* it. Re-run: ALL PASSED.
- Not run: `scripts/verify-firefox-dnr.mjs` (needs a local Firefox binary)
  and the companion e2e (no `companion/` changes).
