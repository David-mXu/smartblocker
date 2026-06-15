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
}

export const DEFAULTS: Settings = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
  whitelist: [...DEFAULT_WHITELIST],
};

const STORAGE_KEY = 'settings';

let cache: Settings | null = null;

// Invalidate the in-memory cache when any context (options page, popup) writes
// new settings, so a long-lived service worker / offscreen doc sees changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/** Read settings (cached), falling back to DEFAULTS for any missing field. */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = { ...DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
  return cache;
}

/** Merge a partial update into the stored settings and return the result. */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  cache = next;
  await api.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
