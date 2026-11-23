// Unit tests for the hash-verified centroid seed-cache reuse core
// (src/shared/prototype-cache.ts), which backs classifier.ts getCentroids.
//
// The 2026-11 bug under test: the old tail-append path checked LENGTH ONLY
// (cached seedVecs.length < spec.texts.length) and assumed cached vectors
// were a strict positional prefix of the new texts. An app update that adds
// a seed text ANYWHERE before the user-correction tail (not just at the
// tail) reused a stale misaligned prefix, never embedded the new seed, and
// double-counted the correction — a poisoned centroid under a
// correct-looking version string. The fix persists a per-position text
// hash next to every cached vector and reuses a cached vector only when
// its hash PROVES it was embedded from that exact text.
//
// Runs directly under Node >= 22.6 type stripping — prototype-cache.ts is
// kept free of non-erasable TS syntax for exactly this reason (same
// constraint family as rules-test.mjs). classifier.ts itself is NOT
// importable here (browser APIs + transformers.js); the decision logic
// lives in the pure shared module so this suite exercises the real one.
//
//   node scripts/centroid-cache-test.mjs
import assert from 'node:assert/strict';
import {
  buildSpecVectors,
  CENTROID_CACHE_FORMAT,
  decodeSeedVector,
  hashSeedText,
  planSeedReuse,
  SEED_VECTOR_ASSET_FORMAT,
  seedVectorsFromAsset,
} from '../src/shared/prototype-cache.ts';
import { dotProduct } from '../src/shared/prototypes.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log('centroid seed-cache hash-verified reuse tests');

// Deterministic fake embedder: every distinct text maps to a distinct
// unit-normalized 4-dim vector, so a misaligned reuse is VISIBLE in the
// resulting vector list, and every embed call is recorded so the tests can
// assert exactly which texts were embedded and how often.
const DIM = 4;
function textVec(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < DIM; i++) v[i] = ((h >>> (i * 8)) & 0xff) / 255 - 0.5;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function makeEmbedRecorder() {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts);
    return texts.map(textVec);
  };
  return { embed, calls };
}

const desc = 'Web pages about video games.';
const s = (i) => `seed example title number ${i} — gameplay`;
const c1 = 'user correction: this was actually gaming';
const c2 = 'user correction: another gaming page';
const baseTexts = [desc, ...Array.from({ length: 11 }, (_, i) => s(i + 1)), c1]; // 13 texts
assert.equal(baseTexts.length, 13);

// ===========================================================================
// planSeedReuse: the decision primitive
// ===========================================================================

const baked = {
  seedVecs: baseTexts.map(textVec),
  hashes: baseTexts.map(hashSeedText),
};

test('CENTROID_CACHE_FORMAT records the current persisted-cache format', () => {
  assert.equal(CENTROID_CACHE_FORMAT, ':mp2');
});

test('hashSeedText is stable, compact, and position-distinguishing', () => {
  assert.equal(hashSeedText('abc'), hashSeedText('abc'));
  assert.match(hashSeedText('abc'), /^[0-9a-z]+$/);
  const distinct = new Set(baseTexts.map(hashSeedText));
  assert.equal(distinct.size, baseTexts.length);
});

test('planSeedReuse: exact-match cache hit is a verified reuse with nothing to embed', () => {
  const plan = planSeedReuse(baked, baseTexts);
  assert.deepEqual(plan, { kind: 'verified', reuseCount: 13, toEmbed: [] });
});

test('planSeedReuse: pre-mp2 cache without hashes is untrusted (rebuild)', () => {
  assert.deepEqual(planSeedReuse({ seedVecs: baked.seedVecs }, baseTexts), { kind: 'rebuild' });
  assert.deepEqual(planSeedReuse(undefined, baseTexts), { kind: 'rebuild' });
  assert.deepEqual(planSeedReuse({ seedVecs: [], hashes: [] }, baseTexts), { kind: 'rebuild' });
});

test('planSeedReuse: hash/vec length mismatch is untrusted (rebuild)', () => {
  assert.deepEqual(
    planSeedReuse({ seedVecs: baked.seedVecs, hashes: baked.hashes.slice(0, 5) }, baseTexts),
    { kind: 'rebuild' },
  );
});

test('planSeedReuse: replacement mid-list is a rebuild (hash mismatch at that position)', () => {
  const mutated = [...baseTexts];
  mutated[5] = 'seed example title number 4 — gameplay REMASTERED';
  assert.deepEqual(planSeedReuse(baked, mutated), { kind: 'rebuild' });
});

test('planSeedReuse: reorder is a rebuild even at the head', () => {
  assert.deepEqual(
    planSeedReuse(baked, [s(1), desc, ...baseTexts.slice(2)]),
    { kind: 'rebuild' },
  );
});

test('planSeedReuse: tail-only shrink stays verified (correction removed)', () => {
  const plan = planSeedReuse(
    { seedVecs: [...baked.seedVecs, textVec(c2)], hashes: [...baseTexts.map(hashSeedText), hashSeedText(c2)] },
    baseTexts,
  );
  assert.deepEqual(plan, { kind: 'verified', reuseCount: 13, toEmbed: [] });
});

test('planSeedReuse: head-drop (old user-approved hazard) is a rebuild', () => {
  const plan = planSeedReuse(
    {
      seedVecs: ['a', 'b', 'c'].map(textVec),
      hashes: ['a', 'b', 'c'].map(hashSeedText),
    },
    ['b', 'c'],
  );
  assert.deepEqual(plan, { kind: 'rebuild' });
});

// ===========================================================================
// buildSpecVectors: assembly + embed-cost behavior
// ===========================================================================

test('(a) pure correction append reuses only cached positions, embeds just the tail', async () => {
  const { embed, calls } = makeEmbedRecorder();
  const res = await buildSpecVectors([...baseTexts, c2], baked, embed);
  assert.equal(res.reused, 13);
  assert.equal(res.embedded, 1);
  assert.deepEqual(calls, [[c2]]); // exactly one call, exactly the new correction
  assert.equal(res.vecs.length, 14);
  assert.deepEqual(res.vecs.slice(0, 13), baked.seedVecs);
  assert.deepEqual(res.vecs[13], textVec(c2));
  assert.deepEqual(res.hashes, [...baseTexts, c2].map(hashSeedText));
});

test('(b) seed inserted between desc-seeds and corrections => full rebuild, aligned vectors', async () => {
  const withNewSeed = [desc, ...Array.from({ length: 12 }, (_, i) => s(i + 1)), c1]; // 14, s(12) sits at index 12
  const rec = makeEmbedRecorder();
  const res = await buildSpecVectors(withNewSeed, baked, rec.embed);
  // first hash mismatch is at index 12 (c1 cached there, s(12) wanted) => no reuse at all
  assert.equal(res.reused, 0);
  assert.equal(res.embedded, 14);
  assert.deepEqual(rec.calls, [withNewSeed]); // one call, ALL texts, in order
  assert.deepEqual(res.vecs, withNewSeed.map(textVec)); // s(12) embedded once, c1 exactly once
  assert.equal(res.vecs.filter((v) => v.every((x, i) => x === textVec(c1)[i])).length, 1);
});

test('(c) appended seed reuses the 13 cached vecs, embeds s12 exactly once, counts exact', async () => {
  const appended = [...baseTexts, s(12)]; // seed lands AFTER the correction tail
  const rec = makeEmbedRecorder();
  const res = await buildSpecVectors(appended, baked, rec.embed);
  assert.equal(res.reused, 13);
  assert.equal(res.embedded, 1);
  assert.deepEqual(rec.calls, [[s(12)]]);
  assert.deepEqual(res.vecs.slice(0, 13), baked.seedVecs);
  assert.deepEqual(res.vecs[13], textVec(s(12)));
  assert.equal(res.vecs.length, 14);
});

test('(d) old-format hash-less cache => full rebuild (one-time migration cost)', async () => {
  const rec = makeEmbedRecorder();
  const res = await buildSpecVectors(baseTexts, { seedVecs: baked.seedVecs }, rec.embed);
  assert.equal(res.reused, 0);
  assert.deepEqual(rec.calls, [baseTexts]);
  assert.deepEqual(res.vecs, baseTexts.map(textVec));
});

test('(e) tail-shrink requires zero embed calls and reuses the verified prefix', async () => {
  const rec = makeEmbedRecorder();
  const grown = await buildSpecVectors([...baseTexts, c2], undefined, rec.embed);
  const cachedPair = { seedVecs: grown.vecs, hashes: grown.hashes };
  const shrunk = await buildSpecVectors(baseTexts, cachedPair, rec.embed);
  assert.equal(shrunk.reused, 13);
  assert.equal(shrunk.embedded, 0);
  assert.deepEqual(rec.calls, [[...baseTexts, c2]]); // only the first build embedded
  assert.deepEqual(shrunk.vecs, grown.vecs.slice(0, 13));
});

test('embed returning the wrong vector count is a hard error, never a silent misalignment', async () => {
  const badEmbed = async (texts) => texts.slice(0, Math.max(1, texts.length - 1)).map(textVec);
  await assert.rejects(buildSpecVectors(baseTexts, undefined, badEmbed));
  await assert.rejects(buildSpecVectors(baseTexts, baked, badEmbed));
});

// ===========================================================================
// Sequence property: incremental chains converge to the cold-build result
// ===========================================================================

test('incremental chain (append → insert → replace) always equals a cold build of the final texts', async () => {
  const rec = makeEmbedRecorder();
  const step1 = await buildSpecVectors(baseTexts, undefined, rec.embed);
  const withCorrection = [...baseTexts, c2];
  const step2 = await buildSpecVectors(
    withCorrection,
    { seedVecs: step1.vecs, hashes: step1.hashes },
    rec.embed,
  );
  const withNewSeed = [desc, ...Array.from({ length: 12 }, (_, i) => s(i + 1)), c1, c2];
  const step3 = await buildSpecVectors(
    withNewSeed,
    { seedVecs: step2.vecs, hashes: step2.hashes },
    rec.embed,
  );
  const cold = await buildSpecVectors(withNewSeed, undefined, rec.embed);
  assert.deepEqual(step3.vecs, cold.vecs);
  assert.deepEqual(step3.hashes, cold.hashes);
  // and the intermediate append really was incremental (cheap), not a full rebuild
  assert.equal(step2.embedded, 1);
  assert.equal(step3.embedded, withNewSeed.length); // mid-insert forced full re-embed
});

await test('dotProduct never returns NaN for mismatched dimensions', () => {
  assert.equal(dotProduct([1, 2, 3], [1, 2]), 0);
  assert.equal(dotProduct([], [1]), 0);
  assert.equal(dotProduct([1, 0], [1, 0]), 1);
});

// --- precomputed asset decoding/reuse ---
function encodeVec(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

await test('decodeSeedVector round-trips a Float32 vector and checks the width', () => {
  const vec = [0.25, -0.5, 0.75, 1];
  assert.deepEqual(decodeSeedVector(encodeVec(vec), 4), vec);
  assert.throws(() => decodeSeedVector(encodeVec(vec), 3), /dims/);
});

await test('seedVectorsFromAsset reuses matching entries and gates on the model', () => {
  const specs = [
    { name: 'alpha', texts: ['one', 'two'] },
    { name: 'beta', texts: ['three'] },
  ];
  const asset = {
    format: SEED_VECTOR_ASSET_FORMAT,
    modelId: 'model-x',
    modelRevision: 'rev-1',
    dim: 2,
    byName: {
      alpha: {
        hashes: specs[0].texts.map(hashSeedText),
        vectors: [encodeVec([1, 0]), encodeVec([0, 1])],
      },
      beta: {
        hashes: specs[1].texts.map(hashSeedText),
        vectors: [encodeVec([0.5, 0.5])],
      },
    },
  };
  const ok = seedVectorsFromAsset(specs, asset, { id: 'model-x', revision: 'rev-1' });
  assert.equal(ok.size, 2);
  assert.deepEqual(ok.get('alpha').seedVecs, [[1, 0], [0, 1]]);
  assert.deepEqual(ok.get('alpha').hashes, asset.byName.alpha.hashes);

  // Wrong model/revision/format → no reuse at all (never mix vector spaces).
  assert.equal(seedVectorsFromAsset(specs, asset, { id: 'model-x', revision: 'rev-2' }).size, 0);
  assert.equal(seedVectorsFromAsset(specs, asset, { id: 'model-y', revision: 'rev-1' }).size, 0);
  assert.equal(
    seedVectorsFromAsset(specs, { ...asset, format: 999 }, { id: 'model-x', revision: 'rev-1' }).size,
    0,
  );

  // A malformed entry is skipped; the rest still work.
  const broken = {
    ...asset,
    byName: {
      ...asset.byName,
      alpha: { hashes: asset.byName.alpha.hashes, vectors: ['not-base64!!'] },
    },
  };
  const partial = seedVectorsFromAsset(specs, broken, { id: 'model-x', revision: 'rev-1' });
  assert.equal(partial.size, 1);
  assert.equal(partial.has('beta'), true);
});

await test('asset vectors flow through the hash-verified reuse plan', async () => {
  const texts = ['a', 'b', 'c'];
  const seeded = {
    name: 'alpha',
    texts,
  };
  const asset = {
    format: SEED_VECTOR_ASSET_FORMAT,
    modelId: 'm',
    modelRevision: 'r',
    dim: 2,
    byName: {
      alpha: {
        hashes: texts.map(hashSeedText),
        vectors: texts.map((_, i) => encodeVec([i, 1])),
      },
    },
  };
  const prev = seedVectorsFromAsset([seeded], asset, { id: 'm', revision: 'r' }).get('alpha');
  let embedded = 0;
  const built = await buildSpecVectors(
    [...texts, 'd'],
    prev,
    async (batch) => {
      embedded += batch.length;
      return batch.map(() => [9, 9]);
    },
  );
  assert.equal(embedded, 1, 'only the appended seed is embedded');
  assert.deepEqual(built.vecs.slice(0, 3), [[0, 1], [1, 1], [2, 1]]);
});

console.log(
  `\ncentroid seed-cache reuse tests: ${passed} passed, ${failed} failed, ${passed + failed} total`,
);
process.exit(failed > 0 ? 1 : 0);
