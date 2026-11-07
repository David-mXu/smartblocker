// User-configurable settings, the single source of truth the classifier and
// blocker read at runtime. config.ts now holds only the DEFAULTS; everything
// here is overridable from the options page and persisted in storage.local.
import { api } from './api';
import {
  BLOCKED_LABELS,
  BLOCK_THRESHOLD,
  DEFAULT_WHITELIST,
  GOOGLE_PRODUCTIVE_HOSTS,
  LABELS,
  LEGACY_SEARCH_WHITELIST,
} from './config';
import { getLockStatus } from './lock';

export interface Settings {
  /** Candidate categories the zero-shot model scores against. */
  labels: string[];
  /** Subset of `labels` that triggers a block. */
  blockedLabels: string[];
  /** Minimum top-label score to block (0..1). */
  blockThreshold: number;
  /** Master kill switch — when false, nothing is ever blocked. */
  enabled: boolean;
  /** Set once the first-run onboarding flow has completed. */
  onboarded: boolean;
  /** Hostnames never classified/blocked. Matched by domain + subdomains. */
  whitelist: string[];
  /**
   * Schema version of `whitelist` — lets a default-list change (e.g. the v2
   * removal of search engines) reach existing installs exactly ONCE, so an
   * entry the user deliberately re-adds afterwards is respected.
   */
  whitelistVersion: number;
  /**
   * Deterministic block rules: substrings matched against the full URL + page
   * title. A match blocks immediately, skipping the ML classifier entirely.
   * Empty by default — opt-in, unlike the model-driven category blocking.
   */
  blocklist: string[];
  /**
   * Opt-in: share anonymized misclassification feedback (see PRIVACY.md) to
   * improve the model. OFF by default — SmartBlocker is telemetry-free unless
   * the user explicitly enables this on the options page.
   */
  shareFeedback: boolean;
  /**
   * Built-in labels the user has explicitly deleted. Tracked so that
   * migrateLabels() doesn't silently re-add them on extension updates.
   */
  deletedBuiltinLabels: string[];
  /**
   * Optional free-text description of what the user is currently working on
   * (e.g. "Studying React hooks and TypeScript", "Filing taxes"). Empty by
   * default — when set, it feeds the context-aware disambiguation pass.
   */
  focusGoal: string;
  /**
   * Opt-in: let the context pass look at currently open productive tabs (plus
   * `focusGoal`) to disambiguate gray-zone pages. OFF by default — reading
   * open tabs is a stronger privacy step than classifying the single page.
   */
  useTabContext: boolean;
  /**
   * Opt-in: resolve titles of embedded YouTube videos/SERP cards through
   * YouTube's oEmbed endpoint when the page DOM gives no usable title.
   * OFF by default (red-team P1 #9): each lookup sends the YouTube video ID
   * to www.youtube.com, which is browsing-metadata egress. Never fires for
   * youtube-nocookie or privacy-facade embeds even when enabled. See the
   * "Network requests" section of PRIVACY.md.
   */
  resolveEmbedTitles: boolean;
}

/** v1: original list (search engines whitelisted). v2 (2026-11-07): search
 *  roots removed, `google.com` replaced by its productive subdomains. */
export const WHITELIST_VERSION = 2;

export const DEFAULTS: Settings = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
  whitelist: [...DEFAULT_WHITELIST],
  whitelistVersion: WHITELIST_VERSION,
  blocklist: [],
  shareFeedback: false,
  deletedBuiltinLabels: [],
  focusGoal: '',
  useTabContext: false,
  resolveEmbedTitles: false,
};

const STORAGE_KEY = 'settings';

let cache: Settings | null = null;

// Invalidate the in-memory cache when any context (options page, popup) writes
// new settings, so a long-lived service worker / offscreen doc sees changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/**
 * `labels`/`blockedLabels` are persisted snapshots taken at onboarding time,
 * so they go stale whenever config.ts's LABELS/BLOCKED_LABELS grow (e.g. the
 * 13-category expansion) — an existing user's stored settings would silently
 * keep classifying against only their old label set forever. Append any
 * canonical label missing from the stored snapshot (preserving user order/
 * edits otherwise), carrying over the new label's default blocked-ness.
 */
function migrateLabels(stored: Partial<Settings> | undefined): Pick<Settings, 'labels' | 'blockedLabels'> {
  if (!stored?.labels) {
    return { labels: [...DEFAULTS.labels], blockedLabels: [...DEFAULTS.blockedLabels] };
  }
  const known = new Set(stored.labels);
  const deleted = new Set(stored.deletedBuiltinLabels ?? []);
  // Append canonical labels the user hasn't seen yet, but skip any they
  // explicitly deleted — otherwise updates would silently re-add them.
  const newLabels = LABELS.filter((l) => !known.has(l) && !deleted.has(l));
  if (newLabels.length === 0) {
    return { labels: stored.labels, blockedLabels: stored.blockedLabels ?? [...DEFAULTS.blockedLabels] };
  }
  return {
    labels: [...stored.labels, ...newLabels],
    blockedLabels: [
      ...(stored.blockedLabels ?? []),
      ...newLabels.filter((l) => BLOCKED_LABELS.has(l)),
    ],
  };
}

/**
 * Bring a stored whitelist up to WHITELIST_VERSION. Runs at READ time (like
 * migrateLabels), so it also applies while settings are locked — safe, since
 * it only ever shrinks the exemption set (stricter, never looser) — and is
 * persisted by the next setSettings(). v1 → v2: strip the legacy search-engine
 * roots (whitelisting "google.com" exempted Google News, image viewers and
 * inline video previews — the standard YouTube bypass) and, if "google.com"
 * was present, keep its productive subdomains working by adding them back
 * explicitly.
 */
export function migrateWhitelist(
  stored: Partial<Settings> | undefined,
): Pick<Settings, 'whitelist' | 'whitelistVersion'> {
  if (!stored?.whitelist) {
    return { whitelist: [...DEFAULT_WHITELIST], whitelistVersion: WHITELIST_VERSION };
  }
  const version = stored.whitelistVersion ?? 1;
  if (version >= WHITELIST_VERSION) {
    return { whitelist: stored.whitelist, whitelistVersion: version };
  }
  const norm = (e: string) => e.trim().toLowerCase().replace(/^www\./, '');
  const legacy = new Set(LEGACY_SEARCH_WHITELIST);
  const hadGoogleRoot = stored.whitelist.some((e) => norm(e) === 'google.com');
  const next = stored.whitelist.filter((e) => !legacy.has(norm(e)));
  if (hadGoogleRoot) {
    const present = new Set(next.map(norm));
    for (const h of GOOGLE_PRODUCTIVE_HOSTS) if (!present.has(h)) next.push(h);
  }
  return { whitelist: next, whitelistVersion: WHITELIST_VERSION };
}

/** Read settings (cached), falling back to DEFAULTS for any missing field. */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  const storedSettings = stored[STORAGE_KEY] as Partial<Settings> | undefined;
  cache = {
    ...DEFAULTS,
    ...storedSettings,
    ...migrateLabels(storedSettings),
    ...migrateWhitelist(storedSettings),
  };
  return cache;
}

/** Merge a partial update into the stored settings and return the result.
 *  THROWS while a lock is active (see lock.ts) — the single choke point every
 *  settings writer goes through, in whichever context it runs. (A raw
 *  storage.local.set from devtools bypasses it: accepted soft-lock.) */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const lock = await getLockStatus();
  if (lock.settingsLocked) {
    throw new Error(
      'SmartBlocker settings are locked' +
        (lock.until
          ? ` until ${new Date(lock.until).toLocaleString()}`
          : ' (password required)'),
    );
  }
  const next = { ...(await getSettings()), ...patch };
  cache = next;
  await api.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
