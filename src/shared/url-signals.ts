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

// Whole path segments only (never substrings): high-precision page-type
// declarations sites make in their own URLs. "watch" is deliberately absent —
// youtube.com/watch spans tutorials as much as distractions, and YouTube
// pages already carry channel + description signals.
const PATH_HINTS: [string[], string][] = [
  [['login', 'signin', 'sign-in', 'signon', 'sign-on', 'auth'], 'Account sign-in page.'],
  [['account', 'accounts', 'myaccount', 'billing'], 'Account management page.'],
  [['checkout', 'cart', 'basket'], 'Online store checkout page.'],
  [['shorts', 'reels', 'feed'], 'Video or social media feed page.'],
];

/** A short page-kind sentence derived from the URL path, or '' if none match. */
export function urlPathHint(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.toLowerCase().split('/');
  } catch {
    return '';
  }
  for (const [tokens, hint] of PATH_HINTS) {
    if (tokens.some((t) => segments.includes(t))) return hint;
  }
  return '';
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
