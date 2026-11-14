# Stale-ALLOW verdict race: why allowing a page can unblock another

## The problem

SmartBlocker's background service worker classifies page titles asynchronously.
Two pages in the same tab can therefore be classified **at the same time**:
`arm()` (src/background/blocker.ts) frees the `inFlightKey` guard on every new
navigation, so when the user leaves page A while A's classification is still
running, page B's evaluation starts immediately next to it. The code already
guarded the *blocked* direction — a stale BLOCK verdict for A must not paint a
block screen over B ("the user already left" check on `navGeneration` +
`armedUrl`). But nobody guarded the *allow* direction: when A's slow
classification finally resolved to ALLOW, its `else` branch ran
`clearCurtain(tabId)` / `clearOverlay(tabId)` / `clearForceRedirectRule(tabId,
urlA)` on the **tab**, which by then was showing **B's just-installed block
screen**. A stale allow silently unblocked the page the user was actually on.
The sub-frame path never had this bug — it re-checks its own generation before
either branch (the `subFrameGeneration` gate), which is direct evidence the
main-frame gap was an oversight, not a design choice.

Two smaller concurrency defects sat next to it: `addForceRedirectRule`
(src/background/force-redirect.ts) read its dedupe index *before* an `await`
and wrote it *after*, so two racers both installed a DNR session rule and one
rule became invisible to the index (leaked until unlock); and `logSample` did
an unguarded read-modify-write of `storage.local.latencySamples`, so two
overlapping evaluations lost whichever sample wrote first.

## Concepts

- **Generation tokens** (`navGeneration`, `subFrameGeneration`): a counter
  bumped on every `arm()`. An async task captures it before its first `await`
  and re-checks it before performing side effects. Stale ⇒ drop the work.
- The subtlety that makes a naive `generation !== mine` check wrong here:
  `onHistoryStateUpdated` re-arms the SAME url and bumps the generation
  anyway, so "generation moved" does not imply "the page moved". That is why
  the gate is `navGeneration.get(tabId) === myGeneration || armedUrl.get(tabId)
  === url` — either it is still my turn, or the turn belongs to the same URL.
- **Fail-open vs fail-closed teardown**: tearing down a block screen is a
  security-relevant action; the guard errs toward NOT tearing down whenever
  uncertain. A surviving block screen is a visible annoyance; a silently
  unblocked distraction page is an invisible protection failure.

## What was changed (evidence + reasoning)

1. **blocker.ts `onTitle`** — added `stillCurrentPage()`, the exact
   disjunction above, next to the existing SERP-only `stillCurrentTitle()`.
   Applied it to every teardown point for main frames:
   - the ALLOW `else` branch (the reported bug),
   - the master-switch-off early return,
   - the whitelisted-URL early return,
   - the YouTube-browsing-surface early return
   (in the last three, `armedAt.delete` is gated too, because a stale caller
   deleting it would also erase the *newer* evaluation's latency anchor).
2. **force-redirect.ts `addForceRedirectRule`** — the reservation
   (`indexRule`) now happens **before** `await updateSessionRules` and is
   reverted (`unindexRule`) if the install fails, so the second racer sees the
   first's entry (`already-enforced`) instead of installing a duplicate. A new
   post-install recheck handles the one hole the reservation opens: a
   concurrent `clearForceRedirectRule` during the in-flight add could only
   drop the index entry (the live rule did not exist yet for it to remove).
   If the reservation is gone after the add lands, the rule is removed and
   `'failed'` is returned so the caller falls back to the injected overlay —
   never a rule we cannot account for reported as enforcement.
3. **blocker.ts `logSample`** — serialized by a single in-context promise
   chain (`latencyLogQueue`), the same enqueue pattern
   `usage-stats-tracker.ts` already uses. A failing link is swallowed for the
   *chain* but still rejects for the awaiting caller, so error handling at
   existing call sites is unchanged.

Verification: `npm run typecheck` passes for these files (during the audit
other builders' in-flight edits elsewhere transiently failed the same command;
a clean full run was re-confirmed once the worktree settled). A new focused
e2e, `scripts/e2e-stale-allow-race.mjs`, reproduces the race deterministically
without test hooks: clearing `titleCache` + `centroidCache` forces the first
classify to pay the full ~2.5 s centroid rebuild, which widens the verdict
latency window far beyond any scheduling jitter; page B is a `settings.blocklist`
hit so its block is instant and deterministic.

## Alternatives and residuals

- Alternative guard: RETURN early on a stale allow instead of gating side
  effects. Rejected because `logSample` (used by the latency diagnostics page)
  should still record the verdict, and because the disabled/whitelisted
  YouTube paths legitimately continue after the gate for non-DOM work.
- Residual (deliberate): the third recordTabStatus write in the
  YouTube-browsing early path stays ungated — same behavior as before, in
  scope discipline; the popup record for the classifier path already had the
  generation gate.
- Residual in force-redirect.ts: a racer that got `already-enforced` while
  the first install later fails sees a rule that does not exist — but the
  naming is honest only if failure also unindexes, which it now does, and the
  post-install recheck converts the mid-flight-clear case into a fallback to
  the injected overlay rather than a silent allow.
