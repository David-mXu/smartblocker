# Breaks v2: authority, limited openings, focus and Pomodoro

## 1. Goal and enforcement boundary

Phase 5 item 10 needed four related relief models without weakening any existing lock:

- per-category daily minute/reward pools at local midnight;
- limited-opening sessions that close on inactivity;
- an immediate focus timer that earns capped reward only on completion;
- separate Pomodoro cycles whose programmed breaks do not spend ordinary allowance.

The authority boundary separates **observations** from **relief**: a browser may ask for a transition, but only the daemon (or the explicitly labeled extension fallback) can apply and persist it. Relief applies only to a successful classifier-driven verdict for the page's primary category. Deterministic matches, classifier-unavailable fail-closed screens, desktop-process enforcement, and ordinary lock timestamps are not relaxed. Timer/Frozen/schedule/password/delay/random-text locks are never shortened, and ordinary `enabled` is never toggled by an allowance operation.

Implementation stays uncommitted; unrelated worktree changes and both eval datasets were preserved.

## 2. Concepts and investigation decisions

### Per-category arithmetic

[`src/shared/allowance-math.ts`](../../src/shared/allowance-math.ts) is a pure reducer for one category. Daily pools accept requests with a capped linear waiting-room delay. Pending requests reserve their whole duration; active grants charge wall clock, including idle. Early close charges elapsed time and releases unused reservation but never de-escalates the waiting penalty. Expired grants settle once.

Review found and fixed two malformed-persistence defects:

1. Unknown grant statuses could be reconstructed as live grants and double-charge settled reservations. Status is now a closed per-kind state machine.
2. A finite but unsafe persisted reward could be clamped upward into a full free reward. Unsafe persisted rewards now become zero.

[`src/shared/allowance-state.ts`](../../src/shared/allowance-state.ts) wraps per-category ledgers into a bounded authority snapshot. Commands may configure a category, request/cancel allowance, earn reward, open/record/close a session, or start fixed Pomodoro relief clamped to 24h. Inputs are cloned, and the last 64 exact operation receipts are stored atomically with revision. `apply` validates before revision assignment; `commit` appends the matching fingerprint and requires a strictly higher JS-safe revision.

[`allowance.rs`](../../companion/crates/smartblocker-core/src/allowance.rs) mirrors those transitions, including delayed ledger sanitization, fingerprint field/null order and UTF-16/Unicode boundary behavior. The mirror is not just a time-clock sanity check: it is the daemon's acceptance boundary.

### Daemon and fallback authority

[`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs) keeps an optional authority in `allowance-state.json`. `None` has two useful distinctions:

- genuinely missing file: eligible for one offline snapshot bootstrap;
- initialized state (and its revision counters): normal command authority.

Present malformed files stop startup instead of producing a fresh pool. Configuration changes consult the same lock status as browser settings. Other command kinds do not alter lock or partner state. Persistence precedes success acknowledgments. Revision/duplicate/persistence failures return distinct explicit reasons.

[`allowance-bridge.ts`](../../src/background/allowance-bridge.ts) separates command and snapshot queues, which prevents an acknowledgement from deadlocking behind the command waiting for that acknowledgement's local persistence. The next command waits for the earlier result and local snapshot write, so it cannot reuse a stale base revision.

Two initialization races were particularly instructive:

- A first configure could run in fallback revision 1 and then be overwritten by a late empty bootstrap. First-use submissions now wait for real initialization (bounded to five seconds).
- After that timeout, another late response could overwrite fallback commands. The connection now treats timeout as **epoch-local fallback authority** and ignores late authority for that same epoch; a fresh epoch must re-establish it. This is why command persistence and authority selection cannot stop at optimistic concurrency fields alone: the initialization handshake must be ordered too.

The UI reports `daemon`, `pending`, or `fallback` honestly. It never labels older/disconnected peers as synchronized.

Reconnect reconciliation follows the same anti-rollback rule. A lower daemon snapshot cannot replace newer offline spending. The browser retains that local state, offers its newer snapshot for forward reconciliation, and remains in fallback until a compatible authority arrives. The daemon republishes a higher/equal existing revision and accepts only a strictly newer recovery snapshot. Mirror-write errors reject the awaiting command and release the next command instead of silently logging and deadlocking both.

### Relief and wall-clock lifecycle

Authority offers relief only through `classifierReliefAllowed`: successful model verdicts may be relaxed only when neither Frozen/global forced schedules/password locks nor an active category-scoped rule owns the block. Deterministic matches and fail-closed outcomes still bypass this path. A relieved blocked page counts as real limited-opening activity; recording is not limited to pages that were already allowed.

`nextAllowanceBoundary` identifies pending activation, grant expiry, opening inactivity/max-lifetime, and the next local midnight. Browser startup restores a dedicated alarm from persisted authority, and grant writes re-arm it. A newly accepted authority snapshot also schedules a coalesced open-tab sweep, so activation and cancellation do not depend on a reload. At an alarm, sweeping re-derives the deadline and then reevaluates open tabs; a delayed alarm cannot make an expired grant valid because the reducer still checks wall time.

### Limited Opening

A Session consumes one daily opening rather than minutes or waiting escalation. Grants close on monotonic activity timeout (default 120 seconds), capped by a maximum lifetime (default 30 minutes). Classified activity revalidates through the authorized `opening-activity` command, coalesced to at most once per five seconds per grant. A visit affects only its primary label; it cannot prolong an unrelated opening.

### Focus and Pomodoro

[`focus-cycles.ts`](../../src/background/focus-cycles.ts) is a browser-local scheduler; [`focus-cycle-types.ts`](../../src/shared/focus-cycle-types.ts) validates volatile persisted program data.

Focus starts immediately and is distinct from [`focus-session.ts`](../../src/shared/focus-session.ts), the existing deferred 60-second-undo Frozen lock. A completed focus timer submits capped reward exactly once; cancellation before completion earns none.

Pomodoro alternates work and fixed break stages. Each completed work stage can earn reward, while each break is a fixed-end `pomodoro-start` grant spending no ordinary pool/opening or escalation. Missed late phases consume only remaining wall-clock time. Persisted exact retry commands reuse the same operation ID, timestamp, duration, and fingerprint after a worker restart or transient overlap.

A concrete bug illustrated snapshot discipline after `await`: `runTick` used the obsolete work-stage snapshot after `startBreak()` had stored a new break and immediately advanced to the next work stage. It now rechecks the latest stage after the await, so advancement happens only when the actual fixed break has ended.

A lifecycle epoch also governs starts and ticks. Cancelling while authority initialization is in progress prevents the old continuation from storing/arming a program and prevents an obsolete tick from scheduling another stage. If a fixed pending retry becomes permanently illegal because later authority observes a newer wall time or day (`clock-rollback`/`day-rollback`), that stale reward/break is terminal: it is skipped rather than retried forever, backdated, or extended. Retryable transport/overlap failures preserve the identical operation payload.

Browser-local scheduling is not claimed as desktop session coordination. The earned rewards and relief grants themselves use the daemon's shared snapshots and receipts.

## 3. Alternatives and tradeoffs

- **Upload full balances:** rejected. Normal commands carry only bounded transitions. An offline snapshot is admitted one time only into an uninitialized daemon.
- **One generic command queue for everything:** rejected after it deadlocked an ACK behind its own persistence write. Command completion and snapshot persistence have separate ordered chains.
- **Indefinite initialization wait:** rejected because older peers would permanently block fallback. A bounded handshake plus timeout-scoped fallback preserves useful offline behavior without allowing a later overwrite.
- **Idle-aware allowance consumption:** deliberately not selected for this iteration. Ordinary allowance uses wall-clock charging; only limited openings observe inactivity.
- **Clamping finite unsafe values into caps:** rejected. Finite does not mean JS-safe integer.
- **Claiming synchronized browser-local schedulers:** avoided. Only their authoritative grants/rewards are synchronized through the daemon.

## 4. Verification evidence

Executed in this batch on Linux/WSL:

| Check | Evidence |
| --- | --- |
| `node scripts/allowance-math-test.mjs` | 28 passed: escalation, wait vs active charging, refunds, rollover, malformed state, rollback |
| `node scripts/allowance-state-test.mjs` | 12 passed: per-category authority, stale bases, primary-only relief, duplicate retries |
| `node scripts/allowance-store-test.mjs` | 6 passed: serialized fallback persistence, lock rejection, write-failure recovery, restart receipts |
| `node scripts/allowance-bridge-test.mjs` | 9 passed: command ordering, write barrier and explicit rejection, deferred reconnects, initialization races, and newer-offline-opening anti-rollback |
| `node scripts/allowance-boundary-test.mjs` | 4 passed: local-midnight scheduling, pending activation/expiry, opening idle/max-lifetime and malformed state |
| `node scripts/category-relief-guard-test.mjs` | 8 passed: hard-lock/active-scope refusal and inactive-scope eligibility |
| `cargo test -p smartblocker-core -p smartblocker-nm-host -p smartblocker-daemon` | 255 passed across six suites, including mirror and focused daemon command cases |
| clippy + rustfmt | Clean for default members |
| `node scripts/focus-cycle-test.mjs` | 8 passed: exact-once reward, two cycles, identical retry, restart, stale-pending terminal recovery, async cancellation, malformed program state |
| `node scripts/e2e-allowance-test.mjs` | `ALLOWANCE FALLBACK E2E: ALL PASSED` with no daemon, real UI/storage/classifier and deterministic precedence |
| `node scripts/e2e-allowance-daemon-test.mjs` | `ALLOWANCE DAEMON E2E: ALL PASSED`: actual browser/native messaging/daemon transitions, release, refund, second client and restart recovery |
| Typecheck + Chrome/Firefox builds | Passed after the authority, blocker, scheduler and options changes |

These are real Linux Chromium/native-messaging/daemon checks, not Windows verification. Firefox and desktop frontend builds were also produced, but Firefox native-messaging runtime and a real Tauri shell were not exercised. Focus/Pomodoro scheduler unit tests use controlled clocks and authority mocks; the isolated daemon E2E exercises the underlying grant/reward permissions, not 25-minute wall-clock sessions.

## 5. Remaining review limits

- Item 12 remains blocked on real-Windows hardware evidence; no Linux/mock shortcut substitutes for it.
- Delayed source/README/ROADMAP updates should reflect only the tests actually rerun, not assumed native or mixed-platform guarantees.
- Later focused review findings should update this note with their concrete remediation/evidence rather than claiming anticipatory review closure.
- Idempotency receipts cover the last 64 acknowledged operations, not unlimited retry history. Very old commands are not guaranteed deduplication after receipt eviction.
