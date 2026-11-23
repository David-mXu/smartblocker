# Precomputed seed embeddings + a warm-cache gate

## Why

A fresh install's first classification had to embed every centroid seed (~518
texts) before it could decide anything — measured ~30s in real Chromium. That
looked like a hang and fed the "protection looks active but isn't" complaints.
The nightly lane also had a cache-poisoning edge: its chain step is designed to
exit 0 even when suites fail, so a first run that died before downloading the
model could save a model-less profile under the `embedded-model-<rev>` key and
keep every later nightly cold (only a manual key bump recovered).

## What changed

### `src/shared/seed-centroid-vectors.json`

- `scripts/build-centroid-cache.mjs` drives the **built extension in real
  Chromium** and asks the offscreen document for embeddings through its own
  `EMBED` RPC — the same runtime that embeds query texts, so there is no
  Node-vs-WASM numeric drift. It writes base64 Float32 vectors keyed by
  per-position seed hashes, model id, and the pinned revision (~1.0MB).
- `copy-assets.mjs` ships the file into both targets; `classifier.ts` fetches
  it lazily (extension-local URL, no web-accessible-resources entry) on the
  first centroid build and feeds it to the existing hash-verified reuse plan.
  Only an exact model id+revision match is trusted; a malformed or stale asset
  simply degrades to a normal rebuild per category.
- Measured after the change: a forced cold centroid build (with an extra custom
  centroid that the asset cannot cover) took **2.6 s**, versus ~30 s before.
- `scripts/centroid-asset-test.mjs` is the staleness tripwire: it fails unless
  every current seed text appears in order with the right hash, the model
  fields match config, vectors decode to the declared width and are
  normalized, and the file stays under 4MB. Run it after editing seeds; run
  the generator when it fails.

### Nightly cache guard

- New `scripts/warm-model-cache.mjs` runs the real classifier once and fails
  non-zero unless the model CacheStorage is populated. The workflow runs it as
  a **hard gate before the chain**; a failure fails the job, so
  `actions/cache`'s post-if-success save is skipped.
- Non-classifier profiles were removed from the cached path list (they never
  hold a model), and an always-run step drops any p1/p2 profile whose
  CacheStorage is under 5MB before the cache save, as defense in depth.

### Test adjustment

`e2e-stale-allow-race` used the old ~30s centroid rebuild as its slow window.
It now delays `EMBED` RPCs inside the SW (black-box; no product hooks) so page
A is deterministically still in flight when page B blocks, and restores the
original function after B's overlay appears.

## Verification

- `centroid-cache-test` (19 incl. asset decode/model gating/hash-reuse),
  `centroid-asset-test` (4), typecheck, 43 pure suites (the new asset tripwire included).
- Chrome + Firefox builds ship the asset; real Chromium cold build measured
  2.6s; `e2e-test` ALL PASSED; `e2e-stale-allow-race` ALL PASSED with the new
  deterministic window; warm-model script passed against the warm profile.
- YAML validated for the workflow changes.

## Post-audit fixes

A final review of the merged tree found and fixed:

- `dotProduct` returned NaN for mismatched vector widths (a wrong-dimension
  asset would score NaN, which compares false and would fail OPEN). It now
  returns 0 for incompatible vectors, and a test pins that.
- `scripts/lib/eval-harness.mjs` loaded the shipped model from HF `main`
  instead of the pinned revision — the nightly eval could score unpinned
  weights against a pinned baseline. Both backends now pass the revision for
  their shipped model (candidates stay unpinned).
- The nightly lane caches the Node/transformers.js model directories (keyed on
  the same source-derived revision) and caps each suite at 20 minutes so a
  hang cannot consume the 300-minute job budget.

## Residual

The asset must be regenerated when seeds or the pinned model revision change;
the tripwire makes forgetting a loud test failure rather than a silent slow
path. Categories with only user-correction vectors (or a custom label added
after generation) still embed their new texts once, which is the intended
incremental cost.
