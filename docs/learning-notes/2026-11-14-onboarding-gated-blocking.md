# Onboarding-gated blocking: why a fresh SmartBlocker install no longer blocks silently

## The problem

SmartBlocker's public contract says completing the first-run wizard is *the*
path that turns protection on. `src/background/protection-verification.ts`
even documents `completeOnboarding()` as "the sole onboarding path that
persists `enabled + onboarded`". But `DEFAULTS.enabled` in
`src/shared/settings.ts` was `true` — set in the Phase 2 foundation and never
revisited — so a brand-new install was **already blocking** before the user
touched anything. The options header showed the contradiction directly: a
green "Blocking on" pill right next to the "Finish setting up SmartBlocker"
banner. The wizard's "Start blocking" button also rang false: clicking it
didn't *start* anything, it merely kept a state that was already running.

## Root cause and concepts

Two different kinds of "on" were conflated:

- **A default** — what the software does before any user decision. Defaults
  are the loudest design statement a product makes, because almost nobody
  reads them.
- **An explicit action** — the user (or a verified flow acting for them)
  choosing the state.

The fix (audit finding #9, option b chosen by the owner): a default must
never claim authority the product says only an action can grant. So
`DEFAULTS.enabled` becomes `false`, `COMPLETE_ONBOARDING` stays the one
**automatic** path to `enabled: true` (it always persisted
`{ enabled: true, onboarded: true }` together), and a manual master-switch
toggle remains a legitimate explicit enable. Manual enables were deliberately
**not** blocked — the finding is about silent defaults, not user agency.

Why "together" matters: persisting `enabled` and `onboarded` in one
`setSettings` write means no intermediate state exists where blocking is live
but the setup banner still claims setup is unfinished.

## Investigation and implementation

1. **Read the decision ladder before guessing.** The first question was
   whether the proof-of-protection fixtures (`shared/protection-policy.ts`)
   consult the master switch — if they did, a pre-onboarding `VERIFY_PROTECTION`
   would be vacuously wrong (every "blocked" verdict vacuously correct with
   the switch off, or wrongly reported as failing). Evidence:
   `ProtectionPolicySettings` picks only
   `labels | blockedLabels | blockThreshold`, and the verdict predicate
   `shouldBlockClassifierVerdict(outcome, blockedLabels, blockThreshold)`
   takes the switch out of the signature entirely. Verdict assessment was
   already switch-independent — so the wizard still proves "the classifier
   and permission work" without requiring live blocking. Conclusion: **no
   code change in the verification path**, only a comment pinning the
   invariant so nobody "fixes" it later.

2. **Trace every reader of the default.** `grep -n enabled` across the
   verdict predicate, `classifier.ts`, `eval-harness.mjs`, and every
   `scripts/e2e-*.mjs`. Three facts came out:
   - The offline evaluator is switch-blind (its `EVAL_SETTINGS` mirror has
     no `enabled` field; the ladder is whitelist → blocklist → title rules →
     threshold), so `npm run eval` numbers cannot shift — nothing was
     changed there on purpose; score history stays comparable.
   - `classifier.ts` never reads `enabled` — classification, and therefore
     verification, works with blocking off. That is what makes "verify
     readiness before enabling" a coherent state.
   - Five Playwright suites silently relied on the old default: they
     launched cold profiles and asserted block overlays without ever arming
     the switch (`e2e-test.mjs`, `e2e-allowance-test.mjs`,
     `e2e-allowance-daemon-test.mjs`, the recovery leg of
     `e2e-p1-privacy-failclosed.mjs`). Each got an explicit `enabled: true`
     arm seed — a fixture should state its premise, not inherit it from a
     mutable default. Conversely, `e2e-protection-verification.mjs`'s
     cold-profile fixture moved to `enabled: false` to mirror the real fresh
     install, which also becomes the regression test that verification is
     still `ready` with the switch off.

3. **Hunt for other silent-enablers.** The important one:
   `resume-enforcer.ts` *arms whenever `resumeMode !== 'off'` and blocking is
   off*. Nothing there checks `onboarded`. Options pages are reachable
   behind the setup banner, so a user who configures auto-resume before
   finishing onboarding, then restarts the browser, would get blocking
   turned back on automatically with `onboarded` still false — the same
   silent-enable path through a side door. That file belongs to another
   builder, so the precise fix was reported rather than made: gate both
   `readArmedPlan()` and `resumeNow()` (`resumeNow` is reachable directly
   from the one-shot alarm listener, so gating one choke point is not
   enough).

4. **Existing installs.** Every `setSettings` write persists the full merged
   settings object, and the `enabled` field shipped in the Phase 2
   foundation — so any install that ever ran the wizard has `enabled` stored
   explicitly and keeps its state after the default flip. No migration. The
   only behavioral delta is on genuinely fresh profiles.

5. **Honest display.** A fresh install now shows the "Paused" pill next to
   the "Finish setting up" banner — that is the point. Recorded in
   `docs/design-notes.md` §5 and `CLAUDE.md` so nobody files it as a bug, and
   so the options/popup owners (separate builders) know it is intended.

## Trade-offs and boundaries

- Manual popup / `#blocking` toggles stay legal: the `setSettings` lock guard
  already exempts `enableOnly` patches, so even locked installs can re-enable.
- A **restored backup** still carries `enabled: true` (backups include global
  fields; `onboarded` was already excluded as transient). Restore is an
  explicit user action restoring their own state, so it was left as a legit
  enable — flagged to the owner in case they want restore re-gated too.
- Forced locks are unaffected: `blocker.ts` gates on
  `!settings.enabled && !lock.forceBlocking`, so Frozen Turkey / timer /
  password enforcement works regardless of the default — this kept the
  companion and fail-closed suites valid.

## Verification

- `npm run typecheck` — pass.
- `node scripts/rules-test.mjs` (covers the protection verdict/config policy)
  — 65 passed.
- `node scripts/resume-test.mjs` — 25 passed (pure derivations unaffected;
  the enforcer gap above lives in background wiring, not this module).
- `node scripts/lock-types-test.mjs` — 22 passed, 2 failed; **proven
  pre-existing** by temporarily restoring `enabled: true` and observing the
  identical 22/2 (the failures are in other builders' in-flight
  `lock-math.ts` delay/random-text clamps, unrelated to this change).
- `node scripts/breaks-test.mjs` (14), `node scripts/profiles-test.mjs` (17),
  `node scripts/backup-test.mjs` (24) — all pass; these parse/import
  `settings.ts` directly so they exercise the new default.
- Not run by me (Playwright / eval, per swarm instructions): lead must re-run
  `e2e-protection-verification`, `e2e-test`, `e2e-allowance-test`,
  `e2e-allowance-daemon-test`, `e2e-p1-privacy-failclosed`, and
  `e2e-companion-test` — the exact list with reasons is in
  `.audit-swarm/builders/builder-onboarding-report.md`.

Full ripple map: `.audit-swarm/builders/builder-onboarding-report.md`.
Key code: `src/shared/settings.ts:185`,
`src/shared/protection-policy.ts` (header),
`src/background/protection-verification.ts:104`.
