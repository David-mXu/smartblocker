# One queue for every lock write, and one label rule for both languages

## The problem

Two defects in the lock system (`src/shared/lock.ts`, `src/shared/lock-math.ts`
and its Rust mirror `companion/crates/smartblocker-core/src/lock_math.rs`):

1. **Lost arm race.** Daemon-frame merges were serialized on `mergeQueue`, but
   every user transition (timer arm, Frozen Turkey, break, password ops,
   schedule edits) was a raw read-modify-write. A merge that had already read
   storage *before* the user armed a lock would blithely write its stale
   pre-arm snapshot back *afterwards* — silently losing the arm.
2. **Schedule-label divergence.** `validateScheduleRule` rejected labels over
   80 UTF-16 units by dropping (or refusing to save) the *whole rule*, while
   the Rust mirror truncated the label and kept the rule. Same rule, two
   stores, two different outcomes — the two stores could never converge on
   such rules.

## Root causes, in plain language

- **Concurrency:** JavaScript is single-threaded, but `await` points are
  interleaving points. A *pattern* like `read → compute → write` is only
  atomic if every writer runs the same pattern through the same door. A
  mutex-by-promise-chaining (`queue = queue.then(op)`) is the standard
  single-door fix — but only if *every* writing path joins it.
- **Cross-language string math:** JavaScript's `String.length` counts UTF-16
  code units (an emoji costs 2), while Rust slices/counts naturally in bytes
  or chars. "80 characters" is therefore three different numbers unless both
  sides pin the unit. The Rust side already counted `len_utf16` and truncated;
  the TS side just refused. Truncate-and-keep is the friendlier contract: the
  schedule *window* is the enforcement; the *label* is decoration.

## What was done

1. **`src/shared/lock.ts` — one write queue.** `mergeQueue` became `runLockOp`:
   every exported transition (and `mergeRemoteLockState`, and the
   partner-pin seed) chains onto a single promise queue. Single queue = no
   lock-ordering deadlock by construction. Two subtle rules make it safe:
   - *Ops must never enqueue from inside an op.* The public read path
     (`getLockState`) enqueues a partner-pin seed; calling it while you hold
     the queue slot would make the seed wait behind the very slot you are
     waiting on. So inside ops, everything reads via `readLockState(true)`
     (the inline-seed path) and writes via `writeLockState` directly.
   - A queued `verifyPassword` cannot be called from `attemptPasswordUnlock`'s
     op (same self-deadlock), so the body was split into an internal
     `verifyPasswordLocked` and a thin queued wrapper.
2. **Stale-read poisoning found while testing.** A public read that needs to
   seed the pin *awaits the entire queue drain*; committing the snapshot it
   read before the drain would cache stale state (the drain also clears the
   cache via the storage-change listener, so the old guard did not fire).
   `readLockState` now re-reads storage once after a seeded wait, and stops
   instead of spinning if seeding fails again.
3. **`src/shared/lock-math.ts` — `sanitizeScheduleLabel`.** Mirrors Rust's
   `sanitize_schedule_label` character-for-character: Unicode `Cc` control
   characters (so `\n`!) become spaces, whitespace runs collapse to one,
   an all-whitespace label becomes absent, and truncation counts UTF-16 code
   units without ever splitting a surrogate pair. Wired into (a)
   `sanitizeLockState` for both `< schedules` and category rules — with
   exact Rust parity for odd types: `null` label = absent, a *non-string*
   label drops the rule just like serde does — and (b) `setSchedules`/
   `setCategorySchedules` so the invariant holds from birth. No Rust change
   was needed for `\n`: Rust already collapsed it; TS was the outlier.
4. **Shared fixtures** (`companion/.../tests/fixtures/lock-cases.json`) pin the
   arithmetic where both suites can see it: exactly-80-unit label kept whole;
   100 ASCII units → first 80; `\n`/tab/double-space collapse; and a 40-CJK +
   30-emoji label (40 + 30×2 = 100 UTF-16 units) truncated to 40 CJK + 20
   emoji = exactly 80 units, the 21st surrogate pair dropped *whole*.
5. A comment-only fix in `src/background/resume-enforcer.ts`: a password lock
   does not "drop" a pending auto-resume; the alarm clears but the plan
   survives in settings, and the next `syncResume` after unlock fires it.
6. **Onboarding gate (behavioral, added on mandate).** "Blocking disabled"
   now means two different things: a user disable vs a never-onboarded
   install's factory default (`enabled: false` until `COMPLETE_ONBOARDING`).
   Auto-resume must only react to the first. The gate reads `settings.onboarded`
   from the same single `getSettings()` the module already does, in both
   `readArmedPlan()` (arms nothing pre-onboarding) and `resumeNow()` (the
   `resume-at` alarm listener calls it directly, bypassing the plan read, so
   it bails and clears the alarm there too).
7. **A shared-tree test failure that looked like mine wasn't.**
   `usage-stats-test` failed one case because its fixture never seeded
   settings and the first "protected" segment silently relied on
   `DEFAULTS.enabled === true` — a default the onboarding change flipped.
   Lesson: tests that depend on ambient defaults break when the *meaning* of
   a default changes; the fix was an explicit onboarded+enabled seed, not a
   product change.

## Alternatives, tradeoffs, residuals

- A second (write-mutex) queue would have risked ordering deadlocks with the
  merge queue; one queue is slower in theory (one slot per SW context) and
  trivially correct in practice — lock writes are rare.
- `validateScheduleRule` still rejects a *raw* >80 label when a caller skips
  sanitize (the options UI keeps its own inline validation); the sanitize and
  authoring paths are what must never lose a rule again.
- `backup.ts` still does its own `slice(0, 80)` label repair, which can split
  a surrogate pair mid-unit; anything restored into the extension re-passes
  `setSchedules`, whose sanitize drops the dangling half clean. Left alone —
  that file was out of scope.

## Verification (all observed, not assumed)

- `npm run typecheck` — clean.
- `node scripts/lock-math-test.mjs` — 184 passed (incl. the 4 new shared
  fixtures).
- `node scripts/lock-types-test.mjs` — 26 passed, including two new
  regression cases: merge-vs-arm race keeps both sides; queue keeps draining
  while a public read seeds the partner pin (with a 5s deadlock tripwire).
- `node scripts/breaks-test.mjs` (14), `node scripts/surrender-test.mjs`
  (12), `node scripts/resume-test.mjs` (25), `node scripts/grace-math-test.mjs`
  (24) — all green.
- `cd companion && cargo test` (default members, never `--workspace`) —
  316 core tests + all shared fixture suites pass; `cargo fmt --check` and
  `cargo clippy --all-targets -- -D warnings` clean.
