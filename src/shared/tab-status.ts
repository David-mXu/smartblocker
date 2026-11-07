import { api } from './api';

/**
 * Per-tab "what did SmartBlocker decide about this page?" record — the data
 * behind the popup's "This page" card (docs/design-notes.md §5 Popup).
 *
 * Written by background/blocker.ts at the end of every main-frame decision,
 * read directly by the popup. Lives in storage.session (memory-only, cleared
 * when the browser closes, never synced) under ONE KEY PER TAB so concurrent
 * verdicts on different tabs can't race a shared read-modify-write object.
 * Where storage.session is unavailable (old Firefox) every call is a no-op and
 * the popup falls back to what it can derive itself (allowed list, blocklist,
 * paused, unsupported page).
 */

export type TabStatusKind =
  /** Classified and allowed (top label not blocked, or under threshold). */
  | 'allowed'
  /** Classified and blocked (block screen / DNR redirect shown). */
  | 'blocked'
  /** Blocked instantly by an "Always block" keyword/URL rule. */
  | 'blocked-rule'
  /** Would have been blocked, but the user said "this is actually productive". */
  | 'overridden'
  /** A browse/search surface deliberately never blocked (YouTube home, search). */
  | 'browsing';

export interface TabStatus {
  /** Page URL the verdict belongs to (popup ignores it if the tab moved on). */
  url: string;
  title: string;
  kind: TabStatusKind;
  /** Top category (plain label, e.g. "video games") — absent for rules. */
  label?: string;
  /** Top score 0..1 — absent for rules. */
  score?: number;
  /** The "Always block" entry that matched, for kind === 'blocked-rule'. */
  rule?: string;
  ts: number;
}

const keyFor = (tabId: number) => `tabStatus:${tabId}`;

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return (api.storage as { session?: chrome.storage.StorageArea }).session ?? null;
  } catch {
    return null;
  }
}

export async function recordTabStatus(tabId: number, status: TabStatus): Promise<void> {
  const area = sessionArea();
  if (!area || tabId < 0) return;
  try {
    await area.set({ [keyFor(tabId)]: status });
  } catch {
    /* quota / unavailable — the popup degrades gracefully */
  }
}

export async function clearTabStatus(tabId: number): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(keyFor(tabId));
  } catch {
    /* ignore */
  }
}

/** Strip the fragment so in-page anchors don't orphan a verdict. */
function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
}

/** The recorded status for `tabId`, or null if none / it belongs to an older URL. */
export async function getTabStatus(tabId: number, currentUrl: string): Promise<TabStatus | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const got = await area.get(keyFor(tabId));
    const s = got[keyFor(tabId)] as TabStatus | undefined;
    if (!s || !samePage(s.url, currentUrl)) return null;
    return s;
  } catch {
    return null;
  }
}
