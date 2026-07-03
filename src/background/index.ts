import { api } from '../shared/api';
import { CLASSIFIER_BACKEND, EMBED_MODEL_ID, MODEL_ID, TEST_TITLES } from '../shared/config';
import { addOverride } from '../shared/overrides';
import { addFeedback } from '../shared/feedback';
import { cleanTitle } from '../shared/titles';
import type { Request, TestPairResponse } from '../shared/messages';
import { classify } from './classifier';
import { initBlocker } from './blocker';
import { initFeedbackUploader } from './feedback-uploader';
import { initUsageTracker } from './usage-tracker';
import { scanHistory } from './history-ingester';

console.log('[FlowGuard] background started');

const ACTIVE_MODEL_ID = CLASSIFIER_BACKEND === 'embed' ? EMBED_MODEL_ID : MODEL_ID;

/** Hostname only — feedback records never store or share the full URL. */
function domainOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

// MV3: all listeners must be registered synchronously at startup.
initBlocker();
initFeedbackUploader();
initUsageTracker();

// First-run onboarding: open the settings page so the user picks what to block.
api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') api.runtime.openOptionsPage();
});

api.runtime.onMessage.addListener(
  (msg: Request, sender, sendResponse: (r: TestPairResponse) => void) => {
    if (msg?.type === 'TEST_PAIR') {
      (async () => {
        const results = [];
        for (const t of TEST_TITLES) results.push(await classify({ title: t }));
        sendResponse({ ok: true, results });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep the message channel open for the async response
    }
    if (msg?.type === 'SCAN_HISTORY') {
      // Fire and forget — the popup polls storage.local.historyScan.
      void scanHistory();
      sendResponse({ ok: true });
    }
    if (msg?.type === 'OVERRIDE') {
      // Block screen's "this is actually productive" — record the correction
      // (title-only override for the allow-list, rich record for feedback).
      void addOverride(msg.title);
      addFeedback({
        kind: 'false_positive',
        title: msg.title,
        domain: domainOf(sender.tab?.url ?? msg.url),
        modelLabel: msg.label ?? '',
        score: msg.score ?? 0,
        modelId: ACTIVE_MODEL_ID,
        extVersion: api.runtime.getManifest().version,
        ts: Date.now(),
      }).catch((e) => console.error('[FlowGuard] feedback write failed:', e));
    }
    if (msg?.type === 'REPORT_FN') {
      // Popup's "this page should have been blocked" — classify (usually a
      // cache hit) so the record captures the verdict being corrected.
      (async () => {
        const title = cleanTitle(msg.title) || msg.title;
        const outcome = await classify({ title });
        await addFeedback({
          kind: 'false_negative',
          title,
          domain: domainOf(msg.url),
          modelLabel: outcome.label,
          score: outcome.score,
          correctedLabel: msg.correctedLabel,
          modelId: ACTIVE_MODEL_ID,
          extVersion: api.runtime.getManifest().version,
          ts: Date.now(),
        });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'CLOSE_TAB') {
      // Block screen's "Stay focused" — close the distracting tab outright.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void api.tabs.remove(tabId);
    }
    return false;
  },
);
