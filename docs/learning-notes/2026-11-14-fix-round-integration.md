# Fix-round integration: swarm audit → 19 patches, one battery

## 1. The problem this round solved

The 2026-11-14 audit swarm produced 25 evidence-backed findings; the owner
approved 19 fixes. Eight builder agents with disjoint file ownership patched
them in parallel, and integration ran the full gate battery (typecheck ·
build · 18 unit suites · 15,874-case eval · 16 Playwright e2e suites ·
cargo/clippy/fmt · python security PoCs). This note covers the integration
level: the traps the gates themselves fell into, and one finding-group that
outlived three separate surface fixes.

## 2. Three traps, all test-infrastructure, all the same lesson

Each failure the battery reported at first was real-looking, red, and wrong:

1. **Ambient defaults enslave tests.** Flipping `DEFAULTS.enabled` from
   `true` to `false` (onboarding-gated blocking) broke three test fixtures
   — `usage-stats-test`'s background-listener case (protection segment
   silently derived from the default), five e2e suites' fresh-profile
   seeds, and `e2e-companion-test`'s fresh-daemon scenario (the *premise* of
   which is "extension intends blocking on", previously delivered for free
   by the default). The compute is identical in all three: a fixture that
   never seeds the field it cares about inherits whatever the default says
   today, and silently changes meaning the day the default changes. Fix in
   every case: seed the premise explicitly (one line), never revert the
   product decision.

2. **`waitForFunction(fn, { timeout })` is a two-arg call.** Playwright's
   signature is `(pageFunction, arg, options)`; passing the options object
   second makes it the *arg* and silently leaves the timeout at the 30s
   default. Nineteen sites across six e2e suites — including a nominal
   120-second scan wait and every "first run downloads the model" wait. The
   shipped code was fine; the first ~30s one-time rebuild after the
   centroid-cache format bump (`:mp1`→`:mp2`, real-Chromium measured
   **29.9s**, not the ~2.5s Node figure) just outlasted every lying timeout.
   This is very likely the origin of the long-standing "first run can time
   out; re-run once" flake note in CLAUDE.md. Fix: move options to third
   position (`fn, undefined, { timeout }`) — verified via a paren-balanced
   rewrite, since regexes can't see call boundaries.

3. **Pipes swallow verdicts.** `node suite.mjs | tail -12; echo $?` reports
   **tail's** exit code. An entire 12-suite chain reported `EXIT=0` for a
   suite whose own log ended in `FAILED`. Any orchestration loop must
   redirect to a log file and capture `$?` directly. The `[sw]` console
   relay in each suite's log is what actually caught the kdf red: the same
   log showed `built 18 centroids (...) in 29916ms` — the timeout was
   finishing the sentence the exit code lied about.

The broader lesson: when a gate fails, verify **what the gate actually
measured** before blaming the code change it guarded. All four initially-red
suites (e2e-test, p2-kdf, p1-privacy, p1-overrides-sanitizer) ended green
with zero product-code changes; only the companion suite needed a real (test
config) fix.

## 3. The behavioral fixes verified live this round

- **Stale-ALLOW race (finding #1)** — the new focused suite
  (`scripts/e2e-stale-allow-race.mjs`) proves the fix on a deterministic
  ~30s centroid-rebuild window: navigating to a blocklist hit while an older
  page's slow ALLOW is still in flight no longer tears down the newer block
  screen. Passed on first run and in the chain.
- **Onboarding-gated blocking (#9)** — `e2e-protection-verification` green
  with the verification layer *master-switch-independent* (a pre-onboarding
  `enabled:false` install still verifies `ready`), plus a two-path
  `onboarded` gate in `resume-enforcer` (`readArmedPlan` **and**
  `resumeNow`, because the alarm listener bypasses the plan read).
- **UI fixes (#7/#8/#19/#21/#10)** — `#usage`'s `sr-only` a11y table
  clipped in a wrapper (was 606px of scrollWidth at 390px —
  `position:absolute` escapes the page's `overflow-x-hidden`); the shell
  header hides on the wizard route; `GET_FOCUS_CYCLE` gained its `.catch`;
  history-ingester's `running` flag became a durable startedAt with
  boot-time healing; the kdf lockStateSync check became a denylist
  (`/salt|kdf/i`) so new legitimate fields can't re-break it — green since
  2026-11-08 turned out to be a false green on a strict allowlist underneath
  a lying 30s timeout.
- **Companion loop** — 64/64 after the seed fix, including the allowance
  mirror round-trips and daemon↔watchdog respawn.

## 4. Process notes that earned their keep

- **File-disjoint builder ownership** let eight agents patch one repo with
  zero merge conflicts; the only coordination costs were two deliberate
  handoffs (resume-enforcer gate, usage-stats fixture) routed through the
  lead rather than transgressing ownership.
- **Verify-before-accept**: the lead re-ran every claim the subagents made.
  It mattered twice — one builder reported its mandate-complete without the
  lead's crossed follow-up having been read, and one builder crashed on an
  image read (text-only harness) and had its on-disk diffs adopted by a
  fresh reviewer instead of trusting its last words.
- **Environmental flakes are proven, not assumed**: the sanitizer chain-run
  failure was closed only after three consecutive ALL-PASSED runs with
  identical source and dist.

## 5. Follow-ups deliberately left open

- The resume-enforcer still has no dedicated Node harness (its gate is
  covered by typecheck + green battery; a mocked-chrome harness would be
  new work).
- The `centroidsInFlight` dedupe path rejects forever if a rebuild promise
  rejects mid-flight — not observed live, worth a belt-and-braces reset.
- CI deliberately excludes the Playwright suites; the 6-day blind red shows
  the cost of that exclusion. A nightly lane that runs this exact chain
  would have caught everything same-day.

## Verification record

- typecheck clean; build green for both chrome and firefox targets.
- 18 pure-Node unit suites green, including the new `centroid-cache-test.mjs`
  (16/16), lock-types 26/26 with two new regression cases, lock-math 184/184
  with four new shared label fixtures, usage-stats 30/30, wildcards 25/25,
  backup 24/24.
- `npm run eval`: 15,874 cases, 98.7% e2e decision accuracy, **zero
  regressions** against the committed baseline.
- cargo test (default members) + clippy `-D warnings` + fmt all clean; the
  python companion-IPC PoC passed 9/9.
- Playwright e2e: 16 suites green end-state, with `e2e-stale-allow-race`,
  `e2e-p1-overrides-sanitizer` (15/15, three consecutive ALL-PASSED runs),
  `e2e-p2-kdf-modelpin` (first green since 2026-11-08), and
  `e2e-companion-test` (64/64) each verified by direct lead re-runs using
  log-file redirection and un-piped exit codes.