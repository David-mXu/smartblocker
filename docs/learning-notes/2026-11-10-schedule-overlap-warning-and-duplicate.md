# Schedule overlap warnings and rule duplication

Date: 2026-11-10
Task: make focus-hour and category-schedule editing easier without changing
lock semantics.

## The problem

The Focus hours page (`src/options/pages/SchedulePage.tsx`) and the
per-category schedule editor (`CategoryScheduleSection.tsx`) let a user stack
as many weekly windows as they want. Nothing explained what happens when two
windows cover the same time. The rules are additive — the union of their
windows is enforced — but the UI looked like a list of independent rows, so an
overlap could look like a mistake or like one rule might replace another.

Duplicating a rule was also manual: change every day chip and both time
fields. That is slow for the common case of "same window on a few more days."

## Concepts

- **Half-open interval.** A window is `[start, end)`: it includes its start
  minute and excludes its end minute. `09:00–12:00` and `12:00–17:00`
  therefore do **not** overlap; they touch at 12:00.
- **Overnight window.** `end < start` means the window crosses midnight
  (`Mon 22:00–06:00` runs into Tuesday morning). Comparing only
  `max(startA, startB) < min(endA, endB)` on the start day misses this.
- **Weekly modular timeline.** Each rule is expanded into real segments on a
  10,080-minute week (7 × 1,440). A Monday 22:00–06:00 window becomes a
  segment that spans into Tuesday. Adding a ±1 week copy lets a Sunday-night
  window overlap a Monday-morning one without special cases.
- **Timezone frame.** `ScheduleRule.tzOffsetMinutes` is a fixed offset east
  of UTC captured when the rule is saved. Evaluation uses it when present and
  otherwise uses the device's current zone. To compare two rules in different
  frames, both are shifted into the device's weekly frame:
  `deviceStart = ruleStart + (deviceOffset − ruleOffset)`.
- **Single-sourced scheduling.** Overlap detection is a *display aid*. It
  reuses lock-math's `scheduleWindowMinutes` and never decides whether a rule
  is currently active. `currentWindowEnd` / `isInScheduleWindow` remain the
  only evaluators.

## Investigation

The first stop was `src/shared/lock-math.ts`. Its private `ruleWindowEnd`
already defines the important semantics:

- end is exclusive (`nowMs < start + duration`),
- a containing overnight window can only have started today or yesterday,
- pinned rules evaluate in their own fixed-offset frame,
- `startMinutes === endMinutes` is an invalid, zero-length window.

Reusing that file mattered because a second implementation of "is this rule
active?" would drift from the background enforcer. The only new primitive was
to expose the existing duration formula as `scheduleWindowMinutes`; the old
private `windowDurationMs` now calls it, so behavior is unchanged.

`src/shared/notifications.ts` already groups overlapping schedule starts for
one reminder, but it groups *event instants*, not overlapping windows. It was
useful evidence that additive rules are expected, but not reusable for this
warning.

## Implementation

### Pure helpers

`src/shared/schedule-overlaps.ts`:

- Expands each valid rule into weekly segments, including overnight spans.
- Compares every pair within the supplied entries. Only pairs with a real
  intersection are returned, so "no overlap" is simply `[]`.
- Canonicalises intersections to one occurrence per week and de-duplicates
  the ±1-week copies.
- Returns deterministic pairs ordered by input position, with each pair
  carrying a stable `key`, both human-readable windows, a `summary`
  (`Mon 09:00–17:00 overlaps Mon 12:00–18:00`), a `detail`
  (`Shared time: Weekdays 12:00–17:00.`), and the raw weekly intervals.
- Formats same-day shared ranges by grouping days (`Weekdays`, `Every day`),
  which keeps the warning short.
- Uses the existing `display-prefs.ts` formatting so the first-day and
  24-hour preferences apply to the warning too.

`src/shared/schedule-edit.ts`:

- `duplicateScheduleRule` copies every field, clones `days` and `categories`,
  gives the copy a fresh id, and adds a display-only `(copy)` label.
- Repeated duplication produces `(copy 2)`, `(copy 3)`, and so on.
- Labels are capped at 80 characters, with the suffix preserved when the stem
  must be shortened.

The `ScheduleRule.label` field is optional and display-only. The companion's
Rust mirror gained the same optional field (`label: Option<String>`) so a
companion merge/reverse-sync does not silently drop it. Evaluation never reads
it.

### Follow-up: the cross-language label contract

Merging the feature exposed four places where a display-only field can still
change behavior. The guiding rule: **a bad label must never drop or alter the
enforcement window**, but the two implementations must agree on what a valid
label is.

1. **UTF-16 cap.** JavaScript's `.length` counts UTF-16 code units; Rust's
   `chars().take(80)` counts scalar values. A label of 80 emoji was 160 JS
   units, so the extension could reject a label its own daemon had just
   produced. [`sanitize_schedule_label`](../../companion/crates/smartblocker-core/src/lock_math.rs)
   now truncates on `len_utf16()`.
2. **Canonical tie-breaker.** At equal `schedulesUpdatedAt`, the merge picks
   the canonically smaller same-id rule. The canonical key omitted the label,
   so two peers holding the same window with different names could each keep
   their own rule depending on argument order. Both
   [`scheduleCanon`](../../src/shared/lock-math.ts) and
   [`canon`](../../companion/crates/smartblocker-core/src/merge.rs) now include
   the label, and a shared fixture
   (`equal timestamps same-id schedule conflict includes the display label…`)
   asserts convergence.
3. **Backup merge/change detection.** `canonicalRule` dropped the label, and
   `ruleKey` / `sameRuleCore` ignored it. A restored rename was silently
   discarded, and because `rulesEqual` saw no change, the schedule sync stamp
   never bumped. Both now include the label, with 18 backup checks covering
   sanitize, round-trip, and rename propagation.
4. **Sanitizer parity.** Rust now collapses control characters and whitespace
   and treats an all-whitespace label as absent, matching the TS sanitizer;
   the rule itself is retained either way.

Observed on the merged tree: `lock-math-test` **180 passed** (the new fixture
fails without fix 2), `backup-test` **18 passed**, `cargo test -p
smartblocker-core` **320 passed** (316 unit + 4 fixtures). Older companion
builds still drop the optional label on reverse-sync; new builds preserve it.

### UI

`SchedulePage.tsx` now computes overlaps from the in-memory `rules` array, so
the warning updates while the user edits and disappears the moment windows
stop overlapping. `CategoryScheduleSection.tsx` does the same for category
rules.

`src/components/ScheduleOverlapNotice.tsx` is a quiet `Callout` with
`role="status"` and `aria-live="polite"`. It renders nothing when there are no
pairs. Its copy says the important part explicitly: overlapping schedules are
allowed, blocking is the union, and no fix is needed. It lists at most three
pairs and adds an "and N more" line, so a pathological list cannot turn into a
wall of amber.

Each global and category rule gained a Duplicate icon button:

- global: `.schedule-duplicate`, `#schedule-duplicate-<rule id>`, disabled
  while any lock is active;
- category: `.category-schedule-duplicate`,
  `#category-schedule-duplicate-<rule id>`, disabled while locked or while a
  saved category window is active.

The copy is inserted directly after its source so the relationship is
obvious. Existing DOM ids, classes, day-chip layout, and preference-aware time
text were left intact; the optional label sits above the existing summary only
when present.

## Alternatives and trade-offs

- **Compare start days only.** Simpler, but wrong for every overnight rule.
  The weekly-segment expansion handles overnight and Sunday/Monday wrap in one
  representation.
- **Evaluate actual `Date` instances week by week.** Would reuse more
  lock-math code, but a weekly warning should not change with the current
  week or DST. The fixed weekly pattern is stable and cheap.
- **Second scheduler.** Rejected: `scheduleWindowMinutes` is shared, and
  active-state evaluation stays in lock-math.
- **Warn across global and category rules together.** Category windows only
  affect classifier verdicts, while global windows force blocking. Mixing
  them would produce warnings about different mechanisms, so each section
  reports its own kind. The helper still supports mixed entries and labels the
  pair `mixed` if a caller needs it.
- **Multi-select bulk editing.** Deliberately not added; Duplicate is the
  smaller, safer bulk-edit aid requested here.
- **Error styling.** Overlap is legal, so the notice uses the warning tint,
  not destructive red, and is not an alert dialog.

## Verification

Run from the worktree root:

```text
npm run typecheck                         # pass
node scripts/schedule-overlaps-test.mjs   # 23 passed, 0 failed
node scripts/lock-math-test.mjs           # 179 passed, 0 failed
node scripts/preferences-test.mjs         # 6 passed, 0 failed
node scripts/category-schedule-math-test.mjs  # 17 passed, 0 failed
node scripts/notifications-test.mjs       # 33 passed, 0 failed
npm run build:chrome                      # pass
node scripts/e2e-schedule-ux.mjs          # all checks passed
```

The overlap suite covers: no overlap, endpoint-only touching, partial,
containment, identical, overnight into the next day, two overnight rules,
Sunday→Monday wrap, different days, same timezone pin, mixed pinned/device
frames, different pinned offsets, category rules, weekly grouping,
deterministic ordering, invalid rules, display preferences, and duplicate
labels/ids/bounds.

The Chrome e2e seeds two overlapping global rules and two overlapping
category rules in a disposable profile. It verifies the warning text,
`role="status"`, `aria-live="polite"`, the per-rule duplicate ids, that the
warning disappears when the windows only touch, that duplication marks the
editor dirty and persists a fresh id plus `(copy)` label, that category
duplication keeps its category, that both duplicate buttons disable under a
timer lock, and that 390px layout has no horizontal overflow. Screenshots are
written to `/tmp/opencode/smartblocker-schedule-ux/`.

The Rust mirror compiled under `cargo test -p smartblocker-core` (310
passed), including a round-trip test that keeps `label` on global and category
rules. `cargo fmt --check` still reports pre-existing formatting diffs in
unrelated `lock_math.rs` functions on this branch.

## Caveats

- Pinned rules use fixed offsets, so the warning inherits the documented DST
  residual: after a daylight-saving change, a pinned window can be one civil
  hour off. The overlap math compares the same fixed offsets evaluation uses.
- Unpinned rules are compared with the device's *current* offset; the warning
  is a weekly summary, not a per-date DST simulation.
- The warning lists the first three overlapping pairs and summarises the
  rest.
- Older companion builds that predate the optional `label` field ignore it on
  deserialize and can drop it when they reverse-sync a lock state. New builds
  preserve it.
