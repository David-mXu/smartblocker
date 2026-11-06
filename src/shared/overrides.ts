// SW-side override store. Persists user corrections (titles forced through the
// block screen) in storage.local, bounded to MAX_OVERRIDES entries. Mirrors the
// caching pattern from settings.ts: one in-memory cache invalidated via
// api.storage.onChanged so a long-lived service worker stays coherent.
//
// Red-team hardening (2026-11 #14): new entries are scoped to
// (hostname, normalized title) — a correction made on one site no longer
// allowlists the same title everywhere, and zero-width/invisible unicode or
// compatibility-glyph variants can no longer slip past an override. Entries
// stored before scoping (title-only, no `host`) are still honored on every
// host so existing user corrections keep working.
import { api } from './api';
import type { Override } from './messages';

const STORAGE_KEY = 'overrides';
const MAX_OVERRIDES = 1000;
// Cap at the 300-char classifier input bound so the stored key covers the
// whole string the verdict was based on.
const MAX_TITLE_LEN = 300;

/** Persisted shape: entries written after scoping carry a `host`. */
type StoredOverride = Override & { host?: string };

let cache: StoredOverride[] | null = null;

// Invalidate the in-memory cache whenever another context writes overrides
// (e.g., future options page) so a long-lived SW picks up the change.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/**
 * Normalize a title for consistent de-duplication between add and check:
 * strip zero-width/invisible unicode (Cf), NFKC-normalize (folds fullwidth and
 * other compatibility glyphs onto their ASCII equivalents), collapse
 * whitespace, cap length. Pure and synchronous — eval scripts import shared/
 * under Node type-stripping, so no browser APIs here.
 */
export function normalizeOverrideTitle(title: string): string {
  return title
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LEN);
}

/** Normalize a hostname the same way url-signals' hostnameOf does. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

function hostOf(e: StoredOverride): string | undefined {
  return e.host ? normalizeHost(e.host) : undefined;
}

async function load(): Promise<StoredOverride[]> {
  if (cache !== null) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = (stored[STORAGE_KEY] as StoredOverride[] | undefined) ?? [];
  return cache;
}

async function save(entries: StoredOverride[]): Promise<void> {
  cache = entries;
  await api.storage.local.set({ [STORAGE_KEY]: entries });
}

/**
 * Record a user correction for the given title, scoped to the page hostname
 * when one is supplied (every new write stores the scoped + normalized form).
 * If an entry already exists at this (host, normalized title) scope it is
 * refreshed with the current timestamp; a legacy host-less entry for the same
 * title is a different (global) scope and is left untouched.
 * The list is bounded to MAX_OVERRIDES; oldest entries are dropped first.
 */
export async function addOverride(title: string, hostname?: string): Promise<void> {
  const key = normalizeOverrideTitle(title);
  if (!key) return;
  const host = hostname ? normalizeHost(hostname) : undefined;
  const entries = await load();

  // Remove any existing entry at this exact scope so we can push a refreshed one.
  const filtered = entries.filter(
    (e) => normalizeOverrideTitle(e.title) !== key || hostOf(e) !== host,
  );

  filtered.push(host ? { title: key, host, ts: Date.now() } : { title: key, ts: Date.now() });

  // Trim to the cap, keeping the most-recently-added (tail) entries.
  const bounded =
    filtered.length > MAX_OVERRIDES
      ? filtered.slice(filtered.length - MAX_OVERRIDES)
      : filtered;

  await save(bounded);
}

/**
 * Return true if the (normalized) title has a stored user override for the
 * given hostname, meaning the classifier should skip blocking it. Legacy
 * host-less entries match on every hostname so pre-scoping corrections keep
 * working. Callers that cannot supply a hostname get the historical
 * title-only behaviour.
 */
export async function isOverridden(title: string, hostname?: string): Promise<boolean> {
  const key = normalizeOverrideTitle(title);
  if (!key) return false;
  const host = hostname ? normalizeHost(hostname) : undefined;
  const entries = await load();
  return entries.some(
    (e) =>
      normalizeOverrideTitle(e.title) === key &&
      // No stored host (legacy entry) or no host to check against (legacy
      // call site): title alone decides. Scoped entries apply only on their
      // own hostname.
      (hostOf(e) === undefined || host === undefined || hostOf(e) === host),
  );
}
