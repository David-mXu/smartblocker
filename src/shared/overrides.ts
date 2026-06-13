// SW-side override store. Persists user corrections (titles forced through the
// block screen) in storage.local, bounded to MAX_OVERRIDES entries. Mirrors the
// caching pattern from settings.ts: one in-memory cache invalidated via
// api.storage.onChanged so a long-lived service worker stays coherent.
import { api } from './api';
import type { Override } from './messages';

const STORAGE_KEY = 'overrides';
const MAX_OVERRIDES = 1000;

let cache: Override[] | null = null;

// Invalidate the in-memory cache whenever another context writes overrides
// (e.g., future options page) so a long-lived SW picks up the change.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/** Normalize a title for consistent de-duplication between add and check. */
function normalize(title: string): string {
  return title.trim();
}

async function load(): Promise<Override[]> {
  if (cache !== null) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = (stored[STORAGE_KEY] as Override[] | undefined) ?? [];
  return cache;
}

async function save(entries: Override[]): Promise<void> {
  cache = entries;
  await api.storage.local.set({ [STORAGE_KEY]: entries });
}

/**
 * Record a user correction for the given title. If an entry already exists for
 * this (normalized) title it is refreshed with the current timestamp.
 * The list is bounded to MAX_OVERRIDES; oldest entries are dropped first.
 */
export async function addOverride(title: string): Promise<void> {
  const key = normalize(title);
  const entries = await load();

  // Remove any existing entry for this title so we can push a refreshed one.
  const filtered = entries.filter((e) => normalize(e.title) !== key);

  filtered.push({ title: key, ts: Date.now() });

  // Trim to the cap, keeping the most-recently-added (tail) entries.
  const bounded =
    filtered.length > MAX_OVERRIDES
      ? filtered.slice(filtered.length - MAX_OVERRIDES)
      : filtered;

  await save(bounded);
}

/**
 * Return true if the (normalized) title has a stored user override,
 * meaning the classifier should skip blocking it.
 */
export async function isOverridden(title: string): Promise<boolean> {
  const key = normalize(title);
  const entries = await load();
  return entries.some((e) => normalize(e.title) === key);
}
