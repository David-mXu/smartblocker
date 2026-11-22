# Audit-swarm hardening round (2026-11-21)

## Context

A seven-agent read-only swarm (classifier/blocker core, security/privacy, shared
pure modules, UI/a11y, Rust companion, tests/docs truth, market research) audited
the whole product in an isolated worktree. Every finding below was reproduced or
source-verified before it was patched; each fix carries a regression test or an
e2e assertion where one is practical.

## What changed

### Extension runtime (correctness)

- **Force-mode DNR fragments** (`force-redirect.ts`): `urlFilter` kept `#frag`,
  which never reaches the network — the rule could not match, the overlay was
  suppressed, and reloads looped. Fragments are stripped at canonicalization
  (same function used for the `(tabId,url)` index, so dedupe is consistent), and
  a per-`(tab,url)` reload cooldown is the loop backstop while
  `already-enforced` still reloads (a reconciled leftover must still redirect).
- **Sanitizer teardown on disable** (`sanitize-page.ts`, `blocker.ts`): turning
  protection off now injects an `enabled:false` teardown that unmasks everything,
  restores unloaded iframe sources, disconnects the MutationObserver, and makes
  in-flight subitem verdicts no-ops. Previously a stale observer kept masking
  lazy-loaded cards on already-open pages.
- **Policy sweeps invalidate in-flight work**: `sweepOpenTabs()` bumps per-tab
  title sequences and per-frame generations before re-deciding; settings and
  profile changes advance the sanitizer policy epoch. A cold classify (~30s)
  can no longer paint a verdict from the old policy.
- **Same-URL title race**: a per-tab title sequence makes the newest evaluation
  the only one allowed to paint/clear; older verdicts still classify and log,
  but their side effects are dropped.
- **Non-classifiable navigations** (chrome://, about:, blocked.html) now bump the
  document generation and clear armed state, so a late verdict cannot act on the
  new document.
- **Profile activation** re-sweeps open tabs (new `PROFILES_STORAGE_KEY`
  listener, coalesced with the settings sweep).
- **Centroid cache provenance**: cached seed vectors record `modelId` and
  `modelRevision`; a revision bump can no longer reuse vectors from different
  weights (legacy caches are grandfathered once and upgraded in place). The title
  cache key now includes the revision too.
- **Title-cache writes** are debounced/coalesced and catch rejections instead of
  writing the whole map per SERP miss.

### Security / DoS

- **Block-screen tamper guard** (`blockscreen.ts`, both variants): the mount
  observer now watches the host's own `style`/`class`/`hidden`/`inert`/
  `aria-hidden` attributes and the shadow tree, re-asserting the authoritative
  `cssText` and restoring the card after `shadowRoot.replaceChildren()`. This
  closes the verified inline-style hide bypass (which defeated every non-force
  lock). Dialog semantics (`role=dialog`, `aria-modal`, labelled), focus move to
  the stay button, Tab containment, and focus restoration were added at the same
  time. Residual: routing every `settingsLocked` state through DNR would be the
  architectural fix; that changes the block UX and is left as a follow-up.
- **Sanitizer authority moved into the isolated world**: "already handled",
  "masked", and item-id→element now live in window-global WeakSets/Map, never in
  page-writable `data-smartblocker-*` attributes. A page that stamps
  `data-smartblocker-state="x"` no longer bypasses embed classification, and
  cloning an id onto a decoy no longer diverts a verdict. Accessors read the
  window property so the one surviving observer sees re-pointed generations.
- **`cleanTitle` bounded + linear**: the suffix regexes were quadratic in a
  long whitespace run (1.4–15s for a page-supplied title). Raw titles are capped
  at 512 code units before any regex, output at 300, on code-point boundaries.
- **Title rules use an ordered-literal matcher** instead of
  `escape().join('[\\s\\S]*')` — a guard-passing rule no longer backtracks
  catastrophically (measured 57s before). The authoring guard normalizes
  (NFKC/Cf) before counting gaps, so fullwidth `＊` cannot smuggle wildcards.
- **Channel rules normalize** Cf/NFKC variants (`Mr​Beast`, `ＭｒＢｅａｓｔ`).
- **Subitem classification budget**: 240/tab and 1,200/minute globally; over
  budget items are reported unclassified (no oracle) instead of pumping the
  shared offscreen model.
- **Unhandled rejections** fixed in companion snapshot writes, CLOSE_TAB, and the
  title cache.

### Evaluator integrity

- `isYouTubeBrowsingSurface` moved to `shared/url-signals.ts`; `decideBlock` now
  mirrors the runtime exemption, and `expectedDecision`/must-block scoring treat
  those pages as policy-allowed (36 committed must-block cases were structurally
  allowed by the product — the old numbers were inflated).
- The blocklist in the harness is matched against the same cleaned title the
  blocker uses.
- **NEW/GONE are now gate failures**: added failing cases and deleted hard cases
  can no longer report "PASS: no regressions"; additions that fully pass are
  allowed. `--update-baseline` is the explicit acceptance path.

### Data integrity

- Backup schedule labels use `sanitizeScheduleLabel` (code-point truncation); a
  lone surrogate could previously drop the companion connection for good.
- A backup apply re-reads the lock at commit time and writes the pre-restore
  slot only after the final lock check, so a lock armed mid-restore survives and
  a refused restore keeps the previous recovery point.
- Future `appBlocklistUpdatedAt` stamps are clamped on import/merge/read; a
  poisoned stamp can no longer freeze cross-device app-list sync.
- A profile-cap merge keeps the current active profile instead of silently
  switching to Default.
- `sanitizeLockState` dedupes rule ids/days and caps stored rules; validation
  enforces non-empty bounded ids and unique days. Scoped-duplicate neutrality is
  unchanged (cross-language fixture).
- Settings/profile caches use invalidation epochs (no cache resurrection).
- Notification schedule reminders attribute categories by window coverage at the
  start instant; the old fallback labelled every category.
- Companion: unauthenticated IPC cannot rewrite `categorySchedules`; app-list
  stamps are clamped; `pairing_tokens`/`extra_incompatible_browsers` are bounded
  in `sanitize()`; an active delay deadline shifts with clock compensation.
- Companion lock state is mirrored to `lock-state.backup.json`; a deleted or
  truncated primary loads the mirror instead of failing open.

### UI / a11y

- Nine unlabeled controls got names; the overlay is a real dialog.
- Diagnostics catch rejected RPCs instead of hanging on "Classifying…".
- Channel-rule copy matches the design contract; the header says "Checking…"
  until settings load; lock countdowns use `aria-live=off`; Partner setup puts
  the field before its action and gates actions on a paired companion; numeric
  fields ignore NaN; Focus/Pomodoro disables while locked; `--faint` now meets
  AA (4.7–5.1:1); the site honors `prefers-reduced-motion`.

### Infra / docs

- Nightly now runs every pure harness discovered on disk plus
  `verify-dataset.mjs` and `npm run eval` (previously never run in CI), and the
  five newer e2e suites are in the chain.
- `e2e-test` and the p1 suite clear a dead profile SingletonLock and, on a
  failed launch, drop the broken service-worker *Database* (keeping
  CacheStorage = the model). The blocked-screen e2e gained an inline-style/
  shadow-tree tamper case; the p1 suite gained a state-forgery case.
- PRIVACY.md/CLAUDE.md now state the feedback worker **is** deployed (endpoint
  live, real D1 id) while sharing stays opt-in/off by default.
- `engines.node >= 22.15` (registerHooks harnesses).

## Post-fix review pass

A follow-up reviewer read the committed diff and found four real defects in the
hardening itself, all fixed and covered:

- `arm()` cleared timers before recognising the extension's own `blocked.html`,
  which bumped the SERP generation and could make the evaluator release the
  redirect rule it had just committed. The recognition is now the first
  statement of `arm()`, and it matches `moz-extension:` as well as
  `chrome-extension:` (Firefox would otherwise never recover a fail-closed
  redirect).
- Membership-only mask/handled authority let a page permanently un-mask by
  deleting our `data-smartblocker-*` attribute. Authority now requires
  membership AND the render hint, and an enumerable isolated-world registry
  re-asserts any mask whose attribute was stripped (pruned by connectivity on
  each scan). Forged hints alone still fail. The p1 suite asserts the strip
  case.
- Over-budget subitems were reported as `deferred` but the page marked them
  "allowed", making the skip permanent. `deferred` now clears the item markers
  so a later scan retries it.
- `tabs.onRemoved` now also drops the title sequence and the per-tab reload
  cooldown keys.

## Verification record

- typecheck clean; Chrome build green; Firefox build green.
- pure battery: every `scripts/*-test.mjs` (except browser suites) + dataset
  verifier green, including new titles/state/backup/lock-math/notification/
  force-redirect cases.
- eval: **PASS, no regressions** after accepting the intentional
  YouTube-exemption corrections in the baseline (see the commit).
- Playwright on the final build: e2e-test (ALL PASSED), e2e-p1-overrides-sanitizer,
  e2e-serp-stability, e2e-security-blockscreen, e2e-stale-allow-race, e2e-p2-dnr,
  e2e-schedule-prefs, e2e-dashboard-test, e2e-profiles, e2e-backup and
  e2e-notifications (the last five re-run because the UI/backup pages changed).
  Two intermediate failures were environmental and are now guarded in the
  harnesses: a zombie Chromium from a killed run held the profile
  (`SingletonLock`), and a killed Chromium left a broken service-worker
  registration (the launch helpers now clear a dead lock and, on a failed boot,
  drop `Default/Service Worker/Database` while keeping CacheStorage).
- companion: 317 core + 4 fixture + 2 nm-host tests, clippy `-D warnings`, fmt.

## Deliberately open

- Route all `settingsLocked` block paths through the DNR blocked page (removes
  the CSS-tamper class entirely rather than re-asserting).
- Corrupt `allowance-state.json`/`partner-state.json` still stops the daemon
  (deliberate fail-closed: minting a fresh grant or trust root would be worse).
- Ordered lock stamps remain wall-clock based; only the partner arm already
  enforces strictly-upward stamps.
- Precomputed seed centroids (kills the one-time ~30s cold rebuild) and
  in-feed Shorts/Reels masking are product work, tracked in ROADMAP.
