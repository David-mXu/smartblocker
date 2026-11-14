# Serializing extension storage read-modify-write cycles, and why a cache must commit after the write

Task: fix three low-severity storage-layer defects in SmartBlocker's small
local stores — unserialized `read-modify-write` (RMW) races, caches committed
to memory before the persisted write, and unbounded feedback text fields that
could wedge the opt-in uploader into an infinite retry loop.

Files: `src/shared/feedback.ts`, `src/shared/overrides.ts`,
`src/background/override-tokens.ts`, `src/background/feedback-uploader.ts`.

## The problems

**1. Last-write-wins races.** `addFeedback` (and `addOverride`, and the
override token mint/consume pair) all followed the same shape: `load()` from
cache/storage, mutate, `save()`. Two concurrent calls both `load()` the same
snapshot in the gap before either `save()`s, so the second save overwrites the
first — one append silently vanishes. For override tokens it is worse: two
concurrent `consumeOverrideToken(token)` calls both find the nonce in their
snapshots and both return `true`, resurrecting a one-time token once.

**2. Phantom caches.** `save()` did `cache = entries; await storage.set(...)`.
If `set()` rejects (quota exceeded, transient Firefox storage failures), the
context keeps serving state that never persisted — and a *failed* write fires
no `storage.onChanged` event, so the listener that normally invalidates the
cache never runs. Nothing rescues the phantom.

**3. Unbounded titles.** A page can set a multi-megabyte `document.title`.
`addFeedback` stored it verbatim into `storage.local` (and it would flow
unbounded into centroid embeddings via `buildClassifierText`). Separately, the
ingestion worker (Cloudflare) validates every string against caps — one
oversized legacy record makes the worker return HTTP 400 for the *whole
batch*, and `uploadPending` deliberately leaves failed batches unmarked for
retry, so the daily alarm re-sends the same doomed batch forever.

## Key concepts and the fixes

**In-context promise chain (the codebase's established pattern).** The repo
already has the right tool twice: `UsageStatsTracker.enqueue` and
`allowance-store.ts enqueueLocal`. The pattern is a module-level
`let queue: Promise = Promise.resolve()` plus:

```ts
function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const attempt = queue.then(work);
  queue = attempt.then(() => undefined, () => undefined); // swallow, never reject the chain
  return attempt;
}
```

Every RMW operation wraps its whole load→mutate→save body in the chain, so
same-context operations serialize at write granularity. The chain tail must
swallow errors (`() => undefined` in both positions) — a rejected predecessor
must not poison every later write. This fixes only *in-context* concurrency;
cross-context coherence still relies on the existing `storage.onChanged`
invalidation listeners, which I left untouched. Applied to `addFeedback`,
`clearFeedback`, `markUploaded`, new `markSkipped` (feedback.ts);
`addOverride` (overrides.ts); `mintOverrideToken` + `consumeOverrideToken`
(override-tokens.ts).

**Commit-after-write, invalidate-on-failure.** `save()` became:

```ts
try {
  await api.storage.local.set(...);
  cache = entries;      // commit only after durability
} catch (e) {
  cache = null;         // invalidate, do NOT revert to a snapshot
  throw e;
}
```

The failure-semantics decision (invalidate vs revert to the pre-read snapshot)
is the interesting part: storage stays the sole source of truth. A re-read is
correct whether the write didn't land at all or partially landed; a reverted
snapshot can be stale if another context wrote between our read and our failed
write. And the rethrow surfaces the dropped write to callers instead of
letting them believe the append succeeded. `override-tokens.ts` has no
in-memory cache at all (every operation reads storage), so this fix does not
apply there; its per-op fail-closed `try/catch` remains as-is.

**Caps at the boundary that has the invariant.** `addFeedback` now
length-caps `title` to 300 (the same classifier-input ceiling as
`overrides.ts MAX_TITLE_LEN`), `domain` to 253 (hostname maximum), and
`channel`/`context` to 500 (the worker's `MAX_TEXT`). Deliberately
length-capping *only* — no NFKC/zero-width normalization, unlike
`overrides.ts`: feedback records feed centroid examples verbatim through
`buildClassifierText`, and normalizing would rewrite the learning signal of
legitimate non-ASCII titles. Safety check before choosing the caps: they sit
above `build-input.ts MAX_CONTEXT` (200), and `buildClassifierText` only ever
reads the first 200 chars of context, so centroid inputs are unchanged —
only genuinely pathological titles (>300 chars) get truncated.

**Pre-check the wire contract, skip permanently once.** The uploader gained
`withinWorkerCaps()` — a faithful mirror of the worker's `validateRecord` — and
`uploadPending` now marks records outside the contract `skipped: true` (new
`markSkipped`) before sending, so a never-acceptable record retires instead of
poisoning every daily batch. Records still count for local on-device learning;
only the opt-in upload gives up on them.

## Verification and one instructive miss

All required suites green: `backup-test` 24/0, `notifications-test` 33/0,
`wildcards-test` 25/0, `feedback-worker` local tests ALL PASSED, `npm run
typecheck` clean. Two ad-hoc harnesses (mocked `chrome` global + Node type
stripping, the repo's own test technique) proved behavior, not just
compilation: concurrent `addFeedback`/`addOverride` both persist; a rejected
`set()` produces no phantom cache and the next append builds on durable
truth; a token consumed twice concurrently yields exactly one `true`.

The parity harness is where the instructive miss showed up: I first mirrored
the worker's modelLabel rule as "nonempty, ≤500" (its `isShortString`
helper). Extracting my real function with esbuild and diffing it against the
worker's actual `validateRecord` over 17 boundary fixtures flagged one
mismatch — the worker checks `modelLabel` with `typeof === 'string' || length
> MAX` and *accepts empty*. The mirror was corrected to exact parity. Tests
must run against the imported artifact, not a hand-copied function.

`usage-stats-test` read 29/1 on the final run — the one failure ("background
listeners dedupe real session status events", `activeMs 0 !== 20000`)
appeared only after parallel builders edited `src/shared/lock.ts` and
`src/shared/settings.ts`, both of which `usage-stats.ts` imports; my earlier
run was 30/0 and none of my files are in that import graph. Attributed to the
concurrent lock/settings work, not these fixes.

## Left for follow-up

The commit-before-write pattern also lives in `src/shared/settings.ts` (:334,
:350) and `src/shared/lock.ts` (:123, :619) — out of my scope this pass, same
one-line reorder plus invalidation applies. Legacy pre-cap feedback records
are intentionally left as stored; the uploader pre-check quarantines them.
