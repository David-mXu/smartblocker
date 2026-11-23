# Opt-in in-feed card masking (`settings.maskFeeds`)

## Why

The 2026-11-21 market research ranked in-feed Shorts/Reels masking as the
remaining unmet need: page-level classification cannot stop a distracting card
that sits on an otherwise-productive YouTube home, subscription or channel
feed, and users install separate Shorts blockers for exactly that (often
unstable ones). The browsing-surface exemption is deliberate — the page itself
must stay usable — so the answer is per-card masking, opt-in.

## What changed

- New profile-scoped setting `maskFeeds` (default **false**), plumbed through
  settings defaults, profile sanitize/apply, backup export/import + change
  summary, the sanitizer sweep keys, and `runPageSanitizer`.
- `sanitize-page.ts` generalizes the YouTube card pass:
  - `/results` keeps using `maskSearchElements` (unchanged behavior).
  - Home / `feed/*` / `@channel` / `channel|/c/|/user/` / `playlist` surfaces
    run the same per-card classification when `maskFeeds` is on, with the
    broader `ytd-rich-item-renderer`, `ytd-compact-video-renderer`,
    `ytd-rich-grid`/reel/Shorts-lockup coverage.
  - Nested renderers are skipped so one video is never queued twice; the
    existing pending/id/authority machinery, blocklist pass, and subitem budget
    apply unchanged.
  - Turning the setting off reveals previously masked cards through the same
    user-reveal authority as the search-masking toggle.
- Options → Blocking gains the `#mask-feeds-toggle` switch with outcome-first
  copy ("Hide distracting cards on YouTube home and feeds"), lock-aware.
- Docs: design-notes §5/§7, CLAUDE gotcha with the opt-in boundary.

## Verification

- `e2e-test` fixture: YouTube home with a gaming card, a React tutorial card and
  a Short — with `maskFeeds` on, the game card is masked, the productive card is
  visible, the page has zero overlays; turning it off reveals the masked card.
- profiles/backup pure tests pin the setting's default, sanitize fallback,
  round-trip, and change-summary behavior.
- typecheck + Chrome build green; the rest of `e2e-test` (SERP, YouTube Search,
  embeds, locks) still passes.

## Boundary

The page-level browsing-surface policy is unchanged: YouTube home/feeds are
still allowed as pages. This only folds individual cards, and only when the
user opts in; a card can always be opened deliberately.
