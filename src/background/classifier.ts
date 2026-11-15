import { env, pipeline } from '@huggingface/transformers';
import { api, IS_FIREFOX } from '../shared/api';
import { buildClassifierText, inputCacheKey } from '../shared/build-input';
import {
  CLASSIFIER_BACKEND,
  EMBED_MODEL_ID,
  EMBED_MODEL_REVISION,
  HYPOTHESIS_TEMPLATE,
  MODEL_ID,
  MODEL_REVISION,
  SOFTMAX_TEMPERATURE,
  TITLE_CACHE_MAX,
} from '../shared/config';
import { getSettings } from '../shared/settings';
import { getPrototypeExamples } from '../shared/feedback';
import {
  centroidSpecs,
  classifyBySimilarity,
  meanNormalize,
  prototypesVersion,
} from '../shared/prototypes';
import { buildSpecVectors, CENTROID_CACHE_FORMAT, type CachedSeedVectors } from '../shared/prototype-cache';
import type { ClassifyInput, ClassifyOutcome, InferResult } from '../shared/messages';
import { classifyViaOffscreen, embedViaOffscreen, supportsOffscreen } from './classify-client';

// ---- MV3 environment config (load-bearing) ----
// Model weights come from the HF Hub (data, not code — Web Store legal). Vite
// statically inlines ORT's wasm glue for Chrome's service worker; Firefox loads
// the module from packaged extension assets instead, as described below. Both
// targets include the .wasm binary as an extension asset.
//
// Chrome's service worker must leave wasmPaths unset so ORT uses the
// bundler-inlined glue; an override would select dynamic import(), which a
// service worker rejects. Firefox's generated event page is a real document,
// not a ServiceWorkerGlobalScope, so Transformers.js otherwise defaults that
// path to its CSP-blocked jsDelivr CDN. Select the packaged local glue only on
// Firefox; dynamic import() of a same-origin module is valid in that document.
env.allowLocalModels = false;
const ortWasm = env.backends.onnx.wasm!;
if (IS_FIREFOX) {
  ortWasm.wasmPaths = {
    mjs: api.runtime.getURL('ort-wasm-simd-threaded.jsep.mjs'),
    wasm: api.runtime.getURL('ort-wasm-simd-threaded.jsep.wasm'),
  };
}
ortWasm.numThreads = 1; // workers can't spawn nested Workers
ortWasm.proxy = false;

// Firefox extension pages may lack the Cache API; probe before transformers
// tries to use it (failure mode is a hard throw during model load).
async function probeBrowserCache(): Promise<void> {
  try {
    await caches.open('smartblocker-probe');
    env.useBrowserCache = true;
  } catch {
    env.useBrowserCache = false;
    console.warn('[SmartBlocker] Cache API unavailable — model re-downloads each session');
  }
}

const logProgress = (p: { status: string; file?: string; progress?: number }) => {
  // Broadcast to the options page (and anywhere else listening).
  try {
    api.runtime.sendMessage({ type: 'MODEL_PROGRESS', ...p });
  } catch {
    // ignore — no options page open
  }
  if (p.status === 'progress' && p.progress != null) {
    console.log(`[SmartBlocker] downloading ${p.file}: ${p.progress.toFixed(0)}%`);
  }
};

// ---- In-process NLI pipeline (Firefox path of the legacy 'nli' backend) ----
type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options?: { hypothesis_template?: string; multi_label?: boolean },
) => Promise<{ labels: string[]; scores: number[] }>;

let instance: Promise<ZeroShotPipeline> | null = null;

async function createPipeline(): Promise<ZeroShotPipeline> {
  await probeBrowserCache();
  const pipe = await pipeline('zero-shot-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    revision: MODEL_REVISION, // pinned HF commit (red-team #19) — see config.ts
    progress_callback: logProgress,
  });
  return pipe as unknown as ZeroShotPipeline;
}

export function getClassifier(): Promise<ZeroShotPipeline> {
  instance ??= createPipeline().catch((e) => {
    instance = null; // allow retry after a failed load
    throw e;
  });
  return instance;
}

// ---- In-process embedding pipeline (Firefox path of the 'embed' backend) ----
type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let embedInstance: Promise<FeatureExtractionPipeline> | null = null;

async function createEmbedPipeline(): Promise<FeatureExtractionPipeline> {
  await probeBrowserCache();
  const pipe = await pipeline('feature-extraction', EMBED_MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    revision: EMBED_MODEL_REVISION, // pinned HF commit (red-team #19) — see config.ts
    progress_callback: logProgress,
  });
  return pipe as unknown as FeatureExtractionPipeline;
}

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  embedInstance ??= createEmbedPipeline().catch((e) => {
    embedInstance = null; // allow retry after a failed load
    throw e;
  });
  return embedInstance;
}

/** Embed texts on whichever host runs inference (offscreen doc or in-process),
 *  returning normalized vectors plus load/infer timings. */
async function embedTexts(
  texts: string[],
): Promise<{ vectors: number[][]; loadMs: number; inferMs: number }> {
  if (supportsOffscreen()) return embedViaOffscreen(texts);
  const t0 = performance.now();
  const embedder = await getEmbedder();
  const tLoaded = performance.now();
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(out.data.slice(i * dim, (i + 1) * dim) as Float32Array));
  }
  return { vectors, loadMs: tLoaded - t0, inferMs: performance.now() - tLoaded };
}

// ---- Centroid store (embed backend) ----
// Centroid vectors are derived data: rebuilt whenever their version (model id
// + active labels + seed/user-correction texts + CENTROID_CACHE_FORMAT)
// changes, cached in storage.local so a fresh SW start skips the ~1s rebuild.
// `seedHashes` is parallel to `seedVectors` — the per-position text hashes the
// vectors were built from — so incremental rebuilds can PROVE which cached
// vectors are still valid (see shared/prototype-cache.ts for the invariant).
type CentroidCache = {
  version: string;
  names: string[];
  vectors: number[][];
  seedVectors?: number[][][];
  seedHashes?: string[][];
};

let centroidsInFlight: Promise<CentroidCache> | null = null;

async function getCentroids(labels: string[]): Promise<CentroidCache & { buildMs: number }> {
  const specs = centroidSpecs(labels, await getPrototypeExamples());
  // The prototypesVersion hash already spans every text, so seed/correction
  // EDITS always change it — the CENTROID_CACHE_FORMAT tag on top is NOT what
  // makes them safe (hash-verified per-position reuse is, see the loop
  // below); it only forces a one-time full rebuild when the persisted cache
  // SHAPE changes. Both are appended so centroids and the title-cache
  // modelKey (see classify) invalidate in lockstep.
  const version = prototypesVersion(EMBED_MODEL_ID, specs) + CENTROID_CACHE_FORMAT;

  const stored = await api.storage.local.get('centroidCache');
  const cached = stored.centroidCache as CentroidCache | undefined;
  if (cached && cached.version === version && cached.seedVectors) {
    return { ...cached, buildMs: 0 };
  }

  // Another call may already be rebuilding the same version — don't duplicate.
  // A REJECTED in-flight build reads as "no build in progress": its failure
  // propagates to the builder's own caller (the only path allowed to fail
  // the classification for that hiccup — classify() then fails closed once);
  // a waiter instead falls through and starts a fresh build, so one
  // transient embed/storage failure cannot fail every concurrent
  // classification that deduped onto it. The fresh attempt stays bounded
  // (one per waiter): it either succeeds or propagates its own rejection.
  if (centroidsInFlight) {
    const inFlight = await centroidsInFlight.then(
      (built) => built,
      () => null,
    );
    if (inFlight && inFlight.version === version) return { ...inFlight, buildMs: 0 };
  }

  const t0 = performance.now();
  const buildPromise: Promise<CentroidCache> = (async () => {
    const names: string[] = [];
    const vectors: number[][] = [];
    const seedVectors: number[][][] = [];
    const seedHashes: string[][] = [];

    // Build a lookup of previously cached per-category seed vectors so adding
    // a single user correction (OVERRIDE or REPORT_FN) only embeds the changed
    // category's new seed text (~12ms) instead of re-embedding all 518 seeds
    // (~25s). Reuse is HASH-VERIFIED, never length-guessed: via
    // buildSpecVectors a cached vector is trusted for a text only when the
    // persisted per-position hash proves it was embedded from that exact
    // text. Any insert/remove/reorder/replace in the cached region — heads
    // and middles, including the 'neutral: user approved' head-drop case the
    // old code special-cased away — fails its position hash and forces a
    // full rebuild of that category; only a verified prefix + fresh tail is
    // incrementally embedded.
    const prevByName = new Map<string, CachedSeedVectors>();
    if (cached && cached.seedVectors && cached.names.length === cached.seedVectors.length) {
      for (let i = 0; i < cached.names.length; i++) {
        prevByName.set(cached.names[i], {
          seedVecs: cached.seedVectors[i],
          hashes: cached.seedHashes?.[i],
        });
      }
    }

    for (const spec of specs) {
      const { vecs, hashes } = await buildSpecVectors(
        spec.texts,
        prevByName.get(spec.name),
        (texts) => embedTexts(texts).then((r) => r.vectors),
      );
      names.push(spec.name);
      vectors.push(meanNormalize(vecs));
      seedVectors.push(vecs);
      seedHashes.push(hashes);
    }
    const built: CentroidCache = { version, names, vectors, seedVectors, seedHashes };
    await api.storage.local.set({ centroidCache: built });
    return built;
  })();
  centroidsInFlight = buildPromise;
  // Release the dedupe slot no matter how the build settles (success OR
  // rejection — the finally below runs when the await settles either way, so
  // a transient failure can never leave a rejected promise parked here for
  // the SW's lifetime). The identity guard means cleanup of this build can
  // never clobber a NEWER build a waiter already started because this one's
  // version went stale mid-flight.
  try {
    const built = await buildPromise;
    console.log(
      `[SmartBlocker] built ${built.names.length} centroids (${version}) in ` +
        `${Math.round(performance.now() - t0)}ms`,
    );
    return { ...built, buildMs: performance.now() - t0 };
  } finally {
    if (centroidsInFlight === buildPromise) centroidsInFlight = null;
  }
}

// ---- Focus / Open-Tab Context embedding cache ----
let focusVecCache: { key: string; vec: number[]; seedVecs: number[][] } | null = null;

function focusContextKey(fc?: ClassifyInput['focusContext']): string {
  if (!fc) return '';
  const goal = (fc.focusGoal ?? '').trim().toLowerCase();
  const tabs = (fc.openTabTitles ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  if (!goal && tabs.length === 0) return '';
  return `${goal}\x1f${tabs.join('\x1e')}`;
}

async function resolveFocusVector(
  fc?: ClassifyInput['focusContext'],
): Promise<{
  vec: number[] | null;
  seedVecs: number[][];
  hasExplicitGoal: boolean;
  inferMs: number;
}> {
  const key = focusContextKey(fc);
  if (!key || !fc) return { vec: null, seedVecs: [], hasExplicitGoal: false, inferMs: 0 };
  const goal = (fc.focusGoal ?? '').trim();
  const tabs = (fc.openTabTitles ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 6);
  if (focusVecCache && focusVecCache.key === key) {
    return {
      vec: focusVecCache.vec,
      seedVecs: focusVecCache.seedVecs,
      hasExplicitGoal: Boolean(goal),
      inferMs: 0,
    };
  }
  const textsToEmbed: string[] = [];
  if (goal) textsToEmbed.push(goal);
  textsToEmbed.push(...tabs);
  if (textsToEmbed.length === 0) {
    return { vec: null, seedVecs: [], hasExplicitGoal: false, inferMs: 0 };
  }

  const { vectors, inferMs } = await embedTexts(textsToEmbed);
  let combined: number[];
  let seedVecs: number[][];
  if (goal && tabs.length > 0) {
    const goalVec = vectors[0];
    const tabsMean = meanNormalize(vectors.slice(1));
    // Weight explicit focus goal 2:1 over passive open-tab titles, and include
    // goalVec twice in seedVecs so Top-K sub-center pooling never dilutes a
    // direct goal match with unrelated open tabs.
    combined = meanNormalize([goalVec, goalVec, tabsMean]);
    seedVecs = [goalVec, goalVec, ...vectors.slice(1)];
  } else {
    combined = meanNormalize(vectors);
    seedVecs = vectors;
  }
  focusVecCache = { key, vec: combined, seedVecs };
  return { vec: combined, seedVecs, hasExplicitGoal: Boolean(goal), inferMs };
}

// ---- Title result cache (repeat titles are ~0ms) ----
// In-memory Map backed by storage.local so it survives service-worker death.
type CacheEntry = { label: string; score: number; all: ClassifyOutcome['all'] };
let titleCache: Map<string, CacheEntry> | null = null;

async function getTitleCache(): Promise<Map<string, CacheEntry>> {
  if (!titleCache) {
    const stored = await api.storage.local.get('titleCache');
    titleCache = new Map(Object.entries(stored.titleCache ?? {}));
  }
  return titleCache;
}

function persistTitleCache(cache: Map<string, CacheEntry>) {
  while (cache.size > TITLE_CACHE_MAX) {
    cache.delete(cache.keys().next().value!); // Map iterates insertion-order: drop oldest
  }
  void api.storage.local.set({ titleCache: Object.fromEntries(cache) });
}

// In-process inference (Firefox, or Chrome before the offscreen doc is wired).
async function classifyInProcess(text: string, labels: string[]): Promise<InferResult> {
  const t0 = performance.now();
  const clf = await getClassifier();
  const tLoaded = performance.now();
  const out = await clf(text, labels, {
    hypothesis_template: HYPOTHESIS_TEMPLATE,
    multi_label: false,
  });
  const tDone = performance.now();
  return {
    label: out.labels[0],
    score: out.scores[0],
    all: { labels: out.labels, scores: out.scores },
    loadMs: tLoaded - t0,
    inferMs: tDone - tLoaded,
  };
}

// Embed backend: one forward pass for the text, then multi-prototype cosine +
// softmax against the centroid store. Centroid (re)build cost is reported as loadMs.
async function classifyEmbed(
  text: string,
  labels: string[],
  focusContext?: ClassifyInput['focusContext'],
): Promise<InferResult> {
  const centroids = await getCentroids(labels);
  const [{ vectors, loadMs, inferMs }, focus] = await Promise.all([
    embedTexts([text]),
    resolveFocusVector(focusContext),
  ]);
  const verdict = classifyBySimilarity(
    vectors[0],
    centroids.names.map((name, i) => ({
      name,
      vec: centroids.vectors[i],
      seedVecs: centroids.seedVectors?.[i],
    })),
    SOFTMAX_TEMPERATURE,
    {
      focusVec: focus.vec,
      focusSeedVecs: focus.seedVecs,
      hasExplicitGoal: focus.hasExplicitGoal,
    },
  );
  return { ...verdict, loadMs: loadMs + centroids.buildMs, inferMs: inferMs + focus.inferMs };
}

export async function classify(input: ClassifyInput, bypassCache = false): Promise<ClassifyOutcome> {
  const { labels } = await getSettings();

  // The cache key spans every signal (title/channel/context) AND the model
  // key (backend + model + centroid version + active focus context), so model
  // switches, user corrections, and focus goal changes never serve stale verdicts.
  const fcKey = focusContextKey(input.focusContext);
  const modelKey =
    CLASSIFIER_BACKEND === 'embed'
      ? `embed:${EMBED_MODEL_ID}:${prototypesVersion(
          EMBED_MODEL_ID,
          centroidSpecs(labels, await getPrototypeExamples()),
        )}${CENTROID_CACHE_FORMAT}:${fcKey}`
      : `nli:${MODEL_ID}`;
  const key = inputCacheKey(input, modelKey);
  const text = buildClassifierText(input);

  const cache = await getTitleCache();
  // Read bypass is reserved for proof-of-protection checks: the production
  // inference path still runs and its fresh verdict refreshes the normal cache.
  const hit = bypassCache ? undefined : cache.get(key);
  if (hit) {
    return { text, ...hit, loadMs: 0, inferMs: 0, cached: true };
  }

  // Offscreen on Chrome/Edge keeps the model alive past SW idle; Firefox runs
  // the pipeline in-process. Labels are user-configurable (settings page) and
  // read per classification so changes apply without a reload.
  let infer: InferResult;
  if (CLASSIFIER_BACKEND === 'embed') {
    infer = await classifyEmbed(text, labels, input.focusContext);
  } else {
    infer = supportsOffscreen()
      ? await classifyViaOffscreen(text, labels)
      : await classifyInProcess(text, labels);
  }

  const entry: CacheEntry = { label: infer.label, score: infer.score, all: infer.all };
  cache.set(key, entry);
  persistTitleCache(cache);

  return { text, ...entry, loadMs: infer.loadMs, inferMs: infer.inferMs, cached: false };
}
