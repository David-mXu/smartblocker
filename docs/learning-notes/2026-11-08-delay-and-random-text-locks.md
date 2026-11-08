# Delay and random-text locks: explicit release without weakening other locks

**Date:** 2026-11-08 · **Scope:** Phase 5 Batch 2 item 6 · **State:** merged
and committed on main; the implementation and verification history follows.

## Goal

SmartBlocker already had timer, password, Frozen and scheduled locks. This item
adds two different unlock gates from the Cold Turkey audit:

- a **delay gate**, where the user deliberately starts a wait before release;
- a **random-text gate**, where only the background can verify a fresh proof.

The core constraint is that releasing one gate must never shorten or clear any
independent timer, password, Frozen, schedule or break operation.

## Recovery and investigation

The implementing agent twice returned `ECONNREFUSED`. Instead of restarting, I
compared its worktree with the 34-file seeded Batch 2 base. That showed a
substantial partial implementation, so the useful work was retained and treated
as unverified rather than discarded.

The actual review order was:

1. Reconstruct `delayUntil`/`delayDurationMs` and random-text state transitions
   in [`src/shared/lock.ts`](../../src/shared/lock.ts).
2. Check that background RPCs, not UI state, complete releases in
   [`src/background/lock-types.ts`](../../src/background/lock-types.ts).
3. Compare the TypeScript/Rust merge winner and sanitization rules, including
   Rust's compact serialization of release tombstones.
4. Run the recovered tests before changing behavior: 21 focused tests, 124
   lock-math tests, 14 break tests, clean typecheck and 119 Rust tests passed.
5. Audit the Locks page and supporting clock/alarm logic. I corrected two
   misleading copy strings: the old page claimed every lock could never be
   shortened, and password unlock omitted the new independent gates.
6. Add the test commands to `CLAUDE.md` and run the remaining full gates.

No agent connection error was treated as evidence that the code was either
complete or broken; the filesystem and tests supplied that evidence.

## Why delay is not another timer

A timer starts at `startTimerLock()` and disappears from derived status when its
end is reached. A delay gate is an indefinite lock until the user starts its
release wait:

```text
unarmed
  │ armDelayLock(duration)
  ▼
armed waiting                delayUntil = 0
  │ START_DELAY_UNLOCK
  ▼
counting down                delayUntil = now + persisted duration
  │ CANCEL_DELAY_UNLOCK              │ deadline reached
  └──────────────► armed waiting    ▼
                                ready but still locked
                                   │ background completion
                                   ▼
released tombstone             both delay fields null, fresh stamp
```

`delayDurationMs` persists alongside `delayUntil`, so a reload cannot silently
choose a shorter wait. Reaching the ready instant alone does not make
`deriveLockStatus()` unlocked. The lock enforcer checks wall time at alarms,
lock-state writes and service-worker startup, then calls the background release.
A late worker therefore completes an elapsed, explicitly-started release without
trusting an alarm callback or a timer in RAM.

Cancelling returns to armed waiting and gives the next attempt a fresh operation
stamp, so the cancelled deadline cannot release the restarted wait.

## Random-text proof boundary

`randomTextLen` is an independent indefinite gate (1–5,000 symbols). The
background mints a CSPRNG challenge, keeps its ID/text/arm stamp/expiry only in
worker memory, and expires it after 15 minutes. Verification consumes the
challenge **before its first await**. This detail makes concurrent copies of the
same proof single-winner: the second call already sees no challenge.

Every rejected attempt—including a typo, an old generation, expiry and a service
worker restart—performs zero lock-storage writes. A correct proof calls
`releaseRandomTextLock(expectedArmStamp)`, which re-reads state and clears only
that gate. Letter case and spacing are ignored; all other symbol changes fail.
Paste prevention is deliberately not an enforcement claim.

## Merge and anti-resurrection model

Each gate is one last-writer-wins operation with its own update stamp:

| Gate | New fields | Same-stamp fail-closed ordering |
|---|---|---|
| Delay | `delayUntil`, `delayDurationMs`, `delayUpdatedAt` | armed beats released; waiting/reset beats countdown; later deadline, then longer duration |
| Random text | `randomTextLen`, `randomTextUpdatedAt` | armed beats released; longer challenge wins |

A release is a tombstone, not simply missing data. A newer release therefore
beats an older armed peer; a later deliberate re-arm can replace a tombstone.
Stampless active legacy shapes survive an empty legacy peer. Malformed active
shapes sanitize away neutrally instead of becoming fabricated release
tombstones. Rust omits null `Option` fields, so TypeScript explicitly recognizes
a stamp-only gate object as a release and preserves its metadata.

The golden fixture runner checks expected output, commutativity and idempotence
for both implementations. Existing break/password/schedule winner rules were
left unchanged. A canonical JSON comparison in `mergeRemoteLockState()` also
prevents object-key insertion order from causing redundant extension↔companion
writes; schedule array order remains significant.

Forward clock compensation now extends active delay countdowns along with
active timer/Frozen deadlines. Waiting, released and already-elapsed gates are
not extended. Breaks, schedules and random-text metadata are untouched.

## Verification actually run

| Command/check | Observed result |
|---|---|
| `node scripts/lock-types-test.mjs` | **21 passed, 0 failed** |
| `node scripts/lock-math-test.mjs` | **124 passed, 0 failed** (97 previous + 27 new) |
| `node scripts/breaks-test.mjs` | **14 passed** |
| `node scripts/surrender-test.mjs` | **12 passed** |
| `node scripts/grace-math-test.mjs` | **21 passed** |
| `node scripts/rules-test.mjs` | **54 passed** |
| `node scripts/rta-test.mjs` | **17 passed** |
| `node scripts/resume-test.mjs` | **24 passed** |
| `npm run typecheck` | Clean |
| `npm run build` | Chrome and Firefox bundles built |
| `cd companion && cargo test` | **119 passed across 6 suites** |
| `cargo clippy --all-targets -- -D warnings` | No issues |
| `cargo fmt --all -- --check` | Passed |
| `npm run eval` | **PASS: no regressions**, 15,874 cases, all metrics `=`, no per-case changes |

No Playwright run was performed in the worktree. That gate belongs to the final
merged-main verification. No git commit, push, reset or rebase was performed.

## Post-merge integration audit

The shared mirror tests proved identical merge behavior but did not model who
was allowed to send a merge. A later daemon audit found that its unauthenticated
guard still pinned only the older password/schedule fields, leaving the new
release operations—and the earlier break operation—writable by an anonymous
local IPC peer. A narrowly scoped fix now pins all nine omitted fields. Three
new daemon tests failed before that fix and pass afterward; an authenticated
release control confirms that legitimate releases still propagate. This was a
unit-level reproduction, not a claimed end-to-end local exploit. See
[`2026-11-08-companion-operation-auth-pinning.md`](2026-11-08-companion-operation-auth-pinning.md)
for the investigation and final combined-tree verification.

## Residual tradeoffs

- Same-millisecond operations have no trusted causal order. Ties deliberately
  fail closed (an active gate wins), so a release made in the exact same stamp
  as its arm may require another merge/update to propagate. This matches the
  existing lock/break fail-safe policy; it is not a claim of causal time.
- Challenges live only in worker memory. A restart discards them and requires a
  fresh text; this is intentional, not persistence failure.
- Clock compensation is necessarily best-effort across a dead worker. Stored
  wall time remains authoritative and the companion remains the hard enforcement
  boundary; raw storage/devtools writes remain the documented soft-lock bypass.
- The daemon understands the new locked status but does not independently issue
  releases. It adopts the authenticated extension's valid release tombstone
  through the normal lock-state merge, preserving enforcement if the extension
  disappears while locked. Unauthenticated peers cannot contribute those release
  operations.
- Independent sources compose. Releasing delay or random text while a timer,
  password, Frozen session or schedule remains active does **not** unblock
  settings, and no classifier-relaxation behavior changes.
