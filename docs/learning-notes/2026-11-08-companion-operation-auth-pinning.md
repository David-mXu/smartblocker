# Companion operation authorization: pin every ordered field

**Date:** 2026-11-08 · **Scope:** Phase 5 Batch 2 post-merge security follow-up ·
**State:** fixed and committed on main; no remote push was requested.

## Problem

Batch 2 added breaks and two explicit-release lock gates. Their TypeScript/Rust
merge fixtures passed, but the complete companion call path had not been checked
against the connection's authentication state.

Before the fix, the daemon's unauthenticated guard pinned only password and
schedule fields. It omitted nine newer fields:

| Operation | Fields omitted from pinning |
|---|---|
| Break | `break_started_at`, `break_not_before`, `break_ends_at`, `break_updated_at` |
| Delay release | `delay_until`, `delay_duration_ms`, `delay_updated_at` |
| Random-text release | `random_text_len`, `random_text_updated_at` |

These operations use **last-writer-wins (LWW)** ordering: the candidate with the
newer operation stamp wins. A stamp clamped to the current time is not trusted;
it can still outrank an older honest operation. Sanitization therefore cannot
substitute for authorization.

## Root cause and trust boundary

The schema and mirror merge grew, but the daemon's separate field-level guard was
not extended. This explains why 124 JS lock-math checks and their Rust fixtures
could stay green: they test whether two implementations select the same winner,
not whether a particular peer may propose that candidate.

The source path was:

1. `serve_connection()` accepted a well-formed `lockStateSync` and looked up the
   connection's `authed` flag (`daemon.rs:1054–1062` before this patch).
2. `merge_in()` forwarded that flag to `merge_from()`.
3. `merge_from()` pinned only the older password/schedule fields before calling
   `merge_lock_states()`.
4. `merge.rs` selected break, delay and random-text winners independently.

A successful anonymous release could alter persisted state and, when no other
lock source remains, change derived `settings_locked`. An injected break can
relax classifier verdicts; deterministic/fail-closed rules and desktop app
enforcement do not become break-aware. This is not a claim of remote-network
access or universal lock removal.

The reachable threat is the documented local IPC boundary: unauthenticated local
clients/scripts can connect, with same-uid peer enforcement on Linux. Reading
pairing tokens is not required for the anonymous path. I did **not** run an
end-to-end socket exploit. The new unit tests do demonstrate unauthorized state
mutation directly through the daemon's actual merge entry point.

## Investigation and implementation

1. **Audited the complete caller rather than stopping at the merge mirror.** The
   pre-existing test `unauthenticated_merge_cannot_touch_the_password` covered
   password and schedules. Its existing Frozen-extension assertion now has a
   matching Timer assertion, but no daemon test covered the new operation
   families.
2. **Added regression cases before fixing production behavior.** A shared test
   builder constructs one active break, a waiting delay gate and a random-text
   gate. Separate tests attempt anonymous arm, change and release operations. An
   authenticated-release case is the control.
3. **Ran the tests against the vulnerable guard.** The three anonymous cases all
   failed: arm populated the empty daemon state, change replaced every original
   operation, and clear produced release tombstones. The existing password case
   passed. Exit was 101 (`3 failed; 1 passed`), so these cases demonstrably detect
   the original defect rather than merely restating the fix.
4. **Applied one narrowly scoped production change.** Under the existing
   `if !authed` block, assign all nine fields from `current` to `sanitized` before
   merging. This collapses anonymous operation proposals to the daemon's state.
   Timestamp sanitization, CRDT winner rules, persistence and broadcast logic are
   untouched.
5. **Kept both intentional behaviors.** The authenticated control applies its
   release unchanged. Existing tests still allow unauthenticated Timer/Frozen
   extension because those fields merge by a monotonic maximum and can only
   stricten the lock. `merge_local()` also remains unauthenticated, so the local
   focus-session commit cannot overwrite ordered operations.

## Alternatives and tradeoffs

- **Reject every anonymous `lockStateSync`.** Rejected because legitimate
  unauthenticated clients may extend Timer/Frozen locks. The field pin retains
  that strictening-only operation without accepting weakening LWW writes.
- **Rely on timestamp bounds.** Insufficient: bounds stop an effectively eternal
  forged stamp, not a fresh unauthorized write.
- **Change merge winner behavior by peer type.** More complex and risky. Pinning
  before one canonical merge preserves commutativity for authenticated peers and
  avoids a second flavor of replication logic.
- **Leave this as a documented limitation.** Would contradict the companion's
  claim that unauthenticated UIs cannot touch locked fields. Closing the central
  guard also protects future callers of `merge_from()` more reliably than a
  socket-arm special case.

The fix intentionally does not alter the documented residual for a same-uid
attacker who reads both pairing-token stores, and it does not authenticate raw
browser-storage writes. Those are different threat boundaries.

## Verification

| Command/check | Observed result |
|---|---|
| Pre-fix `cargo test -p smartblocker-core unauthenticated_merge_cannot_` | **3 expected failures, 1 existing pass**; assertions captured each arm/change/clear mutation |
| Post-fix same command | **4 focused tests passed** |
| `cargo test -p smartblocker-core authenticated_merge_can_release_break_and_explicit_release_gates` | **1 control passed** |
| Full `cd companion && cargo test` | **161 passed across 6 suites** |
| Existing anonymous-extension regression | Now explicitly asserts both Timer and Frozen extension |
| Independent read-only source review | All ordered fields covered; sole peer handler guarded; no bypass found |
| `cargo clippy --all-targets -- -D warnings` | No issues |
| `cargo fmt --all -- --check` | Passed |
| Lock types / lock math / breaks | **21 / 124 / 14 passed** |
| Surrender / grace / rules / adult / resume | **12 / 21 / 54 / 17 / 24 passed** |
| `npm run typecheck` | Clean |
| `npm run build` | Chrome and Firefox targets built successfully |
| `npm run eval` | **PASS: no regressions**, all five metrics `=`, no per-case changes across **15,874** cases |
| `node scripts/e2e-test.mjs` | **E2E: ALL PASSED** in real Chromium |
| `git diff --check` | Passed; no dataset/baseline/seed changes or prohibited companion-file edits |

The pre-fix run is a Rust unit-level reproduction through `Shared::merge_in`, not
a claim that a standalone local process was launched against a live daemon. No
Cold Turkey files or private data were accessed. During implementation and
verification, no eval dataset/baseline/model changes, commit, push, reset or
rebase were made. The main-branch commit was separately authorized afterward.

Related reconciliation: [`ROADMAP.md`](../../ROADMAP.md),
[`2026-11-08-delay-and-random-text-locks.md`](2026-11-08-delay-and-random-text-locks.md),
[`2026-11-08-breaks-v1.md`](2026-11-08-breaks-v1.md), and
[`2026-11-08-batch2-lock-mirror-merge.md`](2026-11-08-batch2-lock-mirror-merge.md).
