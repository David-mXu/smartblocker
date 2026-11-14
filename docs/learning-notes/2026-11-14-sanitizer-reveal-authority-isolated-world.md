# Sanitizer reveal authority: from a page-writable DOM attribute to an isolated-world set

## 1. The problem

`src/content/sanitize-page.ts` masks distracting content in-place (SERP
modules, embedded YouTube/TikTok/game iframes, YouTube search cards) and
offers a "Show" button that reveals a masked element for the session. Two
things recorded that reveal:

- a DOM attribute `data-smartblocker-masked="revealed"` on the element, and
- nothing else.

The CSS that re-shows the children and hides the mask bar keys on that
attribute, but so did **every mask-path skip check**. If the element's
attribute said `"revealed"`, masking paths bailed: `maskElement` returned
early, the embed/facade/chatbot/YouTube-search/SERP-card loops skipped the
element, the self-heal pass did not re-blank its iframes.

That made the attribute *authority*, not just a rendering hint — and the DOM
is written by the very content the sanitizer is defending against. A hostile
page (or server-rendered HTML, or a third-party embed inside an allowed host
like Notion or an AI chatbot, where masking is the only gate) could simply
pre-mark its own distraction `<div data-smartblocker-masked="revealed">` and
never be masked. This matters most on whitelisted/allowed pages: there is no
block screen behind the mask there, the mask *is* the whole enforcement.

The project had already solved the identical problem once: original iframe
`src`/`srcdoc` used to be stashed in page-readable `data-sb-orig-*`
attributes (red-team #16); that stash was moved to an isolated-world
`WeakMap` hung off the window object (`window.__sbOrigMedia`). The reveal
state was simply never given the same treatment.

## 2. Core concepts

- **Isolated world**: Chromium runs content scripts (and
  `chrome.scripting.executeScript`) in a separate JS environment from the
  page. Both share the DOM, but not JS objects. A `WeakSet` created there is
  invisible and unwritable to page JS — unlike DOM attributes, which the
  page can get, set, and erase at will.
- **Authority vs. rendering hint**: a value the adversary can write must
  never decide control flow. It may still drive *presentation* (the CSS
  selectors that show/hide masked children), because presentation is
  re-enforced every scan and can't grant a skip.
- **Keyed by element identity**: a `WeakSet<Element>` membership is tied to
  the live DOM node. If the page re-renders and swaps in a *new* node, the
  reveal is gone — exactly right, since the user only ever revealed the old
  node's content. Weak references also let discarded nodes be
  garbage-collected.

## 3. Investigation and implementation

### Step 1 — where can the authority live? (the decisive question)

The fix's shape depends entirely on the injection lifecycle, so that was
checked first.

Evidence: `src/background/blocker.ts` `runPageSanitizer()` calls
`api.scripting.executeScript({ target: { tabId }, func: sanitizePage,
args: [...] })` — no `world` option, so Chromium's default **isolated
world**, and `func` serialization means each injection runs a fresh function
scope. A module-level `WeakSet` would lose membership the next time the
extension re-injects the sanitizer on the same tab (the runScan
MutationObserver keeps `win.__sbSanitizeObserver` per injection, but
re-injection happens on later verdicts). So the set must hang off the
isolated-world window — the exact pattern `__sbOrigMedia` uses, per its own
in-file comment ("on a window global so re-injection of this script reuses
it"). Page JS cannot reach that `window` (isolated world), so it can neither
read nor write the set.

Implementation:

```ts
// in the `win` cast: __sbRevealed?: WeakSet<Element>;
if (!win.__sbRevealed) win.__sbRevealed = new WeakSet();
const revealedEls = win.__sbRevealed;
```

Two helpers now express every reveal decision:

- `isUserRevealed(el)` — `revealedEls.has(el)`; the only "is this revealed?"
  answer.
- `isMaskedOrGenuinelyRevealed(el)` — walks self + ancestors; a real mask
  kind (ours) shields, and a genuine reveal shields; a `"revealed"`
  attribute *without* set membership does **not** shield, so masking
  proceeds and overwrites it.

### Step 2 — move every authority read to the set

Changed sites in `src/content/sanitize-page.ts` (line numbers of the old
file):

- `maskElement` (~:323): entry guard is now `isUserRevealed(el)`; a forged
  `"revealed"` falls through and the mask's `setAttribute` overwrites it.
  The follower guard (~:330) likewise.
- The reveal click handler (~:372) writes `revealedEls` **first**, then
  still writes the attribute as a render hint (the CSS needs it, and
  `isTrusted` still gates synthetic clicks — that defense is unchanged).
- Embed container loop (~:576): genuine reveal → skip for the session even
  if the page strips the attribute ("can't un-reveal"); forged `"revealed"`
  → **removed**, then the normal blocklist/social/game/YouTube paths
  re-evaluate and re-mask. The self-heal branch now runs for every real
  mask kind without an attribute-value exception.
- Facades (~:666) and chatbot link cards (~:713): same skip-or-strip
  pattern.
- YouTube search cards (~:778) and SERP cards (~:1046): the
  `attr || state || closest(masked)` triples became
  `isMaskedOrGenuinelyRevealed(el) || state`.
- Same-class `closest()` guards that the bug report didn't list but that
  read the attribute the same way were fixed identically, since they are
  the same vulnerability: SERP shelf candidates (~:934), inline SERP video
  previews (~:902), entity-hero targets (~:1213), and both leftover-sweep
  guards (~:1322, ~:1326).
- `resetClassifierArtifacts` (~:297): policy resets keep genuine reveals,
  and a forged `"revealed"` classifier mask is now removed, so the next scan
  re-evaluates instead of the page pinning its content open across a
  policy-epoch change.
- MutationObserver rescans (via `attributeFilter` on
  `data-smartblocker-masked`) flow through the same code, so a page
  stripping or re-faking the attribute triggers re-masking; nothing can
  un-reveal a genuine reveal.
- The `maskSearchElements === false` branches (revealing all masked cards
  when the user turns search-masking off) also add to the set — that is a
  user-initiated reveal, and recording it preserves the existing
  behavior that those cards stay revealed after the setting is re-enabled.

### Step 3 — tests

`sanitize-page.ts` is browser-bound (no pure Node harness exists for it —
by design, since it must serialize as a self-contained function), so the
verification is two new fixture cases in
`scripts/e2e-p1-overrides-sanitizer.mjs`:

- **Fixture A** (`sb-reveal.example.net`): a kw-blocklisted iframe arrives
  server-rendered inside a pre-marked
  `<div data-smartblocker-masked="revealed">`. Must still be masked (old
  code: skipped forever). This is the exact reported bypass.
- **Fixture B** (`sb-resist.example.net`): same forged markup, plus a hostile
  one-shot script that waits for our mask, re-forges `"revealed"`, and
  points the blanked iframe back at the media URL. Asserted in stages: the
  tamper is observed → the next observer-triggered scan re-masks and
  re-blanks → a *trusted* Show click still reveals and restores the
  **first-seen** src (keep-first `origMedia` stash, not the tampered URL,
  which also re-verifies that stash semantics) → the genuine reveal survives
  a deliberately triggered rescan (childList mutation) without being
  re-masked or re-blanked.

Route-fulfilled HTML declares `charset=utf-8` (a known mojibake trap), and
the tamper is one-shot so the re-mask assertion has a deterministic settled
state rather than an unbounded attribute war between page script and
sanitizer.

## 4. Alternatives and trade-offs

- **Module-level `WeakSet`**: rejected — `func` serialization gives each
  injection a fresh scope, so reveals would be lost on every re-injection of
  the sanitizer into the same tab. Hanging off the isolated-world window is
  the only placement that survives re-injection *and* stays invisible to
  the page.
- **Keep self-healing on forged reveals instead of re-masking**: for
  embeds whose iframe was already blanked, forging `"revealed"` gains the
  page nothing (the media src exists only in the isolated-world stash), but
  stripping the forged marker and re-masking is still done so the visible
  state converges to "masked with a bar" rather than a limbo.
- **Reveals surviving SPA re-renders**: a genuinely revealed element whose
  node is replaced loses its reveal and is re-masked on the next scan.
  This matches the old behavior (the attribute lived on the node too) and
  is the conservative direction.
- Not resolved (accepted, pre-existing): the mask bar and curtain are still
  DOM that a hostile page can visually obscure; CSS is a rendering hint and
  re-ensured each scan. The hard gate for whole pages remains the block
  screen / DNR force-redirect path.

## 5. Verification

- `npm run typecheck`: **no errors in `src/content/sanitize-page.ts`**.
  The run reports one `TS18048` in `src/shared/prototype-cache.ts` — an
  untracked in-flight file from a different builder, not related to this
  change.
- `node --check scripts/e2e-p1-overrides-sanitizer.mjs`: syntax OK; both
  new fixtures declare `charset=utf-8`.
- The Playwright suites (`e2e-p1-overrides-sanitizer.mjs` included) were
  deliberately **not run** from this builder — the team lead runs them at
  integration time against `dist/chrome`. Verification here is by reading
  and reasoning over every attribute consumer (a repo-wide grep confirmed
  nothing outside `sanitize-page.ts` reads `"revealed"`) plus the
  typecheck. The behavioral claims in this note are therefore reasoned,
  not yet observed — the e2e stages above are what will confirm them.
