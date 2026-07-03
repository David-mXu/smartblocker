import { env, pipeline } from '@huggingface/transformers';
import { api } from '../shared/api';
import { buildClassifierText, inputCacheKey } from '../shared/build-input';
import {
  CLASSIFIER_BACKEND,
  EMBED_MODEL_ID,
  HYPOTHESIS_TEMPLATE,
  MODEL_ID,
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
import type { ClassifyInput, ClassifyOutcome, InferResult } from '../shared/messages';
import { classifyViaOffscreen, embedViaOffscreen, supportsOffscreen } from './classify-client';

// ---- MV3 environment config (load-bearing) ----
// Model weights come from the HF Hub (data, not code — Web Store legal); the
// ORT wasm runtime is statically inlined into this bundle by Vite, with the
// .wasm binary emitted as an extension asset.
//
// Do NOT set env.backends.onnx.wasm.wasmPaths: any override forces ORT down
// its dynamic-import() code path to load the glue module, which service
// workers reject. Left unset, ORT uses the bundler-inlined glue.
env.allowLocalModels = false;
const ortWasm = env.backends.onnx.wasm!;
ortWasm.numThreads = 1; // workers can't spawn nested Workers
ortWasm.proxy = false;

// Firefox extension pages may lack the Cache API; probe before transformers
// tries to use it (failure mode is a hard throw during model load).
async function probeBrowserCache(): Promise<void> {
  try {
    await caches.open('flowguard-probe');
    env.useBrowserCache = true;
  } catch {
    env.useBrowserCache = false;
    console.warn('[FlowGuard] Cache API unavailable — model re-downloads each session');
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
    console.log(`[FlowGuard] downloading ${p.file}: ${p.progress.toFixed(0)}%`);
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
// + active labels + seed/user-correction texts) changes, cached in
// storage.local so a fresh SW start skips the ~1s rebuild.
type CentroidCache = { version: string; names: string[]; vectors: number[][] };

let centroidsInFlight: Promise<CentroidCache> | null = null;

async function getCentroids(labels: string[]): Promise<CentroidCache & { buildMs: number }> {
  const specs = centroidSpecs(labels, await getPrototypeExamples());
  const version = prototypesVersion(EMBED_MODEL_ID, specs);

  const stored = await api.storage.local.get('centroidCache');
  const cached = stored.centroidCache as CentroidCache | undefined;
  if (cached && cached.version === version) return { ...cached, buildMs: 0 };

  // Another call may already be rebuilding the same version — don't duplicate.
  if (centroidsInFlight) {
    const inFlight = await centroidsInFlight;
    if (inFlight.version === version) return { ...inFlight, buildMs: 0 };
  }

  const t0 = performance.now();
  centroidsInFlight = (async () => {
    const names: string[] = [];
    const vectors: number[][] = [];
    // One embed batch per centroid (~8 texts) keeps peak memory low.
    for (const spec of specs) {
      const { vectors: vecs } = await embedTexts(spec.texts);
      names.push(spec.name);
      vectors.push(meanNormalize(vecs));
    }
    const built: CentroidCache = { version, names, vectors };
    await api.storage.local.set({ centroidCache: built });
    return built;
  })();
  try {
    const built = await centroidsInFlight;
    console.log(
      `[FlowGuard] built ${built.names.length} centroids (${version}) in ` +
        `${Math.round(performance.now() - t0)}ms`,
    );
    return { ...built, buildMs: performance.now() - t0 };
  } finally {
    centroidsInFlight = null;
  }
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

// Embed backend: one forward pass for the text, then cosine + softmax against
// the centroid store. Centroid (re)build cost is reported as loadMs.
async function classifyEmbed(text: string, labels: string[]): Promise<InferResult> {
  const centroids = await getCentroids(labels);
  const { vectors, loadMs, inferMs } = await embedTexts([text]);
  const verdict = classifyBySimilarity(
    vectors[0],
    centroids.names.map((name, i) => ({ name, vec: centroids.vectors[i] })),
    SOFTMAX_TEMPERATURE,
  );
  return { ...verdict, loadMs: loadMs + centroids.buildMs, inferMs };
}

export async function classify(input: ClassifyInput): Promise<ClassifyOutcome> {
  const { labels } = await getSettings();

  // The cache key spans every signal (title/channel/context) AND the model
  // key (backend + model + centroid version), so model switches and user
  // corrections never serve stale verdicts. Centroid-version lookup is only
  // meaningful on the embed backend.
  const modelKey =
    CLASSIFIER_BACKEND === 'embed'
      ? `embed:${EMBED_MODEL_ID}:${prototypesVersion(
          EMBED_MODEL_ID,
          centroidSpecs(labels, await getPrototypeExamples()),
        )}`
      : `nli:${MODEL_ID}`;
  const key = inputCacheKey(input, modelKey);
  const text = buildClassifierText(input);

  const cache = await getTitleCache();
  const hit = cache.get(key);
  if (hit) {
    return { text, ...hit, loadMs: 0, inferMs: 0, cached: true };
  }

  // Offscreen on Chrome/Edge keeps the model alive past SW idle; Firefox runs
  // the pipeline in-process. Labels are user-configurable (settings page) and
  // read per classification so changes apply without a reload.
  let infer: InferResult;
  if (CLASSIFIER_BACKEND === 'embed') {
    infer = await classifyEmbed(text, labels);
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
