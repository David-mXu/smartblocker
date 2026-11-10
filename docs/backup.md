# Configuration backup and restore

SmartBlocker can export its **configuration** to a versioned JSON file and
restore it later or on another install. This is a policy backup, not a full
extension snapshot: runtime state and secrets stay on the original device.

- Pure core: `src/shared/backup.ts` — schema, serialization, validation,
  sanitization, merge/replace, preview.
- Browser orchestration: `src/shared/backup-store.ts` — storage reads/writes,
  lock refusal, pre-restore slot.
- UI: `src/options/pages/BackupPage.tsx`, route `#backup`.

## File format

```json
{
  "schema": "smartblocker.config",
  "version": 1,
  "exportedAt": "2026-11-10T18:00:00.000Z",
  "app": { "name": "SmartBlocker", "version": "0.5.0" },
  "default": {
    "settings": { "...": "Default policy + managed globals" },
    "appBlocklist": ["steam"],
    "appBlocklistUpdatedAt": 0
  },
  "profiles": [
    {
      "id": "p_…",
      "name": "Work",
      "createdAt": 0,
      "updatedAt": 0,
      "policy": { "...": "scoped policy fields" },
      "appBlocklist": [],
      "appBlocklistUpdatedAt": 0
    }
  ],
  "activeProfileId": null,
  "schedules": { "updatedAt": 0, "rules": [] },
  "categorySchedules": { "updatedAt": 0, "rules": [] }
}
```

`serializeBackup()` reconstructs every object in a fixed key order, preserves
authored list/rule order, and adds one trailing newline. The same configuration
and `exportedAt` therefore produce byte-identical files. Schedule rules are
validated with the same `validateScheduleRule` / `validateCategoryScheduleRule`
functions the lock system uses.

Limits: 16 MB of JSON text, 12 named profiles, 100 global focus-hour rules,
100 category windows, and the existing per-policy list bounds (1,000 sites or
URL rules, 500 title rules, 300 channel rules per list, 40 categories, a
500-character focus goal). Repairs (duplicate ids/names, wrong types, invalid
rules) produce warnings; the preview shows them before anything is written.

## What is included

- The **Default profile**: every `PROFILE_POLICY_FIELDS` policy field and its
  desktop-app association.
- Managed **globals**: `enabled`, `shareFeedback`, `resolveEmbedTitles`,
  `resumeMode`, `resumeAt`, `notificationPrefs`, `firstDayOfWeek`, `hour24`.
- Every **named profile**: id, name, timestamps, scoped policy, and
  `appBlocklist` / `appBlocklistUpdatedAt`.
- The **active profile id**.
- Configured **focus hours** (`schedules`) and **category windows**
  (`categorySchedules`), plus their `schedulesUpdatedAt` /
  `categorySchedulesUpdatedAt` merge stamps.

## What is deliberately excluded

- Active lock state: timers, Frozen Turkey / focus sessions, schedule
  evaluation output, breaks, settings-lock leads in effect.
- Password material: `passwordHash`, `passwordTs`, `lockKdf` (salt and
  iteration count). A restored file can never arm or unlock a password.
- Delay and random-text gate state (`delayUntil`, `delayDurationMs`,
  `randomTextLen`, challenge stamps).
- Accountability-partner keys/arms (`partnerArmGeneration`,
  `partnerArmUpdatedAt`).
- Onboarding transients (`onboarded`, wizard state, current step).
- Usage statistics, feedback/corrections, prototype examples, centroid caches,
  title caches, override stores, allowance ledgers, notification ledgers.
- `storage.session` tab status/verdicts, model caches, companion pairing and
  snapshots, install ids, and every other secret or runtime marker.

The backup therefore contains user policy data (including site rules, focus
goals, and the optional block-screen note) but no credentials.

## Schedule ownership

Schedules live in `lockState`, not `settings`. The file exports **only the
authored rules and the two merge stamps**, never `timerUntil`, `frozenUntil`,
password/delay/random/partner fields, or break fields. On restore,
`applySchedulesToLockState()` spreads the live `lockState` and replaces only
`schedules` / `categorySchedules` (and stamps if the content changed). Every
active-lock field survives.

Restore refuses while `settingsLocked` — which covers forced locks (global
schedule windows and focus sessions) — before any live write. A category
window alone does not set `settingsLocked`, so a deliberate replace may swap
category windows while one is active; the new list is authoritative and the
companion receives a fresh `categorySchedulesUpdatedAt`.

## Merge semantics

Merge is additive and never deletes a local profile or focus-hour rule.

- **Profiles** match by stable id first, then by case-insensitive normalized
  name. A match updates the existing profile and keeps its local id (so an
  active-profile reference stays valid). A name collision gets a numeric
  suffix; ids are never duplicated. New profiles are added up to the 12-profile
  limit, then skipped with a warning.
- **Profile lists** use union with **imported entries first**, then local-only
  entries. This applies to allowed sites, URL patterns, title rules, channel
  rules, categories, and deleted-builtin labels. Lists are deduped
  case-insensitively and capped at the same bounds as normal edits. Scalars
  (threshold, booleans, focus goal, block note, break configuration) come from
  the file. A label deletion in either side wins over re-adding that label.
- **Desktop apps** union the same way; the stamp becomes `now` only when the
  list actually changed.
- **The active profile** maps the file's id through the id/name match; a
  missing active profile falls back to Default.
- **Focus hours** union by rule id. Imported content wins for a shared id;
  local-only rules remain. A legacy rule without a timezone pin keeps an
  identical local rule's pin, so an unchanged rule does not look modified. A
  new legacy rule is pinned to the restore-time offset.
- **Stamps** move to `now` only when the resulting list is different; an
  identical merge does not churn the companion.

## Replace semantics

Replace swaps the entire managed configuration:

- Default policy + managed globals come from the file; `onboarded` stays
  local (transient wizard state).
- Named profiles, app associations, and the active profile id are exactly the
  file's (after sanitization and bounds).
- Focus hours and category windows are exactly the file's. An empty category
  list is written explicitly (with a fresh stamp), so it deletes existing
  category windows rather than meaning "older peer, no opinion".
- Every local profile and rule not in the file is deleted.
- The replace control requires an explicit checkbox confirmation; the preview
  names every profile/rule that will be removed.

## Lock safety

Before the first live write, `applyBackupText()` calls `getLockStatus()` and
throws `BackupLockedError` when `settingsLocked` is true. The message names the
lock end (when known) or says a password is required. The pre-restore slot is
not written on a refusal. The status is re-checked immediately before the
commit; the soft-lock residual (devtools writes) is the same one every settings
path accepts.

## Pre-restore snapshot

`storage.local["backup:preRestore:v1"]` holds exactly one bounded slot:

```ts
{ version: 1, savedAt: number, mode: 'merge' | 'replace', text: string }
```

Every apply first serializes the **current** configuration into this slot, then
writes the restored config. The page shows the save time, mode, profile count
and rule count, offers a download of the exact file, and can restore it with a
two-step confirmation. Restoring the slot is itself a replace, so it captures
the configuration it replaces in the same slot — the undo is undoable. The slot
is bounded by the same 16 MB limit and is not a second user profile.

## UI and test contract

Route `#backup` (sidebar label "Backup"). Stable ids:

- `#backup-export`
- `#backup-pick`, `#backup-import` (real file input), `#backup-file`
- `#backup-mode-merge`, `#backup-mode-replace`
- `#backup-errors` (`role="alert"`)
- `#backup-preview`, `#backup-preview-summary`, `#backup-preview-changes`
  (`li[data-kind][data-action]`), `#backup-preview-warnings`
- `#backup-confirm-replace`, `#backup-confirm-replace-note`
- `#backup-apply`, `#backup-msg`
- `#backup-lock-note`
- `#backup-pre-restore`, `#backup-pre-restore-info`,
  `#backup-pre-restore-download`, `#backup-pre-restore-apply`,
  `#backup-pre-restore-msg`

## Verification

```bash
npm run typecheck
node scripts/backup-test.mjs
npm run build:chrome
SB_SKIP_BUILD=1 node scripts/e2e-backup.mjs
```

`scripts/backup-test.mjs` covers schema/version rejection, corrupt and
oversized files, determinism, bounds/duplicates, merge/replace, schedule
ownership, lock refusal, the pre-restore slot, and secret exclusion.
`scripts/e2e-backup.mjs` drives a real Chrome options page: download bytes,
corrupt import, merge apply, replace confirmation + apply, lock refusal with no
live writes, and pre-restore recovery. It writes
`docs/audits/assets/2026-11-09-backup.png`.
