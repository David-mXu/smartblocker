# Title-rule ReDoS guard + compile cache, and the oEmbed fetch quota (2026-11-15)

## Problem

Two hardening gaps shipped in the deterministic-rule and embed code:

1. `src/shared/rules.ts` compiled a fresh `RegExp` on **every** title check —
   and a user-authored rule like `a*a*a*a*a*a*a*a*a*b` (literals joined with
   `[\s\S]*`) is a classic catastrophic-backtracking shape. The page owns
   the title, so an attacker chooses the haystack and a victim rule supplies
   the needle: `re.test` can take exponential time and stall the background
   scanner.
2. `src/background/blocker.ts` resolved placeholder embed titles via
   YouTube oEmbed behind the opt-in `resolveEmbedTitles` toggle, but the
   300-entry cache is keyed by video ID — a hostile page embedding
   "YouTube video player" iframes with *rotating distinct* IDs defeats it,
   and every sanitizer re-scan queues up to 20 more lookups.

## Concepts worth keeping

- **Why `a*a*…*b` explodes**: the regex engine tries every way to split the
  string among the `[\s\S]*` gaps. With N gaps the ways multiply — the
  "dangling star" pattern (`a*a*` never lets a later `a` account for an
  earlier star's consumption the same way twice). Injected metachars were
  already escaped, so this is not *regex injection* — the danger is the
  *author's own wildcard grammar* combined with attacker-chosen input.
- **LRU with a plain `Map`**: JavaScript `Map`s keep insertion order, so
  delete-and-re-set on a hit refreshes recency and `keys().next().value` is
  the least-recently-used victim — a bounded cache with no extra library.
- **Cacheable RegExp is safe only without `/g`**: a global regex's
  `lastIndex` makes `test()` stateful across calls. These compile without
  `/g`, so one shared object serves all calls (a test asserts `lastIndex`
  stays 0).

## What was done, in order

1. **Verified the blast radius first.** `matchedBlocklistEntry`
   (`src/shared/titles.ts`) uses `matchesOrderedWildcard` — a linear
   `indexOf` scanner, not regex — so the URL/title blocklist is *not*
   vulnerable; only the title-rule compiler compiles regexes. That kept the
   fix scoped to title rules.
2. **Compile cache** (`rules.ts`): module-level
   `Map<string, RegExp | null>` keyed by raw rule text, cap 256
   (`TITLE_RULE_CACHE_MAX`), LRU-refresh on hit, oldest-key eviction on
   overflow. Invalid rules cache `null` too. In an MV3 service worker the
   module (and cache) can be reaped at any time — that is fine by design:
   correctness never depends on the cache, only speed does.
3. **Authoring guard** (`rules.ts` `normalizeTitleRule`): refuses *new*
   rules with > 8 star gaps (`TITLE_RULE_MAX_GAPS`) or with no literal run
   of >= 2 non-space characters. Stored rules keep evaluating untouched —
   the guard composes with the cache so even a pathological stored rule now
   pays its backtracking cost at most once per SW lifetime. Error strings
   follow `normalizeChannelHandle`'s contract (shown verbatim by ListEditor,
   so the messages must be actionable: name the problem and the limit).
4. **Wired the guard** where entries are rejected: a `'title'` mode in
   `domains.ts` (`splitEntries`/`mergeEntries`) dispatching to
   `normalizeTitleRule`, `list-editor.tsx` mode union widened, and the
   SitesPage title-pattern editor moved from `mode="keyword"` to
   `mode="title"`. Canonicalization (trim + lowercase + collapse) matches
   the old keyword path, so stored-value form is unchanged.
5. **oEmbed quota** (`blocker.ts`): `grantOembedFetch(tabId)` runs *after*
   the settings toggle, cache, and in-flight dedupe (hits consume nothing)
   and *before* the fetch. Two budgets: 25 fetches per tab per top-level
   document generation (reset in `arm()`, the same epoch that bumps
   `navGeneration`) and 500 per rolling hour SW-wide. Check + increment are
   synchronous — no `await` between them — so concurrent calls cannot
   over-grant.

## The decisive design point of the quota

Quota exhaustion must be **indistinguishable from a failed lookup**: the
resolver returns `null` with no fetch and no error, exactly what a dead
oEmbed endpoint produces, and callers already fall back to DOM/URL titles on
that path. Anything observably different would hand the hostile page a
free oracle for probing the budget.

## Tradeoffs and residuals

- A page can `history.pushState` to bump `navGeneration` and reset its own
  per-document bucket — the rolling-hour global cap (500) bounds the
  sustained pump. A per-SW-lifetime counter was rejected because keepalive
  alarms (Firefox, companion 30 s) can keep a service worker alive
  indefinitely and would eventually starve a legitimate heavy user; the
  rolling window self-heals.
- "Edit as text" in ListEditor re-validates the *entire* list on save and
  skips invalid entries (pre-existing contract — a 2-char keyword is
  dropped the same way). So a legacy 9-gap stored rule is dropped only on
  an explicit whole-list text save, never via normal add/remove.

## Verification (observed, not assumed)

- `node scripts/rules-test.mjs`: **78 passed, 0 failed** — 15 new cases
  (cache identity, LRU refresh, cap eviction with byte-identical matching,
  `lastIndex` statelessness, 7/8-gaps-OK vs 9-gaps-rejected,
  single-char-literal rejection, star-only rejection, stored risky rules
  still matching, legacy cases byte-identical) and every pre-existing
  title/channel/ladder case unchanged.
- `node scripts/wildcards-test.mjs`: 25 passed, 0 failed (grammar
  untouched).
- `node scripts/rta-test.mjs`: 17 passed, 0 failed.
- `npm run typecheck`: clean.
- `EVAL_SETTINGS.titleRules` is `[]` in `scripts/lib/eval-harness.mjs` and
  shipped rule lists default empty, so no eval case is title-rule-driven and
  the cached matcher could not shift `npm run eval` (not run this round,
  per swarm instructions).

Full design notes: `.audit-swarm/builders/builder-rules-report.md`.
