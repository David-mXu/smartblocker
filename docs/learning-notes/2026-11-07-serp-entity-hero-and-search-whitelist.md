# Masking Google's entity hero + removing search engines from the whitelist

## The problem

Searching `mr beast` on Google showed most results correctly collapsed into
"SmartBlocker masked: …" bars, but the top of the page was untouched: the
"MrBeast · American YouTuber" header, an image collage, a **"MrBeast -
YouTube"** card and a **latest-video tile** — clickable YouTube links on a page
SmartBlocker was supposed to be sanitizing. (The whole-page block did arrive
"after a bit", but until then, and on any search whose page verdict was
"allow", those links were live.)

Separately, `google.com`, `bing.com` and `duckduckgo.com` were in the default
whitelist. Results pages (`?q=…`) were already excluded from the whitelist by
`isSearchEngineResultsUrl` in [titles.ts](../../src/shared/titles.ts), but a
root entry matches **every subdomain**, so `news.google.com`, image viewers,
inline video previews and so on were exempt. Exemptions like that are how
people find their way back to YouTube.

## Root cause (hero panel)

The in-page sanitizer ([sanitize-page.ts](../../src/content/sanitize-page.ts))
finds SERP modules with selectors scoped to the results column:
`#rso > div`, `#rso div.MjjYud`, `#rhs > div`, …

Inspecting the **live** DOM (via the `browser-use` CLI attached to the real
Edge session) showed where the hero actually lives:

```
#rcnt
 ├─ div.SLPe5b          ← title row: [data-attrid="title"] "MrBeast",
 │                         [data-attrid="subtitle"] "American YouTuber"
 ├─ div.SLPe5b.M8OgIe   ← [data-attrid="VisualDigestWebResult"]  (YouTube card)
 │                         [data-attrid="VisualDigestVideoResult"] (video tile)
 ├─ div#center_col      ← #rso lives in here — everything we used to scan
 └─ div#rhs
```

The hero rows are **siblings** of `#center_col`, not descendants, so no
existing selector could ever match them. Guessing selectors from memory would
have missed this; reading the real DOM first was the decisive step.

## What changed

### 1. Entity-hero pass (sanitize-page.ts, step 4)
- Find `[data-attrid="title"]`; if it sits in an `#rcnt` row that comes
  **before** `#center_col`, collect every preceding non-empty `#rcnt` row as
  the hero. (Classic layouts fall back to the `#rhs`/`.kp-wholepage` box, with
  a guard that refuses any box containing `#rso` or multiple organic results.)
- Decide whether the entity is a distraction:
  - **Deterministic:** the subtitle matches "YouTuber / streamer / TikToker /
    influencer…", "video game / esports…" or "casino / sportsbook…", gated on
    the user's blocked categories.
  - **Otherwise ML:** the title + subtitle + description are sent through the
    existing `EVAL_SUBITEMS` path, the same classifier used for organic cards.
- **Group masking:** `maskElement` gained a `followers` parameter. The first
  row gets the "SmartBlocker masked" bar, the other rows are hidden silently,
  and one "Show" reveals all of them. Without this you'd see one bar per hero
  row.

### 2. Leftover-link sweep (step 5)
A DOM-agnostic backstop, since Google renames classes constantly: for any
remaining link to a video/social, gaming or gambling host, climb from the
link to the largest enclosing "tile" whose external links **all** point at
distraction-type hosts, and mask that. A container that also holds a
productive link (e.g. nvidia.com next to a YouTube unboxing) stops the climb,
so only the YouTube link itself is masked.

### 3. Whitelist ([config.ts](../../src/shared/config.ts), [settings.ts](../../src/shared/settings.ts))
- `DEFAULT_WHITELIST` drops the three search roots and lists
  `GOOGLE_PRODUCTIVE_HOSTS` explicitly (mail, docs, drive, calendar, meet,
  classroom, scholar, cloud, colab, gemini, aistudio, accounts…).
- **Migration for existing installs:** stored settings override defaults, so
  changing the default alone would do nothing for current users. The new
  `whitelistVersion` field plus `migrateWhitelist()` strip the legacy roots
  **once** (and add the Google subdomains back if `google.com` was present).
  Because the version is bumped, a user who deliberately re-adds `google.com`
  later is respected.
- The migration runs at **read time** (like `migrateLabels`), so it applies
  even while a lock freezes settings. That's safe because it only shrinks the
  exemption set, which makes blocking stricter. It's persisted on the next
  save.

## Tradeoffs / open items
- The hero is masked only after the sanitizer runs, which happens after the
  page-level verdict is "allow" (or the full block lands). A pre-curtain on
  SERPs would hide that window but flash every productive search, so it's not
  done.
- The entity subtitle regex is English-only; other languages fall through to
  the ML verdict.
- The sweep follows the existing SERP policy that *all* YouTube results are
  masked (each has its own "Show"), including tutorials on productive
  searches.

## Verification (all observed)
- `npm run typecheck`, `npm run build`: clean.
- `npm run eval`: **no per-case changes** vs baseline (15,874 cases). The
  explicit Google subdomains preserved every previously whitelisted case.
- `node scripts/e2e-test.mjs`: **ALL PASSED**, including new fixture
  assertions: hero rows outside `#center_col` masked with exactly one bar,
  pure social-profile row swept, and in a mixed tile only the YouTube link is
  masked while the NVIDIA link stays visible.
- `node scripts/e2e-p1-overrides-sanitizer.mjs`: **ALL PASSED** (the
  `maskElement` reveal path changed).
- Live Google, real Edge (compiled sanitizer injected into the page): on
  `mr beast`, both hero rows masked under one bar and 0 unmasked
  YouTube/social links remained in `#rcnt`; on `python list comprehension
  tutorial`, the docs/tutorial results stayed visible and the one leftover
  YouTube tile (121 chars) was swept.
- `migrateWhitelist` checked against the real bundled `settings.ts` with a
  stubbed `chrome` global: legacy roots stripped, user entries kept, no
  duplicate subdomains, re-added `google.com` at v2 respected, fresh install
  default correct.
