// User-configurable settings, the single source of truth the classifier and
// blocker read at runtime. config.ts now holds only the DEFAULTS; everything
// here is overridable from the options page and persisted in storage.local.
import { api } from './api';
import {
  BLOCKED_LABELS,
  BLOCK_THRESHOLD,
  DEFAULT_WHITELIST,
  LABELS,
} from './config';

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
   * Deterministic block rules: substrings matched against the full URL + page
   * title. A match blocks immediately, skipping the ML classifier entirely.
   * Empty by default — opt-in, unlike the model-driven category blocking.
   */
  blocklist: string[];
  /**
   * Opt-in: share anonymized misclassification feedback (see PRIVACY.md) to
   * improve the model. OFF by default — FlowGuard is telemetry-free unless
   * the user explicitly enables this on the options page.
   */
  shareFeedback: boolean;
  /**
   * Built-in labels the user has explicitly deleted. Tracked so that
   * migrateLabels() doesn't silently re-add them on extension updates.
   */
  deletedBuiltinLabels: string[];
  /**
   * Opt-in: continuously track visits + focused time per site (local-only,
   * hostname-level — see PRIVACY.md) to power the options page's Habits
   * dashboard and suggestions. OFF by default; never uploaded anywhere.
   */
  trackUsage: boolean;
}

export const DEFAULTS: Settings = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
  whitelist: [...DEFAULT_WHITELIST],
  blocklist: [],
  shareFeedback: false,
  deletedBuiltinLabels: [],
  trackUsage: false,
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

/** Read settings (cached), falling back to DEFAULTS for any missing field. */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  const storedSettings = stored[STORAGE_KEY] as Partial<Settings> | undefined;
  cache = { ...DEFAULTS, ...storedSettings, ...migrateLabels(storedSettings) };
  return cache;
}

/** Merge a partial update into the stored settings and return the result. */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  cache = next;
  await api.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
