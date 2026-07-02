import { api } from '../shared/api';
import { TEST_TITLES } from '../shared/config';
import { addOverride } from '../shared/overrides';
import type { Request, TestPairResponse } from '../shared/messages';
import { classify } from './classifier';
import { initBlocker } from './blocker';
import { scanHistory } from './history-ingester';

console.log('[FlowGuard] background started');

// MV3: all listeners must be registered synchronously at startup.
initBlocker();

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
      // Block screen's "this is actually productive" — record the correction.
      void addOverride(msg.title);
    }
    if (msg?.type === 'CLOSE_TAB') {
      // Block screen's "Stay focused" — close the distracting tab outright.
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void api.tabs.remove(tabId);
    }
    return false;
  },
);
