import { api } from '../shared/api';
import { TEST_TITLES } from '../shared/config';
import type { Request, TestPairResponse } from '../shared/messages';
import { classify } from './classifier';
import { initBlocker } from './blocker';
import { scanHistory } from './history-ingester';

console.log('[FlowGuard] background started');

// MV3: all listeners must be registered synchronously at startup.
initBlocker();

api.runtime.onMessage.addListener(
  (msg: Request, _sender, sendResponse: (r: TestPairResponse) => void) => {
    if (msg?.type === 'TEST_PAIR') {
      (async () => {
        const results = [];
        for (const t of TEST_TITLES) results.push(await classify(t));
        sendResponse({ ok: true, results });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // keep the message channel open for the async response
    }
    if (msg?.type === 'SCAN_HISTORY') {
      // Fire and forget — the popup polls storage.local.historyScan.
      void scanHistory();
      sendResponse({ ok: true });
    }
    return false;
  },
);
