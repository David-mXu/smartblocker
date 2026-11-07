# Learning note — YouTube channel allow/block rules (Phase 5, batch 1)

**Date:** 2026-11-07 · **Scope:** SmartBlocker extension · **Evidence:** `docs/audits/2026-11-07-cold-turkey-blocker-landscape-audit.md` §4-P0.1

## The problem / feature goal

Cold Turkey lets users block or exempt specific YouTube *channels*; SmartBlocker
could only classify each video's title, so channel-level intent ("never block
Khan Academy tutorials", "always block a known time-sink channel") was
impossible. Goal: two new opt-in lists — `channelBlocklist` (deterministic
block, skip the classifier) and `channelAllowlist` (rescue only a classifier
block verdict) — keyed off the channel string the extension already scrapes.

## Key concepts

- **The decision ladder.** `src/background/blocker.ts` `onTitle()` decides in a
  strict order: master switch → URL whitelist → URL/title blocklist ( ×2, once
  with the raw title and once after DOM meta lands) → ML classifier → threshold
  → user overrides. Anything deterministic must be inserted at the right rung,
  or semantics drift (e.g. an allowlist accidentally rescuing a rule hit).
- **What "channel" actually is.** `src/content/extract-meta.ts`
  `extractMeta()` returns the channel *display name* (`"MrBeast"`), and when a
  `ytd-app` is present appends a site marker: `"MrBeast (youtube.com)"`. Reddit
  gives `r/<name>`; generic sites give `og:site_name`;
  `applyUrlSignals()` (src/shared/url-signals.ts) falls back to the bare
  hostname. So matching must be normalization-based, not byte-equality: stored
  entries are lowercase handle form (`mrbeast`), and both sides are canonicalized
  (strip leading `@`, strip a trailing `(host.tld)` marker, lowercase,
  whitespace-insensitive whole-string equality — never substring, so `beast`
  can't catch `mrbeast2`).
- **The offline mirror rule.** `scripts/lib/eval-harness.mjs` imports the real
  `src/shared` modules and re-runs the same ladder for the 15,874-case
  regression gate, so any new rung must be wired in *both* places with the same
  semantics — and must be a no-op under the shipped defaults (empty lists) so
  `eval-baseline.json` doesn't shift.

## Investigation → implementation (in order)

1. Read `blocker.ts` to find where the extracted channel is already in scope:
   inside the post-meta `else` branch, from `applyUrlSignals(url, meta)`. That
   fixed the insertion points: channelBlocklist right after the second
   blocklist check (classifier skipped, same override/status/force-redirect
   downstream as a blocklist hit, reason label `channel block: "<entry>"`);
   channelAllowlist inside the classifier-ok branch only — which structurally
   guarantees it never rescues a URL-blocklist or channelBlocklist hit.
2. **`src/shared/rules.ts` (new)** — `normalizeChannelHandle` +
   `matchChannel`, pure and erasable-syntax-only (same constraint as
   `lock-math.ts`) so the Node eval harness and a unit test import the .ts
   directly. Kept dependency-free (only a type-only import from `domains.ts`,
   which is erased at runtime, so no cycle with `domains.ts`'s runtime import
   of `normalizeChannelHandle`).
3. **`domains.ts` / `list-editor.tsx`** — added a `'channel'` mode (splits like
   domains, validates through `normalizeChannelHandle`) so the options editors
   store the normalized lowercase handle form.
4. **`settings.ts`** — additive keys `channelBlocklist`/`channelAllowlist`,
   defaults `[]`; old installs pick up the default via the `DEFAULTS` spread in
   `getSettings()`, so no migration is needed.
5. **`eval-harness.mjs`** — `decideBlock()` mirrors the new rungs;
   `EVAL_SETTINGS` gains both lists (empty); `signalsFor()` accepts an optional
   top-level `channel` field (no dataset case has one today → zero baseline
   drift). Channel checks use the `applyUrlSignals`-completed channel, same as
   the live blocker.
6. **UI** — `SitesPage` third section "YouTube channels", two stacked
   `SettingRow`s with `ListEditor`s (`#channel-blocklist`,
   `#channel-allowlist`), helper text stating precedence; registered the new
   DOM IDs in `docs/design-notes.md` §7. Saves go through
   `useOptionsState.save`, which already try/catches the `setSettings` lock
   throw.
7. **Popup** — channel-rule hits reuse `TabStatus.kind === 'blocked-rule'`
   (`rule: "channel @<handle>"`), and the force-redirect branch of
   `derivePageView` gained one conditional for the `channel block:` label.

## Alternatives / tradeoffs

- **Display-name vs handle identity.** The scraped value is the display name,
  not the real `@handle` (that needs the channel link's href). Whitespace-/case/
  marker-insensitive comparison is the honest middle ground; exact `@handle`
  extraction is a possible future hardening.
- **Hostname fallback is matchable on purpose** (an entry like `youtube.com`
  behaves as a site rule); it mirrors what the classifier sees.
- **Sub-frame/embed and SERP-card evaluation** (`evaluateSubItems`,
  `onSubFrame`) were deliberately left out — the spec scoped the rungs to the
  main `onTitle` ladder.
- The popup can't distinguish an allowlist-rescued page from an ordinary
  classifier-allow (it shows the usual "allowed" wording) — left as a
  documented limitation rather than growing a new status kind.

## Verification

- `npm run typecheck` — clean (`tsc --noEmit` on the full project including the
  reindented `blocker.ts` ladder).
- `node scripts/rules-test.mjs` — 34/34 PASS: 11 normalize cases, 10 match
  cases, 13 ladder cases run through the *real* `decideBlock` (imports
  `eval-harness.mjs`, no mirrored logic), including precedence
  (whitelist > blocklist > channelBlocklist > classifier > channelAllowlist)
  and the default-settings no-op.
- `npm run build` — both targets (`dist/chrome` + `dist/firefox`) built.
- `npm run eval` — regression gate vs the committed baseline; env note: this
  worktree has no network, so `npm ci` failed on `onnxruntime-node`'s
  postinstall download and `node_modules` was copied from the main checkout
  (same commit, so same lockfile). Eval gate result is in the task report.
