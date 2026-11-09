# Idle-aware usage statistics and dashboard

> **Extended 2026-11-09:** protection/lock/break annotations, block-reason
> classes, v1→v2 storage migration, and the richer Usage dashboard are covered
> in [2026-11-09-usage-protection-analytics.md](2026-11-09-usage-protection-analytics.md).
> The storage key is now `usageStats:v2`.

## Problem and scope

Phase 5 Batch 3 item 9 needed per-local-day site/category usage statistics, a
rolling seven-day **pages silenced** count, an explicit override rate, JSON
export, and confirmed clearing. The data source had to be tab activity and the
existing per-tab verdicts—not `chrome.history`—so private-window activity could
be included when the extension is allowed there and clearing browser history
would not erase the aggregates.

The implementation was built and reviewed in worktree
`/home/davidxu/.local/share/opencode/worktree/0971ea/b3-usage-statistics`, based
on `2e15e6c`, then integrated into `main` alongside Batch 3 wildcard grammar.
The completed Batch 3 scope was integrated into a path-specific `main` change,
with unrelated work excluded. The isolated statistics worktree left
classifier/eval, companion, tab-status, wildcard, and ROADMAP files unchanged;
integrated verification is recorded separately below.

## Design and implementation

### Pure aggregation and privacy boundary

[`src/shared/usage-stats.ts`](../../src/shared/usage-stats.ts) is a
browser-independent, erasable-syntax-only reducer module. It:

- extracts and normalizes only the hostname from an `http:` or `https:` URL;
- splits active intervals at civil midnight using local `Date` construction, so
  23-hour and 25-hour DST days do not need fixed 24-hour arithmetic;
- stores daily total, hostname, and category buckets;
- computes `overrideRate` as `null` when pages silenced is zero rather than
  presenting an empty denominator as 0%;
- retains 35 local days, at most 100 site and 50 category buckets per day (with
  explicit combined overflow buckets), and at most 2,000 opaque blocked-decision
  IDs for duplicate suppression; and
- exports aggregates only. Checkpoints and duplicate-suppression IDs are omitted
  from JSON export.

The single `storage.local["usageStats:v1"]` value contains daily aggregates, a
foreground checkpoint, and bounded opaque decision IDs. It deliberately has no
full URL, path, query, fragment, title, score, rule text, or event/history log.
Full URLs live only transiently in browser-event handling while their hostname
is extracted. No usage network request was added.

### Active-time accounting and persistence

[`src/background/usage-stats-tracker.ts`](../../src/background/usage-stats-tracker.ts)
serializes reads, transitions, counters, snapshots, and clears through one
promise queue. Aggregates and their checkpoint are written together in one
storage value; splitting them could commit elapsed time without advancing its
checkpoint and then charge that interval again after restart.

Collection uses a one-minute heartbeat and 15-second batched writes. Only a
focused window's active http/https tab with `idle.queryState(30) === "active"`
has a target. A precisely observed focus/tab boundary closes the preceding
segment. Idle/API uncertainty discards the preceding uncertain interval. A first
checkpoint after tracker construction is recovery-only, and gaps over 135
seconds are discarded in full instead of capped into manufactured time. Missing
focus or idle event APIs conservatively stop time accrual but do not disable
blocked-page or override counters.

[`src/background/usage-stats.ts`](../../src/background/usage-stats.ts) attaches
its listeners synchronously for MV3 startup. It observes tab, focus, idle,
navigation, alarm, and existing `storage.session` `tabStatus:*` events. It never
calls a browser history API or runs the classifier.

A blocked or blocked-rule status increments pages silenced once per
navigation/block generation. Main-frame `webNavigation.onCommitted` starts a new
navigation generation even for a same-URL reload; fragment changes and repeated
verdict paints reuse the current generation. If a service worker restarts and an
already-blocked verdict is re-emitted, the storage change's old verdict
reconstructs the blocked state without double-counting it. Overrides are counted
only in the existing `OVERRIDE` RPC after its one-time token guard succeeds, and
a statistics-storage failure is logged without interrupting the rest of that
existing override flow.

### Options dashboard

[`src/options/pages/UsagePage.tsx`](../../src/options/pages/UsagePage.tsx) adds
the `#usage` route using the existing Lamplight settings primitives. It shows:

- pages silenced and completed overrides divided by pages silenced over the last
  seven local days (a dash for an empty denominator);
- approximate focused active time;
- a local-day selector with site and category tables;
- JSON export backed by a fresh background snapshot and a local Blob download;
- a second-click, five-second clear confirmation; and
- explicit retention, private-window, and history-clear-independent copy.

Clearing removes the local usage namespace, returns an actually empty snapshot,
and permits fresh collection afterward. Both manifests add only the `idle`
permission.

## Review findings and fixes

The isolated final pass was a code review rather than only a build pass. Three
edge cases were corrected there; the integrated `main` audit then caught a
fourth, privacy-critical case. All four have focused regression coverage:

1. **Queued event timing:** ordinary checkpoints originally sampled `Date.now()`
   when their queued work began. A slow earlier storage/verdict operation could
   stretch the preceding active interval. Checkpoints now capture their event
   timestamp at observation time. A gated-resolver regression proves that a
   delayed unfocus event closes exactly 30 seconds, not 60.
2. **Failed clear consistency:** clearing originally replaced in-memory state
   before awaiting `storage.remove()`. If removal failed, the UI had reported an
   error but a following snapshot could expose/write the empty in-memory state
   while the durable old data still existed. Durable removal now happens first;
   an injected failure preserves both copies and a retry succeeds.
3. **Navigation generation dedupe:** same-URL committed reloads and
   service-worker reconstruction old verdicts need opposite treatment. Reloads
   now force a new navigation ID, while old+new blocked session values for the
   same page suppress only the cold in-memory reconstruction. The mocked
   browser test covers no duplicate on verdict re-emission and a new count after
   a same-URL `onCommitted` reload.
4. **Rule-label privacy:** an authenticated override carries its user-facing
   model label. For deterministic blocks that label embeds the actual blocklist,
   title, or channel rule, so a rule containing a URL/path/query could have
   become a durable category through either the override counter or subsequent
   active time on the overridden page. `normalizeUsageCategory` now collapses
   all three rule-label prefixes to the shared generic **blocked by rule**
   category at every target/bucket boundary. The override message, feedback,
   popup wording, and authorization flow remain unchanged. A pure regression
   covers direct counters, checkpoints, storage/export text, and all three label
   forms; the mocked browser case covers later active time after an override.
   A follow-up read-only audit confirmed both original leak paths are closed and
   found no remaining concrete rule-text path into durable state or export.

Alternative rejected approaches included reading browser history (violates the
source/privacy requirements), capping a stale interval forward (manufactures
active time), and storing aggregates separately from checkpoints (creates an
atomicity/double-counting risk). The conservative tradeoff is undercounting
uncertain time.

## Verification actually run

All checks below ran in this worktree. Final focused tests and both builds were
rerun after the review fixes.

- `node scripts/usage-stats-test.mjs` — **21 passed, 0 failed**. Coverage
  includes URL/hostname privacy, local-midnight and DST splitting, stale/idle/
  unfocused transitions, backwards clocks, queued timestamps, restart overlap,
  duplicate decisions, cold blocked-verdict reconstruction, same-URL reloads,
  bounded maps/IDs, override denominator behavior, export shape, clear success,
  injected clear failure/retry, mocked browser listeners, and the manifests.
- `npm run typecheck` — **passed** (`tsc --noEmit`, exit 0).
- `npm run build` — **passed** after the final source changes. This sequentially
  completed the Chrome background/offscreen/popup/options/blocked builds and
  Firefox background/popup/options/blocked builds, including asset and manifest
  copying.
- Existing pure suites all passed:
  - `node scripts/lock-math-test.mjs` — **124 passed, 0 failed**.
  - `node scripts/lock-types-test.mjs` — **21 passed, 0 failed**.
  - `node scripts/breaks-test.mjs` — **14 passed, 0 failed**.
  - `node scripts/surrender-test.mjs` — **12 passed, 0 failed**.
  - `node scripts/grace-math-test.mjs` — **21 passed, 0 failed**.
  - `node scripts/resume-test.mjs` — **24 passed, 0 failed**.
  - `node scripts/rules-test.mjs` — **54 passed, 0 failed**.
  - `node scripts/rta-test.mjs` — **17 passed, 0 failed**.
- A manifest audit compared each source manifest with `git show
  2e15e6c:manifests/<browser>.json`: **`idle` was the sole added permission**,
  every non-permission field was unchanged, the permission occurred once, and
  each generated `dist/<browser>/manifest.json` exactly matched its source.
- A source audit of the three new collector files found **no `chrome.history` or
  `browser.history` reference**. Direct reducer/tracker export and clear
  behavior is exercised by the tests above. Manual UI review confirmed export
  requests a fresh snapshot, clear requires the armed second click, and the
  empty-denominator dash and privacy copy are present.
- `git diff --check` — **clean**, including the final documentation and
  pre-cleanup handoff gate.

## Integrated `main` verification

After integration alongside the Batch 3 wildcard work, with the unrelated
YouTube-search changes preserved, the parent session observed:

- `node scripts/usage-stats-test.mjs` — **22 passed, 0 failed** after the
  integrated privacy fix. The initial five-file transcription matched the
  reviewed worktree byte-for-byte; the shared normalizer and test then changed
  intentionally to close finding 4 above.
- `node scripts/wildcards-test.mjs` — **22 passed, 0 failed**.
- `npm run typecheck` — **passed**.
- The same existing pure suites passed in the combined tree: lock-math **124**,
  lock-types **21**, breaks **14**, surrender **12**, grace **21**, resume
  **24**, rules **54**, and RTA **17**.
- `cargo test` — **161 passed across six suites**; Clippy with warnings denied
  and `cargo fmt --check` also passed. No Rust source changed.
- `npm run build` — **passed for both Chrome and Firefox**; both generated
  manifests exactly matched their sources.
- `npm run eval` after the integrated privacy fix — **PASS: no regressions**
  across **15,874 cases**, with **no per-case changes** from the baseline. Both
  `scripts/eval-dataset.json` and `scripts/eval-baseline.json` remained
  byte-identical to `HEAD`.
- `node scripts/e2e-test.mjs` — the final two consecutive unchanged reruns ended
  with **`E2E: ALL PASSED`**, including the preserved YouTube-search coverage
  with `pageVisible: true`. This followed one post-fix Playwright attempt, run
  concurrently with the eval, that failed only the YouTube page-visibility
  assertion with `{ gameMasked: true, reactVisible: true, pageVisible: false }`.
  The individual gaming/programming verdicts in that attempt were correct. No
  source changed before the two passing reruns, so a browser timing mechanism
  remains a hypothesis rather than a proven or fixed root cause; no blocker or
  unrelated search behavior was altered to suppress it.
- Before the approved commit, an isolated `git checkout-index` snapshot of the
  exact 23-path staged tree again passed both focused suites (**22 + 22**),
  typecheck, and both Chrome/Firefox builds. The index contained only the
  sanitizer's **+46/-3** wildcard hunk; the unrelated **+81/-0** YouTube-search
  hunks remained outside the commit.

### Runtime limits still not observed

The isolated worktree did not run a real browser or classifier eval. The parent
later ran the integrated Chromium Playwright suite and final eval, but that
general browser suite does not directly exercise real system idle/focus timing,
private-window runtime behavior, the visual Usage dashboard, native downloads,
or long-lived service-worker restarts. Those specific behaviors are therefore
not claimed as browser-runtime-verified; the focused browser-event suite uses
mocked APIs.

Approximation remains intentional: the initial restart checkpoint and stale or
idle-uncertain gaps add no time, and a worker dying before its 15-second batched
write can lose recent unsaved activity. If focus/idle event APIs are absent,
active time remains zero even though counters continue.

## Integration notes

The main merge surfaces are [`src/background/index.ts`](../../src/background/index.ts)
(startup, OVERRIDE, and RPC wiring), [`src/shared/messages.ts`](../../src/shared/messages.ts),
[`src/options/OptionsApp.tsx`](../../src/options/OptionsApp.tsx), both manifests,
and the shared options documentation. Integrators should preserve the single
`usageStats:v1` value, the `usage-stats-heartbeat` alarm name, synchronous
listener registration, the authenticated-only override counter, and the exact
DOM IDs recorded in [`docs/design-notes.md`](../design-notes.md).
