import { api } from '../shared/api';
import { CLASSIFIER_BACKEND, EMBED_MODEL_ID, MODEL_ID, TEST_TITLES } from '../shared/config';
import { addOverride } from '../shared/overrides';
import { addFeedback } from '../shared/feedback';
import { getLockStatus } from '../shared/lock';
import { getSettings } from '../shared/settings';
import { NEUTRAL_PREFIX } from '../shared/prototypes';
import { cleanTitle } from '../shared/titles';
import { hostnameOf } from '../shared/url-signals';
import type {
  BreakResponse,
  CompanionStatusResponse,
  DeleteSharedFeedbackResponse,
  LockTypeResponse,
  Request,
  SharedFeedbackInfoResponse,
  SubItemsResponse,
  TestPairResponse,
  UsageStatsResponse,
} from '../shared/messages';
import { classify } from './classifier';
import { consumeOverrideToken } from './override-tokens';
import { evaluateSubItems, initBlocker, sweepOpenTabs } from './blocker';
import { cancelConfiguredBreak, requestBreakChallenge, startConfiguredBreak } from './breaks';
import { getCompanionSnapshot, initCompanionBridge } from './companion';
import { deleteSharedFeedback, getExistingInstallId, initFeedbackUploader } from './feedback-uploader';
import { initLockEnforcer } from './lock-enforcer';
import {
  attemptRandomTextUnlock,
  cancelDelayUnlockRpc,
  completeDelayUnlockRpc,
  requestRandomTextUnlockChallenge,
  startDelayUnlockRpc,
} from './lock-types';
import { initResumeEnforcer } from './resume-enforcer';
import { scanHistory } from './history-ingester';
import { initFocusSessionCommitter } from '../shared/focus-session';
import { recordTabStatus } from '../shared/tab-status';
import {
  clearUsageStatsSnapshot,
  getUsageStatsSnapshot,
  initUsageStats,
  recordUsageOverrideAction,
} from './usage-stats';

console.log('[SmartBlocker] background started');

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
initLockEnforcer();
initResumeEnforcer(); // registers runtime.onStartup here (auto-resume, constraint #4)
initCompanionBridge();
initFocusSessionCommitter();
initUsageStats();

// First-run onboarding: open the 3-step welcome wizard (options.html#welcome)
// so the user picks what to block. Plain options.html never forces the
// wizard — it shows a "Finish setup" banner instead (e2e opens it fresh).
api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void api.tabs.create({ url: api.runtime.getURL('options.html#welcome') });
});

api.runtime.onMessage.addListener(
  (
    msg: Request,
    sender,
    sendResponse: (
      r:
        | TestPairResponse
        | BreakResponse
        | LockTypeResponse
        | CompanionStatusResponse
        | SubItemsResponse
        | SharedFeedbackInfoResponse
        | DeleteSharedFeedbackResponse
        | UsageStatsResponse,
    ) => void,
  ) => {
    // Defense-in-depth (red-team #34): only this extension's own contexts
    // (options/popup/content scripts) may invoke these handlers. Web pages
    // can't reach runtime messaging today (no externally_connectable) — this
    // keeps the handlers unreachable if that ever regresses.
    if (sender.id !== api.runtime.id) return false;
    if (msg?.type === 'EVAL_SUBITEMS') {
      evaluateSubItems(msg.items ?? [], sender.tab?.id)
        .then((results) => sendResponse({ ok: true, results }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
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
      // While locked, a genuine block screen has no override button, so any
      // OVERRIDE arriving is stale or forged: drop it entirely — including
      // the feedback record, since false-positive feedback loosens the
      // classifier via the user-approved neutral centroid.
      void (async () => {
        if ((await getLockStatus()).settingsLocked) return;
        // Only a genuine rendered block screen may allowlist: the nonce
        // minted at injection is consumed once, so replayed or forged
        // OVERRIDE messages can't write overrides or feedback.
        if (!(await consumeOverrideToken(msg.nonce))) return;
        const overrideUrl = sender.tab?.url ?? msg.url ?? '';
        await addOverride(msg.title, hostnameOf(overrideUrl));
        // Count only this authenticated user action, never an "overridden"
        // status produced by an old allow rule or a page-supplied event. A
        // local stats outage must not interrupt the existing override flow.
        await recordUsageOverrideAction({ url: overrideUrl, category: msg.label ?? '' }).catch(
          (error) => console.warn('[SmartBlocker] usage override counter failed:', error),
        );
        // Popup "This page" card: reflect the override immediately.
        if (sender.tab?.id !== undefined && sender.tab.url) {
          void recordTabStatus(sender.tab.id, {
            url: sender.tab.url,
            title: msg.title,
            kind: 'overridden',
            label: msg.label,
            score: msg.score,
            ts: Date.now(),
          });
        }
        await addFeedback({
          kind: 'false_positive',
          title: msg.title,
          domain: domainOf(sender.tab?.url ?? msg.url),
          modelLabel: msg.label ?? '',
          score: msg.score ?? 0,
          modelId: ACTIVE_MODEL_ID,
          extVersion: api.runtime.getManifest().version,
          ts: Date.now(),
        });
      })().catch((e) => console.error('[SmartBlocker] override handling failed:', e));
    }
    if (msg?.type === 'REPORT_FN') {
      // Popup's "this page should have been blocked" — classify (usually a
      // cache hit) so the record captures the verdict being corrected.
      (async () => {
        // Mirror the OVERRIDE guard: while locked, forged corrections must
        // not weaken the classifier (red-team 2026-11 — this handler was the
        // remaining unguarded feedback write path).
        if ((await getLockStatus()).settingsLocked) {
          sendResponse({ ok: false, error: 'locked' });
          return;
        }
        // correctedLabel becomes a centroid key — only a configured,
        // non-neutral label may be recorded; anything else (e.g. a forged
        // 'neutral: …' key) would mint a never-block centroid on demand.
        const settings = await getSettings();
        if (
          !settings.labels.includes(msg.correctedLabel) ||
          msg.correctedLabel.startsWith(NEUTRAL_PREFIX)
        ) {
          sendResponse({ ok: false, error: 'unknown label' });
          return;
        }
        const title = cleanTitle(msg.title) || msg.title;
        // The correction itself is the user's correctedLabel; the model's
        // current verdict is context only. Never let a cold/stalled model
        // download hang the popup's "Report" button — record without it.
        const outcome = await Promise.race([
          classify({ title }).catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
        ]);
        await addFeedback({
          kind: 'false_negative',
          title,
          domain: domainOf(msg.url),
          modelLabel: outcome?.label ?? '',
          score: outcome?.score ?? 0,
          correctedLabel: msg.correctedLabel,
          modelId: ACTIVE_MODEL_ID,
          extVersion: api.runtime.getManifest().version,
          ts: Date.now(),
        });
        void sweepOpenTabs();
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'START_DELAY_UNLOCK') {
      startDelayUnlockRpc()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'CANCEL_DELAY_UNLOCK') {
      cancelDelayUnlockRpc()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'COMPLETE_DELAY_UNLOCK') {
      completeDelayUnlockRpc()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'REQUEST_RANDOM_TEXT_UNLOCK_CHALLENGE') {
      requestRandomTextUnlockChallenge()
        .then(({ id, text }) => sendResponse({ ok: true, challengeId: id, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'ATTEMPT_RANDOM_TEXT_UNLOCK') {
      attemptRandomTextUnlock(msg.challengeId, msg.text)
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'REQUEST_BREAK_CHALLENGE') {
      requestBreakChallenge()
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'START_BREAK') {
      startConfiguredBreak(msg.mode, msg.text)
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'CANCEL_BREAK') {
      cancelConfiguredBreak()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'GET_USAGE_STATS') {
      getUsageStatsSnapshot()
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'CLEAR_USAGE_STATS') {
      clearUsageStatsSnapshot()
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'GET_COMPANION_STATUS') {
      (async () => {
        const snapshot = await getCompanionSnapshot();
        // With "Allow in Incognito" off, Incognito windows run no extension
        // pages at all and bypass blocking entirely — surface the state so
        // the options page can warn. Fail open (true): a query error should
        // never raise a false alarm about Incognito bypasses.
        const incognitoAllowed = await api.extension
          .isAllowedIncognitoAccess()
          .catch(() => true);
        sendResponse({ ok: true, snapshot, incognitoAllowed });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'GET_SHARED_FEEDBACK_INFO') {
      // Options page installId reveal (#32 P3) — read-only, never mints.
      getExistingInstallId()
        .then((installId) => sendResponse({ ok: true, installId }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'DELETE_SHARED_FEEDBACK') {
      // Options page self-service erasure (#32 P3). No lock guard: erasing
      // one's own shared records is a privacy right, not a bypass vector —
      // it weakens nothing the lock protects.
      deleteSharedFeedback()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
