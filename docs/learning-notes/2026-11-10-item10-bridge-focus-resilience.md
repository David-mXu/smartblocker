# Item 10 bridge/focus resilience and the partner browser pin

## Problem and context

Item 10 (allowance / reward / sessions / Pomodoro) has two writers for the
same allowance authority: the desktop daemon when it is connected, and the
extension's durable fallback when it is not. A focused review of the first
implementation found interleavings where a command could report success
without the acknowledged state being durable, where an offline opening could be
erased by a later daemon lead, and where a focus rollback could corrupt the
next Pomodoro cycle. The item 14 partner review found a browser-side hole: a
raw `lockState` write could make settings editable while the daemon stayed
armed.

The fixes are in
[`allowance-bridge.ts`](../../src/background/allowance-bridge.ts),
[`allowance-store.ts`](../../src/shared/allowance-store.ts),
[`allowance-state.ts`](../../src/shared/allowance-state.ts),
[`focus-cycles.ts`](../../src/background/focus-cycles.ts), and
[`lock.ts`](../../src/shared/lock.ts).

## Concepts in plain language

- **Revision intent.** A command names the revision it expects. The applied
  result is persisted with a receipt `(operationId, fingerprint, revision)`,
  so a retry can be recognized without charging twice.
- **Receipt window.** Both peers keep only the newest 64 receipts. Once the
  window slides, an old receipt missing from the peer is *ambiguous*: it may
  have been evicted rather than never seen.
- **Reconciliation queue.** A single in-process queue serializes
  read/decide/write transactions, so two writers cannot both read revision R
  and land their writes out of order.
- **Authority epoch.** Each native-messaging connection gets a number.
  Replies from a retired connection are still useful evidence of what the
  daemon committed, but they must not overwrite a newer browser decision.
- **State generation.** A counter bumped whenever the focus program is
  replaced. A storage read that started before the bump must not install its
  stale value over the newer in-memory state.
- **Pin.** A daemon-confirmed partner arm stored outside the generic
  `lockState`, so a raw or stale lock-state write cannot change who is
  authorized.

## What changed, and the evidence

### 1. A full receipt window no longer looks like divergence

The old divergence check compared every local receipt with the peer's
retained receipts. At 64+ revisions, local receipts 7/8 were absent from a
daemon window of 9..72, so an unchanged rev-70 snapshot was promoted over a
legitimate rev-72 daemon lead and bootstrapped back at rev 73. Rewards 71 and
72 disappeared.

`allowanceStateHasLocalOnlyReceipts` now ignores local receipts older than
the peer's oldest retained receipt. When the peer kept none, the bound comes
from its revision. A same-revision fingerprint mismatch still counts as
divergence. `MAX_ALLOWANCE_RECEIPTS` is exported and used for the cap,
validation, and the window bound.

Test: `a receipt evicted from the peer window is not local-only history`
constructs 70 vs 72 revisions; `a full receipt window does not promote an
unchanged daemon lead` exercises the bridge path and asserts no bootstrap was
sent.

### 2. One durable writer for mirrors and fallback commands

Bridge mirrors previously called `writeLocalAllowanceAuthority` directly,
bypassing the fallback command queue. A mirror could read rev 1, a fallback
command could commit rev 2, and the mirror's older rev-1 write could land
last. The command reported success while storage held the older state.

`allowance-store.ts` now exposes `enqueueLocal`, and
`reconcileLocalAllowanceSnapshot` performs the read/decide/write as one queued
transaction. `submitLocalAllowanceCommand` and conflict promotion use the
same queue. The bridge uses reconciliation for both normal observations and
`pendingMirror` recovery.

Tests: `a mirror write cannot land after a fallback command` gates the raw
storage write and delivers a stale daemon sync while the fallback opening
owns the next revision; the opening survives. The store suite adds promotion
ordering, stale-request, and write-failure cases.

### 3. A committed snapshot is mirrored even after its epoch retires

A daemon `allowanceCommandResult` could commit a reward, then be processed
after the connection epoch changed. The old code rejected the completion and
dropped the snapshot. A later fallback command extended the pre-reward
revision; on reconnect the equal-revision promotion let the daemon adopt the
fallback snapshot, erasing the reward.

`observe` now mirrors a retired/fallback snapshot before resolving or
rejecting. A write failure latches `pendingMirror`, which `flushMirror`
retries before fallback. The queued reconcile takes a `stillCurrent` check
and returns `retired` without writing if the epoch changed before the
transaction ran.

Test: `a daemon-acked snapshot on a retired epoch is still mirrored` commits a
reward on epoch N, delivers the result under epoch N+1, then goes offline and
asserts the fallback command built on the mirrored revision and the reward
survived.

### 4. Focus and Pomodoro ownership

Three races were fixed:

- `stateGeneration` stops a storage read that began before a new start from
  assigning its stale program over the new one.
- `storeQueue` serializes persistence so a slow clear cannot land after a
  newer replacement.
- `owns(epoch, id)` guards every post-await advancement. A rollback result
  settling after a cancel or newer start can no longer advance that newer
  session.

A Pomodoro work reward that returns `clock-rollback` advances to the next
work cycle. The old tick still called `startBreak` with its older `now`,
computed a break longer than `breakDurationMs`, and failed validation on
every retry, silently skipping the break. `runTick` now detects that the
program already advanced and arms for the new work end instead.

The recovery `arm` inside `tick()`'s catch is itself guarded; a second
rejection would otherwise be unhandled because callers fire and forget.

Tests: 14 focus-cycle cases, including the stale read, both post-rollback
ownership cases, the Pomodoro rollback/break recovery, and the alarm-failure
cleanup.

### 5. Browser-side partner authority pin

The daemon pins its partner fields against generic `lockStateSync` merges,
but the extension merged the browser copy with ordinary LWW. A raw
`{partnerArmGeneration: null, partnerArmUpdatedAt: future}` write beat the
daemon's arm locally, so `getLockStatus` reported unlocked and settings could
be edited while the daemon remained armed and its file unchanged.

`lock.ts` now stores the daemon-confirmed arm in `partnerArmState`.
`getLockState` overlays that pin, and `mergeRemoteLockState` treats daemon
partner fields as authoritative, repairs a forged raw field, and updates the
pin atomically with the lock state. A partner-bearing frame older than the
current stamp is ignored, so a stale release cannot regress a newer arm;
daemon merges are serialized so two frames cannot interleave their writes.
An absent pin still falls back to the raw armed `lockState`; on upgrade, the
first read of an armed raw state seeds the pin so a later raw clear cannot
release it before the daemon connects.

Tests: `scripts/partner-pin-test.mjs` covers cold-read pin creation,
upgrade seeding, raw clear, raw arm swap, a stale release frame, and a real
daemon release. The test invalidates the cache as a storage event would, so
deleting the overlay fails the cold-read assertions. The partner E2E now
reloads the options page after the raw clear and asserts `#break-mode` stays
disabled.

### 6. Replay tombstones

`prune` retained every unexpired tombstone and then applied a 256-entry cap,
evicting live records. It now retains every unexpired tombstone and drops
only expired ones. Replay checks still compare the signed expiry, so wall-only
pruning is safe; the cap was the unsafe part because `begin_operation_at`
accepts a caller-chosen operation id.

Test: 300 live tombstones survive an observation; all are pruned once their
signed expiry passes.

## Alternatives and tradeoffs

- **Receipt-window ambiguity.** A genuine local-only receipt that has fallen
  out of *both* retained windows is still indistinguishable from an evicted
  one. The chosen rule is conservative for daemon leads: accept the daemon
  snapshot rather than risk erasing its newest commands. The acceptance test
  covers the window boundary; the residual case is documented rather than
  claimed solved.
- **Shared queue vs. compare-and-swap.** The queue is process-local and
  simple. It does not protect against two extension contexts writing storage
  concurrently; the service worker is the single background writer, and the
  fallback path is reached through it.
- **Separate pin vs. daemon echo.** The daemon redacts partner fields for
  unauthenticated frames, so a local pin avoids a sync loop and keeps the
  settings guard working through a raw generic merge. A same-user DevTools
  adversary can edit both storage keys; this pin is an accidental/stale-write
  guard, not the hard enforcement boundary (the daemon still blocks apps).
- **Unbounded unexpired tombstones.** The state grows by one small record per
  released arm and is pruned on expiry. That is preferable to evicting a live
  tombstone and making replay depend on a retired pending operation.
- **Lock-state writes are not transactional.** Daemon merges are serialized
  with each other, but a popup/options `writeLockState` is a separate
  read-modify-write. A write that overlaps a merge can still lose one side's
  change; the pin makes partner authority fail-closed, not every lock field
  atomic across contexts.

## Verification (observed on the final clean tree)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| 12 focused suites | 133 passed, 0 failed (allowance math/state/store/bridge/boundary/relief/activity, focus cycles, category schedules/relief guard, partner protocol/pin) |
| Adjacent storage/lock/break suites | 283 passed, 0 failed (backup 18, profiles 17, lock-math 180, lock-types 24, preferences 6, breaks 14, reward accrual 16, app targets 8) |
| `cargo test -p smartblocker-core` | 320 passed |
| `cargo clippy -p smartblocker-core --all-targets -- -D warnings` | no issues |
| `e2e-partner-test.mjs` | 15 checks, `PARTNER E2E: ALL PASSED` |
| `e2e-allowance-daemon-test.mjs` | 9 checks, `ALLOWANCE DAEMON E2E: ALL PASSED` |
| `e2e-allowance-test.mjs` | 12 checks, `ALLOWANCE FALLBACK E2E: ALL PASSED` |

The E2Es build and run the real Chrome bundles plus the real Rust
`smartblocker-daemon`/`nm-host` on Linux Chromium. They do not exercise
Firefox native messaging, native Windows, or a real Tauri shell; those remain
outside this evidence.

## Remaining limits

- Partner restart edges are still documented P2s: a missing
  `partner-state.json` with an armed `lock-state.json` leaves the arm
  unreleasable, and a forward wall jump followed by a correction fails closed
  until wall catches up.
- Pre-mutex clock capture can produce a spurious, retryable `ClockRollback`.
- The partner E2E replay assertion is weaker than the Rust
  `replay_cannot_release_a_later_arm`; the durable replay proof is the Rust
  test.
- The concurrent session working in this tree swept the uncommitted changes
  into shared commits; this note records the content, not a separate commit.
