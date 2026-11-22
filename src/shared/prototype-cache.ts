// Pure centroid seed-cache reuse planning for the embed backend
// (src/background/classifier.ts getCentroids).
//
// INVARIANT: a cached seed vector may only be reused for a text if a stored
// per-position hash PROVES it was embedded from that exact text — never
// because "N vectors happen to exist". The pre-2026-11 tail-append check was
// length-only (`prev.seedVecs.length < spec.texts.length`), which silently
// misaligned vectors when an app update inserted or removed a seed text
// anywhere before the corrections: the cached correction vector got reused
// at the shifted position, the new seed text was never embedded, and the
// correction was double-counted — a poisoned centroid stored under a
// correct-looking version string (the ':mp1' rebuild-forcer only works when
// someone remembers to bump it, which nothing enforces).
//
// Pure + erasable-syntax-only (no enums/namespaces/param-properties): it is
// imported directly under Node >= 22.6 type stripping by
// scripts/centroid-cache-test.mjs, mirroring rules-test.ts's constraint.
// classifier.ts supplies the real `embed` (offscreen RPC or in-process) and
// storage; nothing here touches browser APIs.

/** Cache-format tag appended to the centroid store `version`
 * (classifier.ts getCentroids) and to the title-cache modelKey (classify).
 *
 * No longer LOAD-BEARING for seed changes: hash-verified reuse (below) makes
 * appending/inserting/removing/reordering seed texts safe without any bump —
 * a cache entry lacking per-position hashes already degrades to a full
 * rebuild on its own. The tag still serves two purposes and must stay in
 * lockstep across the two call sites so centroids and cached title verdicts
 * invalidate together:
 *  1. forcing the ONE-TIME cold rebuild (~2.5s) when the persisted cache
 *     shape changes — old shape = no `seedHashes`, which could otherwise
 *     only be detected per-rebuild;
 *  2. recording which cache format is on disk. A model-REVISION bump is
 *     gated separately by the `modelId`/`modelRevision` fields classifier.ts
 *     writes next to the vectors (added 2026-11-21) — the format tag alone
 *     never saw the revision, so a bump used to reuse old-model vectors.
 * Bump `:mp1` -> ':mp2' here when the persisted structure changes. */
export const CENTROID_CACHE_FORMAT = ':mp2';

/** Compact stable hash (djb2 — same family as prototypesVersion) of a seed
 *  text, persisted next to its cached vector so reuse can be verified. */
export function hashSeedText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** A cached per-category seed-vector list plus the per-position hashes of
 *  the texts it was built from. `hashes` missing or shorter/longer than
 *  `seedVecs` (a pre-':mp2' cache or corrupt entry) ⇒ the entry is
 *  untrusted and forces a full rebuild. */
export interface CachedSeedVectors {
  seedVecs: number[][];
  hashes?: string[];
}

/** How to (re)build one category's seed vectors given its cached entry. */
export type SeedReusePlan =
  /** Reuse is proven: cached positions 0..reuseCount-1 each hashed-match
   *  texts[0..reuseCount-1]; embed exactly `toEmbed` (= texts beyond the
   *  verified prefix). reuseCount === texts.length means a pure cache hit. */
  | { kind: 'verified'; reuseCount: number; toEmbed: string[] }
  /** No provable correspondence — embed all `texts` from scratch. */
  | { kind: 'rebuild' };

/** Decide how much of a cached seed-vector list may be reused for `texts`.
 *
 * Reuse requires a VERIFIED PREFIX: cached position i is trusted for
 * texts[i] iff hashes[i] === hashSeedText(texts[i]) for every i below the
 * overlap. Any mismatch — a text inserted, removed, reordered, or replaced
 * anywhere in the cached region, HEADS AND MIDDLES included — forces a full
 * rebuild of that category. (This generalizes the old special-case
 * 'neutral: user approved' head-drop exclusion: that centroid may now use
 * the tail path too, because any head change fails its position-0 hash.)
 * The one non-rebuild case with texts shorter than the cache — a verified
 * prefix shrink where only TAIL texts were dropped, e.g. a user correction
 * removed — safely reuses the truncated run. */
export function planSeedReuse(
  prev: CachedSeedVectors | undefined,
  texts: string[],
): SeedReusePlan {
  const seedVecs = prev?.seedVecs;
  const hashes = prev?.hashes;
  if (!seedVecs || seedVecs.length === 0 || !hashes || hashes.length !== seedVecs.length) {
    return { kind: 'rebuild' };
  }
  const reuseCount = Math.min(seedVecs.length, texts.length);
  for (let i = 0; i < reuseCount; i++) {
    if (hashes[i] !== hashSeedText(texts[i])) return { kind: 'rebuild' };
  }
  return { kind: 'verified', reuseCount, toEmbed: texts.slice(reuseCount) };
}

/** Build one category's seed vectors: reuse verified cached positions and
 *  call `embed` ONLY for texts whose vectors are missing. Returns the
 *  complete vector list (parallel to `texts`), fresh per-position hashes to
 *  persist alongside it, and the reuse/embed counts (for tests + logging). */
export async function buildSpecVectors(
  texts: string[],
  prev: CachedSeedVectors | undefined,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<{ vecs: number[][]; hashes: string[]; reused: number; embedded: number }> {
  const plan = planSeedReuse(prev, texts);
  if (plan.kind === 'rebuild') {
    const vecs = await embed(texts);
    if (vecs.length !== texts.length) {
      throw new Error(`embed returned ${vecs.length} vectors for ${texts.length} texts`);
    }
    return { vecs, hashes: texts.map(hashSeedText), reused: 0, embedded: texts.length };
  }
  const tailVecs = plan.toEmbed.length > 0 ? await embed(plan.toEmbed) : [];
  if (tailVecs.length !== plan.toEmbed.length) {
    throw new Error(
      `embed returned ${tailVecs.length} tail vectors for ${plan.toEmbed.length} texts`,
    );
  }
  // planSeedReuse only returns 'verified' when prev existed and its hashes
  // were well-formed; make that invariant explicit for the type narrowing.
  if (!prev) throw new Error('internal error: verified reuse plan without a cached entry');
  const vecs = [...prev.seedVecs.slice(0, plan.reuseCount), ...tailVecs];
  return {
    vecs,
    hashes: texts.map(hashSeedText),
    reused: plan.reuseCount,
    embedded: plan.toEmbed.length,
  };
}
