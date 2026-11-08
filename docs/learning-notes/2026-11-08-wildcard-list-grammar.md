# Wildcard list grammar (extension side)

## Goal and starting point

Phase 5 Batch 3 item 13 needed `*` wildcards in the extension's Always block
and Always allow lists, without changing any existing star-free list behavior.
The daemon CLI and item 14 partner-code work are separate and were not part of
this change.

The starting matchers had two deliberately different contracts:

- `matchedBlocklistEntry` in [`src/shared/titles.ts`](../../src/shared/titles.ts)
  lowercased `(url + ' ' + (title ?? ''))`, then returned the first stored rule
  whose trimmed lowercase text was a substring of that haystack.
- `isWhitelisted` parsed the URL, rejected active search/translation surfaces,
  normalized each entry to a host, and allowed an exact host or its subdomains.
  [`src/shared/domains.ts`](../../src/shared/domains.ts) also reduced pasted
  URLs and paths to hosts and silently removed a leading `*.`.

The options UI previously accepted `*.example.com` but stored `example.com`.
In contrast, the in-page sanitizer had its own blocklist helper because
`sanitizePage` is serialized by `chrome.scripting.executeScript`; shared-module
imports are unavailable inside that serialization boundary.

## Grammar and compatibility decisions

### Legacy branches stay separate

A rule with no `*` follows the old code path. This is important: making every
rule go through a new glob compiler could change whitespace, URL/path handling,
first-match results, or apex/subdomain behavior. The new API,
`matchingWhitelistEntries`, returns all matching rules in their trimmed original
spelling; `isWhitelisted` simply checks whether that result is non-empty.

The active-SERP/search/translation guard still runs before **every** allow rule.
An allow wildcard therefore cannot reopen a distracting results page, video
vertical, Play/Store surface, or translation proxy.

### Always block: ordered gaps in the same haystack

For a star-bearing block rule:

1. Trim and lowercase exactly as before; do not add title-rule NFKC or
   whitespace canonicalization.
2. Collapse each star run.
3. Find literal segments in order, starting where the previous segment ended.
4. Keep the search unanchored over the original URL + space + title haystack.
   A gap can cross punctuation, query/path separators, or the URL/title space.

No user text is interpolated into a regular expression. Native `indexOf`
searches provide the ordered-literal matching and avoid attacker-selected regex
backtracking. All regex punctuation in a segment is ordinary text.

Whitespace-only/star-only rules are ignored, as are malformed non-string stored
entries. A standalone `*` was already rejected by the three-character editor
minimum and is also a runtime no-op for manually stored data. `*.*` retains its
explicit broad-block meaning: its literal segment is a dot.

### Always allow: anchored, constrained globs

Wildcard allow entries are parsed separately from legacy host entries:

- Host-only `*.example.com` is the familiar suffix shortcut and includes the
  apex plus all subdomains. It does not match `notexample.com` or
  `example.com.evil.test`.
- Every other host-only glob is case-insensitive and fully anchored against the
  hostname. There is no implicit URL-substring or label-boundary behavior; for
  example, `*example.com` deliberately can match `notexample.com`.
- A star-bearing rule containing a path or scheme is fully anchored against
  lowercase normalized `hostname + pathname + search`. Fragments do not
  participate, and `*` can cross `/`, `.`, and `?`. Scheme-only wildcard rules
  receive the URL's root `/` pathname. The scheme is rule syntax, not part of
  the comparison target, so it does not restrict HTTP versus HTTPS.
- The candidate hostname ignores URL ports, as `URL.hostname` specifies.
  Wildcard rules with an explicit authority port, credentials, empty labels, or
  malformed host characters are rejected instead of being reinterpreted.
- Content-free hosts (`*`, `*.*`, and equivalents) are invalid as allows.
  Path/scheme rules additionally need a complete literal DNS/localhost suffix,
  so `https://*/`, `*/*`, `https://*/*`, and `https://example.*/*` cannot allow
  everything. Safe counterexamples such as `https://example.com/*` and
  `https://*.example.com/*` remain valid.

The options normalizer uses that same exported grammar validator. Star-bearing
entries are lowercased and their star runs collapsed; non-star entries retain
the previous `URL`-based host reduction. No defaults, stored settings shape,
migration, save flow, or lock behavior changed. Existing older values are
already valid: an old `*.example.com` paste was stored as `example.com`, which
has the same apex/subdomain effect.

## Alternatives and tradeoffs

- **Escaped regex compilation:** the existing title-rule module uses one, and a
  similar compiler would have been concise. Ordered `indexOf` matching was
  chosen here to avoid any user-controlled regex construction and make the
  anchored suffix behavior explicit. It also leaves legacy whitespace and text
  normalization alone.
- **One unified matcher:** tempting, but block rules are unanchored over URL +
  title while allow rules are host- or URL-anchored. Separate legacy and
  wildcard branches are longer but preserve the distinct security contracts.
- **Sharing the sanitizer helper:** impossible without breaking function
  serialization. [`src/content/sanitize-page.ts`](../../src/content/sanitize-page.ts)
  therefore keeps a small local mirror. The focused test extracts the nested
  pure functions from the actual `sanitizePage.toString()` and compares their
  results with the shared matcher without constructing a browser DOM. This
  proves parity while also checking that the extracted function has no missing
  outer references.
- **Broad versus constrained path globs:** allowing a hostname such as
  `example.*` in a path/scheme allow would make the literal-host security
  boundary unclear. Those spellings fail closed. Host-only globs remain more
  general, subject to the match-everything rejection and full anchoring.
- **Popup duplication:** the old popup re-derived host matches independently.
  It now calls `matchingWhitelistEntries` once for both the allow verdict and
  `allowedBy`, so wildcard display/removal cannot disagree with the blocker.
  The focused test checks raw matching behavior plus the popup wiring; a full
  browser popup run remains an integration-gate responsibility.

## Files changed

- [`src/shared/titles.ts`](../../src/shared/titles.ts): wildcard parsing,
  ordered-literal matching, block matcher, all-matches allow API.
- [`src/shared/domains.ts`](../../src/shared/domains.ts): safe wildcard editor
  normalization and explicit TypeScript import extensions for direct Node tests.
- [`src/popup/popup-model.ts`](../../src/popup/popup-model.ts): shared allow-match
  derivation for `allowedBy`.
- [`src/popup/PopupApp.tsx`](../../src/popup/PopupApp.tsx): removal compares those
  trimmed labels with trimmed stored entries, preserving legacy whitespace-padded rules.
- [`src/content/sanitize-page.ts`](../../src/content/sanitize-page.ts): only the
  nested blocklist matcher and its local wildcard helper. Main's separate
  YouTube-search changes were retained during integration.
- [`src/options/pages/SitesPage.tsx`](../../src/options/pages/SitesPage.tsx):
  explanatory copy only.
- [`scripts/wildcards-test.mjs`](../../scripts/wildcards-test.mjs): focused pure
  regression suite.
- [`CLAUDE.md`](../../CLAUDE.md): behavior summary and the new test command.
- This learning note records the decisions and verification evidence. The temporary
  dependency symlink and an initial worktree-only `.gitignore` aid are not product changes.

The Batch 3 roadmap status was reconciled only after the integrated gates; the
extension-side wildcard work does not claim the separate daemon CLI or item 14
partner-code scope.

## Verification (observed in the isolated worktree)

Commands run against the final implementation, using Node's direct TypeScript
type stripping for the pure suites:

- `node scripts/wildcards-test.mjs` — **22 passed, 0 failed** after parent review.
  Covers legacy substring behavior, first raw match, ordered gaps,
  collapsed/zero-length stars, case and whitespace, regex punctuation,
  apex/subdomain/lookalike/port behavior, paths + queries + fragments,
  global-allow rejection, SERP precedence, popup raw matches and wiring,
  whitespace-padded popup removal, malformed values, and direct sanitizer parity.
  One initial fixture mistakenly expected a single literal space after `*` not to
  match; it was corrected to require two spaces. Parent review then caught and
  fixed a raw-versus-trimmed removal mismatch before the final suite passed.
- `node scripts/rules-test.mjs` — **54 passed, 0 failed**, rerun after the removal fix.
- `node scripts/lock-math-test.mjs` — **124 passed, 0 failed**.
- `node scripts/lock-types-test.mjs` — **21 passed, 0 failed**.
- `node scripts/breaks-test.mjs` — **14 passed, 0 failed**.
- `node scripts/surrender-test.mjs` — **12 passed, 0 failed**.
- `npm run typecheck` — TypeScript exited successfully with no errors.
- `npm run build` — Chrome/background + offscreen + popup + options + blocked
  page and Firefox/background + popup + options + blocked page all built
  successfully; manifest/asset copying completed for both targets.
- `git diff --check` — no whitespace errors.

No Rust source changed, so Cargo was not run. Per the worktree scope, no full
Playwright or offline evaluation run was performed; the parent session owns the
final integrated browser/eval gates. The ignored local symlink to the existing
`node_modules` was used only to run typecheck/build, not to install packages or
change a lockfile.

## Integrated `main` verification

The parent integrated the reviewed hunks without replacing the unrelated
YouTube-search sanitizer work, then observed:

- `node scripts/wildcards-test.mjs` — **22 passed, 0 failed** in `main`.
- `node scripts/usage-stats-test.mjs` — **22 passed, 0 failed** for the other
  Batch 3 track in the same tree, including its integrated rule-label privacy fix.
- The existing lock-math, lock-type, break, surrender, grace, resume, rules, and
  RTA suites all passed (**124, 21, 14, 12, 21, 24, 54, and 17** respectively).
- `npm run typecheck` and both Chrome/Firefox builds **passed**.
- `node scripts/e2e-test.mjs` — the final two consecutive unchanged reruns ended
  with **`E2E: ALL PASSED`**, including the preserved YouTube-search integration
  cases with `pageVisible: true`. One earlier post-privacy-fix attempt, run
  concurrently with the eval, failed the YouTube page-visibility assertion with
  `{ gameMasked: true, reactVisible: true, pageVisible: false }` despite correct
  individual verdicts. No source changed before the passing reruns. The timing
  mechanism is therefore unproven, not claimed as fixed, and no blocker or
  unrelated search behavior was changed in response.
- `cargo test` — **161 passed across six suites**; Clippy with warnings denied
  and `cargo fmt --check` passed. No Rust source changed.
- A post-wildcard/pre-statistics eval passed all **15,874 cases with no per-case
  changes**. The final post-privacy-fix combined-tree eval again reported
  **PASS: no regressions** across **15,874 cases**, with **no per-case changes**.
  `scripts/eval-dataset.json` and `scripts/eval-baseline.json` remained
  byte-identical to `HEAD`.
- Before the approved commit, an isolated `git checkout-index` snapshot of the
  exact 23-path staged tree again passed both focused suites (**22 + 22**),
  typecheck, and both Chrome/Firefox builds. The index contained only the
  sanitizer's **+46/-3** wildcard hunk; the unrelated **+81/-0** YouTube-search
  hunks remained outside the commit.
