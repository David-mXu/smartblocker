// Data + wording for the toolbar popup. No React here: everything the popup
// shows is derived from plain values so it can be loaded BEFORE the first
// React render (popup.ts) — the popup opens at the size of its first paint,
// so rendering real data on the first frame is what keeps it from jumping.
import { api } from '../shared/api';
import { getSettings, type Settings } from '../shared/settings';
import { getLockState, getLockStatus } from '../shared/lock';
import type { LockStatus } from '../shared/lock-math';
import { getPendingFocusSession, type PendingFocusSession } from '../shared/focus-session';
import { getTabStatus, type TabStatus } from '../shared/tab-status';
import { isClassifiableUrl, matchedBlocklistEntry, matchingWhitelistEntries } from '../shared/titles';
import { hostnameOf } from '../shared/url-signals';
import { inlineLabel, NEUTRAL_LABEL_PREFIX } from '../shared/labels';
import type { CompanionSnapshot } from '../shared/companion-protocol';
import type { CompanionStatusResponse } from '../shared/messages';

export interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

export interface PopupData {
  settings: Settings;
  lock: LockStatus;
  /** Committed focus session end (lockState.frozenUntil), if still running. */
  frozenUntil: number | null;
  pending: PendingFocusSession | null;
  tab: ActiveTab | null;
  tabStatus: TabStatus | null;
  companion: CompanionSnapshot | null;
}

export async function getActiveTab(): Promise<ActiveTab | null> {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) return null;
    return { id: tab.id, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '' };
  } catch {
    return null;
  }
}

export async function loadFrozenUntil(now = Date.now()): Promise<number | null> {
  const state = await getLockState();
  return state.frozenUntil !== null && state.frozenUntil > now ? state.frozenUntil : null;
}

export async function loadCompanionSnapshot(): Promise<CompanionSnapshot | null> {
  try {
    // This is the existing background-cache RPC, not a daemon status query.
    const response = (await api.runtime.sendMessage({
      type: 'GET_COMPANION_STATUS',
    })) as CompanionStatusResponse;
    return response?.ok ? response.snapshot ?? null : null;
  } catch {
    return null; // Background restart or unavailable: never invent grace state.
  }
}

export async function loadPopupData(): Promise<PopupData> {
  const [settings, lock, frozenUntil, pending, tab, companion] = await Promise.all([
    getSettings(),
    getLockStatus(),
    loadFrozenUntil(),
    getPendingFocusSession(),
    getActiveTab(),
    loadCompanionSnapshot(),
  ]);
  const tabStatus = tab ? await getTabStatus(tab.id, tab.url) : null;
  return { settings, lock, frozenUntil, pending, tab, tabStatus, companion };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------


/** Plain category wording: strips the internal neutral prefix. */
export function categoryName(label: string | undefined): string {
  return label ? inlineLabel(label) : '';
}

export function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Team rule: never show a raw model score as the headline. */
export function likelihood(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return 'likely';
  if (score >= 0.85) return 'very likely';
  if (score >= 0.65) return 'likely';
  return 'possibly';
}

/** "3:40 PM", "1:15 AM tomorrow", or "Mon 3:40 PM" further out. */
export function formatEndTime(ts: number, now = Date.now()): string {
  const end = new Date(ts);
  const time = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const dayDiff = Math.round(
    (new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `${time} tomorrow`;
  return `${end.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "3h 12m", "45m", "under a minute". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "0:42" — for the undo countdown. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LOCK_REASON_NAMES: Record<LockStatus['reasons'][number], string> = {
  frozen: 'focus session',
  timer: 'timer lock',
  password: 'password lock',
  delay: 'delay lock',
  'random-text': 'random-text lock',
  schedule: 'focus hours',
  partner: 'accountability partner',
};

/** "Locked: focus session — 3h 12m left (until 3:40 PM)". Empty when unlocked. */
export function lockLineText(lock: LockStatus, now = Date.now()): string {
  if (!lock.settingsLocked) return '';
  const reasons = lock.reasons.map((r) => LOCK_REASON_NAMES[r]).join(' + ');
  if (lock.until === null) return `Locked: ${reasons} — unlock it in Settings`;
  return `Locked: ${reasons} — ${formatRemaining(lock.until - now)} left (until ${formatEndTime(lock.until, now)})`;
}

/** Short reason attached to every control disabled by a lock. */
export function lockedReason(lock: LockStatus, now = Date.now()): string {
  if (!lock.settingsLocked) return '';
  if (lock.until === null) {
    return lock.reasons.length === 1 && lock.reasons[0] === 'password'
      ? 'Locked by your password lock'
      : 'Locked — manage unlocks in Settings';
  }
  return `Locked until ${formatEndTime(lock.until, now)}`;
}

// ---------------------------------------------------------------------------
// "This page" derivation
// ---------------------------------------------------------------------------

export type Tone = 'allowed' | 'blocked' | 'neutral';

export interface PageView {
  /** What to print in mono at the top of the card ('' = nothing). */
  where: string;
  tone: Tone;
  headline: string;
  detail: string;
  /** Classifiable, not on the allowed list → offer "Always allow this site". */
  canAllowSite: boolean;
  /** Allowed by the classifier → offer "Should've been blocked". */
  canReport: boolean;
  /** Paused → the card's primary action turns blocking back on. */
  paused: boolean;
  /** Whitelist entries that exempt this host (for "Remove from allowed"). */
  allowedBy: string[];
}

// Matching rules come from the same URL-aware shared API as the allow verdict.
function describeNonWeb(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'Local file';
    if (u.protocol.endsWith('-extension:')) return 'Extension page';
    return `${u.protocol}//${u.host}`.replace(/\/\/$/, '');
  } catch {
    return '';
  }
}

const BASE: Omit<PageView, 'where' | 'tone' | 'headline' | 'detail'> = {
  canAllowSite: false,
  canReport: false,
  paused: false,
  allowedBy: [],
};

export function derivePageView(data: PopupData): PageView {
  const { tab, tabStatus, settings, lock } = data;
  const url = tab?.url ?? '';

  // Force-mode blocks redirect the tab to our own blocked.html: still a
  // block verdict, just shown on an extension page.
  if (url && url.startsWith(api.runtime.getURL('blocked.html'))) {
    let label = '';
    let score: number | undefined;
    let reason = '';
    try {
      const p = new URL(url).searchParams;
      label = categoryName(p.get('label') ?? '');
      const s = Number(p.get('score'));
      score = Number.isFinite(s) && s > 0 ? s : undefined;
      reason = p.get('reason') ?? '';
    } catch {
      /* fall through to a generic blocked line */
    }
    return {
      ...BASE,
      where: '',
      tone: 'blocked',
      headline: 'Blocked',
      detail:
        reason === 'classifier-unavailable'
          ? 'Blocked because SmartBlocker couldn’t check it during a lock.'
          : label.startsWith('channel block: ')
            ? `Matches your channel rule ${label.slice('channel block: '.length)}.`
            : label
              ? `${sentenceCase(likelihood(score))} ${label}.`
              : 'Blocked during your focus session.',
    };
  }

  if (!tab || !isClassifiableUrl(url)) {
    return {
      ...BASE,
      where: describeNonWeb(url),
      tone: 'neutral',
      headline: 'Not checked',
      detail: 'SmartBlocker doesn’t check this kind of page.',
    };
  }

  const host = hostnameOf(url);

  if (!settings.enabled && !lock.forceBlocking) {
    return {
      ...BASE,
      where: host,
      tone: 'neutral',
      headline: 'Blocking is paused',
      detail: 'Nothing is being blocked right now.',
      paused: true,
    };
  }

  const allowedBy = matchingWhitelistEntries(url, settings.whitelist);
  if (allowedBy.length > 0) {
    return {
      ...BASE,
      where: host,
      tone: 'allowed',
      headline: 'Always allowed',
      detail: 'It’s on your allowed sites, so it’s never checked.',
      allowedBy,
    };
  }

  const status = tabStatus;
  const rule = status?.kind === 'blocked-rule' ? status.rule : status ? null : matchedBlocklistEntry(url, tab.title, settings.blocklist);

  if (rule) {
    return {
      ...BASE,
      where: host,
      tone: 'blocked',
      headline: 'Blocked',
      detail: `Matches your rule “${rule}”.`,
      canAllowSite: true,
    };
  }

  if (!status) {
    return {
      ...BASE,
      where: host,
      tone: 'neutral',
      headline: 'Not checked yet',
      detail: 'Reload the page to check it.',
      canAllowSite: true,
    };
  }

  const label = categoryName(status.label);
  switch (status.kind) {
    case 'blocked':
      return {
        ...BASE,
        where: host,
        tone: 'blocked',
        headline: 'Blocked',
        detail: label ? `${sentenceCase(likelihood(status.score))} ${label}.` : 'Looks like a distraction.',
        canAllowSite: true,
      };
    case 'overridden':
      return {
        ...BASE,
        where: host,
        tone: 'allowed',
        headline: 'Allowed',
        detail: 'You marked this page as productive.',
        canAllowSite: true,
      };
    case 'browsing':
      return {
        ...BASE,
        where: host,
        tone: 'allowed',
        headline: 'Allowed',
        detail: 'The page stays open; individual video results can be masked.',
        canAllowSite: true,
      };
    case 'allowed':
    default: {
      let detail = 'Doesn’t look like a distraction.';
      if (status.label === NEUTRAL_LABEL_PREFIX + 'active focus context') {
        detail = 'Matches what you’re working on.';
      } else if (label && settings.blockedLabels.includes(label)) {
        detail = `Possibly ${label}, but not enough to block.`;
      } else if (label) {
        detail = `Looks like ${label}.`;
      }
      return {
        ...BASE,
        where: host,
        tone: 'allowed',
        headline: 'Allowed',
        detail,
        canAllowSite: true,
        canReport: true,
      };
    }
  }
}
