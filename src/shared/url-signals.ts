// URL-derived classifier signals — cheap, and available even when extractMeta
// gets nothing (legacy pages with no metadata, injection failures, DOM not
// painted yet at title time).
//
// Lives in shared/ rather than background/ so the offline evaluator
// (scripts/lib/eval-harness.mjs) builds classifier input through the SAME code
// the blocker uses. When these hints were private to blocker.ts, editing them
// moved no number in the benchmark — the eval hand-wrote its own guesses.

/** Hostname without the leading "www.", or '' when the URL is unparseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const DOC_HOST_RE = /(^|\.)(docs|developer|developers|api|pkg|crates)\.|(\.dev$)/i;
const DOC_SEGMENTS = new Set([
  'docs',
  'documentation',
  'api',
  'reference',
  'sdk',
  'manual',
]);

const B2B_PRODUCT_HOST_RE =
  /(^|\.)(aws\.amazon\.com|cloud\.google\.com|azure\.microsoft\.com|learn\.microsoft\.com|developer\.apple\.com|github\.com|gitlab\.com|docker\.com|hashicorp\.com|atlassian\.com|jetbrains\.com|stripe\.com|cloudflare\.com|vercel\.com|supabase\.com|datadoghq\.com|grafana\.com|mongodb\.com|redis\.io|snowflake\.com|databricks\.com)$/i;

// Whole path segments only (never substrings): high-precision page-type
// declarations sites make in their own URLs. "watch" is deliberately absent —
// youtube.com/watch spans tutorials as much as distractions, and YouTube
// pages already carry channel + description signals.
const PATH_HINTS: [string[], string, boolean?][] = [
  [
    [
      'login',
      'signin',
      'sign-in',
      'signon',
      'sign-on',
      'auth',
      'oauth',
      'oauth2',
      'sso',
      'saml',
      '2fa',
      'mfa',
      'passkey',
      'reset-password',
      'forgot-password',
    ],
    'Account sign-in page.',
  ],
  [['account', 'accounts', 'myaccount', 'billing'], 'Account management page.'],
  [
    [
      'checkout',
      'cart',
      'basket',
      'warenkorb',
      'panier',
      'carrito',
      'carrello',
      'carrinho',
      'winkelwagen',
      'koszyk',
      'varukorg',
      'handlekurv',
      'ostoskori',
      'sepet',
    ],
    'Online store checkout page.',
    true,
  ],
  [
    [
      'configurator',
      'build-and-price',
      'dp',
      'gp',
      'products',
      'product',
      'itm',
      'goods',
      'oferta',
      'produkt',
      'produit',
      'producto',
      'prodotto',
      'produto',
    ],
    'Online store product page.',
    true,
  ],
  [['shorts', 'reels', 'feed'], 'Video or social media feed page.', true],
];

/** A short page-kind sentence derived from the URL path, or '' if none match. */
export function urlPathHint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
  const isDocUrl = DOC_HOST_RE.test(host) || segments.some((s) => DOC_SEGMENTS.has(s));

  // 1. Auth & account management take highest priority on any domain.
  for (let i = 0; i < 2; i++) {
    const [tokens, hint] = PATH_HINTS[i];
    if (tokens.some((t) => segments.includes(t))) return hint;
  }

  // 2. Search-engine vertical query params (e.g. Google udm=28 / tbm=shop, DDG ia=shopping).
  const udm = parsed.searchParams.get('udm');
  const tbm = parsed.searchParams.get('tbm');
  const ia = parsed.searchParams.get('ia');
  if (
    udm === '28' ||
    tbm === 'shop' ||
    ia === 'shopping' ||
    segments.includes('shopping') ||
    (host.endsWith('bing.com') && segments[0] === 'shop')
  ) {
    return 'Online store product page.';
  }

  // 3. Consumer shopping & social feed path hints (skipped on dev docs & B2B SaaS).
  const isB2BHost = B2B_PRODUCT_HOST_RE.test(host);
  for (let i = 2; i < PATH_HINTS.length; i++) {
    const [tokens, hint, skipOnDocs] = PATH_HINTS[i];
    if (skipOnDocs && (isDocUrl || isB2BHost)) continue;
    if (tokens.some((t) => segments.includes(t))) return hint;
  }
  return '';
}

const GENERIC_SLUGS = new Set([
  'index',
  'home',
  'watch',
  'view',
  'app',
  'page',
  'item',
  'dp',
  'gp',
  'comments',
  'status',
  'p',
  'v',
  'search',
  'results',
  's',
]);

const QUERY_TITLE_PARAMS = ['q', 'query', 'search_query', 'p', 'wd', 'text', 'k', 'term', '_nkw'];

/**
 * Derive a fallback title from the URL when both document.title and DOM
 * metadata (og:title / h1) are blank or generic placeholders.
 * Extracts the search query parameter (if present) or the most informative
 * path slug + hostname, or falls back to the hostname alone so empty-title
 * pages never bypass classification.
 */
export function urlFallbackTitle(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (!host) return null;

  for (const param of QUERY_TITLE_PARAMS) {
    const val = parsed.searchParams.get(param);
    if (val) {
      const cleaned = val.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 1 && /[\p{L}\p{N}]/u.test(cleaned)) {
        return `${cleaned} (${host})`;
      }
    }
  }

  const rawSegments = parsed.pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s).trim();
      } catch {
        return s.trim();
      }
    })
    .filter(Boolean);

  // Pick the last segment that looks like a human-readable slug rather than an
  // opaque ID, numeric index, or generic route token.
  for (let i = rawSegments.length - 1; i >= 0; i--) {
    const seg = rawSegments[i].replace(/\.[a-z0-9]{2,5}$/i, ''); // strip .html etc.
    const lower = seg.toLowerCase();
    if (GENERIC_SLUGS.has(lower)) continue;
    if (/^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg)) continue; // hex/numeric ID
    const humanized = seg.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (humanized.length >= 3 && /[a-zA-Z\u00C0-\u024F\u4E00-\u9FFF]/.test(humanized)) {
      return `${humanized} (${host})`;
    }
  }

  return host;
}

/**
 * Fold URL signals into the meta scraped from the DOM, exactly as the live
 * blocker does: the hostname stands in for a missing site name, and the path
 * hint is prepended unless extractMeta already said the same thing (e.g. its
 * password-field probe emits the identical sign-in sentence).
 */
export function applyUrlSignals(
  url: string,
  meta: { channel?: string; context?: string },
): { channel?: string; context?: string } {
  const hint = urlPathHint(url);
  return {
    channel: meta.channel || hostnameOf(url) || undefined,
    context:
      hint && !(meta.context ?? '').includes(hint)
        ? [hint, meta.context].filter(Boolean).join(' ')
        : meta.context,
  };
}
