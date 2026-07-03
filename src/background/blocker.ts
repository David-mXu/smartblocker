import { api } from '../shared/api';
import { LATENCY_LOG_MAX } from '../shared/config';
import { getSettings } from '../shared/settings';
import { isOverridden } from '../shared/overrides';
import type { ClassifyOutcome, LatencySample } from '../shared/messages';
import { cleanTitle, hostnameOf, isClassifiableUrl, isWhitelisted, matchedBlocklistEntry } from '../shared/titles';
import { BLOCKLISTED_LABEL, WHITELISTED_LABEL, recordVisit } from '../shared/usage-stats';
import { extractMeta } from '../content/extract-meta';
import { classify } from './classifier';
import { noteVerdict } from './usage-tracker';
import { showBlockScreen } from './blockscreen';

/** The fields onTitle actually needs, shared by the ML path and the
 *  deterministic blocklist short-circuit (which skips classify() entirely). */
type BlockDecisionInput = Pick<ClassifyOutcome, 'label' | 'score' | 'cached' | 'loadMs' | 'inferMs'>;

// FlowGuard watches EVERY http(s) site (whitelist exemption applied later, in
// onTitle). Many sites are SPAs: most "navigations" never reload the page, and
// the document title only lands well after the navigation event. Strategy:
//  - onCommitted (full loads) and onHistoryStateUpdated (SPA / in-tab route
//    changes) ARM the tab and timestamp the navigation. Title NOT ready yet.
//  - tabs.onUpdated with changeInfo.title is the actual classification
//    trigger, with a per-tab last-title guard against title flicker.

const armedAt = new Map<number, number>(); // tabId -> nav commit epoch ms
const lastClassified = new Map<number, string>();

function arm(tabId: number, url: string) {
  if (isClassifiableUrl(url)) {
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

// Pull richer page signals (channel, description/post-body snippet) from the
// live DOM. extractMeta is self-contained so it serializes for executeScript.
async function gatherMeta(tabId: number): Promise<{ channel?: string; context?: string }> {
  try {
    const [inj] = await api.scripting.executeScript({ target: { tabId }, func: extractMeta });
    return (inj?.result as { channel?: string; context?: string } | undefined) ?? {};
  } catch {
    return {}; // page not injectable / navigated away — classify on the title alone
  }
}

async function onTitle(tabId: number, rawTitle: string, url: string) {
  const title = cleanTitle(rawTitle);
  if (!title || lastClassified.get(tabId) === title) return;
  lastClassified.set(tabId, title);

  const settings = await getSettings();
  if (!settings.enabled) {
    armedAt.delete(tabId);
    return; // master switch off — never classify or block
  }
  if (isWhitelisted(url, settings.whitelist)) {
    armedAt.delete(tabId);
    // Whitelisted pages are never classified, but the habit stats still want
    // them (they're the user's productive browsing).
    if (settings.trackUsage) {
      noteVerdict(tabId, url, WHITELISTED_LABEL);
      void recordVisit(hostnameOf(url), WHITELISTED_LABEL);
    }
    return; // user-exempted site — never classify or block
  }

  const tTitle = Date.now();
  const pageDelayMs = tTitle - (armedAt.get(tabId) ?? tTitle);
  armedAt.delete(tabId);

  // Deterministic blocklist short-circuit: skip the ML classifier entirely
  // when the URL/title matches a user rule (mirrors the isWhitelisted gate
  // above, just for the opposite outcome).
  const blocklistHit = matchedBlocklistEntry(url, title, settings.blocklist);

  let result: BlockDecisionInput;
  let blocked: boolean;
  if (blocklistHit) {
    result = { label: `blocked rule: "${blocklistHit}"`, score: 1, cached: false, loadMs: 0, inferMs: 0 };
    blocked = true;
  } else {
    const { channel, context } = await gatherMeta(tabId);
    result = await classify({ title, channel, context });
    blocked =
      settings.blockedLabels.includes(result.label) && result.score >= settings.blockThreshold;
  }
  // A prior "this is actually productive" correction wins over the model
  // (and over a blocklist match, so overrides always have the final say).
  if (blocked && (await isOverridden(title))) blocked = false;

  if (settings.trackUsage) {
    const statsLabel = blocklistHit ? BLOCKLISTED_LABEL : result.label;
    noteVerdict(tabId, url, statsLabel);
    void recordVisit(hostnameOf(url), statsLabel);
  }

  let injectMs = 0;
  if (blocked) {
    const tInject = Date.now();
    try {
      await api.scripting.executeScript({
        target: { tabId },
        func: showBlockScreen,
        args: [result.label, result.score, title, Date.now() - tTitle],
      });
    } catch (e) {
      console.warn('[FlowGuard] block screen injection failed:', e);
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
    if (changeInfo.title && tab.url && isClassifiableUrl(tab.url)) {
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
