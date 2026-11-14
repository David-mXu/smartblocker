# Hash-verified reuse in the centroid seed cache

## 1. The problem

SmartBlocker's embed backend classifies a page by comparing its embedding to
per-category **centroids** — the normalized mean of ~518 seed texts
(`src/shared/prototype-seeds.json`) plus the user's own corrections. Building
them means running every seed text through the model, so the vectors are
cached in `storage.local` (`centroidCache`) and rebuilt only when a version
string (model id + labels + seed/correction texts) changes.

Rebuilding all 518 embeddings is expensive, so `classifier.ts getCentroids`
had an **incremental path**: if a category's cached vector list was shorter
than its new text list, it assumed the cached vectors were a positional
PREFIX of the new texts and embedded only the tail.

That assumption was never checked — only the two lengths were. It held for
the common case (a user correction appended at the tail) and silently
failed for every other-shaped edit.

## 2. Root cause

Concretely: say a category's cached vectors were built from
`[description, seed1..seed11, correction1]` — 13 vectors — and an app update
added a 12th seed, giving `[description, seed1..seed12, correction1]` — 14
texts. The length check passed (13 < 14), so the code:

- reused all 13 cached vectors as a "prefix", including the vector at
  position 12 that was embedded from **correction1**, now attributed to
  **seed12**;
- embedded `texts[13]` — which is correction1 **again**;
- never embedded seed12 at all.

The result: a centroid with a phantom double-counted correction and a missing
seed, saved under a *correct-looking* version string. The `:mp1` suffix on the
version was the intended escape hatch ("bump it to force a rebuild"), but
nothing required anyone to bump it when seeds changed — a comment in
`config.ts` was the only reminder. A related hazard (a correction REMOVED
from the head of the `neutral: user approved` list) had been noticed and
patched — but only for that one centroid, by excluding it from the fast path.

The general concept: **positional reuse of derived data is only valid if you
can prove which input produced each cached slot.** Length equality is not
that proof — it's a coincidence statistic.

## 3. Investigation and fix

### Step 1 — confirm what proof is possible

The text each vector was embedded from is fully determined at build time, so
the cheapest possible proof is a **hash stored next to each vector**. djb2
over a short seed text costs microseconds; 518 of them per rebuild is
noise compared to a single model forward pass. No storage-format obstacle:
the cache is a plain `storage.local` object.

### Step 2 — where should the logic live?

`classifier.ts` imports `@huggingface/transformers` and the browser API
shim, so it cannot run under Node. The project's testing convention
(`scripts/rules-test.mjs`, `scripts/lock-math-test.mjs`, …) is to keep the
pure core in a `src/shared/*.ts` module that is "erasable-syntax-only"
(no enums, no namespaces — syntax Node's type-stripping loader can simply
delete) and import it directly from a `.mjs` test. So the new pure module is
`src/shared/prototype-cache.ts`, and `classifier.ts` now only supplies the
real `embed` function and the storage.

### Step 3 — the invariant, as code

`planSeedReuse(cached, texts)` returns one of:

- `{ kind: 'rebuild' }` — the cached entry has no hashes (pre-`mp2` format /
  corrupt / hash and vector arrays disagree in length), or **any** position
  `i` in the overlap has `hashes[i] !== hashSeedText(texts[i])`. Insert,
  remove, reorder, replace — heads and middles alike — all land here. A
  full rebuild of just that category is the only safe output.
- `{ kind: 'verified', reuseCount, toEmbed }` — every cached position below
  the overlap hash-matches, so the cached prefix is *proven* to correspond
  to `texts[0..reuseCount)`; only `texts.slice(reuseCount)` needs embedding.
  (A tail-only shrink — the user removed a correction — is also a verified
  prefix: reuse the truncated run, embed nothing.)

`buildSpecVectors(texts, cached, embed)` wraps that plan: rebuild path embeds
everything, verified path splices `cached[0..reuseCount)` + freshly embedded
tail, and — because a mid-list insert would otherwise shift which text a
reused vector "belongs to" invisibly — it **throws** if `embed` returns the
wrong vector count. A hard error is always better than a silently
misaligned centroid.

### Step 4 — cache format bump

The persisted cache gains `seedHashes: string[][]` (parallel to
`seedVectors`), and the version suffix moves `:mp1` → `:mp2` via a shared
`CENTROID_CACHE_FORMAT` constant used in BOTH `getCentroids()` and the
title-cache `modelKey` in `classify()`, so the two caches invalidate
together. Cost: one person's one-time ~2.5s cold rebuild on update. Old
hash-less caches would already self-degrade to a full rebuild without the
bump — the bump just makes the migration explicit and keeps the format
recorded on disk.

What a maintainer must know now: **the format bump is no longer load-bearing
for seed edits.** Adding, removing, reordering, or replacing seed texts is
safe with no bump — changed categories rebuild fully, unchanged ones reuse
their cached vectors for free (which is also cheaper than the old scheme,
where a `prototypesVersion` change re-embedded everything). The bump remains
necessary when the persisted cache *shape* changes or when a model
REVISION changes out from under an unchanged model id (see the
`EMBED_MODEL_REVISION` note in `config.ts`, which still mentions the old
`:mp1` spelling and is worth a one-line follow-up).

## 4. Alternatives and tradeoffs

- **Embed only the mismatching positions and interleave** (minimizes
  re-embedding after mid-inserts) — rejected: the assembly code becomes the
  same kind of clever positional bookkeeping that caused the bug, for a
  rare case (app updates) that only costs one category's rebuild.
- **Trust `specVersions` string equality as the fast path** (the old
  per-category version cache) — kept as dead weight? No: dropped from the
  persisted format. Per-position hashes subsume it with strictly more
  information; `prototypesVersion(EMBED_MODEL_ID, [spec])` per spec was
  tb2-equivalent work to hashing anyway.
- **Keep the `neutral: user approved` special-case exclusion** — removed.
  Hash verification handles heads and middles generally; that centroid can
  now use the tail path safely (head-drops fail at position 0).

Unresolved, deliberately: the `config.ts` comment and the CLAUDE.md centroid
paragraph still describe the `:mp1`-era contract; both are outside this
change's file scope.

## 5. Verification

- `node scripts/centroid-cache-test.mjs` (new suite, runs the REAL
  `src/shared/prototype-cache.ts` under Node 24 type stripping with a
  deterministic fake embedder): **16/16 pass**, including the lead's three
  scenarios — (a) pure correction append reuses only cached positions and
  embeds exactly `[correction2]`; (b) mid-inserted seed forces a full
  rebuild with all 14 texts embedded once, each output vector matching its
  text; (c) appended seed reuses the 13 cached vectors, and the new seed is
  embedded exactly once. Plus head-drop → rebuild, tail-drop → zero embed
  calls, hash-less old cache → rebuild, embed-count mismatch → throws, and
  an incremental-chain-equals-cold-build property test.
- Type check: `src/background/classifier.ts` +
  `src/shared/prototype-cache.ts` verified clean with `tsc --noEmit` against
  the project tsconfig scoped to those entry points (a temp tsconfig was
  necessary because the shared working tree had other builders' in-flight
  compile errors in `src/shared/lock-math.ts` and
  `src/options/pages/UsagePage.tsx` at the time). The full `npm run
  typecheck`/`npm run eval` sweep is left to the integration lead by
  instruction.
- Behavior change to expect in logs: on first load after this change, one
  full centroid rebuild (~2.5s) — the accepted, announced migration cost.
