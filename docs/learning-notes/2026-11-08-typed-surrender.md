# Typed surrender: adding effort without weakening hard locks

**Date:** 2026-11-08 · **Scope:** Phase 5 Batch 2 item 7 · **State:** merged and
committed on main; this note records the implementation and verification context.

## Goal and boundary

The opt-in typed-surrender mode adds deliberate effort before a user invokes the
existing **non-locked** block-screen override. It is not an unlock mechanism for
Timer, password, Frozen, schedule, delay or random-text locks. Those lock states
continue through their existing authorized paths.

The important distinction is between a UI obstacle and an authorization boundary.
The phrase and wait make an impulsive override slower; the background's existing
one-time override nonce remains the security decision. The typed phrase does not
replace that nonce or grant any new privilege.

## Implemented behavior

- [`src/shared/surrender.ts`](../../src/shared/surrender.ts) contains the pure,
  browser-independent calculations: the fixed neutral phrase, a 15-second wait,
  deadline arithmetic and exact phrase comparison. Only surrounding whitespace is
  ignored; case, punctuation and internal spacing must match.
- The injected block screen shows a dedicated type-to-continue wall only when the
  page is not locked and `surrenderMode` is `phrase`. It cannot send an override
  merely because a countdown or button animation completed.
- Submission requires both an elapsed deadline and the exact phrase. Early or
  wrong input stays rejected; a wrong-entry restart requires a fresh full wait,
  with no partial timing credit.
- A successful interaction sends the **same nonce-carrying `OVERRIDE` message** as
  the pre-existing flow. `src/background/index.ts` still consumes the one-time
  token, so the nonce and message shape do not change when surrender mode is on.
- The pure module is mirrored inside the injected function because
  `executeScript` serializes that function and cannot close over module imports.
  This is why the small calculations have a focused unit suite rather than a new
  runtime messaging protocol.

## Investigation and integration evidence

The feature landed beside breaks and the extension-loss notice in an isolated
worktree. Merge review checked the shared hotspots rather than assuming a clean
patch was sufficient: `settings.ts` retained both break and surrender settings,
`blocker.ts` passed surrender parameters alongside break relaxation, and
`blockscreen.ts` retained its original nonce path. Popup grace components were
kept independent of the override wall.

The design deliberately left the pre-existing transient block-screen Dismiss
behavior for a later product decision. Changing or removing it was not silently
bundled into this opt-in setting.

## Verification

The final combined main-tree verification observed:

- `node scripts/surrender-test.mjs`: **12 passed, 0 failed**. Cases covered the
  character budget, exact inclusive deadline, early/wrong rejection, whitespace,
  case and punctuation drift, and a wrong-entry restart requiring the full delay.
- `node scripts/lock-math-test.mjs`: **124 passed**, confirming no lock merge
  regression in the final Batch 2 tree.
- `npm run typecheck`, Chrome/Firefox builds and Playwright **E2E: ALL PASSED**.
- `npm run eval`: **PASS: no regressions**, all metrics unchanged and no per-case
  changes across **15,874** cases.

No classifier, evaluation dataset or lock-schema behavior was changed by this
setting. Implementation was reviewed before the separately authorized commit;
no remote push was requested.

The broader integration decisions are documented in
[`2026-11-08-batch2-lock-mirror-merge.md`](2026-11-08-batch2-lock-mirror-merge.md).
