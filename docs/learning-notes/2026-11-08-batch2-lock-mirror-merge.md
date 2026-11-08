# Batch 2: merging three features around a two-language lock contract

**Date:** 2026-11-08 · **Scope:** Phase 5 items 5, 7 and 8; item 6 starts from
this merged base. **State:** merged and committed on main; implementation stayed
uncommitted throughout its review and verification.

## Problem and goal

Three isolated agents built breaks, typed-surrender overrides and the
extension-loss grace surface from the same base. The merge had to preserve all
three behaviors *and* the TypeScript↔Rust lock contract, while a separate
desktop stream had unrelated uncommitted Rust/UI work in main.

A **CRDT** (conflict-free replicated data type) lets two copies of lock state
merge deterministically. The important properties are commutativity (A then B
equals B then A) and idempotence (merging the same state twice changes nothing).
Safety also requires anti-resurrection: an expired break or authorized release
must not reappear when an old peer reconnects.

## Implementation and investigation order

1. **Read the diffs before applying them.** This identified the hotspots:
   `settings.ts` and `blocker.ts` (breaks × surrender), `PopupApp.tsx`
   (breaks × grace), `design-notes.md` (all three), `ROADMAP.md`/`CLAUDE.md`
   (pre-existing documentation edits), and the other stream's `store.rs`.
2. **Applied surrender first**, including its new pure module and tests.
3. **Applied grace second.** The pass rejected `CLAUDE.md` and `ROADMAP.md`
   because their index contents differed. Although the log said other files
   applied cleanly, a content grep showed the grace imports and components were
   absent. The base-matched runtime files were therefore copied directly from
   their worktree, while the two documentation changes were hand-ported. This is
   why patch success logs are not verification.
4. **Applied the breaks patch with the five known hotspots excluded.** This
   kept the schema, fixtures, background integration and options changes in one
   coherent operation. New modules/tests were copied separately.
5. **Wove the hotspots explicitly.** Break settings and normalization were
   added beside (not instead of) `surrenderMode`; both `BreakControl` and
   `ExtensionGraceNotice` were retained in the popup. A fresh single-file patch
   cleanly unified the break classifier checks with surrender injection
   parameters. Single-file patches also unified all three design-contract
   additions. In `store.rs`, only the test literal's
   `..LockState::default()` compatibility line was ported; the separate
   stream's logic stayed untouched.
6. **Audited by content and behavior.** Checks found no conflict markers, all
   Batch 1 settings remained present, every new module existed, and the merged
   `blocker.ts` contained both surrender plumbing and all three break relaxation
   points. An intermediate focused run exposed the expected missing break
   settings before their hand-port; after completing the weave it was 14/14.

## Resulting semantics

- A break is a separate timestamped operation, never a mutation of timer,
  password, frozen or schedule lock sources. During an active break only real
  classifier verdicts relax; explicit URL/title/channel/adult rules,
  classifier-unavailable fail-closed results, frozen/scheduled force blocking,
  and daemon enforcement stay hard.
- Typed surrender is opt-in and affects only the existing non-locked block-screen
  override path. Its one-time SW-minted nonce and message shape are unchanged.
  The pre-existing transient Dismiss behavior was deliberately left for a
  Batch 3 product decision, as the user approved.
- Grace is a truthful locked-session disconnect warning, not an invented
  numeric timer. Protocol v2 has no heartbeat acknowledgement or enforcing-peer
  remaining-grace field. A future daemon-coordinated round can expose that
  observation; outgoing heartbeat sends cannot substitute for it.

For feature-level design details see
[`2026-11-08-breaks-v1.md`](2026-11-08-breaks-v1.md),
[`2026-11-08-typed-surrender.md`](2026-11-08-typed-surrender.md), and
[`2026-11-08-extension-loss-grace-countdown.md`](2026-11-08-extension-loss-grace-countdown.md).

## Verification on the initial merged Batch 2 tree

These were the results at the item 5/7/8 merge checkpoint. Item 6 and the
post-audit IPC authorization fix added later coverage; the current aggregate is
recorded in [`ROADMAP.md`](../../ROADMAP.md).

| Check | Observed result |
|---|---|
| `node scripts/breaks-test.mjs` | **14 passed, 0 failed** |
| `node scripts/lock-math-test.mjs` | **97 passed, 0 failed** |
| `node scripts/surrender-test.mjs` | **12 passed, 0 failed** |
| `node scripts/grace-math-test.mjs` | **21 passed, 0 failed** |
| `node scripts/rules-test.mjs` | **54 passed** |
| `node scripts/rta-test.mjs` | **17 passed** |
| `node scripts/resume-test.mjs` | **24 passed** |
| `npm run typecheck` | Clean |
| `npm run build` | Chrome and Firefox targets built |
| `cd companion && cargo test` | **153 passed across 6 suites** (includes the other stream's tests) |
| `cargo clippy --all-targets -- -D warnings` | No issues |
| `cargo fmt --all -- --check` | Passed |
| `npm run eval` | **PASS: no regressions**; all five metrics `=`, no per-case changes across 15,874 cases |
| `node scripts/e2e-test.mjs` | **E2E: ALL PASSED** in real Chromium |
| `git diff --check` | Passed |

No commit, push, reset or rebase was performed.

## Tradeoffs and follow-up

- Existing force-redirect tabs are not retroactively released at break start:
  persisted redirect metadata cannot safely distinguish classifier redirects
  from deterministic/fail-closed ones after a worker restart. Later eligible
  classifications relax.
- Break clocks are wall-clock derivations; clock changes can affect break timing
  but never shorten an underlying lock. Mixed-version peers fail closed rather
  than synchronizing relaxation.
- Item 8's numeric countdown remains intentionally unshipped until daemon
  status carries authoritative grace state.
- Item 6 was launched in a separate worktree seeded with all 34 merged Batch 2
  paths. Seeding matters because an uncommitted main-tree merge otherwise would
  not exist in a fresh worktree based only on HEAD; the new agent therefore sees
  the actual break-aware schema rather than accidentally recreating it.

## Post-merge IPC authorization follow-up

The shared TypeScript/Rust fixtures established merge parity, but they did not
model connection authentication. A final source audit found that the daemon was
still pinning only password/schedule fields for unauthenticated peers, leaving
break, delay and random-text operations exposed to the ordinary LWW merge. This
was an integration gap in `daemon.rs`, not a disagreement between the mirrors.

The coordinated fix pins exactly those nine omitted operation fields inside the
existing unauthenticated guard. Anonymous timer/Frozen extension and authorized
releases are unchanged. The new arm/change/clear regressions failed before the
pin and pass afterward, alongside an authenticated-release control. Full
investigation and combined-tree results are in
[`2026-11-08-companion-operation-auth-pinning.md`](2026-11-08-companion-operation-auth-pinning.md).
No classifier behavior or dataset changed.
