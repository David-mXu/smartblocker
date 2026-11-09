# Quiet, Opt-In Reminders: Schedule, Break, and Allowance

**Date:** 2026-11-09  
**Project:** SmartBlocker  
**Status:** Implemented and verified on `parity/notifications`

## 1. Problem and goal

SmartBlocker could enforce focus hours, breaks, and allowance limits, but it gave
no warning before a boundary arrived. A user could be mid-task when focus hours
began, or lose track of time and be surprised when a break or allowance ended.

The goal was a small notification subsystem with three independent, silent,
opt-in reminders:

- **Focus hours starting soon** — before a weekly or category schedule begins.
- **Break ending soon** — before an active or pending break re-blocks pages.
- **Allowance nearly used up** — when a running allowance grant has N minutes
  left.

Hard constraints shaped the design:

- All groups default **OFF**, because an existing install must not suddenly
  start toasting.
- Preferences are **global** (one browser profile), versioned, and sanitized.
- The MV3 service worker can be asleep for hours, so correctness must come from
  persisted state, not from a page staying open.
- A reminder is best-effort: if the OS or browser refuses it, blocking, locks,
  and allowance accounting must be unaffected.

## 2. Concepts: why MV3 changes the design

Three browser-extension ideas matter here.

**Service-worker lifetime.** In Manifest V3 the background script is not a
permanent process. Chrome can stop it when idle and start it again for an event.
Any in-memory timer or `setTimeout` dies with it. Durable scheduling must use
`chrome.alarms`, and every wake must rebuild its plan from storage.

**One-shot versus periodic alarms.** A periodic "check every minute" alarm is
simple but either wakes the worker constantly or misses an exact lead instant.
A one-shot alarm can be placed at the precise `event − lead` millisecond. It is
also easy to replace: creating an alarm with the same name overwrites the old
one, so a state change can move or remove the next wake immediately.

**Idempotency.** Alarms are promptness, not truth. An alarm can be late, can
fire after the service worker restarted, or can race a storage change. The safe
pattern is to re-derive the reminder from current state on every wake and keep a
durable record of what was already delivered.

## 3. Implementation

### 3.1 Pure derivation first

[`src/shared/notifications.ts`](../../src/shared/notifications.ts) owns all
policy and has no browser APIs:

- `normalizeNotificationPrefs` accepts only a known version and real booleans.
  Unknown versions reset to defaults; minute values are rounded and clamped to
  1–60.
- `normalizeNotificationLedger` / `rememberNotification` maintain a bounded
  `dedupeKey → firedAt` map (64 newest keys).
- `planNotifications` takes `{ prefs, lockState, allowanceState, firedKeys,
  now }` and returns candidates plus at most one alarm per kind.

Keeping this file pure made the edge cases testable under Node type stripping,
the same pattern already used by `lock-math.ts` and `resume.ts`. It imports
runtime helpers with explicit `.ts` extensions so Node can load it directly.

The planner derives each kind from current state:

- **Schedule** uses `nextScheduleStart` from `resume.ts`, over global
  `schedules` plus `categorySchedules`. It skips starts already inside the
  lead window, and groups rules that resolve to the same start into one
  reminder. Overlapping global/category rules therefore produce one toast, not
  one per rule.
- **Break** accepts both active and pending breaks. The fire time is
  `max(breakStart, breakEnd − lead)`, so a lead longer than a short break waits
  until the break actually starts.
- **Allowance** reads the normalized authority state and considers only a
  live `allowance` grant at the configured threshold. `openings` and Pomodoro
  relief are different contracts and stay silent. A pending grant waits until
  `notBeforeMs`.

Dedupe keys encode the event, not the toast:

- `schedule-start:<startMs>`
- `break-end:<startMs>:<endMs>`
- `allowance-low:<category>:<grantId>:<endsAtMs>`

The schedule key deliberately omits lead minutes: changing the lead after a
start was already announced must not re-announce the same start.

### 3.2 Durable, quiet runtime

[`src/background/notifications.ts`](../../src/background/notifications.ts) is
the only browser-facing layer. `initNotificationScheduler()` is called from
[`src/background/index.ts`](../../src/background/index.ts) and registers
listeners synchronously, as MV3 requires.

Its reconcile loop:

1. Clears any `sb-notify:*` alarm that is not in the fixed allowlist.
2. Reads settings, lock state, allowance authority, and the ledger.
3. Re-plans from the current clock.
4. Fires due candidates through `chrome.notifications.create` with
   `silent: true`, or arms the next one-shot alarm.
5. Repeats only when something fired, because firing a schedule start exposes
   the *following* start as the next candidate.

Reconcile is triggered by `storage.onChanged` for `settings`, `lockState`, and
`allowanceAuthority`, by the alarms themselves, by `runtime.onStartup`, and once
at service-worker start. That covers toggles, schedule edits, break changes,
allowance grants, browser restarts, and SW reaps.

Duplicate suppression has two layers:

- Fixed OS notification IDs (`smartblocker-notify-schedule-start`, etc.)
  replace a still-visible toast instead of stacking another one.
- The `notificationState` ledger survives restarts. `fire()` checks the key
  before calling the notification API and writes the key only after a
  successful call. A failed API call is retried on a later wake rather than
  pretending delivery happened.

[`src/shared/settings.ts`](../../src/shared/settings.ts) adds
`notificationPrefs` to `DEFAULTS` and normalizes it on both read and write.
Existing installs need no migration: a missing field normalizes to all-OFF
defaults.

### 3.3 UI

[`src/options/pages/NotificationsPage.tsx`](../../src/options/pages/NotificationsPage.tsx)
renders one `SettingsGroup` with three rows. Each row has a switch and a minute
input; inputs are disabled until their group is on, and every control is
disabled while a lock is active (the same rule as other locked settings).

The page is wired as `#notifications` with a Bell entry in
[`src/options/OptionsApp.tsx`](../../src/options/OptionsApp.tsx). It reuses the
existing `Page`, `SettingsSection`, `SettingRow`, `Switch`, and `Input`
primitives rather than introducing new UI patterns.

### 3.4 Tests

[`scripts/notifications-test.mjs`](../../scripts/notifications-test.mjs) has 33
pure checks. They cover defaults/versioning, clamping, allowlists, lead windows,
inside-the-window behavior, overnight windows, category labels, overlapping
rules, spring-forward and fall-back days, active/pending/ended breaks,
allowance threshold/ended/pending/non-allowance cases, fired-key advancement,
ledger bounds, and all-disabled plans.

[`scripts/e2e-notifications.mjs`](../../scripts/e2e-notifications.mjs) drives a
real Chromium extension context. It checks the options page, default OFF state,
saved prefs, lock disabling, a real alarm at `start − lead`, stale-prefix
cleanup, one fire with the following start re-armed, duplicate suppression, and
alarm removal when everything is disabled. It stubs
`chrome.notifications.create` inside the service worker so the suite does not
depend on an OS toast daemon.

## 4. Decisions, alternatives, and tradeoffs

- **Global preferences, not per-category or per-profile.** The product has one
  browser profile and three reminder kinds. Per-category toggles would multiply
  settings without evidence users need them. The allowance toast names its
  category in the message.
- **One-shot alarms, not a periodic tick.** A tick either wakes too often or
  misses exact leads. The one-shot alarm is also the cleanup mechanism: when a
  schedule is deleted or a toggle turns off, the next reconcile clears that
  kind's alarm.
- **State-derived firing, not alarm-carried payloads.** The alarm name carries
  only the kind. If the alarm fires late, the planner still asks "is this
  event still current?" rather than announcing something already over.
- **Running allowance, not remaining daily pool.** "Allowance nearly used up"
  means a live grant is about to end. The daily pool can be low without any
  grant running, and warning then would be a different feature.
- **Fixed notification IDs.** Reusing IDs replaces a visible toast and keeps the
  allowlist small. The tradeoff is that a newer reminder of the same kind
  replaces an older one; that is desirable for quiet reminders.
- **DST follows the existing lock clock.** `nextScheduleStart` computes an
  unpinned local window as local midnight plus elapsed start minutes. On a
  transition day that can drift one civil hour. The tests encode that documented
  semantics instead of inventing a second clock; pinned rules keep their own
  timezone behavior from `lock-math`.
- **Silent always.** The requirement was no sound. There is no sound toggle to
  misconfigure.

## 5. What went wrong during verification

The first e2e run failed with
`ReferenceError: MINUTE is not defined` inside `worker.evaluate`. The callback
was serialized and executed in the service worker, where the Node-side
`MINUTE` constant does not exist. Inlining `60_000` fixed it. This is a useful
reminder that `page.evaluate`/`worker.evaluate` run in the browser realm, not in
the script's module scope.

A second e2e attempt timed out waiting for stale-alarm cleanup after writing an
identical `settings` object. The reconcile was not reliably triggered by that
no-op write. The test now bumps `lockState.schedulesUpdatedAt`, a real state
change that the scheduler already listens for, and the duplicate-suppression
check also creates a late schedule alarm so it proves the dedupe path instead of
passing vacuously.

## 6. Verification

Run from the worktree:

```bash
node scripts/notifications-test.mjs       # 33 passed, 0 failed
node scripts/resume-test.mjs              # 24 passed, 0 failed
node scripts/breaks-test.mjs              # 14 passed, 0 failed
node scripts/lock-math-test.mjs           # 155 passed, 0 failed
node scripts/allowance-math-test.mjs      # 28 passed, 0 failed
node scripts/allowance-state-test.mjs     # 12 passed, 0 failed
npm run typecheck                         # clean
npm run build:chrome                      # succeeded
node scripts/e2e-notifications.mjs        # 17 checks passed
```

Observed e2e results include the real alarm landing within 2 seconds of
`start − 7 minutes`, one schedule toast followed by an alarm for the following
start, no duplicate toast after a late alarm and a state reconcile, and no
`sb-notify:*` alarms remaining once all three groups were disabled.

## 7. Remaining caveats

- The e2e stubs the OS notification call; it verifies scheduling, payload, and
  dedupe, not the operating system's visual toast.
- If the browser or OS blocks notifications, delivery is skipped silently. The
  ledger records only accepted calls, so a later reconcile may retry.
- The tests use the host's local timezone and explicitly assert the existing
  lock-math DST semantics. A future change to that clock model must update both
  the derivation and the notification tests.
- This branch does not push or modify the companion; the notification
  preferences are extension-local and need no protocol change.
