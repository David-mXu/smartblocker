# Classifying YouTube Search Videos Individually

**Date:** 2026-11-08  
**Project:** SmartBlocker

## 1. Problem and goal

`https://www.youtube.com/results?search_query=tech` stayed completely open, including every video thumbnail and title. The policy question was whether a broad search such as `tech` or `cycling` should block the whole results page. Those queries are ambiguous: the same result list can contain an on-task tutorial and an unrelated distraction. The chosen goal was to keep the search page open while masking distracting videos individually.

## 2. Root cause and concepts

Two deliberate exemptions combined into a coverage gap:

1. [`src/background/blocker.ts`](../../src/background/blocker.ts) classified YouTube `/results` as a browsing surface and returned early unless an explicit deterministic rule matched. This prevented the query itself from receiving a block verdict.
2. [`src/content/sanitize-page.ts`](../../src/content/sanitize-page.ts) skipped top-level YouTube in its universal embedded-media scan and had no YouTube result-card scan. In-page search masking existed for Google, Bing, and other search engines, but not for YouTube Search.

The important design distinction is **page-level versus item-level classification**. A search query is weak evidence about every result beneath it; a video's own title, channel, URL, and snippet are stronger evidence about that particular item. A **single-page application (SPA)** also adds results dynamically, so a one-time scan at navigation is insufficient.

## 3. Investigation and implementation

1. **Traced the page decision first.** Inspection of the browsing-surface early return in `src/background/blocker.ts` established that this was not a wrong model verdict: the classifier was never called for the results page. Reading `src/content/sanitize-page.ts` then showed why no lower-level mask replaced that missing page verdict.
2. **Inspected YouTube's result signals.** The public `/results?search_query=tech` response contained YouTube `videoRenderer` data and watch links. The scanner uses the corresponding rendered containers (`ytd-video-renderer`, grid videos, and Shorts containers) rather than trying to classify the whole page's combined text.
3. **Reused the existing sub-item evaluation pipeline.** New YouTube cards produce the same `EVAL_SUBITEMS` requests as other search cards. [`evaluateSubItems`](../../src/background/blocker.ts) therefore keeps the established settings, block threshold, focus context, overrides, breaks, and locked failure behavior instead of duplicating them. No model, seed, threshold, or scoring code changed.
4. **Kept the page-level exemption, but invoked the sanitizer before returning.** Explicit blocklist/title/adult rules still outrank the exemption and can block the whole page.
5. **Added a YouTube Search branch to the sanitizer.** It finds only real watch/Short links, rejects other link types, and extracts the card's own title, channel, and snippet. Search queries are deliberately not copied into every video's classification context. Existing `maskElement` supplies the mask and trusted **Show** control; the existing mutation observer covers Polymer's lazy-loaded results.
6. **Extended the existing setting and copy.** **Hide distractions in search results** now also controls these cards, rather than introducing a separate setting for the same outcome.
7. **Added end-to-end coverage.** [`scripts/e2e-test.mjs`](../../scripts/e2e-test.mjs) serves a fake YouTube `tech` results page through the real extension. It asserts that a known gaming title is masked, a React tutorial is allowed on the same page, no full-page overlay appears, a lazily inserted Short is masked, and disabling search masking reveals the cards.

## 4. Alternatives and tradeoffs

- **Block the entire `/results` page from its query.** Rejected for broad queries such as `tech`: the query is not a reliable proxy for every result, and users need a way to reach productive videos. Explicit user rules remain available when a query or page should always be blocked.
- **Block every video card because YouTube is high risk.** Rejected because that would recreate site-wide blocking at the card level and hide useful tutorials.
- **Classify each card independently (chosen).** More evaluation work than one page verdict, but it directly models mixed results and reuses the existing bounded, batched pipeline. The main watch/Short page classifier remains a backstop if a result is opened before its card finishes evaluation.
- **Current boundary:** this change targets YouTube `/results`, as requested. YouTube home, channel, feed, and playlist containers retain their existing page-level browsing exemption. Result cards can remain visible briefly while their asynchronous verdict is pending; this matches the existing organic search-card behavior.

## 5. Verification

- `npm run typecheck` — passed with no TypeScript errors.
- `npm run build` — passed for both `dist/chrome` and `dist/firefox`.
- `node --check scripts/e2e-test.mjs` — passed.
- `node scripts/e2e-test.mjs` — **E2E: ALL PASSED**. The new test observed `{ gameMasked: true, reactVisible: true, pageVisible: true }`; lazy Short masking and the search-masking toggle also passed. Existing watch-page, full-page search, embedded-video, lock, history, and sub-frame checks remained green.
- `node scripts/e2e-p1-overrides-sanitizer.mjs` — **E2E-P1: ALL PASSED**. Existing override scoping, trusted-reveal, hostile attribute-mutation recovery, and stylesheet self-healing checks remained green.
- `git diff --check` — no whitespace errors.
