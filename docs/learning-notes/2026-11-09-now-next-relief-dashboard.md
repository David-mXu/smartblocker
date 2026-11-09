# The Now / Next / Relief dashboard: one truthful reading of existing state

**Date:** 2026-11-09 · **Scope:** options dashboard (`#dashboard`) · **State:**
implemented and committed on `parity/dashboard`; this note records the design,
tradeoffs and verification.

## 1. The problem

Every fact a user needs about SmartBlocker already existed somewhere: the master
switch in settings, lock reasons in `lock-math.ts`, focus sessions in
`focus-session.ts`, breaks in `breaks.ts`, allowances in the authority stores,
and companion health in `companion-protocol.ts`. But the options pages presented
those facts one feature at a time. A user asking "is it blocking right now, what
happens next, and what relief do I actually have?" had to visit Blocking, Locks,
Focus, Focus hours, and Breaks and mentally merge five sources.

The goal was a first-class **Now**, **Next**, and **Relief** page that answers
those three questions without inventing data. Two constraints shaped the design:

- **Truthfulness over polish.** A countdown must come from the same engine that
  enforces the lock. The page must not guess a schedule end, claim a companion
  is healthy, or imply that a break relaxes hard rules.
- **No second scheduler.** Building an independent timeline calculator would
  create two explanations of the same schedule that could drift. The new view
  had to consume the existing schedule engine.

## 2. Core concepts

### Pure selector, thin view

A **selector** is a function that takes state and returns a view model. This one
is pure: [`src/shared/dashboard.ts`](../../src/shared/dashboard.ts) owns no
timers, reads no browser APIs, writes no storage, and has no React imports.
[`src/options/pages/DashboardPage.tsx`](../../src/options/pages/DashboardPage.tsx)
only renders the returned model and supplies live inputs.

That separation buys deterministic tests. `scripts/dashboard-test.mjs` imports
the TypeScript module directly under Node's type stripping, passes fixed
timestamps, and asserts exact strings and boundaries. No browser, fake clock, or
test runner is needed. It also keeps the page unable to accidentally mutate
lock state while merely describing it.

### Reusing the enforcement engine

The existing [`src/shared/lock-math.ts`](../../src/shared/lock-math.ts) exports
`currentWindowEnd(rules, date)` (is a window active, and when does it end?) and
`nextBoundary(state, now)` (when is the next schedule boundary?). Those are the
same functions the background uses to enforce schedules. The dashboard calls
them rather than reimplementing weekday, overnight, overlap, or pinned-offset
logic.

The "Next" card needs to know whether the upcoming boundary is a **start** or
an **end**. Instead of adding a new API, `nextRuleTransition` calls
`nextBoundary` on a fake lock state containing one rule, then asks
`currentWindowEnd` whether that rule is active. An active rule's earliest
boundary is its end; an inactive rule's earliest boundary is its next start.
Both answers come from the production predicate.

### A timeline without a second scheduler

The 24-hour lanes are produced by **minute-sampling** the same predicate:
`ruleIntervals` walks the local day one minute at a time and records when
`currentWindowEnd` flips between inactive and active. Rules are minute-granular
and all rule frames are whole-minute offsets, so the sampled boundaries are
exact. Intervals from overlapping rules are merged for drawing, while
occurrences remain per rule so the textual equivalent can name each one.

**DST is the subtle part.** A local day is not always 24 hours: it can be 23
(spring forward) or 25 (fall back). `dayBounds` asks the JavaScript `Date`
constructor for local midnight today and local midnight tomorrow, giving the
real span. Percentages divide by that span, ticks are placed at local 0/6/12/18
and the next local midnight, and the marker is clamped into the day. The tests
run the DST cases in a child process with `TZ=America/New_York` so the suite is
meaningful regardless of the machine timezone.

One honest limitation: `lock-math` constructs window ends by adding minute
offsets to local midnight. On a DST transition day, the configured wall-clock
time and the actual firing instant can differ by an hour. The dashboard displays
the **actual local firing instant** and the rule's configured summary, and the
tests assert safe day lengths rather than civil-duration assumptions. Fixing the
scheduler itself was out of scope for a read-only view.

### Deferred focus commits and relief boundaries

A pending focus session is a **deferred commit**: the lock is written only
after the undo window closes. The dashboard therefore shows three distinct
states: "pending" (undo still available), "locking" (undo closed, blocking
forced), and "finishing" (end passed, record awaits cleanup). Collapsing these
into one "focus active" badge would hide the user's last chance to undo.

Relief is deliberately narrow. The model lists the configured break mode,
active or pending break countdowns, and live allowance/opening/Pomodoro grants
from the local authority. Its statement is explicit: relief relaxes
**classifier verdicts only**. Deterministic rules, active category-schedule
blocks, forced locks, and desktop enforcement still apply. That sentence
prevents the page from becoming a promise the enforcement layer does not keep.

## 3. Implementation

1. **Read the existing sources first.** `useOptionsState` already exposed
   settings, pending focus, companion and a ticking `now`, but not the raw lock
   state. The page needed schedules, timer/frozen timestamps, and break fields,
   so the hook gained a `lockState` field. No new fetch or duplicate store was
   introduced.

2. **Build the model in layers.** `buildDashboard` derives lock status once,
   then composes `buildLock`, `buildGlobalWindow`, `buildCategoryWindow`,
   `buildBreak`, `buildFocus`, `buildCompanion`, `nextTransition`,
   `buildAutoResume` and `buildRelief`. Each helper has one job and reuses the
   matching production module. Formatting helpers keep countdown text in one
   place: `formatDashboardRemaining` never renders a positive remainder as
   `0`, and `formatDashboardClock` uses local time with a short weekday or date
   only when needed.

3. **Keep optional data visibly optional.** The profile type exists but the
   current build supplies `null`; the model does not invent a name. Allowance
   state is loaded with `GET_ALLOWANCE_AUTHORITY` and falls back to
   `getLocalAllowanceAuthority()`. The UI labels `daemon`, `fallback` and
   `pending` distinctly, and says "unavailable" when there is no state.

4. **Render one focal column.** `DashboardPage` uses the existing Lamplight
   primitives (`SettingsSection`, `SettingsGroup`, `SettingRow`, `Callout`,
   `Badge`) rather than new cards. Now leads with blocking state, then lock
   reasons with per-reason countdowns, active windows, break, focus, and
   companion. Next shows the global transition, category transition,
   auto-resume, and pending focus. Relief shows break mode, allowance authority,
   live grants, and the classifier-only statement. The timeline renders two
   labelled lanes with a current-time marker and a `<ul>` of textual
   equivalents, so the information does not depend on color or position.

5. **Register the page honestly.** `OptionsApp` adds `dashboard` as the first
   `PAGES` entry with the label "Now"; the wordmark links to `#dashboard`. The
   unknown-hash fallback stays `blocking` so old bookmarks are unchanged.
   Existing page ids and test ids were preserved.

6. **Verify behavior, not just rendering.** `scripts/e2e-dashboard-test.mjs`
   builds the Chrome extension, seeds settings, lock state, a pending focus
   session and a valid allowance authority, opens
   `options.html#dashboard`, and checks:
   - navigation order and `aria-current`, plus the document title;
   - three simultaneous lock reasons and their aggregate end;
   - global and category transition copy with local clock times;
   - pending focus undo copy and the armed auto-resume time;
   - the relief statement and a live allowance grant;
   - timeline segments, textual equivalents, and the "Now ·" marker;
   - a live timer lock appearing and expiring without a reload;
   - no URL or page title in the body, and no horizontal scroll at 390px.

   Screenshots are written to `/tmp/opencode/dashboard-1280.png` and
   `/tmp/opencode/dashboard-390.png`.

## 4. Alternatives and tradeoffs

- **A new scheduler for the timeline:** rejected. It would be easier to write
  but would create a second source of truth for overnight and DST behavior.
  Minute-sampling is slightly more work per render, but the timeline is memoized
  by day and rebuilt only when the local day changes.
- **Rendering one merged lane:** rejected. Global focus hours and category
  windows have different enforcement semantics, so merging them would imply
  they lock the same things. Two lanes plus per-rule text keep the distinction.
- **Hiding auto-resume while blocking is on:** rejected. The stored plan is
  still armed; hiding it would make the next pause surprising. The page shows
  the armed time and says plainly that it only fires while blocking is off.
- **Treating a pending focus session as active:** rejected. It would erase the
  undo window, which is the user's only chance to cancel.
- **Claiming relief for every block:** rejected. The copy names the boundary:
  classifier verdicts only; deterministic and native enforcement remain.

## 5. Verification

Run from the worktree:

| Check | Observed result |
| --- | --- |
| `node scripts/dashboard-test.mjs` | 17 passed, 0 failed, including DST child-process cases |
| `npm run typecheck` | passed |
| `npm run build:chrome` | passed |
| `node scripts/e2e-dashboard-test.mjs` | all checks passed against the built Chrome extension |

The pure suite covers: empty state, blocking on/paused/forced, overlapping
timer + focus + schedule reasons, exact countdown boundaries, indefinite
password gates, overnight schedules, overlapping windows, category windows,
pending/active focus, auto-resume modes, relief grants and authority states,
break copy, companion states, timeline text and local-time labels, absence of
URL/title fields, and spring-forward/fall-back day lengths.

The e2e suite is the evidence that the page runs on live extension state rather
than static fixtures: it drives real storage writes and observes the UI update
without a reload.
