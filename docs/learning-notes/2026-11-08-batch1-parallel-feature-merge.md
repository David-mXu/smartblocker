# Batch 1: building four features with parallel agents and union-merging them

**Date:** 2026-11-08 · **Scope:** Phase 5 Batch 1 (title rules, YouTube channel
rules, RTA adult signal, autostart-resume) · Federation of 4 worktree agents.

## The original goal

Turn the Cold Turkey parity audit (`docs/audits/2026-11-07-*.md`) into code:
four deterministic, lock-schema-free features, shipped in parallel without
colliding. Each feature had to be provably **inert at default settings** so
the shared 15,874-case eval baseline could not shift.

## The approach and why

- **One git worktree per feature** (F1 channels / F2 titles / F3 RTA / F4
  resume) so four agents could edit `settings.ts`, `blocker.ts`, and the eval
  harness "simultaneously" without interleaving failures.
- **New logic in new pure `shared/` modules** — no browser APIs,
  erasable-syntax-only, so Node type-stripping imports them directly for unit
  tests and the offline ladder mirror (`scripts/lib/eval-harness.mjs`).
- **Per-feature learning notes** live with the features:
  `2026-11-07-title-rules.md`, `2026-11-07-youtube-channel-rules.md`,
  `2026-11-07-rta-adult-blocking.md`, `2026-11-07-autostart-resume.md`.

## What the merge actually involved (the interesting part)

All four diffs share one base commit and every conflict was additive — but
`git apply --3way` had two failure modes worth remembering:

1. **Unmerged-index cascade.** When a file enters conflicted (`UU`) state,
   later patches for that file fail with `does not exist in index` and their
   hunks are **silently dropped from that application pass**. Nothing warns
   at the end. The fix used here: resolve conflicts first, `git restore
   --staged .` (unstages, never touches the working tree), then re-apply —
   but `--3way` next refuses with `does not match index` once the working
   file differs from HEAD, so the dropped hunks were **hand-ported from the
   worktree files** instead. Stop trusting tool output ("Applied … cleanly")
   once a pass exits non-zero: **verify by content grep**, not by the log.
2. **Add/add untracked files aren't in `git diff`.** Three agents each
   created `src/shared/rules.ts`; two created `scripts/rules-test.mjs`. Those
   were unioned by hand into one module and one 54-test file.

Three concrete scope traps the hand-port caught that a lazy merge would miss:
the same anchor string (`let classifyFailedClosed`) exists in both `onTitle`
and `onSubFrame` — the declaration initially landed in the sub-frame function;
`focusContext`/`applyUrlSignals` appear twice too (channel rules belong only
in the main-frame `onTitle`, per spec); and `recordTabStatus` needed a
unified `matchedRule` (blocklist → title rule → `channel @<handle>`) rather
than either agent's local version.

## Decision: precedence in the merged ladder

Features touched the same deterministic branches, so label precedence had to
be a policy choice, not an accident:

```
whitelist → URL/title blocklist → title rules → adult host (.xxx)
  → adult meta (after DOM gather) → channelBlocklist
  → classifier → channelAllowlist rescue → overrides
```

Explicit user rules (blocklist/title/channel) **outrank the generic adult
signal** for the reason label — user intent beats a heuristic. The channel
allowlist rescues *only* classifier verdicts; F2's title rules punch through
the YouTube-browse exemption exactly like blocklist entries. The hatch for
blockAdult switched tabs open immediately via `SETTINGS_SWEEP_KEYS` (the
title cache memoizes inference, not decisions, so no cache-key changes needed).

## Verification (exact commands, all observed on 2026-11-08)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (after hand-porting `settings.ts` keys + `allowImportingTsExtensions`) |
| `npm run build` | both targets built |
| `node scripts/rules-test.mjs` | **54 passed** (20 title + 34 channel) |
| `node scripts/rta-test.mjs` | **17 passed** |
| `node scripts/resume-test.mjs` | **24 passed** |
| `node scripts/lock-math-test.mjs` | **77 passed** — lock invariants untouched |
| `npm run eval` | **PASS: no regressions**; all 5 metrics `=` baseline; no per-case changes; dataset/baseline unmodified |
| `node scripts/e2e-test.mjs` | **E2E: ALL PASSED** (warm model cache, real Chromium) |

## Tradeoffs deliberately accepted (agent-flagged, reviewed and endorsed)

- Channel rules key off the scraped **display name**, not the canonical
  `@handle` href; sub-frames/SERP cards/history scan are not covered by the
  new rule lists (page-ladder scope of Batch 1); popup reuses generic
  "blocked"/"allowed" wording with rule labels, no new status kinds.
- **F4's 'startup' semantics**: resume fires on browser cold-start only
  (detected by a `storage.session` boot marker) — not on every SW wake, since
  navigations would otherwise resume blocking within minutes. Spec deviation
  the user explicitly endorsed.
- The `"notifications"` permission was added to both manifests **at the user's
  approval** — before that, the resume toast was a guarded no-op. Local-only
  and disclosed in `PRIVACY.md`; `npm ci --onnxruntime-node-install-cuda=skip`
  documented in README for CUDA-13 hosts.

## Left for Batch 2

Breaks + delay/random-text locks + surrender wall + grace countdown — these
change `lock.ts`/`lock-math.ts`, which are **mirrored in Rust** (`merge.rs`)
with shared fixtures; the two sides must move in one coordinated phase.
Tree left **uncommitted** for the user's review.
