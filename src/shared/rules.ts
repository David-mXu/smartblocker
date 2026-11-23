// Pure deterministic rule matchers — no browser APIs, erasable-syntax-only,
// so Node's type stripping (>= 22.6) loads this file directly for unit tests
// and the eval harness, exactly like lock-math.ts.
//
// This module hosts all three Phase 5 batch-1 rule layers of the block
// decision ladder:
//
//   URL whitelist → URL/title blocklist → title rules → channelBlocklist →
//   classifier → channelAllowlist (rescues ONLY a classifier verdict, never
//   a rule hit) → overrides
//
// Sections: channel rules (F1), title rules (F2), adult-host signal (F3).
// The adult <meta name="rating"> DOM probe lives inline in
// src/content/extract-meta.ts because that function is serialized into the
// page by scripting.executeScript and cannot import anything.
//
// Evidence base: docs/audits/2026-11-07-cold-turkey-blocker-landscape-audit.md
// (§1.1 checkBlockAdult, §4-P0.1/P0.2).

import type { NormalizeResult } from './domains';

// ---------------------------------------------------------------------------
// Channel rules (settings.channelBlocklist / channelAllowlist)
//
// What "channel" means here: the channel string extractMeta() scrapes and
// applyUrlSignals completes — a channel DISPLAY NAME with an optional
// " (youtube.com)"-style site marker ("MrBeast (youtube.com)"), a Reddit
// "r/<name>", an og:site_name, or the hostname fallback. Entries are stored in
// the lowercase handle form ("mrbeast"); normalizeChannelHandle does that
// reduction and the options editors validate through it (domains.ts 'channel'
// mode).
// ---------------------------------------------------------------------------

/** Strips one trailing site marker: "MrBeast (youtube.com)" → "MrBeast".
 *  Requires a dotted host inside the parens so "(Official)"-style suffixes
 *  that are genuinely part of a name are kept. */
const SITE_MARKER_RE = /\s*\((?:[\w-]+\.)+[\w-]{2,}\)\s*$/;

/**
 * Canonical comparison form: leading @ dropped, site marker dropped,
 * lowercase, inner whitespace collapsed. " @MrBeast " → "mrbeast".
 */
function canonicalChannel(raw: string): string {
  return raw
    // Invisible format characters (zero-width space, ZWJ, soft hyphen, LRM)
    // and NFKC compatibility forms are exactly how a scraper-level channel
    // name can LOOK identical and still fail a stored rule: "Mr​Beast"
    // (with U+200B) or "ＭｒＢｅａｓｔ" must match "mrbeast". Same normalization
    // family as overrides.ts / title rules.
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .trim()
    .replace(/^@+/, '')
    .replace(SITE_MARKER_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize one typed/pasted entry to its stored form: the leading @ is
 * optional, everything is stored lowercase ("@MrBeast" → "mrbeast"). Called
 * by the options editors via domains.ts mergeEntries(mode: 'channel'); the
 * error strings are shown verbatim by ListEditor.
 */
export function normalizeChannelHandle(input: string): NormalizeResult {
  const value = canonicalChannel(input);
  if (!value) return { ok: false, error: 'Enter a channel name, like @mrbeast' };
  if (value.length > 100) return { ok: false, error: 'Keep channel names under 100 characters' };
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return { ok: false, error: `"${input.trim()}" needs at least one letter or number` };
  }
  return { ok: true, value };
}

/**
 * Does `channel` (the page's extracted channel, or null when the page gave
 * none) match an entry of `list`? Returns the matching STORED entry, for
 * reason labels, or null.
 *
 * Both sides are compared in canonical form with ALL whitespace removed, so a
 * stored handle matches the scraped display name regardless of case, the
 * leading @, or spacing ("marquesbrownlee" matches
 * "Marques Brownlee (youtube.com)"). Comparison is whole-string equality —
 * never a substring test — so "beast" can't catch "mrbeast2".
 */
export function matchChannel(
  channel: string | null | undefined,
  list: readonly string[],
): string | null {
  if (!channel || list.length === 0) return null;
  const want = canonicalChannel(channel).replace(/\s+/g, '');
  if (!want) return null;
  for (const entry of list) {
    const got = canonicalChannel(entry).replace(/\s+/g, '');
    if (got && got === want) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title rules (settings.titleRules) — "window titles" blocking, CT-style
//
// A dedicated, title-only rule list with optional `*` wildcards. A matching
// rule blocks the page instantly — same ladder position as the URL
// `blocklist` (after the whitelist, before the classifier) — with a distinct
// `title rule: "…"` reason label so the block screen and logs say why.
//
// Match semantics — everything applied to BOTH the rule and the cleaned title:
//   1. Unicode-normalize: strip zero-width/format chars (Cf), NFKC (folds
//      fullwidth/compatibility glyphs onto ASCII equivalents — the exact
//      normalization overrides.ts uses for titles), collapse whitespace,
//      lowercase (case-insensitive), trim.
//   2. Bare rule (no `*`): plain substring match.
//   3. Wildcard rule: the literal parts must appear in the title IN ORDER,
//      and each run of consecutive `*`s is a "match anything" gap
//      (leading/trailing stars are effectively no-ops: "*lofi" ≡ "lofi" ≡
//      "lofi*" — all mean "title contains lofi"). Every other regex
//      metachar is escaped, so `[x(y*` compiles as literal text + wildcard.
//   4. Empty/whitespace-only and star-only rules are IGNORED (a lone `*`
//      would match every title — a footgun the compiler refuses).
// ---------------------------------------------------------------------------

/**
 * Upper bound on cached compiled title rules. matchTitleRule runs for every
 * title check on every armed tab, so without a cache each rule would be
 * re-compiled (normalized + split + escaped + `new RegExp`) on every single
 * check, and a pathological stored rule would pay its backtracking risk on
 * every title instead of once per compile.
 */
export const TITLE_RULE_CACHE_MAX = 256;
/** Authoring guard: max `*` gaps a NEW rule may use (see normalizeTitleRule). */
export const TITLE_RULE_MAX_GAPS = 8;

// Module-level Map keyed by the raw rule text, insertion-ordered so a delete
// + re-set on hit gives LRU refresh and `keys().next()` gives the victim for
// eviction. Rules are stateless (no /g flag, so re.test has no lastIndex
// hazard), so sharing one RegExp object across calls is safe. The cache is
// per-module-instance: when the MV3 service worker is reaped the cache dies
// with it and the first check per rule recompiles (sub-millisecond) —
// correctness never depends on it. Compiled nulls (invalid rules) are cached
// too, so a garbage stored entry is not re-normalized on every title check.
const titleRuleCache = new Map<string, RegExp | null>();

export function compileTitleRule(rule: string): RegExp | null {
  if (typeof rule !== 'string') return null;
  if (titleRuleCache.has(rule)) {
    const cached = titleRuleCache.get(rule) as RegExp | null;
    // LRU: re-insert to move this key to the back of the eviction order.
    titleRuleCache.delete(rule);
    titleRuleCache.set(rule, cached);
    return cached;
  }
  const compiled = compileTitleRuleUncached(rule);
  titleRuleCache.set(rule, compiled);
  if (titleRuleCache.size > TITLE_RULE_CACHE_MAX) {
    const oldest = titleRuleCache.keys().next().value;
    if (oldest !== undefined) titleRuleCache.delete(oldest);
  }
  return compiled;
}

function compileTitleRuleUncached(rule: string): RegExp | null {
  const norm = normalizeForTitleRule(rule);
  if (!norm) return null;
  // Consecutive `*`s are one wildcard. Split on star runs and trim each part:
  // whitespace adjacent to a star is redundant (the gap already spans it), so
  // "* *" or " *  " prune away exactly like a lone "*" would — a pure gap with
  // no literal content is never compiled.
  const parts = norm
    .split(/\*+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const pattern = parts.map(escapeRegex).join('[\\s\\S]*');
  try {
    return new RegExp(pattern);
  } catch {
    // Escape should make a throw impossible; refuse the rule if it does.
    return null;
  }
}

/** Linear ordered-literal match: the exact semantics the old
 *  `escapeRegex(part).join('[\\s\\S]*')` regex had, without the regex engine.
 *  Sequential earliest-match is optimal for ordered literals, so this is
 *  O(haystack × parts) with no backtracking at all — a stored rule such as
 *  `a*b*c*d` can no longer be turned into a service-worker stall by a hostile
 *  page title (measured 57s via the regex on 300 chars). */
function matchesTitleRuleParts(haystack: string, rule: string): boolean {
  const parts = normalizeForTitleRule(rule)
    .split(/\*+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const at = haystack.indexOf(parts[i], cursor);
    if (at < 0) return false;
    cursor = at + parts[i].length;
  }
  return true;
}

/** The matched rule's trimmed raw text (for the block screen/reason/logs), or null. */
export function matchTitleRule(title: string | null | undefined, rules: string[]): string | null {
  if (!title || !Array.isArray(rules) || rules.length === 0) return null;
  const haystack = normalizeForTitleRule(title);
  if (!haystack) return null;
  for (const raw of rules) {
    if (typeof raw !== 'string') continue;
    if (matchesTitleRuleParts(haystack, raw)) return raw.trim();
  }
  return null;
}

/**
 * Authoring-time guard for NEW title rules, callable by the options editors
 * (domains.ts mergeEntries mode 'title', keyed through this like channel
 * entries go through normalizeChannelHandle).
 *
 * The compiler escapes metachars, so a rule can never inject regex — but a
 * USER-AUTHORED rule like "a*a*a*a*a*a*b" joined with [\s\S]* against an
 * attacker-chosen title is an exponential-backtracking footgun inside
 * re.test, stalling the scanner on the page that owns the title. The guard
 * refuses structurally risky shapes at entry time:
 *
 *   - at most TITLE_RULE_MAX_GAPS wildcard gaps (each gap doubles the
 *     worst-case backtracking work; 8 keeps the fan-in trivially bounded),
 *   - at least one literal run of >= 2 non-space characters (single-char
 *     literals are both the ReDoS building block and useless filters).
 *
 * EXISTING stored rules are untouched: matchTitleRule/compileTitleRule keep
 * evaluating anything they already accepted (the compile cache makes even a
 * pathological stored rule cost its compile once). This function only decides
 * what may be ADDED from the editor UI.
 *
 * Canonicalization matches normalizeKeyword (domains.ts), which previously
 * validated these entries: trim + lowercase + whitespace collapse.
 */
export function normalizeTitleRule(input: string): NormalizeResult {
  // Normalize exactly like the matcher does BEFORE counting gaps, so a
  // fullwidth `＊` (NFKC → `*`) or an invisible Cf character can neither
  // smuggle a wildcard past the cap nor change the stored spelling.
  const value = normalizeForTitleRule(input);
  if (!value) return { ok: false, error: 'Enter a title pattern, like minecraft*speedrun' };
  if (value.length < 3) {
    return { ok: false, error: 'Use at least 3 characters so it doesn’t block everything' };
  }
  const gaps = (value.match(/\*+/g) ?? []).length;
  if (gaps > TITLE_RULE_MAX_GAPS) {
    return {
      ok: false,
      error: `"${value}" uses ${gaps} * wildcards — keep it to ${TITLE_RULE_MAX_GAPS} or fewer so matching stays fast`,
    };
  }
  const parts = value
    .split(/\*+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, error: 'Add some text to match — a * on its own would block every page' };
  }
  if (!parts.some((p) => p.replace(/\s/g, '').length >= 2)) {
    return {
      ok: false,
      error: `"${value}" needs at least one run of 2 or more letters, like "minecraft*speedrun"`,
    };
  }
  return { ok: true, value };
}

/**
 * Shared normalization for rule text and titles — mirrors overrides.ts'
 * normalizeOverrideTitle (Cf-strip → NFKC → whitespace-collapse → trim) plus
 * lowercasing for the case-insensitive match. No length cap: the 300-char
 * slice in overrides.ts is a storage-key bound, not a matching rule.
 */
function normalizeForTitleRule(text: string): string {
  return text
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Adult-host signal (settings.blockAdult, default OFF) — mirrors the Cold
// Turkey extension's checkBlockAdult flow. The meta-tag half of that flow is
// the DOM probe in src/content/extract-meta.ts (see header note).
// ---------------------------------------------------------------------------

/**
 * True when `hostname` is inside the `.xxx` adult TLD — the exact TLD itself
 * or any subdomain of it ("example.xxx", "a.b.xxx"). A host that merely
 * contains "xxx" ("xxx.com", "fooxxx.net") is NOT a match: the TLD position
 * is what counts. Case-insensitive and tolerant of a trailing root dot and
 * surrounding whitespace; the empty string never matches.
 */
export function isAdultHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'xxx' || host.endsWith('.xxx');
}
