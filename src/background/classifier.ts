import { env, pipeline } from '@huggingface/transformers';
import { api } from '../shared/api';
import { buildClassifierText, inputCacheKey } from '../shared/build-input';
import { HYPOTHESIS_TEMPLATE, MODEL_ID, TITLE_CACHE_MAX } from '../shared/config';
import { getSettings } from '../shared/settings';
import type { ClassifyInput, ClassifyOutcome, InferResult } from '../shared/messages';
import { classifyViaOffscreen, supportsOffscreen } from './classify-client';

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

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options?: { hypothesis_template?: string; multi_label?: boolean },
) => Promise<{ labels: string[]; scores: number[] }>;

let instance: Promise<ZeroShotPipeline> | null = null;

async function createPipeline(): Promise<ZeroShotPipeline> {
  // Firefox extension pages may lack the Cache API; probe before transformers
  // tries to use it (failure mode is a hard throw during model load).
  try {
    await caches.open('flowguard-probe');
    env.useBrowserCache = true;
  } catch {
    env.useBrowserCache = false;
    console.warn('[FlowGuard] Cache API unavailable — model re-downloads each session');
  }

  const pipe = await pipeline('zero-shot-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.progress != null) {
        console.log(`[FlowGuard] downloading ${p.file}: ${p.progress.toFixed(0)}%`);
      }
    },
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

export async function classify(input: ClassifyInput): Promise<ClassifyOutcome> {
  // Cache key spans every signal (title/channel/context); the model sees the
  // assembled text. Both come from build-input so they stay in lockstep.
  const key = inputCacheKey(input);
  const text = buildClassifierText(input);

  const cache = await getTitleCache();
  const hit = cache.get(key);
  if (hit) {
    return { text, ...hit, loadMs: 0, inferMs: 0, cached: true };
  }

  // Labels are user-configurable (settings page); read them per classification
  // so changes apply without a reload. Offscreen on Chrome/Edge keeps the model
  // alive past SW idle; Firefox runs the pipeline in-process.
  const { labels } = await getSettings();
  const infer = supportsOffscreen()
    ? await classifyViaOffscreen(text, labels)
    : await classifyInProcess(text, labels);

  const entry: CacheEntry = { label: infer.label, score: infer.score, all: infer.all };
  cache.set(key, entry);
  persistTitleCache(cache);

  return { text, ...entry, loadMs: infer.loadMs, inferMs: infer.inferMs, cached: false };
}
