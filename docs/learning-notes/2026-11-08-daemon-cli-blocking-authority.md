# Daemon CLI and cross-browser ordinary-blocking authority

**Date:** 2026-11-08  
**Scope:** Phase 5 item 13's daemon socket CLI and ordinary-blocking sync. The
previously completed extension wildcard grammar is retained. The implementation
is uncommitted; unrelated worktree changes and both eval datasets were left
unchanged.

## 1. Problem and goal

Roadmap item 13 asks for `block start|stop|toggle` and `lock MINUTES` through
the companion daemon socket. A CLI boolean write is not enough for this feature:
ordinary web blocking already lives in each browser profile's `settings.enabled`.
If two browsers and a CLI can write independently, delayed writes can silently
undo a newer choice, and applying a daemon message back into extension storage
can look like another user command.

The required contract is:

- ordinary blocking is separate from timer/Frozen/schedule/password and other
  lock state;
- `block start|stop|toggle` controls ordinary blocking across connected
  browsers and persists it;
- `lock MINUTES` also enables ordinary blocking, then starts or extends a timer
  but never shortens it;
- every disable or toggle-off is refused while **any** lock is active, while an
  enable/start remains legal;
- browser changes are authenticated, ordered across browsers, and survive a
  daemon reconnect without command echo loops;
- successful CLI acknowledgement means the requested state was persisted;
  refusal and persistence failure are reported truthfully.

## 2. Concepts and design

**Daemon-owned authority vs. local intent.** Connected browsers no longer treat
ordinary `enabled` changes as unrelated local truth. The daemon sends an
authoritative `{ enabled, revision }`; an extension sends a new local preference
as `blockingStateUpdate { enabled, baseRevision }`. `baseRevision` is an
optimistic-concurrency token: it names the state on which the browser based its
intent. A different current revision means another browser or the CLI decided
in the meantime, so the stale write cannot overwrite it. The daemon returns its
current authority instead.

`blocking-state.json` stores the value and revision separately from
`config.json`, so pairing/config healing cannot roll it back. A missing,
corrupt, or older-daemon state is `None`/uninitialized, not a vote to disable.
An authenticated browser can initialize it explicitly with either `true` or
`false` at base revision zero.

**Soft blocking vs. timer locks.** `BlockingState` and the existing `LockState`
remain independent. The new protocol messages are additive **protocol v2**
messages, not a v3 fork. `LockCommand` clamps neither the existing deadline
down nor the requested duration above the established lock maximum. It takes
`max(existingTimerUntil, now + requestedDuration)`.

The extension's centralized settings guard still rejects every ordinary
mutation while locked, with one deliberate exception: exactly
`setSettings({ enabled: true })`. That exception lets daemon/CLI healing enable
blocking under a lock without opening a disable or arbitrary-settings side
channel.

## 3. Implementation steps

### Step 1 — Add the durable state and additive wire messages

[`protocol.rs`](../../companion/crates/smartblocker-core/src/protocol.rs) and
[`companion-protocol.ts`](../../src/shared/companion-protocol.ts) mirror
`BlockingState`, browser updates, daemon syncs, CLI block/lock commands, and
`CommandResult`. Existing `CompanionStatus` carries optional `blocking`, so
older peers remain valid. Relay-unavailable statuses explicitly have no
ordinary-blocking authority.

[`store.rs`](../../companion/crates/smartblocker-core/src/store.rs) loads and
atomically rewrites the optional state file. A storage test proves round-trip,
reopen, corrupt-file, and config-independence behavior.

### Step 2 — Apply ordered state transitions in the daemon

[`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs) owns all
state changes. Browser updates require the connection's existing paired/auth
status; unauthenticated mutation attempts receive an error and cannot change
or broadcast state. Mutations use the established lock-state → blocking lock
order. Actual value changes increment the revision, persist first, update
memory, broadcast to other clients, and answer the sender. Repeating the
current value produces no new revision or broadcast.

The local CLI uses the same same-user IPC admission as the existing supervisor
probe but a separate command path from paired browser intents. `block stop`
and a toggle whose requested result is off derive the current lock status at
the command boundary and refuse if any lock source is active.

`lock` persists ordinary enabled state and the monotonic timer before its
success acknowledgement. These are two files, not a fictitious atomic database
transaction. The implementation writes the timer first, restores it on a
blocking-file write failure where possible, leaves in-memory state unchanged,
and reports any rollback failure explicitly. Focused tests use a directory at
the destination filename to induce a real rename failure without depending on
Unix permission bits.

### Step 3 — Wire real extension intents and authority application

[`companion-blocking.ts`](../../src/shared/companion-blocking.ts) contains pure
validation, revision acceptance, base-revision, semantic-authority comparison,
and outgoing-intent decisions. Same-revision states with contradictory values
are not accepted; duplicate delivery of the exact same authority is safe and
must not cancel a pending read of a user's latest local value.

[`companion.ts`](../../src/background/companion.ts) observes daemon status and
sync messages, merges their lock state first, and then applies ordinary
blocking. Genuine local differences use the latest storage value, not a
possibly queued event snapshot. Disconnect/degraded status clears connection
authority; the next real daemon status re-establishes persisted state or allows
one fresh-daemon initialization only when the blocking field is actually
absent. A real status waiting on its asynchronous lock merge is not mistaken
for an uninitialized daemon.

The daemon CLI in [`smartblocker-daemon/src/main.rs`](../../companion/crates/smartblocker-daemon/src/main.rs)
parses one positive whole-minute operand, waits for a real `CommandResult`, and
exits nonzero for refusal, transport error, invalid arguments, or persistence
failure. `status` reports the persisted enabled value and revision beside the
existing lock status. Usage and semantics are documented in
[`companion/README.md`](../../companion/README.md).

### Step 4 — Bind async work to its connection and exact write receipt

Focused re-review found two races that value comparisons did not solve. First,
an old lock merge or settings continuation could complete after a reconnect and
outrank the restarted daemon. Every authority operation now captures both its
port and a monotonically increasing connection epoch. Queued authority writes
are serialized, and continuations validate that identity after asynchronous
boundaries; retired-port callbacks are ignored.

Second, a single value-only echo marker confused overlapping writes with user
choices. [`settings.ts`](../../src/shared/settings.ts) now persists a unique
`companionBlockingApplyEcho` receipt in the **same** storage transaction as the
daemon-applied settings value. The bridge recognizes and consumes that exact
receipt, including when delivery crosses a reconnect or the boolean itself did
not change. Untagged writes remain local intent. The last completed
companion-written boolean distinguishes an older daemon value still visible in
storage from an actual newer user choice; it is not used as an echo marker.

Rejected-write recovery also revalidates the epoch, current authority, and
absence of a newer pending choice **after** its storage read. Deferred tests
cover old status and writes crossing reconnect, overlapping authority writes,
matching and opposing user writes during an application, and rejected-write
recovery crossing both a newer choice and a new connection. This illustrates
the general rule: checking an invariant before `await` does not prove it still
holds when the continuation runs.

## 4. Alternatives and tradeoffs

- **A bare daemon boolean with last-writer-wins:** smaller, but a delayed
  browser write could undo a newer CLI/browser decision. Revisions make that
  race observable and reject only stale-base writes.
- **A value-only echo marker:** rejected after review. Boolean equality cannot
  identify which overlapping asynchronous operation produced a storage event;
  unique receipts survive those orderings without reclassifying user writes.
  Bounding receipts by consuming each delivered ID avoids per-session growth.
- **Reusing `config.json`:** rejected because pairing and config self-healing
  have different ownership and persistence rules. A dedicated file minimizes
  interference with existing behavior.
- **Putting `enabled` into the lock CRDT:** rejected. Ordinary blocking is not a
  monotonic lock and must legitimately switch off while unlocked; lock fields
  follow different merge/monotonicity rules.
- **Forcing blocking on for every existing extension timer:** not introduced.
  Existing timer semantics remain independent. The explicit **CLI** `lock`
  command enables ordinary blocking as required.
- **Claiming two-file atomicity:** avoided. Writes are individually atomic and
  success awaits both; failure compensation is best effort and any rollback
  failure is reported. Crash windows between files remain a format-level
  tradeoff, not a proven atomic transaction.
- **Blocking all `setSettings` writes while locked:** retained except the exact
  enable-only patch. A broad `enabled`-containing exception would reopen other
  settings edits, so the key count and value are both checked.

## 5. Verification and evidence

Commands run against the implementation on Linux/WSL:

- `cargo test -p smartblocker-core -p smartblocker-nm-host -p smartblocker-daemon`
  — **196 passed across six suites**. Tests cover stale cross-browser bases,
  authenticated/unauthenticated updates, exact replies/broadcasts, durable
  revisions, no-op echo termination, every disable path under a timer,
  idempotent commands, enable-and-extend lock behavior, invalid durations,
  real persistence failures with no success acknowledgement, and daemon-side
  lock persistence serialization.
- `node scripts/companion-blocking-test.mjs` — **10 passed, 0 failed**, covering
  malformed/unbounded authority, revision ordering, fresh versus observed
  initialization, duplicate-delivery semantics, rapid intents in both
  directions, failed sends, and lock-error/newer-choice interactions.
- `node scripts/companion-background-test.mjs` — **10 passed, 0 failed** against
  the actual background module with deferred pairing, lock merges, daemon
  replies, settings writes, and recovery reads. These tests specifically force
  reconnect, overlapping-write, latest-user-choice, and stale-recovery
  interleavings rather than relying on immediate mock writes. The final narrow
  re-review returned no actionable findings.
- `node scripts/e2e-companion-test.mjs` — repeated runs ended
  with **`COMPANION E2E: ALL PASSED`** using a real Linux headless Chromium,
  actual built extension, native-messaging relay, daemon, and CLI binary. New
  checks exercised both toggle directions,
  extension-to-daemon persistence, no revision churn after the returned
  settings write, immediate post-ack file reads, CLI timer propagation and
  extension, stop/toggle refusal under lock, unchanged durable state after
  refusal, legal idempotent start, deliberate raw-storage disable healed back
  to enabled, truthful status, and exact value+revision restoration after a
  real daemon restart. Every pre-existing grace, app-enforcement, Frozen,
  watchdog, uninstall, redirect-blocking, and squatter check also passed.
  After the final source edits, the browser bundles were rebuilt before this
  evidence was collected, so `dist/chrome` contained the reviewed background.
  One rebuilt-browser run failed three checks in the rapid on→off/toggle-on
  sequence; the next two completely unchanged runs passed every check. That
  failure is recorded as non-reproduced, not as fixed or root-caused. Injected
  UI fixtures remain labeled as fixtures; the ordinary-blocking checks above
  are not injected.
- `node scripts/grace-math-test.mjs` — **24 passed, 0 failed**.
- `node scripts/lock-types-test.mjs` — **21 passed, 0 failed**.
- `node scripts/breaks-test.mjs` — **14 passed, 0 failed**.
- `node scripts/resume-test.mjs` — **24 passed, 0 failed**.
- `node scripts/lock-math-test.mjs` — **124 passed, 0 failed**, including the
  TS/Rust golden-fixture parity checks.
- `node scripts/wildcards-test.mjs` — **22 passed, 0 failed** for the other
  half of item 13.
- `npm run typecheck`, `npm run build`, and `npm run build:desktop` — passed;
  both Chrome and Firefox bundles plus the desktop frontend built.
- `cargo clippy -p smartblocker-core -p smartblocker-nm-host -p smartblocker-daemon --all-targets -- -D warnings`
  and `cargo fmt ... -- --check` — clean.
- Scoped `git diff --check` and `git diff --exit-code --
  scripts/eval-dataset.json scripts/eval-baseline.json` — clean; the datasets
  stayed byte-identical to `HEAD`.

These results establish the behavior on the tested Linux/WSL loop only. Native
Windows App Paths/registry execution, Windows service/Task-Manager behavior,
and a real Tauri shell were not exercised and are not claimed as verified.
