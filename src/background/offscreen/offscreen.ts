// Offscreen document: runs in a real document context (not a service worker),
// so the Transformers.js pipeline survives SW idle shutdown. This file handles
// ONLY pure inference — no caching, no settings, no title assembly. All of
// that lives SW-side in classify-client.ts + classifier.ts.
//
// Load-bearing constraints (see also vite.config.offscreen.ts + CLAUDE.md):
//   - inlineDynamicImports: true in the Vite config
//   - wasmPaths MUST be overridden to extension-local files here (unlike the
//     SW, where they must stay unset) — see the env config below
//   - Probe Cache API before Transformers.js uses it
//   - format: 'es' + <script type=module> (matches the background bundle)

import { env, pipeline } from '@huggingface/transformers';
import { api } from '../../shared/api';
import { EMBED_MODEL_ID, HYPOTHESIS_TEMPLATE, MODEL_ID } from '../../shared/config';
import type { EmbedResult, InferResult, Request } from '../../shared/messages';

// ---- MV3 environment config ----
// The SW rule is "never set wasmPaths" — transformers.js leaves them unset
// only inside a ServiceWorkerGlobalScope, where the bundler-inlined glue is
// used. The offscreen document is NOT a service worker, so transformers
// defaults wasmPaths to its jsdelivr CDN, which the extension CSP blocks
// ("Failed to fetch dynamically imported module ... jsep.mjs"). Override to
// the extension-local copies that copy-assets.mjs ships under their unhashed
// names; dynamic import() of a same-origin module is fine in a real document.
env.allowLocalModels = false;
const ortWasm = env.backends.onnx.wasm!;
ortWasm.wasmPaths = {
  mjs: api.runtime.getURL('ort-wasm-simd-threaded.jsep.mjs'),
  wasm: api.runtime.getURL('ort-wasm-simd-threaded.jsep.wasm'),
};
ortWasm.numThreads = 1; // 4 threads measured only ~11ms -> ~9ms p50 per embed — not worth 3 workers
ortWasm.proxy = false;

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options?: { hypothesis_template?: string; multi_label?: boolean },
) => Promise<{ labels: string[]; scores: number[] }>;

let instance: Promise<ZeroShotPipeline> | null = null;

// Probe Cache API before Transformers.js tries to use it — failure mode is
// a hard throw during model load (mirrored from classifier.ts).
async function probeBrowserCache(): Promise<void> {
  try {
    await caches.open('smartblocker-probe');
    env.useBrowserCache = true;
  } catch {
    env.useBrowserCache = false;
    console.warn('[SmartBlocker/offscreen] Cache API unavailable — model re-downloads each session');
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
    console.log(`[SmartBlocker/offscreen] downloading ${p.file}: ${p.progress.toFixed(0)}%`);
  }
};

async function createPipeline(): Promise<ZeroShotPipeline> {
  await probeBrowserCache();

  const pipe = await pipeline('zero-shot-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: logProgress,
  });
  return pipe as unknown as ZeroShotPipeline;
}

function getClassifier(): Promise<ZeroShotPipeline> {
  instance ??= createPipeline().catch((e) => {
    instance = null; // allow retry after a failed load
    throw e;
  });
  return instance;
}

// ---- Embedding pipeline (embed backend) ----
// feature-extraction with mean pooling + normalization; batch in, batch out.
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

async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const t0 = performance.now();
  const embedder = await getEmbedder();
  const tLoaded = performance.now();
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  const tDone = performance.now();
  // Output tensor is [batch, dim] with a flat data buffer — slice per input.
  const dim = out.dims[out.dims.length - 1];
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(out.data.slice(i * dim, (i + 1) * dim) as Float32Array));
  }
  return { vectors, loadMs: tLoaded - t0, inferMs: tDone - tLoaded };
}

// ---- Message listener ----
// Chrome MV3 rule: async message handlers MUST use sendResponse + `return true`.
// Returning a Promise from onMessage does NOT work in Chrome.
api.runtime.onMessage.addListener(
  (
    message: Request,
    _sender,
    sendResponse: (result: InferResult | EmbedResult | { error: string }) => void,
  ) => {
    if (message.type !== 'CLASSIFY' && message.type !== 'EMBED') {
      // Not our message — return false so the channel stays open for other listeners.
      return false;
    }

    (async () => {
      try {
        if (message.type === 'EMBED') {
          sendResponse(await embedTexts(message.texts));
          return;
        }

        const { text, labels } = message;
        const t0 = performance.now();
        const clf = await getClassifier();
        const tLoaded = performance.now();
        const out = await clf(text, labels, {
          hypothesis_template: HYPOTHESIS_TEMPLATE,
          multi_label: false,
        });
        const tDone = performance.now();

        const result: InferResult = {
          label: out.labels[0],
          score: out.scores[0],
          all: { labels: out.labels, scores: out.scores },
          loadMs: tLoaded - t0,
          inferMs: tDone - tLoaded,
        };
        sendResponse(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[SmartBlocker/offscreen] ${message.type} error:`, msg);
        sendResponse({ error: msg });
      }
    })();

    // Return true to keep the message channel open while the async work runs.
    return true;
  },
);

console.log('[SmartBlocker/offscreen] document ready, classifier will load on first message');
