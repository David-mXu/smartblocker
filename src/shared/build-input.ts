// Assembles classifier input from richer page signals into a single model
// text string, and derives a stable cache key for the title cache.
import type { ClassifyInput } from './messages';

/** Maximum total length fed to the model (~300 chars keeps inference fast). */
const MAX_TOTAL = 300;
/** Context is trimmed first; everything else is kept verbatim when possible. */
const MAX_CONTEXT = 200;

/**
 * Combine title + channel + context into ONE bounded string the model
 * classifies.  Title comes first (highest signal), then channel, then context.
 * Empty/undefined parts are omitted.  Context is the first thing trimmed when
 * the combined length would exceed MAX_TOTAL.
 */
export function buildClassifierText(input: ClassifyInput): string {
  const title = (input.title ?? '').trim();
  const channel = (input.channel ?? '').trim();
  let context = (input.context ?? '').trim();

  // Pre-trim context to its own cap before budget math.
  if (context.length > MAX_CONTEXT) {
    context = context.slice(0, MAX_CONTEXT).trimEnd();
  }

  const parts: string[] = [];
  let budget = MAX_TOTAL;

  // Title is always included (it's the primary signal).
  if (title) {
    parts.push(title);
    budget -= title.length;
  }

  // Channel — include if it fits; it's short and high-value.
  if (channel && budget > channel.length + 2 /* separator */) {
    parts.push(channel);
    budget -= channel.length + 2;
  }

  // Context — include trimmed to whatever budget remains.
  if (context) {
    const available = budget - 2; // account for '. ' separator
    if (available > 10) {
      parts.push(available < context.length ? context.slice(0, available).trimEnd() : context);
    }
  }

  return parts.join('. ');
}

/**
 * Stable, collision-resistant cache key derived from the same fields used by
 * buildClassifierText.  Normalised to lowercase and trimmed so that minor
 * capitalisation differences (e.g. auto-capitalised page titles) still hit the
 * same cache entry.
 *
 * Format: "title\x00channel\x00context" — the NUL delimiter is safe because
 * neither titles nor channels contain it, and it prevents "a\x00b" from
 * colliding with "a" + "b" in any field position.
 */
export function inputCacheKey(input: ClassifyInput): string {
  const title = (input.title ?? '').trim().toLowerCase();
  const channel = (input.channel ?? '').trim().toLowerCase();
  // Only the first MAX_CONTEXT chars of context matter (same budget as above).
  const context = (input.context ?? '').trim().toLowerCase().slice(0, MAX_CONTEXT);
  return `${title}\x00${channel}\x00${context}`;
}
