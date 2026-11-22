# Override friction tier + closing the audit's test gaps

## Why

The 2026-11-21 audit's market research ranked a **timed pause** as the cheapest
validated retention/ethics win: Android 17's "Pause Point" (May 2026) ships a
10-second speed bump, and the PNAS delay-vs-moralizing work says the delay is
what works. SmartBlocker only had a one-click release or an opt-in typed wall;
the one-click default made the override an impulse action.

The same audit listed the store's riskiest **untested** paths: the override
store, the feedback learning fold, and the 60-second deferred Focus-session
commit (an irreversible lock written by a timer).

## What changed

### `surrenderMode: 'off' | 'pause' | 'phrase'`

- `shared/surrender.ts` gains `PAUSE_OVERRIDE_MS = 10_000`,
  `normalizeOverrideFriction()`, and `pauseElapsed()` (pure, Node-tested).
- The injected block screen's unlocked override now branches three ways. The
  new `#smartblocker-pause-wall` shows a live countdown and an "Open anyway"
  button that stays `disabled` until the deadline; activation additionally
  re-checks the deadline and `isTrusted`, so a page-scripted click is inert.
  Cancel returns to the normal choice row. No typing, no guilt copy.
- Options → Blocking replaces the boolean switch with a three-option
  `#surrender-mode-toggle` ("One click" / "10-second pause" / "Type a
  sentence"); the id from design-notes §7 is preserved.
- Profile/backup sanitize accepts `pause` (unknown values still fall back to
  `off`); the existing lock guard hides the override entirely, so friction
  tiers never apply under a lock.

### New harnesses (audit gaps)

- `scripts/overrides-test.mjs` — normalization (Cf/NFKC/space/300 cap), host
  scoping vs legacy host-less entries, www-insensitivity, refresh-in-place,
  separate scopes per host, concurrent-add serialization, the 1,000 cap, empty
  titles, failed-write cache invalidation, external-write invalidation.
- `scripts/feedback-test.mjs` — field caps, 500-record bound, concurrent
  appends, `markUploaded`/`markSkipped` ts identities, clear, failed-write
  invalidation, and the on-device learning fold (`getPrototypeExamples`):
  false-positive → user-approved neutral, false-negative → corrected label,
  newest-24 per centroid, unusable records skipped.
- `scripts/focus-session-test.mjs` — the deferred commit: no lock write on
  start, undo clears the pending record + alarm, pre-deadline commit is a no-op,
  post-deadline commit writes the FIXED end time then is idempotent, expired
  sessions clear without writing, undo after commit returns false, and the
  alarm listener path commits.

### E2E

`e2e-p1-overrides-sanitizer` now drives the pause tier against a real Chromium:
the wall appears, the release button is disabled, a synthetic early click does
not release or record, ~10 s later the button enables, and clicking it releases
the page and records the correction.

## Verification

- typecheck clean; Chrome build green.
- pure battery green including the three new suites and the extended
  surrender/profiles cases.
- `e2e-p1-overrides-sanitizer`: ALL PASSED (pause tier + the prior
  sanitizer/override cases).
- `e2e-test` and `e2e-profiles` re-run for regressions on the shared block
  screen and the settings page.

## Deliberately not done

- No "pause" for the popup's "Should've been blocked" report (it is not a
  release path).
- The pause tier is opt-in and never applies while locked; it is friction, not
  authentication.
