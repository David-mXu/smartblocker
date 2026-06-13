// Offscreen document: runs in a real document context (not a service worker),
// so the Transformers.js pipeline survives SW idle shutdown. This file handles
// ONLY pure inference — no caching, no settings, no title assembly. All of
// that lives SW-side in classify-client.ts + classifier.ts.
//
// Load-bearing constraints mirrored from classifier.ts + CLAUDE.md:
//   - inlineDynamicImports: true in the Vite config (never a reachable dynamic import())
//   - NEVER set env.backends.onnx.wasm.wasmPaths (forces ORT dynamic-import path)
//   - numThreads=1, proxy=false (offscreen page cannot spawn nested Workers)
//   - Probe Cache API before Transformers.js uses it
//   - format: 'iife' — the offscreen page HAS a document, so ORT can use
//     document.baseURI to resolve the .wasm asset; ES module not required here.

import { env, pipeline } from '@huggingface/transformers';
import { api } from '../../shared/api';
import { HYPOTHESIS_TEMPLATE, MODEL_ID } from '../../shared/config';
import type { InferResult, Request } from '../../shared/messages';

// ---- MV3 environment config (mirrored from classifier.ts) ----
// Do NOT set env.backends.onnx.wasm.wasmPaths: any override forces ORT down
// its dynamic-import() code path, which fails in restricted extension contexts.
env.allowLocalModels = false;
const ortWasm = env.backends.onnx.wasm!;
ortWasm.numThreads = 1; // offscreen pages cannot spawn nested Workers
ortWasm.proxy = false;

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options?: { hypothesis_template?: string; multi_label?: boolean },
) => Promise<{ labels: string[]; scores: number[] }>;

let instance: Promise<ZeroShotPipeline> | null = null;

async function createPipeline(): Promise<ZeroShotPipeline> {
  // Probe Cache API before Transformers.js tries to use it — failure mode is
  // a hard throw during model load (mirrored from classifier.ts createPipeline).
  try {
    await caches.open('flowguard-probe');
    env.useBrowserCache = true;
  } catch {
    env.useBrowserCache = false;
    console.warn('[FlowGuard/offscreen] Cache API unavailable — model re-downloads each session');
  }

  const pipe = await pipeline('zero-shot-classification', MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.progress != null) {
        console.log(`[FlowGuard/offscreen] downloading ${p.file}: ${p.progress.toFixed(0)}%`);
      }
    },
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

// ---- Message listener ----
// Chrome MV3 rule: async message handlers MUST use sendResponse + `return true`.
// Returning a Promise from onMessage does NOT work in Chrome.
api.runtime.onMessage.addListener(
  (message: Request, _sender, sendResponse: (result: InferResult | { error: string }) => void) => {
    if (message.type !== 'CLASSIFY') {
      // Not our message — return false so the channel stays open for other listeners.
      return false;
    }

    const { text, labels } = message;

    (async () => {
      try {
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
        console.error('[FlowGuard/offscreen] classify error:', msg);
        sendResponse({ error: msg });
      }
    })();

    // Return true to keep the message channel open while the async work runs.
    return true;
  },
);

console.log('[FlowGuard/offscreen] document ready, classifier will load on first message');
