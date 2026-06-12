import { api } from '../shared/api';
import { BLOCKED_LABELS, BLOCK_THRESHOLD, LATENCY_LOG_MAX } from '../shared/config';
import type { LatencySample } from '../shared/messages';
import { cleanTitle, isContentUrl } from '../shared/titles';
import { classify } from './classifier';
import { showOverlay } from './overlay';

// YouTube/Reddit are SPAs: most "navigations" never reload the page, and the
// document title only lands well after the navigation event. Strategy:
//  - onCommitted (full loads) and onHistoryStateUpdated (SPA navs) ARM the tab
//    and timestamp the navigation. The title is NOT ready at this point.
//  - tabs.onUpdated with changeInfo.title is the actual classification
//    trigger, with a per-tab last-title guard against title flicker.

const armedAt = new Map<number, number>(); // tabId -> nav commit epoch ms
const lastClassified = new Map<number, string>();

const WATCHED_HOST = /(^|\.)((youtube)|(reddit))\.com$/;

function isWatched(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return WATCHED_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function arm(tabId: number, url: string) {
  if (isWatched(url)) {
    armedAt.set(tabId, Date.now());
    lastClassified.delete(tabId);
  }
}

async function logSample(sample: LatencySample) {
  const { latencySamples = [] } = await api.storage.local.get('latencySamples');
  latencySamples.push(sample);
  while (latencySamples.length > LATENCY_LOG_MAX) latencySamples.shift();
  await api.storage.local.set({ latencySamples });
  console.log(
    `[FlowGuard] ${sample.blocked ? 'BLOCKED' : 'allowed'} "${sample.title}" -> ` +
      `${sample.label} (${(sample.score * 100).toFixed(0)}%) | ` +
      `pageDelay ${sample.pageDelayMs}ms, load ${Math.round(sample.loadMs)}ms, ` +
      `infer ${Math.round(sample.inferMs)}ms, inject ${Math.round(sample.injectMs)}ms, ` +
      `total ${Math.round(sample.totalMs)}ms${sample.cached ? ' (cached)' : ''}`,
  );
}

async function onTitle(tabId: number, rawTitle: string, url: string) {
  const title = cleanTitle(rawTitle);
  if (!title || lastClassified.get(tabId) === title) return;
  lastClassified.set(tabId, title);

  const tTitle = Date.now();
  const pageDelayMs = tTitle - (armedAt.get(tabId) ?? tTitle);
  armedAt.delete(tabId);

  const result = await classify(title);
  const blocked = BLOCKED_LABELS.has(result.label) && result.score >= BLOCK_THRESHOLD;

  let injectMs = 0;
  if (blocked) {
    const tInject = Date.now();
    try {
      await api.scripting.executeScript({
        target: { tabId },
        func: showOverlay,
        args: [result.label, result.score, Date.now() - tTitle],
      });
    } catch (e) {
      console.warn('[FlowGuard] overlay injection failed:', e);
    }
    injectMs = Date.now() - tInject;
  }

  await logSample({
    url,
    title,
    label: result.label,
    score: result.score,
    blocked,
    cached: result.cached,
    pageDelayMs,
    loadMs: result.loadMs,
    inferMs: result.inferMs,
    injectMs,
    totalMs: Date.now() - tTitle,
    ts: tTitle,
  });
}

export function initBlocker() {
  api.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) arm(d.tabId, d.url);
  });
  api.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId === 0) arm(d.tabId, d.url);
  });
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.title && tab.url && isContentUrl(tab.url)) {
      void onTitle(tabId, changeInfo.title, tab.url).catch((e) =>
        console.error('[FlowGuard] classification failed:', e),
      );
    }
  });
  api.tabs.onRemoved.addListener((tabId) => {
    armedAt.delete(tabId);
    lastClassified.delete(tabId);
  });
}
