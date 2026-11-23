// Validates the shipped precomputed seed-vector asset against the CURRENT
// seeds and pinned model. This is the tripwire that makes the asset safe:
// edit prototype-seeds.json (or bump the model revision) without
// regenerating and this suite fails loudly instead of shipping a cache that
// silently falls back to a slow rebuild (or worse, is ignored at runtime).
//
//   node scripts/centroid-asset-test.mjs
//   node scripts/build-centroid-cache.mjs   # regenerate after seed/model edits
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import asset from '../src/shared/seed-centroid-vectors.json' with { type: 'json' };
import { EMBED_MODEL_ID, EMBED_MODEL_REVISION, LABELS } from '../src/shared/config.ts';
import { centroidSpecs } from '../src/shared/prototypes.ts';
import {
  decodeSeedVector,
  hashSeedText,
  SEED_VECTOR_ASSET_FORMAT,
} from '../src/shared/prototype-cache.ts';

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

const specs = centroidSpecs([...LABELS], {});
const assetPath = new URL('../src/shared/seed-centroid-vectors.json', import.meta.url);

console.log('seed-vector asset tests');

test('asset was generated for the pinned model', () => {
  assert.equal(asset.format, SEED_VECTOR_ASSET_FORMAT);
  assert.equal(asset.modelId, EMBED_MODEL_ID);
  assert.equal(asset.modelRevision, EMBED_MODEL_REVISION);
  assert.ok(Number.isInteger(asset.dim) && asset.dim > 0);
});

test('every current centroid has an entry with the exact seed texts in order', () => {
  for (const spec of specs) {
    const entry = asset.byName[spec.name];
    assert.ok(entry, `missing centroid "${spec.name}" — regenerate the asset`);
    assert.equal(
      entry.hashes.length,
      spec.texts.length,
      `"${spec.name}" has ${spec.texts.length} seeds but the asset has ${entry.hashes.length} — regenerate`,
    );
    assert.equal(entry.vectors.length, entry.hashes.length);
    for (let i = 0; i < spec.texts.length; i++) {
      assert.equal(
        entry.hashes[i],
        hashSeedText(spec.texts[i]),
        `"${spec.name}" seed ${i} changed — regenerate the asset`,
      );
    }
  }
});

test('vectors decode to finite, normalized embeddings of the declared width', () => {
  for (const spec of specs) {
    for (const encoded of asset.byName[spec.name].vectors) {
      const vec = decodeSeedVector(encoded, asset.dim);
      let norm = 0;
      for (const value of vec) {
        assert.ok(Number.isFinite(value), `non-finite component in "${spec.name}"`);
        norm += value * value;
      }
      norm = Math.sqrt(norm);
      assert.ok(norm > 0.5, `near-zero vector in "${spec.name}" (norm ${norm})`);
      assert.ok(
        Math.abs(norm - 1) < 0.01,
        `"${spec.name}" vector is not normalized (norm ${norm.toFixed(4)})`,
      );
    }
  }
});

test('the asset stays small enough to ship', () => {
  const bytes = readFileSync(assetPath).length;
  assert.ok(bytes < 4 * 1024 * 1024, `asset is ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  assert.ok(bytes > 100 * 1024, 'asset looks empty');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
