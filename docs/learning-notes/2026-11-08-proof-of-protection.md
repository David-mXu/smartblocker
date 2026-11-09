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

## Firefox runtime follow-up: real cold-model recovery and navigation

### Defect and root cause

Building Firefox was not sufficient runtime evidence. The first packed-XPI cold
recovery run on **Firefox 150.0.2** reached the genuine event page but failed to
initialize the model. The per-check error showed Transformers.js trying to import
`https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.mjs`.

Firefox's generated background page is a document, not a
`ServiceWorkerGlobalScope`. That makes Transformers.js select its CDN default for
`wasmPaths`, while the extension CSP allows extension-local code and model hosts,
not jsDelivr. Chromium did not expose this defect: its service worker uses the
bundler-inlined glue, and its offscreen document already had local overrides.

### Implementation and test decisions

- [classifier.ts](../../src/background/classifier.ts) now sets `wasmPaths` to
  packaged `.mjs` and `.wasm` URLs **only when `IS_FIREFOX` is true**. Applying the
  override globally was rejected because it would move Chrome's service worker
  onto dynamic `import()`, which that environment rejects.
- [copy-assets.mjs](../../scripts/copy-assets.mjs) emits the unhashed ORT module
  and binary into both builds. Chrome's existing service-worker/offscreen routing
  remains unchanged.
- The working XPI writer and privileged Marionette transport were extracted into
  [firefox-marionette.mjs](../../scripts/lib/firefox-marionette.mjs). The options
  handle is parked on `about:blank` before add-on disable/re-enable; otherwise
  Marionette's own content document is unloaded with the extension. This repairs
  the lifecycle harness without changing any readiness assertion.
- [e2e-firefox-onboarding.mjs](../../scripts/e2e-firefox-onboarding.mjs) rejects
  real background `fetch` before cold initialization rather than substituting a
  cached verdict or fake inference result. Warm restart coverage preserves title
  verdicts, deletes model CacheStorage, and blocks network access so the stored
  answers cannot conceal an unavailable model.

### Runtime evidence observed

The final runs used the real packed extension and this project-local Firefox
150.0.2 executable:

```sh
npm run build:firefox
TMPDIR=/tmp/opencode SB_FIREFOX="$PWD/.dev-profile-playwright-browsers/firefox-1522/firefox/firefox" \
  node scripts/e2e-firefox-onboarding.mjs
TMPDIR=/tmp/opencode SB_FIREFOX="$PWD/.dev-profile-playwright-browsers/firefox-1522/firefox/firefox" \
  node scripts/verify-firefox-dnr.mjs
```

- **E2E-FIREFOX: ALL PASSED — 35 checks.** Observed coverage included temporary
  XPI activation and the exact welcome URL; required APIs and local ORT assets;
  genuine cold-fetch failure and completion refusal; incompatible settings with
  zero additional model downloads; the real wizard's failure and unverified exit;
  recovery in the same event page; model/centroid persistence; add-on restart;
  warm-verdict outage and fresh recovery; permission denial; stale-response and
  external-change handling; commit locking; verified persistence; popup/options
  round-trips; and ordinary navigation enforcement.
- The initial successful model run exposed `smartblocker-probe` and
  `transformers-cache`, **18 centroid names with 18 seed-vector groups**, and two
  initial title verdicts. Readiness still left `onboarded` false until the real
  wizard completion recheck passed.
- Ordinary navigation used new non-readiness titles, empty block/title rules, no
  force lock, and no DNR redirect. The gaming title produced a top-frame overlay
  and a fresh `video games`/block latency sample; changing the document to the
  programming title cleared the overlay and produced a fresh `programming and
  software development`/allow sample. Both samples had `cached: false`, and the
  session DNR rule count was zero. Only loopback whitelist entries were removed
  in the disposable profile so the local fixture was not silently allowed.
- **FIREFOX DNR VERIFY: ALL PASSED.** The separate URL-keyword Frozen Turkey run
  redirected to `blocked.html?reason=dnf-redirect`, exposed one exact URL-scoped
  session rule, and drained it on unlock. This remains independent of the model.
- After the shared Firefox-only runtime change, Chromium's cold **15-check**
  protection suite and `node scripts/e2e-test.mjs` both passed again. Thus the
  Firefox repair did not regress the existing Chromium execution paths.

## Cross-version Firefox actions and regression evidence

The Firefox follow-up expanded beyond the initial 150.0.2 run with project-local
**121.0**, **153.6.0esr**, **159.0.1**, and **162.0a1** binaries. The following
results were observed directly; they are not inferred from manifest metadata.

- [e2e-firefox-onboarding.mjs](../../scripts/e2e-firefox-onboarding.mjs) ended
  **E2E-FIREFOX: ALL PASSED on all four versions**. Coverage included packed-XPI
  activation, native host permission where needed, real cold model failure and
  recovery, local ORT assets, add-on restart, permission denial, stale-response
  rejection, external policy recovery, verified wizard persistence, popup state,
  and fresh classifier-driven navigation enforcement. Fast ESR exposed a harness
  race: warm inference could finish before the delayed-response hook was
  installed. The final harness now deliberately triggers a real policy recheck
  after installing that hook. Navigation evidence requires an actually fresh
  sample for each title, rather than accidentally selecting a later same-title
  cache hit as the proof of fresh inference.
- [e2e-firefox-actions.mjs](../../scripts/e2e-firefox-actions.mjs) ended
  **E2E-FIREFOX-ACTIONS: ALL PASSED on every one of those four versions**. Each
  run used a new packed-XPI profile, unique URL blocklist keywords, and real
  `https://example.com/?q=…` documents. Firefox 121's initially denied optional
  host access was granted through trusted input in its actual Add-ons Manager.
  A trusted open-shadow-root OVERRIDE click persisted the host-scoped title
  correction and false-positive feedback; a subsequent real document reload,
  proven by a new `performance.timeOrigin` after the override timestamp,
  produced an allowed verdict with no overlay. Both the injected overlay and
  extension-owned `blocked.html` Stay-focused controls really closed their own
  tabs. Frozen Turkey installed the exact tab/URL session DNR rule, showed only
  the locked close action, and drained the rule after tab closure while the lock
  remained active. Closure required both Marionette-handle disappearance and
  removal of the marked live `gBrowser` tab; an unloaded-document transport
  error alone was never accepted.
- [e2e-firefox-compat.mjs](../../scripts/e2e-firefox-compat.mjs) ended
  **E2E-FIREFOX-COMPAT: ALL PASSED** on Firefox 150.0.2. Trusted Add-ons Manager
  input performed actual all-site revoke → grant → revoke → retry transitions;
  both denied completion attempts were refused before the final grant allowed
  verified persistence. With private access genuinely denied, a real private
  document remained outside extension enforcement. Native private Allow then
  produced the ordinary gaming overlay and fresh programming allow in a private
  window, followed by actual window closure. The evidence included fresh
  block/allow samples, no DNR session rule, no ordinary Firefox history entry,
  and Firefox-specific private-access guidance on both relevant options screens.
- The shared Marionette `load()` helper now explicitly reselects its retained
  original tab handle after parent-process navigation. Firefox can otherwise
  leave content evaluation on the previously selected target even though
  `gBrowser.selectedTab` points at options. The action suite also normalizes
  the `{value: handle}` response shape returned by newer Firefox versions.
- `npm run typecheck` passed. `node scripts/rules-test.mjs` remained **65/65**,
  and `npm run eval` completed all **15,874 cases** with **no per-case changes**
  and no regressions.
- A fresh Chrome build passed both canonical regressions: `node
  scripts/e2e-test.mjs` ended **E2E: ALL PASSED**, including OVERRIDE on a
  deterministic rule and forced blocking ignoring that correction; `node
  scripts/e2e-p2-dnr.mjs` ended **E2E-P2-DNR: ALL PASSED**, including actual DNR
  redirects, hostile-DOM removal, fail-closed retries, sender-tab closure, and
  session-rule draining.

## Firefox idle-loop defect and companion-snapshot repair

The natural-idle investigation initially altered the idle timeout and waited for
startup work, but Firefox still emitted startup activity immediately after every
genuine shutdown. Passive `backgroundState` accessors, a third clean process,
and wakeup-entry instrumentation did not establish the cause. Tracing the actual
Firefox storage backends finally provided the decisive evidence: **two
`companionSnapshot` notifications after every restart**. A known missing host
was being written as `connecting`, then as `not-installed` again. Firefox emits
`storage.onChanged` even for an identical `storage.local.set`, so these repeated
snapshot writes kept waking primed listeners and prevented a stable stopped
state.

Suppressing those writes removed the snapshot events but did not by itself end
the restarts: the remaining event stream then cleanly exposed
`Port.onDisconnect` on every new background. Creating a doomed native port on
every event-page startup was a second wake source. Startup therefore now skips
that attempt **only when the persisted verdict is already not-installed**.
Explicit daily retries still connect, a new or previously connected installation
retains normal probing/reconnect behavior, and an actual host response still
publishes connected. The module regression proves no startup port for the known
missing-host case as well as real retry and successful-connection behavior.

With storage and native-port wakes eliminated, the next run showed a different
condition: a genuine `idle.onStateChanged` fired when the disposable browser's
OS idle clock crossed the product's **30-second** usage-accounting threshold.
An attempted alternative used WebDriver pointer clicks to reserve an active
window, but the measured `nsIUserIdleService.idleTime` remained about 23.5
seconds immediately after the second click: DOM input did not reset that clock
in this headless environment. Rather than modifying OS state or removing the
usage listener, the final harness invokes the real
`browser.idle.setDetectionInterval(3600)` for this disposable profile, verifies
its active query and Firefox's persisted startup parameter, tests the unchanged
background stop/stability behavior, and restores the production **30-second**
interval before final inference. This is a usage-only test precondition, not a
blocking-rule relaxation or a claim about eviction under every OS-idle regime.
The unchanged usage-statistics suite remains **22/22 passing**.

[companion.ts](../../src/background/companion.ts) now compares the merged
snapshot with its previous value and suppresses no-op writes. A retry for a host
already known to be missing retains the persisted not-installed verdict rather
than publishing a transient connecting state and immediately reverting it. The
real `connectNative` attempt still runs on every intended retry; a genuine host
message still publishes and persists `connected`. This addresses the source of
the storage-wake loop rather than hiding resets or weakening the stable-stopped
assertion. The lifecycle harness also rejects any storage notification after
its shortened idle timer is armed.

[companion-idle-storage-test.mjs](../../scripts/companion-idle-storage-test.mjs)
verifies the focused module contract: known missing-host startup opens no port;
an explicit scheduled retry really calls `connectNative` with **zero snapshot
writes** and **zero notifications**; a subsequent genuine status message
persists connected. It passed alongside the existing
`companion-background-test.mjs` (**10/10**) and `companion-blocking-test.mjs`
(**10/10**) suites. Those module tests supplement, rather than replace, the
real Firefox lifecycle evidence below.

## Full persistent-XPI lifecycle integration result

[e2e-firefox-lifecycle.mjs](../../scripts/e2e-firefox-lifecycle.mjs) ended
**E2E-FIREFOX-LIFECYCLE: ALL PASSED** on Firefox Nightly 162.0a1. This was the
real persistent unsigned XPI in isolated disposable profiles, not a mocked
background lifecycle:

- Cold onboarding produced two fresh verdicts, settings, **18 centroids and 18
  seed-vector groups**, and pinned-revision model bytes. `Marionette:Quit`
  genuinely stopped Firefox; a different process PID then resumed the installed
  XPI with **no `Addon:Install`**. Settings, title verdicts, centroids, and model
  CacheStorage matched exactly, while `storage.session` correctly received a
  new boot marker. Fresh block/allow inference after restart made **zero
  HTTP(S) fetches** with background HTTP(S) requests fault-injected.
- Before the measured idle phase, a third real process preserved the armed
  deterministic wake fixture and all persisted assets without reinstalling.
  Only that disposable browser used an isolated `$HOME`, verified through
  Firefox's resolved native-manifest directory; the installed machine companion
  was never modified or killed.
- Firefox's actual idle scheduler reached `backgroundState: stopped` and
  `contextId: null`, then remained stopped through the required six-second
  stability window instead of merely producing transient shutdown events.
  There were **zero storage notifications** after the short background timer
  was armed, no active native ports, no pending listeners, and no DevTools
  attachment. The test did not disable/re-enable the add-on or invoke Firefox's
  parent-port disconnect callback.
- Ordinary navigation woke the suspended page in a **new background context**
  in the same Firefox process and produced the real deterministic block overlay.
  The same browser's `storage.session` marker survived that event-page restart.
  After restoring the production usage-idle interval and normal background
  timeout, the resumed event page again produced fresh block/allow verdicts
  using packaged local ORT assets and **zero HTTP(S) fetches**.

This establishes real persistence and stop/wake behavior under the explicitly
recorded idle-test preconditions. It does not imply that an open companion port
or the production 20-second Firefox keepalive allows eviction, and it does not
substitute for the AMO-signed installation/upgrade checks below.

### Revalidation after concurrent edits

Concurrent allowance/UI work subsequently changed shared blocker, lock, settings,
protocol, and options files. Those unrelated edits were left untouched. After a
fresh combined Chrome/Firefox build, the four-version real-site action matrix
again ended **ALL PASSED** on 121.0, 153.6.0esr, 159.0.1, and 162.0a1, and the
full Nightly lifecycle again ended **E2E-FIREFOX-LIFECYCLE: ALL PASSED** with the
same actual persistence, stable stop/wake, no-idle-write, persisted-asset, and
fresh-inference evidence. The final two-browser build and TypeScript/diff checks
also passed in this later tree.

The current-tree Chromium enforcement suites likewise ended **E2E: ALL PASSED**
and **E2E-P2-DNR: ALL PASSED**. One earlier run against the generated persistent
`.e2e-profile` stalled before model verification at its first
`chrome.storage.local.remove`; after it remained idle past the explicit model
timeout, only that identified test Node/browser process pair was terminated.
The profile was retained rather than deleted or described as working. The two
harnesses now accept an optional `SB_E2E_PROFILE` without changing their default
path. The subsequent run used a separate genuinely cold disposable profile,
built real centroids and model CacheStorage, then passed the complete OVERRIDE,
history, Frozen Turkey, sanitizer, subframe, DNR, fail-closed, and rule-drain
scenarios above. This establishes current clean-start behavior but does not
claim that the preserved one-off stalled test profile was repaired or explained.

## Boundaries and unresolved limits

- Automated coverage is from the named **headless** Firefox versions and real
  Chromium binary; it is broad versioned evidence, not a claim about every OS,
  desktop session, display server, or future Firefox release.
- A packed XPI survived actual Firefox process restarts on Nightly without
  `Addon:Install`, with exact settings/title-verdict/centroid/model-cache
  persistence and a new `storage.session` boot. This is deliberately unsigned
  persistent testing on Nightly. On release Firefox 150, permanent installation
  of that same unsigned artifact failed with `ERROR_SIGNEDSTATE_REQUIRED`
  (`MOZ_REQUIRE_SIGNING=true`). AMO credentials and a pre-signed artifact were
  unavailable, so signed installation and signed upgrade remain unperformed
  release checks rather than implied passes.
- Readiness is a point-in-time result. It does not guarantee that a user cannot
  later revoke access or change policy; final-step external-change invalidation,
  focus rechecks, and commit-time checks address the covered setup transitions.
- Two readiness titles cannot establish classification quality for arbitrary
  pages. The full decision eval guards aggregate behavior, while the local
  navigation fixtures plus real example.com runs cover representative
  enforcement rather than every website.
- Some failure-path suites explicitly inject permission or model-fetch faults
  at the background API boundary to exercise deterministic error handling. They
  do not substitute for the separate successful native Add-ons Manager
  denied/granted/revoked/retried and private-window evidence documented above.
- DOM, storage, trusted-input, and enforcement assertions do not replace
  visual/theme inspection, real OS sleep/resume, or manual AMO review.
- No files were committed or pushed as part of this work. Pre-existing unrelated
  modified and untracked files were preserved.
