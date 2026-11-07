# Title rules (deterministic title-only blocking with `*` wildcards)

Date: 2026-11-07 · Scope: new additive feature (Cold-Turkey "window titles"
analog).

## Goal

Give users a dedicated rule list matched against the **page title only**,
independent of the existing URL+title `blocklist`. Semantics: case-insensitive,
NFKC-normalized, bare rule = substring, `*` = multi-char wildcard (parts must
appear in order). A hit blocks instantly, skipping the classifier.

## Key concepts

**The decision ladder in `onTitle` (src/background/blocker.ts)**

Each page evaluation runs: master switch → whitelist → deterministic rules →
(classifier → threshold) → override store. Deterministic blocks short-circuit:
they never run inference and never consult the title cache.

**Why the title cache needs no key change**

The title cache (`src/background/classifier.ts`, `inputCacheKey`) memoizes
only *inference output* — `{label, score, all}` for a given input text +
model key. It has no decision in it. So:
- Adding a rule: the block itself runs fresh on the next evaluation; nothing
  cached can be stale "not-blocked" state because the rule gate never caches.
- Removing a rule: the sweep re-runs `onTitle`, the rule misses, and
  `classify()` may serve a cached verdict — correct, because inference is
  rule-independent — and the blockedLabels/threshold decision is recomputed
  from current settings.

Immediate effect after editing rules comes from the `SETTINGS_SWEEP_KEYS`
list in blocker.ts: changing any listed setting triggers a debounced
`sweepOpenTabs()` which clears `lastClassified`/`inFlightKey` per open tab
and re-evaluates. `'titleRules'` was added there, exactly like `blocklist`.

**Wildcard compilation without regex injection**

Rules are user data; compiling them straight into `new RegExp` would mean
`[x(y` or `(?=…)` could throw or behave like regex. The compiler
(`src/shared/rules.ts`):
1. Normalizes both rule and title identically: strip `\p{Cf}` format chars
   (zero-width smuggling), NFKC (fullwidth "Ｆ" → "F" — same normalization as
   overrides.ts, minus its storage-key length cap), collapse whitespace,
   lowercase, trim.
2. Splits on wildcard **runs** (`\*+` = one gap), trims each part, drops
   empties. No parts left → rule was only stars/spaces → refused (a lone `*`
   matching every title is a footgun).
3. Escapes ALL regex metachars in each literal part, joins with
   `[\s\S]*` ("any chars, in order", NOT glob-anchored — a rule searches the
   title, stars only mark gaps). Leading/trailing stars are no-ops vs a bare
   substring, which matches user intuition for title rules.

**Eval parity**

`scripts/lib/eval-harness.mjs` imports the REAL `matchTitleRule` and calls it
inside `decideBlock` at the same ladder position (after whitelist + blocklist,
before classifier), using the cleaned title with the `urlFallbackTitle` path —
the same string the classifier sees. With the default-empty `titleRules` the
gate is a no-op, so the 15,874-case baseline is untouched (verified: "no
per-case changes").

## Decisions / tradeoffs

- **Same rank as blocklist, distinct label**: `title rule: "<rule>"` vs
  blocklist's `blocked rule: "<entry>"`. Blockscreens show rule labels
  without the "Blocked ·" prefix (regex extended to `/^(?:blocked|title) rule/i`
  in both blockscreen renderers).
- **Main-frame `onTitle` only**: sub-frame embeds (`onSubFrame`), SERP-card
  masking (`evaluateSubItems`/`sanitize-page.ts`) and the history scan
  keep their existing blocklist-only ladder. The feature spec covered the
  page-decision ladder only.
- **Explicit rules punch through the YouTube browsing-surface exemption**:
  same treatment as blocklist (an explicit user rule trumps the convenience
  of browse-YouTube-unblocked).
- **Popup fallback derivation left blocklist-only** (`popup-model.ts`): the
  pre-status estimate path is a degraded guess; the recorded tab status
  already shows title-rule blocks correctly via kind `blocked-rule` + `rule`.

## Verification (all green)

- `node scripts/rules-test.mjs` — 20/20 (compile safety incl. `[x(y*`,
  consecutive-star collapse, star-only pruning, NFKC/zero-width, ordering,
  case). Style mirrors `scripts/lock-math-test.mjs`.
- `npm run typecheck` — clean.
- `npm run build` — chrome + firefox bundles built.
- `npm run eval` — **PASS: no regressions**, all per-slice metrics identical
  to baseline 2026-11-05, "no per-case changes".
- Harness ladder spot-check (non-baseline): wildcard hit blocks with
  `title-rule:…`, whitelist beats rule, blocklist ordered before rule, no hit
  falls to classifier.

## Env gotcha encountered (worktree only)

`npm ci` failed in the worktree: `onnxruntime-node@1.21.0` postinstall sees
CUDA 13, doesn't know it, builds an `undefined` download URL → ECONNREFUSED.
`npm ci --foreground-scripts --onnxruntime-node-install-cuda=skip` installs
fine — the CPU runtime is bundled in the tarball; the postinstall only
downloads CUDA EP binaries (not needed; eval runs CPU inference).
