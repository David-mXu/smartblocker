/**
 * Input normalization for the options/onboarding list editors and the popup's
 * "Always allow this site" action. Pure functions, no browser APIs.
 *
 * - Star-free allowed sites are HOSTNAMES matched by domain + subdomain
 *   (titles.ts isWhitelisted), so anything pasted — a full URL, "www.x.com",
 *   "x.com/path" — is reduced to its bare host. Safe wildcard allow rules are
 *   retained; *.example.com includes the apex and subdomains, while other
 *   globs use the fully anchored grammar in titles.ts.
 * - Always-block entries are URL + title SUBSTRINGS with optional * gaps
 *   (titles.ts matchedBlocklistEntry, which lowercases), so they are only
 *   trimmed + lowercased — "/cart" and "black friday" are valid entries.
 * - Channel entries (the YouTube channel rules) are HANDLES: the leading @ is
 *   optional, stored lowercase (rules.ts normalizeChannelHandle).
 */
import { normalizeChannelHandle } from './rules.ts';
import { isValidWildcardWhitelistEntry } from './titles.ts';

export type NormalizeResult = { ok: true; value: string } | { ok: false; error: string };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** "https://www.YouTube.com/watch?v=1" → "youtube.com"; safe globs stay intact. */
export function normalizeDomain(input: string): NormalizeResult {
  let raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Enter a website, like example.com' };
  if (raw.includes('*')) {
    raw = raw.replace(/\*+/g, '*');
    if (!isValidWildcardWhitelistEntry(raw)) {
      return { ok: false, error: `"${input.trim()}" needs a specific website host with its wildcard` };
    }
    return { ok: true, value: raw };
  }
  // Preserve legacy star-free URL/path normalization exactly.
  let host = raw;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
    host = new URL(withScheme).hostname;
  } catch {
    return { ok: false, error: `"${input.trim()}" isn't a website address` };
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!HOST_RE.test(host) && host !== 'localhost') {
    return { ok: false, error: `"${input.trim()}" isn't a website address` };
  }
  return { ok: true, value: host };
}

/** Always-block keyword / URL fragment. */
export function normalizeKeyword(input: string): NormalizeResult {
  const value = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value) return { ok: false, error: 'Enter a keyword or part of a web address' };
  if (value.length < 3) return { ok: false, error: 'Use at least 3 characters so it doesn’t block everything' };
  return { ok: true, value };
}

/**
 * Split pasted/typed text into candidate entries: newlines and commas always
 * separate; for domain and channel lists whitespace does too (domains and
 * handles never contain it), while keyword lists keep inner spaces
 * ("black friday").
 */
export function splitEntries(text: string, mode: 'domain' | 'keyword' | 'channel'): string[] {
  const sep = mode === 'keyword' ? /[\n,;]+/ : /[\n,;\s]+/;
  return text
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface MergeResult {
  items: string[];
  added: string[];
  duplicates: string[];
  invalid: { input: string; error: string }[];
}

/** Normalize + dedupe `inputs` into `existing` (order kept, new entries appended). */
export function mergeEntries(
  existing: string[],
  inputs: string[],
  mode: 'domain' | 'keyword' | 'channel',
): MergeResult {
  const norm =
    mode === 'domain' ? normalizeDomain : mode === 'channel' ? normalizeChannelHandle : normalizeKeyword;
  const seen = new Set(existing.map((e) => e.toLowerCase()));
  const items = [...existing];
  const added: string[] = [];
  const duplicates: string[] = [];
  const invalid: { input: string; error: string }[] = [];
  for (const input of inputs) {
    const r = norm(input);
    if (!r.ok) {
      invalid.push({ input, error: r.error });
      continue;
    }
    if (seen.has(r.value)) {
      duplicates.push(r.value);
      continue;
    }
    seen.add(r.value);
    items.push(r.value);
    added.push(r.value);
  }
  return { items, added, duplicates, invalid };
}
