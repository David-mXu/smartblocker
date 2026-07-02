// classify-client.ts — runs in the SERVICE WORKER.
//
// Provides supportsOffscreen() and classifyViaOffscreen() so the orchestrator
// (classifier.ts / blocker.ts) can route inference through the offscreen
// document on Chrome/Edge, falling back to the in-process pipeline on Firefox.
//
// DOES NOT: cache, read settings, or assemble classifier text. Those all
// remain SW-side so they are isolated from the offscreen document.

import { api, IS_FIREFOX } from '../shared/api';
import type { EmbedResult, InferResult } from '../shared/messages';

// The URL must match the path Vite emits into dist/<mode>/offscreen.html.
const OFFSCREEN_URL = 'offscreen.html';

/** True only on Chrome/Edge — Firefox has no offscreen API. */
export function supportsOffscreen(): boolean {
  return (
    !IS_FIREFOX &&
    typeof chrome !== 'undefined' &&
    // chrome.offscreen is only present on Chrome/Edge MV3; guard the access.
    !!chrome.offscreen
  );
}

// Module-level in-flight promise guards against the race condition where two
// concurrent calls both try to create the document (Chrome throws "Only a
// single offscreen document may be created at a time" on the second attempt).
let creatingDoc: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  // Prefer the native hasDocument API when available (Chrome 116+).
  if (chrome.offscreen.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  }

  // If a creation is already in flight, wait for it — don't race.
  if (creatingDoc) {
    return creatingDoc;
  }

  creatingDoc = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification:
        'Run the local text-classification model off the service worker so it survives SW idle shutdown.',
    })
    .catch((e: unknown) => {
      // "already exists" can occur if two SW instances race; treat it as success.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already')) {
        throw e;
      }
    })
    .finally(() => {
      creatingDoc = null;
    });

  return creatingDoc;
}

/**
 * Ensure the offscreen document is alive, then send a CLASSIFY message to it
 * and return the raw InferResult. The caller (classifier.ts) is responsible
 * for caching and verdict logic.
 */
export async function classifyViaOffscreen(
  text: string,
  labels: string[],
): Promise<InferResult> {
  await ensureOffscreenDocument();

  const response = await api.runtime.sendMessage({
    type: 'CLASSIFY' as const,
    text,
    labels,
  });

  // The offscreen document sends back either an InferResult or { error: string }.
  if (response && typeof response === 'object' && 'error' in response) {
    throw new Error(`[FlowGuard/offscreen] ${(response as { error: string }).error}`);
  }

  return response as InferResult;
}

/**
 * Ensure the offscreen document is alive, then send an EMBED message to it
 * and return the raw EmbedResult (one normalized vector per input text).
 * Centroid math and caching are the caller's (classifier.ts) concern.
 */
export async function embedViaOffscreen(texts: string[]): Promise<EmbedResult> {
  await ensureOffscreenDocument();

  const response = await api.runtime.sendMessage({ type: 'EMBED' as const, texts });

  if (response && typeof response === 'object' && 'error' in response) {
    throw new Error(`[FlowGuard/offscreen] ${(response as { error: string }).error}`);
  }

  return response as EmbedResult;
}
