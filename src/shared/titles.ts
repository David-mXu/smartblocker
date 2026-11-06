// URL/title filtering shared by the live blocker and the history scanner.

/**
 * Pages SmartBlocker will classify: real web pages over http(s) only. Excludes
 * browser-internal pages (chrome://, edge://, about:), local files (file://),
 * the extension's own pages (chrome-extension://), and anything unparseable.
 * Replaces the old YouTube/Reddit-only CONTENT_URL gate — SmartBlocker now watches
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

const SEARCH_ENGINE_ROOT_RE =
  /^(?:(?:www|cn|m|html|lite|search|images|video|videos|shopping)\.)?(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|bing\.com|duckduckgo\.com|brave\.com|yahoo\.[a-z]{2,3}(?:\.[a-z]{2})?|baidu\.com|yandex\.[a-z]{2,3}|naver\.com|ecosia\.org)$/i;

const SEARCH_QUERY_PARAMS = ['q', 'p', 'wd', 'query', 'text', 'search_query', 'k', 'term', '_nkw'];

const SEARCH_SURFACE_PATH_RE =
  /^\/(?:search|s|results|shopping|shop|videos|images|games|fbx|store\/games)(?:\/|$)/i;

/**
 * True when `parsed` is an active Search Engine Results Page (SERP),
 * search-engine shopping/video/game vertical (e.g. google.com/search?q=...,
 * bing.com/videos, play.google.com/store/games), or a Google Translate page
 * proxy (translate.google.com/translate?u=...) rather than a blank search
 * homepage or a productive subdomain like docs.google.com / mail.google.com.
 */
export function isSearchEngineResultsUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'play.google.com' ||
    host === 'store.google.com' ||
    host === 'shopping.google.com' ||
    host.endsWith('.translate.goog')
  )
    return true;
  if (host === 'translate.google.com' && parsed.searchParams.has('u')) return true;
  if (!SEARCH_ENGINE_ROOT_RE.test(host)) return false;
  for (const param of SEARCH_QUERY_PARAMS) {
    const val = parsed.searchParams.get(param);
    if (val && val.trim().length > 0) return true;
  }
  return SEARCH_SURFACE_PATH_RE.test(parsed.pathname);
}

/**
 * Is this URL exempt from blocking? Domain + subdomain match: a whitelist entry
 * of "github.com" exempts github.com AND gist.github.com, but not notgithub.com.
 *
 * Search-engine root domains in the whitelist ("google.com", "bing.com",
 * "duckduckgo.com") still exempt productive subdomains (docs.google.com,
 * mail.google.com, drive.google.com, scholar.google.com, cloud.google.com) and
 * blank search homepages, but do NOT exempt active search query pages
 * (?q=..., /shopping, /videos) so distracting searches and embedded SERP
 * widgets are still classified.
 */
export function isWhitelisted(url: string | undefined, whitelist: string[]): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isSearchEngineResultsUrl(parsed)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
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

const GENERIC_TITLES = new Set([
  'youtube',
  'youtube video player',
  'reddit',
  'google',
  'google search',
  'bing',
  'duckduckgo',
  'brave search',
  'baidu',
  '百度一下，你就知道',
  'yandex',
  'naver',
  'new tab',
  'untitled',
  'loading',
  'loading...',
  'just a moment...',
  'redirecting',
  'redirecting...',
]);

/** Strip site suffixes; return null for titles too generic or empty to classify. */
export function cleanTitle(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw
    .replace(/^(?:\(\d+\)\s*|(?:🐴|🔊|▶️?)\s*)+/u, '') // "(3) " unread-count or tab-marker prefix
    .replace(/\s*\(\d{1,2}:\d{2}(:\d{2})?\)$/, '') // "(2:26)" live playback timer (brain.fm etc.)
    .replace(/\s*[-|–]\s*YouTube$/i, '')
    .replace(/\s*[-|–:]\s*r\/\w+$/i, '')
    .replace(
      /\s*(?:[-|–·_]\s*(?:Google(?:\s+(?:Search|Shopping|Videos|Images|検索|검색|Suche|Recherche|Búsqueda))?|Bing(?:\s+(?:Videos|Shopping|Images|Search))?|Search|Brave\s+Search|DuckDuckGo|Yahoo!?\s*(?:Search(?:\s+Results)?|検索|ショッピング)?|Baidu|百度搜索|Yandex|Яндекс|Naver\s*(?:Search|통합검색|쇼핑검색)?|네이버\s*(?:통합검색|쇼핑검색)?|Ecosia)|\s+at\s+DuckDuckGo)$/i,
      '',
    )
    .trim();
  // Reject temporary raw URL titles set by Chromium before <title> parses.
  if (/^https?:\/\//i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}\/\S*$/i.test(t)) return null;
  // Require at least one letter or digit (supports short brand names like "X",
  // "eBay", "ESPN" and CJK titles like "淘宝", "微博"), and reject placeholder shells.
  if (!t || !/[\p{L}\p{N}]/u.test(t) || GENERIC_TITLES.has(t.toLowerCase())) return null;
  return t;
}
