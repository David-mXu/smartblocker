# Schedule lead-in, display preferences, and block-screen notes

Date: 2026-11-09
Branch: `parity/schedule-prefs`

## Why this change exists

This batch closed five Cold-Turkey parity gaps:

1. A focus-hours window can now freeze settings **before** it starts, without
   blocking pages until the real start.
2. Users can choose Sunday or Monday as the first day of the week, and 12- or
   24-hour time, as display-only preferences.
3. The Locks page quietly says when no locks are configured.
4. Users can add a short custom note to block screens.
5. The lock math, UI, tests, and docs were updated together.

The important design constraint: schedule evaluation is shared by the extension
(`src/shared/lock-math.ts`) and the Rust companion
(`companion/crates/smartblocker-core/src/lock_math.rs`). Any behavioral change
has to be mirrored exactly and covered by
`companion/crates/smartblocker-core/tests/fixtures/lock-cases.json`, which both
test suites consume.

## Core concept: a lead is a settings lock, not a block

A schedule rule describes a window `[start, end)`. The new optional
`leadMinutes` adds an interval before it:

```text
[start - lead, start)   settingsLocked = true,  forceBlocking = false
[start, end)            settingsLocked = true,  forceBlocking = true
```

Both intervals set `settingsLocked`, which disables settings changes and hides
the block-screen bypass. Only the real window sets `forceBlocking`, which turns
blocking on even when the master toggle is off and ignores stored overrides.

Two details that are easy to get wrong:

- **The lead is half-open.** At the exact start instant the ordinary
  `schedule` reason takes over. Tests cover both sides of that boundary.
- **The lead lock's `until` is the window's end, not the window's start.**
  Otherwise a lock banner would count down to 09:00, then jump forward to
  17:00 when the window began. Using the window end keeps the displayed
  deadline monotonic.

`leadMinutes` is bounded to `1..1440` (0 or absent means off). It is validated
in both languages and accepted for category schedules, where policy deliberately
ignores it because category windows never lock settings.

## Implementation path

### 1. Lock math, TypeScript and Rust

In `src/shared/lock-math.ts`:

- Added `leadMinutes?: number | null` to `ScheduleRule`.
- Added `MIN_SCHEDULE_LEAD_MINUTES` / `MAX_SCHEDULE_LEAD_MINUTES`.
- Added `'schedule-lead'` to the lock reason union.
- Added private `ruleLeadEnd` / `currentScheduleLeadEnd`, which evaluate the
  lead in the rule's own timezone frame (pinned offset or device zone).
- `deriveLockStatus` now pushes `schedule-lead` after `schedule` and adds the
  lead end to `until`. `forceBlocking` still depends only on the real window
  (or a frozen session).
- `nextBoundary` includes lead starts so the promptness alarm wakes at the
  start of the freeze.
- Added `nextScheduleLockAt` (next settings-lock onset, lead-aware) and
  `nextWindowStart` (next real window start, lead-ignored).
- `scheduleCanon` includes the validated lead so same-id merge conflicts stay
  deterministic.
- `validateScheduleRule` accepts 0 or 1–1440 and rejects fractions,
  negatives, and larger values.

The Rust mirror in `lock_math.rs` adds the same field, constants, reason,
helpers, boundary candidate, validation, and canonical tiebreak. `merge.rs`
includes the lead in its canonical string.

### 2. Why resume stayed on the real window

`src/shared/resume.ts` used to derive the next schedule start by hopping through
`nextBoundary`. Once `nextBoundary` includes lead starts, that derivation would
return the lead start and auto-resume blocking early. `nextScheduleStart` now
calls `nextWindowStart` directly. Tests assert that a rule with a 30-minute lead
still resumes at 09:00, not 08:30.

### 3. Shared fixtures and unit tests

Added fixture cases for:

- lead active without `forceBlocking`
- exact window start handing over to `schedule`
- overlapping active window + another rule's lead (reason order)
- overnight lead starting the previous evening
- category schedule lead not locking
- lead start as the next boundary, including across midnight
- lead sanitization (valid, over 1440, fractional)
- merge canonical tiebreak on lead
- a lead-locked side's schedule list surviving an unlocked newer write

The TypeScript runner (`scripts/lock-math-test.mjs`) and Rust fixture runner
both pass all cases. Additional unit tests cover `nextScheduleLockAt`,
`nextWindowStart`, and resume behavior.

### 4. Display preferences

New pure module `src/shared/display-prefs.ts` contains:

- `normalizeFirstDayOfWeek` (0 or 1 only)
- `normalizeHour24` (strict boolean)
- `orderedWeekdays` / `sortDaysForDisplay` / `weekdayOrderIndex`
- `formatMinutesClock` (locale-independent 12/24-hour output)
- `sanitizeBlockMessage` (trim, collapse controls/whitespace, 160-char cap)

`src/shared/settings.ts` adds `firstDayOfWeek`, `hour24`, and `blockMessage`
to `Settings` and `DEFAULTS`, and sanitizes them on both read and write. This
matters because a devtools-tampered `storage.local` value should not reach
every renderer.

The new `#preferences` page (`src/options/pages/PreferencesPage.tsx`) exposes
the two display controls and a live preview. The selected preferences flow to:

- focus-hours summaries, day-chip order, and overnight notes
- category schedule summaries, day-chip order, and overnight notes
- options lock banners/reasons, Locks page clock text, and Focus page lock times

Native `<input type="time">` values still use `minutesToHHMM` (`HH:MM`), so the
display preference never changes the stored representation.

### 5. Locks hint

`LocksPage` renders `#locks-empty-hint` only when no timer, password, delay,
random-text, or partner lock is active/configured. It disappears on the next
lock tick. The existing empty focus-hours and category-schedule hints were left
in place.

### 6. Custom block-screen message

Settings gain `blockMessage` (≤160 chars, plain text). It is configured on the
Blocking page (`#block-message-input`) and rendered with `textContent` only:

- injected overlay: `#smartblocker-block-message` in `blockscreen.ts`
- DNR force redirect: query param `msg` → `blocked.ts` clamp → 
  `#smartblocker-block-message` in `blockscreen-ui.ts`

`blockscreen.ts` is serialized by `scripting.executeScript`, so the new
argument is a plain string and the function remains import-free. The DNR page
treats `msg` as attacker-influenced: it collapses controls/whitespace, caps at
160 characters, and uses text nodes only.

Alternatives considered:

- **Reuse the `schedule` reason for leads.** Rejected because banners and
  desktop helpers could not distinguish "blocking now" from "settings frozen,
  blocking soon".
- **Set `until` to the window start.** Rejected because the countdown would
  jump backwards at the handover.
- **Store the message as HTML.** Rejected: escaping bugs in an
  attacker-adjacent surface are not worth formatting flexibility.
- **Put display preferences in `lockState`.** Rejected: they are presentation
  only and must not participate in merge or locking.

## Verification

Observed results in this worktree:

```text
npm run typecheck                         → pass
node scripts/lock-math-test.mjs           → 179 passed, 0 failed
node scripts/resume-test.mjs              → 25 passed, 0 failed
node scripts/preferences-test.mjs         → 6 passed, 0 failed
npm run build:chrome                      → pass
node scripts/e2e-schedule-prefs.mjs       → all checks passed
cargo test -p smartblocker-core           → 264 passed (3 suites)
cargo test -p smartblocker-core --lib     → 260 passed
```

The focused e2e verified tampered-preference sanitization, persistence, Monday-
first ordering, 24-hour summaries, lead badge/explanatory text, stored
`leadMinutes`, the `focus hours lead-in` lock banner, both empty hints, and
literal `<b>…</b>` display on both the injected overlay and the DNR
`blocked.html` page. Screenshots:
`/tmp/opencode/smartblocker-schedule-prefs/`.

One test-only issue: Playwright cannot click the visually hidden switch input
because its `<label>` intercepts pointer events; the e2e clicks the label
instead. The product behavior was correct.

## Residuals / notes for the next reader

- The lead explanation shows a time-of-day only. A lead that crosses midnight
  (e.g. 09:00 with a 24-hour lead) displays `09:00` without saying “previous
  day”; the window still evaluates correctly.
- The custom note is rendered on the normal injected block screen and the
  extension-owned force-redirect page. The injected “classifier unavailable”
  screen was left unchanged.
- Category schedules accept `leadMinutes` for shape compatibility but it is
  inert by design.
- The Rust mirror still uses fixed timezone offsets; the lead math inherits the
  documented DST residual.

## Integration follow-up: one boundary, two consumers

Merging the lead work onto the combined tree exposed two cross-feature defects
that the branch's own tests could not see. Both came from the same mistake:
assuming every consumer wanted the *start* of the next configured window.

1. **Dashboard reason map** — `dashboard.ts` keeps an exhaustive
   `Record<LockReason, string>` label map. `schedule-lead` was a new reason,
   so TypeScript correctly rejected the stale map. The fix adds a
   “Focus-hours lead-in” label and a dedicated reason branch that says when
   blocking actually begins, while using `status.until` (the window end) for
   the countdown. A regression test now pins both sides of the handover: one
   minute inside the lead window shows the lead reason and leaves
   `forceBlocking` false; the exact start switches to the ordinary
   `schedule` reason and forces blocking.

2. **Auto-resume / notification starts** — `nextScheduleStart` had been
   simplified to `nextWindowStart(rules, now)`. That is correct while the
   user is outside every window, but wrong for overlapping rules: with an
   08:00–20:00 window already active and a 09:00 start inside it, the planner
   treated 09:00 as a new transition. Notifications would arm a reminder for a
   start the user was already blocked through, and auto-resume could fire
   mid-window. The fix walks past the contiguous active stack first
   (`currentWindowEnd` hop, bounded), then asks `nextWindowStart` for the next
   real onset. This preserves the pre-lead “starts inside a stack are not
   transitions” contract while still ignoring the lead itself.

Evidence on the combined tree:

```text
npm run typecheck                         → pass
node scripts/dashboard-test.mjs           → 18 passed
node scripts/lock-math-test.mjs           → 179 passed
node scripts/resume-test.mjs              → 25 passed
node scripts/notifications-test.mjs       → 33 passed
node scripts/preferences-test.mjs         → 6 passed
cargo test -p smartblocker-core           → 269 passed (3 suites)
```

The durable lesson is to test a new time concept at every consumer boundary,
not only in its owning module. The shared lock-math fixtures proved the lead
math, but the dashboard map and resume helper were separate contracts that
TypeScript and the notification suite caught only after integration.
