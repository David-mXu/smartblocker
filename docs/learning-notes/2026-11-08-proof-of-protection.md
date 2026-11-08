# Proof of protection: verified onboarding readiness

Date: 2026-11-08

## Problem and goal

The first-run wizard's final step used to say **“You’re all set”** and persist
`enabled: true` plus `onboarded: true` without proving that the model could run,
that the current settings would block a distraction and allow a productive page,
or that the browser still granted host access. “Setup complete” therefore meant
that settings had been enabled, not that protection had been observed working.

The goal was to make completion evidence-based without weakening a user's rules,
opening fake tabs, treating cached answers as fresh inference, or misreporting an
intentional custom configuration as a model failure. Existing uncommitted work in
unrelated files had to remain intact.

The two built-in probes are:

- **Elden Ring Boss Fight** → `video games` → **block** under compatible settings.
- **React Router Tutorial** → `programming and software development` → **allow**
  under compatible settings.

Actual `<all_urls>` permission is a third required check. Only a report containing
passes for all three can be `ready` and complete onboarding.

## Root cause and relevant concepts

### Enabled is not the same as ready

A settings write proves persistence, not enforcement. Model initialization and
inference happen later, browser permissions can change independently, and custom
labels or thresholds can make a fixed fixture inappropriate. Readiness therefore
needs evidence from the production classifier and production decision policy.

The fix deliberately does **not** claim that two fixture titles prove enforcement
for every website. They are bounded setup checks. Existing browser-navigation
tests provide the separate evidence for overlays, allows, and locked redirects.

### A cache read bypass is not a separate inference path

[`src/background/classifier.ts`](../../src/background/classifier.ts) memoizes title
verdicts to make repeat classification cheap. A readiness check based on that
cache could remain green while the real inference channel was broken.

`classify(input, bypassCache)` now skips only the cache **read** when the second
argument is true. It still executes the normal classifier and writes the fresh
result to the normal cache. This avoids a test-only model implementation while
preserving production caching behavior. A verdict marked `cached: true` cannot
pass readiness even if its label and decision look correct.

### One policy predicate prevents semantic drift

The blocker had several classifier-driven paths, and the offline evaluator had a
parallel implementation. A verifier with another copy of the block condition
could disagree with the code users actually experience.

[`shouldBlockClassifierVerdict`](../../src/shared/prototypes.ts) now owns the
classifier-only condition: the top label must be blocked and
`effectiveBlockScore(...) >= blockThreshold`. That retains the existing top-two
blocked-category mass rule. Deterministic rules and channel-allow rescues remain
in their callers because they are outside this predicate's scope. All three
blocker paths, the offline evaluator, and readiness assessment use this predicate.

### Async evidence can become stale

Inference can take long enough for a user to leave a step, change settings in a
second tab, or start another check. An older `ready` response must not overwrite a
newer failure. This is a **time-of-check/time-of-use** problem: the conditions at
the moment evidence was produced may differ from those at the moment it is used.

There are two complementary defenses:

1. The options page assigns each run a generation and invalidates pending runs on
   navigation or relevant external changes.
2. The background does not trust the preview when completion is requested. It
   reruns verification, compares policy fingerprints before and after inference,
   checks permission again, and only then attempts the settings write.

The UI generation is a display safeguard, not the authority that persists success.

## Investigation and implementation

### 1. Trace the existing enforcement and onboarding paths

The investigation followed the real `classify()` entry point, its title cache,
all classifier block decisions in `blocker.ts`, the offline decision harness, the
three-step welcome wizard, settings persistence, manifests, and existing Chromium
suites. The existing e2e style was important: it launches the built extension and
sabotages the real service-worker `EMBED`/`CLASSIFY` channel rather than adding a
product test hook.

The old final wizard branch directly saved `enabled + onboarded`. There was no
verification RPC or readiness report, and the deterministic-rule unit suite did
not cover this policy.

### 2. Share the decision and add a fresh-verification primitive

The three blocker call sites and the evaluator were moved to the shared predicate
without changing threshold or top-two-mass semantics. The classifier gained the
cache-read bypass described above. Normal callers still use the default
`classify(input)` behavior.

[`src/shared/protection-policy.ts`](../../src/shared/protection-policy.ts) is a
pure module so Node can test it without browser globals. It defines the fixtures,
checks configuration compatibility, assesses fresh verdicts, and summarizes the
required checks. Missing checks never summarize as ready.

Configuration is assessed before inference where possible. For example:

- a missing `video games` category explains which category must be restored;
- allowing `video games` explains why the distraction fixture cannot prove a
  block;
- blocking `programming and software development` explains why the productive
  fixture cannot prove an allow.

Those cases are `degraded`, not model errors. If inference runs but a correct
gaming label falls below a custom threshold, the diagnostic includes the actual
effective confidence and threshold guidance. An unexpected semantic label also
fails instead of being accepted merely because the real policy would block it.

### 3. Add read-only verification and verified completion

[`src/background/protection-verification.ts`](../../src/background/protection-verification.ts)
uses the production classifier and real `permissions.contains({ origins:
['<all_urls>'] })`. It opens no fixture tabs and modifies no rules.

`VERIFY_PROTECTION` returns structured checks and one of `ready`, `degraded`, or
`error`; it never marks onboarding complete. `COMPLETE_ONBOARDING` reruns the same
verification and returns `saved: true` only after `setSettings({ enabled: true,
onboarded: true })` succeeds. Verification failures and settings/lock failures
return `saved: false`.

The runner compares `labels`, `blockedLabels`, and `blockThreshold` before and
after inference, and repeats the permission check after inference. A policy
change during the run produces an error rather than combining evidence from two
configurations.

### 4. Make the final wizard step actionable

[`WelcomeWizard.tsx`](../../src/options/welcome/WelcomeWizard.tsx) now gates its
primary action on `ready`. Checking, degraded, and error are all non-success
states.

[`StepReady.tsx`](../../src/options/welcome/StepReady.tsx) displays the individual
site-access, distraction, and productive checks, verdict details, retry and
settings/category recovery actions, and the existing summary, incognito, and pin
information. **Continue without verification** remains available after ordinary
verification failures, but it leaves `onboarded` false and therefore keeps the
“Finish setup” path honest.

### 5. Harden the races found in review

A first read-only review identified that an older slow preview could overwrite a
newer one, and that an early settings/permission snapshot could be stale at the
settings write. Generation guards, the background completion recheck, policy
fingerprints, and repeated permission checks addressed those findings.

A second review found a separate commit-pending race: after **Start blocking** had
started the background recheck, **Continue without verification** could navigate
away while the background eventually saved success. Back navigation could also
invalidate the guarded cleanup and leave saving disabled. A distinct `completing`
state now disables Back, Change links, and the unverified exit during this commit,
and cleanup always clears that pending state.

Relevant storage changes invalidate the preview and coalesce into a fresh run.
Focus/visibility restoration rechecks browser-level state. The installed permission
event typings did not provide the required removable listeners, so focus/
visibility rechecks are used instead of keeping those listeners; background commit
still performs its own direct permission check.

Finally, `docs/design-notes.md` now specifies the verified final step and its DOM
contract, and [`CLAUDE.md`](../../CLAUDE.md) documents the modules, commands, and
boundary between readiness and actual navigation enforcement.

## Alternatives and tradeoffs

- **Open real fixture tabs:** rejected for readiness because it adds visible test
  navigation and conflates model/policy verification with navigation enforcement.
  Navigation remains covered by the existing browser suite.
- **Duplicate the threshold logic in the verifier:** rejected because green
  verification must use the same classifier policy as enforcement.
- **Trust a cached verdict:** rejected because a warm cache can conceal an
  inference outage. The tradeoff is that every readiness run performs two real
  inferences.
- **Change custom settings just to make fixtures pass:** rejected. Incompatible
  configurations now explain what cannot be proved instead of silently rewriting
  the user's intent.
- **Require verification to leave the wizard:** rejected to preserve an exit.
  Unverified continuation is explicit and does not set `onboarded`.
- **Trust only the UI's latest `ready`:** rejected because other contexts can
  change settings while the preview is displayed. The background recheck costs
  another pair of inferences at commit time but protects the actual write.

## Verification actually run

All results below were observed in this project tree; they are not assumed test
coverage.

- `node scripts/rules-test.mjs` — **65 passed, 0 failed**. The additions cover
  the exact threshold boundary, blocked top-two mass, unblocked/neutral runner-up
  behavior, fresh block/allow evidence, cached-verdict rejection, missing or
  incompatible categories, custom-threshold guidance, unexpected labels, and
  missing required checks.
- `npm run typecheck` — **passed** after the final logic changes.
- `npm run build:chrome && node scripts/e2e-protection-verification.mjs` — **all
  15 checks passed** in a newly recreated cold Chromium profile. The observed
  checks were: service-worker boot; cold gaming/block + programming/allow + real
  host access; both verdicts fresh; read-only verification leaving `onboarded`
  false; warm-cache inference sabotage failing; background completion refusing a
  model outage; failed verification disabling **Start blocking**; unverified exit
  leaving `onboarded` false; repaired inference returning fresh `ready`; mocked
  permission denial preventing completion; incompatible custom settings yielding
  configuration diagnostics with zero model calls despite sabotage; a delayed
  stale `ready` being ignored; external settings recovery automatically restoring
  `ready`; commit-pending navigation locks; and the real wizard persisting
  `enabled + onboarded` only after background completion passed.
- `node scripts/e2e-test.mjs` — **passed**, including the existing real browser
  navigation checks for gaming overlays, productive-page allows, locked
  redirects, and sanitizer behavior. This is the separate enforcement proof; the
  readiness RPC did not open those fixture pages.
- `npm run eval` — **passed across all 15,874 cases**, with **no per-case changes
  and no regressions** after the shared-predicate refactor.
- `npm run build` — final Chrome and Firefox builds **passed**, including asset
  and manifest generation.
- `git diff --check` — **passed with no whitespace errors** after the code and
  documentation edits.

## Boundaries and unresolved limits

- Firefox was built and typechecked, but this increment did **not** execute the
  Firefox onboarding runtime. The cold-browser readiness suite ran in Chromium.
- Readiness is a point-in-time result. It does not guarantee that a user cannot
  later revoke access or change policy; final-step external-change invalidation,
  focus rechecks, and commit-time checks address the covered setup transitions.
- Two titles cannot establish classification quality for arbitrary pages. The
  full decision eval guards shipped aggregate behavior, while actual navigation
  tests cover representative enforcement rather than every website.
- Permission denial in the failure-path suite is injected at
  `chrome.permissions.contains`; the successful cold-profile run checks the real
  browser grant. No claim is made that the suite physically toggled a browser
  permission UI.
- The new panel was exercised through DOM state, disabled controls, and completion
  behavior in Chromium. This task did not add a separate visual screenshot audit.
- No files were committed or pushed as part of this work. Pre-existing unrelated
  modified and untracked files were preserved.
