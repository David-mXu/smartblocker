// Focus-time tracker: attributes real focused time (active tab, focused
// window, user not idle) to hostnames, feeding the usage-stats store behind
// the opt-in `trackUsage` setting (default OFF).
//
// Mechanics: exactly one "open span" { domain, label, start } exists while a
// classifiable tab is focused. Every focus-changing event (tab switch, URL
// change, window focus, idle transition) CLOSES the open span — attributing
// `now - start` — and opens a new one for whatever is focused now. The open
// span lives in storage.local, not memory: the MV3 service worker routinely
// dies between events, and the closing event (which wakes the SW) must still
// see the span the dead SW opened. Only runtime.onStartup treats a leftover
// span as stale (browser was killed mid-span) and clamps it.
//
// Known limitation: chrome.idle is input-based, so passive watching (a video
// playing while the mouse is untouched) goes idle after IDLE_SECONDS and
// undercounts — acceptable for v1.
import { api } from '../shared/api';
import { getSettings } from '../shared/settings';
import { addFocusMs, WHITELISTED_LABEL } from '../shared/usage-stats';
import { cleanTitle, hostnameOf, isClassifiableUrl, isWhitelisted } from '../shared/titles';
import { classify } from './classifier';

const SPAN_KEY = 'usageOpenSpan';
const IDLE_SECONDS = 60;

interface OpenSpan {
  domain: string;
  label: string;
  start: number;
}

// Last verdict per tab, fed by the blocker so span labels are usually free.
// In-memory only: after a SW restart the classify() fallback (titleCache-
// backed) fills the gap.
const tabVerdicts = new Map<number, { domain: string; label: string }>();

export function noteVerdict(tabId: number, url: string, label: string): void {
  const domain = hostnameOf(url);
  if (domain) tabVerdicts.set(tabId, { domain, label });
}

export function forgetTab(tabId: number): void {
  tabVerdicts.delete(tabId);
}

// Focus events arrive in bursts (rapid tab switching fires onActivated +
// onFocusChanged together); serialize handling so close/open pairs never
// interleave and double-attribute.
let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn).catch((e) => console.error('[FlowGuard] usage tracker:', e));
}

async function closeOpenSpan(clampMs = Infinity): Promise<void> {
  const stored = await api.storage.local.get(SPAN_KEY);
  const span = stored[SPAN_KEY] as OpenSpan | undefined;
  if (!span) return;
  await api.storage.local.remove(SPAN_KEY);
  const ms = Math.min(Date.now() - span.start, clampMs);
  await addFocusMs(span.domain, span.label, ms);
}

async function resolveTab(tab: chrome.tabs.Tab): Promise<OpenSpan | null> {
  if (!tab.url || !isClassifiableUrl(tab.url)) return null;
  const domain = hostnameOf(tab.url);
  if (!domain) return null;
  const { whitelist } = await getSettings();
  if (isWhitelisted(tab.url, whitelist)) return { domain, label: WHITELISTED_LABEL, start: 0 };
  const known = tab.id !== undefined ? tabVerdicts.get(tab.id) : undefined;
  if (known && known.domain === domain) return { ...known, start: 0 };
  const title = cleanTitle(tab.title ?? '');
  if (!title) return { domain, label: 'other', start: 0 };
  const { label } = await classify({ title }); // usually a titleCache hit
  return { domain, label, start: 0 };
}

/** Close the current span and open one for `tabId` (null = nothing focused). */
async function refocus(tabId: number | null): Promise<void> {
  const { trackUsage } = await getSettings();
  // Always close a leftover span (it was opened while tracking was on), but
  // only open a new one when tracking is currently enabled.
  await closeOpenSpan();
  if (!trackUsage || tabId === null) return;
  let tab: chrome.tabs.Tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    return; // tab already gone
  }
  const span = await resolveTab(tab);
  if (!span) return;
  span.start = Date.now();
  await api.storage.local.set({ [SPAN_KEY]: span });
}

async function refocusActiveTab(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  await refocus(tab?.id ?? null);
}

export function initUsageTracker(): void {
  api.tabs.onActivated.addListener(({ tabId }) => {
    enqueue(() => refocus(tabId));
  });

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // In-tab navigation of the focused tab starts a new span (new domain/label).
    if (changeInfo.url && tab.active) enqueue(() => refocus(tabId));
  });

  api.tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
  });

  api.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === api.windows.WINDOW_ID_NONE) {
      enqueue(() => refocus(null)); // browser lost focus entirely
    } else {
      enqueue(refocusActiveTab);
    }
  });

  api.idle.onStateChanged.addListener((state) => {
    if (state === 'active') {
      enqueue(refocusActiveTab);
    } else {
      enqueue(() => refocus(null)); // idle or locked — stop the clock
    }
  });

  // Browser relaunch: a leftover span means the browser was killed mid-span
  // and we never saw a closing event. We can't know when input stopped, so
  // credit at most the idle threshold rather than hours of phantom focus.
  api.runtime.onStartup.addListener(() => {
    enqueue(() => closeOpenSpan(IDLE_SECONDS * 1000));
  });

  try {
    api.idle.setDetectionInterval(IDLE_SECONDS);
  } catch (e) {
    console.warn('[FlowGuard] idle.setDetectionInterval failed:', e);
  }
}
