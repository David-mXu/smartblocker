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

const LITERAL_HOST_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const HOST_GLOB_LABEL_RE = /^[a-z0-9*-]+$/;
const SCHEME_GLOB_RE = /^[a-z*][a-z0-9+.*-]*$/;

type WhitelistWildcard =
  | { kind: 'suffix'; value: string }
  | { kind: 'host' | 'url'; value: string };

function isLiteralDnsHost(host: string): boolean {
  return host === 'localhost' || LITERAL_HOST_RE.test(host);
}

function isHostGlob(host: string): boolean {
  if (
    !host ||
    host.length > 253 ||
    !/[a-z0-9]/.test(host) // Reject *, *.*, and other content-free globs.
  ) {
    return false;
  }
  return host.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      HOST_GLOB_LABEL_RE.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

/** A path/scheme glob must be confined to a complete literal host suffix. */
function hasLiteralHostConstraint(host: string): boolean {
  if (!host.includes('*')) return isLiteralDnsHost(host);
  const suffix = host
    .slice(host.lastIndexOf('*') + 1)
    .replace(/^\./, '');
  return isLiteralDnsHost(suffix);
}

/** Parse and validate the wildcard-only allow grammar. Legacy entries never use it. */
function parseWhitelistWildcard(input: string): WhitelistWildcard | null {
  if (typeof input !== 'string') return null;
  let entry = input.trim().toLowerCase().replace(/\*+/g, '*');
  if (!entry.includes('*') || /\s/.test(entry)) return null;
  // Fragments do not participate in either the rule or the candidate URL.
  const fragment = entry.indexOf('#');
  if (fragment >= 0) entry = entry.slice(0, fragment);
  if (!entry) return null;

  let rest = entry;
  let hasScheme = false;
  const schemeEnd = rest.indexOf('://');
  if (schemeEnd >= 0) {
    const scheme = rest.slice(0, schemeEnd);
    if (!SCHEME_GLOB_RE.test(scheme)) return null;
    hasScheme = true;
    rest = rest.slice(schemeEnd + 3);
  }

  let boundary = rest.search(/[/?]/);
  const isUrlRule = hasScheme || boundary >= 0;
  if (hasScheme && boundary < 0) {
    // URL normalization gives a scheme-only rule its root pathname.
    rest += '/';
    boundary = rest.length - 1;
  } else if (boundary >= 0 && rest[boundary] === '?') {
    rest = rest.slice(0, boundary) + '/' + rest.slice(boundary);
    boundary++;
  }

  const host = (isUrlRule ? rest.slice(0, boundary) : rest).replace(/^www\./, '');
  if (!isHostGlob(host)) return null;

  if (!isUrlRule) {
    // Unlike every other host glob, this familiar spelling also includes the apex.
    if (host.startsWith('*.') && !host.slice(2).includes('*') && isLiteralDnsHost(host.slice(2))) {
      return { kind: 'suffix', value: host.slice(2) };
    }
    return { kind: 'host', value: host };
  }

  if (!hasLiteralHostConstraint(host)) return null;
  return { kind: 'url', value: host + rest.slice(boundary) };
}

/** Editor validation uses the exact grammar enforced by the runtime matcher. */
export function isValidWildcardWhitelistEntry(input: string): boolean {
  return parseWhitelistWildcard(input) !== null;
}

/**
 * Ordered-literal wildcard matching. No user text is interpolated into a RegExp;
 * native indexOf searches avoid regex backtracking and stars may span separators.
 */
function matchesOrderedWildcard(haystack: string, rawPattern: string, anchored: boolean): boolean {
  const pattern = rawPattern.replace(/\*+/g, '*');
  // A star confined to an ignored URL fragment leaves a literal remainder.
  if (!pattern.includes('*')) return anchored ? haystack === pattern : haystack.includes(pattern);
  if (!pattern.replace(/[\s*]/g, '')) return false;

  let body = pattern;
  let start = 0;
  let end = haystack.length;
  if (anchored && !body.startsWith('*')) {
    const star = body.indexOf('*');
    const prefix = body.slice(0, star);
    if (!haystack.startsWith(prefix)) return false;
    start = prefix.length;
    body = body.slice(star);
  }
  if (anchored && !body.endsWith('*')) {
    const star = body.lastIndexOf('*');
    const suffix = body.slice(star + 1);
    if (!haystack.endsWith(suffix)) return false;
    end = haystack.length - suffix.length;
    if (end < start) return false;
    body = body.slice(0, star + 1);
  }

  let cursor = start;
  for (const literal of body.split('*')) {
    if (!literal) continue;
    const found = haystack.indexOf(literal, cursor);
    if (found < 0 || found + literal.length > end) return false;
    cursor = found + literal.length;
  }
  return true;
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
 * Return every matching stored rule (trimmed, original spelling) in list order.
 * Star-free entries keep legacy domain + subdomain semantics: "github.com"
 * exempts github.com AND gist.github.com, but not notgithub.com. Wildcards use
 * the anchored host/URL grammar above, with apex-inclusive *.example.com sugar.
 *
 * Empty on active SERPs/search/translation surfaces: those guards precede ALL
 * allow rules, even an explicitly stored search-engine root. Blank homepages
 * and productive search-engine subdomains remain allow-able as before.
 */
export function matchingWhitelistEntries(url: string | undefined, whitelist: string[]): string[] {
  if (!url || !Array.isArray(whitelist)) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (isSearchEngineResultsUrl(parsed)) return [];

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const urlTarget = (host + parsed.pathname + parsed.search).toLowerCase();
  const matches: string[] = [];
  for (const raw of whitelist) {
    if (typeof raw !== 'string') continue;
    const original = raw.trim();
    if (!original) continue;
    if (!original.includes('*')) {
      // Byte-for-byte legacy behavior for every star-free stored rule.
      const e = normHost(raw);
      if (e && (host === e || host.endsWith('.' + e))) matches.push(original);
      continue;
    }

    const rule = parseWhitelistWildcard(original);
    if (!rule) continue;
    if (
      (rule.kind === 'suffix' && (host === rule.value || host.endsWith('.' + rule.value))) ||
      (rule.kind === 'host' && matchesOrderedWildcard(host, rule.value, true)) ||
      (rule.kind === 'url' && matchesOrderedWildcard(urlTarget, rule.value, true))
    ) {
      matches.push(original);
    }
  }
  return matches;
}

export function isWhitelisted(url: string | undefined, whitelist: string[]): boolean {
  return matchingWhitelistEntries(url, whitelist).length > 0;
}

/**
 * Deterministic keyword/URL blocklist match — the complement to isWhitelisted.
 * Each entry is a plain substring matched against the full lowercased URL AND
 * the page title, so one mechanism covers "URL contains X", "domain is X" (a
 * domain is itself a URL substring), and "search query contains X" (search
 * engines put the query in the URL, e.g. ?q=... or ?search_query=...) without
 * per-engine parsing. A star-bearing rule instead treats each star run as a
 * gap between ordered literal segments over that SAME unanchored haystack.
 * Returns the first matched entry in its trimmed original spelling, or null.
 */
export function matchedBlocklistEntry(
  url: string | undefined,
  title: string | null,
  blocklist: string[],
): string | null {
  if (!url || !Array.isArray(blocklist)) return null;
  const haystack = (url + ' ' + (title ?? '')).toLowerCase();
  for (const raw of blocklist) {
    if (typeof raw !== 'string') continue;
    const needle = raw.trim().toLowerCase();
    if (!needle) continue;
    if (!needle.includes('*')) {
      // Keep the legacy branch exact: no normalization beyond trim + lowercase.
      if (haystack.includes(needle)) return raw.trim();
    } else if (matchesOrderedWildcard(haystack, needle, false)) {
      return raw.trim();
    }
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
