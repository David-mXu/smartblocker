# Protection-health self-check on the dashboard

## Why

The complaint corpus's strongest pattern is **"false-active protection"**: the
product looks on while site access was revoked, onboarding never finished, the
model files are missing, or the desktop companion quietly disconnected. Until
now only the onboarding preview verified readiness; after install, drift was
invisible.

## What changed

- Pure `src/shared/protection-health.ts` derives one honest state from:
  `<all_urls>` permission, onboarding, master switch, active lock/forced
  blocking, cached-model presence, and companion connection state.
  Precedence: revoked access → unfinished setup → missing model (while
  protection should be active) → companion disconnected → paused → locked →
  on. A timer lock with blocking switched off reports **paused**, not
  "locked"; `connecting` is treated as transient, not drift.
- `#dashboard` renders it as `#protection-health` (title/detail + a fix link to
  `#welcome`, `#advanced`, `#blocking`, or `#companion`) inside the Now section.
  The probes re-run when the master switch, onboarding, lock state, or model
  download progress changes.
- "Model files present" is deliberately a **proxy** — a non-empty
  `transformers*` CacheStorage — because it proves the one-time download
  happened without paying for an inference on every dashboard view. Unknown
  (no Cache API, e.g. some Firefox contexts) is never reported as missing.

## Verification

- `scripts/protection-health-test.mjs`: every transition and precedence rule,
  tone mapping, and a source tripwire for the dashboard ids.
- `e2e-dashboard-test`: seeds a cache entry, asserts a live health row, then
  writes an unlocked enabled state → "Protection is on", and disables the
  master switch → "Blocking is off", all without a reload.

## Deliberately not done

- No background alarm/persisted health record: the dashboard derives from live
  state, so it cannot go stale or disagree with the rest of the UI.
- The popup does not duplicate the row yet; its "This page" card already reports
  per-tab decisions and the header reports paused/locked.
- Health never auto-fixes anything (no auto-enable, no permission re-prompt);
  it only names the problem and the surface that repairs it.
