// URL/title filtering shared by the live blocker and the history scanner.

/**
 * Pages FlowGuard will classify: real web pages over http(s) only. Excludes
 * browser-internal pages (chrome://, edge://, about:), local files (file://),
 * the extension's own pages (chrome-extension://), and anything unparseable.
 * Replaces the old YouTube/Reddit-only CONTENT_URL gate — FlowGuard now watches
 * every site except the user's whitelist (see isWhitelisted).
 */
export function isClassifiableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const proto = new URL(url).protocol;
    return proto === 'http:' || proto === 'https:';
  } catch {
    return false;
  }
}

/** Normalize a hostname/whitelist entry: lowercase, strip scheme/path/leading www. */
function normHost(value: string): string {
  let h = value.trim().toLowerCase();
  // Tolerate users pasting a full URL or a "www." prefix into the whitelist.
  h = h.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return h;
}

/**
 * Is this URL exempt from blocking? Domain + subdomain match: a whitelist entry
 * of "github.com" exempts github.com AND gist.github.com, but not notgithub.com.
 */
export function isWhitelisted(url: string | undefined, whitelist: string[]): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  for (const entry of whitelist) {
    const e = normHost(entry);
    if (!e) continue;
    if (host === e || host.endsWith('.' + e)) return true;
  }
  return false;
}

/**
 * Deterministic keyword/URL blocklist match — the complement to isWhitelisted.
 * Each entry is a plain substring matched against the full lowercased URL AND
 * the page title, so one mechanism covers "URL contains X", "domain is X" (a
 * domain is itself a URL substring), and "search query contains X" (search
 * engines put the query in the URL, e.g. ?q=... or ?search_query=...) without
 * per-engine parsing. Returns the matched entry (for the block screen), or
 * null. Intentionally simpler than isWhitelisted's hostname-only matching —
 * this is an opt-in power-user rule list, not a safe default.
 */
export function matchedBlocklistEntry(
  url: string | undefined,
  title: string | null,
  blocklist: string[],
): string | null {
  if (!url) return null;
  const haystack = (url + ' ' + (title ?? '')).toLowerCase();
  for (const raw of blocklist) {
    const needle = raw.trim().toLowerCase();
    if (needle && haystack.includes(needle)) return raw.trim();
  }
  return null;
}

const GENERIC_TITLES = new Set(['youtube', 'reddit', 'new tab']);

/** Strip site suffixes; return null for titles too generic to classify. */
export function cleanTitle(raw: string): string | null {
  let t = raw
    .replace(/^\(\d+\)\s*/, '') // "(3) " unread-count prefix
    .replace(/\s*[-|–]\s*YouTube$/i, '')
    .replace(/\s*[-|–:]\s*r\/\w+$/i, '')
    .trim();
  if (t.length < 5 || GENERIC_TITLES.has(t.toLowerCase())) return null;
  return t;
}
