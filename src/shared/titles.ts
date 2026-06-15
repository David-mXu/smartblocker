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
