# Versioned configuration backup and restore

## 1. Goal and boundary

SmartBlocker had no way to move a carefully tuned configuration to another
install, or to recover one after a bad edit. The task was a local, versioned
JSON backup with an import preview, merge and replace modes, and an undo path —
without turning the file into a security hole or a source of silent corruption.

The key decision is that a backup is **configuration, not a snapshot of runtime
state**. It carries the Default profile's policy, the managed globals, every
named profile (including desktop-app associations), and the authored
focus-hours/category rules. It deliberately excludes things that would be
dangerous or meaningless to transplant:

- active locks (timers, focus sessions, breaks) and schedule evaluation output;
- password hashes, KDF salt/iteration state, delay/random-text gate state, and
  partner keys/arms;
- usage statistics, feedback/corrections, centroids, caches, allowance and
  notification ledgers;
- onboarding transients, `storage.session` tab status, companion pairing, and
  every secret.

The file still contains user policy data — site rules, focus goals, the optional
block-screen note — so the UI says so next to the download button. Full format
and semantics live in [`docs/backup.md`](../backup.md).

## 2. The file format: version gate, then repair

[`src/shared/backup.ts`](../../src/shared/backup.ts) is a pure module: no
browser APIs, erasable TypeScript syntax only, and explicit `.ts` extensions on
local imports. That combination is what lets Node import the exact same code
the extension runs, instead of a mirrored test copy.

A document declares `schema: "smartblocker.config"` and an integer `version`
(currently `1`). `parseBackup()` is deliberately two-stage:

1. **Hard gates** — non-empty text, 16 MB cap, valid JSON, a JSON object, the
   schema id, and a version in `[1, current]`. A newer file is rejected with
   the producer/consumer versions in the message, because silently dropping
   fields the importing build does not understand is worse than refusing.
2. **Repair** — once the envelope is trusted, `sanitizeBackup()` rebuilds a
   canonical document. Wrong types fall back, lists are normalized and capped,
   duplicate profile ids/names and malformed rules are repaired, and each
   repair produces a human-readable warning. Structural omissions (missing
   `default.settings`, `profiles`, or `schedules.rules`) are errors rather than
   silent empties.

Repair rather than reject is a deliberate tradeoff. A backup is often the last
copy of years of tuning; refusing it because one timestamp is a string loses
everything. The warnings are surfaced in the preview, before any write, so the
user sees what was fixed. The bounds are the normal editing bounds: 12 named
profiles, 100 focus-hour rules, 100 category windows, plus the existing policy
list limits (1,000 sites/URL rules, 500 title rules, 300 channel rules, 40
categories). The 16 MB cap is a memory/storage guard against a devtools-edited
file.

`serializeBackup()` is not just `JSON.stringify`. Every object is rebuilt in a
fixed key order, arrays preserve authored order, optional rule fields are
omitted when absent, and one trailing newline is added. The same
configuration plus the same `exportedAt` therefore produces byte-identical
text — useful for tests, diffs, and trusting that a re-download did not
"change" anything.

## 3. Merge vs replace

Both modes first build a pure `BackupAppliedState`, and the UI preview calls
the *same* `mergeBackupState()` / `replaceBackupState()` functions. A preview
that reimplemented the diff could disagree with the apply; sharing the code
makes that class of bug impossible.

**Merge** is additive. Profiles match by stable id first, then by
case-insensitive normalized name. A match keeps the local id, so an active
profile reference stays valid, and updates the name/policy/apps from the file.
A genuinely new profile gets its imported id when free, otherwise a fresh id;
a colliding name gets a numeric suffix; new profiles stop at the 12-profile
cap with a warning. Lists (allowed sites, URL patterns, title rules, channels,
categories, deleted built-ins, desktop apps) use a union with **imported
entries first, then local-only**, deduped case-insensitively and capped at the
normal bounds. Scalars come from the file. The active-profile id is mapped
through the id/name matches; a missing mapping falls back to Default.

The imported-first ordering is a product decision, not an accident: a merge is
usually "bring my saved setup onto this install," so the saved list's priority
should be visible and deterministic. It also makes a repeated merge converge
instead of oscillating. Local-only entries are never deleted, and a deletion
marker for a built-in label beats re-adding that label.

**Replace** is exact: the file's Default policy/globals, named profiles, app
associations, focus hours, and category windows become the managed config.
Local-only profiles and rules are deleted. `onboarded` stays local because it
describes this install's wizard, not the user's policy. An empty category list
is written explicitly with a fresh stamp, so it means "delete the windows"
rather than the older-peer meaning "no opinion." The UI requires an explicit
checkbox before replace can run and the preview names every removal.

## 4. Schedules live in `lockState`

Focus hours are not in `settings`; they live in `lockState`. Exporting the
whole `lockState` would have leaked active timers, password/delay state, and
break fields into a "configuration" file. Instead the document contains only
the authored rule lists and the two merge stamps
(`schedulesUpdatedAt`, `categorySchedulesUpdatedAt`).

On restore, [`applySchedulesToLockState()`](../../src/shared/backup.ts) spreads
the live `lockState` and replaces only the schedule lists (and their stamps).
Every active-lock field survives. Schedules union by rule id in merge mode;
imported content wins for a shared id, local-only rules remain. A legacy rule
with no timezone pin is pinned at restore time, except when an identical local
rule exists — then the local pin is kept, so an unchanged rule does not look
modified.

Stamps move to `now` only when the resulting list actually differs. This
matters because the desktop companion watches the stamps: an identical merge
must not look like a config change and trigger a resync.

## 5. Refusing while locked and the undo slot

[`src/shared/backup-store.ts`](../../src/shared/backup-store.ts) owns the
browser side. `applyBackupText()` parses, then checks `getLockStatus()` and
throws `BackupLockedError` when `settingsLocked` is true — before any live
write. The message names the lock end when known, or says a password is
required, and notes when a schedule or focus session is currently forcing
blocking. The Apply button intentionally stays enabled while locked so clicking
it produces that explanation instead of a dead control.

`settingsLocked` covers forced locks (global schedules and focus sessions),
but a category window alone may not set it. A replace can therefore swap
category windows while one is active; the new list is authoritative and the
companion gets a fresh stamp.

The lock check runs again immediately before the commit, because a lock can
start while the options page is open. That is a time-of-check/time-of-use
window, and the residual is the same soft-lock one every settings path accepts:
a devtools writer can still race the final write. The design narrows it rather
than pretending it is impossible.

Before the commit, the store serializes the **current** configuration into one
bounded slot, `storage.local["backup:preRestore:v1"]`
(`{ version, savedAt, mode, text }`). The slot is written before the live
config, so a crash between the two writes still leaves a recoverable file. The
page shows its timestamp, mode, profile count, and rule count, can download
the exact bytes, and can restore it after a two-step confirmation. Restoring
the slot is itself a replace, and that replace captures the configuration it
is about to overwrite in the same slot — the undo is undoable. One slot, not a
history, keeps storage bounded; the download button is the way to keep more.

## 6. The `#backup` page

[`src/options/pages/BackupPage.tsx`](../../src/options/pages/BackupPage.tsx) is
wired into the options shell as `#backup` with the `Archive` icon. It follows
the existing Lamplight primitives (`Page`, `SettingsSection`, `SettingsGroup`,
`SettingRow`, `Callout`) and the autosave/no-Save-button pattern.

The interaction order is export → choose file → choose mode → inspect preview →
apply. A corrupt file clears the preview and disables Apply; a valid file
produces counts, a change list with `data-kind`/`data-action` for tests, and
warnings. Replace adds the confirmation callout and checkbox. Stable ids cover
the export, picker, mode radios, errors (`role="alert"`), preview, replace
confirmation, apply status, lock note, and the pre-restore controls; the full
list is in [`docs/backup.md`](../backup.md) and the design contract in
[`docs/design-notes.md`](../design-notes.md).

## 7. Verification

Pure and mocked-storage behavior is covered by
[`scripts/backup-test.mjs`](../../scripts/backup-test.mjs), 17 tests:

- byte-for-byte round trip and deterministic serialization;
- corrupt/wrong-schema/future-version/oversized rejection;
- bounds, duplicate and invalid-rule repair;
- no secrets or runtime state in the file;
- merge by id and by normalized name, list union precedence, local-only
  retention, id/name collision handling, and the profile cap;
- replace removal semantics and the explicit empty category list;
- identical-schedule stamp stability and preservation of every active lock
  field;
- preview counts and removal names;
- lock refusal with no live writes;
- pre-restore capture, download text, and recovery for both merge and replace.

The real-browser suite
[`scripts/e2e-backup.mjs`](../../scripts/e2e-backup.mjs) drives a disposable
Chrome profile: it downloads and parses the actual file bytes, imports a
corrupt file, performs a merge against seeded local state, checks lock-field
preservation and the pre-restore slot, refuses while a settings lock is active
and proves the live config did not change, then performs a confirmed replace
and recovers the pre-replace state. It writes
[`docs/audits/assets/2026-11-09-backup.png`](../audits/assets/2026-11-09-backup.png).

Commands run:

```bash
npm run typecheck
node scripts/backup-test.mjs
npm run build:chrome
SB_SKIP_BUILD=1 node scripts/e2e-backup.mjs
```

Observed results: typecheck and build passed; the Node suite reported
`17 passed, 0 failed`; the e2e suite reported `All backup UI checks passed.`

## 8. Tradeoffs and unresolved edges

- **Imported-first list union** can reorder a local list. The alternative,
  local-first, would make a restored install inherit stale ordering. Neither
  is "correct"; the choice is documented and tested.
- **Repair with warnings** trusts the envelope but not the contents. A file
  with a missing top-level section is still rejected, because defaulting it
  would silently wipe configuration.
- **One pre-restore slot** trades history for bounded storage. Downloading is
  the escape hatch.
- **Soft-lock residual** remains for devtools writers; the final re-check
  narrows but cannot eliminate the race.
- **The 16 MB cap counts JS string length**, not encoded file bytes. It is a
  guard, not an exact byte quota.
- **Companion convergence** relies on the stamps changing only when content
  changes. If a future schedule field is added, both `ruleKey()` and the
  companion's merge need to learn about it together.
