# Productive-work rewards: opt-in focus credit without a second balance

## 1. Goal and boundary

The allowance ledger already had a capped per-category `earnedRewardMs` pool and an authoritative `reward` command, but nothing earned it automatically. This change turns that accounting into an actual opt-in reward loop:

- a category must explicitly enable `rewardEarning`;
- the user configures a bounded work-to-reward unit (default 5 focused minutes -> 1 minute, minimum 1 minute each, award never above work);
- productive focus accrues work only while SmartBlocker is enabled and a real settings-lock/focus context is active;
- completed work creates a persisted command intent and submits it through the authoritative allowance path; it never writes a balance directly;
- the Allowance page explains the rule, shows live status and progress, and reports the authoritative earned-today amount against the category cap.

The safety boundary is unchanged from Breaks v2: the browser observes time, but the extension fallback or Rust daemon applies each reward command and stores its receipt. A pending intent is persisted **before** submission, so a worker crash can only undercount, never double-credit.

## 2. Conservative earning rule

The resolver in [`src/background/reward-accrual.ts`](../../src/background/reward-accrual.ts) requires all of the following:

1. `settings.enabled`;
2. `lock.settingsLocked` and no active explicit break;
3. no active focus/Pomodoro program (those already award completed work);
4. system idle state `active`;
5. a focused browser window and its active tab, with an `http(s)` URL;
6. a real classifier verdict `kind === 'allowed'` with a numeric `score >= settings.blockThreshold`;
7. not currently relieved by an allowance/opening/Pomodoro grant for that category.

The deliberate choice is that **whitelisted pages do not earn**. A whitelisted page can be recorded as allowed without a classifier score, so it has no evidence that the content itself is productive. The same conservative rule excludes `overridden`, `browsing`, `blocked`, `blocked-rule`, weak verdicts, and fail-closed pages. This makes the feature slightly under-inclusive, which is preferable to paying reward for a page the local classifier never actually endorsed.

Each enabled category accrues independently from the same focused minutes. Pools and caps remain per category. A category that reaches its daily cap stops minting new intents without blocking another category.

## 3. Time accounting

[`src/shared/reward-accrual.ts`](../../src/shared/reward-accrual.ts) is a pure state machine:

- each checkpoint closes the **previous** segment and records the categories that were earning during it;
- this means a tab switch credits the page actually worked on, not the page that happens to be in front afterwards;
- gaps longer than 135 seconds are discarded in full, not clamped into one free minute;
- the first checkpoint after a worker restart is recovery-only (`discardPrevious`), so the pre-restart gap is never charged;
- idle, break, focus-program, and API-loss transitions also discard the preceding gap;
- an identical checkpoint time adds zero time and cannot duplicate an award;
- local midnight resets the progress remainder; work does not carry into the next day;
- at most one pending intent exists per category, so repeated checkpoints cannot mint the same work twice;
- a pending intent keeps the exact operation id, timestamp, day key, amount, and consumed work for every retry.

Operation ids are deterministic: a 32-hex install id plus a persisted 16-hex ordinal. Retries reuse the exact id; the authority's existing duplicate receipt logic then returns `ok, duplicate: true` if the first submission was applied but its reply was lost.

A terminal refusal (for example `day-rollback` or `invalid-operation`) drops the intent **and consumes its work**, so the next checkpoint cannot re-offer the same minutes under a fresh id. A transient failure keeps the intent and retries the identical payload. The tradeoff is an occasional conservative undercount when the authority permanently rejects a valid-looking award and the user later changes the condition; the alternative risks double payment.

Reward config lives in [`src/shared/allowance-math.ts`](../../src/shared/allowance-math.ts) and the Rust mirror in [`allowance.rs`](../../companion/crates/smartblocker-core/src/allowance.rs). Defaults are off / 5 min / 1 min. Normalization clamps both durations to whole milliseconds between one minute and 24 hours, and clamps award to work. Existing zero-cap behavior is unchanged.

## 4. UI and live evidence

[`src/options/pages/AllowancePage.tsx`](../../src/options/pages/AllowancePage.tsx) adds:

- an opt-in switch;
- work-per-unit and reward-per-unit minute fields;
- a live earning/paused badge and a plain-language reason;
- earned today / cap, current unit progress, and a progress bar;
- a note while an award awaits authoritative acknowledgement.

The page polls `GET_REWARD_STATUS` once per second. Configuration fields now track a `configDirty` flag, because the existing one-second authority poll would otherwise erase an unsaved switch/field change before the user could press Save. A category switch or a successful Save reloads the authoritative normalized config.

`GET_REWARD_STATUS` is read-only and wired in [`src/background/index.ts`](../../src/background/index.ts); no balance is uploaded.

## 5. Alternatives and tradeoffs

- **Whitelisted pages earn:** rejected. "Allowed" can mean the user whitelisted the site, not that the classifier found productive content.
- **Credit the page currently in front at checkpoint time:** rejected. It would credit a tab switch's entire previous gap to the new page. Closing the previous segment is the safer model.
- **Write the ledger directly from the tracker:** rejected. The whole feature would bypass daemon receipts, caps, and revisions.
- **Retry terminal refusals forever:** rejected. Exact retries only help transient transport/revision failures.
- **Carry progress across midnight:** rejected to keep the daily cap tied to a local calendar day.
- **Count focus-program work simultaneously:** rejected because focus cycles already award completed work, which would double-pay the same minutes.

Known conservative edge: if the daily cap is reached exactly between checkpoints, the remainder of that final work unit can be discarded. The award itself is still capped correctly.

## 6. Verification

Executed in this worktree:

| Check | Result |
| --- | --- |
| `node scripts/reward-accrual-test.mjs` | 16 passed: ratio/unit math, tab switch, independent categories, stale gaps, restart, midnight, cap, disabled/break, verdict eligibility, malformed state, exact retry, terminal refusal |
| `node scripts/allowance-math-test.mjs` | 28 passed: reward defaults/clamps plus existing allowance math |
| `node scripts/allowance-state-test.mjs` | 12 passed |
| `node scripts/allowance-store-test.mjs` | 7 passed, including a fallback reward command and cap |
| `node scripts/allowance-bridge-test.mjs` | 10 passed |
| `node scripts/allowance-boundary-test.mjs` | 4 passed |
| `node scripts/category-relief-guard-test.mjs` | 8 passed |
| `node scripts/focus-cycle-test.mjs` | 9 passed |
| `cargo test -p smartblocker-core` | 262 passed |
| `cargo clippy -p smartblocker-core --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `npm run typecheck` | clean |
| `npm run build:chrome` | built |
| `node scripts/e2e-reward-test.mjs` | `REWARD FALLBACK E2E: ALL PASSED`: real options UI, persisted opt-in, active lock, focused productive tab, authoritative fallback credit, cap pause, blocked-verdict pause, no daemon |

The reward E2E injects the classifier verdict into `storage.session` for a real foreground tab so it does not wait for a local model load; the same run also observed a real cached classifier verdict at 72% for the test page. No Rust daemon was started in that E2E. A full `cargo test --workspace` was attempted but the environment lacks `pkg-config`/`libdbus-1-dev`, so crates requiring DBus could not build; the changed `smartblocker-core` crate passed its complete suite. No native-Windows/daemon E2E is claimed for this change.
