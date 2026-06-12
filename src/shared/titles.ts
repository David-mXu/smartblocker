// URL/title filtering shared by the live blocker and the history scanner.

const CONTENT_URL =
  /(?:^|\.)youtube\.com\/(?:watch|shorts\/)|(?:^|\.)reddit\.com\/r\/[^/]+\/comments\//;

export function isContentUrl(url: string): boolean {
  return CONTENT_URL.test(url);
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
